import { describe, expect, it } from 'vitest';
import {
  applyAction,
  cloneState,
  createGame,
  createRng,
  generateLegalActions,
  type DeckList,
  type GameAction,
  type GameState,
  type PlayerId,
} from '@jonny-boi/core';
import {
  decayAndCountSubtree,
  findNodeByFingerprint,
  fingerprintPosition,
  fingerprintsEqual,
  type PositionFingerprint,
  type ReusableEdge,
  type ReusableNode,
} from './tree-reuse.js';
import { createHybridPilot } from './hybrid.js';
import {
  DEFAULT_HYBRID_CONFIG,
  FAST_HYBRID_CONFIG,
  THRIFTY_HYBRID_CONFIG,
  TREE_REUSE_OFF,
  TREE_REUSE_ON,
} from './hybrid-config.js';
import { createHeuristicPilot } from './heuristic.js';
import type { Pilot } from './pilot.js';
import { createCollectingStatsSink } from './search-stats.js';
import {
  burnDef,
  createTestRegistry,
  creatureDef,
  giveHand,
  landDef,
  putOnBattlefield,
} from './test-support.js';

const TEST_REGISTRY = createTestRegistry();

/**
 * The fast test config with reuse ON.
 *
 * Reuse is OFF in `DEFAULT_HYBRID_CONFIG` — a measured decision recorded there —
 * so every test that is ABOUT reuse has to ask for it explicitly. That is the
 * right way round: if the default is ever flipped, these tests keep testing what
 * they say they test.
 */
const REUSING_CONFIG = { ...FAST_HYBRID_CONFIG, reuse: TREE_REUSE_ON };

function aggroDeck(): DeckList {
  const cards = [];
  for (let i = 0; i < 14; i++) cards.push(landDef('Mountain', 'R'));
  for (let i = 0; i < 8; i++) cards.push(creatureDef(`Goblin${i}`, 2, 2, { cost: { R: 1 } }));
  for (let i = 0; i < 4; i++) cards.push(burnDef(`Bolt${i}`, 3, { R: 1 }));
  return { cards };
}

function newGame(seed: number): GameState {
  const { state } = createGame({ seed, decks: { A: aggroDeck(), B: aggroDeck() } });
  return state;
}

/**
 * Play a whole game and record every action, exactly as the sim harness drives a
 * pilot. The recorded SEQUENCE is the assertion target throughout this file: a
 * winner and a turn count can coincide by luck, an identical action-by-action
 * transcript cannot. It is the same technique `bench/mcts-bench.mjs` fingerprints
 * decisions with.
 */
function playGame(seed: number, pilotA: Pilot, pilotB: Pilot, maxActions = 3000): GameAction[] {
  let state = newGame(seed);
  const pilots: Record<PlayerId, Pilot> = { A: pilotA, B: pilotB };
  const rngs: Record<PlayerId, ReturnType<typeof createRng>> = {
    A: createRng((seed ^ 0x9e3779b9) >>> 0),
    B: createRng((seed ^ 0x85ebca6b) >>> 0),
  };
  const taken: GameAction[] = [];
  for (let i = 0; i < maxActions && !state.gameOver && state.turnNumber <= 30; i++) {
    const legal = generateLegalActions(state);
    if (legal.length === 0) break;
    const seat = state.priorityPlayer;
    const action = pilots[seat]!.chooseAction({
      view: state,
      legalActions: legal,
      rng: rngs[seat]!,
      registry: TEST_REGISTRY,
    });
    taken.push(action);
    state = applyAction(state, action, undefined, TEST_REGISTRY).state;
  }
  return taken;
}

/** A position with a real decision in it, so the pilot actually searches. */
function decisionState(seed: number): GameState {
  const state = newGame(seed);
  state.step = 'precombatMain';
  state.activePlayer = 'A';
  state.priorityPlayer = 'A';
  state.stack = [];
  state.players.A.hand = [];
  state.players.B.hand = [];
  state.players.A.landsPlayedThisTurn = 0;
  putOnBattlefield(state, 'A', [landDef('Mountain', 'R'), landDef('Mountain', 'R')]);
  giveHand(state, 'A', [
    creatureDef('Goblin', 2, 2, { cost: { R: 1 } }),
    burnDef('Bolt', 3, { R: 1 }),
  ]);
  putOnBattlefield(state, 'B', [creatureDef('Bear', 2, 2)]);
  return state;
}

