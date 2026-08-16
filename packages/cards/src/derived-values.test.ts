/**
 * Derived values — "equal to the number of …".
 *
 * The design worth defending: the evaluation lives in `intParam`, the single
 * chokepoint every numeric param already reads. That means damage, cards drawn,
 * life gained, mill depth and pump size ALL understand derived values without a
 * single primitive changing — and a future primitive inherits it for free.
 *
 * The vocabulary is deliberately closed. A card naming a count we cannot
 * evaluate exactly is reported, not approximated, because a derived value that
 * is quietly wrong makes a card stronger or weaker than printed in a way no
 * test of that card would notice.
 */

import { describe, expect, it } from 'vitest';
import type { CardDefinition, EffectContext, GameState, PlayerId } from '@jonny-boi/core';
import { compileCard } from './compile/compile.js';
import type { CompilableCard } from './compile/types.js';
import { intParam } from './effect-helpers.js';

function card(overrides: Partial<CompilableCard> & { name: string; oracleText: string }): CompilableCard {
  return {
    id: `id:${overrides.name}`,
    manaCost: { generic: 0, W: 0, U: 0, B: 0, R: 0, G: 0, C: 0, other: [] },
    typeLine: { supertypes: [], types: ['Instant'], subtypes: [] },
    power: null,
    toughness: null,
    keywords: [],
    ...overrides,
  } as CompilableCard;
}

const BEAR: CardDefinition = { id: 'bear', name: 'Bear', types: ['creature'], power: 2, toughness: 2 };
const FOREST: CardDefinition = { id: 'forest', name: 'Forest', types: ['land'], produces: ['G'] };

/** A minimal context carrying just the board/zones a derived count reads. */
function contextWith(board: Array<{ def: CardDefinition; controller: PlayerId }>, handSize = 0): EffectContext {
  const battlefield = board.map((entry, index) => ({
    instanceId: index + 1,
    def: entry.def,
    controller: entry.controller,
    owner: entry.controller,
    zone: 'battlefield' as const,
    tapped: false,
    summoningSick: false,
    damageMarked: 0,
    markedByDeathtouch: false,
    counters: {},
  }));
  const hand = Array.from({ length: handSize }, (_, i) => ({
    instanceId: 500 + i,
    def: BEAR,
    controller: 'A' as PlayerId,
    owner: 'A' as PlayerId,
    zone: 'hand' as const,
    tapped: false,
    summoningSick: false,
    damageMarked: 0,
    markedByDeathtouch: false,
    counters: {},
  }));
  const state = {
    battlefield,
    players: {
      A: { hand, graveyard: [] },
      B: { hand: [], graveyard: [] },
    },
  } as unknown as GameState;
  return { state, controller: 'A', params: {} } as unknown as EffectContext;
}

/** Read a derived param off a context with the given params. */
function read(ctx: EffectContext, params: Record<string, unknown>): number {
  return intParam({ ...ctx, params } as EffectContext, 'amount', -1);
}

describe('evaluating a derived count', () => {
  it('counts creatures you control, ignoring the opponent', () => {
    const ctx = contextWith([
      { def: BEAR, controller: 'A' },
      { def: BEAR, controller: 'A' },
      { def: BEAR, controller: 'B' },
    ]);
    expect(read(ctx, { amount: { countOf: 'creaturesYouControl' } })).toBe(2);
  });

  it("counts the opponent's creatures", () => {
    const ctx = contextWith([
      { def: BEAR, controller: 'A' },
      { def: BEAR, controller: 'B' },
      { def: BEAR, controller: 'B' },
    ]);
    expect(read(ctx, { amount: { countOf: 'creaturesOpponentControls' } })).toBe(2);
  });

  it('counts lands separately from creatures', () => {
    const ctx = contextWith([
      { def: FOREST, controller: 'A' },
      { def: FOREST, controller: 'A' },
      { def: BEAR, controller: 'A' },
    ]);
    expect(read(ctx, { amount: { countOf: 'landsYouControl' } })).toBe(2);
    expect(read(ctx, { amount: { countOf: 'creaturesYouControl' } })).toBe(1);
  });

  it('counts cards in your hand', () => {
    const ctx = contextWith([], 4);
    expect(read(ctx, { amount: { countOf: 'cardsInYourHand' } })).toBe(4);
  });

  it('is zero on an empty board rather than undefined', () => {
    const ctx = contextWith([]);
    expect(read(ctx, { amount: { countOf: 'creaturesYouControl' } })).toBe(0);
  });

  it('still reads a printed literal unchanged', () => {
    const ctx = contextWith([{ def: BEAR, controller: 'A' }]);
    expect(read(ctx, { amount: 3 })).toBe(3);
  });

  it('falls back for an unknown count rather than inventing a number', () => {
    const ctx = contextWith([{ def: BEAR, controller: 'A' }]);
    expect(read(ctx, { amount: { countOf: 'phasesOfTheMoon' } })).toBe(0);
  });
});

describe('the compiler reaches derived values from printed text', () => {
  it('compiles damage equal to a count', () => {
    const result = compileCard(
      card({
        name: 'Tribal Bolt',
        oracleText: 'Tribal Bolt deals damage to any target equal to the number of creatures you control.',
      }),
    );
    expect(result.status, `missing: ${JSON.stringify(result.missing)}`).toBe('complete');
    expect(result.definition.effects?.[0]).toEqual({
      primitive: 'dealDamage',
      params: { amount: { countOf: 'creaturesYouControl' } },
    });
  });

  it('compiles draw equal to a count', () => {
    const result = compileCard(
      card({
        name: 'Tribal Draw',
        oracleText: 'Draw cards equal to the number of creatures you control.',
        typeLine: { supertypes: [], types: ['Sorcery'], subtypes: [] },
      }),
    );
    expect(result.status, `missing: ${JSON.stringify(result.missing)}`).toBe('complete');
    expect(result.definition.effects?.[0]).toEqual({
      primitive: 'drawCards',
      params: { count: { countOf: 'creaturesYouControl' } },
    });
  });

  it('refuses a count it cannot evaluate exactly', () => {
    const result = compileCard(
      card({
        name: 'Weird Bolt',
        oracleText:
          'Weird Bolt deals damage to any target equal to the number of times you have blinked today.',
      }),
    );
    expect(result.status).toBe('incomplete');
  });
});
