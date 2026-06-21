/**
 * Unit tests for the effect primitives in isolation. Each test builds a minimal
 * draft `GameState` + an `EffectContext`, runs one primitive, and asserts the
 * state mutation and the events emitted. No engine, no RNG — pure and
 * deterministic.
 */

import { describe, expect, it } from 'vitest';
import type {
  CardDefinition,
  CardInstance,
  EffectContext,
  GameEvent,
  GameState,
  InstanceId,
  PlayerId,
} from '@jonny-boi/core';
import { PLUS_ONE_COUNTER, effectiveToughness, effectivePower } from '@jonny-boi/core';
import {
  addMana,
  counterSpell,
  createToken,
  dealDamage,
  destroyAll,
  destroyTarget,
  discardCard,
  drawCards,
  exileTarget,
  gainLife,
  loseLife,
  pumpUntilEndOfTurn,
  returnFromGraveyard,
  tapTarget,
} from './primitives.js';

// --- minimal fixtures ----------------------------------------------------------

let nextId = 1;

function inst(def: CardDefinition, player: PlayerId, zone: CardInstance['zone'] = 'battlefield'): CardInstance {
  return {
    instanceId: nextId++,
    def,
    controller: player,
    owner: player,
    zone,
    tapped: false,
    summoningSick: false,
    damageMarked: 0,
    markedByDeathtouch: false,
    counters: {},
  };
}

function emptyState(): GameState {
  return {
    nextInstanceId: 1000,
    turnNumber: 1,
    activePlayer: 'A',
    priorityPlayer: 'A',
    step: 'precombatMain',
    players: {
      A: {
        id: 'A', life: 20, manaPool: { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 },
        landsPlayedThisTurn: 0, hasLost: false,
        library: [], hand: [], graveyard: [], exile: [], command: [],
      },
      B: {
        id: 'B', life: 20, manaPool: { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 },
        landsPlayedThisTurn: 0, hasLost: false,
        library: [], hand: [], graveyard: [], exile: [], command: [],
      },
    },
    battlefield: [],
    stack: [],
    combat: null,
    winner: null,
    gameOver: false,
    consecutivePasses: 0,
    seed: 1,
    rngState: 1,
  };
}

function ctxFor(
  state: GameState,
  source: CardInstance,
  params: Record<string, unknown>,
  targets: ReadonlyArray<InstanceId | PlayerId> = [],
): { ctx: EffectContext; events: GameEvent[] } {
  const events: GameEvent[] = [];
  const ctx: EffectContext = {
    state,
    source,
    controller: source.controller,
    targets,
    params,
    emit: (e) => events.push(e),
  };
  return { ctx, events };
}

const bear: CardDefinition = { id: 'bear', name: 'Bear', types: ['creature'], power: 2, toughness: 2, cost: { generic: 2 } };
const bigGuy: CardDefinition = { id: 'big', name: 'Big', types: ['creature'], power: 3, toughness: 3, cost: { generic: 3 } };

// --- dealDamage ----------------------------------------------------------------

describe('dealDamage', () => {
  it('3 damage to a 2/2 marks lethal damage and emits damageDealt', () => {
    const s = emptyState();
    const target = inst(bear, 'B');
    s.battlefield.push(target);
    const src = inst({ id: 'bolt', name: 'Bolt', types: ['instant'] }, 'A', 'stack');
    const { ctx, events } = ctxFor(s, src, { amount: 3 }, [target.instanceId]);
    dealDamage(ctx);
    expect(target.damageMarked).toBe(3);
    expect(effectiveToughness(target) - target.damageMarked).toBeLessThanOrEqual(0); // lethal
    expect(events.find((e) => e.type === 'damageDealt')).toMatchObject({ amount: 3, combat: false });
  });

  it('to a player reduces life and emits lifeChanged + damageDealt', () => {
    const s = emptyState();
    const src = inst({ id: 'bolt', name: 'Bolt', types: ['instant'] }, 'A', 'stack');
    const { ctx, events } = ctxFor(s, src, { amount: 3 }, ['B']);
    dealDamage(ctx);
    expect(s.players.B.life).toBe(17);
    expect(events.some((e) => e.type === 'lifeChanged')).toBe(true);
  });

  it('is a safe no-op with no target', () => {
    const s = emptyState();
    const src = inst({ id: 'bolt', name: 'Bolt', types: ['instant'] }, 'A', 'stack');
    const { ctx, events } = ctxFor(s, src, { amount: 3 }, []);
    expect(() => dealDamage(ctx)).not.toThrow();
    expect(events).toHaveLength(0);
  });
});

// --- drawCards -----------------------------------------------------------------

