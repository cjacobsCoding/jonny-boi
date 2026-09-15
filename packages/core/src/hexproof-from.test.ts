/**
 * HEXPROOF FROM [QUALITY] (CR 702.11e) — the ONE rule it is, and the three it
 * is not.
 *
 * Protection from a quality is four rules against every source; hexproof-from
 * is the TARGETING one, against an opponent's source only. The tests that make
 * this file honest are therefore the NEGATIVE ones: a creature with hexproof
 * from black must still be blockable by a black creature, enchantable by a
 * black Aura, and targetable by its OWN controller's black spell. An
 * implementation that routed this through `protectionFrom` — the obvious,
 * tempting shortcut, since the quality vocabulary really is shared — passes
 * every positive test here and fails all three.
 *
 * Read `protection.test.ts` beside this one: it asserts the four halves that
 * protection DOES have, off the same predicates, so the two abilities cannot
 * quietly converge.
 */

import { describe, expect, it } from 'vitest';
import type { CardDefinition } from './card.js';
import type { CardInstance, GameState, PlayerId } from './state.js';
import { createGame } from './engine.js';
import { isLegalTarget, legalTargetsFor } from './targeting.js';
import { canBlock } from './internal/combat.js';
import { indexContinuous } from './internal/continuous.js';
import { isLegalHost } from './attachments.js';
import { mergeKeywordGrant } from './internal/stats.js';
import { applyCopyExceptions } from './copy.js';
import { deckOf, landDef } from './test-fixtures.js';

const SEED = 1751;

function creature(id: string, extra?: Partial<CardDefinition>): CardDefinition {
  return { id, name: id, types: ['creature'], power: 2, toughness: 2, ...extra };
}

const BLACK_SPELL: CardDefinition = { id: 'black-spell', name: 'Black Spell', types: ['instant'], cost: { B: 1 }, timing: 'instant' };
const RED_SPELL: CardDefinition = { id: 'red-spell', name: 'Red Spell', types: ['instant'], cost: { R: 1 }, timing: 'instant' };
const WHITE_SPELL: CardDefinition = { id: 'white-spell', name: 'White Spell', types: ['instant'], cost: { W: 1 }, timing: 'instant' };

/** Fiendslayer Paladin, exactly as the compiler builds it from the printed card. */
const PALADIN = creature('Fiendslayer Paladin', {
  cost: { generic: 1, W: 2 },
  keywords: { firstStrike: true, lifelink: true, hexproofFrom: ['black', 'red'] },
});

const BLACK_AURA: CardDefinition = {
  id: 'Black Aura',
  name: 'Black Aura',
  types: ['enchantment'],
  cost: { B: 1 },
  attachment: { attachesTo: { anyOfTypes: ['creature'] }, whenIllegal: 'toGraveyard', label: 'Enchant creature' },
};

function board(): GameState {
  const { state } = createGame({
    seed: SEED,
    decks: { A: deckOf(landDef('Mountain', 'R'), 30), B: deckOf(landDef('Mountain', 'R'), 30) },
  });
  state.step = 'precombatMain';
  state.activePlayer = 'A';
  state.priorityPlayer = 'A';
  state.stack = [];
  return state;
}

function place(state: GameState, def: CardDefinition, controller: PlayerId): CardInstance {
  const instance: CardInstance = {
    instanceId: state.nextInstanceId++,
    def,
    controller,
    owner: controller,
    zone: 'battlefield',
    tapped: false,
    summoningSick: false,
    damageMarked: 0,
    markedByDeathtouch: false,
    counters: {},
  };
  state.battlefield.push(instance);
  return instance;
}

