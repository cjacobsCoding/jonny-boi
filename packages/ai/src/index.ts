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

// Tunable heuristic weights (data-driven, designer-tunable).
export type { HeuristicWeights } from './weights.js';
export { DEFAULT_HEURISTIC_WEIGHTS } from './weights.js';

import type { AiRegistry } from './pilot.js';
import { createAiRegistry } from './pilot.js';
import { RANDOM_PILOT_ID, createRandomPilot } from './random.js';
import { HEURISTIC_PILOT_ID, createHeuristicPilot } from './heuristic.js';

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
}

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
