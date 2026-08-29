/**
 * PREDEFINED ARTIFACT TOKENS (CR 111.10) — Treasure, Clue, Food, as data.
 *
 * The fidelity edges:
 *  - "create a Treasure token" must make THE Treasure — abilities included. A
 *    nameless artifact with the right subtype would satisfy every filter and
 *    still be uncrackable, a strictly worse card wearing a green checkmark.
 *  - the alternation is CLOSED: "create a Blood token" must stay reported until
 *    Blood's face (rummage) is authored, never compile to a blank.
 */

import { describe, expect, it } from 'vitest';
import type { CardDefinition, GameState, PlayerId } from '@jonny-boi/core';
import { compileCard } from './compile/compile.js';
import type { CompilableCard } from './compile/types.js';
import { buildRegistry } from './pool.js';
import { PREDEFINED_TOKEN_DEFS } from './predefined-tokens.js';

function makeCard(overrides: Partial<CompilableCard> & { name: string }): CompilableCard {
  return {
    id: `test:${overrides.name}`,
    manaCost: { generic: 0, W: 0, U: 0, B: 0, R: 0, G: 0, C: 0, other: [] },
    typeLine: { supertypes: [], types: [], subtypes: [] },
    oracleText: '',
    power: null,
    toughness: null,
    keywords: [],
    ...overrides,
  };
}

describe('the predefined token faces', () => {
  it('Treasure carries the sacrifice-cost any-color mana ability', () => {
    const treasure = PREDEFINED_TOKEN_DEFS.treasure!;
    expect(treasure.subtypes).toEqual(['Treasure']);
    const ability = treasure.manaAbilities?.[0];
    expect(ability?.cost?.sacrificeSelf).toBe(true);
    expect(ability?.produces).toHaveLength(5);
  });

  it('Clue cracks for a draw, Food for its printed life', () => {
    const clue = PREDEFINED_TOKEN_DEFS.clue!.activated?.[0];
    expect(clue?.cost.sacrificeSelf).toBe(true);
    expect(clue?.effects[0]?.primitive).toBe('drawCards');
    const food = PREDEFINED_TOKEN_DEFS.food!.activated?.[0];
    expect(food?.cost.sacrificeSelf).toBe(true);
    expect(food?.cost.tap).toBe(true);
    expect(food?.effects[0]).toEqual({ primitive: 'gainLife', params: { amount: 3 } });
  });
});

describe('compiling "create a … token" against the closed table', () => {
  it('compiles a Treasure-maker completely', () => {
    const result = compileCard(
      makeCard({
        name: 'Coin Sorcery',
        typeLine: { supertypes: [], types: ['Sorcery'], subtypes: [] },
        oracleText: 'Create two Treasure tokens.',
      }),
    );
    expect(result.status, JSON.stringify(result.missing)).toBe('complete');
    expect(result.definition.effects?.[0]).toEqual({
      primitive: 'createPredefinedToken',
      params: { token: 'treasure', count: 2 },
    });
  });

  it('compiles a dies-trigger Clue and a tapped Treasure', () => {
    const clue = compileCard(
      makeCard({
        name: 'Tireless Sleuth',
        typeLine: { supertypes: [], types: ['Creature'], subtypes: ['Human'] },
        power: '2',
        toughness: '2',
        oracleText: 'When this creature dies, create a Clue token.',
      }),
    );
    expect(clue.status, JSON.stringify(clue.missing)).toBe('complete');
    const tapped = compileCard(
      makeCard({
        name: 'Slow Coins',
        typeLine: { supertypes: [], types: ['Sorcery'], subtypes: [] },
        oracleText: 'Create a tapped Treasure token.',
      }),
    );
    expect(tapped.status, JSON.stringify(tapped.missing)).toBe('complete');
    expect(tapped.definition.effects?.[0]?.params).toEqual({ token: 'treasure', tapped: true });
  });

  it('still REFUSES a predefined token whose face is not authored (Blood)', () => {
    const result = compileCard(
      makeCard({
        name: 'Bloodletter',
        typeLine: { supertypes: [], types: ['Sorcery'], subtypes: [] },
        oracleText: 'Create a Blood token.',
      }),
    );
    expect(result.status).toBe('incomplete');
  });
});

describe('the primitive, resolved for real', () => {
  it('creates the looked-up face and honors count + tapped; an unknown kind is a safe no-op', () => {
    const registry = buildRegistry();
    const primitive = registry.get('createPredefinedToken');
    expect(primitive).toBeDefined();
    const created: Array<{ def: CardDefinition; count: number; tapped: boolean }> = [];
    const ctxFor = (params: Record<string, unknown>): unknown => ({
      state: {} as GameState,
      source: { instanceId: 1, def: { id: 's', name: 'Source', types: ['sorcery'] } },
      controller: 'A' as PlayerId,
      targets: [],
      params,
      emit: () => {},
      ask: () => undefined,
      createTokens(def: CardDefinition, count: number, _c?: unknown, options?: { tapped?: boolean }) {
        created.push({ def, count, tapped: options?.tapped === true });
        return Array.from({ length: count }, (_, i) => 100 + i);
      },
    });
    primitive!(ctxFor({ token: 'treasure', count: 3 }) as never);
    primitive!(ctxFor({ token: 'food', tapped: true }) as never);
    primitive!(ctxFor({ token: 'blood' }) as never);
    expect(created).toHaveLength(2);
    expect(created[0]).toMatchObject({ count: 3, tapped: false });
    expect(created[0]!.def.name).toBe('Treasure');
    expect(created[1]).toMatchObject({ count: 1, tapped: true });
    expect(created[1]!.def.name).toBe('Food');
  });
});
