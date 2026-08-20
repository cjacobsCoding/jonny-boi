/**
 * THE PILOT vs REPLACEMENT AND PREVENTION EFFECTS — the "not inert, not a lie"
 * half of the system.
 *
 * Two failures are possible here and both are silent, which is why each gets a
 * test that goes red on it specifically:
 *
 *  1. **A fog the pilot never casts is an inert card.** Prevention has no value
 *     in a main phase and the whole game's worth in front of a lethal swing, so
 *     a pilot that scores it like a generic spell either throws it away on curve
 *     or never plays it at all. Both are the card not existing.
 *  2. **A damage doubler that does not change the pilot's combat math is a
 *     lie.** The ENGINE will double the damage whatever the pilot believes; what
 *     the belief decides is whether the attack happens. A pilot that owns a
 *     Gratuitous Violence and still reads its 2/2 as dealing 2 will decline a
 *     lethal attack and block as if it were not being hit twice as hard.
 *
 * Both are asserted against the REAL heuristic and the real legal-action
 * generator, and each carries the precondition that the action was OFFERED —
 * without it, "declined" and "was never allowed" are the same observation, which
 * is this repo's recurring failure shape.
 */

import { describe, expect, it } from 'vitest';
import {
  addFloatingReplacement,
  createGame,
  createRng,
  generateLegalActions,
  type CardDefinition,
  type DeckList,
  type GameAction,
  type GameState,
} from '@jonny-boi/core';
import { createHeuristicPilot } from './heuristic.js';
import { assessAttack } from './tactical.js';
import { boardIndex } from './board-stats.js';
import { addPool, creatureDef, giveHand, landDef, putOnBattlefield } from './test-support.js';

function stubDeck(): DeckList {
  return { cards: Array.from({ length: 30 }, (_, i) => landDef(`L${i}`, 'G')) };
}

function freshGame(seed = 1): GameState {
  const { state } = createGame({ seed, decks: { A: stubDeck(), B: stubDeck() } });
  state.players.A.hand = [];
  state.players.B.hand = [];
  return state;
}

/** "Prevent all combat damage that would be dealt this turn." */
const FOG: CardDefinition = {
  id: 'pilot-fog',
  name: 'Fog',
  types: ['instant'],
  timing: 'instant',
  cost: { G: 1 },
  effects: [{ primitive: 'preventDamage', params: { combat: true } }],
};

/** "If a creature you control would deal damage …, it deals double that damage." */
const VIOLENCE: CardDefinition = {
  id: 'pilot-violence',
  name: 'Gratuitous Violence',
  types: ['enchantment'],
  cost: { generic: 2, R: 3 },
  replacements: [
    {
      event: 'damage',
      applies: { sourceController: 'you', sourceFilter: { anyOfTypes: ['creature'] } },
      outcome: { times: 2 },
    },
  ],
};

const pilot = createHeuristicPilot();

function choose(state: GameState): GameAction {
  const legalActions = generateLegalActions(state);
  return pilot.chooseAction({ view: state, legalActions, rng: createRng(4), registry: undefined as never });
}

/** Put B on the back foot: A has attacked, blockers are declared, B holds priority. */
function intoDamageWindow(state: GameState, attackers: readonly number[]): void {
  state.step = 'declareBlockers';
  state.activePlayer = 'A';
  state.priorityPlayer = 'B';
  state.stack = [];
  state.combat = { attackers: [...attackers], blocks: {}, attackersDeclared: true, blockersDeclared: true };
}

describe('a fog is cast when — and only when — it prevents something', () => {
  it('is CAST in front of a lethal attack', () => {
    const state = freshGame();
    const [ogre] = putOnBattlefield(state, 'A', [creatureDef('Ogre', 6, 6)]);
    giveHand(state, 'B', [FOG]);
    addPool(state, 'B', 'G', 1);
    state.players.B.life = 5;
    intoDamageWindow(state, [ogre!.instanceId]);

    // PRECONDITION: casting it really was on the menu. Without this the test
    // would pass on a build where the engine never offered the spell at all.
    const legal = generateLegalActions(state);
    expect(
      legal.some((a) => a.kind === 'castSpell' && a.instanceId === state.players.B.hand[0]?.instanceId),
      'the engine never offered the Fog — the test proves nothing',
    ).toBe(true);

    const chosen = choose(state);
    expect(chosen.kind).toBe('castSpell');
  });

  it('is NOT cast in a main phase with no attack to stop', () => {
    const state = freshGame();
    putOnBattlefield(state, 'A', [creatureDef('Ogre', 6, 6)]);
    giveHand(state, 'B', [FOG]);
    addPool(state, 'B', 'G', 1);
    state.players.B.life = 5;
    state.step = 'precombatMain';
    state.activePlayer = 'B';
    state.priorityPlayer = 'B';
    state.combat = null;
    state.stack = [];

    const legal = generateLegalActions(state);
    const castFog = legal.find(
      (a) => a.kind === 'castSpell' && a.instanceId === state.players.B.hand[0]?.instanceId,
    );
    expect(castFog, 'the engine never offered the Fog — the test proves nothing').toBeDefined();
    expect(choose(state).kind).not.toBe('castSpell');
  });

  it('is NOT cast against an attack that cannot hurt (a 1/1 at 20 life)', () => {
    const state = freshGame();
    const [mouse] = putOnBattlefield(state, 'A', [creatureDef('Mouse', 1, 1)]);
    giveHand(state, 'B', [FOG]);
    addPool(state, 'B', 'G', 1);
    state.players.B.life = 20;
    intoDamageWindow(state, [mouse!.instanceId]);

    const legal = generateLegalActions(state);
    expect(
      legal.some((a) => a.kind === 'castSpell' && a.instanceId === state.players.B.hand[0]?.instanceId),
    ).toBe(true);
    expect(choose(state).kind).not.toBe('castSpell');
  });

  it('is worth MORE against a DOUBLED attack than against the same printed one', () => {
    // The identical 2/2 swing at a healthy life total: two damage is not worth a
    // card, four is. The ONLY difference between the two boards is the doubler,
    // so this fails on any build where the fog's pricing reads printed power.
    const build = (withDoubler: boolean): GameState => {
      const state = freshGame();
      const [beater] = putOnBattlefield(state, 'A', [creatureDef('Beater', 2, 2)]);
      if (withDoubler) putOnBattlefield(state, 'A', [VIOLENCE]);
      giveHand(state, 'B', [FOG]);
      addPool(state, 'B', 'G', 1);
      state.players.B.life = 20;
      intoDamageWindow(state, [beater!.instanceId]);
      return state;
    };
    expect(choose(build(false)).kind).not.toBe('castSpell');
    expect(choose(build(true)).kind).toBe('castSpell');
  });
});

