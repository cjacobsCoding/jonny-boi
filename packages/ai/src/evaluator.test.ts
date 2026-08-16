import { describe, expect, it } from 'vitest';
import { createGame, generateLegalActions, type DeckList, type GameState } from '@jonny-boi/core';
import {
  createHeuristicEvaluator,
  DEFAULT_EVALUATION_WEIGHTS,
  evaluatePosition,
  TACTICAL_EVALUATION_WEIGHTS,
} from './evaluator.js';
import { DEFAULT_HYBRID_CONFIG, TACTICAL_HYBRID_CONFIG } from './hybrid-config.js';
import { creatureDef, giveHand, landDef, putOnBattlefield } from './test-support.js';

function deck(): DeckList {
  const cards = [];
  for (let i = 0; i < 20; i++) cards.push(landDef('Mountain', 'R'));
  for (let i = 0; i < 10; i++) cards.push(creatureDef(`Goblin${i}`, 2, 2, { cost: { R: 1 } }));
  return { cards };
}

/** A settled, symmetric mid-game position: both seats identical in every term. */
function evenPosition(seed = 1): GameState {
  const { state } = createGame({ seed, decks: { A: deck(), B: deck() } });
  state.step = 'precombatMain';
  state.activePlayer = 'A';
  state.priorityPlayer = 'A';
  state.stack = [];
  state.battlefield = [];
  state.players.A.hand = [];
  state.players.B.hand = [];
  state.players.A.landsPlayedThisTurn = 0;
  return state;
}

