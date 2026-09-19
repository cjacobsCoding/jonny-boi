/**
 * THE WALL-TRIBAL COUNT — "where X is the number of creatures you control with
 * defender", and the "where X is …" spelling of a derived amount.
 *
 * Two printed spellings mean one quantity: `damage-equal-to-count` reads "equal
 * to the number of …" and this reads "…X, where X is the number of …". Both go
 * through the ONE `DERIVED_COUNTS` table, which is what stops them drifting
 * into different numbers (rule 12).
 *
 * Doorkeeper is the acceptance card. Axebane Guardian, its twin, deliberately
 * stays REPORTED — see the last block for exactly what blocks it.
 */

import { describe, expect, it } from 'vitest';
import type { CardDefinition, CardInstance, GameState, PlayerId } from '@jonny-boi/core';
import { createGame, evaluateDerivedCount } from '@jonny-boi/core';
import { compileCard } from './compile.js';
import type { CompilableCard } from './types.js';

function card(
  overrides: Partial<CompilableCard> & { name: string; oracleText: string },
): CompilableCard {
  return {
    id: `id:${overrides.name}`,
    manaCost: { generic: 2, W: 0, U: 0, B: 0, R: 0, G: 0, C: 0, other: [] },
    typeLine: { supertypes: [], types: ['Creature'], subtypes: ['Human', 'Wizard'] },
    power: 0,
    toughness: 4,
    keywords: ['Defender'],
    ...overrides,
  } as CompilableCard;
}

/** Doorkeeper, as printed. */
const DOORKEEPER = card({
  name: 'Doorkeeper',
  oracleText:
    'Defender\n{2}{U}, {T}: Target player mills X cards, where X is the number of creatures you control with defender.',
});

describe('Doorkeeper — the acceptance card', () => {
  it('compiles completely, defender keyword and all', () => {
    const result = compileCard(DOORKEEPER);
    expect(result.status, `missing: ${JSON.stringify(result.missing)}`).toBe('complete');
    expect(result.definition.keywords?.defender).toBe(true);
  });

  it('mills a DERIVED amount, never a fixed one', () => {
    const ability = compileCard(DOORKEEPER).definition.activated![0]!;
    expect(ability.cost.tap).toBe(true);
    expect(ability.cost.mana).toEqual({ generic: 2, U: 1 });
    const ref = ability.effects[0]!;
    expect(ref.primitive).toBe('mill');
    expect(ref.params!.targets).toBe('player');
    // The whole point: a number here instead of a descriptor is a Doorkeeper
    // that mills the same amount on an empty board and on a wall deck.
    expect(ref.params!.amount).toEqual({ countOf: 'creaturesYouControlWithDefender' });
  });
});

// --- the count is real on a board ------------------------------------------------

function defenderDef(id: string, defender: boolean): CardDefinition {
  return {
    id,
    name: id,
    types: ['creature'],
    power: 0,
    toughness: 4,
    cost: { generic: 1 },
    ...(defender ? { keywords: { defender: true } } : {}),
  };
}

function place(state: GameState, def: CardDefinition, controller: PlayerId): void {
  state.battlefield.push({
    instanceId: state.nextInstanceId++,
    def,
    controller,
    owner: controller,
    zone: 'battlefield',
    tapped: false,
    summoningSick: false,
    damageMarked: 0,
    markedByDeathtouch: false,
    attachedTo: null,
    counters: {},
  } as CardInstance);
}

describe('creaturesYouControlWithDefender — the discriminator', () => {
  it('counts YOUR walls only: not your non-walls, not the opponent\'s walls', () => {
    const filler = defenderDef('filler', false);
    const { state } = createGame({
      seed: 3,
      decks: {
        A: { cards: Array.from({ length: 40 }, () => filler) },
        B: { cards: Array.from({ length: 40 }, () => filler) },
      },
    });
    place(state, defenderDef('wall-a1', true), 'A');
    place(state, defenderDef('wall-a2', true), 'A');
    place(state, defenderDef('bear-a', false), 'A');
    place(state, defenderDef('wall-b', true), 'B');
    // A land must not count even if something odd happens to it.
    state.battlefield.push({
      instanceId: state.nextInstanceId++,
      def: { id: 'forest', name: 'forest', types: ['land'], keywords: { defender: true } },
      controller: 'A',
      owner: 'A',
      zone: 'battlefield',
      tapped: false,
      summoningSick: false,
      damageMarked: 0,
      markedByDeathtouch: false,
      attachedTo: null,
      counters: {},
    } as CardInstance);

    expect(evaluateDerivedCount(state, 'creaturesYouControlWithDefender', 'A')).toBe(2);
    expect(evaluateDerivedCount(state, 'creaturesYouControlWithDefender', 'B')).toBe(1);
    // The unnarrowed row must NOT have quietly become the narrowed one.
    expect(evaluateDerivedCount(state, 'creaturesYouControl', 'A')).toBe(3);
  });
});

// --- what stays reported, and exactly why -----------------------------------------

describe('Axebane Guardian compiles WHOLE (§3.164)', () => {
  it('reads "Add X mana in any combination of colors" as a board-derived amount over five colour modes', () => {
    /**
     * HISTORY. Until §3.164 this test pinned the card as REPORTED, and the
     * reason was real: `ManaAbility.produces` is a fixed list and
     * `TapForManaAction.mode` an INDEX into it, so "X mana in any combination
     * of colors" — a multiset choice of size X over five colours, X moving with
     * the board — had no honest home, and approximating it ("any ONE color",
     * five fixed pips) would have handed a wall deck an ability the card does
     * not print. §3.164 kept the mode list fixed (one mode per colour, its
     * length never moving) and put the SIZE in `ManaAbility.amount`, read at
     * activation, with `anyCombination` letting one activation carry a split
     * across the modes. That is the printed ability, so the pin flips.
     */
    const result = compileCard(
      card({
        name: 'Axebane Guardian',
        oracleText:
          'Defender\n{T}: Add X mana in any combination of colors, where X is the number of creatures you control with defender.',
      }),
    );
    expect(result.status).toBe('complete');
    const ability = result.definition.manaAbilities?.[0];
    expect(ability?.amount).toEqual({ countOf: 'creaturesYouControlWithDefender' });
    expect(ability?.anyCombination).toBe(true);
  });
});
