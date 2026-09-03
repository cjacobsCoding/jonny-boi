/**
 * The `mcts` pilot — a Monte-Carlo Tree Search pilot (DESIGN §2 AI-strategy seam,
 * §3.4). It plays the meta decks more realistically than the heuristic so the sim's
 * deck verdicts carry less noise: on each decision it builds a search tree over the
 * legal actions and runs many simulated playouts through the *core engine itself*
 * (a pure, deterministic, cloneable forward model), then returns the best action.
 *
 * The four MCTS phases, all driven by NAMED `MctsConfig` knobs (no magic numbers):
 *   - SELECTION  — descend the tree by UCB1 (`value + c·sqrt(ln(N)/n)`), `c` named.
 *   - EXPANSION  — add one child for an untried legal action at the selected node.
 *   - ROLLOUT    — from the new node, play a fast default policy (the existing
 *                  `random` or `heuristic` pilot, reused — DRY) to a terminal state
 *                  or a NAMED depth cap, then EVALUATE: win/loss/draw at a terminal,
 *                  else a heuristic eval (life differential + board presence).
 *   - BACKPROP   — propagate the reward up the path, always scored from the
 *                  *deciding* player's perspective.
 *
 * Determinism: every random choice (rollout policy tie-breaks, UCB1 ties, the final
 * pick among equally-visited children) is taken from the seeded `Rng` threaded in
 * via `DecisionContext`. Same seed ⇒ same action. No `Math.random`, no `Date.now`
 * inside the reproducible path: `MctsConfig.maxDecisionMillis` defaults to
 * `Infinity`, so the clock is not consulted at all. A caller that sets a finite
 * cap (an interactive UI bounding a turn) knowingly trades reproducibility for a
 * real-time bound — never do that for the sim's statistics.
 *
 * Forward-model registry (IMPORTANT): rollouts call `applyAction`, which needs the
 * effect `registry` to resolve spells. The `ai` package does not depend on `cards`,
 * so the pilot uses `ctx.registry` when the harness supplies it (full fidelity) and
 * otherwise rolls out with an empty registry — lands/mana/creatures/combat/attacks
 * still resolve; only spell *effects* no-op. See `DecisionContext.registry`.
 *
 * Performance: we clone the root state ONCE per simulation and mutate that single
 * sim copy as we descend + roll out — never a deep clone per ply beyond what the
 * engine already does in `applyAction`.
 *
 * WHAT THIS PILOT ACTUALLY COSTS AND BUYS (measured 2026-08, sample gauntlet,
 * Mono-Red Aggro vs Boros Aggro — read this before proposing it as a default):
 *
 *   throughput     0.087 games/sec, vs the heuristic's 176 — about 2000x slower.
 *                  The cost is structural, not garbage: a decision runs
 *                  `simulationsPerDecision` x `rolloutDepth` engine plies, so a
 *                  game plays on the order of a million times the engine work the
 *                  heuristic does. Cutting ~18% of the search's allocation moved
 *                  wall clock by ~5%, inside this machine's run-to-run noise.
 *   strength       49 wins in 120 seeded games against the heuristic = 40.8%,
 *                  95% CI [32.5%, 49.8%]. Seat and play were both rotated. That
 *                  interval excludes 50%: at this budget the look-ahead pilot is
 *                  measurably WORSE than the pilot whose policy it rolls out with,
 *                  not better.
 *   play quality   0.71 wasted-mana events per turn against the heuristic's 0.00
 *                  (see `MctsConfig.evalWastedManaPenalty`, which fixes that but
 *                  costs win rate, and so ships off).
 *
 * The premise this pilot was built on — "slower per game, but better games, so
 * fewer are needed" — is therefore not currently true. It stays as a selectable,
 * documented option and a research vehicle; it is not a default, and the guard
 * tests in `index.test.ts` and the sim's `pilot-quality.test.ts` are correct to
 * pin that. `packages/ai/bench/mcts-bench.mjs` reproduces every number above.
 */

import type {
  CardDefinition,
  EffectRegistry,
  GameAction,
  GameState,
  InstanceId,
  PlayerId,
  RulesConfig,
  Rng,
} from '@jonny-boi/core';
import {
  applyActionInPlace,
  bestManaYield,
  castTiming,
  cloneState,
  convertedManaCost,
  createEffectRegistry,
  DEFAULT_RULES,
  generateLegalActions,
  isCreature,
  isLand,
  MAIN_STEPS,
  MANA_COLORS,
} from '@jonny-boi/core';
import type { DecisionContext, Pilot } from './pilot.js';
import type { ContinuousIndex } from './board-stats.js';
import { boardIndex, power, statTotal, toughnessLeft } from './board-stats.js';
import type { MctsConfig } from './mcts-config.js';
import { DEFAULT_MCTS_CONFIG } from './mcts-config.js';
import { createRandomPilot } from './random.js';
import { createHeuristicPilot } from './heuristic.js';
import { safeFallbackAction } from './choices.js';
import type { SearchStatsSink, StatsAccumulator } from './search-stats.js';
import { countEquivalentActions, createStatsAccumulator, finishStats } from './search-stats.js';

