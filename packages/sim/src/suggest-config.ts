/**
 * Named constants for the deck **suggestion engine** (DESIGN §3.6).
 *
 * Every value that bounds the search, shapes the cheap pre-ranking heuristic, or
 * orders the final recommendations lives here — so `suggest.ts` carries NO inline
 * magic numbers (CLAUDE.md rule 1 / DESIGN §1.3). Tune the suggester from one
 * place; the CLI surfaces the ones a user trades speed-vs-confidence against.
 */

import type { MultipleComparisonsMethod } from './stats.js';

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
   * Games per matchup a candidate may reach at FULL depth — the budget a finalist
   * that survives every wave is measured with, and (in the legacy fixed scheme)
   * the budget every candidate gets whether it deserves it or not. Lower = faster
   * + noisier (more 'inconclusive'); higher = slower + more confident. The CLI
   * exposes this as `--games`.
   */
  readonly defaultGamesPerCandidate: number;
  /**
   * The minimum copies of ONE basic-land line the suggester will leave in a deck
   * when proposing to cut from it. Cutting basics to "oblivion" makes the deck
   * unplayable (no mana); we keep the deck legal/playable, a NAMED constraint (the
   * task's "keep the deck legal" rule), not an inline literal.
   */
  readonly minBasicLandsKept: number;
}

