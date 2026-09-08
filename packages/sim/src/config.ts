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

/**
 * How much of the out card an A/B swap replaces.
 *
 * This is the difference between two genuinely different questions, and a result
 * is uninterpretable without knowing which was asked:
 *
 *   - `'one'` — replace a SINGLE copy. Asks "is the 4th copy of this card pulling
 *     its weight?" A tiny effect, so it needs a lot of games to clear significance.
 *   - `'playset'` — replace EVERY copy. Asks "does this card belong in the deck at
 *     all?" Roughly four times the effect size on a 4-of, which is usually what a
 *     person means when they ask whether card A beats card B.
 *
 * Lives here rather than in `swap.ts` so `matchup.ts`'s `RunOptions` can name it
 * without importing the module that imports it.
 */
export type SwapScope = 'one' | 'playset' | { readonly copies: number };

/**
 * §3.136 — how many copies a scope actually moves out of a line of `lineCount`.
 *
 * THE one place the question is answered, so `applySwap` (which moves them),
 * `copiesSwappedBy` (which reports them) and the candidate generator (which
 * stamps the number on every candidate) cannot disagree — the drift this whole
 * module was factored to prevent.
 *
 * The named scopes are the two questions people usually ask; `{ copies: n }` is
 * the third, asked for directly ("I have 3 Elvish Visionaries but I want to look
 * at swapping 2 of them"). A count is CLAMPED into the line rather than refused:
 * asking for 5 copies of a 3-of gets 3, which is the only sensible reading, and
 * asking for 0 or a fraction gets 1.
 */
export function copiesForScope(lineCount: number, scope: SwapScope): number {
  if (scope === 'playset') return lineCount;
  if (scope === 'one') return 1;
  const asked = Math.trunc(scope.copies);
  if (!Number.isFinite(asked)) return 1;
  return Math.max(1, Math.min(asked, lineCount));
}

/** A human-readable name for a scope, for logs, deck names and UI copy. */
export function describeScope(scope: SwapScope): string {
  if (scope === 'playset') return 'the whole playset';
  if (scope === 'one') return 'one copy';
  const n = Math.max(1, Math.trunc(scope.copies));
  return n === 1 ? 'one copy' : `${n} copies`;
}

/**
 * How much of a card an A/B swap replaces by default.
 *
 * `'playset'`: replacing every copy answers "does this card belong in the deck?",
 * which is what a person almost always means when comparing two cards, and it
 * carries roughly four times the effect size of a single copy on a 4-of — the
 * difference between a verdict a few hundred games can reach and one it cannot.
 * Swapping one copy is still available and answers the narrower question of
 * whether the last copy earns its slot.
 */
export const DEFAULT_SWAP_SCOPE: SwapScope = 'playset';

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
  /**
   * Actions ONE TURN may take before the game is declared a draw by CR 104.4b.
   *
   * Some real card pairs are genuine MANDATORY infinite loops — Dualcaster Mage
   * copying a Rite of Replication that makes another Dualcaster Mage is the
   * printed example, and neither half is a "may". A player cannot stop it, so
   * the rules already answer this: "if the game somehow enters a loop of
   * mandatory actions, repeating a sequence of events with no way to stop, the
   * game is a draw."
   *
   * Distinct from {@link maxActionsPerGame} on purpose, and that distinction is
   * the whole point. The GAME cap is a backstop that says "something is wrong
   * and I do not know what", and the soak treats reaching it as a defect. A
   * single TURN running past this bound is a different and *diagnosable* fact —
   * no legitimate turn is thousands of actions long — so the game ends the way
   * the rules say rather than by burning the backstop and looking like a bug.
   */
  readonly maxActionsPerTurn: number;
  /**
   * How many times in a row the engine may reject a pilot's action before the
   * harness steps in and passes priority for that seat instead.
   *
   * A pilot that proposes an action the engine refuses sees an unchanged state on
   * its next decision, proposes the same action again, and livelocks — the game
   * burns `maxActionsPerGame` and records a **bogus timeout draw** that silently
   * poisons every win-rate and A/B verdict built on it. The action cap alone does
   * not catch this honestly: it hides a pilot bug as a "draw". This guard breaks
   * the loop deterministically (it reads only the game state), lets the game reach
   * a real result, and surfaces the rejections in `MatchResult.rejectedActions`
   * so a broken pilot is visible rather than laundered into the statistics.
   */
  readonly maxConsecutiveRejectedActions: number;
  /** Default number of games when the caller / CLI doesn't specify. */
  readonly defaultGames: number;
  /**
   * Apply actions by MUTATING the harness's own game state instead of taking
   * core's defensive clone on every action (`applyActionInPlace` vs
   * `applyAction`).
   *
   * The pure `applyAction` deep-copies the ENTIRE world — both libraries (~60
   * card instances each), battlefield, hands, stack, continuous effects — before
   * every single action, and a game applies hundreds of actions. The harness owns
   * its state outright: it never reads a previous state, and the only other holder
   * is the pilot, which is handed the state as a read-only *borrow* for the
   * duration of one `chooseAction` call (the look-ahead pilot clones before it
   * mutates). So the copy is pure waste here.
   *
   * This is an EXACT optimisation, not a trade-off: both entry points run the same
   * validation and the same mutation on a draft, so the resulting state, events,
   * winner, turn and action counts are bit-identical (pinned by
   * `match-inplace.test.ts`). The flag exists so that equivalence stays *testable*
   * — flip it off and the harness takes the pure path.
   */
  readonly applyActionsInPlace: boolean;
}