/** The id the MCTS pilot registers under and is selected by from data. */
export const MCTS_PILOT_ID = 'mcts';

/**
 * Build the MCTS pilot with the given (tunable) config. A factory matching the
 * registry's factory model; the pilot is otherwise stateless between decisions.
 *
 * `stats` is an OPTIONAL instrumentation sink (see `search-stats.ts`). It exists
 * so the search's real shape — branching factor, tree depth, how many engine plies
 * go to the tree versus to rollouts — can be MEASURED rather than guessed, which
 * is what `docs/plans/superhuman-ai-program.md` §2/§65 demands before any
 * optimisation. When it is absent (every shipped call site) the search allocates
 * nothing for it and takes no extra branch inside a loop.
 */
export function createMctsPilot(config: MctsConfig = DEFAULT_MCTS_CONFIG, stats?: SearchStatsSink): Pilot {
  // Reuse the existing pilots as the rollout default policy (DRY — no bespoke
  // playout logic). Both are stateless, so we build them once.
  const rolloutPilot = config.rolloutPolicy === 'heuristic' ? createHeuristicPilot() : createRandomPilot();
  const policy: RolloutPolicy = { pilot: rolloutPilot, needsTargetedCasts: rolloutPolicyNeedsEnrichment(config) };

  return {
    id: MCTS_PILOT_ID,
    // Honest, because this string is what a user picks from. The old wording
    // ("plays the meta decks more realistically to cut sim-verdict noise")
    // promised a benefit that measurement does not support — see the file header.
    description:
      'Monte-Carlo Tree Search (UCB1 selection + engine rollouts, tunable budget). Research option: ~2000x slower than the heuristic and, at the shipped budget, measurably weaker (40.8% over 120 seeded games).',
    chooseAction(ctx: DecisionContext): GameAction {
      try {
        return search(ctx, config, policy, stats);
      } catch {
        // Robustness: never throw on an odd state. Fall back to a safe, legal move.
        return safeFallback(ctx);
      }
    },
  };
}

/**
 * The rollout default policy, paired with whether its playout menu has to be
 * ENRICHED with targeted casts (see `candidateActions`).
 *
 * The tree needs the enrichment — the search can only value "burn the threat" if
 * a targeted cast is a node it can expand. A *rollout* only needs it if its
 * policy picks FROM the menu it is handed:
 *
 *   - `random` picks uniformly from the offered actions, so without the targeted
 *     variants it could never point a burn spell at anything, and its playouts
 *     would systematically undervalue every removal spell in the deck.
 *   - `heuristic` reads the hand and CONSTRUCTS its own targeted cast; it consults
 *     the offered list only for "may I play a land", "which abilities are on
 *     offer", "which attackers am I allowed to declare", and as the tap menu for
 *     `planManaPayment` — none of which the enrichment touches (it rewrites bare
 *     `castSpell`s and passes every other action through in order). Enriching for
 *     it is pure allocation, once per ply, ~20,000 times per decision.
 *
 * Derived from the configured policy rather than a separate knob, so the two can
 * never fall out of step.
 */
interface RolloutPolicy {
  readonly pilot: Pilot;
  readonly needsTargetedCasts: boolean;
}

function rolloutPolicyNeedsEnrichment(config: MctsConfig): boolean {
  return config.rolloutPolicy !== 'heuristic';
}

// --- the search ----------------------------------------------------------------

/** A node in the search tree. Children are created lazily on expansion. */
interface SearchNode {
  /** The legal actions still untried from this node (expand consumes these). */
  readonly untried: GameAction[];
  /** Expanded children, by the action that produced them. */
  readonly children: ChildEdge[];
  /** Times this node was visited (for UCB1's parent-visit term). */
  visits: number;
  /** Set once this node's `untried` list has been enumerated from its sim state. */
  enumerated: boolean;
}

/** An edge to a child: the action taken and the child node's statistics. */
interface ChildEdge {
  readonly action: GameAction;
  readonly node: SearchNode;
  /** Accumulated reward (in [0,1], deciding-player perspective) over visits. */
  totalReward: number;
}

