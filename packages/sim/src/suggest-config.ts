/**
 * Named constants for the deck **suggestion engine** (DESIGN §3.6).
 *
 * Every value that bounds the search, shapes the cheap pre-ranking heuristic, or
 * orders the final recommendations lives here — so `suggest.ts` carries NO inline
 * magic numbers (CLAUDE.md rule 1 / DESIGN §1.3). Tune the suggester from one
 * place; the CLI surfaces the ones a user trades speed-vs-confidence against.
 */

/** Bounds + thresholds the auto candidate search and the ranking obey. */
export interface SuggestConfig {
  /**
   * Hard cap on candidate swaps actually evaluated by the sim in auto mode. The
   * combinatorial space (cuttable cards × addable cards) explodes, and each
   * candidate costs `2 × |gauntlet| × games` matches, so we keep only the top-K
   * by the cheap heuristic and record everything we skipped (no silent
   * truncation — CLAUDE.md rule 6).
   */
  readonly maxCandidates: number;
  /**
   * Games per matchup for each candidate evaluation. Lower = faster + noisier
   * (more 'inconclusive'); higher = slower + more confident. The CLI exposes
   * this as `--games`.
   */
  readonly defaultGamesPerCandidate: number;
  /**
   * The minimum copies of a basic land the suggester will leave in a deck when
   * proposing to cut one. Cutting basics to "oblivion" makes the deck unplayable
   * (no mana); we keep the deck legal/playable, a NAMED constraint (the task's
   * "keep the deck legal" rule), not an inline literal.
   */
  readonly minBasicLandsKept: number;
}

export const DEFAULT_SUGGEST_CONFIG: SuggestConfig = Object.freeze({
  // ~6 candidates × a 4-deck gauntlet × 40 games ≈ a few thousand games — a
  // single tractable CLI run. Raise it for a deeper (slower) search.
  maxCandidates: 12,
  defaultGamesPerCandidate: 60,
  // A deck below this many of a given basic clearly can't cast its spells; we
  // never propose a cut that would drop a basic-land line under it.
  minBasicLandsKept: 18,
});

/**
 * Weights for the cheap pre-ranking heuristic that picks which candidates make
 * the `maxCandidates` cut WITHOUT running a sim. We never claim this heuristic
 * judges strength — it only orders candidates so the bounded auto mode spends its
 * sim budget on plausibly-relevant swaps (an `in` card that shares the deck's
 * colors and fits its curve) instead of obvious non-starters. The sim + stats
 * make the real call.
 */
export interface HeuristicWeights {
  /** Reward an `in` card whose color identity the deck can already cast. */
  readonly colorMatch: number;
  /** Reward an `in` card near the deck's average spell mana-value (curve fit). */
  readonly curveFit: number;
}

export const DEFAULT_HEURISTIC_WEIGHTS: HeuristicWeights = Object.freeze({
  colorMatch: 1,
  curveFit: 1,
});

/**
 * Rank-bucket ordering. The final list groups swaps into proven-better,
 * inconclusive, then proven-worse; within a bucket we order by delta then
 * p-value. These ordinals make that ordering data, not a literal in a comparator.
 */
export const RANK_BUCKET_ORDER = Object.freeze({
  better: 0,
  inconclusive: 1,
  worse: 2,
});
