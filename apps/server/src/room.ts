/**
 * `Room` — the authoritative game room: lobby, deck selection, mulligan, the live
 * game, and disconnect/reconnect. It is the SINGLE SOURCE OF TRUTH for one match.
 *
 * Transport-free by design (DESIGN §2 seams / testability): a `Room` knows nothing
 * about WebSockets. It talks to the outside world through the minimal `Connection`
 * interface (an id + a `send(ServerMessage)` sink). The WS layer (`index.ts`) adapts
 * real sockets to that interface; tests pass fake connections that record messages.
 * This is what lets us unit-test the full lobby→game→gameOver flow with no sockets.
 *
 * Anti-cheat: every game-state send goes through `maskStateForSeat` (the protocol's
 * single chokepoint), so a client never receives the opponent's hidden cards. A
 * client may only act for ITS OWN seat; spectators may not act at all.
 */

import { buildRegistry, loadCardPool, type CardPool } from '@jonny-boi/cards';
import {
  applyAction,
  createGame,
  DEFAULT_RULES,
  generateLegalActions,
  PLAYER_IDS,
  type CardInstance,
  type GameState,
  type PlayerId,
  type RulesConfig,
} from '@jonny-boi/core';
import {
  maskStateForSeat,
  PROTOCOL_VERSION,
  type DeckList,
  type LobbyPlayer,
  type RoomPhase,
  type ServerMessage,
} from '@jonny-boi/protocol';
import { loadDeck, type Deck, type LoadedDeck } from '@jonny-boi/sim';
import { randomBytes } from 'node:crypto';
import { DEFAULT_GAME_SEED, RECONNECT_TOKEN_BYTES } from './config.js';

/** The transport-free sink a `Room` writes `ServerMessage`s to. */
export interface Connection {
  /** Stable per-connection id (the WS layer assigns one; tests pass any string). */
  readonly id: string;
  /** Deliver one message to this connection. The WS layer serializes it to JSON. */
  send(message: ServerMessage): void;
}

/** What we track per seat. A seat may be empty, connected, or disconnected. */
interface Seat {
  readonly id: PlayerId;
  name: string;
  /** The live connection occupying this seat, or `null` if vacant/disconnected. */
  connection: Connection | null;
  /** The chosen, validated deck (its loaded library), or `null` until chosen. */
  deck: LoadedDeck | null;
  /** Lobby readiness flag. */
  ready: boolean;
  /** Whether this player has finished their mulligan decision this game. */
  mulliganSettled: boolean;
  /** Mulligans taken so far this game (London: each draws a fresh hand, then bottoms cards). */
  mulligansTaken: number;
  /** Per-seat token allowing a dropped player to reclaim THIS seat (reconnect). */
  reconnectToken: string;
}

/** Result of a join attempt, surfaced so the WS layer can register the connection. */
export interface JoinResult {
  readonly seat: PlayerId | null;
  readonly spectator: boolean;
}

/**
 * A shared, lazily-built card pool + effect registry. Building the pool warns on
 * unsupported refs; we silence that here (the pool is already validated by the
 * cards package's own tests) so the server log stays clean.
 */
let sharedPool: CardPool | null = null;
function getPool(): CardPool {
  if (!sharedPool) sharedPool = loadCardPool({ onWarn: () => {} });
  return sharedPool;
}

export class Room {
  readonly code: string;
  private readonly config: RulesConfig;
  private readonly pool: CardPool;
  private readonly registry = buildRegistry();
  private readonly seats: Record<PlayerId, Seat>;
  private readonly spectators = new Set<Connection>();

  private phase: RoomPhase = 'waiting';
  private state: GameState | null = null;
  /** Monotonic seed so each rematch is a fresh, still-reproducible game. */
  private nextSeed: number;

  constructor(code: string, config: RulesConfig = DEFAULT_RULES, seed: number = DEFAULT_GAME_SEED) {
    this.code = code;
    this.config = config;
    this.pool = getPool();
    this.nextSeed = seed;
    this.seats = {
      A: this.makeSeat('A'),
      B: this.makeSeat('B'),
    };
  }

  private makeSeat(id: PlayerId): Seat {
    return {
      id,
      name: '',
      connection: null,
      deck: null,
      ready: false,
      mulliganSettled: false,
      mulligansTaken: 0,
      reconnectToken: randomBytes(RECONNECT_TOKEN_BYTES).toString('hex'),
    };
  }