function search(
  ctx: DecisionContext,
  config: MctsConfig,
  policy: RolloutPolicy,
  stats?: SearchStatsSink,
): GameAction {
  const { view, legalActions, rng } = ctx;
  const decider = view.priorityPlayer;

  // Degenerate decisions: nothing offered, or only passing is possible → pass
  // cleanly without spending any search effort.
  if (legalActions.length === 0) return safeFallback(ctx);
  if (!hasNonPassAction(legalActions)) {
    const pass = legalActions[0] as GameAction;
    ctx.trace?.({ action: pass, reason: 'only pass available — passing' });
    return pass;
  }
  // A single legal action: no search needed.
  if (legalActions.length === 1) {
    const only = legalActions[0] as GameAction;
    ctx.trace?.({ action: only, reason: 'single legal action' });
    return only;
  }

  // A window where the only thing on offer is floating mana we could never spend
  // is not a decision — pass without paying for a search. This is free strength:
  // mana pools empty at the end of every step, so mana tapped with nothing
  // castable is strictly wasted, and these windows are the single most common
  // shape in a game (every opponent step where we hold no affordable instant).
  if (isUnspendableManaWindow(view as GameState, legalActions)) {
    const pass = legalActions.find((a) => a.kind === 'passPriority') ?? (legalActions[0] as GameAction);
    ctx.trace?.({ action: pass, reason: 'no castable spell — mana would be wasted, passing' });
    return pass;
  }

  const registry = ctx.registry ?? createEffectRegistry();
  const rulesConfig = ctx.rulesConfig ?? DEFAULT_RULES;

  // The root holds the real (read-only) view; we never mutate it. Each simulation
  // clones it once and works on that copy.
  const root: SearchNode = {
    // Enrich the offered actions with *targeted* spell casts (see
    // `candidateActions`). The engine's `generateLegalActions` offers a bare,
    // target-less `castSpell`; a damage/destroy spell with no target fizzles, so an
    // un-enriched search could never represent "burn the threat / burn for lethal".
    // We add those targeted variants so MCTS can actually search them.
    untried: candidateActions(view as GameState, legalActions),
    children: [],
    visits: 0,
    enumerated: true,
  };

  // The root view is read-only and never mutated: the engine's `applyAction` clones
  // its input and returns a fresh state, so each simulation derives its own line
  // from `view` without us copying state ourselves.
  const rootState = view as GameState;
  const acc = stats ? createStatsAccumulator() : undefined;
  if (acc) {
    const equivalence = countEquivalentActions(rootState, root.untried);
    acc.rootBranching = equivalence.offered;
    acc.rootDistinct = equivalence.distinct;
    noteBranching(acc, root.untried.length);
    acc.nodes = 1;
  }
  const scratch: SimScratch = {
    path: [],
    edges: [],
    wasted: 0,
    rolloutCtx: { view: rootState, legalActions: EMPTY_ACTIONS, rng },
    acc,
  };
  const deadline = config.maxDecisionMillis === Infinity ? Infinity : now() + config.maxDecisionMillis;

  for (let i = 0; i < config.simulationsPerDecision; i++) {
    // Wall-clock safety backstop. Checked only every few sims to keep `now()` off
    // the hot path; on normal positions this never trips before the count budget.
    if (deadline !== Infinity && (i & 0x7) === 0 && now() >= deadline) break;
    runSimulation(root, rootState, decider, config, rulesConfig, registry, policy, rng, scratch);
  }
  if (acc && stats) stats.decision(finishStats(acc));

  // Pick the most-visited root child (robust child) — the standard MCTS final move
  // choice, less noisy than highest mean reward. RNG breaks ties for determinism.
  const best = pickRobustChild(root, rng);
  if (!best) return safeFallback(ctx);

  ctx.trace?.({
    action: best.action,
    reason: `mcts: ${root.visits} sims, best ${describeAction(best.action)} (${best.node.visits} visits, ` +
      `${(best.totalReward / Math.max(1, best.node.visits)).toFixed(3)} mean)`,
    score: best.node.visits,
  });
  return best.action;
}

/**
 * One MCTS iteration over a freshly-cloned sim state: SELECT down the tree applying
 * each chosen action to the sim state, EXPAND one untried action, ROLLOUT to a
 * terminal/depth-cap and EVALUATE, then BACKPROP the reward up the visited path.
 */
