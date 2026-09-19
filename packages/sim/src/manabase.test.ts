/**
 * THE MANABASE GENERATOR (DESIGN §3.175) — the enumerated family for a known deck
 * is EXACTLY the list the rules say, label for label; the variant deck is the
 * base rewritten in place; the ladder adapter round-trips.
 *
 * The exact-list tests run on a hand-built pool, so the assertion is about the
 * GENERATOR'S RULES and cannot drift when the shipped pool regenerates. A second
 * block runs the real pool and checks the structural promises (every type
 * variant is a plain dual of the deck's colours, one per signature, all legal).
 */

import { describe, expect, it } from 'vitest';
import type { CardDefinition } from '@jonny-boi/core';
import type { CardPool } from '@jonny-boi/cards';
import { buildRegistry, loadCardPool } from '@jonny-boi/cards';
import { createGame } from '@jonny-boi/core';
import { BOROS_AGGRO, SELESNYA_BLINK, MONO_RED_AGGRO } from '../data/decks/index.js';
import type { Deck } from './deck.js';
import { loadDeck, validateDeck } from './deck.js';
import {
  applyManabase,
  colorMixVariants,
  dualLandFamilyOf,
  dualSignatureOf,
  generateManabaseVariants,
  landCountVariants,
  landTypeVariants,
  manabaseCandidateOf,
  summarizeManabase,
  variantForCandidateKey,
  MANABASE_BASE_REF,
} from './manabase.js';
import { DUAL_LAND_FAMILIES, LAND_COUNT_SWEEP_RADIUS, LAND_TYPE_VARIANT_COPIES } from './manabase-config.js';
import { swappedInstanceIdsFor } from './paired-arms.js';
import { candidateKey } from './suggest-history.js';

// --- a hand-built pool: the rules are what is under test, not the shipped data ------

const land = (name: string, extra: Partial<CardDefinition> = {}): CardDefinition => ({
  id: name.toLowerCase().replace(/\s+/g, '-'),
  name,
  types: ['land'],
  ...extra,
});
const spell = (name: string, cost: CardDefinition['cost']): CardDefinition => ({
  id: name.toLowerCase().replace(/\s+/g, '-'),
  name,
  types: ['creature'],
  cost,
  power: 1,
  toughness: 1,
});

const FOREST = land('Forest', { subtypes: ['forest'], basic: true, produces: ['G'] });
const PLAINS = land('Plains', { subtypes: ['plains'], basic: true, produces: ['W'] });
const ISLAND = land('Island', { subtypes: ['island'], basic: true, produces: ['U'] });
const SWAMP = land('Swamp', { subtypes: ['swamp'], basic: true, produces: ['B'] });

/** One plain GW dual per family, plus the shapes that must NOT be offered. */
const TEST_SHOCK = land('Test Shock', { subtypes: ['forest', 'plains'], entersTappedUnlessLifePaid: 2, producesOptions: [{ G: 1 }, { W: 1 }] });
const TEST_CHECK = land('Test Check', { entersTappedUnless: { controlsSubtype: ['forest', 'plains'] }, producesOptions: [{ G: 1 }, { W: 1 }] });
const TEST_GATE = land('Test Gate', { subtypes: ['gate'], entersTapped: true, producesOptions: [{ G: 1 }, { W: 1 }] });
const TEST_GATE_TWO = land('Test Gate Two', { entersTapped: true, producesOptions: [{ W: 1 }, { G: 1 }] });
const TEST_TYPED_TAPLAND = land('Test Typed Tapland', { subtypes: ['forest', 'plains'], entersTapped: true, producesOptions: [{ G: 1 }, { W: 1 }] });
const TEST_TRUE_DUAL = land('Test True Dual', { subtypes: ['forest', 'plains'], producesOptions: [{ G: 1 }, { W: 1 }] });
const TEST_GAINLAND = land('Test Gainland', {
  entersTapped: true,
  producesOptions: [{ G: 1 }, { W: 1 }],
  triggers: [{ condition: { on: 'etb' }, effects: [{ primitive: 'gainLife', params: { amount: 1 } }], label: 'gain 1' }],
} as Partial<CardDefinition>);
const TEST_UB_DUAL = land('Test UB Dual', { entersTapped: true, producesOptions: [{ U: 1 }, { B: 1 }] });
const TEST_TRILAND = land('Test Triland', { entersTapped: true, producesOptions: [{ G: 1 }, { W: 1 }, { U: 1 }] });

