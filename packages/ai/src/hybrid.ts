/**
 * The `hybrid` pilot — heuristic policy + PUCT search + heuristic leaf evaluation.
 *
 * This is Phases 2–4 of `docs/plans/superhuman-ai-program.md` (§58), built on the
 * Phase-1 measurements rather than on intuition. It is NOT "MCTS with better
 * constants": it changes what the search is asked, in three specific ways that the
 * instrumentation identified.
 *
 * ## 1. The action space is strategic and ATOMIC (Phase 2, brief §3–4)
 * The vanilla pilot searches raw engine actions, so "tap an Island" is a node. It
 * therefore prices a tap through rollouts in which the *heuristic* later spends
 * that mana, while the real next mover treats it as sunk and declines — measured
 * at 0.71 wasted mana per turn against the heuristic's 0.00 (DESIGN §3.4), and
 * the recorded diagnosis of why vanilla MCTS lost.
 *
 * Here a candidate is a {@link PolicyCandidate}: a whole play together with the
 * taps that fund it, planned by core's `planManaPayment` — the same planner the
 * heuristic pays with. A naked `tapForMana` is not in the search space at all, so
 * the pilot **cannot** tap-and-not-spend; it is not a behaviour that was
 * discouraged, it is a behaviour that no longer has a representation.
 *
 * Two more compressions fall out of the same move. Actions are collapsed by
 * {@link actionEquivalenceKey}, so five untapped Islands are one decision (Phase 1
 * measured **41.6%** of all offered actions as strategically duplicate). And any
 * position whose policy offers exactly one option is auto-resolved without a
 * search node at all (Phase 1 measured **25.7%** of real decisions as forced).
 *
 * ## 2. Selection is policy-guided (Phase 3, brief §8, §28)
 * PUCT — `Q(s,a) + c·P(s,a)·sqrt(N(s))/(1+N(s,a))` — with `P` a softmax over the
 * heuristic's own scores, plus progressive widening (§7) so the search spends its
 * first visits on the two or three plays the policy actually likes. Every legal
 * option keeps a floor prior (`minPriorFraction`) and is eventually widened into,
 * because §8 forbids the heuristic *permanently* eliminating anything.
 *
 * ## 3. Leaves are evaluated, not played out (Phase 4, brief §9)
 * Phase 1 measured that 95% of a vanilla decision's engine work is rollout plies
 * and that only 25% of those rollouts reach a terminal — so three-quarters of the
 * time it pays ~100 plies to arrive at a positional judgement anyway. The hybrid
 * calls {@link StateEvaluator.evaluateState} instead. That is the change that
 * attacks the multiplier rather than the constant.
 *
 * ## Adversarial backup
 * Rewards are stored once, from the DECIDING player's perspective, and a node
 * whose mover is the opponent selects to *minimise* them. The vanilla pilot
 * maximises the decider's reward at every node, i.e. it assumes the opponent
 * helpfully plays into it.
 *
 * ## 4. The tree survives the decision (brief §21–22)
 * A search used to be thrown away the moment it answered. It is now retained and
 * re-rooted onto the live position at the next decision — ours or after the
 * opponent has moved — so the visits spent on a line are still there when that
 * line becomes the present. The match is by POSITION, not by action, for reasons
 * that are load-bearing rather than stylistic; they are in `tree-reuse.ts`, along
 * with the argument that this stays a deterministic function of the seed.
 *
 * ## Determinism
 * Every tie-break comes from the injected seeded `Rng`. With the default
 * simulation budget no clock is consulted at all, so the same seed reproduces the
 * same action on any machine — the property the Lab's paired A/B verdict depends
 * on. A `millis` budget (play only) deliberately trades that away; see
 * {@link SearchBudget}.
 *
 * Tree reuse makes a decision depend on what this pilot instance searched
 * earlier, which is a real change to that story and is safe for a specific,
 * checkable reason: the retained tree is keyed on a fingerprint that includes
 * `GameState.seed` and on the deciding seat, so it can only ever be reused within
 * the one game and the one seat it was built in, where the whole sequence of
 * positions is itself a function of the seed. See `tree-reuse.ts`.
 */

