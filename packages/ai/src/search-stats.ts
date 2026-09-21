/**
 * SEARCH INSTRUMENTATION — the measurement layer the search work is judged by
 * (`docs/plans/superhuman-ai-program.md` §2, §65, §68: "do not assume the
 * bottleneck — instrument it").
 *
 * Two things live here, and they are deliberately together because the second is
 * what makes the first meaningful:
 *
 *  1. {@link SearchStatsSink} — an OPTIONAL observer a search pilot reports its
 *     per-decision shape into (branching factor, tree depth, node count, how many
 *     engine plies were spent inside the tree versus inside rollouts). A pilot
 *     that is handed no sink does no extra work at all, so instrumentation can
 *     never cost the shipped path anything.
 *  2. {@link actionEquivalenceKey} — the canonical key that says when two offered
 *     actions are the SAME decision. Five untapped Islands generate five distinct
 *     `tapForMana` actions the search would otherwise explore separately, which is
 *     the brief's §4 "Level 1 — equivalent actions" and Brief A's "mana
 *     equivalence: five identical Islands must collapse to one action key".
 *
 * Keeping the key here rather than inside one pilot is the point: Phase 1 uses it
 * to MEASURE how much redundancy the current search carries, and Phase 2 uses the
 * same function to REMOVE that redundancy. If the two ever disagreed, the reported
 * saving would be fiction.
 *
 * ⚠️ The key must never merge two actions whose consequences differ. It keys on
 * printed card identity plus the resource actually produced/spent plus the chosen
 * targets — never on instance id alone (which would merge nothing) and never on
 * card name alone (which would merge a tapped dual's two colours into one).
 */

import type { GameAction, GameState, InstanceId, PlayerId } from '@jonny-boi/core';
import { manaModesOf } from '@jonny-boi/core';

// --- equivalence ----------------------------------------------------------------

/**
 * A canonical key for an action, such that two actions sharing a key are
 * strategically interchangeable *from this state*.
 *
 * The rules, and why each is safe:
 *
 *  - `tapForMana` — keyed by the **mana produced**, not by which permanent
 *    produces it. Tapping Island #7 and Island #12 for {U} put the identical mana
 *    in the pool and leave identical boards up to which of two indistinguishable
 *    lands is tapped, and nothing in this engine can tell those apart (no card
 *    cares "which" Island). A modal source keys per MODE, so a dual's {U} and its
 *    {B} stay two different decisions. The permanent's NAME is included so a
 *    Birds of Paradise tapped for {U} is not merged with an Island tapped for {U}
 *    — they leave different creatures available to block.
 *  - `castSpell` / `playLand` — keyed by printed name + targets. Two copies of
 *    Lightning Bolt in hand are one decision; the same Bolt aimed at two different
 *    creatures is two.
 *  - `activateAbility` — printed name + ability index + targets, same reasoning.
 *  - `declareAttackers` / `declareBlockers` — keyed by the actual assignment.
 *    These are composite decisions over specific bodies and merging any of them
 *    would change the game.
 *  - `passPriority` / `answerChoice` — one per player / per answer.
 *
 * Cheap on purpose: it is called once per offered action per decision, and the
 * search calls it on every node it widens.
 */