describe('drawCards', () => {
  it('moves N cards from library to hand and emits drawCard each', () => {
    const s = emptyState();
    for (let i = 0; i < 5; i++) s.players.A.library.push(inst(bear, 'A', 'library'));
    const src = inst({ id: 'brainstorm', name: 'Brainstorm', types: ['instant'] }, 'A', 'stack');
    const { ctx, events } = ctxFor(s, src, { count: 2 });
    drawCards(ctx);
    expect(s.players.A.hand).toHaveLength(2);
    expect(s.players.A.library).toHaveLength(3);
    expect(events.filter((e) => e.type === 'drawCard')).toHaveLength(2);
  });

  it('stops safely on an empty library', () => {
    const s = emptyState();
    const src = inst({ id: 'ponder', name: 'Ponder', types: ['sorcery'] }, 'A', 'stack');
    const { ctx } = ctxFor(s, src, { count: 3 });
    expect(() => drawCards(ctx)).not.toThrow();
    expect(s.players.A.hand).toHaveLength(0);
  });
});

// --- gainLife / loseLife -------------------------------------------------------

describe('gainLife / loseLife', () => {
  it('gainLife adds to controller life', () => {
    const s = emptyState();
    const src = inst({ id: 'finks', name: 'Finks', types: ['creature'] }, 'A', 'stack');
    const { ctx, events } = ctxFor(s, src, { amount: 2 });
    gainLife(ctx);
    expect(s.players.A.life).toBe(22);
    expect(events.some((e) => e.type === 'gainLife')).toBe(true);
  });

  it('loseLife subtracts from controller life', () => {
    const s = emptyState();
    const src = inst({ id: 'seize', name: 'Thoughtseize', types: ['sorcery'] }, 'A', 'stack');
    const { ctx } = ctxFor(s, src, { amount: 2 });
    loseLife(ctx);
    expect(s.players.A.life).toBe(18);
  });
});

// --- pumpUntilEndOfTurn --------------------------------------------------------

describe('pumpUntilEndOfTurn', () => {
  it('+3/+3 changes combat math via counters', () => {
    const s = emptyState();
    const target = inst(bear, 'A');
    s.battlefield.push(target);
    const src = inst({ id: 'gg', name: 'Giant Growth', types: ['instant'] }, 'A', 'stack');
    const { ctx, events } = ctxFor(s, src, { power: 3, toughness: 3 }, [target.instanceId]);
    pumpUntilEndOfTurn(ctx);
    expect(target.counters[PLUS_ONE_COUNTER]).toBe(3);
    expect(effectivePower(target)).toBe(5);
    expect(effectiveToughness(target)).toBe(5);
    expect(events.some((e) => e.type === 'counterAdded')).toBe(true);
  });
});

// --- destroyTarget -------------------------------------------------------------

describe('destroyTarget', () => {
  it('destroys a creature, moving it to its owner graveyard', () => {
    const s = emptyState();
    const target = inst(bear, 'B');
    s.battlefield.push(target);
    const src = inst({ id: 'db', name: 'Doom Blade', types: ['instant'] }, 'A', 'stack');
    const { ctx, events } = ctxFor(s, src, {}, [target.instanceId]);
    destroyTarget(ctx);
    expect(s.battlefield).toHaveLength(0);
    expect(s.players.B.graveyard).toHaveLength(1);
    expect(events.some((e) => e.type === 'creatureDied')).toBe(true);
  });

  it('notColor filter spares a creature of that color (no-op)', () => {
    const s = emptyState();
    const blackBear: CardDefinition = { ...bear, id: 'bb', cost: { B: 2 } };
    const target = inst(blackBear, 'B');
    s.battlefield.push(target);
    const src = inst({ id: 'db', name: 'Doom Blade', types: ['instant'] }, 'A', 'stack');
    const { ctx } = ctxFor(s, src, { notColor: 'B' }, [target.instanceId]);
    destroyTarget(ctx);
    expect(s.battlefield).toHaveLength(1); // nonblack-only: black creature survives
  });

  it('maxManaValue filter spares a too-expensive creature', () => {
    const s = emptyState();
    const target = inst(bigGuy, 'B'); // mv 3
    s.battlefield.push(target);
    const src = inst({ id: 'push', name: 'Fatal Push', types: ['instant'] }, 'A', 'stack');
    const { ctx } = ctxFor(s, src, { maxManaValue: 2 }, [target.instanceId]);
    destroyTarget(ctx);
    expect(s.battlefield).toHaveLength(1);
  });
});

// --- exileTarget ---------------------------------------------------------------

describe('exileTarget', () => {
  it('exiles a creature to its owner exile zone', () => {
    const s = emptyState();
    const target = inst(bear, 'B');
    s.battlefield.push(target);
    const src = inst({ id: 'path', name: 'Path', types: ['instant'] }, 'A', 'stack');
    const { ctx } = ctxFor(s, src, {}, [target.instanceId]);
    exileTarget(ctx);
    expect(s.battlefield).toHaveLength(0);
    expect(s.players.B.exile).toHaveLength(1);
  });

  it('gainLifeEqualPower gives the controller life equal to power (Swords)', () => {
    const s = emptyState();
    const target = inst(bigGuy, 'B'); // power 3
    s.battlefield.push(target);
    const src = inst({ id: 'stp', name: 'Swords', types: ['instant'] }, 'A', 'stack');
    const { ctx } = ctxFor(s, src, { gainLifeEqualPower: true }, [target.instanceId]);
    exileTarget(ctx);
    expect(s.players.B.life).toBe(23); // the exiled creature's controller gains
  });
});