import type {
  EffectRegistry,
  GameAction,
  GameState,
  PlayerId,
  Rng,
  RulesConfig,
} from '@jonny-boi/core';
import {
  applyActionInPlace,
  cloneState,
  createEffectRegistry,
  DEFAULT_RULES,
  generateLegalActions,
  indexContinuous,
} from '@jonny-boi/core';
import type { DecisionContext, Pilot } from './pilot.js';
import type { PolicyCandidate } from './heuristic.js';
import { createHeuristicPilot } from './heuristic.js';
import { safeFallbackAction } from './choices.js';
import type { StateEvaluator } from './evaluator.js';
import { createHeuristicEvaluator } from './evaluator.js';
import type { HybridConfig } from './hybrid-config.js';
import { DEFAULT_HYBRID_CONFIG } from './hybrid-config.js';
import { actionEquivalenceKey } from './search-stats.js';
import type { SearchStatsSink, StatsAccumulator } from './search-stats.js';
import { createStatsAccumulator, finishStats } from './search-stats.js';
import type { PositionFingerprint } from './tree-reuse.js';
import { decayAndCountSubtree, findNodeByFingerprint, fingerprintPosition } from './tree-reuse.js';
import { lethalAttackers } from './tactical.js';

/** The id the hybrid pilot registers under and is selected by from data. */
export const HYBRID_PILOT_ID = 'hybrid';

/**
 * Build the hybrid pilot.
 *
 * `evaluator` is the §29–31 seam: swapping in a learned policy/value model later
 * is a different argument here, not a different search. `stats` is the optional
 * Phase-1 instrumentation sink; absent on every shipped call site.
 */
export function createHybridPilot(
  config: HybridConfig = DEFAULT_HYBRID_CONFIG,
  evaluator: StateEvaluator = createHeuristicEvaluator(config.evaluation),
  stats?: SearchStatsSink,
): Pilot {
  // The fast policy, reused as the optional leaf rollout driver (DRY — there is
  // no bespoke playout logic anywhere in this package).
  const rolloutPilot = config.leafRolloutDepth > 0 ? createHeuristicPilot() : undefined;
  // Per-pilot commitment state: see `PendingMacro`.
  let pending: PendingMacro | undefined;
  // Per-pilot search memory across decisions: see `RetainedTree`.
  let retained: RetainedTree | undefined;

  return {
    id: HYBRID_PILOT_ID,
    description:
      'Hybrid search: heuristic policy prior + PUCT + progressive widening over ATOMIC funded plays, ' +
      'with a heuristic leaf evaluator instead of random playouts. Selectable; not the default pilot.',
    chooseAction(ctx: DecisionContext): GameAction {
      try {
        // A macro already chosen and still valid is carried out rather than
        // re-searched. This is what makes "tap and cast" atomic in the REAL game
        // as well as inside the tree — and it is also a large speedup, because a
        // three-mana spell costs one search instead of four.
        const replay = takeNextPly(pending, ctx);
        if (replay) {
          pending = replay.remaining;
          ctx.trace?.({ action: replay.action, reason: 'carrying out the planned play' });
          return replay.action;
        }
        pending = undefined;
        const decision = search(ctx, config, evaluator, rolloutPilot, retained, stats);
        pending = decision.remaining;
        // A forced position returns no tree and deliberately leaves the retained
        // one alone: the search compresses forced windows away internally
        // (`advanceToDecision`), so the tree already accounts for the play about
        // to be made and will still match afterwards.
        if (decision.tree) retained = decision.tree;
        return decision.action;
      } catch {
        pending = undefined;
        retained = undefined;
        return fallback(ctx);
      }
    },
  };
}

// --- commitment (atomicity in the real game) --------------------------------------

/**
 * A macro the search chose whose later plies have not been played yet.
 *
 * The search values "tap, tap, cast" as one thing; the engine still asks for one
 * action at a time. Without this the pilot would re-search after every tap and
 * could pick a *different* macro next time, stranding the mana it just made —
 * which is the exact failure this whole redesign exists to remove.
 *
 * It is remembered with the position it was planned in, and every ply is
 * re-validated against the live legal actions before it is played. Anything
 * unexpected (the opponent responded, the card left hand, the step advanced)
 * throws the plan away and re-searches, so a stale plan can never be forced
 * through. A pilot instance is shared across games by the sim harness, so the
 * turn/step/player guard is doing real work, not just tidiness.
 */
interface PendingMacro {
  readonly plies: readonly GameAction[];
  readonly index: number;
  readonly turnNumber: number;
  readonly step: string;
  readonly player: PlayerId;
}

/** The next ply of a still-valid plan, or `undefined` to re-search. */
function takeNextPly(
  pending: PendingMacro | undefined,
  ctx: DecisionContext,
): { readonly action: GameAction; readonly remaining: PendingMacro | undefined } | undefined {
  if (!pending) return undefined;
  const view = ctx.view;
  if (
    view.priorityPlayer !== pending.player ||
    view.turnNumber !== pending.turnNumber ||
    view.step !== pending.step ||
    view.pendingChoice != null
  ) {
    return undefined;
  }
  const action = pending.plies[pending.index];
  if (!action || !stillOffered(ctx.legalActions, action)) return undefined;
  const nextIndex = pending.index + 1;
  return {
    action,
    remaining: nextIndex < pending.plies.length ? { ...pending, index: nextIndex } : undefined,
  };
}

