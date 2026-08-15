/**
 * `@jonny-boi/protocol` — the frozen client↔server contract for online play, plus
 * the per-seat view-masking function. PURE + isomorphic: it runs identically in the
 * Node authoritative server and the browser client, and depends only on
 * `@jonny-boi/core` *types* (no Node, no DOM, no runtime deps beyond core's PLAYER_IDS).
 *
 * Anti-cheat principle: the server is authoritative and sends each client ONLY its
 * own `MaskedGameView`. A client therefore never receives the opponent's hidden
 * information (hand contents, library order) over the wire — masking happens here,
 * server-side, before sending. `maskStateForSeat` is the single chokepoint.
 */

import { PLAYER_IDS } from '@jonny-boi/core';
import type {
  GameState,
  PlayerState,
  PlayerId,
  CardInstance,
  ChoiceKind,
  PendingChoice,
  StackObject,
  CombatState,
  Step,
  GameAction,
} from '@jonny-boi/core';

/**
 * Bumped on any breaking change to the message shapes below; checked at handshake.
 *
 * 2 — `MaskedGameView.pendingChoice`: the server now tells a seat what question a
 * resolving card asked it. Before this, an online client saw its legal menu
 * collapse to opaque `answerChoice` actions with no prompt, which is a dead end.
 */
export const PROTOCOL_VERSION = 2;

/**
 * The oldest version a current client can still hold a useful game on.
 *
 * The two halves of this app deploy at different speeds: the web app ships
 * automatically on every merge, while the game server is a bundle someone copies
 * onto a NAS by hand. So the server is routinely the stale side, and a strict
 * equality check turns that skew into a total outage — the lobby refuses to open
 * at all, for a difference that only affects some cards.
 *
 * v1 → v2 added `MaskedGameView.pendingChoice`. A v1 server simply omits the
 * field, which a v2 client already reads as "no question parked". Everything else
 * — rooms, lobby, mulligans, casting, combat, reconnect — is unchanged, so a v2
 * client can play a v1 server for any game that never asks a player to choose.
 * The client negotiates down to this floor and says so, rather than failing shut.
 */
export const MIN_COMPATIBLE_PROTOCOL_VERSION = 1;

// ---------------------------------------------------------------------------
// Room codes.
//
// These live HERE, in the shared contract, because a room code is something the
// server issues and the client types back — the definition of a value both ends
// must agree on. They used to be defined twice, and the two copies drifted: the
// server generated FIVE characters while the web client only enabled its "Join
// room" button at exactly SIX. Every real code left the button greyed out, so
// joining an online game was impossible, and nothing failed loudly enough to
// notice — the button just sat there.
// ---------------------------------------------------------------------------

/**
 * Number of characters in a generated room code. The client validates against
 * this and the server generates to it; importing the same constant is what stops
 * them drifting apart again.
 */
export const ROOM_CODE_LENGTH = 5;

/**
 * Characters a generated code may contain — uppercase, with the shapes that get
 * misread out loud or on a phone screen (I, O, 0, 1) deliberately absent, since
 * these get read aloud and re-typed.
 */
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/**
 * Longest code the wire accepts. Deliberately looser than
 * {@link ROOM_CODE_LENGTH} so the server can keep honouring codes it issued
 * under an older, differently-sized scheme; validation bounds the string, it
 * does not pin it to today's length.
 */
export const MAX_ROOM_CODE_LENGTH = 16;

/**
 * Normalize a typed room code for comparison: trim surrounding space and fold to
 * uppercase, matching how the server looks a room up. A phone keyboard that
 * autocapitalises differently, or a code pasted with a trailing space, then
 * still finds the room.
 */
export function normalizeRoomCode(code: string): string {
  return code.trim().toUpperCase();
}

/**
 * Whether a typed code is worth sending to the server. Length only — the server
 * remains the authority on whether the room exists.
 */
export function isPlausibleRoomCode(code: string): boolean {
  return normalizeRoomCode(code).length === ROOM_CODE_LENGTH;
}

// ---------------------------------------------------------------------------
// Decklists carried over the wire (so the server can build ANY deck — including
// the user's custom decks — from the shared card pool, then validate it).
// ---------------------------------------------------------------------------