function runSimulation(
  root: SearchNode,
  rootState: GameState,
  decider: PlayerId,
  config: MctsConfig,
  rulesConfig: RulesConfig,
  registry: EffectRegistry,
  policy: RolloutPolicy,
  rng: Rng,
  scratch: SimScratch,
): void {
  // Each simulation starts from its OWN copy of the root state and mutates that
  // copy from here on (`step` is in-place). This is the only clone a simulation
  // makes: the shared `rootState` — which is the real, live game view — is never
  // touched, and every ply after this one costs no copy at all.
  let state: GameState = cloneState(rootState);
  const acc = scratch.acc;
  if (acc) {
    acc.simulations++;
    acc.clones++;
  }
  // The visited path and its edges are rebuilt every simulation and dropped at
  // the end of it, so they are REUSED scratch rather than two fresh arrays per
  // simulation. Safe because nothing outside this function ever sees them: the
  // backprop loop below is their only reader, and `chooseAction` is synchronous
  // and never re-entered (see `SIM_SCRATCH`).
  const path = scratch.path;
  const edges = scratch.edges;
  path.length = 0;
  edges.length = 0;
  scratch.wasted = 0;
  path.push(root);

  let node = root;

  // --- SELECTION: descend fully-expanded nodes by UCB1 until we hit one with an
  // untried action or a terminal/leaf state.
  while (node.untried.length === 0 && node.children.length > 0 && !state.gameOver) {
    const edge = selectUcb1(node, config, rng);
    if (!edge) break;
    state = step(state, edge.action, rulesConfig, registry, decider, scratch);
    if (acc) acc.treePlies++;
    node = edge.node;
    path.push(node);
    edges.push(edge);
    // Lazily enumerate this child's legal actions the first time we descend into it.
    if (!node.enumerated) {
      pushLegalAt(node.untried, state, rulesConfig);
      node.enumerated = true;
      if (acc) noteBranching(acc, node.untried.length);
    }
  }

  // --- EXPANSION: add one child for an untried action (if any remain and the game
  // isn't already decided here).
  if (!state.gameOver && node.untried.length > 0) {
    const idx = rng.nextInt(node.untried.length);
    const action = node.untried.splice(idx, 1)[0] as GameAction;
    state = step(state, action, rulesConfig, registry, decider, scratch);
    if (acc) {
      acc.treePlies++;
      acc.nodes++;
    }
    // The child's legal actions are enumerated lazily on its first later descent.
    const child: SearchNode = { untried: [], children: [], visits: 0, enumerated: false };
    const edge: ChildEdge = { action, node: child, totalReward: 0 };
    node.children.push(edge);
    node = child;
    path.push(node);
    edges.push(edge);
  }

  // --- ROLLOUT + EVALUATE from the leaf's state, in the deciding player's frame.
  const reward = rollout(state, decider, config, rulesConfig, registry, policy, rng, scratch);

  // --- BACKPROP: every visited node gets a visit; every edge accumulates reward.
  for (let i = 0; i < path.length; i++) (path[i] as SearchNode).visits++;
  for (let i = 0; i < edges.length; i++) (edges[i] as ChildEdge).totalReward += reward;
  // `path` includes the root, so its length is the edge count + 1.
  if (acc && path.length - 1 > acc.maxTreeDepth) acc.maxTreeDepth = path.length - 1;
}

/** Fold one node's legal-action count into the branching-factor statistics. */
function noteBranching(acc: StatsAccumulator, count: number): void {
  acc.branchingSum += count;
  acc.branchingCount++;
  if (count > acc.maxBranching) acc.maxBranching = count;
}

/**
 * Per-decision scratch reused across a decision's simulations.
 *
 * ESCAPE-SAFETY (the rule that decides what may be pooled here): a buffer may
 * live here only if nothing outside one `runSimulation` call can still be
 * holding it when the next simulation starts. `path` and `edges` qualify — they
 * hold references to tree nodes, are read only by that simulation's backprop,
 * and are cleared at its start. The tree's `untried` action lists and the
 * `GameAction`s in them emphatically do NOT: a node RETAINS its actions for the
 * life of the search (they become the `action` on child edges and the value this
 * function finally returns), so pooling those would hand the tree an object a
 * later simulation overwrites, and the pilot would return an action describing a
 * line it never searched.
 *
 * One scratch is built per decision rather than per pilot, so a pilot instance
 * shared between seats — or nested inside another search — cannot alias it.
 */
interface SimScratch {
  readonly path: SearchNode[];
  readonly edges: ChildEdge[];
  /**
   * How many times the deciding player's mana pool emptied with mana still in it
   * during THIS simulation — see `MctsConfig.evalWastedManaPenalty`. Reset at the
   * start of every simulation and read once by `evaluate`.
   */
  wasted: number;
  /** The rollout policy's decision context, rewritten per ply (see `rollout`). */
  readonly rolloutCtx: MutableDecisionContext;
  /**
   * The optional instrumentation accumulator. `undefined` on every shipped call
   * site, which is what keeps measurement free: each counter site is one
   * already-loaded reference compare, and no stats object is ever built.
   */
  readonly acc: StatsAccumulator | undefined;
}

/**
 * A writable `DecisionContext`. `DecisionContext` is deliberately deep-readonly
 * so a pilot cannot mutate what it is lent; this is the one place that *builds*
 * one, and it rewrites the same object each ply instead of allocating ~20,000 of
 * them per decision.
 */
type MutableDecisionContext = { -readonly [K in keyof DecisionContext]: DecisionContext[K] };

/** UCB1 child selection: maximise `mean + c·sqrt(ln(parentVisits)/childVisits)`. */
function selectUcb1(node: SearchNode, config: MctsConfig, rng: Rng): ChildEdge | undefined {
  const lnParent = Math.log(Math.max(1, node.visits));
  let best: ChildEdge | undefined;
  let bestValue = -Infinity;
  let ties = 0;
  for (const edge of node.children) {
    const n = edge.node.visits;
    // An unvisited child is infinitely attractive (forces at least one visit).
    const mean = n === 0 ? Infinity : edge.totalReward / n;
    const exploration = n === 0 ? Infinity : config.explorationConstant * Math.sqrt(lnParent / n);
    const value = mean + exploration;
    if (value > bestValue) {
      bestValue = value;
      best = edge;
      ties = 1;
    } else if (value === bestValue) {
      // Reservoir tie-break on the seeded RNG so ties are reproducible.
      ties++;
      if (rng.nextInt(ties) === 0) best = edge;
    }
  }
  return best;
}