/**
 * Is this planned ply still something the engine is offering?
 *
 * Only the plan's own action *kinds* are recognised. A combat declaration is
 * never replayed: it is a single ply anyway, and re-declaring is exactly the
 * live-lock the heuristic pilot had to be taught to avoid.
 */
function stillOffered(legal: readonly GameAction[], action: GameAction): boolean {
  for (let i = 0; i < legal.length; i++) {
    const offered = legal[i] as GameAction;
    if (offered.kind !== action.kind) continue;
    if (action.kind === 'tapForMana' && offered.kind === 'tapForMana') {
      if (offered.instanceId === action.instanceId && (offered.mode ?? 0) === (action.mode ?? 0)) return true;
    } else if (action.kind === 'castSpell' && offered.kind === 'castSpell') {
      if (offered.instanceId === action.instanceId) return true;
    } else if (action.kind === 'activateAbility' && offered.kind === 'activateAbility') {
      if (offered.instanceId === action.instanceId && offered.abilityIndex === action.abilityIndex) return true;
    }
  }
  return false;
}

// --- the tree ---------------------------------------------------------------------

/** A candidate with its normalised prior. */
interface ScoredCandidate {
  readonly candidate: PolicyCandidate;
  readonly prior: number;
}

/** A decision node: whose choice it is, and what the choices are. */
interface HybridNode {
  /** Sorted by prior, descending — widening consumes them in this order. */
  readonly candidates: readonly ScoredCandidate[];
  /** Expanded edges, always a prefix of `candidates`. */
  readonly children: HybridEdge[];
  /** Who is choosing here — the reason PUCT can back up adversarially. */
  readonly mover: PlayerId;
  visits: number;
  /**
   * The position this node stands for, recorded while the search was standing in
   * it. Present only within `reuse.maxDepth` edges of the root — deeper nodes can
   * never be a re-rooting target, and fingerprinting them would be pure cost.
   * Filled in lazily, so a node inherited from a previous decision acquires one
   * the first time the new search walks through it.
   */
  fingerprint?: PositionFingerprint;
}

/**
 * The tree kept between two decisions, together with the two facts that say
 * whether it may be reused at all (brief §21–22).
 *
 * `seed` and `decider` are not belt-and-braces. A pilot instance outlives a game
 * in every real consumer (`sim/cli.ts`, `apps/web/lib/sim/execute.ts`, the sim
 * harness), and one instance may serve BOTH seats, so "this tree belongs to
 * another game" and "this tree was scored from the other player's point of view"
 * are ordinary situations, not corner cases. See `tree-reuse.ts` for why letting
 * either one through would break the Lab's paired A/B verdict.
 */
interface RetainedTree {
  readonly root: HybridNode;
  readonly decider: PlayerId;
  readonly seed: number;
}

/** An edge: the strategic action taken, and its statistics. */
interface HybridEdge {
  readonly scored: ScoredCandidate;
  /** Created lazily on the SECOND visit — a leaf that is never revisited costs no policy call. */
  node: HybridNode | undefined;
  visits: number;
  /** Accumulated reward in [0,1], always from the DECIDING player's perspective. */
  totalReward: number;
}

/** What `search` returns: the action to play now, plus the rest of its macro. */
interface SearchDecision {
  readonly action: GameAction;
  readonly remaining: PendingMacro | undefined;
  /**
   * The tree to keep for the next decision, or `undefined` to keep whatever is
   * already retained (the forced path, which builds no tree).
   */
  readonly tree?: RetainedTree;
}

