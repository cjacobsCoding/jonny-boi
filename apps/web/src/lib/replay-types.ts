/**
 * Plain-data shapes for the match-replay viewer (DESIGN §3.7 — watch a single
 * AI-vs-AI game turn by turn from the event log).
 *
 * The sim Web Worker plays ONE game with `recordTrace:true` and serializes it into
 * a `MatchTrace`: the full ordered event log + a per-event board snapshot + a small
 * instance→card metadata map (so the UI can name/draw permanents the events only
 * reference by id) + the two seats and the outcome. Everything here survives
 * `postMessage` structured-clone — no class instances, no functions (DESIGN §2:
 * the event log is the replay source; this is its serialized, render-ready form).
 *
 * The UI never re-runs the sim: it indexes into `frames[step]` to render the board
 * at that point and folds `events` for the scrolling log + key-moment highlights.
 */
import type { GameEvent, PlayerId, Step } from '@jonny-boi/core';

/** A permanent on the battlefield at a given replay frame (render-ready). */
export interface ReplayPermanent {
  readonly instanceId: number;
  readonly name: string;
  /** The pool card id, when this instance maps to a real pool card (for art). */
  readonly cardId: string | null;
  /** Effective power/toughness (creatures only; null for non-creatures). */
  readonly power: number | null;
  readonly toughness: number | null;
  readonly tapped: boolean;
  readonly summoningSick: boolean;
  /** Damage marked this turn (so a wounded creature reads correctly). */
  readonly damageMarked: number;
  readonly isCreature: boolean;
  readonly isLand: boolean;
}

/** One player's render-ready state at a replay frame. */
export interface ReplaySide {
  readonly life: number;
  readonly handCount: number;
  readonly libraryCount: number;
  readonly graveyardCount: number;
  readonly board: readonly ReplayPermanent[];
}

/**
 * A single replay frame: the board AFTER the event at `eventIndex` was applied.
 * `frames[0]` is the opening state (before any logged action). One frame per
 * *checkpoint* the worker captured (after each applied action), each tagged with
 * the index of the last event it includes so the scrubber maps cleanly to the log.
 */
export interface ReplayFrame {
  /** Index into `events` of the last event reflected by this frame. -1 = opening. */
  readonly eventIndex: number;
  readonly turn: number;
  readonly step: Step;
  readonly activePlayer: PlayerId;
  readonly sides: Readonly<Record<PlayerId, ReplaySide>>;
  readonly stackSize: number;
  readonly gameOver: boolean;
  readonly winner: PlayerId | null;
}

/** Identity of a seat in the replayed match. */
export interface ReplaySeat {
  readonly player: PlayerId;
  readonly deckName: string;
  readonly pilot: string;
}

/** Why the game ended, ready to render as a banner. */
export type ReplayOutcome =
  | { readonly kind: 'win'; readonly winner: PlayerId }
  | { readonly kind: 'timeout' };

/** A complete, serialized single-game trace the viewer scrubs through. */
export interface MatchTrace {
  readonly seats: Readonly<Record<PlayerId, ReplaySeat>>;
  /** The full event log (the replay source of truth). May be truncated (see note). */
  readonly events: readonly GameEvent[];
  /** One board snapshot per checkpoint, in order (frames[0] = opening). */
  readonly frames: readonly ReplayFrame[];
  /** instanceId → name, for events that carry only an id. */
  readonly names: Readonly<Record<number, string>>;
  /** instanceId → pool card id (for art), when known. */
  readonly cardIds: Readonly<Record<number, string>>;
  readonly outcome: ReplayOutcome;
  readonly seed: number;
  readonly turns: number;
  /** Total actions the game took (frames track these). */
  readonly actions: number;
  /**
   * True when the game was longer than the trace cap and the tail was dropped, so
   * the UI can say "first N events shown" rather than imply the game is complete.
   */
  readonly truncated: boolean;
}
