import { describe, expect, it } from 'vitest';
import {
  applyAction,
  createGame,
  createRng,
  generateLegalActions,
  type DeckList,
  type GameAction,
  type GameState,
  type PlayerId,
} from '@jonny-boi/core';
import { createHybridPilot, HYBRID_PILOT_ID } from './hybrid.js';
import { DEFAULT_HYBRID_CONFIG, FAST_HYBRID_CONFIG, PLAY_HYBRID_CONFIG } from './hybrid-config.js';
import { createHeuristicPilot, policyCandidates } from './heuristic.js';
import { createRandomPilot } from './random.js';
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

function intoMainPhase(state: GameState): void {
  state.step = 'precombatMain';
  state.activePlayer = 'A';
  state.priorityPlayer = 'A';
  state.stack = [];
  state.players.A.hand = [];
  state.players.B.hand = [];
  state.players.A.landsPlayedThisTurn = 0;
}

/** Play a full game between two pilots, exactly as the sim harness does. */
function playGame(seed: number, pilotA: Pilot, pilotB: Pilot, maxActions = 3000) {
  let state = newGame(seed);
  const pilots: Record<PlayerId, Pilot> = { A: pilotA, B: pilotB };
  const rngs: Record<PlayerId, ReturnType<typeof createRng>> = {
    A: createRng((seed ^ 0x9e3779b9) >>> 0),
    B: createRng((seed ^ 0x85ebca6b) >>> 0),
  };
  const events: { type: string }[] = [];
  let actions = 0;
  for (; actions < maxActions && !state.gameOver && state.turnNumber <= 30; actions++) {
    const legal = generateLegalActions(state);
    if (legal.length === 0) break;
    const seat = state.priorityPlayer;
    const action = pilots[seat]!.chooseAction({
      view: state,
      legalActions: legal,
      rng: rngs[seat]!,
      registry: TEST_REGISTRY,
    });
    const applied = applyAction(state, action, undefined, TEST_REGISTRY);
    state = applied.state;
    for (const event of applied.events) events.push(event as { type: string });
  }
  return { winner: state.gameOver ? state.winner : null, turns: state.turnNumber, events, actions };
}

describe('hybrid pilot — identity and configuration', () => {
  it('registers under the expected id', () => {
    expect(createHybridPilot(FAST_HYBRID_CONFIG).id).toBe(HYBRID_PILOT_ID);
    expect(HYBRID_PILOT_ID).toBe('hybrid');
  });

  /**
   * ⚠️ THE BUDGET TRAP, pinned by a test. `MctsConfig.maxDecisionMillis` cost this
   * project a long debug: a wall-clock budget makes the search machine-dependent,
   * so the base and variant arms of the Lab's paired A/B swap can receive DIFFERENT
   * search budgets on the same seed, destroying the common-random-numbers premise
   * the whole verdict rests on. The hybrid keeps the two policies as separate,
   * explicitly-named budget kinds; the SHIPPED default must stay the deterministic
   * one, and only the interactive config may reach for the clock.
   */
  it('ships a DETERMINISTIC budget; only the interactive config is time-based', () => {
    expect(DEFAULT_HYBRID_CONFIG.budget.kind).toBe('simulations');
    expect(FAST_HYBRID_CONFIG.budget.kind).toBe('simulations');
    expect(PLAY_HYBRID_CONFIG.budget.kind).toBe('millis');
  });

  it('never permanently eliminates an option — every prior has a floor', () => {
    expect(DEFAULT_HYBRID_CONFIG.minPriorFraction).toBeGreaterThan(0);
  });
});