function search(
  ctx: DecisionContext,
  config: HybridConfig,
  evaluator: StateEvaluator,
  rolloutPilot: Pilot | undefined,
  retained: RetainedTree | undefined,
  stats?: SearchStatsSink,
): SearchDecision {
  const { view, legalActions, rng } = ctx;
  const decider = view.priorityPlayer;
  const rootState = view as GameState;
  const registry = ctx.registry ?? createEffectRegistry();
  const rules = ctx.rulesConfig ?? DEFAULT_RULES;

  if (legalActions.length === 0) return { action: fallback(ctx), remaining: undefined };

  // DECISION ROUTER, first branch (brief §45): `if (IsImmediateLethal) ...`.
  // A kill the solver has PROVEN cannot be blocked out is not a position to search
  // — searching it can only find the same answer, or fail to. See `takeLethal`.
  const kill = takeLethal(ctx, config);
  if (kill) {
    ctx.trace?.({ action: kill, reason: 'tactical: lethal attack, unblockable by any assignment' });
    return { action: kill, remaining: undefined, tree: undefined };
  }

  const raw = evaluator.evaluatePolicy(view, legalActions);
  const candidates = prepareCandidates(rootState, raw, config);

  // FORCED (brief §4 Level 0): one strategic option means there is nothing to
  // search. Phase 1 measured this at 25.7% of all real decisions.
  if (candidates.length <= 1) {
    const only = candidates[0]?.candidate ?? { plies: [legalActions[0] as GameAction], score: 0, label: '' };
    ctx.trace?.({ action: only.plies[0] as GameAction, reason: 'forced — single strategic option' });
    return commit(only, view.turnNumber, view.step, decider);
  }

  const acc = stats ? createStatsAccumulator() : undefined;
  if (acc) {
    acc.rootBranching = raw.length;
    acc.rootDistinct = candidates.length;
    acc.maxBranching = candidates.length;
    acc.branchingSum = candidates.length;
    acc.branchingCount = 1;
    acc.nodes = 1;
  }

  // §21–22: re-root onto last decision's tree when it contains this position.
  // The candidate list is ALWAYS the freshly-derived one — only statistics and
  // subtrees are inherited — so a wrong match can cost accuracy but can never
  // produce an action the engine did not just offer.
  const fingerprint = config.reuse.enabled ? fingerprintPosition(rootState) : undefined;
  const reused = fingerprint
    ? reuseRoot(retained, rootState, decider, fingerprint, candidates, config, acc)
    : undefined;
  const root: HybridNode =
    reused ?? { candidates, children: [], mover: decider, visits: 0, fingerprint };
  const path: HybridEdge[] = [];
  const budget = config.budget;
  const simulationCap = budget.kind === 'simulations' ? budget.simulations : budget.maxSimulations;
  const deadline = budget.kind === 'millis' ? now() + budget.millis : Infinity;

  for (let i = 0; i < simulationCap; i++) {
    // The clock is consulted ONLY under a `millis` budget, and then only every
    // eighth simulation. Under the default `simulations` budget this branch is a
    // compile-time-constant comparison and the search stays bit-reproducible.
    if (deadline !== Infinity && (i & 0x7) === 0 && now() >= deadline) break;
    runSimulation(root, rootState, decider, config, evaluator, rolloutPilot, rules, registry, rng, path, acc);
  }

  const best = pickRobustChild(root, rng);
  if (acc && stats) stats.decision(finishStats(acc));
  if (!best) return { action: fallback(ctx), remaining: undefined };

  ctx.trace?.({
    action: best.scored.candidate.plies[0] as GameAction,
    reason:
      `hybrid: ${root.visits} sims, ${root.children.length}/${candidates.length} widened, ` +
      `best ${best.scored.candidate.label || 'play'} (${best.visits} visits, ` +
      `${(best.totalReward / Math.max(1, best.visits)).toFixed(3)} mean, prior ${best.scored.prior.toFixed(2)})` +
      (reused ? ' [reused tree]' : ''),
    score: best.visits,
  });
  // With reuse off nothing is retained at all — not merely never matched — so the
  // disabled pilot is the previous one exactly, down to what it holds on to.
  return commit(
    best.scored.candidate,
    view.turnNumber,
    view.step,
    decider,
    config.reuse.enabled ? { root, decider, seed: rootState.seed } : undefined,
  );
}

/**
 * The lethal attack, when the solver can prove one — otherwise `undefined`.
 *
 * ## Why this is a ROUTER BRANCH and not just an evaluator term (brief §45)
 * `evaluateState` already scores a proven kill highly, but scoring is not taking.
 * A search still has to *find* the line, and a 160-simulation PUCT search that has
 * widened to three children and is splitting its visits can fail to. Worse, the
 * alpha strike is deliberately given a LOWER prior than the value-judged attack
 * (`collectAttackCandidates`), which is right in general and exactly wrong here.
 * A kill that has been proven unblockable is not a judgement call, so it does not
 * go to the judge.
 *
 * ## Why acting on it is safe
 * `guaranteedDamage` is a lower bound on what gets through (`tactical.ts` prices
 * the defence generously and never optimistically), and the candidate set is the
 * ENGINE's own offered eligibility list, so the returned declaration is a legal
 * narrowing by construction. What it does not model is cards — a trick, a removal
 * spell, a flashed-in blocker. That is the same bet a human makes attacking into
 * open mana, and the previous behaviour (not seeing the kill at all) is strictly
 * worse than making it.
 *
 * ## Combat only, on purpose
 * "Burn them out from 3" is also a lethal line, and it is NOT handled here: it
 * needs the effect-value layer to say how much damage a card in hand deals to a
 * face, which is a different question with different failure modes. The policy
 * already scores lethal burn at the top of its range, so the search reaches it;
 * combat is the case the search demonstrably could not see, because the evaluator
 * dropped the lethal signal the instant attackers tapped.
 */
