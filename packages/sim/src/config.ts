/**
 * Sim harness constants — every value that affects a run's behaviour or a
 * verdict's threshold lives here, named, so the match loop and the statistics
 * carry NO inline magic numbers (DESIGN §1.3). Tune the lab from one place.
 */

/** Deck-legality rules (constructed-ish). Data, not literals scattered in code. */
export interface DeckRules {
  /** Minimum library size a legal deck must have. */
  readonly minDeckSize: number;
  /** Maximum copies of a non-basic-land card a deck may run. */
  readonly maxCopiesNonBasic: number;
  /** Card names exempt from the copy limit (basic lands — any number allowed). */
  readonly unlimitedCopies: ReadonlySet<string>;
}

/** The basic land names that may appear in unlimited quantities. */
export const BASIC_LAND_NAMES: ReadonlySet<string> = new Set([
  'Plains',
  'Island',
  'Swamp',
  'Mountain',
  'Forest',
]);

/** Default constructed-deck legality rules. */
export const DEFAULT_DECK_RULES: DeckRules = Object.freeze({
  minDeckSize: 60,
  maxCopiesNonBasic: 4,
  unlimitedCopies: BASIC_LAND_NAMES,
});

/** Simulation runtime knobs. */
export interface SimConfig {
  /**
   * Hard cap on turns a single game may run before we declare a timeout draw.
   * Guards against any non-terminating board state — the sim must never hang.
   */
  readonly maxTurnsPerGame: number;
  /**
   * Hard cap on individual actions applied within one game. A second guard in
   * case a state loops without advancing the turn counter (belt and braces).
   */
  readonly maxActionsPerGame: number;
  /** Default number of games when the caller / CLI doesn't specify. */
  readonly defaultGames: number;
}

export const DEFAULT_SIM_CONFIG: SimConfig = Object.freeze({
  // Real MTG games end well under this; a stalled board (e.g. two walls) hits it
  // and is recorded as a draw rather than spinning forever.
  maxTurnsPerGame: 60,
  // Each turn is a bounded number of priority passes / micro-actions; this cap is
  // generously above any legitimate game and only trips on a pathological loop.
  maxActionsPerGame: 20_000,
  defaultGames: 100,
});

/** Statistical thresholds for confidence intervals and the A/B verdict. */
export interface StatsConfig {
  /**
   * Two-sided significance level for the swap verdict. At alpha = 0.05 we call a
   * swap 'better'/'worse' only when the paired test's p-value < 0.05.
   */
  readonly alpha: number;
  /**
   * z critical value for the confidence interval, paired with `alpha`. For a
   * two-sided 95% interval (alpha 0.05) this is 1.959964 (the 0.975 normal
   * quantile). Named so the CI and the verdict share one confidence level.
   */
  readonly z: number;
  /**
   * Minimum paired games before a swap verdict can be anything but
   * 'inconclusive'. Below this the sample is too small to trust regardless of p.
   */
  readonly minGamesForVerdict: number;
}

export const DEFAULT_STATS_CONFIG: StatsConfig = Object.freeze({
  alpha: 0.05,
  // 0.975 quantile of the standard normal — the 95% two-sided z multiplier.
  z: 1.959963984540054,
  minGamesForVerdict: 30,
});

/**
 * The single, shared fidelity caveat (DESIGN §3.9 — now DONE). Engine v2 models
 * triggered abilities and until-end-of-turn continuous effects, so prowess,
 * cast/ETB-trigger tokens, persist, and pumps that wear off all play correctly.
 * A small set of advanced mechanics is still genuinely unimplemented (the
 * authoritative list is `STUBBED_MECHANICS` in `@jonny-boi/cards`); cards that
 * use them play as a simplified subset. Every surface (CLI output, help text,
 * the suggestion report's `notes.fidelityCaveat`, and the web Lab) references
 * THIS constant so there is exactly one wording. The statistics are always exact.
 */
export const FIDELITY_CAVEAT =
  'Note: the engine models triggered abilities and until-end-of-turn effects. A few ' +
  'advanced mechanics remain unimplemented — transform/double-faced cards, dynamic ' +
  'power/toughness, planeswalker loyalty, and flash/flashback — so cards using them ' +
  'play as a simplified subset. The statistics are exact.';