describe('position fingerprint — the key tree reuse matches on', () => {
  it('a clone of a position fingerprints identically', () => {
    const state = decisionState(3);
    expect(fingerprintsEqual(fingerprintPosition(state), fingerprintPosition(cloneState(state)))).toBe(true);
  });

  it('separates two positions that differ in any single field', () => {
    const base = decisionState(3);
    const baseline = fingerprintPosition(base);
    const mutations: ReadonlyArray<readonly [string, (s: GameState) => void]> = [
      ['life', (s) => (s.players.A.life -= 1)],
      ['turn', (s) => (s.turnNumber += 1)],
      ['step', (s) => (s.step = 'postcombatMain')],
      ['priority', (s) => (s.priorityPlayer = 'B')],
      ['active player', (s) => (s.activePlayer = 'B')],
      ['consecutive passes', (s) => (s.consecutivePasses += 1)],
      ['rng cursor', (s) => (s.rngState = (s.rngState ^ 0x5f) >>> 0)],
      ['next instance id', (s) => (s.nextInstanceId += 1)],
      ['a permanent tapped', (s) => (s.battlefield[0]!.tapped = !s.battlefield[0]!.tapped)],
      ['damage marked', (s) => (s.battlefield[0]!.damageMarked += 1)],
      ['summoning sickness', (s) => (s.battlefield[0]!.summoningSick = !s.battlefield[0]!.summoningSick)],
      ['a counter', (s) => (s.battlefield[0]!.counters = { '+1/+1': 1 })],
      ['an attachment', (s) => (s.battlefield[0]!.attachedTo = s.battlefield[1]!.instanceId)],
      ['controller', (s) => (s.battlefield[0]!.controller = 'B')],
      ['hand contents', (s) => s.players.A.hand.pop()],
      ['library depth', (s) => s.players.A.library.shift()],
      ['graveyard', (s) => s.players.A.graveyard.push(s.players.A.hand[0]!)],
      ['mana pool', (s) => (s.players.A.manaPool.R += 1)],
      ['lands played', (s) => (s.players.A.landsPlayedThisTurn += 1)],
      ['game over', (s) => (s.gameOver = true)],
      ['combat', (s) => (s.combat = { attackers: [s.battlefield[0]!.instanceId], blocks: {}, attackersDeclared: true, blockersDeclared: false })],
    ];
    for (const [label, mutate] of mutations) {
      const mutated = cloneState(base);
      mutate(mutated);
      expect(
        fingerprintsEqual(baseline, fingerprintPosition(mutated)),
        `changing ${label} must change the fingerprint`,
      ).toBe(false);
    }
  });

  it('separates two GAMES even when every other field agrees', () => {
    // THE guarantee that makes reuse safe for the Lab. A pilot instance outlives a
    // game in every real consumer, and the Lab shards games across workers by
    // range — so a tree that could survive a game boundary would make a verdict
    // depend on the worker count. `seed` is in the fingerprint precisely so that
    // is structurally impossible rather than merely unlikely.
    const first = decisionState(3);
    const second = cloneState(first);
    (second as { seed: number }).seed = first.seed + 1;
    expect(fingerprintsEqual(fingerprintPosition(first), fingerprintPosition(second))).toBe(false);
  });
});

// --- the re-rooting walk ----------------------------------------------------------

function fp(n: number): PositionFingerprint {
  return { a: n, b: n * 7 + 1 };
}

function node(fingerprint: number | undefined, children: ReusableEdge[] = []): ReusableNode {
  return { children, visits: 0, fingerprint: fingerprintFor(fingerprint) };
}

function fingerprintFor(n: number | undefined): PositionFingerprint | undefined {
  return n === undefined ? undefined : fp(n);
}

function edge(child: ReusableNode | undefined, visits = 0, totalReward = 0): ReusableEdge {
  return { node: child, visits, totalReward };
}

describe('findNodeByFingerprint — locating the live position in a retained tree', () => {
  it('finds the root itself', () => {
    const root = node(1);
    expect(findNodeByFingerprint(root, fp(1), 4)).toBe(root);
  });

  it('finds a descendant and returns undefined for a position that is not there', () => {
    const target = node(9);
    const root = node(1, [edge(node(2, [edge(target)]))]);
    expect(findNodeByFingerprint(root, fp(9), 4)).toBe(target);
    expect(findNodeByFingerprint(root, fp(42), 4)).toBeUndefined();
  });

  it('prefers the SHALLOWEST match when a position recurs', () => {
    // A genuine transposition. The shallow node's statistics were gathered
    // closest to the line actually played, so it is the one worth inheriting.
    const deep = node(5);
    const shallow = node(5);
    const root = node(1, [edge(node(2, [edge(node(3, [edge(deep)]))])), edge(shallow)]);
    expect(findNodeByFingerprint(root, fp(5), 4)).toBe(shallow);
  });

  it('refuses to look deeper than maxDepth', () => {
    const deep = node(5);
    const root = node(1, [edge(node(2, [edge(node(3, [edge(deep)]))]))]);
    expect(findNodeByFingerprint(root, fp(5), 2)).toBeUndefined();
    expect(findNodeByFingerprint(root, fp(5), 3)).toBe(deep);
  });
});