function takeLethal(ctx: DecisionContext, config: HybridConfig): GameAction | undefined {
  if (!config.takeProvenLethal) return undefined;
  const view = ctx.view;
  if (view.step !== 'declareAttackers') return undefined;
  const me = view.priorityPlayer;
  if (me !== view.activePlayer) return undefined;
  const offered = ctx.legalActions.find((a) => a.kind === 'declareAttackers') as
    | Extract<GameAction, { kind: 'declareAttackers' }>
    | undefined;
  if (!offered || offered.attackers.length === 0) return undefined;

  // The one place the REAL continuous index is built. It costs a `Map`, which is
  // why the leaf evaluator does without it — but this answer is about to be
  // played, and an anthem or an until-EOT pump changes whether the kill is there.
  const state = view as GameState;
  const attackers = lethalAttackers(
    state,
    me,
    indexContinuous(state),
    config.tactical,
    offered.attackers,
  );
  if (!attackers || attackers.length === 0) return undefined;
  return { kind: 'declareAttackers', player: me, attackers: [...attackers] };
}

/** Package a chosen macro into "play this now, remember the rest". */
function commit(
  candidate: PolicyCandidate,
  turnNumber: number,
  step: string,
  player: PlayerId,
  tree?: RetainedTree,
): SearchDecision {
  const action = candidate.plies[0] as GameAction;
  const remaining =
    candidate.plies.length > 1
      ? { plies: candidate.plies, index: 1, turnNumber, step, player }
      : undefined;
  return { action, remaining, tree };
}

/**
 * Collapse equivalent candidates, convert the policy's raw scores into a prior,
 * and order them so progressive widening consumes the best first.
 *
 * The prior is a softmax with a FLOOR: `minPriorFraction` of a uniform prior is
 * added to every option before normalising, which is the mechanical guarantee
 * behind brief §8 — the heuristic can make an option unlikely, never impossible.
 */
