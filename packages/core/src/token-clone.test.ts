/**
 * **A token survives the action boundary with its whole face**, and an ordinary
 * instance still clones byte-for-byte.
 *
 * `cloneState` runs on EVERY action, and it copies an instance FIELD BY FIELD —
 * a shape that has silently dropped a new field four times on this project
 * (`awaitingTargets`, `xValue`, `printedDef`, `chosenAsEntered`). So a branch
 * that adds a fact has to prove the clone still carries it.
 *
 * This branch's answer is deliberately structural rather than another
 * conditional line: a token's colour, its creature types and its token-ness live
 * on the **`CardDefinition`**, which `cloneInstance` shares BY REFERENCE. That
 * makes them impossible to drop — there is no line to forget. The first test
 * pins that guarantee; the second pins the other half of the bargain, that
 * adding a definition field did not quietly widen the per-instance object the
 * clone allocates on every action of every simulated game.
 */

import { describe, expect, it } from 'vitest';
import type { CardDefinition, CardInstance, GameState } from './index.js';
import { cloneState, colorsOfDefinition, createGame, DEFAULT_RULES, applyAction } from './index.js';
import type { EffectRegistry } from './effects.js';

/** A registry with the one primitive these games need: make a token. */
function registry(): EffectRegistry {
  const reg = new Map<string, (ctx: { createToken: (def: CardDefinition) => number }) => void>();
  reg.set('makeToken', (ctx) => {
    ctx.createToken(FAERIE_TOKEN);
  });
  return reg as unknown as EffectRegistry;
}

/** Exactly what the cards package's `makeToken` mints for Bitterblossom. */
const FAERIE_TOKEN: CardDefinition = {
  id: 'token:creature:B:Faerie-Rogue:1/1',
  name: 'Faerie Rogue',
  types: ['creature'],
  subtypes: ['Faerie', 'Rogue'],
  isToken: true,
  power: 1,
  toughness: 1,
  colors: ['B'],
  keywords: { flying: true },
};

const SWAMP: CardDefinition = {
  id: 'test:Swamp',
  name: 'Swamp',
  types: ['land'],
  basic: true,
  subtypes: ['swamp'],
  produces: ['B'],
};

/** A token maker whose whole script is the one primitive above. */
const MAKER: CardDefinition = {
  id: 'test:Maker',
  name: 'Faerie Maker',
  types: ['sorcery'],
  cost: { generic: 1 },
  effects: [{ primitive: 'makeToken', params: {} }],
};

function game(): { state: GameState; reg: EffectRegistry } {
  const reg = registry();
  const { state } = createGame({
    seed: 4242,
    startingPlayer: 'A',
    registry: reg,
    decks: {
      A: { cards: Array.from({ length: 40 }, () => SWAMP) },
      B: { cards: Array.from({ length: 40 }, () => SWAMP) },
    },
  });
  return { state, reg };
}

/** Put a token on the battlefield the way the engine does, then clone. */
function tokenAfterClone(): { before: CardInstance; after: CardInstance } {
  const { state, reg } = game();
  let next = state;
  // Cast nothing — put the token on directly through the same helper the engine
  // uses, by resolving a spell whose script is the primitive.
  const spell: CardInstance = {
    instanceId: 9001,
    def: MAKER,
    controller: 'A',
    owner: 'A',
    zone: 'hand',
    tapped: false,
    summoningSick: false,
    damageMarked: 0,
    markedByDeathtouch: false,
    counters: {},
  };
  next.players.A.hand.push(spell);
  for (let i = 0; i < 2; i++) {
    const land: CardInstance = { ...spell, instanceId: 9100 + i, def: SWAMP, zone: 'battlefield' };
    next.battlefield.push(land);
  }
  let guard = 0;
  while (next.step !== 'precombatMain' && !next.gameOver && guard++ < 50) {
    next = applyAction(next, { kind: 'passPriority', player: next.priorityPlayer }, DEFAULT_RULES, reg)
      .state;
  }
  for (const land of next.battlefield.filter((c) => c.def.id === SWAMP.id)) {
    next = applyAction(
      next,
      { kind: 'tapForMana', player: 'A', instanceId: land.instanceId, mode: 0 },
      DEFAULT_RULES,
      reg,
    ).state;
  }
  next = applyAction(
    next,
    { kind: 'castSpell', player: 'A', instanceId: spell.instanceId },
    DEFAULT_RULES,
    reg,
  ).state;
  guard = 0;
  while (next.stack.length > 0 && !next.gameOver && guard++ < 20) {
    next = applyAction(next, { kind: 'passPriority', player: next.priorityPlayer }, DEFAULT_RULES, reg)
      .state;
  }
  const before = next.battlefield.find((c) => c.def.isToken === true);
  if (!before) throw new Error('the token never entered');
  const after = cloneState(next).battlefield.find((c) => c.instanceId === before.instanceId);
  if (!after) throw new Error('the token did not survive the clone');
  return { before, after };
}

describe('cloning a token', () => {
  it('carries the whole printed face across the action boundary', () => {
    const { before, after } = tokenAfterClone();
    // Shared BY REFERENCE — which is the guarantee, not an implementation
    // detail: there is no field-by-field copy of the definition to forget.
    expect(after.def).toBe(before.def);
    expect(after.def.isToken).toBe(true);
    expect(after.def.subtypes).toEqual(['Faerie', 'Rogue']);
    expect(colorsOfDefinition(after.def)).toEqual(['B']);
    expect(after.def.keywords?.flying).toBe(true);
  });

  it('leaves the cloned INSTANCE the same shape it has always been', () => {
    // The other half of the bargain. `cloneInstance` allocates one of these per
    // card in the game on every single action, and an extra property on the
    // ordinary instance measured as a real throughput regression before. Adding
    // token-ness to the DEFINITION must not have widened it.
    const { after } = tokenAfterClone();
    expect(Object.keys(after).sort()).toEqual(
      [
        'controller',
        'counters',
        'damageMarked',
        'def',
        'instanceId',
        'markedByDeathtouch',
        'owner',
        'summoningSick',
        'tapped',
        'zone',
      ].sort(),
    );
  });
});