export function actionEquivalenceKey(state: GameState, action: GameAction): string {
  switch (action.kind) {
    case 'tapForMana': {
      const perm = findPermanent(state, action.instanceId);
      const mode = action.mode ?? 0;
      if (!perm) return `tap:?:${mode}`;
      const production = manaModesOf(perm.def)[mode];
      const produced = production ? productionKey(production) : `m${mode}`;
      return `tap:${perm.def.name}:${produced}`;
    }
    case 'castSpell': {
      const name = handCardName(state, action.player, action.instanceId);
      // §3.112 — the printed cast and an evoke/dash cast of the same card are
      // two decisions, not one: the body that arrives is different.
      const alt = action.alternative !== undefined ? `:${action.alternative}` : '';
      return `cast:${name}:${targetsKey(action.targets)}${alt}`;
    }
    case 'playLand': {
      const name = handCardName(state, action.player, action.instanceId);
      return `land:${name}`;
    }
    case 'activateAbility': {
      const perm = findPermanent(state, action.instanceId);
      const name = perm?.def.name ?? String(action.instanceId);
      return `act:${name}:${action.abilityIndex}:${targetsKey(action.targets)}`;
    }
    case 'cycleCard': {
      // Keyed by NAME, like the cast and land cases above and for the same
      // reason: two copies of the same cycling land in hand are the same move,
      // and keying by instance id would make the search widen twice for it.
      const name = handCardName(state, action.player, action.instanceId);
      return `cycle:${name}:${action.abilityIndex ?? 0}`;
    }
    case 'suspendCard': {
      // §3.106 — keyed by NAME for the same reason cycling is.
      const name = handCardName(state, action.player, action.instanceId);
      return `suspend:${name}`;
    }
    // §3.112 — same rule.
    case 'foretellCard':
      return `foretell:${handCardName(state, action.player, action.instanceId)}`;
    case 'plotCard':
      return `plot:${handCardName(state, action.player, action.instanceId)}`;
    case 'activateGraveyardAbility': {
      // §3.111 — keyed by NAME: two copies of the same unearth card in the
      // graveyard are one move, exactly as two cycling lands in hand are.
      const card = state.players[action.player].graveyard.find((c) => c.instanceId === action.instanceId);
      const name = card?.def.name ?? String(action.instanceId);
      return `gyact:${name}:${action.abilityIndex}:${targetsKey(action.targets)}`;
    }
    case 'declareAttackers':
      return `atk:${[...action.attackers].sort(numeric).join(',')}`;
    case 'declareBlockers':
      return `blk:${action.blocks.map((b) => `${b.blocker}>${b.attacker}`).sort().join(',')}`;
    case 'passPriority':
      return `pass:${action.player}`;
    case 'answerChoice':
      return `ans:${action.choiceId}:${JSON.stringify(action.answer)}`;
    // §3.178 — the combo window's two answers. A pilot is never offered them
    // (the window opens only for seats the Play board names), so these rows
    // exist because the switch is total, not because search widens on them.
    case 'repeatCombo':
      return `combo:repeat:${action.times}`;
    case 'dismissCombo':
      return 'combo:dismiss';
    default: {
      const exhaustive: never = action;
      void exhaustive;
      return 'action';
    }
  }
}

/** Sort comparator for numeric instance ids (default sort is lexicographic). */
function numeric(a: number, b: number): number {
  return a - b;
}

/** A stable string for a mana production, e.g. `{U:1}` → `U`, `{C:2}` → `CC`. */
function productionKey(production: Readonly<Record<string, number | undefined>>): string {
  let out = '';
  for (const color of PRODUCTION_COLORS) out += color.repeat(production[color] ?? 0);
  return out || 'none';
}

/**
 * The colour order used to render a production key. Fixed and local so the key is
 * stable regardless of object key order (`{U:1,G:1}` and `{G:1,U:1}` must match).
 */
const PRODUCTION_COLORS: readonly string[] = ['W', 'U', 'B', 'R', 'G', 'C'];

function targetsKey(targets: ReadonlyArray<InstanceId | PlayerId> | undefined): string {
  if (!targets || targets.length === 0) return '-';
  return targets.join('+');
}

function findPermanent(state: GameState, id: InstanceId) {
  const battlefield = state.battlefield;
  for (let i = 0; i < battlefield.length; i++) {
    const perm = battlefield[i];
    if (perm && perm.instanceId === id) return perm;
  }
  return undefined;
}

function handCardName(state: GameState, player: PlayerId, id: InstanceId): string {
  const hand = state.players[player]?.hand;
  if (hand) {
    for (let i = 0; i < hand.length; i++) {
      const card = hand[i];
      if (card && card.instanceId === id) return card.def.name;
    }
  }
  return String(id);
}

/**
 * How many DISTINCT decisions a menu of offered actions really contains, and how
 * many entries collapse onto an existing one.
 *
 * This is the "largest sources of redundant/equivalent search" number the brief
 * (§65) asks for, measured rather than asserted.
 */
export function countEquivalentActions(
  state: GameState,
  actions: readonly GameAction[],
): { readonly offered: number; readonly distinct: number; readonly redundant: number } {
  const seen = new Set<string>();
  for (let i = 0; i < actions.length; i++) {
    seen.add(actionEquivalenceKey(state, actions[i] as GameAction));
  }
  return { offered: actions.length, distinct: seen.size, redundant: actions.length - seen.size };
}

// --- per-decision statistics ------------------------------------------------------

/**
 * The measured shape of ONE search decision. Every field is a count the search
 * already knows; nothing here is estimated.
 */