/**
 * Play the fast default policy from `state` until the game ends or we hit the
 * NAMED `rolloutDepth` cap, then evaluate. Returns a reward in [0, 1] from the
 * deciding player's perspective.
 */
function rollout(
  state: GameState,
  decider: PlayerId,
  config: MctsConfig,
  rulesConfig: RulesConfig,
  registry: EffectRegistry,
  policy: RolloutPolicy,
  rng: Rng,
  scratch: SimScratch,
): number {
  const ctxScratch = scratch.rolloutCtx;
  let s = state;
  let plies = 0;
  for (let depth = 0; depth < config.rolloutDepth; depth++) {
    if (s.gameOver) break;
    const legal = policy.needsTargetedCasts ? legalAt(s, rulesConfig) : bareLegalAt(s, rulesConfig);
    if (legal.length === 0) break; // no moves pre-gameOver → stop and evaluate
    // The rollout policy reuses an existing pilot (DRY). It only ever returns a
    // legal/constructible action; the engine cleanly rejects anything odd, so a
    // stray rejection just advances the rollout harmlessly.
    // The rollout policy is handed a REUSED context object rather than a fresh
    // one per ply. Escape-safe by construction: `policy.pilot` is never a caller-
    // supplied pilot — this pilot builds it itself from `config.rolloutPolicy`,
    // and both `random` and `heuristic` read the context synchronously and retain
    // nothing from it. (A rollout policy that stored its context would have to
    // stop sharing this object; the `RolloutPolicy` doc says so.)
    ctxScratch.view = s;
    ctxScratch.legalActions = legal;
    ctxScratch.rng = rng;
    const action = policy.pilot.chooseAction(ctxScratch as DecisionContext);
    s = step(s, action, rulesConfig, registry, decider, scratch);
    plies++;
  }
  const acc = scratch.acc;
  if (acc) {
    acc.rolloutPlies += plies;
    if (s.gameOver) acc.terminalEvaluations++;
    else acc.leafEvaluations++;
  }
  return evaluate(s, decider, config, plies, scratch.wasted);
}

/**
 * Evaluate a rollout's end state for the deciding player, squashed into [0, 1]:
 *   - terminal: win / loss / draw rewards from config, nudged toward the draw line
 *     by how many `plies` the rollout took (faster wins / slower losses score
 *     better — decisive play; see `winSpeedDiscount`).
 *   - non-terminal (hit the depth cap): a heuristic blend of life differential and
 *     board-presence differential, logistically squashed so it shares the [0,1]
 *     scale with the terminal rewards.
 */
function evaluate(
  state: GameState,
  decider: PlayerId,
  config: MctsConfig,
  plies: number,
  wastedMana: number,
): number {
  if (state.gameOver) {
    const discount = config.winSpeedDiscount * plies;
    if (state.winner === decider) {
      // A win: full reward, pulled toward (never below) the draw line as it drags on.
      return Math.max(config.drawReward, config.winReward - discount);
    }
    if (state.winner === null) return config.drawReward;
    // A loss: minimum reward, pulled toward (never above) the draw line if delayed —
    // a loss you stalled longer is marginally less bad.
    return Math.min(config.drawReward, config.lossReward + discount);
  }
  const opp = other(decider);
  const lifeDiff = state.players[decider].life - state.players[opp].life;
  const boardDiff = boardPresence(state, decider) - boardPresence(state, opp);
  const evalPoints = config.evalLifeWeight * lifeDiff + config.evalBoardWeight * boardDiff;
  // Logistic squash centred at 0 (even position ⇒ 0.5), `evalScale` sets steepness.
  const positional = 1 / (1 + Math.exp(-evalPoints / config.evalScale));
  // Charge the mana this line tapped and never spent. Clamped back into [0, 1]
  // because UCB1's exploration term assumes rewards live on that scale.
  const charged = positional - config.evalWastedManaPenalty * wastedMana;
  return charged < 0 ? 0 : charged > 1 ? 1 : charged;
}

/**
 * Board presence: summed (power + toughness) of a player's creatures, read through
 * the continuous layer so an anthem, an Equipment or a `*` P/T box counts for what
 * it is worth rather than for what is printed.
 */
function boardPresence(state: GameState, player: PlayerId): number {
  const index = boardIndex(state);
  let total = 0;
  for (const perm of state.battlefield) {
    if (perm.controller === player && isCreature(perm.def)) {
      total += statTotal(perm, index);
    }
  }
  return total;
}

// --- engine glue ----------------------------------------------------------------

