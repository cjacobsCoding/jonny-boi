/**
 * Named configuration for the in-browser Lab (DESIGN §3.7). Every value that
 * shapes a sim run — default game counts, the candidate cap, the base seed, the
 * tuning-slider bounds — lives here as a NAMED token (DESIGN §1: no magic
 * numbers). The Lab UI reads these instead of inlining literals, and re-exports
 * the sim's own fidelity caveat so the honesty note has a single source.
 */
import {
  DEFAULT_SIM_CONFIG,
  DEFAULT_SUGGEST_CONFIG,
  DEFAULT_STATS_CONFIG,
  FIDELITY_CAVEAT,
  LAND_COUNT_SWEEP_RADIUS,
} from '@jonny-boi/sim';
import { DEFAULT_DECK_RULES, type TrimSettings } from '@jonny-boi/sim';

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

/**
 * §3.174 — the Lab TRIM. The target-size input's bounds: never below the
 * format's minimum (the sim refuses a plan under it), and up to the largest
 * constructed deck anyone brings to the Lab. Games per candidate REUSES
 * `SUGGEST_GAMES` — the trim runs Suggest's adaptive ladder, not a second one.
 */
export const LARGEST_CONSTRUCTED_DECK_SIZE = 100;
export const TRIM_TARGET_SIZE = {
  default: DEFAULT_DECK_RULES.minDeckSize,
  min: DEFAULT_DECK_RULES.minDeckSize,
  max: LARGEST_CONSTRUCTED_DECK_SIZE,
  step: 1,
} as const;

/**
 * The trim's opening settings: ASK before applying an improving removal, and
 * PAUSE when a round finds none — the conservative pair, so nothing changes a
 * deck until the user says so. Both are one click away in the panel.
 */
export const TRIM_DEFAULT_SETTINGS: TrimSettings = Object.freeze({
  targetSize: TRIM_TARGET_SIZE.default,
  onImprovement: 'ask',
  onNoImprovement: 'pause',
});

 * §3.175 — the manabase experiments: paired games per opponent a FINALIST
 * variant reaches (the ladder is adaptive, like Suggestions, so the default is
 * the same finalist depth), and how far the count/mix sweeps step each way.
 */
export const MANABASE_GAMES = {
  default: DEFAULT_SUGGEST_CONFIG.defaultGamesPerCandidate,
  min: 10,
  max: 200,
  step: 10,
} as const;

export const MANABASE_SWEEP_RADIUS = {
  default: LAND_COUNT_SWEEP_RADIUS,
  min: 1,
  max: 3,
  step: 1,
} as const;

/** The significance level the verdict uses (surfaced so the UI never invents it). */
export const VERDICT_ALPHA = DEFAULT_STATS_CONFIG.alpha;

/**
 * The fidelity caveat surfaced near every verdict. Re-exported verbatim from the
 * sim so there is exactly one wording across CLI and web — `suggestSwaps` stamps
 * this same text into `report.notes.fidelityCaveat`.
 */
export { FIDELITY_CAVEAT };