// --- destroyAll ----------------------------------------------------------------

describe('destroyAll', () => {
  it('destroys every creature but leaves lands', () => {
    const s = emptyState();
    s.battlefield.push(inst(bear, 'A'), inst(bigGuy, 'B'));
    s.battlefield.push(inst({ id: 'forest', name: 'Forest', types: ['land'], produces: ['G'] }, 'A'));
    const src = inst({ id: 'wrath', name: 'Wrath', types: ['sorcery'] }, 'A', 'stack');
    const { ctx } = ctxFor(s, src, {});
    destroyAll(ctx);
    expect(s.battlefield.filter((c) => c.def.types.includes('creature'))).toHaveLength(0);
    expect(s.battlefield.filter((c) => c.def.types.includes('land'))).toHaveLength(1);
  });
});

// --- addMana -------------------------------------------------------------------

describe('addMana', () => {
  it('adds the listed symbols to the controller pool (Dark Ritual BBB)', () => {
    const s = emptyState();
    const src = inst({ id: 'ritual', name: 'Dark Ritual', types: ['instant'] }, 'A', 'stack');
    const { ctx, events } = ctxFor(s, src, { mana: ['B', 'B', 'B'] });
    addMana(ctx);
    expect(s.players.A.manaPool.B).toBe(3);
    expect(events.filter((e) => e.type === 'manaAdded')).toHaveLength(3);
  });
});

// --- counterSpell --------------------------------------------------------------

describe('counterSpell', () => {
  it('removes a targeted spell from the stack to its owner graveyard', () => {
    const s = emptyState();
    const spell = inst({ id: 'bolt', name: 'Bolt', types: ['instant'] }, 'B', 'stack');
    s.stack.push({ instanceId: spell.instanceId, card: spell, controller: 'B', resolvesTo: 'graveyard', targets: [] });
    const src = inst({ id: 'cs', name: 'Counterspell', types: ['instant'] }, 'A', 'stack');
    const { ctx } = ctxFor(s, src, {}, [spell.instanceId]);
    counterSpell(ctx);
    expect(s.stack).toHaveLength(0);
    expect(s.players.B.graveyard).toHaveLength(1);
  });

  it('is a no-op when the target is not on the stack', () => {
    const s = emptyState();
    const src = inst({ id: 'cs', name: 'Counterspell', types: ['instant'] }, 'A', 'stack');
    const { ctx } = ctxFor(s, src, {}, [9999]);
    expect(() => counterSpell(ctx)).not.toThrow();
  });
});

// --- discardCard ---------------------------------------------------------------

describe('discardCard', () => {
  it('moves a card from the targeted player hand to graveyard', () => {
    const s = emptyState();
    s.players.B.hand.push(inst(bear, 'B', 'hand'));
    const src = inst({ id: 'seize', name: 'Thoughtseize', types: ['sorcery'] }, 'A', 'stack');
    const { ctx } = ctxFor(s, src, { count: 1 }, ['B']);
    discardCard(ctx);
    expect(s.players.B.hand).toHaveLength(0);
    expect(s.players.B.graveyard).toHaveLength(1);
  });
});

// --- createToken ---------------------------------------------------------------

describe('createToken', () => {
  it('puts a token creature onto the battlefield under the controller', () => {
    const s = emptyState();
    const src = inst({ id: 'pyro', name: 'Young Pyromancer', types: ['creature'] }, 'A', 'battlefield');
    const { ctx } = ctxFor(s, src, { count: 1, power: 1, toughness: 1, name: 'Elemental' });
    createToken(ctx);
    const tokens = s.battlefield.filter((c) => c.def.name === 'Elemental');
    expect(tokens).toHaveLength(1);
    expect(tokens[0]!.controller).toBe('A');
    expect(tokens[0]!.def.power).toBe(1);
  });
});

// --- tapTarget -----------------------------------------------------------------

describe('tapTarget', () => {
  it('taps an untapped target permanent', () => {
    const s = emptyState();
    const target = inst(bear, 'B');
    s.battlefield.push(target);
    const src = inst({ id: 'cmd', name: 'Cryptic', types: ['instant'] }, 'A', 'stack');
    const { ctx } = ctxFor(s, src, {}, [target.instanceId]);
    tapTarget(ctx);
    expect(target.tapped).toBe(true);
  });
});

// --- returnFromGraveyard -------------------------------------------------------

describe('returnFromGraveyard', () => {
  it('returns the most recent graveyard card to hand, skipping the source', () => {
    const s = emptyState();
    const dead = inst(bear, 'A', 'graveyard');
    s.players.A.graveyard.push(dead);
    const src = inst({ id: 'witness', name: 'Eternal Witness', types: ['creature'] }, 'A', 'battlefield');
    const { ctx } = ctxFor(s, src, { count: 1 });
    returnFromGraveyard(ctx);
    expect(s.players.A.hand).toHaveLength(1);
    expect(s.players.A.graveyard).toHaveLength(0);
  });
});
