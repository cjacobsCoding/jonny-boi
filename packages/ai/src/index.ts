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

/**
 * THE OBSERVATION SEAM (`docs/plans/superhuman-ai-program.md` §13–17, §32–33,
 * §37). `chooseAction` is called only while this pilot holds priority, so a pilot
 * could not see the opponent act at all; `Pilot.createGameObserver` is how it now
 * can. The vocabulary lives here, the masking chokepoint that produces it lives in
 * `@jonny-boi/sim` — the harness is the trusted side.
 *
 * The feed is SPECTATOR-LEVEL by construction: nothing in an `Observation` is
 * anybody's secret, so there is no seat whose entitlement could be computed
 * wrongly. See `observation.ts` for the type-level enforcement.
 */
export type {
  Observation,
  ObservedGameStart,
  ObservedDraw,
  ObservedZoneChange,
  ObservedChoiceAsked,
  ObservedChoiceAnswered,
  ObservedChoiceAutoAnswered,
  RedactedObservationType,
  HiddenZoneName,
  PublicZoneName,
  GameObserver,
  GameStartInfo,
} from './observation.js';
export { HIDDEN_ZONES, isHiddenZone, isPublicZone, REDACTED_OBSERVATION_TYPES } from './observation.js';

/**
 * The seam's proof-of-life consumer: a per-game tally of what the opponent has
 * publicly revealed (cards drawn, lands, spells by name, mana by colour). It is
 * the evidence a belief model will consume — not the belief model itself.
 */
export type { OpponentReveals, OpponentRevealObserver } from './reveal-tally.js';
export { createOpponentRevealObserver, createRevealTrackingPilot } from './reveal-tally.js';

// Built-in pilots + their ids.
export { RANDOM_PILOT_ID, createRandomPilot } from './random.js';
export { HEURISTIC_PILOT_ID, createHeuristicPilot, policyCandidates } from './heuristic.js';
export type { PolicyCandidate } from './heuristic.js';

/**
 * LAND SEQUENCING — "which land does this hand want?", scored by what each land
 * UNLOCKS through core's own `planManaPayment` rather than by the fact that it is a
 * land. Exported as a seam because the ranking is useful to anything that has to
 * explain or override a land drop (the Lab's inspector, a future learned policy),
 * and because `LAND_SEQUENCING_OFF_WEIGHTS` is how the before/after strength
 * measurement runs both arms in one process.
 */
export type { LandDropOption } from './land-sequencing.js';
export {
  bestLandDrop,
  describeLandDrop,
  rankLandDrops,
  totalAvailableMana,
  LAND_SEQUENCING_OFF_WEIGHTS,
} from './land-sequencing.js';
export { MCTS_PILOT_ID, createMctsPilot } from './mcts.js';
export { HYBRID_PILOT_ID, createHybridPilot } from './hybrid.js';

/**
 * The hybrid search's knobs and the evaluation seam (§29–31 of the program
 * brief): `evaluateState` / `evaluatePolicy`, initially backed by the heuristic
 * so a learned model can drop in later without the search changing.
 */
export type { HybridConfig, SearchBudget, TreeReuseConfig } from './hybrid-config.js';
export {
  DEFAULT_HYBRID_CONFIG,
  FAST_HYBRID_CONFIG,
  PLAY_HYBRID_CONFIG,
  TACTICAL_HYBRID_CONFIG,
  THRIFTY_HYBRID_CONFIG,
  TREE_REUSE_ON,
  TREE_REUSE_OFF,
} from './hybrid-config.js';

/**
 * THE TACTICAL SOLVER (brief §11–12, §39) — exact answers to "can I kill this
 * turn", "can they kill me", "how fast is each board".
 *
 * Exported as a standalone seam rather than buried in the evaluator because three
 * different consumers want the same answers and must not each grow their own:
 * the leaf evaluator scores them, the pilot's decision router ACTS on them, and
 * the curated tactical suite (`tactical-suite.ts`, brief §48) asserts them.
 */