export interface DeckList {
  readonly name: string;
  readonly cards: ReadonlyArray<{ readonly cardId: string; readonly count: number }>;
}

// ---------------------------------------------------------------------------
// Masked game view: GameState from one seat's perspective.
// ---------------------------------------------------------------------------

/**
 * One player's state as another seat is entitled to see it. Public zones
 * (graveyard, exile) and public scalars (life, mana, etc.) are always present;
 * hidden zones are reduced to counts. `hand` carries the actual cards ONLY for the
 * viewer's own seat (null for the opponent — the opponent's cards never travel here).
 */
export interface PublicPlayerView {
  readonly id: PlayerId;
  readonly life: number;
  readonly manaPool: PlayerState['manaPool'];
  readonly landsPlayedThisTurn: number;
  readonly hasLost: boolean;
  /** Public zones — visible to everyone. */
  readonly graveyard: readonly CardInstance[];
  readonly exile: readonly CardInstance[];
  /** Hidden zones reduced to counts. */
  readonly handCount: number;
  readonly libraryCount: number;
  /** The viewer's own hand cards (revealed); `null` for the opponent. */
  readonly hand: readonly CardInstance[] | null;
}

// ---------------------------------------------------------------------------
// The parked question (`GameState.pendingChoice`), masked per seat.
// ---------------------------------------------------------------------------

/**
 * A pending choice as a seat that is NOT answering it is entitled to see it: who
 * was asked, by which card, and what SHAPE the question has — never its payload.
 *
 * The payload is the whole point of the redaction. A `PendingChoice`'s
 * `candidates` are a snapshot the engine deliberately hands to exactly one seat,
 * and for a card like Thoughtseize those candidates ARE the opponent's hand: the
 * card entitles the caster to see them, and nobody else. `prompt` is dropped for
 * the same reason — an effect is free to write the cards it is asking about into
 * its prompt text, so it is payload too, not chrome.
 *
 * What survives is what the board is already showing anyway: the spell that asked
 * is on the (public) stack, and whose turn it is to act is public by construction.
 */
export interface RedactedPendingChoice {
  /**
   * Discriminant. A client narrows on this rather than sniffing for a missing
   * field, so a summary can never be mistaken for a full question (or vice versa)
   * by a client that guessed the shape wrong.
   */
  readonly redacted: true;
  readonly id: number;
  readonly chooser: PlayerId;
  readonly sourceName: string;
  readonly kind: ChoiceKind;
}

/**
 * What `MaskedGameView.pendingChoice` carries: the FULL question for the seat that
 * must answer it, a {@link RedactedPendingChoice} summary for anyone else.
 */
export type MaskedPendingChoice = PendingChoice | RedactedPendingChoice;

/** Reduce a choice to the summary a non-chooser may see. */
export function redactPendingChoice(choice: PendingChoice): RedactedPendingChoice {
  return {
    redacted: true,
    id: choice.id,
    chooser: choice.chooser,
    sourceName: choice.sourceName,
    kind: choice.kind,
  };
}

/**
 * Narrow a masked choice to the summary form. The negative branch is the full
 * `PendingChoice`, which is what the choice UI needs — so a client that renders a
 * prompt has to pass this guard first, and cannot render one from a summary.
 */
export function isRedactedChoice(choice: MaskedPendingChoice): choice is RedactedPendingChoice {
  return (choice as RedactedPendingChoice).redacted === true;
}

/**
 * The pending choice as `seat` may see it (`null` for a spectator, who is never
 * anyone's chooser). This is the masking rule in one line: you get the question
 * only if you are the one being asked.
 */
function maskPendingChoiceForSeat(state: GameState, seat: PlayerId | null): MaskedPendingChoice | null {
  const choice = state.pendingChoice;
  if (!choice) return null;
  return seat !== null && choice.chooser === seat ? choice : redactPendingChoice(choice);
}

