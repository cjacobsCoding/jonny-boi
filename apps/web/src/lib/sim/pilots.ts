/**
 * **WHO PLAYED THE GAMES** — the Lab's data about the AI pilots, and what each one
 * costs to run.
 *
 * ## Why this module exists
 *
 * Every number this app produces — a gauntlet win rate, an A/B verdict, a ranked
 * suggestion — is a measurement of a deck *as played by one particular pilot*. It
 * is not a property of the deck alone. That is not a defect; it is what simulation
 * is. But it has a measured, large consequence:
 *
 * > Running the gauntlet with the `hybrid` pilot on BOTH seats moved Mono-Red
 * > Aggro from **32.9% → 19.0%**. When both sides block better, an aggro deck's
 * > edge shrinks, because much of that edge was punishing weak blocking.
 *
 * Both numbers are correct. They answer different questions. So the pilot travels
 * with every request, every result and every stored record (see
 * `sim-protocol.ts`, `shard-protocol.ts`, `history-store.ts`), and the UI shows it
 * next to the numbers rather than hiding it in a tooltip.
 *
 * ## The list of pilots is NOT defined here
 *
 * `SELECTABLE_PILOT_IDS` in `@jonny-boi/ai` is the single source of truth for which
 * pilots exist. This module only attaches the *presentation and cost* data the web
 * app needs on top of it, and degrades gracefully (CLAUDE.md rule 6) for an id it
 * has no row for — an unknown pilot is shown, and its cost is reported as unknown
 * rather than guessed. `pilots.test.ts` asserts every selectable id has a row, so a
 * new pilot upstream produces a failing test with a one-line fix, not a silent
 * blank in the UI.
 */
import {
  DEFAULT_PILOT_ID,
  HEURISTIC_PILOT_ID,
  HYBRID_PILOT_ID,
  MCTS_PILOT_ID,
  RANDOM_PILOT_ID,
  SELECTABLE_PILOT_IDS,
} from '@jonny-boi/ai';

/** What the UI needs to know about one pilot. */
export interface PilotProfile {
  readonly id: string;
  /** Short display name. */
  readonly label: string;
  /** One honest line about how it plays — strength AND its known limits. */
  readonly blurb: string;
  /**
   * How long a GAME takes relative to the heuristic pilot (which is 1 by
   * definition), or `null` when nobody has measured this pilot. `null` means the
   * UI says "unmeasured" — it never guesses, because guessing low is how a user
   * starts an eight-hour run thinking it is a thirty-second one.
   */
  readonly relativeGameCost: number | null;
  /** True for the pilot every surface uses unless told otherwise. */
  readonly isDefault: boolean;
}

/**
 * MEASURED relative GAME costs — how much longer one game takes than it does under
 * the heuristic. Every one of these traces to a number somebody ran, recorded on
 * the coordination board; none is an estimate from reading the code.
 *
 *  - `heuristic` — **1 by definition.** It is the baseline the others are quoted
 *    against, and it is `DEFAULT_PILOT_ID`.
 *  - `hybrid` — **~1400×**, the figure `feat/hybrid-search` reported (as a
 *    per-decision ratio) when it declined to make the hybrid the default: "the
 *    Lab's stock gauntlet would go from seconds to hours". Cross-checked against
 *    that branch's own decision timings, which is why it is safe to carry it over
 *    as a per-GAME ratio: 7.07 ms per decision on aggro boards and 27.7 ms on
 *    control boards, over the few hundred decisions in a game, is seconds to tens
 *    of seconds per game — and 1400 × the heuristic's ~8.5 ms game is ~12 s. The
 *    two routes agree to well within the order of magnitude this estimate claims.
 *  - `mcts` — **~3400×**, from the two throughputs in `DEFAULT_PILOT_ID`'s own
 *    doc-comment: ~29 s per game in Node against a heuristic gauntlet running at
 *    ~110–120 games/sec (~8.5 ms per game). The browser worker measured ~66 s per
 *    game, i.e. worse still, so this is the optimistic end.
 *  - `random` — **1**, an upper bound rather than a measurement: picking uniformly
 *    from the legal actions is strictly cheaper than scoring them, and the engine's
 *    own game loop dominates either way. Being wrong here can only over-state the
 *    time, which is the safe direction.
 *
 * ⚠️ These are RATIOS OF WHOLE GAMES, not of the decision alone. Under the
 * heuristic the engine — not the pilot — dominates a game's cost, so scaling a
 * game by a pure decision ratio would over-state a search pilot badly. If you
 * re-measure, measure games per second end to end.
 *
 * A pilot absent from this table gets `null` and is reported as unmeasured.
 */
const RELATIVE_GAME_COST: Readonly<Record<string, number>> = {
  [HEURISTIC_PILOT_ID]: 1,
  [HYBRID_PILOT_ID]: 1400,
  [MCTS_PILOT_ID]: 3400,
  [RANDOM_PILOT_ID]: 1,
};