describe('hybrid pilot — determinism (the Lab depends on it)', () => {
  it('same seed → identical chosen action', () => {
    const state = newGame(7);
    intoMainPhase(state);
    putOnBattlefield(state, 'A', [landDef('Mountain', 'R')]);
    giveHand(state, 'A', [landDef('Mountain', 'R'), creatureDef('Goblin', 2, 2, { cost: { R: 1 } })]);
    const legal = generateLegalActions(state);
    const a = createHybridPilot(FAST_HYBRID_CONFIG).chooseAction({ view: state, legalActions: legal, rng: createRng(9) });
    const b = createHybridPilot(FAST_HYBRID_CONFIG).chooseAction({ view: state, legalActions: legal, rng: createRng(9) });
    expect(a).toEqual(b);
  });

  it('same seed → identical whole game', () => {
    const first = playGame(41, createHybridPilot(FAST_HYBRID_CONFIG), createRandomPilot());
    const second = playGame(41, createHybridPilot(FAST_HYBRID_CONFIG), createRandomPilot());
    expect(second.winner).toBe(first.winner);
    expect(second.turns).toBe(first.turns);
    expect(second.actions).toBe(first.actions);
  });

  it('consults no clock under a simulations budget', () => {
    // If the search read the wall clock, freezing it would change the result.
    const state = newGame(17);
    intoMainPhase(state);
    putOnBattlefield(state, 'A', [landDef('Mountain', 'R'), landDef('Mountain', 'R')]);
    giveHand(state, 'A', [creatureDef('Goblin', 2, 2, { cost: { R: 1 } }), burnDef('Bolt', 3, { R: 1 })]);
    putOnBattlefield(state, 'B', [creatureDef('Bear', 2, 2)]);
    const legal = generateLegalActions(state);
    const pilot = createHybridPilot(FAST_HYBRID_CONFIG);
    const normal = pilot.chooseAction({ view: state, legalActions: legal, rng: createRng(5), registry: TEST_REGISTRY });

    const realNow = performance.now.bind(performance);
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (performance as any).now = () => 0;
      const frozen = createHybridPilot(FAST_HYBRID_CONFIG).chooseAction({
        view: state,
        legalActions: legal,
        rng: createRng(5),
        registry: TEST_REGISTRY,
      });
      expect(frozen).toEqual(normal);
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (performance as any).now = realNow;
    }
  });
});

// --- PHASE 2: the measured defect, and why it cannot recur ---------------------

describe('policyCandidates — the ATOMIC action space (Phase 2)', () => {
  /**
   * THE regression test for this whole branch. DESIGN §3.4 records the vanilla
   * pilot wasting 0.71 mana per turn because it searched "tap a land" as its own
   * action, valued it through rollouts in which the heuristic later spent the
   * mana, and then declined to spend it. The fix is structural: a naked tap is not
   * a strategic option at all, so the search has no way to express the mistake.
   */
  it('offers no naked "tap for mana" option — a tap only exists inside a funded play', () => {
    const state = newGame(21);
    intoMainPhase(state);
    putOnBattlefield(state, 'A', [landDef('Mountain', 'R'), landDef('Mountain', 'R')]);
    giveHand(state, 'A', [creatureDef('Goblin', 2, 2, { cost: { R: 1 } })]);
    const candidates = policyCandidates(state, generateLegalActions(state));
    expect(candidates.length).toBeGreaterThan(0);
    for (const candidate of candidates) {
      const last = candidate.plies[candidate.plies.length - 1]!;
      expect(last.kind).not.toBe('tapForMana');
    }
  });

  it('bundles the funding taps WITH the cast, in one candidate', () => {
    const state = newGame(22);
    intoMainPhase(state);
    putOnBattlefield(state, 'A', [landDef('Mountain', 'R'), landDef('Mountain', 'R')]);
    giveHand(state, 'A', [creatureDef('Ogre', 3, 3, { cost: { R: 1, generic: 1 } })]);
    const candidates = policyCandidates(state, generateLegalActions(state));
    const cast = candidates.find((c) => c.plies[c.plies.length - 1]!.kind === 'castSpell');
    expect(cast).toBeDefined();
    // Two mana needed, nothing floating ⇒ two taps then the cast.
    expect(cast!.plies.length).toBe(3);
    expect(cast!.plies[0]!.kind).toBe('tapForMana');
    expect(cast!.plies[1]!.kind).toBe('tapForMana');
  });

  it('offers a spell already covered by floating mana as a bare cast', () => {
    const state = newGame(23);
    intoMainPhase(state);
    state.players.A.manaPool = { ...state.players.A.manaPool, R: 1 };
    giveHand(state, 'A', [creatureDef('Goblin', 2, 2, { cost: { R: 1 } })]);
    const cast = policyCandidates(state, generateLegalActions(state)).find(
      (c) => c.plies[0]!.kind === 'castSpell',
    );
    expect(cast).toBeDefined();
    expect(cast!.plies.length).toBe(1);
  });

  it('never offers a spell this board cannot fund', () => {
    const state = newGame(24);
    intoMainPhase(state);
    putOnBattlefield(state, 'A', [landDef('Mountain', 'R')]);
    giveHand(state, 'A', [creatureDef('Dragon', 5, 5, { cost: { R: 2, generic: 4 } })]);
    const candidates = policyCandidates(state, generateLegalActions(state));
    expect(candidates.some((c) => c.plies.some((p) => p.kind === 'castSpell'))).toBe(false);
  });

  it('always offers doing nothing — holding up is a real line', () => {
    const state = newGame(25);
    intoMainPhase(state);
    putOnBattlefield(state, 'A', [landDef('Mountain', 'R')]);
    giveHand(state, 'A', [creatureDef('Goblin', 2, 2, { cost: { R: 1 } })]);
    const candidates = policyCandidates(state, generateLegalActions(state));
    expect(candidates.some((c) => c.plies[0]!.kind === 'passPriority')).toBe(true);
  });

  it('collapses two identical lands in hand into ONE land-drop option', () => {
    const state = newGame(26);
    intoMainPhase(state);
    giveHand(state, 'A', [landDef('Mountain', 'R'), landDef('Mountain', 'R'), landDef('Mountain', 'R')]);
    const lands = policyCandidates(state, generateLegalActions(state)).filter(
      (c) => c.plies[0]!.kind === 'playLand',
    );
    expect(lands.length).toBe(1);
  });
});