describe('decayAndCountSubtree — ageing statistics and bounding memory', () => {
  it('counts every node once', () => {
    const root = node(1, [edge(node(2, [edge(node(3))])), edge(node(4))]);
    expect(decayAndCountSubtree(root, 1, 100)).toBe(4);
  });

  it('leaves statistics untouched at decay 1', () => {
    const child = node(2);
    child.visits = 30;
    const root = node(1, [edge(child, 30, 18)]);
    root.visits = 30;
    decayAndCountSubtree(root, 1, 100);
    expect(root.children[0]!.visits).toBe(30);
    expect(root.children[0]!.totalReward).toBe(18);
  });

  it('preserves every mean exactly while reducing confidence', () => {
    // The property that makes decay a PRIOR rather than a distortion: visits and
    // reward scale together, so Q is unchanged and only N shrinks.
    const root = node(1, [edge(node(2), 40, 26), edge(node(3), 10, 3)]);
    root.visits = 50;
    decayAndCountSubtree(root, 0.25, 100);
    expect(root.visits).toBe(12.5);
    for (const [visits, reward, mean] of [
      [root.children[0]!.visits, root.children[0]!.totalReward, 26 / 40],
      [root.children[1]!.visits, root.children[1]!.totalReward, 3 / 10],
    ] as const) {
      expect(reward / visits).toBeCloseTo(mean, 12);
    }
  });

  it('reports -1 rather than a partial answer once the cap is exceeded', () => {
    const root = node(1, [edge(node(2, [edge(node(3))])), edge(node(4))]);
    expect(decayAndCountSubtree(root, 1, 3)).toBe(-1);
  });
});

// --- the pilot ---------------------------------------------------------------------

describe('hybrid pilot with tree reuse — determinism', () => {
  it('a pilot that already played another game plays this one identically', () => {
    // The single most important assertion on this branch. Every real consumer
    // (`sim/cli.ts`, `apps/web/lib/sim/execute.ts`, the sim harness) builds ONE
    // pilot and runs many games through it, and the Lab hands different slices of
    // the game grid to different workers. If a retained tree could survive a game
    // boundary, the same seeded game would answer differently depending on which
    // games happened to run before it — i.e. on the worker count.
    const fresh = playGame(101, createHybridPilot(REUSING_CONFIG), createHeuristicPilot());

    const warmed = createHybridPilot(REUSING_CONFIG);
    playGame(202, warmed, createHeuristicPilot());
    playGame(303, warmed, createHeuristicPilot());
    const afterOtherGames = playGame(101, warmed, createHeuristicPilot());

    expect(afterOtherGames).toEqual(fresh);
  });

  it('same seed → identical action-by-action transcript', () => {
    const first = playGame(41, createHybridPilot(REUSING_CONFIG), createHeuristicPilot());
    const second = playGame(41, createHybridPilot(REUSING_CONFIG), createHeuristicPilot());
    expect(second).toEqual(first);
    expect(first.length).toBeGreaterThan(20);
  });

  it('stays deterministic when ONE instance plays both seats', () => {
    // Rewards are stored from the deciding player's point of view, so a tree
    // built for seat A must never be re-rooted for a seat-B decision. A shared
    // instance is not hypothetical: `sim/pilot-quality.test.ts` does exactly this.
    const shared = createHybridPilot(REUSING_CONFIG);
    const first = playGame(57, shared, shared);
    const second = playGame(57, createHybridPilot(REUSING_CONFIG), createHybridPilot(REUSING_CONFIG));
    // Two INSTANCES may legitimately reuse where one instance cannot, so these
    // two transcripts need not agree — but each must reproduce itself.
    expect(playGame(57, createHybridPilot(REUSING_CONFIG), createHybridPilot(REUSING_CONFIG))).toEqual(second);
    const sharedAgain = createHybridPilot(REUSING_CONFIG);
    expect(playGame(57, sharedAgain, sharedAgain)).toEqual(first);
  });
});