export interface DecisionStats {
  /** How many candidate actions the root had to choose between. */
  readonly rootBranching: number;
  /** Distinct root candidates after {@link actionEquivalenceKey} collapsing. */
  readonly rootDistinct: number;
  /** The largest legal-action count seen at any node enumerated this decision. */
  readonly maxBranching: number;
  /** Mean legal-action count over every node enumerated this decision. */
  readonly meanBranching: number;
  /** Tree nodes allocated this decision (the node-allocation volume). */
  readonly nodes: number;
  /** Deepest path from the root, in tree edges (not rollout plies). */
  readonly maxTreeDepth: number;
  /** Simulations actually run (may be below the budget if a cap tripped). */
  readonly simulations: number;
  /** Engine actions applied while descending/expanding the tree. */
  readonly treePlies: number;
  /** Engine actions applied inside rollouts — the search's dominant cost. */
  readonly rolloutPlies: number;
  /** Root-state clones made (one per simulation in the current design). */
  readonly clones: number;
  /** Leaf evaluations that ran on a NON-terminal position. */
  readonly leafEvaluations: number;
  /** Leaf evaluations that landed on a terminal (decided) position. */
  readonly terminalEvaluations: number;
  /**
   * TREE REUSE (brief §21-22). `reuseAttempts` is 1 when a tree was carried in
   * from the previous decision at all; `reuseHits` is 1 when the live position
   * was actually found inside it. The ratio is the number that says whether
   * reuse is doing anything, and it is a COUNT rather than a rate so a summary
   * over many decisions can add them up honestly.
   */
  readonly reuseAttempts: number;
  readonly reuseHits: number;
  /** Nodes in the adopted subtree — the retained-memory measurement. */
  readonly reusedNodes: number;
  /** Visits inherited by the new root's edges, i.e. free search. */
  readonly reusedVisits: number;
}

/**
 * An observer a search pilot reports each decision into. Optional everywhere: a
 * pilot built without one must not construct a single object for it, which is why
 * the pilot takes the sink at CONSTRUCTION rather than reading it per decision.
 */
export interface SearchStatsSink {
  decision(stats: DecisionStats): void;
}

/** A mutable accumulator a search fills in as it runs, then emits once. */
export interface StatsAccumulator {
  rootBranching: number;
  rootDistinct: number;
  maxBranching: number;
  branchingSum: number;
  branchingCount: number;
  nodes: number;
  maxTreeDepth: number;
  simulations: number;
  treePlies: number;
  rolloutPlies: number;
  clones: number;
  leafEvaluations: number;
  terminalEvaluations: number;
  reuseAttempts: number;
  reuseHits: number;
  reusedNodes: number;
  reusedVisits: number;
}

/** A zeroed accumulator. */
export function createStatsAccumulator(): StatsAccumulator {
  return {
    rootBranching: 0,
    rootDistinct: 0,
    maxBranching: 0,
    branchingSum: 0,
    branchingCount: 0,
    nodes: 0,
    maxTreeDepth: 0,
    simulations: 0,
    treePlies: 0,
    rolloutPlies: 0,
    clones: 0,
    leafEvaluations: 0,
    terminalEvaluations: 0,
    reuseAttempts: 0,
    reuseHits: 0,
    reusedNodes: 0,
    reusedVisits: 0,
  };
}

/** Freeze an accumulator into the reported {@link DecisionStats}. */
export function finishStats(acc: StatsAccumulator): DecisionStats {
  return {
    rootBranching: acc.rootBranching,
    rootDistinct: acc.rootDistinct,
    maxBranching: acc.maxBranching,
    meanBranching: acc.branchingCount === 0 ? 0 : acc.branchingSum / acc.branchingCount,
    nodes: acc.nodes,
    maxTreeDepth: acc.maxTreeDepth,
    simulations: acc.simulations,
    treePlies: acc.treePlies,
    rolloutPlies: acc.rolloutPlies,
    clones: acc.clones,
    leafEvaluations: acc.leafEvaluations,
    terminalEvaluations: acc.terminalEvaluations,
    reuseAttempts: acc.reuseAttempts,
    reuseHits: acc.reuseHits,
    reusedNodes: acc.reusedNodes,
    reusedVisits: acc.reusedVisits,
  };
}

/**
 * A ready-made sink that accumulates every decision and can summarise them.
 * Used by the bench and by tests; a consumer wanting something else just
 * implements {@link SearchStatsSink}.
 */
export interface CollectingStatsSink extends SearchStatsSink {
  readonly decisions: readonly DecisionStats[];
  summary(): SearchStatsSummary;
}

