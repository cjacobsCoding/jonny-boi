/**
 * THE PILOT PLAYS POISON (§3.105) — the two lethal clocks in the heuristic's
 * own decisions, driven through `chooseAction` on real engine states, plus the
 * pure arithmetic in `poison-pressure.ts`.
 *
 * What is pinned, and the mistake each pin prevents:
 *  - an unblocked infect attacker that would give the TENTH counter is lethal
 *    and gets swung, even though its power is nowhere near the life total;
 *  - the mirror: a defender at nine poison chump-blocks a 1/1 infect attacker
 *    it would otherwise ignore, because THAT is the lethal one;
 *  - among two attackers of equal power, the infect one is blocked first at a
 *    healthy life total — it is the bigger clock;
 *  - the pure functions: infect is poison and never life, toxic rides on top,
 *    and lethal is never claimed from the blended number.
 */

import { describe, expect, it } from 'vitest';
import {
  addPoisonCounters,
  createGame,
  createRng,
  generateLegalActions,
  POISON_LOSS_THRESHOLD,
  type CardInstance,
  type DeckList,
  type GameAction,
  type GameState,
} from '@jonny-boi/core';
import { createHeuristicPilot } from './heuristic.js';
import { creatureDef, landDef, putOnBattlefield } from './test-support.js';
import { boardIndex } from './board-stats.js';
import { attackPressure, attackerPressure, lifeEquivalent, pressureIsLethal } from './poison-pressure.js';
import { DEFAULT_HEURISTIC_WEIGHTS } from './weights.js';

function stubDeck(): DeckList {
  return { cards: Array.from({ length: 30 }, (_, i) => landDef(`L${i}`, 'R')) };
}

function freshGame(seed = 1): GameState {
  const { state } = createGame({ seed, decks: { A: stubDeck(), B: stubDeck() } });
  return state;
}

function intoDeclareAttackers(state: GameState): void {
  state.step = 'declareAttackers';
  state.activePlayer = 'A';
  state.priorityPlayer = 'A';
  state.combat = { attackers: [], blocks: {}, attackersDeclared: false, blockersDeclared: false };
}

function intoDeclareBlockers(state: GameState, attackers: CardInstance[]): void {
  state.step = 'declareBlockers';
  state.activePlayer = 'A';
  state.priorityPlayer = 'B';
  state.combat = {
    attackers: attackers.map((a) => a.instanceId),
    blocks: {},
    attackersDeclared: true,
    blockersDeclared: false,
  };
}

const pilot = createHeuristicPilot();
const rng = () => createRng(99);

function choose(state: GameState): GameAction {
  return pilot.chooseAction({ view: state, legalActions: generateLegalActions(state), rng: rng() });
}

const INFECT = { infect: true } as const;

describe('lethal pressure — the pure arithmetic', () => {
  it('an infect attacker is poison and never life; toxic rides on top of damage', () => {
    const state = freshGame();
    const [elf, rex, bear] = putOnBattlefield(state, 'A', [
      creatureDef('Glistener Elf', 1, 1, { keywords: INFECT }),
      creatureDef('Tyrranax Atrocity', 4, 4, { keywords: { toxic: 3 } }),
      creatureDef('Bear', 2, 2),
    ]);
    const index = boardIndex(state);
    expect(attackerPressure(elf!, 1, index)).toEqual({ damage: 0, poison: 1 });
    expect(attackerPressure(rex!, 4, index)).toEqual({ damage: 4, poison: 3 });
    expect(attackerPressure(bear!, 2, index)).toEqual({ damage: 2, poison: 0 });
    expect(attackPressure(state, [elf!.instanceId, rex!.instanceId, bear!.instanceId], 'B', index)).toEqual({
      damage: 6,
      poison: 4,
    });
  });

  it('lethal is asked of each clock alone — never of the blend', () => {
    const state = freshGame();
    state.players.B.life = 4;
    addPoisonCounters(state, 'B', POISON_LOSS_THRESHOLD - 2, () => {});
    // 3 damage and 1 poison: neither clock finishes, though the blend (3 + 2) ≥ 4.
    const mixed = { damage: 3, poison: 1 };
    expect(lifeEquivalent(mixed, DEFAULT_HEURISTIC_WEIGHTS)).toBeGreaterThanOrEqual(4);
    expect(pressureIsLethal(state, 'B', mixed)).toBe(false);
    expect(pressureIsLethal(state, 'B', { damage: 4, poison: 0 })).toBe(true);
    expect(pressureIsLethal(state, 'B', { damage: 0, poison: 2 })).toBe(true);
  });
});