export const DEFAULT_SIM_CONFIG: SimConfig = Object.freeze({
  // Real MTG games end well under this; a stalled board (e.g. two walls) hits it
  // and is recorded as a draw rather than spinning forever.
  maxTurnsPerGame: 60,
  // Each turn is a bounded number of priority passes / micro-actions; this cap is
  // generously above any legitimate game and only trips on a pathological loop.
  maxActionsPerGame: 20_000,
  // Two orders of magnitude above a real turn (a heavy storm turn is tens of
  // actions), so only a genuine loop reaches it.
  maxActionsPerTurn: 2_000,
  // A healthy pilot is rejected essentially never; a couple of rejections in a row
  // is already pathological, so we intervene quickly rather than after thousands.
  maxConsecutiveRejectedActions: 3,
  defaultGames: 100,
  // On: the harness owns its state, so core's per-action defensive clone is pure
  // waste. Exact, not approximate — `match-inplace.test.ts` pins both paths to
  // bit-identical results.
  applyActionsInPlace: true,
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
 * The single, shared fidelity note (DESIGN §3.9 — done). Every surface (CLI
 * output, help text, the suggestion report's `notes.fidelityCaveat`, and the web
 * Lab) references THIS constant so there is exactly one wording.
 *
 * ⚠️ IT USED TO BE A CAVEAT, AND THE CAVEAT WENT STALE. It named "flashback
 * GRANTED by another card" and "modes chosen at cast time" as unimplemented, and
 * said cards using them "play as a simplified subset" — long after both landed.
 * Snapcaster Mage and Cryptic Command both compile complete, and the soak
 * REQUIRES its `graveyard-grant` and `modal-cast` witnesses to fire on every
 * run, so the engine would fail its own suite if either had regressed.
 *
 * Its own stated authority, `STUBBED_MECHANICS` in `@jonny-boi/cards`, is EMPTY
 * — the text simply had not been re-read against it. What is true now is
 * stronger and simpler: a card reaches the pool only if the Oracle-text compiler
 * reported it `complete`, so nothing in the pool plays as a simplified subset.
 * A card the compiler cannot model faithfully is not in the pool at all.
 */
export const FIDELITY_CAVEAT =
  'Note: every card in the pool compiles COMPLETELY — the Oracle-text compiler '
  + 'admits a card only when every printed ability is implemented by a real '
  + 'effect primitive, so nothing here plays as a simplified subset. Triggered '
  + 'abilities, until-end-of-turn effects, planeswalker loyalty, transforming '
  + 'double-faced cards, flashback (printed and granted), cast-time modal '
  + 'choices, characteristic-defining power/toughness and turn-scoped memory all '
  + 'play for real. Cards the compiler cannot model faithfully are excluded '
  + 'rather than approximated. The statistics are exact.';