/**
 * Advance a simulation's PRIVATE state by one action, mutating it in place.
 *
 * Every caller here owns its state outright (each simulation clones the root once
 * up front — see `runSimulation`), so the engine's defensive clone is pure waste:
 * it deep-copies both players' entire libraries on every ply, and a single
 * decision plays tens of thousands of plies. Cloning once per playout instead of
 * once per ply searches exactly the same tree for a fraction of the allocation.
 *
 * Robust: on any throw (shouldn't happen — the engine rejects bad input cleanly)
 * we keep the state as-is so a rollout can't crash the search.
 */
function step(
  state: GameState,
  action: GameAction,
  config: RulesConfig,
  registry: EffectRegistry,
  decider: PlayerId,
  scratch: SimScratch,
): GameState {
  try {
    const result = applyActionInPlace(state, action, config, registry);
    // The engine already built this event list for us; counting the deciding
    // player's lost mana out of it is what lets `evaluate` see waste at all.
    const events = result.events;
    for (let i = 0; i < events.length; i++) {
      const event = events[i] as { type: string; player?: PlayerId };
      if (event.type === MANA_POOL_EMPTIED && event.player === decider) scratch.wasted++;
    }
    return result.state;
  } catch {
    return state;
  }
}

/**
 * The engine event that fires when a step ends with mana still floating — i.e.
 * mana that was tapped and then lost. Named rather than inlined because it is
 * the one signal the search has that a line wasted a resource.
 */
const MANA_POOL_EMPTIED = 'manaPoolEmptied';

/**
 * Legal actions at a sim state, ENRICHED with targeted spell casts (see
 * `candidateActions`), robust to any engine quirk (empty on error). Used for every
 * tree node so the search can choose targeted burn/removal, not just the engine's
 * bare target-less `castSpell`.
 */
function legalAt(state: GameState, config: RulesConfig): GameAction[] {
  try {
    return candidateActions(state, generateLegalActions(state, config));
  } catch {
    return [];
  }
}

/**
 * The engine's legal actions with NO enrichment, for a rollout policy that does
 * not read the offered casts (see `RolloutPolicy`). Same robustness contract.
 */
function bareLegalAt(state: GameState, config: RulesConfig): readonly GameAction[] {
  try {
    return generateLegalActions(state, config);
  } catch {
    return EMPTY_ACTIONS;
  }
}

/** Shared empty menu — an error path must not allocate a fresh array per ply. */
const EMPTY_ACTIONS: readonly GameAction[] = Object.freeze([]);

/**
 * Enumerate a node's legal actions straight INTO its `untried` list.
 *
 * `untried.push(...legalAt(...))` built a throwaway array and then spread it
 * through the argument list — two allocations plus a variadic call per node
 * expansion. The actions themselves are still freshly built and are RETAINED by
 * the tree (a node's untried entries become the `action` on its child edges), so
 * they are deliberately not pooled: pooling them would hand the tree an object
 * that a later simulation overwrites.
 */
function pushLegalAt(untried: GameAction[], state: GameState, config: RulesConfig): void {
  const legal = legalAt(state, config);
  for (let i = 0; i < legal.length; i++) untried.push(legal[i] as GameAction);
}

// --- targeted-cast enrichment ----------------------------------------------------

/** A spell's targeting intent, read from its effect primitives (robust to unknowns). */
interface DamageIntent {
  readonly amount: number;
  readonly canHitPlayer: boolean;
  readonly canHitCreature: boolean;
}

/**
 * The primitive ids the enrichment recognises for targeting (mirrors the
 * heuristic's vocabulary). These MUST match the ids `cards` actually registers:
 * an id that matches nothing leaves the spell as a bare, target-less cast, which
 * resolves as a no-op — so a typo here silently turns removal and combat tricks
 * into blank cards that the search then cheerfully "spends".
 */
const DAMAGE_PRIMITIVE = 'dealDamage';
const REMOVAL_PRIMITIVES: readonly string[] = ['destroyTarget', 'exileTarget'];
const PUMP_PRIMITIVE = 'pumpUntilEndOfTurn';

/**
 * Expand the engine's bare legal actions into the set MCTS actually searches: every
 * target-less `castSpell` of a *targeting* spell (burn / destroy) is replaced by its
 * sensible **targeted** variants — at the opponent's face (if it can hit a player)
 * and at each opposing creature it can meaningfully hit. Non-targeting casts and all
 * other actions pass through unchanged. This is the search-space analogue of what the
 * heuristic does when it constructs a targeted cast: without it, a damage spell with
 * no target fizzles and the search could never value playing it.
 *
 * We cap the per-spell creature targets to the few biggest threats so the branching
 * factor (and thus search cost) stays bounded — chip-the-face and kill-the-biggest
 * are the lines that matter; targeting a small creature is rarely the best burn.
 */