  /** True when both seats are filled by a (currently or previously) connected player. */
  private bothSeatsClaimed(): boolean {
    return PLAYER_IDS.every((id) => this.seats[id].name !== '');
  }

  /** Whether the room has no remaining live connections (eligible for cleanup). */
  isEmpty(): boolean {
    const noSeated = PLAYER_IDS.every((id) => this.seats[id].connection === null);
    return noSeated && this.spectators.size === 0;
  }

  // --- lobby: join / seating -------------------------------------------------

  /**
   * Seat a creating player as A. Validates an optional deck immediately so the
   * lobby reflects `hasDeck`. Returns the join result + the seat's reconnect token.
   */
  createSeat(conn: Connection, name: string, deck?: DeckList): JoinResult & { token: string } {
    const seat = this.seats.A;
    seat.name = name;
    seat.connection = conn;
    if (deck) this.tryChooseDeck('A', deck, conn);
    conn.send({ t: 'roomJoined', code: this.code, yourSeat: 'A', spectator: false });
    this.refreshPhaseFromLobby();
    this.broadcastLobby();
    return { seat: 'A', spectator: false, token: seat.reconnectToken };
  }

  /**
   * Join an existing room. Seats the player as B if B is open; otherwise the
   * connection becomes a spectator. Returns the join result (+ token when seated).
   */
  join(conn: Connection, name: string, deck?: DeckList): JoinResult & { token?: string } {
    const open = PLAYER_IDS.find((id) => this.seats[id].name === '');
    if (!open) {
      // Both seats taken → spectator.
      this.spectators.add(conn);
      conn.send({ t: 'roomJoined', code: this.code, yourSeat: null, spectator: true });
      // A spectator joining mid-game should see the current board.
      if (this.state) this.sendStateTo(conn, null);
      this.broadcastLobby();
      return { seat: null, spectator: true };
    }
    const seat = this.seats[open];
    seat.name = name;
    seat.connection = conn;
    if (deck) this.tryChooseDeck(open, deck, conn);
    conn.send({ t: 'roomJoined', code: this.code, yourSeat: open, spectator: false });
    this.refreshPhaseFromLobby();
    this.broadcastLobby();
    return { seat: open, spectator: false, token: seat.reconnectToken };
  }

  /** Look up which seat (if any) a connection currently occupies. */
  seatOf(conn: Connection): PlayerId | null {
    return PLAYER_IDS.find((id) => this.seats[id].connection === conn) ?? null;
  }

  isSpectator(conn: Connection): boolean {
    return this.spectators.has(conn);
  }

  /** The reconnect token for a seat (the WS layer hands this to the client). */
  tokenFor(seat: PlayerId): string {
    return this.seats[seat].reconnectToken;
  }

  // --- lobby: deck + ready ---------------------------------------------------

  /** Validate + record a deck choice for a seat; replies with an error on failure. */
  private tryChooseDeck(seatId: PlayerId, deck: DeckList, conn: Connection): boolean {
    const asDeck: Deck = {
      name: deck.name,
      archetype: 'online',
      cards: deck.cards.map((c) => ({ cardId: c.cardId, count: c.count })),
    };
    try {
      const loaded = loadDeck(asDeck, this.pool);
      this.seats[seatId].deck = loaded;
      return true;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      conn.send({ t: 'error', code: 'invalidDeck', message: reason });
      return false;
    }
  }

  chooseDeck(conn: Connection, deck: DeckList): void {
    const seatId = this.seatOf(conn);
    if (!seatId) {
      conn.send({ t: 'error', code: 'notInRoom', message: 'you are not seated in this room' });
      return;
    }
    if (this.phase === 'playing' || this.phase === 'mulligan') {
      conn.send({ t: 'error', code: 'invalidDeck', message: 'cannot change deck once the game has started' });
      return;
    }
    if (this.tryChooseDeck(seatId, deck, conn)) {
      // Changing a deck clears readiness so a player can't ready a deck then swap.
      this.seats[seatId].ready = false;
      this.refreshPhaseFromLobby();
      this.broadcastLobby();
    }
  }

  setReady(conn: Connection, ready: boolean): void {
    const seatId = this.seatOf(conn);
    if (!seatId) {
      conn.send({ t: 'error', code: 'notInRoom', message: 'you are not seated in this room' });
      return;
    }
    this.seats[seatId].ready = ready;
    this.broadcastLobby();
    this.maybeStartGame();
  }

  /** Move from `waiting` to `deckSelect` once both seats are claimed. */
  private refreshPhaseFromLobby(): void {
    if (this.phase === 'waiting' && this.bothSeatsClaimed()) this.phase = 'deckSelect';
  }

