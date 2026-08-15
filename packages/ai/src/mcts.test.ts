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
import { createMctsPilot, MCTS_PILOT_ID } from './mcts.js';
import { createRandomPilot } from './random.js';
import { createHeuristicPilot } from './heuristic.js';
import type { Pilot } from './pilot.js';
import { DEFAULT_MCTS_CONFIG, FAST_MCTS_CONFIG, type MctsConfig } from './mcts-config.js';
import {
  burnDef,
  createTestRegistry,
  creatureDef,
  giveHand,
  landDef,
  putOnBattlefield,
} from './test-support.js';

/**
 * A small aggressive deck (lands + cheap beaters + burn) good enough to start a
 * game and to make decisive short games. Tests override hand/board where they need
 * a scripted position.
 */
function aggroDeck(): DeckList {
  const cards = [];
  for (let i = 0; i < 14; i++) cards.push(landDef(`Mountain${i % 3}`, 'R'));
  for (let i = 0; i < 8; i++) cards.push(creatureDef(`Goblin${i}`, 2, 2, { cost: { R: 1 } }));
  for (let i = 0; i < 4; i++) cards.push(burnDef(`Bolt${i}`, 3, { R: 1 }));
  return { cards };
}

function newGame(seed: number): GameState {
  const { state } = createGame({ seed, decks: { A: aggroDeck(), B: aggroDeck() } });
  return state;
}

/** Put the active player (A) into their precombat main with priority + clean hand. */
function intoMainPhase(state: GameState): void {
  state.step = 'precombatMain';
  state.activePlayer = 'A';
  state.priorityPlayer = 'A';
  state.stack = [];
  state.players.A.hand = [];
  state.players.B.hand = [];
  state.players.A.landsPlayedThisTurn = 0;
}

/**
 * The shared full-fidelity effect registry for game-playing tests: it resolves the
 * `dealDamage` primitive so burn spells actually deal damage, mirroring how the sim
 * harness hands the pool's registry to pilots in production. Threaded into BOTH the
 * match loop's `applyAction` and each pilot's `DecisionContext`, so the heuristic
 * and the MCTS pilot's look-ahead rollouts both see faithful spell resolution.
 */
const TEST_REGISTRY = createTestRegistry();

/**
 * Play a full game between two pilots seated in A and B from a given seed, using
 * the same loop the sim harness uses. The effect registry is threaded into both the
 * engine's `applyAction` and the pilot context (full-fidelity, like the real sim).
 * Returns the winner (or null on a draw/cap).
 */
function playGame(
  seed: number,
  pilotA: Pilot,
  pilotB: Pilot,
  maxActions = 2000,
): PlayerId | null {
  let state = newGame(seed);
  const rngA = createRng((seed ^ 0x9e3779b9) >>> 0);
  const rngB = createRng((seed ^ 0x85ebca6b) >>> 0);
  const pilots: Record<PlayerId, Pilot> = { A: pilotA, B: pilotB };
  const rngs: Record<PlayerId, ReturnType<typeof createRng>> = { A: rngA, B: rngB };

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
    state = applyAction(state, action, undefined, TEST_REGISTRY).state;
  }
  return state.gameOver ? state.winner : null;
}

describe('mcts pilot — identity', () => {
  it('registers under the expected id', () => {
    const pilot = createMctsPilot(FAST_MCTS_CONFIG);
    expect(pilot.id).toBe(MCTS_PILOT_ID);
    expect(MCTS_PILOT_ID).toBe('mcts');
  });
});