function candidateActions(state: GameState, legal: readonly GameAction[]): GameAction[] {
  const me = state.priorityPlayer;
  const opp = other(me);
  const out: GameAction[] = [];
  // Built lazily and ONCE per call: most action lists contain no targetable cast
  // at all, and a board with nothing modifying anything gets core's shared empty
  // map, so the common path still allocates nothing.
  let index: ContinuousIndex | undefined;
  for (const action of legal) {
    if (action.kind !== 'castSpell' || (action.targets?.length ?? 0) > 0) {
      out.push(action);
      continue;
    }
    const card = handCard(state, me, action.instanceId);
    const intent = card ? damageIntentOf(card.def) : undefined;
    const isRemoval = card ? REMOVAL_PRIMITIVES.some((p) => hasPrimitive(card.def, p)) : false;
    const isPump = card ? hasPrimitive(card.def, PUMP_PRIMITIVE) : false;
    if (!intent && !isRemoval && !isPump) {
      out.push(action); // creature / non-targeting spell — cast as-is
      continue;
    }
    const oppCreatures = opposingCreatures(state, opp);
    index ??= boardIndex(state);
    let added = false;
    if (intent) {
      if (intent.canHitPlayer) {
        out.push({ ...action, targets: [opp] });
        added = true;
      }
      if (intent.canHitCreature) {
        for (const id of topThreatIds(oppCreatures, intent.amount, index)) {
          out.push({ ...action, targets: [id] });
          added = true;
        }
      }
    } else if (isRemoval) {
      for (const id of topThreatIds(oppCreatures, Infinity, index)) {
        out.push({ ...action, targets: [id] });
        added = true;
      }
    } else if (isPump) {
      // A pump targets OUR OWN creature, so it needs its own candidate set —
      // enriching it against enemy creatures would only ever help the opponent.
      for (const id of pumpTargetIds(state, me)) {
        out.push({ ...action, targets: [id] });
        added = true;
      }
    }
    // A targeting spell (burn/destroy) that found no legal target ⇒ a bare cast just
    // fizzles and wastes mana, so we drop it from the search rather than offer it.
    if (!added) continue;
  }
  return out;
}

/** Read a spell's damage intent from its `dealDamage` primitive, if any. */
function damageIntentOf(def: CardDefinition): DamageIntent | undefined {
  for (const ref of def.effects ?? []) {
    if (ref.primitive !== DAMAGE_PRIMITIVE) continue;
    const amount = typeof ref.params?.amount === 'number' ? ref.params.amount : 0;
    const targets = typeof ref.params?.targets === 'string' ? ref.params.targets : 'any';
    return {
      amount,
      canHitPlayer: targets === 'any' || targets === 'player',
      canHitCreature: targets === 'any' || targets === 'creature',
    };
  }
  return undefined;
}

function hasPrimitive(def: CardDefinition, primitive: string): boolean {
  return (def.effects ?? []).some((ref) => ref.primitive === primitive);
}

function handCard(state: GameState, player: PlayerId, id: InstanceId) {
  return state.players[player].hand.find((c) => c.instanceId === id);
}

function opposingCreatures(state: GameState, opp: PlayerId) {
  return state.battlefield.filter((c) => c.controller === opp && isCreature(c.def));
}

/**
 * Candidate targets for a pump: our own creatures, **creatures currently in
 * combat first** — that is where a trick decides something. Capped like the
 * removal targets so the branching factor stays bounded.
 */
function pumpTargetIds(state: GameState, me: PlayerId): InstanceId[] {
  const index = boardIndex(state);
  const inCombat = new Set<InstanceId>();
  if (state.combat) {
    for (const id of state.combat.attackers) inCombat.add(id);
    for (const blocker of Object.keys(state.combat.blocks)) inCombat.add(Number(blocker) as InstanceId);
  }
  return state.battlefield
    .filter((c) => c.controller === me && isCreature(c.def))
    .sort((a, b) => {
      const combatDelta = Number(inCombat.has(b.instanceId)) - Number(inCombat.has(a.instanceId));
      return combatDelta !== 0 ? combatDelta : power(b, index) - power(a, index);
    })
    .slice(0, MAX_PUMP_TARGETS)
    .map((c) => c.instanceId);
}

/** Keep the pump branching factor small — the creature that matters is in combat. */
const MAX_PUMP_TARGETS = 2;

/**
 * True when every action on offer is "tap something for mana" AND no card in hand
 * could be cast in this window even after tapping everything available. Such a
 * window has exactly one sensible line — pass — so searching it is pure cost.
 *
 * Safe by the rules, not just by heuristic: mana pools empty at the end of each
 * step, so mana produced with nothing to spend it on is simply lost. There is no
 * "hold up mana" line to miss here, because holding it is not a thing the pool
 * permits.
 */