  /** Start the game when both seated players have a valid deck and are ready. */
  private maybeStartGame(): void {
    if (this.phase !== 'deckSelect') return;
    const ready = PLAYER_IDS.every((id) => {
      const s = this.seats[id];
      return s.connection !== null && s.deck !== null && s.ready;
    });
    if (ready) this.startGame();
  }

  // --- game lifecycle --------------------------------------------------------

  /** Build the authoritative `GameState` from both decks via the core setup path. */
  private startGame(): void {
    const deckA = this.seats.A.deck;
    const deckB = this.seats.B.deck;
    if (!deckA || !deckB) return; // guarded by caller, but stay safe.

    const seed = this.nextSeed;
    const created = createGame({
      seed,
      startingPlayer: 'A',
      config: this.config,
      registry: this.registry,
      decks: {
        A: { cards: deckA.library },
        B: { cards: deckB.library },
      },
    });
    this.state = created.state;

    for (const id of PLAYER_IDS) {
      this.seats[id].mulliganSettled = false;
      this.seats[id].mulligansTaken = 0;
    }

    this.phase = 'mulligan';
    this.broadcastLobby();
    for (const id of PLAYER_IDS) {
      const conn = this.seats[id].connection;
      if (conn) this.sendMulliganPrompt(conn, id);
    }
  }

  private sendMulliganPrompt(conn: Connection, seatId: PlayerId): void {
    if (!this.state) return;
    conn.send({
      t: 'mulliganPrompt',
      hand: this.state.players[seatId].hand,
      mulligansTaken: this.seats[seatId].mulligansTaken,
    });
  }

  /**
   * Handle a mulligan decision. Simple, correct London-style flow: a "no keep"
   * reshuffles that player's hand into the library and redraws a full hand (we keep
   * it simple — no bottoming step), incrementing their mulligan count and re-prompting.
   * A "keep" settles the player. When BOTH players have settled, play begins.
   */
  mulligan(conn: Connection, keep: boolean): void {
    const seatId = this.seatOf(conn);
    if (!seatId || !this.state) {
      conn.send({ t: 'error', code: 'notInRoom', message: 'no active mulligan for you' });
      return;
    }
    if (this.phase !== 'mulligan') {
      conn.send({ t: 'error', code: 'illegalAction', message: 'not in the mulligan phase' });
      return;
    }
    const seat = this.seats[seatId];
    if (seat.mulliganSettled) return; // already decided; ignore duplicates.

    if (keep) {
      seat.mulliganSettled = true;
    } else {
      this.redrawHand(seatId);
      seat.mulligansTaken += 1;
      this.sendMulliganPrompt(conn, seatId);
      return;
    }

    if (PLAYER_IDS.every((id) => this.seats[id].mulliganSettled)) {
      this.beginPlay();
    }
  }

  /** Put a seat's hand back into the library, reshuffle deterministically, redraw. */
  private redrawHand(seatId: PlayerId): void {
    if (!this.state) return;
    const player = this.state.players[seatId];
    // Return hand to library.
    for (const card of player.hand) {
      card.zone = 'library';
      player.library.push(card);
    }
    player.hand = [];
    // Deterministic reshuffle from a seed that varies per mulligan so the new hand
    // differs but the room stays reproducible.
    this.shuffleLibrary(seatId, this.nextSeed ^ (this.seats[seatId].mulligansTaken + 1));
    for (let i = 0; i < this.config.startingHandSize; i++) {
      const top = player.library.shift();
      if (!top) break;
      top.zone = 'hand';
      player.hand.push(top);
    }
  }