function prepareCandidates(
  state: GameState,
  raw: readonly PolicyCandidate[],
  config: HybridConfig,
): ScoredCandidate[] {
  // Level 1 equivalence: two candidates whose whole macro keys the same are the
  // same decision (two copies of a Bolt; a Mountain versus another Mountain).
  const seen = new Set<string>();
  const unique: PolicyCandidate[] = [];
  for (const candidate of raw) {
    const key = macroKey(state, candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(candidate);
  }
  unique.sort((a, b) => b.score - a.score);
  const kept = unique.length > config.maxCandidates ? unique.slice(0, config.maxCandidates) : unique;
  if (kept.length === 0) return [];

  // Softmax, shifted by the max so `exp` cannot overflow on a lethal-burn score.
  const top = kept[0]!.score;
  let total = 0;
  const weights = new Array<number>(kept.length);
  for (let i = 0; i < kept.length; i++) {
    const w = Math.exp((kept[i]!.score - top) / config.policyTemperature);
    weights[i] = w;
    total += w;
  }
  const floor = config.minPriorFraction / kept.length;
  const scaled = 1 - config.minPriorFraction;
  const out: ScoredCandidate[] = new Array(kept.length);
  for (let i = 0; i < kept.length; i++) {
    out[i] = { candidate: kept[i]!, prior: floor + scaled * (weights[i]! / total) };
  }
  return out;
}

/**
 * The canonical key for a whole macro, from one position.
 *
 * Two jobs, and it is the right key for both because both ask the same question
 * *within a single position*: collapsing interchangeable candidates in
 * {@link prepareCandidates}, and lining a retained edge up against the freshly
 * derived candidate list in {@link reuseRoot}. It is emphatically NOT the right
 * key for deciding which node the game moved to — see `tree-reuse.ts`.
 */
function macroKey(state: GameState, candidate: PolicyCandidate): string {
  let key = '';
  for (let i = 0; i < candidate.plies.length; i++) {
    key += actionEquivalenceKey(state, candidate.plies[i] as GameAction) + '|';
  }
  return key;
}

/**
 * Re-root the retained tree onto the live position (brief §21–22), or return
 * `undefined` to search from scratch.
 *
 * The shape of the answer is deliberate: a NEW root node over the FRESH candidate
 * list, into which the matched node's edge statistics and subtrees are adopted by
 * macro key. Reusing the matched node itself would carry its candidate list along
 * — a list derived inside a simulation — and one bad fingerprint match would then
 * put the pilot's own action set out of step with what the engine is offering.
 * This way the worst a wrong match can do is contribute misleading numbers.
 *
 * Adoption keeps `children` a strict prefix of `candidates`, which is the
 * invariant progressive widening relies on: everything up to the deepest adopted
 * index is expanded, adopting statistics where a match exists and starting from
 * zero where it does not.
 */
function reuseRoot(
  retained: RetainedTree | undefined,
  state: GameState,
  decider: PlayerId,
  fingerprint: PositionFingerprint,
  candidates: readonly ScoredCandidate[],
  config: HybridConfig,
  acc: StatsAccumulator | undefined,
): HybridNode | undefined {
  if (!retained) return undefined;
  if (acc) acc.reuseAttempts = 1;
  // The two guards that keep reuse inside the one game and the one seat it was
  // built for. `seed` is redundant with the fingerprint (which mixes it in) but
  // is checked first because it is one comparison and states the intent in code.
  if (retained.seed !== state.seed || retained.decider !== decider) return undefined;

  // `findNodeByFingerprint` is deliberately structural (`ReusableNode`) so the
  // reuse machinery knows nothing about PUCT; every node it can reach from a
  // `HybridNode` root is one, hence the narrowing here.
  const matched = findNodeByFingerprint(retained.root, fingerprint, config.reuse.maxDepth) as
    | HybridNode
    | undefined;
  if (!matched) return undefined;

  // One walk does both remaining jobs: age the statistics and enforce the memory
  // cap. Over the cap the tree is dropped rather than trimmed — a partly-trimmed
  // tree is a tree whose visit counts no longer add up.
  const nodes = decayAndCountSubtree(matched, config.reuse.decay, config.reuse.maxNodes);
  if (nodes < 0) return undefined;

  const byKey = new Map<string, HybridEdge>();
  for (const edge of matched.children) byKey.set(macroKey(state, edge.scored.candidate), edge);

  let lastAdopted = -1;
  const adopted = new Array<HybridEdge | undefined>(candidates.length);
  for (let i = 0; i < candidates.length; i++) {
    const edge = byKey.get(macroKey(state, (candidates[i] as ScoredCandidate).candidate));
    if (!edge) continue;
    adopted[i] = edge;
    lastAdopted = i;
  }
  if (lastAdopted < 0) return undefined;

  const children: HybridEdge[] = [];
  let visits = 0;
  for (let i = 0; i <= lastAdopted; i++) {
    const scored = candidates[i] as ScoredCandidate;
    const old = adopted[i];
    if (old) {
      children.push({ scored, node: old.node, visits: old.visits, totalReward: old.totalReward });
      visits += old.visits;
    } else {
      children.push({ scored, node: undefined, visits: 0, totalReward: 0 });
    }
  }
  if (acc) {
    acc.reuseHits = 1;
    acc.reusedNodes = nodes;
    acc.reusedVisits = visits;
  }
  return { candidates, children, mover: decider, visits, fingerprint };
}

/**
 * One PUCT iteration: descend, expand one child by progressive widening, evaluate
 * the leaf with the evaluator, back the reward up.
 */
function runSimulation(
  root: HybridNode,
  rootState: GameState,
  decider: PlayerId,
  config: HybridConfig,
  evaluator: StateEvaluator,
  rolloutPilot: Pilot | undefined,
  rules: RulesConfig,
  registry: EffectRegistry,
  rng: Rng,
  path: HybridEdge[],
  acc: StatsAccumulator | undefined,
): void {
  // One clone per simulation, mutated in place from here on — never a clone per
  // ply. The live root view is never touched.
  const state = cloneState(rootState);
  if (acc) {
    acc.simulations++;
    acc.clones++;
  }
  path.length = 0;

  let node = root;
  let depth = 0;

  while (depth < config.maxTreeDepth && !state.gameOver) {
    const edge = selectEdge(node, decider, config, rng);
    if (!edge) break;
    path.push(edge);
    const macroPlies = applyMacro(state, edge.scored.candidate.plies, rules, registry);
    const settled = advanceToDecision(state, evaluator, rules, registry, config);
    depth++;
    // Only THIS step's plies — accumulating a running total here would count the
    // first edge once per level and make the tree look far more expensive than it is.
    if (acc) acc.treePlies += macroPlies + settled.autoResolved;
    if (state.gameOver || settled.candidates === undefined) break;

    if (edge.node === undefined) {
      // Expand only on a SECOND visit through this edge: a leaf the search never
      // returns to costs no policy call at all, which matters because the policy
      // is the most expensive thing in the loop.
      if (edge.visits === 0) break;
      const prepared = prepareCandidates(state, settled.candidates, config);
      if (prepared.length === 0) break;
      edge.node = {
        candidates: prepared,
        children: [],
        mover: state.priorityPlayer,
        visits: 0,
        // Only shallow nodes can ever be a re-rooting target (`reuse.maxDepth`),
        // so only shallow nodes pay for a fingerprint.
        fingerprint: recordsPosition(config, depth) ? fingerprintPosition(state) : undefined,
      };
      if (acc) {
        acc.nodes++;
        acc.branchingSum += prepared.length;
        acc.branchingCount++;
        if (prepared.length > acc.maxBranching) acc.maxBranching = prepared.length;
      }
      break;
    }
    node = edge.node;
    // Lazy fill: a node inherited from a previous decision sits one level nearer
    // the root than it did, so positions it never needed to record before are now
    // within re-rooting range. Recording them here — where the simulation is
    // already standing in the position — costs one fingerprint per node, once.
    if (node.fingerprint === undefined && recordsPosition(config, depth)) {
      node.fingerprint = fingerprintPosition(state);
    }
  }

  const reward = evaluateLeaf(state, decider, config, evaluator, rolloutPilot, rules, registry, rng, acc);

  root.visits++;
  for (let i = 0; i < path.length; i++) {
    const edge = path[i] as HybridEdge;
    edge.visits++;
    edge.totalReward += reward;
    if (edge.node) edge.node.visits++;
  }
  if (acc && depth > acc.maxTreeDepth) acc.maxTreeDepth = depth;
}

/**
 * Is a node at this tree depth close enough to the root to be worth a position
 * fingerprint? Reuse can only re-root onto something within `reuse.maxDepth`
 * edges, so anything deeper would be paying for a lookup that cannot happen.
 */
function recordsPosition(config: HybridConfig, depth: number): boolean {
  return config.reuse.enabled && depth <= config.reuse.maxDepth;
}

/**
 * Choose the next edge: widen to a new candidate if the visit count has earned
 * one, otherwise pick by PUCT.
 *
 * Progressive widening (brief §7) is the focusing mechanism. `numChildren =
 * ceil(C · visits^alpha)` means a node with 4 visits considers 3 plays and a node
 * with 100 considers 12 — the search's attention follows its own confidence
 * instead of being spread evenly over options the policy already dislikes.
 */
function selectEdge(
  node: HybridNode,
  decider: PlayerId,
  config: HybridConfig,
  rng: Rng,
): HybridEdge | undefined {
  if (node.candidates.length === 0) return undefined;
  const allowed = Math.min(
    node.candidates.length,
    Math.max(config.minChildren, Math.ceil(config.wideningCoefficient * Math.pow(node.visits, config.wideningExponent))),
  );
  if (node.children.length < allowed) {
    const scored = node.candidates[node.children.length] as ScoredCandidate;
    const edge: HybridEdge = { scored, node: undefined, visits: 0, totalReward: 0 };
    node.children.push(edge);
    return edge;
  }

  // PUCT. `Q` is stored from the DECIDER's perspective, so a node the opponent
  // moves at reads it inverted — the opponent is assumed to play well, which the
  // vanilla pilot never assumed.
  const invert = node.mover !== decider;
  const sqrtParent = Math.sqrt(Math.max(1, node.visits));
  let best: HybridEdge | undefined;
  let bestValue = -Infinity;
  let ties = 0;
  for (const edge of node.children) {
    const mean = edge.visits === 0 ? EVEN_POSITION : edge.totalReward / edge.visits;
    const q = invert ? 1 - mean : mean;
    const value = q + config.explorationConstant * edge.scored.prior * (sqrtParent / (1 + edge.visits));
    if (value > bestValue) {
      bestValue = value;
      best = edge;
      ties = 1;
    } else if (value === bestValue) {
      // Reservoir tie-break on the seeded RNG so ties stay reproducible.
      ties++;
      if (rng.nextInt(ties) === 0) best = edge;
    }
  }
  return best;
}

/**
 * The value given to an edge with no statistics yet — an even position. Named
 * because it is a real modelling choice ("first play urgency"): optimism here
 * would make the search re-try every fresh option before believing any of them.
 */
const EVEN_POSITION = 0.5;

/** Apply a macro's plies in order, in place. Returns how many landed. */
function applyMacro(
  state: GameState,
  plies: readonly GameAction[],
  rules: RulesConfig,
  registry: EffectRegistry,
): number {
  let applied = 0;
  for (let i = 0; i < plies.length; i++) {
    if (state.gameOver) break;
    if (!stepInPlace(state, plies[i] as GameAction, rules, registry)) break;
    applied++;
  }
  return applied;
}

/**
 * Advance past every FORCED decision until a real strategic choice is reached
 * (brief §4 Level 0, §40 "compress strategically irrelevant priority passes").
 *
 * A position is forced when its policy offers exactly one option — which, because
 * a naked `tapForMana` is not a policy option at all, includes every one of the
 * enormously common windows where the only things on offer are mana taps the
 * pilot has nothing to spend on. Bounded by `maxAutoResolveSteps` so a rules bug
 * costs one decision rather than hanging the sim.
 *
 * Returns the candidates it computed at the stopping point, so the caller never
 * pays for the policy twice.
 */
function advanceToDecision(
  state: GameState,
  evaluator: StateEvaluator,
  rules: RulesConfig,
  registry: EffectRegistry,
  config: HybridConfig,
): { readonly candidates: readonly PolicyCandidate[] | undefined; readonly autoResolved: number } {
  let autoResolved = 0;
  for (let guard = 0; guard < config.maxAutoResolveSteps; guard++) {
    if (state.gameOver) return { candidates: undefined, autoResolved };
    let legal: readonly GameAction[];
    try {
      legal = generateLegalActions(state, rules);
    } catch {
      return { candidates: undefined, autoResolved };
    }
    if (legal.length === 0) return { candidates: undefined, autoResolved };
    const candidates = evaluator.evaluatePolicy(state, legal);
    if (candidates.length > 1) return { candidates, autoResolved };
    const only = candidates[0];
    if (!only) return { candidates: undefined, autoResolved };
    autoResolved += applyMacro(state, only.plies, rules, registry);
  }
  return { candidates: undefined, autoResolved };
}

/**
 * Score the leaf. Terminal positions and the positional evaluation both come from
 * the same {@link StateEvaluator}; the only thing added here is the speed
 * discount, which is about how the search should *prefer* between two wins rather
 * than about how good a position is.
 *
 * `leafRolloutDepth` is 0 by default — that is the Phase-4 change. A caller who
 * wants to re-measure the rollout-versus-evaluator trade can raise it and read
 * the difference; nothing else in the search changes.
 */
function evaluateLeaf(
  state: GameState,
  decider: PlayerId,
  config: HybridConfig,
  evaluator: StateEvaluator,
  rolloutPilot: Pilot | undefined,
  rules: RulesConfig,
  registry: EffectRegistry,
  rng: Rng,
  acc: StatsAccumulator | undefined,
): number {
  let plies = 0;
  if (rolloutPilot && !state.gameOver) {
    for (let depth = 0; depth < config.leafRolloutDepth && !state.gameOver; depth++) {
      let legal: readonly GameAction[];
      try {
        legal = generateLegalActions(state, rules);
      } catch {
        break;
      }
      if (legal.length === 0) break;
      const action = rolloutPilot.chooseAction({ view: state, legalActions: legal, rng });
      if (!stepInPlace(state, action, rules, registry)) break;
      plies++;
    }
  }
  if (acc) {
    acc.rolloutPlies += plies;
    if (state.gameOver) acc.terminalEvaluations++;
    else acc.leafEvaluations++;
  }

  const score = evaluator.evaluateState(state, decider);
  if (!state.gameOver) return score;
  // Terminal: nudge toward the draw line by how long it took, so the search
  // closes won games out instead of dithering into a timeout.
  const discount = config.winSpeedDiscount * plies;
  const draw = config.evaluation.drawScore;
  if (score > draw) return Math.max(draw, score - discount);
  if (score < draw) return Math.min(draw, score + discount);
  return score;
}

/**
 * Advance a simulation's PRIVATE state by one action in place. Robust: a rejected
 * or impossible action stops the macro rather than crashing the search.
 */
function stepInPlace(
  state: GameState,
  action: GameAction,
  rules: RulesConfig,
  registry: EffectRegistry,
): boolean {
  try {
    applyActionInPlace(state, action, rules, registry);
    return true;
  } catch {
    return false;
  }
}

/**
 * The most-visited root child — the standard MCTS final move choice, and less
 * noisy than the highest mean. RNG breaks ties so the pick stays reproducible.
 */
function pickRobustChild(root: HybridNode, rng: Rng): HybridEdge | undefined {
  let best: HybridEdge | undefined;
  let bestVisits = -1;
  let ties = 0;
  for (const edge of root.children) {
    if (edge.visits > bestVisits) {
      bestVisits = edge.visits;
      best = edge;
      ties = 1;
    } else if (edge.visits === bestVisits) {
      ties++;
      if (rng.nextInt(ties) === 0) best = edge;
    }
  }
  return best;
}

/** A guaranteed-legal action when search cannot run. */
function fallback(ctx: DecisionContext): GameAction {
  const pass = ctx.legalActions.find((a) => a.kind === 'passPriority');
  if (pass) return pass;
  if (ctx.legalActions.length > 0) return ctx.legalActions[0] as GameAction;
  return safeFallbackAction(ctx.view as unknown as GameState);
}

/** Wall-clock reader, isolated so the reproducible path never touches it directly. */
function now(): number {
  const perf = (globalThis as { performance?: { now(): number } }).performance;
  return perf ? perf.now() : Date.now();
}
