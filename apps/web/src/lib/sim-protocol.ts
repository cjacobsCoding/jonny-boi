/**
 * What the Lab UI can ASK FOR, and what it gets back — the request/result shapes
 * shared by the views, the `useSimWorker` hook, and the parallel runner.
 *
 * The sim plays hundreds–thousands of games; running it on the main thread would
 * freeze the UI (DESIGN §1.6 / the Lab brief). So ALL sim execution lives in Web
 * Workers. A request here is the WHOLE job the user asked for; `sim/plan.ts` cuts
 * it into shards and `sim/shard-protocol.ts` describes those — keeping "what the
 * user wants" and "how it is divided across cores" as two separate contracts.
 *
 * Every shape is plain data that survives `postMessage` structured-clone — no
 * class instances, no functions, just the serializable fields the UI renders.
 */
import type { PrecisionDecision, SequentialOutcome } from '@jonny-boi/sim';
import type {
  GauntletResult,
  SuggestionHistory,
  SuggestionReport,
  SwapEvaluation,
  SwapScope,
} from '@jonny-boi/sim';
import type { LandRatio, TrimRoundKind, TrimRoundReport } from '@jonny-boi/sim';
import type { MatchTrace } from './replay-types.js';

/*
 * Note on deck import: the compiled definitions for cards outside the curated
 * pool do NOT ride on a request. Each worker builds its own card pool from
 * scratch and a run dispatches hundreds of shards, so they are shipped once per
 * worker in the pool's `init` message (`sim/shard-protocol.ts`) instead of once
 * per shard. `useSimWorker` injects them when it builds the pool — the single
 * chokepoint every run goes through, so no call site can forget them.
 */

/** A deck handed to the worker: the sim's `Deck` shape (id-or-name cardIds). */
export interface SimDeckPayload {
  readonly name: string;
  readonly archetype: string;
  readonly cards: ReadonlyArray<{ readonly cardId: string; readonly count: number; readonly name?: string }>;
}

/**
 * **THE PILOT IS PART OF THE QUESTION, SO IT IS PART OF EVERY REQUEST.**
 *
 * A win rate is a measurement of a deck *as played by one pilot on both seats*,
 * not a property of the deck: running the gauntlet with `hybrid` instead of
 * `heuristic` moved Mono-Red Aggro from 32.9% to 19.0% (both pre-date the land-sequencing fix; the gauntlet baseline is now 28.2%). Both are right; they
 * answer different questions. So `pilotId` is REQUIRED on every request rather
 * than optional-with-a-default — an optional field is a field a call site can
 * forget, and the one that forgets it would silently answer a different question
 * than the UI is displaying. (This repo has already paid for a constant that two
 * packages each defaulted separately; see COORDINATION.md on the room-code bug.)
 *
 * The id is a plain string resolved against `@jonny-boi/ai`'s registry in the
 * worker — the same seam the CLI's `--pilot` flag uses.
 */
export interface PilotedRequest {
  readonly pilotId: string;
}

/** Run the hero against the chosen gauntlet decks (by sample-deck name). */
export interface GauntletRequest extends PilotedRequest {
  readonly kind: 'gauntlet';
  readonly hero: SimDeckPayload;
  /** Sample-deck names to test against (the worker resolves them to decks). */
  readonly opponentNames: readonly string[];
  readonly gamesPerOpponent: number;
  readonly seed: number;
  /**
   * Stop once the win-rate interval reaches this half-width (§3.94). A gauntlet
   * ESTIMATES rather than tests, so this is a two-stage fixed-width rule and NOT
   * the group-sequential boundary the A/B panel uses — different question,
   * different statistics.
   */
  readonly untilPrecise?: number;
}

/** Evaluate a single-card swap (out → in) on the hero against the gauntlet. */
export interface SwapRequest extends PilotedRequest {
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
  /**
   * Stop as soon as a pre-registered group-sequential boundary is crossed (§3.92).
   * A decided swap finishes in a fraction of the budget; an undecided one runs the
   * whole thing and costs nothing extra.
   */
  readonly untilDecided?: boolean;
}

/** Rank candidate single-card swaps that improve the hero (the suggestion loop). */
export interface SuggestRequest extends PilotedRequest {
  readonly kind: 'suggest';
  readonly hero: SimDeckPayload;
  readonly opponentNames: readonly string[];
  /** Depth a FINALIST reaches. The search is adaptive — losers get far less. */
  readonly gamesPerCandidate: number;
  readonly maxCandidates: number;
  readonly seed: number;
  /**
   * What earlier runs on this deck already learned (`lib/sim/history-store.ts`
   * keeps it in `localStorage`). Supplying it is what makes a re-run explore NEW
   * candidates instead of re-deriving the same shortlist — the user-reported bug
   * "it just started comparing to Eternal Witness AGAIN". The finished report
   * carries the updated record back for the caller to persist.
   */
  readonly history?: SuggestionHistory;
  /**
   * §3.136 — FOCUSED MODE: consider cutting only these cards (names or ids).
   * Asked for directly ("scoped to looking at just specific cards in the deck").
   * Omit to search the whole deck.
   */
  readonly cutOnly?: readonly string[];
  /**
   * §3.136 — how many copies each candidate swap moves: one, the whole playset,
   * or a named count ("I have 3 Elvish Visionaries but I want to swap 2").
   * Omit for `DEFAULT_SWAP_SCOPE`.
   */
  readonly swapScope?: SwapScope;
}