describe('a damage doubler really changes the pilot’s combat math', () => {
  it('makes an otherwise non-lethal attack read as lethal', () => {
    const build = (withDoubler: boolean): GameState => {
      const state = freshGame();
      putOnBattlefield(state, 'A', [creatureDef('Beater', 3, 3)]);
      if (withDoubler) putOnBattlefield(state, 'A', [VIOLENCE]);
      state.players.B.life = 5;
      state.step = 'declareAttackers';
      state.activePlayer = 'A';
      state.priorityPlayer = 'A';
      state.combat = { attackers: [], blocks: {}, attackersDeclared: false, blockersDeclared: false };
      return state;
    };

    const plain = build(false);
    const doubled = build(true);
    expect(assessAttack(plain, 'A', 'now', boardIndex(plain)).lethal).toBe(false);
    expect(assessAttack(doubled, 'A', 'now', boardIndex(doubled)).lethal).toBe(true);
    // …and the number, not just the flag: 3 printed becomes 6.
    expect(assessAttack(plain, 'A', 'now', boardIndex(plain)).maxDamage).toBe(3);
    expect(assessAttack(doubled, 'A', 'now', boardIndex(doubled)).maxDamage).toBe(6);
  });

  it('shortens the clock the pilot reads off the board', () => {
    const build = (withDoubler: boolean): GameState => {
      const state = freshGame();
      putOnBattlefield(state, 'A', [creatureDef('Beater', 4, 4)]);
      if (withDoubler) putOnBattlefield(state, 'A', [VIOLENCE]);
      state.players.B.life = 16;
      state.step = 'declareAttackers';
      state.activePlayer = 'A';
      state.priorityPlayer = 'A';
      state.combat = { attackers: [], blocks: {}, attackersDeclared: false, blockersDeclared: false };
      return state;
    };
    const plain = assessAttack(build(false), 'A', 'now', boardIndex(build(false)));
    const doubledState = build(true);
    const doubled = assessAttack(doubledState, 'A', 'now', boardIndex(doubledState));
    expect(doubled.turnsToKill).toBeLessThan(plain.turnsToKill);
  });

  it('is NOT applied to the opponent’s attackers — "a creature YOU control"', () => {
    const state = freshGame();
    putOnBattlefield(state, 'B', [creatureDef('Their Beater', 3, 3)]);
    putOnBattlefield(state, 'A', [VIOLENCE]);
    state.players.A.life = 5;
    state.step = 'declareAttackers';
    state.activePlayer = 'B';
    state.priorityPlayer = 'B';
    state.combat = { attackers: [], blocks: {}, attackersDeclared: false, blockersDeclared: false };
    expect(assessAttack(state, 'B', 'now', boardIndex(state)).maxDamage).toBe(3);
  });

  it('does not SPEND a prevention shield merely by evaluating the position', () => {
    const state = freshGame();
    const [beater] = putOnBattlefield(state, 'A', [creatureDef('Beater', 4, 4)]);
    // A live "prevent the next 3 damage that would be dealt to you" on B's side.
    addFloatingReplacement(state, {
      event: 'damage',
      applies: { recipientController: 'you', recipientKind: 'player' },
      outcome: { preventUpTo: 3 },
      sourceInstanceId: beater!.instanceId,
      controller: 'B',
      duration: 'endOfTurn',
    });
    state.step = 'declareAttackers';
    state.activePlayer = 'A';
    state.priorityPlayer = 'A';
    state.combat = { attackers: [beater!.instanceId], blocks: {}, attackersDeclared: false, blockersDeclared: false };

    // Evaluate the same position several times: a projection that spent the
    // shield would report a bigger number on every pass.
    const first = assessAttack(state, 'A', 'now', boardIndex(state)).maxDamage;
    const second = assessAttack(state, 'A', 'now', boardIndex(state)).maxDamage;
    const third = assessAttack(state, 'A', 'now', boardIndex(state)).maxDamage;
    expect(first).toBe(1);
    expect(second).toBe(first);
    expect(third).toBe(first);
    // …and the shield's remaining count is exactly what it started as.
    expect(state.replacements?.[0]?.remaining).toBe(3);
  });
});
