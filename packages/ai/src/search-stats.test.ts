import { describe, expect, it } from 'vitest';
import { createGame, createRng, generateLegalActions, type DeckList, type GameState } from '@jonny-boi/core';
import { actionEquivalenceKey, countEquivalentActions, createCollectingStatsSink } from './search-stats.js';
import { createMctsPilot } from './mcts.js';
import { FAST_MCTS_CONFIG } from './mcts-config.js';
import { creatureDef, giveHand, landDef, putOnBattlefield } from './test-support.js';

function deck(): DeckList {
  const cards = [];
  for (let i = 0; i < 20; i++) cards.push(landDef('Mountain', 'R'));
  for (let i = 0; i < 10; i++) cards.push(creatureDef(`Goblin${i}`, 2, 2, { cost: { R: 1 } }));
  return { cards };
}

function newGame(seed: number): GameState {
  const { state } = createGame({ seed, decks: { A: deck(), B: deck() } });
  state.step = 'precombatMain';
  state.activePlayer = 'A';
  state.priorityPlayer = 'A';
  state.stack = [];
  state.players.A.hand = [];
  state.players.B.hand = [];
  state.players.A.landsPlayedThisTurn = 0;
  return state;
}

describe('actionEquivalenceKey — collapsing what is genuinely the same', () => {
  it('gives five identical Islands ONE key (Brief A: mana equivalence)', () => {
    const state = newGame(1);
    putOnBattlefield(state, 'A', [
      landDef('Island', 'U'),
      landDef('Island', 'U'),
      landDef('Island', 'U'),
      landDef('Island', 'U'),
      landDef('Island', 'U'),
    ]);
    const taps = generateLegalActions(state).filter((a) => a.kind === 'tapForMana');
    expect(taps.length).toBe(5);
    const counted = countEquivalentActions(state, taps);
    expect(counted.offered).toBe(5);
    expect(counted.distinct).toBe(1);
    expect(counted.redundant).toBe(4);
  });

  it('does NOT merge different colours — a Forest is not an Island', () => {
    const state = newGame(2);
    putOnBattlefield(state, 'A', [landDef('Island', 'U'), landDef('Forest', 'G')]);
    const taps = generateLegalActions(state).filter((a) => a.kind === 'tapForMana');
    expect(countEquivalentActions(state, taps).distinct).toBe(2);
  });

  it('does NOT merge two sources that happen to make the same mana', () => {
    // A Bird tapped for {U} and an Island tapped for {U} leave DIFFERENT boards —
    // one of them can also block. Merging them would hide a real decision.
    const state = newGame(3);
    putOnBattlefield(state, 'A', [landDef('Island', 'U')]);
    const bird = putOnBattlefield(state, 'A', [
      { id: 'Bird', name: 'Bird', types: ['creature'], power: 0, toughness: 1, cost: { G: 1 }, produces: ['U'] },
    ]);
    expect(bird.length).toBe(1);
    const taps = generateLegalActions(state).filter((a) => a.kind === 'tapForMana');
    expect(taps.length).toBe(2);
    expect(countEquivalentActions(state, taps).distinct).toBe(2);
  });

  it('gives two copies of the same spell in hand ONE key, but two targets TWO', () => {
    const state = newGame(4);
    const bolt = { id: 'Bolt', name: 'Bolt', types: ['instant'] as const, cost: { R: 1 } };
    const [first, second] = giveHand(state, 'A', [bolt, bolt]);
    const targets = putOnBattlefield(state, 'B', [creatureDef('Bear', 2, 2), creatureDef('Ogre', 3, 3)]);
    const keyFirst = actionEquivalenceKey(state, {
      kind: 'castSpell',
      player: 'A',
      instanceId: first!.instanceId,
      targets: [targets[0]!.instanceId],
    });
    const keySecondSameTarget = actionEquivalenceKey(state, {
      kind: 'castSpell',
      player: 'A',
      instanceId: second!.instanceId,
      targets: [targets[0]!.instanceId],
    });
    const keyOtherTarget = actionEquivalenceKey(state, {
      kind: 'castSpell',
      player: 'A',
      instanceId: first!.instanceId,
      targets: [targets[1]!.instanceId],
    });
    expect(keySecondSameTarget).toBe(keyFirst);
    expect(keyOtherTarget).not.toBe(keyFirst);
  });

  it('is stable across calls — the same action always keys the same', () => {
    const state = newGame(5);
    putOnBattlefield(state, 'A', [landDef('Mountain', 'R')]);
    const tap = generateLegalActions(state).find((a) => a.kind === 'tapForMana');
    expect(tap).toBeDefined();
    expect(actionEquivalenceKey(state, tap!)).toBe(actionEquivalenceKey(state, tap!));
  });
});

describe('SearchStatsSink — the search reports its own shape', () => {
  it('an instrumented search reports branching, depth, nodes and rollout plies', () => {
    const state = newGame(9);
    putOnBattlefield(state, 'A', [landDef('Mountain', 'R'), landDef('Mountain', 'R')]);
    giveHand(state, 'A', [landDef('Mountain', 'R'), creatureDef('Goblin', 2, 2, { cost: { R: 1 } })]);
    const legal = generateLegalActions(state);

    const sink = createCollectingStatsSink();
    const pilot = createMctsPilot(FAST_MCTS_CONFIG, sink);
    pilot.chooseAction({ view: state, legalActions: legal, rng: createRng(11) });

    expect(sink.decisions.length).toBe(1);
    const stats = sink.decisions[0]!;
    expect(stats.simulations).toBe(FAST_MCTS_CONFIG.simulationsPerDecision);
    expect(stats.rootBranching).toBeGreaterThan(1);
    expect(stats.rootDistinct).toBeGreaterThan(0);
    expect(stats.rootDistinct).toBeLessThanOrEqual(stats.rootBranching);
    expect(stats.nodes).toBeGreaterThan(1);
    expect(stats.clones).toBe(stats.simulations);
    // The measurement that drove the whole Phase-4 decision: rollouts dominate.
    expect(stats.rolloutPlies).toBeGreaterThan(stats.treePlies);

    const summary = sink.summary();
    expect(summary.decisions).toBe(1);
    expect(summary.meanPliesPerSimulation).toBeGreaterThan(1);
  });

  it('instrumentation does not change what the search chooses', () => {
    const state = newGame(13);
    putOnBattlefield(state, 'A', [landDef('Mountain', 'R')]);
    giveHand(state, 'A', [landDef('Mountain', 'R'), creatureDef('Goblin', 2, 2, { cost: { R: 1 } })]);
    const legal = generateLegalActions(state);

    const plain = createMctsPilot(FAST_MCTS_CONFIG);
    const watched = createMctsPilot(FAST_MCTS_CONFIG, createCollectingStatsSink());
    expect(watched.chooseAction({ view: state, legalActions: legal, rng: createRng(77) })).toEqual(
      plain.chooseAction({ view: state, legalActions: legal, rng: createRng(77) }),
    );
  });
});