const ELF = spell('Elf', { G: 1 });
const PUMP = spell('Pump', { G: 1 });
const KNIGHT = spell('Knight', { generic: 1, W: 1 });
const BLESSING = spell('Blessing', { generic: 1, W: 1 });
const CLERIC = spell('Cleric', { generic: 1, W: 1 });
const BEAR = spell('Bear', { generic: 1, G: 1 });
const RANGER = spell('Ranger', { generic: 2, G: 1 });
const BEAST = spell('Beast', { generic: 2, G: 1 });
const GIANT = spell('Giant', { generic: 3, W: 1 });
const ANGEL = spell('Angel', { generic: 3, W: 2 });
const HYDRA = spell('Hydra', { generic: 4, G: 2 });

const TEST_CARDS: readonly CardDefinition[] = [
  FOREST, PLAINS, ISLAND, SWAMP,
  TEST_SHOCK, TEST_CHECK, TEST_GATE, TEST_GATE_TWO, TEST_TYPED_TAPLAND, TEST_TRUE_DUAL, TEST_GAINLAND, TEST_UB_DUAL, TEST_TRILAND,
  ELF, PUMP, KNIGHT, BLESSING, CLERIC, BEAR, RANGER, BEAST, GIANT, ANGEL, HYDRA,
];

function testPool(cards: readonly CardDefinition[] = TEST_CARDS): CardPool {
  const byId = new Map(cards.map((c) => [c.id, c] as const));
  const byName = new Map(cards.map((c) => [c.name, c] as const));
  return {
    cards,
    get: (id) => byId.get(id),
    getByName: (name) => byName.get(name),
    unsupportedRefs: [],
    attachmentProblems: [],
  };
}

/** A fixed two-colour deck: 22 lands (12 Forest, 10 Plains), 38 spells, 60 cards. */
const TEST_GW: Deck = {
  name: 'Test GW',
  archetype: 'test',
  cards: [
    { cardId: 'Elf', count: 4 },
    { cardId: 'Pump', count: 4 },
    { cardId: 'Knight', count: 3 },
    { cardId: 'Blessing', count: 3 },
    { cardId: 'Cleric', count: 2 },
    { cardId: 'Bear', count: 4 },
    { cardId: 'Ranger', count: 4 },
    { cardId: 'Beast', count: 4 },
    { cardId: 'Giant', count: 4 },
    { cardId: 'Angel', count: 4 },
    { cardId: 'Hydra', count: 2 },
    { cardId: 'Forest', count: 12 },
    { cardId: 'Plains', count: 10 },
  ],
};

const deckSize = (deck: Deck): number => deck.cards.reduce((sum, e) => sum + e.count, 0);

describe('the base manabase summary', () => {
  it('reads lands, basics by colour, the spells’ pips and the deck’s colours', () => {
    const summary = summarizeManabase(TEST_GW, testPool());
    expect(summary.deckSize).toBe(60);
    expect(summary.landCount).toBe(22);
    expect(summary.basics).toEqual([
      { name: 'Forest', color: 'G', count: 12 },
      { name: 'Plains', color: 'W', count: 10 },
    ]);
    // G pips: Elf 4 + Pump 4 + Bear 4 + Ranger 4 + Beast 4 + Hydra 2×2 = 24; W: Knight 3 + Blessing 3 + Cleric 2 + Giant 4 + Angel 4×2 = 20.
    expect(summary.pips).toEqual({ W: 20, G: 24 });
    expect(summary.colors).toEqual(['W', 'G']);
    expect(summary.description).toBe('22 lands — 12 Forest, 10 Plains · spells need W ×20, G ×24');
  });

  it('refuses a deck with a card the pool cannot resolve rather than guessing', () => {
    const broken: Deck = { ...TEST_GW, cards: [...TEST_GW.cards, { cardId: 'Nonesuch', count: 1 }] };
    expect(() => summarizeManabase(broken, testPool())).toThrow(/Nonesuch/);
  });
});