/** A serializable snapshot of `GameState` redacted for one seat. */
export interface MaskedGameView {
  readonly viewer: PlayerId;
  readonly turnNumber: number;
  readonly activePlayer: PlayerId;
  readonly priorityPlayer: PlayerId;
  readonly step: Step;
  readonly players: Record<PlayerId, PublicPlayerView>;
  /** Battlefield + stack are public (both players see them). */
  readonly battlefield: readonly CardInstance[];
  readonly stack: readonly StackObject[];
  readonly combat: CombatState | null;
  readonly winner: PlayerId | null;
  readonly gameOver: boolean;
  /**
   * The question a resolving card parked, or `null`. Full for the seat that must
   * answer; a {@link RedactedPendingChoice} summary for the other seat and for
   * spectators. Without this an online client sees its legal menu collapse to
   * opaque `answerChoice` actions and the game dead-ends.
   */
  readonly pendingChoice: MaskedPendingChoice | null;
}

/**
 * Produce the view `seat` is entitled to. The opponent's `hand` is `null` (only a
 * `handCount`) and their `library` is a `libraryCount` only — their hidden cards are
 * never copied into the result, so a serialized `MaskedGameView` cannot leak them.
 */
export function maskStateForSeat(state: GameState, seat: PlayerId): MaskedGameView {
  const players = {} as Record<PlayerId, PublicPlayerView>;
  for (const id of PLAYER_IDS) {
    const p = state.players[id];
    const isViewer = id === seat;
    players[id] = {
      id,
      life: p.life,
      manaPool: p.manaPool,
      landsPlayedThisTurn: p.landsPlayedThisTurn,
      hasLost: p.hasLost,
      graveyard: p.graveyard,
      exile: p.exile,
      handCount: p.hand.length,
      libraryCount: p.library.length,
      hand: isViewer ? p.hand : null,
    };
  }
  return {
    viewer: seat,
    turnNumber: state.turnNumber,
    activePlayer: state.activePlayer,
    priorityPlayer: state.priorityPlayer,
    step: state.step,
    players,
    battlefield: state.battlefield,
    stack: state.stack,
    combat: state.combat,
    winner: state.winner,
    gameOver: state.gameOver,
    pendingChoice: maskPendingChoiceForSeat(state, seat),
  };
}

/**
 * The view a SPECTATOR is entitled to: no seat's hand, and only the summary of any
 * parked question. It lives here, beside `maskStateForSeat`, so masking stays a
 * single chokepoint — a spectator view assembled by the server out of a seat's view
 * would silently inherit whatever that seat was entitled to see next time a field
 * is added, which is exactly how `pendingChoice` would have leaked.
 *
 * `viewer` is seat A only because the shape demands a value; nothing seat-specific
 * survives the blanking below.
 */
export function maskStateForSpectator(state: GameState): MaskedGameView {
  const view = maskStateForSeat(state, PLAYER_IDS[0] as PlayerId);
  const players = {} as Record<PlayerId, PublicPlayerView>;
  for (const id of PLAYER_IDS) players[id] = { ...view.players[id], hand: null };
  return {
    ...view,
    players,
    pendingChoice: maskPendingChoiceForSeat(state, null),
  };
}

// ---------------------------------------------------------------------------
// Anti-cheat assertion tooling.
// ---------------------------------------------------------------------------

/**
 * Every `instanceId` reachable anywhere in a value, at any depth — the STRUCTURAL
 * way to ask "does this message mention that card?".
 *
 * Text scanning is the tempting version and it is wrong in both directions: a
 * substring/regex over the serialized JSON hits the digits of unrelated numbers
 * (life totals, counts, a longer id that starts with a shorter one), and it misses
 * an id that a future field carries under another name. Walking the structure and
 * collecting the values of every `instanceId` key is exact.
 *
 * Exported because it is the assertion the masking chokepoint has to be provable
 * with, and every consumer that ships a new view field needs the same check.
 */
export function collectInstanceIds(value: unknown): Set<number> {
  const found = new Set<number>();
  const seen = new Set<object>();
  const walk = (node: unknown): void => {
    if (node === null || typeof node !== 'object') return;
    if (seen.has(node)) return; // a cycle must not wedge the walk
    seen.add(node);
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    for (const [key, child] of Object.entries(node)) {
      if (key === 'instanceId' && typeof child === 'number') found.add(child);
      walk(child);
    }
  };
  walk(value);
  return found;
}