export const DEFAULT_SUGGEST_CONFIG: SuggestConfig = Object.freeze({
  // The wave-1 scout roster. Adaptive sampling made width cheap: the fixed scheme
  // could afford 12 candidates × full depth, while successive halving scouts twice
  // as many for a fraction of the games and still measures the finalists at full
  // depth. Raise it for a wider (slower) search.
  maxCandidates: 24,
  defaultGamesPerCandidate: 60,
  // A deck below this many of a given basic clearly can't cast the spells of that
  // colour. It is a per-LINE floor, so it has to be read against the smallest line
  // a real deck runs, not against a mono-coloured deck's total: the gauntlet's
  // two-colour decks run eight to ten of each basic, and a floor above that would
  // silently make every land in every two-colour deck uncuttable.
  minBasicLandsKept: 8,
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
 * THE ADAPTIVE SEARCH (successive halving over candidate swaps).
 *
 * The fixed scheme spent the same games on an obvious loser as on a real
 * contender, and re-ran the identical shortlist every time. This config drives a
 * wave scheduler instead: every candidate gets a small scout batch, the budget then
 * concentrates on the candidates still plausibly better, and clear losers are
 * dropped early. Nothing here is a literal in the scheduler.
 */
export interface AdaptiveSearchConfig {
  /**
   * Stop the ladder once the LEADER is decided against the RUNNER-UP (§3.98).
   *
   * ⚠️ This is the only stopping rule that does not cost the ranking. §3.96 found
   * that the finalists are usually decided against the BASE long before the last
   * wave — but `suggest` outputs an ORDER, and the last wave is what separates the
   * leaders from each other. Stopping on "beats the base" would leave exactly the
   * comparison a user acts on as uncertain as before. Stopping on "beats the
   * runner-up" cannot, because that IS the comparison.
   */
  readonly stopWhenLeaderSettled: boolean;
  /**
   * Fraction of a wave's roster carried into the next wave. 0.5 is the classic
   * successive-halving choice: halve the field, double the games, so every wave
   * costs roughly the same while the survivors' precision keeps doubling.
   */
  readonly survivalFraction: number;
  /** Never cut below this many survivors — a final wave needs something to compare. */
  readonly minSurvivors: number;
  /** How much the per-candidate game budget grows each wave (the other half of halving). */
  readonly gamesGrowthFactor: number;
  /**
   * Floor on a wave's per-candidate games. A scout batch far below this tells you
   * nothing at all (the paired test needs discordant pairs to look at), so the
   * scheduler stops adding waves rather than planning a meaningless one.
   */
  readonly minGamesPerWave: number;
  /** Hard cap on waves, so a huge roster can't plan an unbounded ladder. */
  readonly maxWaves: number;
  /**
   * Break-even share of DISCORDANT pairs. In a paired test only the games where
   * the two decks disagreed carry information; the variant is better exactly when
   * it wins more than half of them. 0.5 is the null, not a tunable preference.
   */
  readonly futilityBreakEvenShare: number;
  /**
   * Discordant pairs a candidate must have accumulated before the futility rule may
   * retire it. Below this the confidence bound is so wide it can never trigger, and
   * requiring it makes the rule's intent explicit rather than emergent.
   */
  readonly minDiscordantForFutility: number;
  /**
   * How many *untried but related* candidates may be injected after a wave (the
   * "exploit a promising direction" rule). 0 disables offspring entirely.
   */
  readonly offspringPerWave: number;
  /**
   * Offspring may only join while the next wave's per-candidate budget is at most
   * this fraction of the maximum. A newcomer must play catch-up from zero games, so
   * letting one in at the deepest wave would cost a full-budget evaluation for a
   * candidate with no evidence behind it.
   */
  readonly offspringMaxEntryBudgetFraction: number;
  /** How the family of simultaneous candidate tests is corrected (DESIGN §3.6). */
  readonly multipleComparisons: MultipleComparisonsMethod;
}

export const DEFAULT_ADAPTIVE_CONFIG: AdaptiveSearchConfig = Object.freeze({
  stopWhenLeaderSettled: true,
  survivalFraction: 0.5,
  minSurvivors: 2,
  gamesGrowthFactor: 2,
  // Fewer than a handful of games per opponent produces a table with no discordant
  // pairs at all, which is not a measurement — it is noise with a p-value of 1.
  minGamesPerWave: 14,
  maxWaves: 5,
  futilityBreakEvenShare: 0.5,
  minDiscordantForFutility: 10,
  offspringPerWave: 2,
  offspringMaxEntryBudgetFraction: 0.5,
  // Family-wise control by default: a tool that says "play this card" should be
  // wrong ~5% of the time across the whole list, not 5% per row.
  multipleComparisons: 'holm' as MultipleComparisonsMethod,
});

/**
 * Weights for **progressive exploration** — how a re-run picks a different, better
 * slate than the run before it, and how a run leans into a promising direction.
 *
 * This is the deliberately-simple, explainable version of the "genetic algorithm"
 * intuition: prefer what has never been tried, refine what looked promising, drop
 * what is settled, and prefer candidates that resemble whatever is currently
 * winning. Every term is a named weight, and the report prints which term earned a
 * candidate its slot.
 */
export interface ExplorationWeights {
  /** Weight on the cheap colour/curve prior (`scoreCandidate`). */
  readonly heuristicPrior: number;
  /** Bonus for a candidate no previous run has ever simulated. */
  readonly untried: number;
  /** Bonus for re-testing a previously promising but inconclusive candidate. */
  readonly refinePromising: number;
  /** Observed paired delta a past candidate must beat to count as "promising". */
  readonly promisingDelta: number;
  /**
   * Games after which a candidate that has never shown a positive delta is
   * considered settled and stops being re-tested. This is what stops run two from
   * re-testing run one's losers — the user's actual complaint.
   */
  readonly settledAfterGames: number;
  /** Relatedness: shares the `in` card with a current leader (a different cut). */
  readonly sameInCard: number;
  /** Relatedness: shares the `out` card with a current leader (a different add). */
  readonly sameOutCard: number;
  /** Relatedness: the `in` card has the same colour identity as a leader's. */
  readonly sameColorIdentity: number;
  /** Relatedness: the `in` card sits in the same curve slot (mana value). */
  readonly sameCurveSlot: number;
  /** Relatedness: the `in` card fills the same role (primary card type). */
  readonly sameRole: number;
}

export const DEFAULT_EXPLORATION_WEIGHTS: ExplorationWeights = Object.freeze({
  // The colour/curve prior is a weak signal, so it orders candidates only when
  // nothing stronger (untried, related to a leader) separates them.
  heuristicPrior: 1,
  // Dominates the prior: an untried candidate is the entire point of a re-run.
  untried: 100,
  // Above the prior, below untried — refine after the unexplored space is served.
  refinePromising: 50,
  promisingDelta: 0,
  settledAfterGames: 40,
  // Same cut / same add are the strongest "nearby" signals a card swap has.
  sameInCard: 30,
  sameOutCard: 20,
  sameColorIdentity: 8,
  sameCurveSlot: 6,
  sameRole: 4,
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