describe('the land-COUNT sweep is exactly the enumerated list', () => {
  it('trades the most-played basic for the cheapest nonland with room (or the copies), ±k', () => {
    const { variants, skipped } = landCountVariants(TEST_GW, testPool());
    expect(LAND_COUNT_SWEEP_RADIUS).toBe(2);
    expect(skipped).toEqual([]);
    // Cutting a land ADDS a nonland: the 1-drops are all 4-ofs (no room), so the
    // cheapest eligible is a 2-drop — Blessing (3 copies, alphabetically before
    // Knight) for one copy, Cleric (2 copies) for two. Adding a land CUTS the
    // cheapest nonland that has the copies: Elf (before Pump alphabetically).
    expect(variants.map((v) => [v.key, v.label, v.landCount, v.slotsChanged])).toEqual([
      ['count:-1', '21 lands (−1 Forest, +1 Blessing)', 21, 1],
      ['count:+1', '23 lands (+1 Forest, −1 Elf)', 23, 1],
      ['count:-2', '20 lands (−2 Forest, +2 Cleric)', 20, 2],
      ['count:+2', '24 lands (+2 Forest, −2 Elf)', 24, 2],
    ]);
    expect(variants[0]?.steps).toEqual([{ outId: 'forest', outName: 'Forest', inId: 'blessing', inName: 'Blessing', copies: 1 }]);
    expect(variants[1]?.steps).toEqual([{ outId: 'elf', outName: 'Elf', inId: 'forest', inName: 'Forest', copies: 1 }]);
  });

  it('reports a deck with no basics as skipped instead of inventing a land', () => {
    const noBasics: Deck = {
      ...TEST_GW,
      cards: TEST_GW.cards.filter((e) => e.cardId !== 'Forest' && e.cardId !== 'Plains').concat([{ cardId: 'Test Gate', count: 4 }]),
    };
    const { variants, skipped } = landCountVariants(noBasics, testPool());
    expect(variants).toEqual([]);
    expect(skipped).toEqual([{ kind: 'count', label: 'land count sweep', reason: 'the deck runs no basic land to add or cut' }]);
  });

  it('reports the step it cannot fill when every nonland is a full playset', () => {
    // Boros Aggro is nine 4-ofs: nothing has room, so every CUT step is skipped
    // by name, while the ADD steps (cut a 4-of for a Plains) exist.
    const pool = loadCardPool({ onWarn: () => {} });
    const { variants, skipped } = landCountVariants(BOROS_AGGRO, pool);
    expect(variants.map((v) => v.key)).toEqual(['count:+1', 'count:+2']);
    expect(skipped.map((s) => s.reason)).toEqual([
      'no nonland has room for 1 more copy',
      'no nonland has room for 2 more copies',
    ]);
  });
});

describe('the colour-MIX sweep is exactly the enumerated list', () => {
  it('shifts basics between the two types, ±1 and ±2, one orientation per pair', () => {
    const { variants, skipped } = colorMixVariants(TEST_GW, testPool());
    expect(skipped).toEqual([]);
    expect(variants.map((v) => [v.key, v.label])).toEqual([
      ['mix:Forest>Plains:1', 'Forest/Plains 12/10 → 11/11'],
      ['mix:Plains>Forest:1', 'Forest/Plains 12/10 → 13/9'],
      ['mix:Forest>Plains:2', 'Forest/Plains 12/10 → 10/12'],
      ['mix:Plains>Forest:2', 'Forest/Plains 12/10 → 14/8'],
    ]);
    expect(variants.every((v) => v.landCount === 22)).toBe(true);
  });

  it('a one-basic deck has nothing to shift and says so', () => {
    const { variants, skipped } = colorMixVariants(MONO_RED_AGGRO, loadCardPool({ onWarn: () => {} }));
    expect(variants).toEqual([]);
    expect(skipped[0]?.reason).toMatch(/only one basic land type \(Mountain\)/);
  });
});

