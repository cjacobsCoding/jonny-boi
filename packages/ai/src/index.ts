/**
 * `@jonny-boi/ai` — AI pilots (DESIGN §3.4).
 *
 * A **pilot** answers `chooseAction(view, legalActions) → action` against a
 * read-only game view (the §2 AI-strategy seam). Pilots self-register by id into
 * an `AiRegistry` and are selected by data (an id string), never hard-wired.
 *
 * Built-ins:
 *   - `random`    — uniformly random legal action via a seeded RNG (determinism
 *                   baseline / sim control).
 *   - `heuristic` — a competent, non-random pilot (develop mana, remove threats,
 *                   develop the board, attack/block for value), driven by a
 *                   tunable `HeuristicWeights` data object (no magic numbers).
 *   - `mcts`      — a Monte-Carlo Tree Search pilot (UCB1 selection + engine
 *                   rollouts), tunable via `MctsConfig`. Stronger but slower — it
 *                   simulates many playouts per decision through the core engine, so
 *                   the sim's deck verdicts carry less noise.
 *
 * Determinism: every choice is reproducible given the seed — the RNG is injected,
 * never `Math.random`, never the wall clock.
 */

// Pilot seam: interface, view, trace, registry.
export type {
  Pilot,
  PilotFactory,
  PilotView,
  DecisionContext,
  DecisionTrace,
  AiRegistry,
  DeepReadonly,
} from './pilot.js';
export { createAiRegistry } from './pilot.js';

// Built-in pilots + their ids.
export { RANDOM_PILOT_ID, createRandomPilot } from './random.js';
export { HEURISTIC_PILOT_ID, createHeuristicPilot } from './heuristic.js';
export { MCTS_PILOT_ID, createMctsPilot } from './mcts.js';

// Tunable heuristic weights (data-driven, designer-tunable).
export type { HeuristicWeights } from './weights.js';
export { DEFAULT_HEURISTIC_WEIGHTS } from './weights.js';

/**
 * Answering core's player CHOICES. Pilots use these automatically; they are
 * exported so any other consumer that has to answer on a player's behalf (a
 * hotseat "auto-play this seat" control, a server filling in for a disconnected
 * seat) reaches for the same reasoning rather than reinventing it.
 */
export { answerChoiceHeuristically, answerAction, safeFallbackAction, cardValue } from './choices.js';

// Tunable MCTS config (data-driven, designer-tunable: budget, depth, eval weights).
export type { MctsConfig } from './mcts-config.js';
export { DEFAULT_MCTS_CONFIG, FAST_MCTS_CONFIG } from './mcts-config.js';

import type { AiRegistry } from './pilot.js';
import { createAiRegistry } from './pilot.js';
import { RANDOM_PILOT_ID, createRandomPilot } from './random.js';
import { HEURISTIC_PILOT_ID, createHeuristicPilot } from './heuristic.js';
import { MCTS_PILOT_ID, createMctsPilot } from './mcts.js';

/**
 * Build a registry pre-loaded with the built-in pilots. The sim/web call this to
 * get a registry they can resolve pilots from by id, and may register their own
 * pilots on top. (A factory, not a shared singleton, so each consumer owns its
 * registry — no cross-test global state.)
 */
export function createDefaultAiRegistry(): AiRegistry {
  const registry = createAiRegistry();
  registerBuiltInPilots(registry);
  return registry;
}

/** Self-register the built-in pilots into a registry (the §2 seam in action). */
export function registerBuiltInPilots(registry: AiRegistry): void {
  registry.registerPilot(RANDOM_PILOT_ID, () => createRandomPilot());
  registry.registerPilot(HEURISTIC_PILOT_ID, () => createHeuristicPilot());
  registry.registerPilot(MCTS_PILOT_ID, () => createMctsPilot());
}

/**
 * The pilot every consumer uses unless it is told otherwise — the CLI sim, the
 * in-browser lab, and the "watch a game" replay all read this one constant, so
 * the strength of AI play is a single data decision rather than a default
 * repeated at each call site.
 *
 * ## It is the HEURISTIC, and that is a measured decision — do not flip it back
 * without a fresh head-to-head. `mcts` held this slot on the theory that engine
 * rollouts must out-play a one-action-deep policy. Two independent measurements
 * say it is currently both slower AND worse:
 *
 *   - **Play quality**: over three Mono-Red vs UW Control games, counting
 *     `manaPoolEmptied` events (mana a pilot tapped and then never spent),
 *
 *         heuristic:   1 wasted-mana event  / 107 turns  = 0.01 per turn
 *         mcts:      202 wasted-mana events / 115 turns  = 1.76 per turn
 *
 *     — 176× more waste. Watching a replay that reads exactly as the user
 *     reported it: a player taps a Sol Ring and does nothing with the mana. A
 *     search shallow enough that a wasted tap costs nothing inside its rollout
 *     horizon will happily make wasted taps.
 *   - **Throughput**: ~29 s per game in Node and ~66 s per game in the browser
 *     worker (11 minutes for those three games). The Lab's default run is
 *     100 games × 6 opponents = 600 games, i.e. *hours* — the signature "swap a
 *     card, get a verdict" loop stops being interactive at all. The heuristic
 *     runs the same gauntlet in seconds.
 *
 * MCTS remains registered and SELECTABLE ({@link SELECTABLE_PILOT_IDS}, `--pilot
 * mcts`, the Lab's picker) so the comparison can be re-run at any time; it should
 * return here only with a budget that beats the heuristic head-to-head, not on the
 * theory that it ought to. Pinned by tests in `index.test.ts` and by
 * `pilot-quality.test.ts` (same waste metric), because this constant has already
 * been silently flipped back by a merge once.
 */
export const DEFAULT_PILOT_ID = HEURISTIC_PILOT_ID;

/** The pilot ids a consumer may select from data (CLI flag, UI picker). */
export const SELECTABLE_PILOT_IDS: readonly string[] = [HEURISTIC_PILOT_ID, MCTS_PILOT_ID, RANDOM_PILOT_ID];

/**
 * Convenience: resolve a pilot by id from a fresh default registry. For one-off
 * lookups; long-lived consumers should build one registry via
 * `createDefaultAiRegistry` and reuse it.
 */
export function getPilot(id: string) {
  return createDefaultAiRegistry().getPilot(id);
}

/** Stable package identity retained from the scaffold for cross-workspace smoke tests. */
export const PACKAGE_NAME = 'ai';
