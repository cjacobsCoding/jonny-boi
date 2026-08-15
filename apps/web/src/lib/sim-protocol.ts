/**
 * The message protocol between the Lab UI (main thread) and the sim Web Worker.
 *
 * The sim plays hundreds–thousands of games; running it on the main thread would
 * freeze the UI (DESIGN §1.6 / the Lab brief). So ALL sim execution lives in
 * `sim.worker.ts`; the UI posts a `SimRequest` and receives a stream of
 * `SimResponse`s (progress → result, or an error). This module owns the shared
 * shapes both sides import, so the contract has one definition (DRY).
 *
 * The worker imports `@jonny-boi/sim` (+ core/cards/ai) and reports results in
 * plain-data shapes that survive `postMessage` structured-clone — no class
 * instances, no functions, just the serializable fields the UI renders.
 */
import type {
  GauntletResult,
  SwapEvaluation,
  SuggestionReport,
} from '@jonny-boi/sim';
import type { CardDefinition } from '@jonny-boi/core';
import type { SwapScope } from '@jonny-boi/sim';
import type { MatchTrace } from './replay-types.js';

/**
 * Fields every request carries. `importedCards` is how deck import reaches the
 * simulation: the worker builds its own card pool from scratch, so without
 * shipping the compiled definitions across the boundary an imported deck would
 * fail to load in the Lab even though it plays fine on the main thread. The
 * hook injects this automatically so no call site can forget it.
 */
export interface SimRequestBase {
  /** Compiled definitions for cards outside the curated pool (see `decklist/`). */
  readonly importedCards?: readonly CardDefinition[];
}

/** A deck handed to the worker: the sim's `Deck` shape (id-or-name cardIds). */
export interface SimDeckPayload {
  readonly name: string;
  readonly archetype: string;
  readonly cards: ReadonlyArray<{ readonly cardId: string; readonly count: number }>;
}

/** Run the hero against the chosen gauntlet decks (by sample-deck name). */
export interface GauntletRequest extends SimRequestBase {
  readonly kind: 'gauntlet';
  readonly hero: SimDeckPayload;
  /** Sample-deck names to test against (the worker resolves them to decks). */
  readonly opponentNames: readonly string[];
  readonly gamesPerOpponent: number;
  readonly seed: number;
}

/** Evaluate a single-card swap (out → in) on the hero against the gauntlet. */
export interface SwapRequest extends SimRequestBase {
  readonly kind: 'swap';
  readonly hero: SimDeckPayload;
  readonly opponentNames: readonly string[];
  readonly outCardId: string;
  readonly inCardId: string;
  readonly gamesPerOpponent: number;
  readonly seed: number;
  /**
   * Replace one copy or the whole playset. Omitted means the sim's default
   * (`DEFAULT_SWAP_SCOPE`) — the two answer different questions, so the UI always
   * sends this explicitly and shows which was tested.
   */
  readonly swapScope?: SwapScope;
}

/** Rank candidate single-card swaps that improve the hero (the suggestion loop). */
export interface SuggestRequest extends SimRequestBase {
  readonly kind: 'suggest';
  readonly hero: SimDeckPayload;
  readonly opponentNames: readonly string[];
  readonly gamesPerCandidate: number;
  readonly maxCandidates: number;
  readonly seed: number;
}

/**
 * Play ONE game (hero vs a chosen opponent) and record the full trace, so the
 * match-replay viewer can scrub through it turn by turn (DESIGN §3.7). The hero
 * sits in seat A, the opponent in seat B; the worker resolves the opponent by
 * sample-deck name. A `maxEvents` cap bounds a pathological game's trace.
 */
export interface MatchRequest extends SimRequestBase {
  readonly kind: 'match';
  readonly hero: SimDeckPayload;
  /** Sample-deck name to play against (resolved by the worker). */
  readonly opponentName: string;
  readonly seed: number;
  /** Hard cap on recorded events (named in replay-config); the worker truncates. */
  readonly maxEvents: number;
}

/** Anything the UI can ask the worker to run. */
export type SimRequest = GauntletRequest | SwapRequest | SuggestRequest | MatchRequest;

/** Coarse progress so the UI can show a bar + throughput while a run is live. */
export interface SimProgress {
  readonly type: 'progress';
  /** Units completed so far (opponents, candidates, …) — units depend on `kind`. */
  readonly done: number;
  /** Total units to complete. */
  readonly total: number;
  /** Individual games the sim has played so far (for games/sec). */
  readonly gamesRun: number;
  /** Wall-clock seconds since the run started. */
  readonly elapsedSeconds: number;
  /** A short human label for what the worker is doing right now. */
  readonly label: string;
}

/** A finished run's payload — discriminated by the request `kind`. */
export type SimResultPayload =
  | { readonly kind: 'gauntlet'; readonly result: GauntletResult; readonly gamesPerSecond: number }
  | { readonly kind: 'swap'; readonly result: SwapEvaluation; readonly gamesPerSecond: number }
  | { readonly kind: 'suggest'; readonly result: SuggestionReport }
  | { readonly kind: 'match'; readonly result: MatchTrace };

/** A successful result message. */
export interface SimDone {
  readonly type: 'result';
  readonly payload: SimResultPayload;
}

/** A friendly, already-formatted error message (never a raw stack to the user). */
export interface SimError {
  readonly type: 'error';
  readonly message: string;
}

/** Anything the worker can send back to the UI. */
export type SimResponse = SimProgress | SimDone | SimError;