describe('the ONE rule it has: targeting, by an opponent, from a named quality', () => {
  it("an OPPONENT's black spell cannot target it", () => {
    const state = board();
    const paladin = place(state, PALADIN, 'A');
    expect(isLegalTarget(state, 'creature', paladin.instanceId, 'B', BLACK_SPELL)).toBe(false);
  });

  it("an OPPONENT's red spell cannot target it either — the payload is a LIST", () => {
    const state = board();
    const paladin = place(state, PALADIN, 'A');
    expect(isLegalTarget(state, 'creature', paladin.instanceId, 'B', RED_SPELL)).toBe(false);
  });

  it("an OPPONENT's WHITE spell targets it freely — this is not blanket hexproof", () => {
    const state = board();
    const paladin = place(state, PALADIN, 'A');
    expect(isLegalTarget(state, 'creature', paladin.instanceId, 'B', WHITE_SPELL)).toBe(true);
  });

  it("its OWN CONTROLLER may aim a black spell at it — hexproof's scope, not shroud's", () => {
    const state = board();
    const paladin = place(state, PALADIN, 'A');
    expect(isLegalTarget(state, 'creature', paladin.instanceId, 'A', BLACK_SPELL)).toBe(true);
  });

  it('an UNKNOWN caster is refused — the conservative direction hexproof already takes', () => {
    const state = board();
    const paladin = place(state, PALADIN, 'A');
    expect(isLegalTarget(state, 'creature', paladin.instanceId, undefined, BLACK_SPELL)).toBe(false);
  });

  it('an UNKNOWN source is refused — the conservative direction protection already takes', () => {
    const state = board();
    const paladin = place(state, PALADIN, 'A');
    expect(isLegalTarget(state, 'creature', paladin.instanceId, 'B', undefined)).toBe(false);
  });

  it("is absent from an opponent's black-spell menu and present in their white one", () => {
    const state = board();
    const paladin = place(state, PALADIN, 'A');
    // A plain creature beside it, so "absent from the black menu" is a real
    // exclusion rather than an empty menu passing a `not.toContain`.
    const plain = place(state, creature('Plain'), 'A');
    const blackMenu = legalTargetsFor(state, 'creature', 'B', BLACK_SPELL);
    expect(blackMenu).not.toContain(paladin.instanceId);
    expect(blackMenu).toContain(plain.instanceId);
    expect(legalTargetsFor(state, 'creature', 'B', WHITE_SPELL)).toContain(paladin.instanceId);
  });

  it('a GRANTED hexproof-from behaves like a printed one while it lasts', () => {
    const state = board();
    const target = place(state, creature('Plain'), 'B');
    expect(isLegalTarget(state, 'creature', target.instanceId, 'A', RED_SPELL)).toBe(true);
    state.continuous.push({
      id: state.nextInstanceId++,
      targetInstanceId: target.instanceId,
      sourceInstanceId: target.instanceId,
      until: 'endOfTurn',
      keywords: { hexproofFrom: ['red'] },
    } as GameState['continuous'][number]);
    expect(isLegalTarget(state, 'creature', target.instanceId, 'A', RED_SPELL)).toBe(false);
    // and still not a blanket: a white spell gets through.
    expect(isLegalTarget(state, 'creature', target.instanceId, 'A', WHITE_SPELL)).toBe(true);
  });
});

describe("the three rules it does NOT have — protection's other quarters", () => {
  it('CAN be blocked by a black creature (protection would refuse the block)', () => {
    const state = board();
    const attacker = place(state, PALADIN, 'A');
    const blackBlocker = place(state, creature('Black Blocker', { cost: { B: 1 } }), 'B');
    expect(canBlock(attacker, blackBlocker, indexContinuous(state))).toBe(true);
  });

  it('CAN be enchanted by a black Aura (protection would knock it off)', () => {
    const state = board();
    const host = place(state, PALADIN, 'A');
    expect(isLegalHost(BLACK_AURA.attachment!, 'B', host, BLACK_AURA, state)).toBe(true);
  });

  it('carries none of the blanket flags — the definition itself is the proof', () => {
    expect(PALADIN.keywords?.protectionFrom).toBeUndefined();
    expect(PALADIN.keywords?.hexproof).toBeUndefined();
    expect(PALADIN.keywords?.shroud).toBeUndefined();
  });
});

describe('the payload merges by UNION at every home', () => {
  it('mergeKeywordGrant unions two lists instead of writing `true`', () => {
    expect(mergeKeywordGrant({ hexproofFrom: ['black'] }, { hexproofFrom: ['blue'] }).hexproofFrom).toEqual([
      'black',
      'blue',
    ]);
  });

  it('mergeKeywordGrant does not duplicate a repeated quality', () => {
    expect(mergeKeywordGrant({ hexproofFrom: ['black'] }, { hexproofFrom: ['black'] }).hexproofFrom).toEqual(['black']);
  });

  it("a copy's `except it has …` unions rather than replacing the copied qualities", () => {
    const copied = applyCopyExceptions(creature('Clone', { keywords: { hexproofFrom: ['black'] } }), {
      addKeywords: { hexproofFrom: ['red'] },
    });
    expect(copied.keywords?.hexproofFrom).toEqual(['black', 'red']);
  });
});
