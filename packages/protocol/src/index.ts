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
  StackObject,
  CombatState,
  Step,
  GameAction,
} from '@jonny-boi/core';

/** Bumped on any breaking change to the message shapes below; checked at handshake. */
export const PROTOCOL_VERSION = 1;

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
  };
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
  | { readonly t: 'roomJoined'; readonly code: string; readonly yourSeat: PlayerId | null; readonly spectator: boolean }
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