export type { AttackHorizon, CombatAssessment, TacticalConfig, TacticalPicture } from './tactical.js';
export { assessAttack, assessPosition, lethalAttackers, DEFAULT_TACTICAL_CONFIG } from './tactical.js';

/**
 * SEARCH REUSE BETWEEN DECISIONS (brief §21-22). The position fingerprint and the
 * re-rooting walk are exported because they are search-agnostic: a later tactical
 * solver (§11) or a transposition table (§18) wants the same position key, and
 * two different keys for "is this the same position" is exactly the kind of drift
 * this repo has been bitten by before.
 */
export type { PositionFingerprint, ReusableNode, ReusableEdge } from './tree-reuse.js';
export {
  fingerprintPosition,
  fingerprintsEqual,
  findNodeByFingerprint,
  decayAndCountSubtree,
} from './tree-reuse.js';
export type { StateEvaluator, EvaluationWeights } from './evaluator.js';
export {
  createHeuristicEvaluator,
  evaluatePosition,
  DEFAULT_EVALUATION_WEIGHTS,
  TACTICAL_EVALUATION_WEIGHTS,
} from './evaluator.js';

// Tunable heuristic weights (data-driven, designer-tunable).
export type { HeuristicWeights } from './weights.js';
export { DEFAULT_HEURISTIC_WEIGHTS } from './weights.js';

/**
 * Answering core's player CHOICES. Pilots use these automatically; they are
 * exported so any other consumer that has to answer on a player's behalf (a
 * hotseat "auto-play this seat" control, a server filling in for a disconnected
 * seat) reaches for the same reasoning rather than reinventing it.
 */
export {
  answerChoiceHeuristically,
  answerAction,
  safeFallbackAction,
  cardValue,
  // The COPY-TARGET ruler (CR 707.2): what a permanent with these PRINTED
  // characteristics is worth to be. Exported so the policy can be tested
  // directly and so a UI could preview the pilot's reasoning.
  copyTargetValue,
} from './choices.js';

// Tunable MCTS config (data-driven, designer-tunable: budget, depth, eval weights).
export type { MctsConfig } from './mcts-config.js';
export { DEFAULT_MCTS_CONFIG, FAST_MCTS_CONFIG } from './mcts-config.js';

/**
 * SEARCH INSTRUMENTATION (`docs/plans/superhuman-ai-program.md` §2, §65).
 * Optional observers a search pilot reports its measured shape into, plus the
 * action-equivalence key that both MEASURES redundant search and (in the hybrid)
 * REMOVES it. Exported so `packages/ai/bench` and tests can read the search's
 * real branching/depth/ply counts instead of estimating them.
 */
export type {
  DecisionStats,
  SearchStatsSink,
  CollectingStatsSink,
  SearchStatsSummary,
} from './search-stats.js';
export {
  actionEquivalenceKey,
  countEquivalentActions,
  createCollectingStatsSink,
} from './search-stats.js';

import type { AiRegistry } from './pilot.js';
import { createAiRegistry } from './pilot.js';
import { RANDOM_PILOT_ID, createRandomPilot } from './random.js';
import { HEURISTIC_PILOT_ID, createHeuristicPilot } from './heuristic.js';
import { MCTS_PILOT_ID, createMctsPilot } from './mcts.js';
import { HYBRID_PILOT_ID, createHybridPilot } from './hybrid.js';

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
  registry.registerPilot(HYBRID_PILOT_ID, () => createHybridPilot());
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

/**
 * The pilot ids a consumer may select from data (CLI flag, UI picker).
 *
 * These are the brief's §59 selectable MODES: `heuristic` (the fast policy
 * baseline), `mcts` (VANILLA_MCTS — the research control the hybrid must beat),
 * `hybrid` (policy prior + PUCT + heuristic leaf evaluation) and `random` (the
 * determinism/sanity baseline). Having all four selectable from data is what
 * makes "test every change against the previous best" a command rather than a
 * code change.
 */
export const SELECTABLE_PILOT_IDS: readonly string[] = [
  HEURISTIC_PILOT_ID,
  HYBRID_PILOT_ID,
  MCTS_PILOT_ID,
  RANDOM_PILOT_ID,
];

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
