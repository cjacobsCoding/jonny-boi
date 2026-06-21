/**
 * Named configuration for the in-browser Lab (DESIGN §3.7). Every value that
 * shapes a sim run — default game counts, the candidate cap, the base seed, the
 * tuning-slider bounds — lives here as a NAMED token (DESIGN §1: no magic
 * numbers). The Lab UI reads these instead of inlining literals, and re-exports
 * the sim's own provisional caveat so the honesty note has a single source.
 */
import {
  DEFAULT_SIM_CONFIG,
  DEFAULT_SUGGEST_CONFIG,
  DEFAULT_STATS_CONFIG,
} from '@jonny-boi/sim';

/**
 * The fixed base seed every Lab run uses by default, so results are reproducible
 * and the user can compare two runs apples-to-apples. Surfaced (and editable) in
 * the UI. Mirrors the CLI's default seed (0xc0ffee) for cross-surface parity.
 */
export const DEFAULT_LAB_SEED = 0xc0ffee;

/** Games per opponent for a gauntlet run, and the slider's bounds + step. */
export const GAUNTLET_GAMES = {
  default: DEFAULT_SIM_CONFIG.defaultGames,
  min: 10,
  max: 400,
  step: 10,
} as const;

/** Games per opponent for the paired A/B swap test (the signature feature). */
export const SWAP_GAMES = {
  default: DEFAULT_SIM_CONFIG.defaultGames,
  min: 10,
  max: 400,
  step: 10,
} as const;

/**
 * Suggestions tuning: games per candidate (confidence) and the candidate cap
 * (breadth). Lower = faster + noisier; higher = slower + more confident. Defaults
 * come from the sim's own suggest config so the surfaces agree.
 */
export const SUGGEST_GAMES = {
  default: DEFAULT_SUGGEST_CONFIG.defaultGamesPerCandidate,
  min: 10,
  max: 200,
  step: 10,
} as const;

export const SUGGEST_MAX_CANDIDATES = {
  default: DEFAULT_SUGGEST_CONFIG.maxCandidates,
  min: 1,
  max: 24,
  step: 1,
} as const;

/** The significance level the verdict uses (surfaced so the UI never invents it). */
export const VERDICT_ALPHA = DEFAULT_STATS_CONFIG.alpha;

/**
 * The §3.9 provisional-verdict caveat, surfaced near every verdict. We re-derive
 * it from the sim's exported suggestion notes so there is exactly one wording —
 * `suggestSwaps` stamps this same text into `report.notes.fidelityCaveat`.
 */
export const FIDELITY_CAVEAT =
  'Verdicts are PROVISIONAL (DESIGN §3.9): the MVP engine omits triggered ' +
  'abilities & until-end-of-turn expiry, so some cards play as a faithful vanilla ' +
  'subset. The statistics are exact; fidelity grows when engine v2 lands.';