describe('hybrid pilot — atomic play in the real game (Phase 2)', () => {
  /**
   * Atomicity inside the tree is only half the fix: the engine still asks one
   * action at a time, so a pilot that re-searched after every tap could pick a
   * DIFFERENT play next time and strand the mana it just made. The pilot commits
   * to the macro it chose and carries it out.
   */
  it('follows a tap through to the cast it planned', () => {
    const state = newGame(31);
    intoMainPhase(state);
    putOnBattlefield(state, 'A', [landDef('Mountain', 'R'), landDef('Mountain', 'R')]);
    giveHand(state, 'A', [creatureDef('Ogre', 3, 3, { cost: { R: 1, generic: 1 } })]);

    const pilot = createHybridPilot(FAST_HYBRID_CONFIG);
    let live: GameState = state;
    const kinds: string[] = [];
    for (let i = 0; i < 4 && !live.gameOver; i++) {
      const legal = generateLegalActions(live);
      const action = pilot.chooseAction({
        view: live,
        legalActions: legal,
        rng: createRng(3),
        registry: TEST_REGISTRY,
      });
      kinds.push(action.kind);
      if (action.kind === 'castSpell') break;
      live = applyAction(live, action, undefined, TEST_REGISTRY).state;
    }
    expect(kinds).toContain('castSpell');
    // Every action before the cast was part of paying for it.
    for (const kind of kinds.slice(0, -1)) expect(kind).toBe('tapForMana');
  });

  it('wastes far less mana per turn than the vanilla search it replaces', () => {
    // `manaPoolEmptied` is the engine's own "a step ended with mana still
    // floating" signal — the exact metric that got MCTS reverted as the default
    // (1.76/turn for mcts, 0.01/turn for the heuristic; DESIGN §3.4).
    let wasted = 0;
    let turns = 0;
    for (const seed of [101, 202, 303]) {
      const pilot = createHybridPilot(FAST_HYBRID_CONFIG);
      const game = playGame(seed, pilot, createHybridPilot(FAST_HYBRID_CONFIG));
      wasted += game.events.filter((e) => e.type === 'manaPoolEmptied').length;
      turns += game.turns;
    }
    expect(wasted / turns).toBeLessThan(0.35);
  });
});

// --- PHASE 3 + 4: guided selection and leaf evaluation --------------------------