/** Aggregate shape over many decisions. */
export interface SearchStatsSummary {
  readonly decisions: number;
  readonly meanRootBranching: number;
  readonly maxRootBranching: number;
  readonly meanBranching: number;
  readonly maxBranching: number;
  readonly rootRedundancyRate: number;
  readonly meanTreeDepth: number;
  readonly maxTreeDepth: number;
  readonly meanNodes: number;
  readonly totalSimulations: number;
  readonly totalTreePlies: number;
  readonly totalRolloutPlies: number;
  readonly totalClones: number;
  readonly meanPliesPerSimulation: number;
  readonly terminalRate: number;
  /** Share of decisions that CARRIED a tree in and found the live position in it. */
  readonly reuseHitRate: number;
  /** Mean inherited visits per decision that hit — how much search was free. */
  readonly meanReusedVisits: number;
  /** Largest retained subtree seen, in nodes — the memory bound, measured. */
  readonly maxReusedNodes: number;
}

export function createCollectingStatsSink(): CollectingStatsSink {
  const decisions: DecisionStats[] = [];
  return {
    decisions,
    decision(stats) {
      decisions.push(stats);
    },
    summary() {
      const n = decisions.length;
      if (n === 0) return EMPTY_SUMMARY;
      let rootSum = 0;
      let rootMax = 0;
      let distinctSum = 0;
      let branchSum = 0;
      let branchMax = 0;
      let depthSum = 0;
      let depthMax = 0;
      let nodeSum = 0;
      let sims = 0;
      let treePlies = 0;
      let rolloutPlies = 0;
      let clones = 0;
      let terminals = 0;
      let leaves = 0;
      let reuseAttempts = 0;
      let reuseHits = 0;
      let reusedVisits = 0;
      let maxReusedNodes = 0;
      for (const d of decisions) {
        rootSum += d.rootBranching;
        if (d.rootBranching > rootMax) rootMax = d.rootBranching;
        distinctSum += d.rootDistinct;
        branchSum += d.meanBranching;
        if (d.maxBranching > branchMax) branchMax = d.maxBranching;
        depthSum += d.maxTreeDepth;
        if (d.maxTreeDepth > depthMax) depthMax = d.maxTreeDepth;
        nodeSum += d.nodes;
        sims += d.simulations;
        treePlies += d.treePlies;
        rolloutPlies += d.rolloutPlies;
        clones += d.clones;
        terminals += d.terminalEvaluations;
        leaves += d.leafEvaluations + d.terminalEvaluations;
        reuseAttempts += d.reuseAttempts;
        reuseHits += d.reuseHits;
        reusedVisits += d.reusedVisits;
        if (d.reusedNodes > maxReusedNodes) maxReusedNodes = d.reusedNodes;
      }
      return {
        decisions: n,
        meanRootBranching: rootSum / n,
        maxRootBranching: rootMax,
        meanBranching: branchSum / n,
        maxBranching: branchMax,
        rootRedundancyRate: rootSum === 0 ? 0 : 1 - distinctSum / rootSum,
        meanTreeDepth: depthSum / n,
        maxTreeDepth: depthMax,
        meanNodes: nodeSum / n,
        totalSimulations: sims,
        totalTreePlies: treePlies,
        totalRolloutPlies: rolloutPlies,
        totalClones: clones,
        meanPliesPerSimulation: sims === 0 ? 0 : (treePlies + rolloutPlies) / sims,
        terminalRate: leaves === 0 ? 0 : terminals / leaves,
        reuseHitRate: reuseAttempts === 0 ? 0 : reuseHits / reuseAttempts,
        meanReusedVisits: reuseHits === 0 ? 0 : reusedVisits / reuseHits,
        maxReusedNodes,
      };
    },
  };
}

const EMPTY_SUMMARY: SearchStatsSummary = Object.freeze({
  decisions: 0,
  meanRootBranching: 0,
  maxRootBranching: 0,
  meanBranching: 0,
  maxBranching: 0,
  rootRedundancyRate: 0,
  meanTreeDepth: 0,
  maxTreeDepth: 0,
  meanNodes: 0,
  totalSimulations: 0,
  totalTreePlies: 0,
  totalRolloutPlies: 0,
  totalClones: 0,
  meanPliesPerSimulation: 0,
  terminalRate: 0,
  reuseHitRate: 0,
  meanReusedVisits: 0,
  maxReusedNodes: 0,
});
