/**
 * Compiler tests.
 *
 * The headline test is a GROUND-TRUTH comparison: take the 32 cards a human
 * hand-authored in `data/pool.ts`, feed the compiler nothing but their real
 * Scryfall Oracle text, and check that it independently arrives at the same
 * engine definition. That is the only honest way to claim "imported cards are
 * real" — the compiler has to agree with the cards we already trust.
 *
 * The second headline test is the inverse: every card the humans flagged in
 * `STUBBED_MECHANICS` as needing an engine system we lack must be reported
 * `'incomplete'` by the compiler. A compiler that cheerfully "compiles"
 * Liliana of the Veil would be lying, and that lie would silently corrupt the
 * A/B verdicts the whole deck lab produces.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { CardDefinition } from '@jonny-boi/core';
import { CARD_POOL } from '../../data/pool.js';
import { STUBBED_MECHANICS } from '../index.js';
import { CORE_PRIMITIVE_IDS } from '../primitives.js';
import { compileCard, compileCards } from './compile.js';
import type { CompilableCard } from './types.js';

/** The normalized Scryfall index the pool joins to (produced by data-tools). */
const CARD_INDEX_PATH = fileURLToPath(
  new URL('../../../data-tools/data/card-index.json', import.meta.url),
);

interface CardIndexFile {
  readonly cards: readonly CompilableCard[];
}

const index = JSON.parse(readFileSync(CARD_INDEX_PATH, 'utf8')) as CardIndexFile;
const byId = new Map(index.cards.map((card) => [card.id, card]));

/** The Scryfall record for an authored pool card (they join on Scryfall id). */
function scryfallFor(definition: CardDefinition): CompilableCard {
  const card = byId.get(definition.id);
  if (!card) throw new Error(`no Scryfall record for authored card ${definition.name}`);
  return card;
}

/** Names the humans documented as needing an engine system we do not have. */
const STUBBED_NAMES = new Set(STUBBED_MECHANICS.map((entry) => entry.card));

/**
 * Cards where the hand-authored pool made an approximation the compiler refuses
 * to make. These are NOT compiler bugs — they are places the compiler is
 * stricter than the humans were, and each one names the engine system that would
 * have to exist before the card could be imported for real.
 *
 * Kitchen Finks is the sharpest example: it costs {1}{G/W}{G/W}, and the pool
 * authors dropped the hybrid pips entirely, so the pool plays a 3-mana 3/2 for
 * one mana. The compiler reports the hybrid cost instead of shipping that.
 */
const HUMAN_APPROXIMATIONS: Readonly<Record<string, string>> = Object.freeze({
  Tarmogoyf: 'dynamic power/toughness (characteristic-defining */*)',
  // Birds of Paradise taps for ONE mana of any color. Core's `produces` is a
  // fixed list and `applyTapForMana` adds one of EACH listed color, so the
  // authored `['W','U','B','R','G']` makes Birds tap for FIVE mana. The
  // compiler refuses to reproduce that; a faithful Birds needs a mana ability
  // whose color is chosen on activation.
  'Birds of Paradise': 'mana abilities that produce a chosen color',
});

/** True when the compiler is expected to be stricter than the authored pool. */
function isApproximated(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(HUMAN_APPROXIMATIONS, name);
}