describe('the land-TYPE sweep is exactly the enumerated list', () => {
  it('offers one plain dual per family and signature, in entry-speed order, naming the equivalents', () => {
    const { variants, skipped } = landTypeVariants(TEST_GW, testPool());
    expect(skipped).toEqual([]);
    expect(variants.map((v) => [v.key, v.label, v.family])).toEqual([
      ['type:test-true-dual', '4 Test True Dual for 2 Forest + 2 Plains', 'untapped'],
      ['type:test-shock', '4 Test Shock for 2 Forest + 2 Plains', 'shock'],
      ['type:test-check', '4 Test Check for 2 Forest + 2 Plains', 'check'],
      // Two tapped signatures: typed (fetchable) and untyped; the untyped one
      // stands for its twin rather than being tested twice.
      ['type:test-gate', '4 Test Gate for 2 Forest + 2 Plains', 'tapped'],
      ['type:test-typed-tapland', '4 Test Typed Tapland for 2 Forest + 2 Plains', 'tapped'],
    ]);
    expect(variants.find((v) => v.key === 'type:test-gate')?.note).toBe('enters tapped — also stands for Test Gate Two');
    expect(variants.find((v) => v.key === 'type:test-shock')?.note).toBe('shockland — pay 2 life or enters tapped');
    // Every type variant is a playset replacing two basics of each colour.
    for (const v of variants) {
      expect(v.slotsChanged).toBe(LAND_TYPE_VARIANT_COPIES);
      expect(v.steps.map((s) => [s.outName, s.copies])).toEqual([
        ['Forest', 2],
        ['Plains', 2],
      ]);
    }
    // Never offered: the gainland (a trigger), the off-colour dual, the tri-land.
    const offered = variants.map((v) => v.steps[0]?.inName);
    expect(offered).not.toContain('Test Gainland');
    expect(offered).not.toContain('Test UB Dual');
    expect(offered).not.toContain('Test Triland');
  });

  it('skips a dual the deck already runs, and an equivalent of one it runs, by name', () => {
    const withGate: Deck = {
      ...TEST_GW,
      cards: TEST_GW.cards.map((e) => (e.cardId === 'Forest' ? { ...e, count: 8 } : e)).concat([{ cardId: 'Test Gate', count: 4 }]),
    };
    const { variants, skipped } = landTypeVariants(withGate, testPool());
    expect(variants.map((v) => v.key)).toEqual(['type:test-true-dual', 'type:test-shock', 'type:test-check', 'type:test-typed-tapland']);
    expect(skipped).toEqual([
      { kind: 'type', label: '4 Test Gate for 2 Forest + 2 Plains', reason: 'Test Gate is already in the deck' },
      { kind: 'type', label: '4 Test Gate Two for 2 Forest + 2 Plains', reason: 'the deck already runs an equivalent land (Test Gate)' },
    ]);
  });

  it('skips a colour pair the deck lacks the basics for, saying how many it has', () => {
    const thinPlains: Deck = {
      ...TEST_GW,
      cards: TEST_GW.cards.map((e) => (e.cardId === 'Plains' ? { ...e, count: 1 } : e.cardId === 'Forest' ? { ...e, count: 21 } : e)),
    };
    const { variants, skipped } = landTypeVariants(thinPlains, testPool());
    expect(variants).toEqual([]);
    expect(skipped[0]?.reason).toBe('needs 2 Forest and 2 Plains to replace; the deck has 21 and 1');
  });

  it('honours the family filter', () => {
    const { variants } = landTypeVariants(TEST_GW, testPool(), ['shock', 'check']);
    expect(variants.map((v) => v.family)).toEqual(['shock', 'check']);
  });

  it('classifies every entry rule onto the closed family table', () => {
    expect(dualLandFamilyOf(TEST_SHOCK)).toBe('shock');
    expect(dualLandFamilyOf(TEST_CHECK)).toBe('check');
    expect(dualLandFamilyOf(TEST_GATE)).toBe('tapped');
    expect(dualLandFamilyOf(TEST_TRUE_DUAL)).toBe('untapped');
    expect(dualLandFamilyOf(land('Fast', { entersTappedUnless: { maxOtherLands: 2 } }))).toBe('fast');
    expect(dualLandFamilyOf(land('Slow', { entersTappedUnless: { minOtherLands: 2 } }))).toBe('slow');
    expect(dualLandFamilyOf(land('Battle', { entersTappedUnless: { minBasicLands: 2 } }))).toBe('battle');
    expect(dualLandFamilyOf(land('Odd', { entersTappedUnless: { anyPlayerLifeAtMost: 13 } }))).toBe('conditional');
    expect(dualLandFamilyOf(land('Reveal', { entersTappedUnlessRevealed: { subtypes: ['forest'] } } as Partial<CardDefinition>))).toBe('reveal');
    expect(dualSignatureOf(TEST_GATE)).toBe(dualSignatureOf(TEST_GATE_TWO));
    expect(dualSignatureOf(TEST_GATE)).not.toBe(dualSignatureOf(TEST_TYPED_TAPLAND));
    expect(DUAL_LAND_FAMILIES.map((f) => f.id)).toContain(dualLandFamilyOf(TEST_SHOCK));
  });
});