describe('evaluateState — the leaf evaluator', () => {
  it('scores a perfectly symmetric position at exactly even', () => {
    const state = evenPosition();
    expect(evaluatePosition(state, 'A')).toBeCloseTo(0.5, 10);
    expect(evaluatePosition(state, 'B')).toBeCloseTo(0.5, 10);
  });

  it('is zero-sum: what is good for me is exactly as bad for them', () => {
    const state = evenPosition(2);
    state.players.A.life = 18;
    state.players.B.life = 7;
    putOnBattlefield(state, 'A', [creatureDef('Ogre', 3, 3)]);
    giveHand(state, 'A', [creatureDef('Bear', 2, 2)]);
    expect(evaluatePosition(state, 'A') + evaluatePosition(state, 'B')).toBeCloseTo(1, 10);
  });

  it('reports a decided game as won / lost, not as a position', () => {
    const state = evenPosition(3);
    state.gameOver = true;
    state.winner = 'A';
    expect(evaluatePosition(state, 'A')).toBe(DEFAULT_EVALUATION_WEIGHTS.winScore);
    expect(evaluatePosition(state, 'B')).toBe(DEFAULT_EVALUATION_WEIGHTS.lossScore);
    state.winner = null;
    expect(evaluatePosition(state, 'A')).toBe(DEFAULT_EVALUATION_WEIGHTS.drawScore);
  });

  /**
   * The three regression tests that matter, because they are exactly the blind
   * spots the vanilla pilot's "life differential + board presence" evaluation has.
   * Brief §9 is explicit: "Do NOT reduce MTG to life total + card count."
   */
  it('sees CARD ADVANTAGE, which life-and-board cannot', () => {
    const state = evenPosition(4);
    giveHand(state, 'A', [creatureDef('Bear', 2, 2), creatureDef('Bear', 2, 2), creatureDef('Bear', 2, 2)]);
    expect(evaluatePosition(state, 'A')).toBeGreaterThan(0.5);
  });

  it('sees MANA DEVELOPMENT — a screwed opponent is behind even at equal life', () => {
    const state = evenPosition(5);
    putOnBattlefield(state, 'A', [landDef('Mountain', 'R'), landDef('Mountain', 'R'), landDef('Mountain', 'R')]);
    putOnBattlefield(state, 'B', [landDef('Mountain', 'R')]);
    expect(evaluatePosition(state, 'A')).toBeGreaterThan(0.5);
  });

  it('sees a LETHAL BOARD — an attack that ends the game next combat', () => {
    const lethal = evenPosition(6);
    lethal.players.B.life = 4;
    putOnBattlefield(lethal, 'A', [creatureDef('Ogre', 5, 5)]);

    const notLethal = evenPosition(6);
    notLethal.players.B.life = 20;
    putOnBattlefield(notLethal, 'A', [creatureDef('Ogre', 5, 5)]);

    // Life alone already favours the first position; the point is the lethal
    // bonus makes it favoured by MORE than the raw life difference would.
    const lifeOnly = evaluatePosition(lethal, 'A', { ...DEFAULT_EVALUATION_WEIGHTS, lethalThreatWeight: 0 });
    expect(evaluatePosition(lethal, 'A')).toBeGreaterThan(lifeOnly);
    expect(evaluatePosition(notLethal, 'A')).toBeLessThan(evaluatePosition(lethal, 'A'));
  });

  it('does NOT count a summoning-sick creature as a lethal threat', () => {
    const state = evenPosition(7);
    state.players.B.life = 4;
    const [sick] = putOnBattlefield(state, 'A', [creatureDef('Ogre', 5, 5)]);
    sick!.summoningSick = true;
    const withoutBonus = evaluatePosition(state, 'A', { ...DEFAULT_EVALUATION_WEIGHTS, lethalThreatWeight: 0 });
    expect(evaluatePosition(state, 'A')).toBeCloseTo(withoutBonus, 10);
  });

  it('stays inside [0,1] at absurd extremes so the search reward scale holds', () => {
    const state = evenPosition(8);
    state.players.A.life = 10_000;
    state.players.B.life = -10_000;
    const score = evaluatePosition(state, 'A');
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThanOrEqual(1);
  });

  it('every weight is tunable — zeroing the blend flattens the score to even', () => {
    const state = evenPosition(9);
    state.players.A.life = 20;
    state.players.B.life = 1;
    putOnBattlefield(state, 'A', [creatureDef('Ogre', 9, 9)]);
    const flat = evaluatePosition(state, 'A', {
      ...DEFAULT_EVALUATION_WEIGHTS,
      lifeWeight: 0,
      boardWeight: 0,
      cardAdvantageWeight: 0,
      manaDevelopmentWeight: 0,
      untappedManaWeight: 0,
      creatureCountWeight: 0,
      lethalThreatWeight: 0,
      // The tactical terms are weights like any other and must zero out too. The
      // lethal READ still has to be switched off explicitly: it is selected by a
      // boolean, and its weight is already zero above, so this line is about the
      // solver not being consulted at all rather than about the score.
      facingLethalWeight: 0,
      pressureWeight: 0,
      clockWeight: 0,
      useTacticalLethal: false,
    });
    expect(flat).toBeCloseTo(0.5, 10);
  });

  /**
   * ⚠️ THE SHIPPED DEFAULT KEEPS THE TACTICAL SOLVER OFF, AND THAT IS A MEASURED
   * DECISION — the same shape as `DEFAULT_HYBRID_CONFIG.reuse` (DESIGN §3.4b/d).
   *
   * The tactical blend is the more CORRECT evaluator by a wide margin (5/5 against
   * 0/5 on the curated ordering suite; two of the default's answers are backwards,
   * not merely blind) and it is free or slightly cheaper. It is also, on every
   * strength measurement taken, a wash:
   *
   *   Mono-Red vs Boros,       n=120, vs heuristic:  60.0% -> 60.0%
   *   UW Control vs Golgari,   n=80,  vs heuristic:  53.8% -> 55.0%
   *   head to head, aggro,     n=120:                48.3% [39.6, 57.2]
   *   per-term ablation, aggro, n=120: EVERY arm 72/120, identical to the control
   *
   * So the brief's rule decides it: a change that does not measurably help does not
   * become the default. Flipping it needs a fresh measurement, not an opinion —
   * this test is here so the flip cannot happen quietly.
   */
  it('the shipped default keeps the tactical terms OFF — measured, not accidental', () => {
    expect(DEFAULT_EVALUATION_WEIGHTS.useTacticalLethal).toBe(false);
    expect(DEFAULT_EVALUATION_WEIGHTS.facingLethalWeight).toBe(0);
    expect(DEFAULT_EVALUATION_WEIGHTS.pressureWeight).toBe(0);
    expect(DEFAULT_EVALUATION_WEIGHTS.clockWeight).toBe(0);
    expect(DEFAULT_HYBRID_CONFIG.takeProvenLethal).toBe(false);
    // ...and the alternative really is different, so "off" is a choice between two
    // live options rather than a description of the only one that exists.
    expect(TACTICAL_EVALUATION_WEIGHTS.useTacticalLethal).toBe(true);
    expect(TACTICAL_HYBRID_CONFIG.takeProvenLethal).toBe(true);
  });

  it('with the tactical terms off, the solver is never consulted at all', () => {
    // The cost half of "ships off": a default that still paid for a feature it had
    // switched off would be a rule-7 regression for nothing. Proven by behaviour —
    // a board whose ONLY difference is one the solver can see and the old read
    // cannot must score identically under the default.
    const build = (wallIsTapped: boolean): GameState => {
      const state = evenPosition(11);
      putOnBattlefield(state, 'A', [creatureDef('Ogre', 3, 3)]);
      const [wall] = putOnBattlefield(state, 'B', [creatureDef('Wall', 0, 4)]);
      wall!.tapped = wallIsTapped;
      return state;
    };
    const walled = build(false);
    const open = build(true);

    // A Wall taps for no mana, so no positional term the default reads can see the
    // difference and the scores must match exactly; under the tactical blend the
    // tapped wall stops blocking and the pressure/clock terms separate them.
    expect(evaluatePosition(walled, 'A')).toBe(evaluatePosition(open, 'A'));
    expect(evaluatePosition(walled, 'A', TACTICAL_EVALUATION_WEIGHTS)).not.toBe(
      evaluatePosition(open, 'A', TACTICAL_EVALUATION_WEIGHTS),
    );
  });
});

describe('evaluatePolicy — the prior seam', () => {
  it('offers scored candidates, always including the option to do nothing', () => {
    const state = evenPosition(10);
    putOnBattlefield(state, 'A', [landDef('Mountain', 'R')]);
    giveHand(state, 'A', [landDef('Mountain', 'R'), creatureDef('Goblin', 2, 2, { cost: { R: 1 } })]);
    const evaluator = createHeuristicEvaluator();
    const candidates = evaluator.evaluatePolicy(state, generateLegalActions(state));
    expect(candidates.length).toBeGreaterThan(1);
    expect(candidates.every((c) => c.plies.length > 0)).toBe(true);
    expect(candidates.some((c) => c.plies[0]!.kind === 'passPriority')).toBe(true);
  });

  it('is a stable, swappable seam — id names which evaluator produced the numbers', () => {
    expect(createHeuristicEvaluator().id).toBe('heuristic-eval');
  });
});