function isUnspendableManaWindow(state: GameState, legal: readonly GameAction[]): boolean {
  let taps = 0;
  for (let i = 0; i < legal.length; i++) {
    const kind = (legal[i] as GameAction).kind;
    if (kind === 'passPriority') continue;
    if (kind !== 'tapForMana') return false;
    taps++;
  }
  if (taps === 0) return false;

  const me = state.priorityPlayer;
  const player = state.players[me];

  // The most mana we could put in the pool this window: what floats now, plus the
  // best single mode of every untapped source we control.
  let available = 0;
  for (const color of MANA_COLORS) available += player.manaPool[color];
  for (const perm of state.battlefield) {
    if (perm.controller === me && !perm.tapped) available += bestManaYield(perm.def);
  }

  const sorcerySpeedOpen =
    me === state.activePlayer && MAIN_STEPS.includes(state.step) && state.stack.length === 0;

  for (const card of player.hand) {
    if (isLand(card.def)) continue;
    if (castTiming(card.def) !== 'instant' && !sorcerySpeedOpen) continue;
    if (convertedManaCost(card.def.cost ?? {}) <= available) return false; // something to play for
  }
  return true;
}

/**
 * The instance ids of the opponent's biggest creatures that this spell can hit
 * (within `damage`, or any creature when `damage` is Infinity for hard removal),
 * highest-power first, capped to keep branching bounded.
 */
function topThreatIds(
  oppCreatures: ReturnType<typeof opposingCreatures>,
  damage: number,
  index: ContinuousIndex,
): InstanceId[] {
  const MAX_CREATURE_TARGETS = 2; // keep the cast branching factor small
  return oppCreatures
    .filter((c) => damage === Infinity || toughnessLeft(c, index) <= damage)
    .sort((a, b) => power(b, index) - power(a, index))
    .slice(0, MAX_CREATURE_TARGETS)
    .map((c) => c.instanceId);
}

// --- final-move + fallbacks ------------------------------------------------------

/** The most-visited root child (robust child), RNG-tie-broken for determinism. */
function pickRobustChild(root: SearchNode, rng: Rng): ChildEdge | undefined {
  let best: ChildEdge | undefined;
  let bestVisits = -1;
  let ties = 0;
  for (const edge of root.children) {
    if (edge.node.visits > bestVisits) {
      bestVisits = edge.node.visits;
      best = edge;
      ties = 1;
    } else if (edge.node.visits === bestVisits) {
      ties++;
      if (rng.nextInt(ties) === 0) best = edge;
    }
  }
  return best;
}

/**
 * A guaranteed-legal action when search can't run (empty/odd state): the offered
 * pass, else the first legal action, else a bare pass for the priority-holder.
 */
function safeFallback(ctx: DecisionContext): GameAction {
  const { legalActions, view } = ctx;
  const pass = legalActions.find((a) => a.kind === 'passPriority');
  if (pass) {
    ctx.trace?.({ action: pass, reason: 'fallback — passing' });
    return pass;
  }
  if (legalActions.length > 0) {
    const first = legalActions[0] as GameAction;
    ctx.trace?.({ action: first, reason: 'fallback — first legal action' });
    return first;
  }
  // Nothing offered at all. Passing is not universally legal — while a choice is
  // parked the engine only accepts an answer — so ask for the move that always is.
  const bare = safeFallbackAction(view as unknown as GameState);
  ctx.trace?.({ action: bare, reason: 'fallback — forced move' });
  return bare;
}

// --- small utilities ------------------------------------------------------------

function other(p: PlayerId): PlayerId {
  return p === 'A' ? 'B' : 'A';
}

/** Is anything other than passing on offer? (Indexed: no closure, no copy.) */
function hasNonPassAction(actions: readonly GameAction[]): boolean {
  for (let i = 0; i < actions.length; i++) {
    if ((actions[i] as GameAction).kind !== 'passPriority') return true;
  }
  return false;
}

/** Wall-clock reader, isolated so the reproducible path never touches it directly. */
function now(): number {
  // `performance.now` when present (browser/Node), else a monotonic-ish fallback.
  // Used ONLY for the safety cap, never for game decisions, so determinism holds.
  const perf = (globalThis as { performance?: { now(): number } }).performance;
  return perf ? perf.now() : Date.now();
}

function describeAction(action: GameAction): string {
  switch (action.kind) {
    case 'castSpell':
      return `cast #${action.instanceId}`;
    case 'playLand':
      return `play land #${action.instanceId}`;
    case 'activateAbility':
      return `activate #${action.instanceId}.${action.abilityIndex}`;
    case 'cycleCard':
      return `cycle #${action.instanceId}.${action.abilityIndex ?? 0}`;
    case 'suspendCard':
      return `suspend #${action.instanceId}`;
    case 'activateGraveyardAbility': // §3.111
      return `activate from graveyard #${action.instanceId}.${action.abilityIndex}`;
    case 'tapForMana':
      return `tap #${action.instanceId}`;
    case 'declareAttackers':
      return `attack ×${action.attackers.length}`;
    case 'declareBlockers':
      return `block ×${action.blocks.length}`;
    case 'passPriority':
      return 'pass';
    case 'answerChoice':
      return `answer choice #${action.choiceId}`;
    default: {
      const _exhaustive: never = action;
      void _exhaustive;
      return 'action';
    }
  }
}