describe('the whole family', () => {
  it('is the three sweeps, legality-checked, with every skip reported', () => {
    const sweep = generateManabaseVariants(TEST_GW, testPool());
    expect(sweep.variants.map((v) => v.key)).toEqual([
      'count:-1', 'count:+1', 'count:-2', 'count:+2',
      'mix:Forest>Plains:1', 'mix:Plains>Forest:1', 'mix:Forest>Plains:2', 'mix:Plains>Forest:2',
      'type:test-true-dual', 'type:test-shock', 'type:test-check', 'type:test-gate', 'type:test-typed-tapland',
    ]);
    expect(sweep.skipped).toEqual([]);
    for (const variant of sweep.variants) {
      expect(validateDeck(applyManabase(TEST_GW, variant, testPool()), testPool())).toEqual([]);
    }
  });

  it('can be narrowed to one sweep', () => {
    const sweep = generateManabaseVariants(TEST_GW, testPool(), { sweeps: { count: false, mix: true, type: false } });
    expect(sweep.variants.every((v) => v.kind === 'mix')).toBe(true);
    expect(sweep.variants).toHaveLength(4);
  });
});

describe('applyManabase builds the base deck rewritten IN PLACE', () => {
  it('a type variant changes exactly its slots — and nothing else', () => {
    const pool = testPool();
    const [variant] = landTypeVariants(TEST_GW, pool, ['shock']).variants;
    const built = applyManabase(TEST_GW, variant!, pool);
    expect(built.name).toBe('Test GW — 4 Test Shock for 2 Forest + 2 Plains');
    expect(deckSize(built)).toBe(60);
    // Land entries: two Forests and two Plains became four Test Shocks, in place.
    const counts = new Map<string, number>();
    for (const e of built.cards) counts.set(e.cardId, (counts.get(e.cardId) ?? 0) + e.count);
    expect(counts.get('Forest')).toBe(10);
    expect(counts.get('Plains')).toBe(8);
    expect(counts.get('test-shock')).toBe(4);
    // Every nonland line is untouched.
    for (const e of TEST_GW.cards) {
      if (e.cardId !== 'Forest' && e.cardId !== 'Plains') expect(counts.get(e.cardId)).toBe(e.count);
    }
    // The flat libraries differ in exactly four slots — the paired runner's
    // identical-game skip reasons over precisely these.
    const baseLib = loadDeck(TEST_GW, pool).library;
    const builtLib = loadDeck(built, pool).library;
    expect(swappedInstanceIdsFor(baseLib, builtLib)).toHaveLength(4);
  });

  it('a count variant moves one slot and keeps the size', () => {
    const pool = testPool();
    const variant = landCountVariants(TEST_GW, pool).variants.find((v) => v.key === 'count:-1')!;
    const built = applyManabase(TEST_GW, variant, pool);
    expect(deckSize(built)).toBe(60);
    expect(swappedInstanceIdsFor(loadDeck(TEST_GW, pool).library, loadDeck(built, pool).library)).toHaveLength(1);
    expect(built.cards.find((e) => e.cardId === 'blessing')?.count).toBe(1);
    expect(built.cards.filter((e) => e.cardId === 'Blessing' || e.cardId === 'blessing').reduce((s, e) => s + e.count, 0)).toBe(4);
  });

  it('gathers copies across split lines of the same basic', () => {
    const pool = testPool();
    const split: Deck = {
      ...TEST_GW,
      cards: TEST_GW.cards.flatMap((e) => (e.cardId === 'Forest' ? [{ cardId: 'Forest', count: 1 }, { cardId: 'forest', count: 11 }] : [e])),
    };
    const variant = landTypeVariants(split, pool, ['shock']).variants[0]!;
    const built = applyManabase(split, variant, pool);
    expect(deckSize(built)).toBe(60);
    expect(built.cards.filter((e) => e.cardId === 'test-shock').reduce((s, e) => s + e.count, 0)).toBe(4);
    expect(swappedInstanceIdsFor(loadDeck(split, pool).library, loadDeck(built, pool).library)).toHaveLength(4);
  });

  it('throws when a step cannot be honoured, rather than building a deck that differs from its label', () => {
    const pool = testPool();
    const variant = landTypeVariants(TEST_GW, pool, ['shock']).variants[0]!;
    const fewer: Deck = { ...TEST_GW, cards: TEST_GW.cards.map((e) => (e.cardId === 'Plains' ? { ...e, count: 1 } : e)) };
    expect(() => applyManabase(fewer, variant, pool)).toThrow(/Plains/);
  });
});

