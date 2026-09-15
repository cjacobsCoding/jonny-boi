/**
 * The PURE online-session reducer (DOM-free, unit-tested). It folds the connection
 * status and the stream of `ServerMessage`s (plus a couple of local UI intents) into a
 * single immutable `OnlineState` the React layer renders from. Keeping the state
 * machine pure means the lobby/deck-selection/in-game transitions are testable with
 * mocked `ServerMessage`s — no real server, no React.
 *
 * The server is authoritative: we never run the engine here. In-game we simply hold
 * the latest `state` frame (`MaskedGameView` + `legalActions` + `yourTurn` + `log`).
 */
import type { CardInstance, GameAction, PlayerId } from '@jonny-boi/core';
import type {
  ErrorCode,
  LobbyPlayer,
  MaskedGameView,
  PublicGameEvent,
  RoomPhase,
  ServerMessage,
  StartingPlayerChoice,
} from '@jonny-boi/protocol';
import type { ConnectionStatus } from './connection.js';

/** A transient error banner/toast the UI shows then clears. */
export interface OnlineError {
  readonly code: ErrorCode;
  readonly message: string;
}

/** The latest authoritative in-game frame from the server. */
export interface GameFrame {
  readonly view: MaskedGameView;
  readonly legalActions: readonly GameAction[];
  readonly yourTurn: boolean;
  readonly log: readonly string[];
  /**
   * THE WHOLE GAME'S public events so far, in order — this seat's share of them,
   * already filtered by the server's `maskEventsForSeat`.
   *
   * CUMULATIVE, not the latest batch, because that is the shape its consumer
   * needs: `useDamageSequence` keeps a high-water mark into one growing log and
   * derives only what is new, so a per-frame array would make every frame look
   * like a fresh combat. A server that sends no `events` (v2, or an action that
   * produced nothing public) simply appends nothing.
   */
  readonly events: readonly PublicGameEvent[];
}

/** Shared empty log, so a frame from a server with no event channel allocates none. */
const NO_EVENTS: readonly PublicGameEvent[] = Object.freeze([]);

/**
 * Which screen the online flow is on. This is CLIENT-side routing derived from the
 * server's messages; the server's own `RoomPhase` is mirrored in `roomPhase`.
 */
export type OnlineScreen =
  | 'menu' // choose create vs join
  | 'connecting' // socket opening / waiting on roomJoined
  | 'lobby' // in a room, picking deck + ready
  | 'mulligan' // mulligan decision
  | 'playing' // in-game board
  | 'finished'; // game over

/** The full online-session state. */
export interface OnlineState {
  readonly screen: OnlineScreen;
  readonly status: ConnectionStatus;
  /** The room code (once joined/created). */
  readonly code: string | null;
  /** Which seat we own (null until the server assigns it). */
  readonly yourSeat: PlayerId | null;
  /** True if we're a spectator (no seat). */
  readonly spectator: boolean;
  /** The server's room phase (mirrors its lifecycle). */
  readonly roomPhase: RoomPhase | null;
  /** Both lobby players (names, ready, hasDeck). */
  readonly lobbyPlayers: readonly LobbyPlayer[];
  /** Who the creator chose to take the first turn (§3.125); null until the lobby says. */
  readonly startingPlayer: StartingPlayerChoice | null;
  /** Whether THIS client has chosen a deck (local intent echo). */
  readonly deckChosen: boolean;
  /** Whether THIS client is ready (local intent echo; server lobby is authoritative). */
  readonly ready: boolean;
  /** The mulligan prompt hand, when the server is asking us to keep/ship. */
  readonly mulliganHand: readonly CardInstance[] | null;
  readonly mulligansTaken: number;
  /** The latest in-game frame. */
  readonly frame: GameFrame | null;
  /** Game-over result. */
  readonly result: { readonly winner: PlayerId | null; readonly reason: string } | null;
  /** Opponent connectivity (banner). */
  readonly opponentConnected: boolean;
  /** A transient error to surface. */
  readonly error: OnlineError | null;
}

/** The initial state (before any connection). */
export const INITIAL_ONLINE_STATE: OnlineState = Object.freeze({
  screen: 'menu',
  status: 'closed',
  code: null,
  yourSeat: null,
  spectator: false,
  roomPhase: null,
  lobbyPlayers: [],
  startingPlayer: null,
  deckChosen: false,
  ready: false,
  mulliganHand: null,
  mulligansTaken: 0,
  frame: null,
  result: null,
  opponentConnected: true,
  error: null,
});

/**
 * Local UI intents folded into state alongside server messages. (The actual network
 * send happens in the hook; these record the local echo so the UI reflects intent
 * immediately, e.g. "deck chosen" before the lobby broadcast returns.)
 */
export type OnlineEvent =
  | { readonly kind: 'server'; readonly msg: ServerMessage }
  | { readonly kind: 'status'; readonly status: ConnectionStatus }
  | { readonly kind: 'requestCreate' }
  | { readonly kind: 'requestJoin' }
  | { readonly kind: 'localDeckChosen' }
  | { readonly kind: 'localReady'; readonly ready: boolean }
  | { readonly kind: 'dismissError' }
  | { readonly kind: 'leave' };