  /** Fisher–Yates shuffle of a seat's library with a seeded PRNG (mulberry32). */
  private shuffleLibrary(seatId: PlayerId, seed: number): void {
    if (!this.state) return;
    const lib = this.state.players[seatId].library;
    let s = seed >>> 0;
    const rand = (): number => {
      s = (s + 0x6d2b79f5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    for (let i = lib.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      const tmp = lib[i] as CardInstance;
      lib[i] = lib[j] as CardInstance;
      lib[j] = tmp;
    }
  }

  /** Transition from mulligan into live play and push the first state to everyone. */
  private beginPlay(): void {
    this.phase = 'playing';
    for (const id of PLAYER_IDS) {
      const conn = this.seats[id].connection;
      if (conn) conn.send({ t: 'gameStarted', yourSeat: id });
    }
    this.broadcastState(['Game started.']);
    this.broadcastLobby();
  }

  /**
   * Apply a submitted action. Confirms the sender holds priority for it (else
   * `notYourTurn`); on rejection re-sends the intact state with `illegalAction`;
   * on success broadcasts the new masked state to every client.
   */
  submitAction(conn: Connection, action: unknown): void {
    const seatId = this.seatOf(conn);
    if (this.isSpectator(conn)) {
      conn.send({ t: 'error', code: 'notInRoom', message: 'spectators cannot submit actions' });
      return;
    }
    if (!seatId) {
      conn.send({ t: 'error', code: 'notInRoom', message: 'you are not seated in this room' });
      return;
    }
    if (this.phase !== 'playing' || !this.state) {
      conn.send({ t: 'error', code: 'illegalAction', message: 'the game is not in progress' });
      return;
    }
    // A client may only act for its own seat, and only when it holds priority.
    const act = action as { kind?: string; player?: PlayerId };
    if (act.player !== undefined && act.player !== seatId) {
      conn.send({ t: 'error', code: 'notYourTurn', message: 'you may only act for your own seat' });
      return;
    }
    if (this.state.priorityPlayer !== seatId) {
      conn.send({ t: 'error', code: 'notYourTurn', message: 'you do not hold priority' });
      return;
    }

    const result = applyAction(this.state, action as never, this.config, this.registry);
    const rejected = result.events.some((e) => e.type === 'actionRejected');
    if (rejected) {
      const reason = result.events.find((e) => e.type === 'actionRejected');
      conn.send({
        t: 'error',
        code: 'illegalAction',
        message: reason && 'reason' in reason ? String(reason.reason) : 'illegal action',
      });
      // Re-send the (unchanged) authoritative state so the client resyncs.
      this.sendStateTo(conn, seatId);
      return;
    }

    this.state = result.state;
    const log = this.summarizeEvents(result.events);
    this.broadcastState(log);
    this.checkGameOver();
  }

  /** A short, human-readable line per notable event for the client log. */
  private summarizeEvents(events: readonly { type: string }[]): string[] {
    const log: string[] = [];
    for (const e of events) {
      switch (e.type) {
        case 'landPlayed':
          log.push('A land was played.');
          break;
        case 'spellCast':
          log.push(`A spell was cast: ${(e as { name?: string }).name ?? 'unknown'}.`);
          break;
        case 'attackersDeclared':
          log.push('Attackers declared.');
          break;
        case 'blockersDeclared':
          log.push('Blockers declared.');
          break;
        case 'stepBegin':
          log.push(`Step: ${(e as { step?: string }).step ?? ''}.`);
          break;
        default:
          break;
      }
    }
    return log;
  }

  /** Conclude the game if the engine flagged it over; emits `gameOver` to all. */
  private checkGameOver(): void {
    if (!this.state || !this.state.gameOver) return;
    this.phase = 'finished';
    const winner = this.state.winner;
    const reason = winner ? `${winner} won.` : 'The game ended in a draw.';
    this.broadcastToAll({ t: 'gameOver', winner, reason });
    this.broadcastLobby();
  }

  /** Concede: the conceding seat loses, the opponent wins. */
  concede(conn: Connection): void {
    const seatId = this.seatOf(conn);
    if (!seatId || !this.state) {
      conn.send({ t: 'error', code: 'notInRoom', message: 'no active game to concede' });
      return;
    }
    if (this.phase === 'finished') return;
    const winner: PlayerId = seatId === 'A' ? 'B' : 'A';
    this.phase = 'finished';
    this.broadcastToAll({ t: 'gameOver', winner, reason: `${seatId} conceded.` });
    this.broadcastLobby();
  }

  /** Rematch: rebuild a fresh game with a new seed, keeping the same decks/seats. */
  rematch(conn: Connection): void {
    const seatId = this.seatOf(conn);
    if (!seatId) {
      conn.send({ t: 'error', code: 'notInRoom', message: 'you are not seated in this room' });
      return;
    }
    if (this.phase !== 'finished') {
      conn.send({ t: 'error', code: 'illegalAction', message: 'can only rematch after a game ends' });
      return;
    }
    // New seed so the shuffle differs; still deterministic/reproducible.
    this.nextSeed = (this.nextSeed + 1) >>> 0;
    this.phase = 'deckSelect';
    for (const id of PLAYER_IDS) this.seats[id].ready = false;
    this.startGame();
  }

  // --- disconnect / reconnect ------------------------------------------------

  /**
   * Handle a socket close. If it held a seat, mark the seat disconnected (keep its
   * name/deck/token so it can be reclaimed) and notify the opponent. A spectator
   * just leaves. The room and the opponent's game are never disturbed.
   */
  handleDisconnect(conn: Connection): void {
    if (this.spectators.delete(conn)) return;
    const seatId = this.seatOf(conn);
    if (!seatId) return;
    this.seats[seatId].connection = null;
    const opponent = seatId === 'A' ? 'B' : 'A';
    const oppConn = this.seats[opponent].connection;
    if (oppConn) oppConn.send({ t: 'opponentDisconnected' });
    this.broadcastLobby();
  }

  /**
   * Reclaim a seat with its reconnect token. Returns the seat on success (and
   * resends the current state + notifies the opponent), or `null` on a bad token.
   */
  reconnect(conn: Connection, seatId: PlayerId, token: string): PlayerId | null {
    const seat = this.seats[seatId];
    if (seat.name === '' || seat.reconnectToken !== token) return null;
    if (seat.connection !== null) return null; // seat is already live.
    seat.connection = conn;
    conn.send({ t: 'roomJoined', code: this.code, yourSeat: seatId, spectator: false });
    this.broadcastLobby();
    // Resend the player's view so the client resyncs after the drop.
    if (this.state) this.sendStateTo(conn, seatId);
    const opponent = seatId === 'A' ? 'B' : 'A';
    const oppConn = this.seats[opponent].connection;
    if (oppConn) oppConn.send({ t: 'opponentReconnected' });
    return seatId;
  }

  // --- protocol version ------------------------------------------------------

  /** Whether a handshake's protocol version matches the server's. */
  static protocolMatches(version: number): boolean {
    return version === PROTOCOL_VERSION;
  }

  // --- broadcasting ----------------------------------------------------------

  /** The lobby snapshot (phase + both seated players). */
  private lobbyPlayers(): LobbyPlayer[] {
    return PLAYER_IDS.filter((id) => this.seats[id].name !== '').map((id) => {
      const s = this.seats[id];
      return { seat: id, name: s.name, ready: s.ready, hasDeck: s.deck !== null };
    });
  }

  private broadcastLobby(): void {
    const msg: ServerMessage = {
      t: 'lobby',
      code: this.code,
      phase: this.phase,
      players: this.lobbyPlayers(),
    };
    this.broadcastToAll(msg);
  }

  /** Deliver a message to every connected seat + spectator. */
  private broadcastToAll(msg: ServerMessage): void {
    for (const id of PLAYER_IDS) {
      const conn = this.seats[id].connection;
      if (conn) conn.send(msg);
    }
    for (const spec of this.spectators) spec.send(msg);
  }

  /**
   * Send each connected client its OWN masked state. Masking goes through
   * `maskStateForSeat`, the protocol's single chokepoint, so a client never
   * receives the opponent's hidden cards. Spectators get a neutral view (seat A's
   * public information — no hidden hands, since they aren't a seat).
   */
  private broadcastState(log: readonly string[]): void {
    if (!this.state) return;
    for (const id of PLAYER_IDS) {
      const conn = this.seats[id].connection;
      if (conn) this.sendStateTo(conn, id, log);
    }
    for (const spec of this.spectators) this.sendStateTo(spec, null, log);
  }

  /**
   * Send one masked `state` message to a connection. `seat === null` means a
   * spectator: we mask from seat A's perspective then strip BOTH hands so a
   * spectator sees no hidden information at all. `legalActions`/`yourTurn` are only
   * populated for the seat that actually holds priority.
   */
  private sendStateTo(conn: Connection, seat: PlayerId | null, log: readonly string[] = []): void {
    if (!this.state) return;
    const yourTurn = seat !== null && this.state.priorityPlayer === seat;
    const legalActions = yourTurn ? generateLegalActions(this.state, this.config) : [];

    if (seat === null) {
      // Spectator: take A's masked view and blank out the (still-present) own hand
      // so a spectator never sees any hand contents.
      const view = maskStateForSeat(this.state, 'A');
      const spectatorView = {
        ...view,
        players: {
          A: { ...view.players.A, hand: null },
          B: { ...view.players.B, hand: null },
        },
      };
      conn.send({ t: 'state', view: spectatorView, legalActions: [], yourTurn: false, log });
      return;
    }

    const view = maskStateForSeat(this.state, seat);
    conn.send({ t: 'state', view, legalActions, yourTurn, log });
  }
}