/**
 * Play ONE game (hero vs a chosen opponent) and record the full trace, so the
 * match-replay viewer can scrub through it turn by turn (DESIGN §3.7). The hero
 * sits in seat A, the opponent in seat B; the worker resolves the opponent by
 * sample-deck name. A `maxEvents` cap bounds a pathological game's trace.
 */
export interface MatchRequest extends PilotedRequest {
  readonly kind: 'match';
  readonly hero: SimDeckPayload;
  /** Sample-deck name to play against (resolved by the worker). */
  readonly opponentName: string;
  readonly seed: number;
  /** Hard cap on recorded events (named in replay-config); the worker truncates. */
  readonly maxEvents: number;
}

/**
 * ONE ROUND of the Lab's trim (DESIGN §3.174): evaluate single-card removals of
 * the hero (or nonland+land pairs, the widening step) with the paired A/B
 * machinery, and report which — if any — proved better.
 *
 * A round, not a session, on purpose: the panel applies a winning removal to
 * the deck itself and re-issues the next round on the updated hero, so the
 * deck the Lab re-reads is the deck that was tested, and Cancel is the ordinary
 * one-run cancel. `round` offsets the seed so consecutive rounds play different
 * games; `baseLandRatio` is the deck's ratio when the session began, so the mana
 * prior measures drift from where the user started.
 */
export interface TrimRequest extends PilotedRequest {
  readonly kind: 'trim';
  readonly hero: SimDeckPayload;
  readonly opponentNames: readonly string[];
  /** Depth a FINALIST reaches — the same adaptive ladder Suggest runs. */
  readonly gamesPerCandidate: number;
  readonly seed: number;
  /** 0 for the session's first round. */
  readonly round: number;
  readonly roundKind: TrimRoundKind;
  readonly targetSize: number;
  /** Omitted on the first round: the hero IS the base. */
  readonly baseLandRatio?: LandRatio;
}

/** Anything the UI can ask the worker to run. */
export type SimRequest = GauntletRequest | SwapRequest | SuggestRequest | MatchRequest | TrimRequest;

/**
 * Live progress for the whole run, aggregated across every worker.
 *
 * The unit is GAMES for all run kinds. Coarser units (opponents, candidates)
 * looked fine on a single worker but lie once twelve run at once: eleven
 * candidates can be 90% played and still show zero done. Games completed out of
 * games planned is the one count that stays honest whatever the core count, so
 * the bar, the throughput and the ETA all derive from it.
 */
export interface SimProgress {
  readonly type: 'progress';
  /** Games completed so far, summed over every worker. */
  readonly done: number;
  /** Games the run plans to play in total (0 while a run is still planning). */
  readonly total: number;
  /** Same tally as `done`, kept for the games/sec readout. */
  readonly gamesRun: number;
  /** Wall-clock seconds since the run started. */
  readonly elapsedSeconds: number;
  /** A short human label for what the run is doing right now. */
  readonly label: string;
}

/**
 * A finished run's payload — discriminated by the request `kind`.
 *
 * Every variant carries the `pilotId` that produced it, echoed from the request.
 * A result that travelled without its pilot would be a number with no units: the
 * UI could not label it, and a result left on screen while the picker moved would
 * describe a run nobody made.
 */
export type SimResultPayload =
  | {
      readonly kind: 'gauntlet';
      /** Present only when the run sized itself to a precision target. */
      readonly precision?: PrecisionDecision;
      readonly result: GauntletResult;
      readonly gamesPerSecond: number;
      readonly pilotId: string;
    }
  | {
      readonly kind: 'swap';
      readonly result: SwapEvaluation;
      readonly gamesPerSecond: number;
      readonly pilotId: string;
      /**
       * Present only when the run used group-sequential stopping. The UI shows it
       * because 'we played a quarter of the games you asked for' is something the
       * reader must be told, not left to infer from a smaller n.
       */
      readonly sequential?: SequentialOutcome;
    }
  | { readonly kind: 'suggest'; readonly result: SuggestionReport; readonly pilotId: string }
  | { readonly kind: 'match'; readonly result: MatchTrace; readonly pilotId: string }
  | { readonly kind: 'trim'; readonly result: TrimRoundReport; readonly pilotId: string };