/** Map a server `RoomPhase` to the client screen (when in a room). */
function screenForPhase(phase: RoomPhase, prev: OnlineScreen): OnlineScreen {
  switch (phase) {
    case 'waiting':
    case 'deckSelect':
      return 'lobby';
    case 'mulligan':
      // Stay on the board if we're already there but the phase is still 'mulligan'
      // for the OTHER seat; our own mulligan is driven by `mulliganPrompt`.
      return prev === 'playing' ? 'playing' : 'lobby';
    case 'playing':
      return 'playing';
    case 'finished':
      return 'finished';
    default:
      return prev;
  }
}

/** The pure reducer. */
export function onlineReducer(state: OnlineState, event: OnlineEvent): OnlineState {
  switch (event.kind) {
    case 'status':
      return reduceStatus(state, event.status);
    case 'requestCreate':
    case 'requestJoin':
      return { ...state, screen: 'connecting', error: null };
    case 'localDeckChosen':
      return { ...state, deckChosen: true };
    case 'localReady':
      return { ...state, ready: event.ready };
    case 'dismissError':
      return { ...state, error: null };
    case 'leave':
      return { ...INITIAL_ONLINE_STATE, status: state.status };
    case 'server':
      return reduceServer(state, event.msg);
  }
}

function reduceStatus(state: OnlineState, status: ConnectionStatus): OnlineState {
  return { ...state, status };
}

function reduceServer(state: OnlineState, msg: ServerMessage): OnlineState {
  switch (msg.t) {
    case 'roomJoined':
      return {
        ...state,
        code: msg.code,
        yourSeat: msg.yourSeat,
        spectator: msg.spectator,
        screen: 'lobby',
        error: null,
      };
    case 'lobby':
      return {
        ...state,
        code: msg.code,
        roomPhase: msg.phase,
        lobbyPlayers: msg.players,
        // Absent from an older server's lobby message → keep whatever we knew.
        startingPlayer: msg.startingPlayer ?? state.startingPlayer,
        screen: screenForPhase(msg.phase, state.screen),
      };
    case 'gameStarted':
      return {
        ...state,
        yourSeat: msg.yourSeat,
        screen: 'playing',
        result: null,
        mulliganHand: null,
        // A REMATCH is a new game on the same connection, so the cumulative event
        // log has to re-baseline here or the first frame of game two arrives
        // carrying game one's combats and replays every one of them.
        frame: state.frame === null ? null : { ...state.frame, events: NO_EVENTS },
      };
    case 'mulliganPrompt':
      return {
        ...state,
        screen: 'mulligan',
        mulliganHand: msg.hand,
        mulligansTaken: msg.mulligansTaken,
      };
    case 'state': {
      // APPEND, never replace: the frame is the latest board, but `events` is the
      // running log the damage sequence is derived from. `msg.events` is this
      // action's batch — absent on a v2 server, and absent on any send that was
      // not the result of an action (a reconnect, a resync after a refused move),
      // which is exactly when appending nothing is the right answer.
      const previous = state.frame?.events ?? NO_EVENTS;
      const batch = msg.events;
      return {
        ...state,
        screen: 'playing',
        mulliganHand: null,
        frame: {
          view: msg.view,
          legalActions: msg.legalActions,
          yourTurn: msg.yourTurn,
          log: msg.log,
          events: batch === undefined || batch.length === 0 ? previous : [...previous, ...batch],
        },
      };
    }
    case 'gameOver':
      return {
        ...state,
        screen: 'finished',
        result: { winner: msg.winner, reason: msg.reason },
      };
    case 'opponentDisconnected':
      return { ...state, opponentConnected: false };
    case 'opponentReconnected':
      return { ...state, opponentConnected: true };
    case 'error':
      return { ...state, error: { code: msg.code, message: msg.message } };
    case 'pong':
      // Keepalive ack — no state change.
      return state;
  }
}

/** A friendly default message for an error code (used when the server omits one). */
export function friendlyError(code: ErrorCode): string {
  switch (code) {
    case 'roomNotFound':
      return "That room code doesn't exist. Check it and try again.";
    case 'roomFull':
      return 'That room is already full.';
    case 'notInRoom':
      return "You're not in a room.";
    case 'notYourTurn':
      return "It's not your turn.";
    case 'illegalAction':
      return 'That move is not legal right now.';
    case 'invalidDeck':
      return 'That deck is not legal for this game.';
    case 'protocolMismatch':
      // Either side can be the stale one, and the server is the side that usually
      // lags (the web app auto-deploys; the game server is deployed by hand). Saying
      // "refresh" would be actively wrong then — the user would refresh forever.
      return 'This app and the game server are running different versions. Refresh to update the app; if that does not help, the game server needs updating.';
    case 'internal':
      return 'The server hit an unexpected error.';
    default:
      return 'Something went wrong.';
  }
}