describe('hybrid pilot — search behaviour', () => {
  it('resolves a forced decision without searching at all', () => {
    const state = newGame(37);
    intoMainPhase(state);
    // Nothing in hand, nothing on board: the only strategic option is to pass.
    const sink = createCollectingStatsSink();
    const pilot = createHybridPilot(FAST_HYBRID_CONFIG, undefined, sink);
    const action = pilot.chooseAction({
      view: state,
      legalActions: generateLegalActions(state),
      rng: createRng(1),
      registry: TEST_REGISTRY,
    });
    expect(action.kind).toBe('passPriority');
    expect(sink.decisions.length).toBe(0); // no search node was ever built
  });

  /**
   * Progressive widening (brief §7) is the search's focusing mechanism: a node
   * with a handful of visits looks at two or three plays, and only earns the rest
   * as its confidence grows. Both halves are asserted, because only checking the
   * "more visits ⇒ more children" direction would also pass for a search that
   * simply expanded everything immediately.
   */
  it('widens progressively — few visits look narrowly, many visits reach everything', () => {
    const state = newGame(43);
    intoMainPhase(state);
    putOnBattlefield(state, 'A', [landDef('Mountain', 'R'), landDef('Mountain', 'R'), landDef('Mountain', 'R')]);
    putOnBattlefield(state, 'B', [creatureDef('Bear', 2, 2), creatureDef('Ogre', 3, 3)]);
    giveHand(state, 'A', [
      landDef('Mountain', 'R'),
      creatureDef('Goblin', 2, 2, { cost: { R: 1 } }),
      creatureDef('Brute', 3, 3, { cost: { R: 1, generic: 1 } }),
      burnDef('Bolt', 3, { R: 1 }),
    ]);
    const legal = generateLegalActions(state);

    const widthFor = (simulations: number) => {
      const reasons: string[] = [];
      createHybridPilot({ ...FAST_HYBRID_CONFIG, budget: { kind: 'simulations', simulations } }).chooseAction({
        view: state,
        legalActions: legal,
        rng: createRng(2),
        registry: TEST_REGISTRY,
        trace: (t) => reasons.push(t.reason),
      });
      const match = /(\d+)\/(\d+) widened/.exec(reasons.join(' '));
      return match ? { widened: Number(match[1]), total: Number(match[2]) } : { widened: 0, total: 0 };
    };

    const narrow = widthFor(4);
    const wide = widthFor(400);
    expect(narrow.total).toBeGreaterThan(3); // the position really does offer choices
    expect(narrow.widened).toBeLessThan(narrow.total);
    expect(wide.widened).toBe(wide.total);
  });

  it('finds lethal burn — the search agrees with the obvious line', () => {
    const state = newGame(47);
    intoMainPhase(state);
    state.players.B.life = 3;
    putOnBattlefield(state, 'A', [landDef('Mountain', 'R')]);
    giveHand(state, 'A', [burnDef('Bolt', 3, { R: 1 })]);

    const pilot = createHybridPilot(FAST_HYBRID_CONFIG);
    let live: GameState = state;
    for (let i = 0; i < 4 && !live.gameOver; i++) {
      const action = pilot.chooseAction({
        view: live,
        legalActions: generateLegalActions(live),
        rng: createRng(4),
        registry: TEST_REGISTRY,
      });
      live = applyAction(live, action, undefined, TEST_REGISTRY).state;
    }
    expect(live.players.B.life).toBeLessThanOrEqual(0);
  });

  it('never returns an action the engine rejects, over full games', () => {
    for (const seed of [61, 62, 63]) {
      const game = playGame(seed, createHybridPilot(FAST_HYBRID_CONFIG), createHeuristicPilot());
      expect(game.turns).toBeGreaterThan(1);
      // A pilot that returned rejected actions burns the action cap without
      // advancing the game; reaching a real result proves it did not.
      expect(game.actions).toBeLessThan(3000);
    }
  });

  it('beats the random pilot decisively', () => {
    let wins = 0;
    const games = 8;
    for (let g = 0; g < games; g++) {
      const hybrid = createHybridPilot(FAST_HYBRID_CONFIG);
      const random = createRandomPilot();
      const isA = g % 2 === 0;
      const result = playGame(700 + g, isA ? hybrid : random, isA ? random : hybrid);
      if (result.winner !== null && (result.winner === 'A') === isA) wins++;
    }
    expect(wins).toBeGreaterThanOrEqual(games - 2);
  });

  it('survives a missing effect registry (rule 6: graceful fallback)', () => {
    const state = newGame(71);
    intoMainPhase(state);
    putOnBattlefield(state, 'A', [landDef('Mountain', 'R')]);
    giveHand(state, 'A', [burnDef('Bolt', 3, { R: 1 })]);
    const action = createHybridPilot(FAST_HYBRID_CONFIG).chooseAction({
      view: state,
      legalActions: generateLegalActions(state),
      rng: createRng(6),
    });
    expect(generateLegalActions(state).length).toBeGreaterThan(0);
    expect(action).toBeDefined();
  });

  it('falls back safely when handed no legal actions at all', () => {
    const state = newGame(73);
    intoMainPhase(state);
    const action = createHybridPilot(FAST_HYBRID_CONFIG).chooseAction({
      view: state,
      legalActions: [] as readonly GameAction[],
      rng: createRng(8),
    });
    expect(action).toBeDefined();
  });
});
