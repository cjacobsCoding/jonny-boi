import { describe, expect, it } from 'vitest';
import { createGame, generateLegalActions, type DeckList, type GameState } from '@jonny-boi/core';
import {
  createHeuristicEvaluator,
  DEFAULT_EVALUATION_WEIGHTS,
  evaluatePosition,
} from './evaluator.js';
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
    });
    expect(flat).toBeCloseTo(0.5, 10);
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