describe('mcts pilot — determinism', () => {
  it('same seed → identical chosen action across runs', () => {
    const state = newGame(7);
    intoMainPhase(state);
    giveHand(state, 'A', [landDef('Mountain', 'R'), creatureDef('Goblin', 2, 2, { cost: { R: 1 } })]);
    const legal = generateLegalActions(state);

    const pilot = createMctsPilot(FAST_MCTS_CONFIG);
    const a = pilot.chooseAction({ view: state, legalActions: legal, rng: createRng(123) });
    const b = pilot.chooseAction({ view: state, legalActions: legal, rng: createRng(123) });
    expect(a).toEqual(b);
  });

  it('same seed → identical action sequence over a whole game', () => {
    // A tiny budget keeps this fast while still exercising a full deterministic game.
    const cfg: MctsConfig = { ...FAST_MCTS_CONFIG, simulationsPerDecision: 12, rolloutDepth: 30 };
    const mctsA = () => createMctsPilot(cfg);
    const w1 = playGame(55, mctsA(), createRandomPilot());
    const w2 = playGame(55, mctsA(), createRandomPilot());
    expect(w1).toBe(w2);
  });
});

// --- regression: no wall clock in the reproducible path ------------------------

/**
 * MCTS is the sim's DEFAULT pilot, so anything that makes it machine-dependent
 * makes the lab's verdicts machine-dependent. `maxDecisionMillis` used to default
 * to 1000 ms on the assumption that it "never trips before the count budget"; a
 * timing probe on a real position measured decisions taking 2005 ms, i.e. the cap
 * was firing routinely. A tripping clock means how many simulations a decision gets
 * depends on how fast the machine happens to be at that instant — and in the paired
 * A/B swap test the base and variant arms of the SAME seed can then receive
 * different search budgets, which destroys the common-random-numbers premise the
 * McNemar verdict rests on. The default is now `Infinity`, so `now()` is never
 * consulted; termination comes from the finite `simulationsPerDecision` /
 * `rolloutDepth` budgets, which never needed a clock.
 */
describe('mcts pilot — no wall clock in the reproducible path (regression)', () => {
  it('ships configs whose decision budget is a count, never a duration', () => {
    expect(Number.isFinite(DEFAULT_MCTS_CONFIG.maxDecisionMillis)).toBe(false);
    expect(Number.isFinite(FAST_MCTS_CONFIG.maxDecisionMillis)).toBe(false);
  });

  it('a finite cap DOES change the chosen action — which is why the sim must not set one', () => {
    // Same position, same seed, same count budget: only the clock differs. A cap
    // that truncates the search picks a different action, demonstrating that a
    // finite `maxDecisionMillis` is not the inert backstop it was assumed to be.
    // A position with an obvious winning line: lethal burn to the face. Only a
    // search that actually runs can find it.
    const state = newGame(3);
    intoMainPhase(state);
    state.players.B.life = 3;
    const [bolt] = giveHand(state, 'A', [burnDef('Bolt', 3, { R: 1 })]);
    putOnBattlefield(state, 'A', [landDef('Mountain', 'R')]);
    state.players.A.manaPool = { ...state.players.A.manaPool, R: 1 };
    const legal = generateLegalActions(state);

    const ctx = { view: state, legalActions: legal, registry: TEST_REGISTRY };
    const searched = createMctsPilot(FAST_MCTS_CONFIG).chooseAction({ ...ctx, rng: createRng(123) });
    const truncated = createMctsPilot({ ...FAST_MCTS_CONFIG, maxDecisionMillis: 0 }).chooseAction({
      ...ctx,
      rng: createRng(123),
    });

    expect(searched.kind).toBe('castSpell');
    if (searched.kind === 'castSpell') expect(searched.instanceId).toBe(bolt!.instanceId);
    // The clock-truncated search returns 0 simulations' worth of knowledge and
    // falls back to a pass — the same seed, a different action.
    expect(truncated.kind).toBe('passPriority');
  });
});