describe('compileCard — ground truth against the hand-authored pool', () => {
  it('has a Scryfall record for every authored card (the join key holds)', () => {
    for (const definition of CARD_POOL) {
      expect(() => scryfallFor(definition), definition.name).not.toThrow();
    }
  });

  // The card frame — cost, types, P/T, mana production — must match the humans
  // for EVERY card, including the ones whose text we cannot fully implement.
  // A stubbed card still has to be the right creature for the right cost.
  for (const authored of CARD_POOL) {
    it(`compiles the correct frame for ${authored.name}`, () => {
      const scryfall = scryfallFor(authored);
      const { definition } = compileCard(scryfall);

      expect(definition.id).toBe(authored.id);
      expect(definition.name).toBe(authored.name);
      expect([...definition.types].sort()).toEqual([...authored.types].sort());
      // Mana production is order-insensitive ({C}{C} vs multi-symbol lists).
      // Skipped where the pool's own mana data is an approximation the compiler
      // declines to copy (see HUMAN_APPROXIMATIONS — Birds of Paradise).
      if (!isApproximated(authored.name)) {
        expect([...(definition.produces ?? [])].sort()).toEqual(
          [...(authored.produces ?? [])].sort(),
        );
      }

      // Printed P/T must match — unless it is characteristic-defining (`*`),
      // where the pool authored a fixed guess and the compiler declines to.
      if (scryfall.power !== null && scryfall.toughness !== null) {
        expect(definition.power).toBe(authored.power);
        expect(definition.toughness).toBe(authored.toughness);
      } else {
        expect(definition.power).toBeUndefined();
      }

      // Cost must match unless the printed cost uses symbols the engine cannot
      // pay ({X}, hybrid, Phyrexian) — reported rather than silently dropped.
      if (scryfall.manaCost.other.length === 0) {
        expect(definition.cost ?? {}).toEqual(authored.cost ?? {});
      }
    });
  }

  // For the cards the humans fully implemented, the compiler must independently
  // produce the same behavior: the same primitives with the same parameters.
  const fullyAuthored = CARD_POOL.filter(
    (card) => !STUBBED_NAMES.has(card.name) && !isApproximated(card.name),
  );
  for (const authored of fullyAuthored) {
    it(`independently reproduces the authored behavior of ${authored.name}`, () => {
      const result = compileCard(scryfallFor(authored));

      expect(result.status, `missing: ${JSON.stringify(result.missing)}`).toBe('complete');
      expect(effectSignature(result.definition)).toEqual(effectSignature(authored));
      expect(triggerSignature(result.definition)).toEqual(triggerSignature(authored));
      expect(result.definition.keywords ?? {}).toEqual(authored.keywords ?? {});
    });
  }
});

describe('compileCard — honesty about what the engine cannot do', () => {
  for (const stub of STUBBED_MECHANICS) {
    const authored = CARD_POOL.find((card) => card.name === stub.card);
    if (!authored) continue;
    it(`refuses to claim ${stub.card} is complete (needs ${stub.missingEngineSystem})`, () => {
      const result = compileCard(scryfallFor(authored));
      expect(result.status).toBe('incomplete');
      expect(result.missing.length).toBeGreaterThan(0);
      // Every reported gap must carry a human-readable explanation — this text
      // is shown to the user in the import UI, so it can never be empty.
      for (const gap of result.missing) {
        expect(gap.text.length).toBeGreaterThan(0);
        expect(gap.missingEngineSystem.length).toBeGreaterThan(0);
      }
    });
  }

  for (const [name, expectedGap] of Object.entries(HUMAN_APPROXIMATIONS)) {
    it(`is stricter than the authored pool on ${name} (needs ${expectedGap})`, () => {
      const authored = CARD_POOL.find((card) => card.name === name);
      expect(authored, `${name} is no longer in the pool`).toBeDefined();

      const result = compileCard(scryfallFor(authored!));
      expect(result.status).toBe('incomplete');
      expect(result.missing.map((gap) => gap.missingEngineSystem)).toContain(expectedGap);
    });
  }

  it('never emits an effect referencing an unregistered primitive', () => {
    const known = new Set(CORE_PRIMITIVE_IDS);
    for (const authored of CARD_POOL) {
      const { definition } = compileCard(scryfallFor(authored));
      const refs = [
        ...(definition.effects ?? []),
        ...(definition.triggers ?? []).flatMap((trigger) => trigger.effects),
      ];
      for (const ref of refs) {
        expect(known.has(ref.primitive), `${authored.name} → ${ref.primitive}`).toBe(true);
      }
    }
  });

  it('partitions a mixed list into playable and blocked', () => {
    const bolt = scryfallFor(CARD_POOL.find((c) => c.name === 'Lightning Bolt')!);
    const liliana = scryfallFor(CARD_POOL.find((c) => c.name === 'Liliana of the Veil')!);

    const { playable, blocked } = compileCards([bolt, liliana]);

    expect(playable.map((card) => card.name)).toEqual(['Lightning Bolt']);
    expect(blocked.map((entry) => entry.card.name)).toEqual(['Liliana of the Veil']);
    expect(blocked[0]!.missing.length).toBeGreaterThan(0);
  });
});