/** Display copy per pilot. Kept beside the cost so one edit updates both. */
const PILOT_COPY: Readonly<Record<string, { label: string; blurb: string }>> = {
  [HEURISTIC_PILOT_ID]: {
    label: 'Heuristic',
    blurb:
      'A fast, competent policy player: develop mana, remove threats, attack and block for value. The Lab’s default, and what makes a full gauntlet finish in seconds.',
  },
  [HYBRID_PILOT_ID]: {
    label: 'Hybrid search',
    blurb:
      'Policy-guided search over funded plays. Beats the heuristic 60.0% head-to-head (95% CI 51.1–68.3) on fast tactical boards; on grindy control boards the win is not proven (53.8%, CI 42.9–64.3).',
  },
  [MCTS_PILOT_ID]: {
    label: 'MCTS',
    blurb:
      'Plain Monte-Carlo tree search. Measured both slower AND weaker than the heuristic; kept selectable so that comparison can be re-run, not because it is recommended.',
  },
  [RANDOM_PILOT_ID]: {
    label: 'Random',
    blurb:
      'Picks uniformly among legal actions. A determinism and sanity baseline — a win rate against it says nothing about the meta.',
  },
};

/** The pilot used when a caller does not choose one — re-exported for the UI. */
export { DEFAULT_PILOT_ID };

/**
 * Every pilot the Lab offers, in the order `@jonny-boi/ai` lists them. There is
 * deliberately no second list here: adding a pilot upstream adds it to the picker.
 */
export function labPilots(): readonly PilotProfile[] {
  return SELECTABLE_PILOT_IDS.map(pilotProfile);
}

/** The profile for one id. Unknown ids degrade to a shown-but-unmeasured row. */
export function pilotProfile(id: string): PilotProfile {
  const copy = PILOT_COPY[id];
  const cost = RELATIVE_GAME_COST[id];
  return {
    id,
    label: copy?.label ?? id,
    blurb:
      copy?.blurb ??
      'A pilot this build has no description or timing for. Results are still valid — they are simply measured with a pilot the Lab cannot cost.',
    relativeGameCost: cost ?? null,
    isDefault: id === DEFAULT_PILOT_ID,
  };
}

/** Short display name for a pilot id — the one-liner most call sites want. */
export function pilotLabel(id: string): string {
  return pilotProfile(id).label;
}

/** True when `id` is one of the pilots the app is willing to run. */
export function isSelectablePilot(id: string): boolean {
  return SELECTABLE_PILOT_IDS.includes(id);
}

/**
 * A conservative games-per-second-per-worker figure for the BASELINE pilot, used
 * only to turn a relative cost into a wall-clock estimate.
 *
 * MEASURED IN THE PRODUCT, not inferred from a bench: a 700-game gauntlet
 * (Mono-Red Aggro vs the full field) run in this Lab on eleven browser workers
 * reported **192 games/sec**, i.e. ~17.5 per worker. It is rounded UP only to 20
 * and kept deliberately at the pessimistic end, because this number exists to
 * answer "is this run seconds or hours?" — and an estimate that runs short is the
 * one that gets somebody to start an overnight run by accident.
 *
 * ⚠️ It is much lower than headless figures you may find elsewhere (the CLI has
 * measured 110–206 games/sec on ONE core). Those are Node, one deck, no UI, and no
 * eleven-way contention on a box that thermally throttles under all-core load. The
 * estimate this feeds is for the browser, so it is calibrated in the browser.
 * Everything derived from it is labelled as an estimate in the UI.
 */
export const REFERENCE_GAMES_PER_SECOND_PER_WORKER = 20;

/**
 * Rough wall-clock seconds for a run of `games` games with `pilotId` spread over
 * `workerCount` workers, or `null` when the pilot's cost is unmeasured.
 */
export function estimateRunSeconds(
  games: number,
  pilotId: string,
  workerCount: number,
): number | null {
  const cost = pilotProfile(pilotId).relativeGameCost;
  if (cost === null) return null;
  if (games <= 0) return 0;
  const workers = Math.max(1, Math.floor(workerCount));
  return (games * cost) / (REFERENCE_GAMES_PER_SECOND_PER_WORKER * workers);
}

/**
 * Above this multiple of the baseline pilot's cost, a run's duration stops being
 * an implementation detail and becomes the user's main decision, and the estimate
 * is given the warning treatment. (The estimate itself is shown for EVERY pilot,
 * before every run — a number that only appears when something is expensive
 * teaches the reader that its absence means "free".)
 */
export const COSTLY_PILOT_THRESHOLD = 10;

/** True when picking this pilot changes a run from "a moment" to "a commitment". */
export function isCostlyPilot(id: string): boolean {
  const cost = pilotProfile(id).relativeGameCost;
  // Unmeasured counts as costly: unknown is not the same as cheap.
  return cost === null || cost >= COSTLY_PILOT_THRESHOLD;
}

/**
 * "×1,400 the run time of Heuristic" — the honest one-liner for a picker option,
 * or `null` for the baseline pilot itself (where it would read "×1").
 */
export function relativeCostText(id: string): string | null {
  const profile = pilotProfile(id);
  if (profile.relativeGameCost === null) return 'run time not measured';
  if (profile.relativeGameCost <= 1) return null;
  return `×${profile.relativeGameCost.toLocaleString()} the run time of ${pilotLabel(HEURISTIC_PILOT_ID)}`;
}