describe('mcts pilot — strength sanity (scripted decisive position)', () => {
  it('takes the lethal burn line when it can win this turn', () => {
    const state = newGame(3);
    intoMainPhase(state);
    state.players.B.life = 3;
    // A has a Bolt (3 dmg) and the mana floating to cast it → lethal is available.
    const [bolt] = giveHand(state, 'A', [burnDef('Bolt', 3, { R: 1 })]);
    putOnBattlefield(state, 'A', [landDef('Mountain', 'R')]); // untapped mana source
    // Give A the floating mana so the cast is directly legal this decision.
    state.players.A.manaPool = { ...state.players.A.manaPool, R: 1 };

    const legal = generateLegalActions(state);
    const pilot = createMctsPilot(DEFAULT_MCTS_CONFIG);
    const action = pilot.chooseAction({ view: state, legalActions: legal, rng: createRng(1) });
    // The winning line is to cast the bolt at the opponent's face.
    expect(action.kind).toBe('castSpell');
    if (action.kind === 'castSpell') {
      expect(action.instanceId).toBe(bolt!.instanceId);
    }
  });

  it('attacks for lethal when an unblocked attacker wins the game', () => {
    const state = newGame(4);
    state.step = 'declareAttackers';
    state.activePlayer = 'A';
    state.priorityPlayer = 'A';
    state.combat = { attackers: [], blocks: {}, attackersDeclared: false, blockersDeclared: false };
    state.players.A.hand = [];
    state.players.B.hand = [];
    state.players.B.life = 4;
    const [beater] = putOnBattlefield(state, 'A', [creatureDef('Beater', 5, 5)]); // opponent has no blockers

    const legal = generateLegalActions(state);
    const pilot = createMctsPilot(DEFAULT_MCTS_CONFIG);
    const action = pilot.chooseAction({ view: state, legalActions: legal, rng: createRng(2) });
    expect(action.kind).toBe('declareAttackers');
    if (action.kind === 'declareAttackers') {
      expect(action.attackers).toContain(beater!.instanceId);
    }
  });
});

describe('mcts pilot — robustness', () => {
  it('passes cleanly when only pass is available', () => {
    const state = newGame(9);
    const pass: GameAction = { kind: 'passPriority', player: state.priorityPlayer };
    const pilot = createMctsPilot(FAST_MCTS_CONFIG);
    const action = pilot.chooseAction({ view: state, legalActions: [pass], rng: createRng(1) });
    expect(action).toEqual(pass);
  });

  it('passes cleanly when no actions are offered', () => {
    const state = newGame(9);
    const pilot = createMctsPilot(FAST_MCTS_CONFIG);
    const action = pilot.chooseAction({ view: state, legalActions: [], rng: createRng(1) });
    expect(action).toEqual({ kind: 'passPriority', player: state.priorityPlayer });
  });

  it('only ever returns a legal action across many real states', () => {
    const pilot = createMctsPilot(FAST_MCTS_CONFIG);
    const rng = createRng(777);
    let state = newGame(42);
    for (let i = 0; i < 120 && !state.gameOver; i++) {
      const legal = generateLegalActions(state);
      const action = pilot.chooseAction({ view: state, legalActions: legal, rng });
      // For composite combat actions the pilot may narrow the set, but for the
      // simple action kinds it must return something the generator offered; either
      // way the engine must accept it without rejecting.
      const before = state;
      const result = applyAction(before, action);
      const rejected = result.events.some((e) => e.type === 'actionRejected');
      expect(rejected).toBe(false);
      state = result.state;
    }
  });

  it('works with an empty registry (fallback rollouts) without throwing', () => {
    const pilot = createMctsPilot(FAST_MCTS_CONFIG);
    const state = newGame(11);
    const legal = generateLegalActions(state);
    expect(() => pilot.chooseAction({ view: state, legalActions: legal, rng: createRng(5) })).not.toThrow();
  });
});

/**
 * A deliberately tiny search budget for the game-playing strength tests: just
 * enough sims/depth that MCTS clearly out-plays random, while keeping the WHOLE
 * file well under ~15s. MCTS strength scales with `simulationsPerDecision`, so the
 * production `DEFAULT_MCTS_CONFIG` (160 sims) plays markedly stronger than this
 * test budget — these tests prove the pilot *works and beats random*, not that the
 * small-budget pilot matches a full-budget one.
 */