describe('heuristic pilot — attacking on the poison clock', () => {
  /**
   * Two infect 1/1s into ONE 2/2 blocker at a full life total. On damage terms
   * this is a bad attack — whichever elf is blocked dies for nothing. At nine
   * poison it is LETHAL: the blocker stops one elf, the other gives the tenth
   * counter, so the alpha-strike rule sends both. The two boards differ only
   * in the poison count, which is the whole point.
   */
  function twoElvesIntoABear(poison: number): { action: GameAction; elves: CardInstance[] } {
    const state = freshGame();
    const elves = putOnBattlefield(state, 'A', [
      creatureDef('Glistener Elf', 1, 1, { keywords: INFECT }),
      creatureDef('Blight Mamba', 1, 1, { keywords: INFECT }),
    ]);
    putOnBattlefield(state, 'B', [creatureDef('Bear', 2, 2)]);
    if (poison > 0) addPoisonCounters(state, 'B', poison, () => {});
    intoDeclareAttackers(state);
    return { action: choose(state), elves };
  }

  it('sends both infect 1/1s into a 2/2 for the tenth counter at a full life total', () => {
    const { action, elves } = twoElvesIntoABear(POISON_LOSS_THRESHOLD - 1);
    expect(action.kind).toBe('declareAttackers');
    if (action.kind === 'declareAttackers') {
      expect(action.attackers).toContain(elves[0]!.instanceId);
      expect(action.attackers).toContain(elves[1]!.instanceId);
    }
  });

  it('the same two elves with NO poison on the other side do not throw themselves at the 2/2', () => {
    const { action, elves } = twoElvesIntoABear(0);
    if (action.kind === 'declareAttackers') {
      expect(action.attackers).not.toEqual(expect.arrayContaining([elves[0]!.instanceId, elves[1]!.instanceId]));
    }
  });
});

describe('heuristic pilot — blocking on the poison clock', () => {
  it('at nine poison, chump-blocks a 3/3 infect attacker it would let through at zero', () => {
    const desperate = freshGame();
    const attackers = putOnBattlefield(desperate, 'A', [creatureDef('Plague Stinger', 3, 3, { keywords: INFECT })]);
    const [chump] = putOnBattlefield(desperate, 'B', [creatureDef('Chump', 1, 1)]);
    addPoisonCounters(desperate, 'B', POISON_LOSS_THRESHOLD - 1, () => {});
    intoDeclareBlockers(desperate, attackers);
    const action = choose(desperate);
    expect(action.kind).toBe('declareBlockers');
    if (action.kind === 'declareBlockers') {
      expect(action.blocks).toContainEqual({ blocker: chump!.instanceId, attacker: attackers[0]!.instanceId });
    }

    const healthy = freshGame();
    const healthyAttackers = putOnBattlefield(healthy, 'A', [
      creatureDef('Plague Stinger', 3, 3, { keywords: INFECT }),
    ]);
    const [healthyChump] = putOnBattlefield(healthy, 'B', [creatureDef('Chump', 1, 1)]);
    intoDeclareBlockers(healthy, healthyAttackers);
    const healthyAction = choose(healthy);
    if (healthyAction.kind === 'declareBlockers') {
      expect(healthyAction.blocks).not.toContainEqual({
        blocker: healthyChump!.instanceId,
        attacker: healthyAttackers[0]!.instanceId,
      });
    }
  });

  it('with one blocker and two equal attackers, the infect one is blocked first', () => {
    const state = freshGame();
    const [infect, vanilla] = putOnBattlefield(state, 'A', [
      creatureDef('Scourge Servant', 3, 3, { keywords: INFECT }),
      creatureDef('Vanilla', 3, 3),
    ]);
    const [wall] = putOnBattlefield(state, 'B', [creatureDef('Wall', 0, 6)]);
    intoDeclareBlockers(state, [infect!, vanilla!]);
    const action = choose(state);
    expect(action.kind).toBe('declareBlockers');
    if (action.kind === 'declareBlockers') {
      expect(action.blocks).toContainEqual({ blocker: wall!.instanceId, attacker: infect!.instanceId });
    }
  });
});