describe('hybrid pilot with tree reuse — behaviour', () => {
  it('really does re-root: most decisions inherit a tree over a real game', () => {
    const sink = createCollectingStatsSink();
    playGame(63, createHybridPilot(REUSING_CONFIG, undefined, sink), createHeuristicPilot());
    const summary = sink.summary();
    expect(summary.decisions).toBeGreaterThan(10);
    expect(summary.reuseHitRate).toBeGreaterThan(0.5);
    expect(summary.meanReusedVisits).toBeGreaterThan(0);
  });

  it('inherits nothing at all when reuse is switched off', () => {
    const sink = createCollectingStatsSink();
    const config = { ...FAST_HYBRID_CONFIG, reuse: TREE_REUSE_OFF };
    playGame(63, createHybridPilot(config, undefined, sink), createHeuristicPilot());
    const summary = sink.summary();
    expect(summary.decisions).toBeGreaterThan(10);
    expect(summary.reuseHitRate).toBe(0);
    expect(summary.maxReusedNodes).toBe(0);
  });

  it('keeps the retained tree far inside its memory cap over a whole game', () => {
    const sink = createCollectingStatsSink();
    playGame(63, createHybridPilot(THRIFTY_HYBRID_CONFIG, undefined, sink), createHeuristicPilot());
    expect(sink.summary().maxReusedNodes).toBeLessThan(THRIFTY_HYBRID_CONFIG.reuse.maxNodes);
  });

  it('drops the tree rather than adopting it when the cap is too small to hold it', () => {
    // The cap is a real guard, not decoration: a tree over the limit is discarded
    // whole (a partly-trimmed tree is one whose visit counts no longer add up),
    // and the pilot simply searches from scratch.
    const sink = createCollectingStatsSink();
    const config = { ...FAST_HYBRID_CONFIG, reuse: { ...TREE_REUSE_ON, maxNodes: 1 } };
    const transcript = playGame(63, createHybridPilot(config, undefined, sink), createHeuristicPilot());
    expect(sink.summary().reuseHitRate).toBe(0);
    expect(transcript.length).toBeGreaterThan(20);
  });

  it('never returns an action the engine rejects, with reuse on', () => {
    let state = newGame(88);
    const pilot = createHybridPilot(REUSING_CONFIG);
    const heuristic = createHeuristicPilot();
    const rngs: Record<PlayerId, ReturnType<typeof createRng>> = {
      A: createRng(1),
      B: createRng(2),
    };
    for (let i = 0; i < 800 && !state.gameOver && state.turnNumber <= 30; i++) {
      const legal = generateLegalActions(state);
      if (legal.length === 0) break;
      const seat = state.priorityPlayer;
      const action = (seat === 'A' ? pilot : heuristic).chooseAction({
        view: state,
        legalActions: legal,
        rng: rngs[seat]!,
        registry: TEST_REGISTRY,
      });
      const applied = applyAction(state, action, undefined, TEST_REGISTRY);
      expect(applied.rejected, `rejected ${JSON.stringify(action)}`).toBeFalsy();
      state = applied.state;
    }
  });
});

describe('tree-reuse configuration', () => {
  it('is OFF in the shipped default — the measured decision, pinned', () => {
    // Reuse did not make the pilot stronger at the default budget and did make
    // every decision cost 35-59% more (the table on DEFAULT_HYBRID_CONFIG), so
    // enabling it there would be a rule-7 throughput regression bought with a
    // strength gain that is not there. Anyone flipping this must re-measure.
    expect(DEFAULT_HYBRID_CONFIG.reuse.enabled).toBe(false);
    expect(TREE_REUSE_OFF.enabled).toBe(false);
    expect(TREE_REUSE_ON.enabled).toBe(true);
  });

  it('offers reuse where it measured well: a cheaper search, same strength', () => {
    expect(THRIFTY_HYBRID_CONFIG.reuse.enabled).toBe(true);
    expect(THRIFTY_HYBRID_CONFIG.budget.kind).toBe('simulations');
    // The point of the config is a SMALLER budget carried by the retained tree;
    // if it ever stopped being smaller it would just be the default with extra
    // cost, which is the thing the measurement rejected.
    expect(
      THRIFTY_HYBRID_CONFIG.budget.kind === 'simulations' && THRIFTY_HYBRID_CONFIG.budget.simulations,
    ).toBeLessThan(
      DEFAULT_HYBRID_CONFIG.budget.kind === 'simulations' ? DEFAULT_HYBRID_CONFIG.budget.simulations : 0,
    );
  });

  it('bounds both the search for a match and the retained memory', () => {
    expect(TREE_REUSE_ON.maxDepth).toBeGreaterThan(0);
    expect(TREE_REUSE_ON.maxNodes).toBeGreaterThan(0);
    expect(TREE_REUSE_ON.decay).toBeGreaterThan(0);
    expect(TREE_REUSE_ON.decay).toBeLessThanOrEqual(1);
  });
});