const STRENGTH_TEST_CONFIG: MctsConfig = Object.freeze({
  ...FAST_MCTS_CONFIG,
  simulationsPerDecision: 16,
  rolloutDepth: 30,
});

/** Run a seeded mini-tournament of one pilot vs another; return mcts's win-rate. */
function winRateVs(
  makeOpponent: () => Pilot,
  firstSeed: number,
  games: number,
): { winRate: number; decided: number; wins: number } {
  let mctsWins = 0;
  let decided = 0;
  for (let seed = firstSeed; seed < firstSeed + games; seed++) {
    // Alternate seats so neither pilot keeps the on-the-play edge every game.
    const mctsSeat: PlayerId = seed % 2 === 0 ? 'A' : 'B';
    const mcts = createMctsPilot(STRENGTH_TEST_CONFIG);
    const opponent = makeOpponent();
    const winner =
      mctsSeat === 'A' ? playGame(seed, mcts, opponent) : playGame(seed, opponent, mcts);
    if (winner === null) continue; // ignore draws/timeouts in the rate
    decided++;
    if (winner === mctsSeat) mctsWins++;
  }
  return { winRate: decided > 0 ? mctsWins / decided : 0, decided, wins: mctsWins };
}

/**
 * PLAY-QUALITY guard, and the reason `MctsConfig.evalWastedManaPenalty` exists.
 *
 * MCTS was made the default pilot once and reverted because it tapped mana it
 * then never spent — 1.76 such events per turn against the heuristic's 0.01. The
 * cause was structural, not a bug: mana pools empty at the end of every step, so
 * floating mana is lost, and the search's evaluation (life + board) could not see
 * that. The tree valued "tap" through rollouts in which the *heuristic* rollout
 * policy went on to spend the mana, while the real next mover — another MCTS
 * search, for which the tapped mana is already sunk — declined to.
 *
 * `manaPoolEmptied` is the engine's own signal for it, so this measures the play
 * rather than the pilot's reasoning: it would hold for any pilot.
 */