describe('the ladder adapter', () => {
  it('a variant round-trips through the candidate key', () => {
    const pool = testPool();
    const sweep = generateManabaseVariants(TEST_GW, pool);
    for (const variant of sweep.variants) {
      const candidate = manabaseCandidateOf(variant, sweep.base, TEST_GW.name);
      expect(candidate.key).toBe(candidateKey(MANABASE_BASE_REF, variant.key));
      expect(candidate.inName).toBe(variant.label);
      expect(candidate.copiesSwapped).toBe(variant.slotsChanged);
      expect(variantForCandidateKey(candidate.key, sweep.variants)).toBe(variant);
    }
    expect(variantForCandidateKey('Forest>Plains', sweep.variants)).toBeUndefined();
  });
});

describe('on the shipped pool', () => {
  const pool = loadCardPool({ onWarn: () => {} });

  it('every Selesnya Blink type variant is a plain dual of its colours, one per signature, and legal', () => {
    const sweep = generateManabaseVariants(SELESNYA_BLINK, pool);
    const types = sweep.variants.filter((v) => v.kind === 'type');
    expect(types.length).toBeGreaterThan(3);
    const signatures = new Set<string>();
    for (const variant of types) {
      const def = pool.get(variant.steps[0]!.inId)!;
      expect(def.types).toContain('land');
      expect(dualLandFamilyOf(def)).toBe(variant.family);
      const signature = dualSignatureOf(def);
      expect(signatures.has(signature)).toBe(false);
      signatures.add(signature);
      expect(validateDeck(applyManabase(SELESNYA_BLINK, variant, pool), pool)).toEqual([]);
    }
    // The deck runs Selesnya Guildgate (enters tapped, untyped): that signature is
    // skipped by name rather than tested against itself.
    expect(sweep.skipped.some((s) => /equivalent land \(Selesnya Guildgate\)/.test(s.reason))).toBe(true);
    // Count and mix on real data: the labels read as designed.
    expect(sweep.variants.filter((v) => v.kind === 'count').map((v) => v.label)).toEqual([
      '23 lands (−1 Forest, +1 Elvish Visionary)',
      '25 lands (+1 Forest, −1 Cloudshift)',
      '22 lands (−2 Forest, +2 Elvish Visionary)',
      '26 lands (+2 Forest, −2 Cloudshift)',
    ]);
    expect(sweep.variants.filter((v) => v.kind === 'mix').map((v) => v.label)).toEqual([
      'Forest/Plains 8/8 → 7/9',
      'Forest/Plains 8/8 → 9/7',
      'Forest/Plains 8/8 → 6/10',
      'Forest/Plains 8/8 → 10/6',
    ]);
  });

  it('a built variant shuffles identically to the base apart from its slots (the CRN property)', () => {
    const variant = generateManabaseVariants(SELESNYA_BLINK, pool).variants.find((v) => v.kind === 'type')!;
    const base = loadDeck(SELESNYA_BLINK, pool);
    const built = loadDeck(applyManabase(SELESNYA_BLINK, variant, pool), pool);
    const registry = buildRegistry();
    const opponent = loadDeck(MONO_RED_AGGRO, pool);
    const a = createGame({ seed: 7, startingPlayer: 'A', registry, decks: { A: { cards: base.library }, B: { cards: opponent.library } } });
    const b = createGame({ seed: 7, startingPlayer: 'A', registry, decks: { A: { cards: built.library }, B: { cards: opponent.library } } });
    const orderA = [...a.state.players.A.hand, ...a.state.players.A.library].map((c) => c.def.name);
    const orderB = [...b.state.players.A.hand, ...b.state.players.A.library].map((c) => c.def.name);
    let differing = 0;
    for (let i = 0; i < orderA.length; i++) if (orderA[i] !== orderB[i]) differing++;
    expect(differing).toBe(LAND_TYPE_VARIANT_COPIES);
  });
});