describe('compileCard — templated cards outside the curated pool', () => {
  it('compiles a vanilla creature with evergreen keywords', () => {
    const result = compileCard(
      makeCard({
        name: 'Serra Angel',
        typeLine: { supertypes: [], types: ['Creature'], subtypes: ['Angel'] },
        manaCost: { generic: 3, W: 2, U: 0, B: 0, R: 0, G: 0, C: 0, other: [] },
        power: 4,
        toughness: 4,
        oracleText: 'Flying, vigilance',
        keywords: ['Flying', 'Vigilance'],
      }),
    );

    expect(result.status).toBe('complete');
    expect(result.definition.keywords).toEqual({ flying: true, vigilance: true });
    expect(result.definition.cost).toEqual({ generic: 3, W: 2 });
  });

  it('compiles an enters-the-battlefield trigger', () => {
    const result = compileCard(
      makeCard({
        name: 'Wall of Omens',
        typeLine: { supertypes: [], types: ['Creature'], subtypes: ['Wall'] },
        manaCost: { generic: 1, W: 1, U: 0, B: 0, R: 0, G: 0, C: 0, other: [] },
        power: 0,
        toughness: 4,
        oracleText: 'Defender\nWhen Wall of Omens enters, draw a card.',
        keywords: ['Defender'],
      }),
    );

    expect(result.status).toBe('complete');
    expect(result.definition.triggers).toHaveLength(1);
    expect(result.definition.triggers![0]!.condition.on).toBe('etb');
    expect(result.definition.triggers![0]!.effects).toEqual([
      { primitive: 'drawCards', params: { count: 1 } },
    ]);
  });

  it('compiles a multi-effect spell sentence by sentence', () => {
    const result = compileCard(
      makeCard({
        name: 'Test Bolt Plus',
        typeLine: { supertypes: [], types: ['Instant'], subtypes: [] },
        manaCost: { generic: 1, W: 0, U: 0, B: 0, R: 1, G: 0, C: 0, other: [] },
        power: null,
        toughness: null,
        oracleText: 'Test Bolt Plus deals 2 damage to any target. You gain 2 life.',
        keywords: [],
      }),
    );

    expect(result.status).toBe('complete');
    expect(result.definition.effects).toEqual([
      { primitive: 'dealDamage', params: { amount: 2 } },
      { primitive: 'gainLife', params: { amount: 2 } },
    ]);
  });

  // Modern burn spells print "target player or planeswalker" rather than the
  // older "target player". The engine has no planeswalkers, so that choice can
  // only resolve to the player — the spell is fully implementable.
  it.each([
    'target player or planeswalker',
    'any target',
    'target creature or player',
    'target creature, player, or planeswalker',
  ])('compiles a damage spell targeting "%s"', (targetPhrase) => {
    const result = compileCard(
      makeCard({
        name: 'Lava Spike',
        typeLine: { supertypes: [], types: ['Sorcery'], subtypes: ['Arcane'] },
        manaCost: { generic: 0, W: 0, U: 0, B: 0, R: 1, G: 0, C: 0, other: [] },
        oracleText: `Lava Spike deals 3 damage to ${targetPhrase}.`,
      }),
    );

    expect(result.status, JSON.stringify(result.missing)).toBe('complete');
    expect(result.definition.effects).toEqual([
      { primitive: 'dealDamage', params: { amount: 3 } },
    ]);
  });

  it('strips reminder text rather than reporting it as unsupported', () => {
    const result = compileCard(
      makeCard({
        name: 'Vanilla Flyer',
        typeLine: { supertypes: [], types: ['Creature'], subtypes: ['Bird'] },
        manaCost: { generic: 1, W: 0, U: 1, B: 0, R: 0, G: 0, C: 0, other: [] },
        power: 2,
        toughness: 1,
        oracleText: 'Flying (This creature can only be blocked by creatures with flying or reach.)',
        keywords: ['Flying'],
      }),
    );

    expect(result.status).toBe('complete');
    expect(result.definition.keywords).toEqual({ flying: true });
  });

  it('reports an {X} cost instead of pretending it is free', () => {
    const result = compileCard(
      makeCard({
        name: 'Fireball',
        typeLine: { supertypes: [], types: ['Sorcery'], subtypes: [] },
        manaCost: { generic: 0, W: 0, U: 0, B: 0, R: 1, G: 0, C: 0, other: ['{X}'] },
        power: null,
        toughness: null,
        oracleText: 'Fireball deals X damage to any target.',
        keywords: [],
      }),
    );

    expect(result.status).toBe('incomplete');
    expect(result.missing.map((gap) => gap.missingEngineSystem)).toContain(
      'variable ({X}), Phyrexian, and monocolour hybrid mana costs',
    );
  });

  it('compiles a colour/colour hybrid cost the mana system can pay', () => {
    const result = compileCard(
      makeCard({
        name: 'Hybrid Bear',
        typeLine: { supertypes: [], types: ['Creature'], subtypes: ['Bear'] },
        manaCost: { generic: 1, W: 0, U: 0, B: 0, R: 0, G: 0, C: 0, other: ['G/W', 'G/W'] },
        power: 3,
        toughness: 2,
        oracleText: '',
      }),
    );

    expect(result.status, JSON.stringify(result.missing)).toBe('complete');
    expect(result.definition.cost).toEqual({
      generic: 1,
      hybrid: [
        ['G', 'W'],
        ['G', 'W'],
      ],
    });
  });

  it('reports an unmodelled keyword rather than dropping the ability', () => {
    const result = compileCard(
      makeCard({
        name: 'Sneaky Beast',
        typeLine: { supertypes: [], types: ['Creature'], subtypes: ['Beast'] },
        manaCost: { generic: 2, W: 0, U: 0, B: 0, R: 0, G: 1, C: 0, other: [] },
        power: 3,
        toughness: 3,
        oracleText: 'Menace',
        keywords: ['Menace'],
      }),
    );

    expect(result.status).toBe('incomplete');
    expect(result.missing.some((gap) => /menace/i.test(gap.text))).toBe(true);
  });

  it('compiles "enters tapped" onto the definition', () => {
    const result = compileCard(
      makeCard({
        name: 'Simple Tapland',
        typeLine: { supertypes: [], types: ['Land'], subtypes: [] },
        oracleText: 'Simple Tapland enters tapped.\n{T}: Add {U}.',
      }),
    );

    expect(result.status, JSON.stringify(result.missing)).toBe('complete');
    expect(result.definition.entersTapped).toBe(true);
    expect(result.definition.produces).toEqual(['U']);
  });

  it('still reports a dual land whose mana ability offers a choice', () => {
    const result = compileCard(
      makeCard({
        name: 'Dismal Backwater',
        typeLine: { supertypes: [], types: ['Land'], subtypes: [] },
        manaCost: { generic: 0, W: 0, U: 0, B: 0, R: 0, G: 0, C: 0, other: [] },
        power: null,
        toughness: null,
        oracleText: 'Dismal Backwater enters tapped.\n{T}: Add {U} or {B}.\nWhen Dismal Backwater enters, you gain 1 life.',
        keywords: [],
      }),
    );

    expect(result.status).toBe('incomplete');
    // "Enters tapped" is implemented now; the choice of {U} or {B} is not.
    expect(result.definition.entersTapped).toBe(true);
    expect(result.missing.map((gap) => gap.missingEngineSystem)).toContain(
      'mana abilities that produce a chosen color',
    );
  });
});

/** Build a `CompilableCard` for a synthetic test card. */
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

/** Primitive+params of a definition's spell/ETB script, for comparison. */
function effectSignature(definition: CardDefinition): unknown[] {
  return (definition.effects ?? []).map((ref) => [ref.primitive, ref.params ?? {}]);
}

/**
 * Condition + effects of every trigger, order-insensitive (the compiler emits
 * one trigger per spell type; the authored pool lists them in its own order).
 */
function triggerSignature(definition: CardDefinition): unknown[] {
  return (definition.triggers ?? [])
    .map((trigger) => [
      trigger.condition.on,
      trigger.condition.who ?? 'you',
      trigger.condition.spellType ?? '',
      trigger.effects.map((ref) => [ref.primitive, ref.params ?? {}]),
    ])
    .map((entry) => JSON.stringify(entry))
    .sort();
}