describe('mcts pilot — does not tap mana it never spends', () => {
  /**
   * Wasted-mana budget for a whole self-played game, per turn. Not zero: holding
   * up an instant that never gets cast is legitimate play. This mirrors the sim's
   * `pilot-quality.test.ts` budget for the default pilot, so a change that would
   * disqualify MCTS from ever being the default fails HERE, in its own package,
   * instead of being discovered downstream.
   */
  const MAX_WASTED_MANA_PER_TURN = 0.35;
  const WASTE_SEEDS: readonly number[] = [3, 11, 29];
  /**
   * Half the shipped simulation budget, at the shipped rollout depth. Mana
   * discipline is search QUALITY, so it scales with the budget: measured on this
   * fixture the same pilot wastes 0.51/turn at the 40-sim `FAST_MCTS_CONFIG`,
   * and clears the bar from 80 sims up (the shipped default is 160, which also
   * clears it but costs ~18 s of suite time instead of ~9 s). The number to hold
   * this pilot to in production is the one the bench measures over the real card
   * pool — 0.22/turn against the heuristic's 0.00 — and this is the cheapest
   * in-suite budget that guards the same property.
   */
  const WASTE_TEST_CONFIG: MctsConfig = {
    ...DEFAULT_MCTS_CONFIG,
    simulationsPerDecision: DEFAULT_MCTS_CONFIG.simulationsPerDecision / 2,
  };

  /** Play a self-play game, counting the engine's wasted-mana events. */
  function wasteRate(config: MctsConfig): { perTurn: number; wasted: number; turns: number } {
    const pilot = createMctsPilot(config);
    let wasted = 0;
    let turns = 0;
    for (const seed of WASTE_SEEDS) {
      let state = newGame(seed);
      const rngs: Record<PlayerId, ReturnType<typeof createRng>> = {
        A: createRng((seed ^ 0x9e3779b9) >>> 0),
        B: createRng((seed ^ 0x85ebca6b) >>> 0),
      };
      for (let i = 0; i < 600 && !state.gameOver && state.turnNumber <= 12; i++) {
        const legal = generateLegalActions(state);
        if (legal.length === 0) break;
        const seat = state.priorityPlayer;
        const action = pilot.chooseAction({
          view: state,
          legalActions: legal,
          rng: rngs[seat]!,
          registry: TEST_REGISTRY,
        });
        const result = applyAction(state, action, undefined, TEST_REGISTRY);
        for (const event of result.events) if (event.type === 'manaPoolEmptied') wasted++;
        state = result.state;
      }
      turns += state.turnNumber;
    }
    return { perTurn: wasted / Math.max(turns, 1), wasted, turns };
  }

  it('stays within the wasted-mana budget the default pilot has to meet', () => {
    const { perTurn, wasted, turns } = wasteRate(WASTE_TEST_CONFIG);
    expect(
      perTurn,
      `${wasted} wasted-mana events over ${turns} turns (${perTurn.toFixed(2)}/turn). ` +
        'A pilot that taps sources it never spends plays visibly badly and skews every A/B verdict.',
    ).toBeLessThan(MAX_WASTED_MANA_PER_TURN);
  });

  it('THE REGRESSION: waste-blind evaluation is measurably worse', () => {
    // Pins the *cause*, not just the symptom. With the penalty switched off the
    // search goes back to being unable to see wasted mana, and wastes strictly
    // more of it — so nobody can quietly zero the knob and keep a green suite.
    // Run at the cheap budget: the effect is largest where the search is
    // noisiest, and this comparison needs two games, not one.
    const withPenalty = wasteRate(FAST_MCTS_CONFIG);
    const blind = wasteRate({ ...FAST_MCTS_CONFIG, evalWastedManaPenalty: 0 });
    expect(blind.wasted).toBeGreaterThan(withPenalty.wasted);
  });
});

describe('mcts pilot — strength vs the other pilots (full-fidelity rollouts)', () => {
  it('beats random clearly over seeded short games', () => {
    // The guaranteed value bar: with the effect registry wired through, MCTS's
    // engine look-ahead crushes uniform-random play. Keep this a solid, non-flaky
    // floor at a tiny budget — strength only grows with more sims.
    const beatsRandomFloor = 0.7; // NAMED: assert mcts win-rate ≥ 70% vs random
    const { winRate, decided } = winRateVs(() => createRandomPilot(), 0, 12);
    expect(decided).toBeGreaterThan(0);
    expect(winRate).toBeGreaterThanOrEqual(beatsRandomFloor);
  });

  it('is not dominated by the heuristic pilot', () => {
    // Honest bound: at this *tiny* test budget (16 sims) the hand-tuned heuristic is
    // a strong opponent, so we assert only that MCTS is *not dominated* — it wins a
    // meaningful share of decided games (measured ~1/3 here, well above the floor).
    // MCTS strength scales with `simulationsPerDecision`, so the production
    // `DEFAULT_MCTS_CONFIG` (160 sims) plays stronger than this budget; but measuring
    // a production-budget tournament here would blow the suite's time budget. We do
    // NOT overclaim parity at 16 sims — only the deterministic, non-flaky floor below,
    // which holds with the full-fidelity (registry-wired) rollouts these tests use.
    const competitiveFloor = 0.25; // NAMED: not dominated — wins a meaningful share
    const { winRate, decided } = winRateVs(() => createHeuristicPilot(), 100, 10);
    expect(decided).toBeGreaterThan(0);
    expect(winRate).toBeGreaterThanOrEqual(competitiveFloor);
  });
});