/**
 * Which of `forbidden` a value mentions — empty means "nothing leaked". Returning
 * the offenders rather than a boolean is what makes a failing anti-cheat test say
 * WHICH card escaped.
 */
export function leakedInstanceIds(value: unknown, forbidden: Iterable<number>): number[] {
  const present = collectInstanceIds(value);
  return [...forbidden].filter((id) => present.has(id));
}

// ---------------------------------------------------------------------------
// Room + error vocabularies (no magic strings — consumers switch on these).
// ---------------------------------------------------------------------------

export type RoomPhase = 'waiting' | 'deckSelect' | 'mulligan' | 'playing' | 'finished';

export type ErrorCode =
  | 'roomNotFound'
  | 'roomFull'
  | 'notInRoom'
  | 'notYourTurn'
  | 'illegalAction'
  | 'invalidDeck'
  | 'protocolMismatch'
  | 'internal';

export interface LobbyPlayer {
  readonly seat: PlayerId;
  readonly name: string;
  readonly ready: boolean;
  readonly hasDeck: boolean;
}

// ---------------------------------------------------------------------------
// Client → Server messages.
// ---------------------------------------------------------------------------

export type ClientMessage =
  | { readonly t: 'createRoom'; readonly protocolVersion: number; readonly name: string; readonly deck?: DeckList }
  | { readonly t: 'joinRoom'; readonly protocolVersion: number; readonly code: string; readonly name: string; readonly deck?: DeckList }
  /**
   * Reclaim a seat after a dropped socket, using the `reconnectToken` the server
   * issued in `roomJoined`. Added in PROTOCOL_VERSION 1 as a new tag: a client that
   * never sends it behaves exactly as before, so this is backward-compatible.
   */
  | {
      readonly t: 'reconnect';
      readonly protocolVersion: number;
      readonly code: string;
      readonly seat: PlayerId;
      readonly token: string;
    }
  | { readonly t: 'chooseDeck'; readonly deck: DeckList }
  | { readonly t: 'setReady'; readonly ready: boolean }
  | { readonly t: 'mulligan'; readonly keep: boolean }
  | { readonly t: 'submitAction'; readonly action: GameAction }
  | { readonly t: 'concede' }
  | { readonly t: 'rematch' }
  | { readonly t: 'ping' };

export type ClientMessageTag = ClientMessage['t'];

// ---------------------------------------------------------------------------
// Server → Client messages.
// ---------------------------------------------------------------------------

export type ServerMessage =
  | {
      readonly t: 'roomJoined';
      readonly code: string;
      readonly yourSeat: PlayerId | null;
      readonly spectator: boolean;
      /**
       * Secret that lets THIS client reclaim THIS seat after a drop (see the
       * `reconnect` client message). Present only for a seated player — never for a
       * spectator, and never for the opposing seat. Optional so older clients, which
       * simply ignore it, keep working unchanged.
       */
      readonly reconnectToken?: string;
    }
  | { readonly t: 'lobby'; readonly code: string; readonly phase: RoomPhase; readonly players: readonly LobbyPlayer[] }
  | { readonly t: 'gameStarted'; readonly yourSeat: PlayerId }
  | { readonly t: 'mulliganPrompt'; readonly hand: readonly CardInstance[]; readonly mulligansTaken: number }
  | {
      readonly t: 'state';
      readonly view: MaskedGameView;
      readonly legalActions: readonly GameAction[];
      readonly yourTurn: boolean;
      readonly log: readonly string[];
    }
  | { readonly t: 'gameOver'; readonly winner: PlayerId | null; readonly reason: string }
  | { readonly t: 'opponentDisconnected' }
  | { readonly t: 'opponentReconnected' }
  | { readonly t: 'error'; readonly code: ErrorCode; readonly message: string }
  | { readonly t: 'pong' };

export type ServerMessageTag = ServerMessage['t'];

/** Exhaustiveness helper: callers can `default: return assertNever(msg)` in a switch. */
export function assertNever(x: never): never {
  throw new Error(`Unexpected variant: ${JSON.stringify(x)}`);
}
