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
 * THIS IS THE HEURISTIC, AND THE REASON IS MEASURED. MCTS held this slot on the
 * theory that engine rollouts buy play quality over a one-action-deep heuristic.
 * At its current budget they do not: over three Mono-Red vs UW Control games,
 * counting `manaPoolEmptied` events (mana a pilot tapped and then never spent),
 *
 *     heuristic:   1 wasted-mana event  / 107 turns  = 0.01 per turn
 *     mcts:      202 wasted-mana events / 115 turns  = 1.76 per turn
 *
 * — 176× more waste, at roughly a hundred times the wall clock (11 minutes for
 * those three games). Watching a replay, that reads exactly as reported: a
 * player taps a Sol Ring and does nothing with the mana. A search shallow enough
 * that a wasted tap costs it nothing inside the rollout horizon will happily
 * make wasted taps.
 *
 * MCTS remains registered and selectable ({@link SELECTABLE_PILOT_IDS}); it
 * should return here only with a budget that beats the heuristic on a measured
 * head-to-head, not on the theory that it ought to.
 * `pilot-quality.test.ts` guards this with the same waste metric.
 */
export const DEFAULT_PILOT_ID = HEURISTIC_PILOT_ID;

/** The pilot ids a consumer may select from data (CLI flag, UI picker). */
export const SELECTABLE_PILOT_IDS: readonly string[] = [MCTS_PILOT_ID, HEURISTIC_PILOT_ID, RANDOM_PILOT_ID];

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
