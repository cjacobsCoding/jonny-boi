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
import { colorsOfDefinition, convertedManaCost, formatManaCost, phyrexianLifeOptions } from '@jonny-boi/core';
import type { CardDefinition } from '@jonny-boi/core';
import { CARD_POOL } from '../../data/pool.js';
import { STUBBED_MECHANICS } from '../index.js';
import { CORE_PRIMITIVE_IDS } from '../primitives.js';
import { compileCard, compileCards, UNPAYABLE_MANA_SYMBOL_GAP } from './compile.js';
import { explainUnsupported } from './rules.js';
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
  // EMPTY, and that is the news: every remaining pool card is either reproduced
  // exactly from its printed text or named in STUBBED_MECHANICS.
  //
  // Tarmogoyf used to live here — the pool pinned a representative 2/3 for a
  // card whose printed box is a formula, and the compiler refused to copy the
  // guess. Characteristic-defining P/T (CR 613.3 layer 7a) closed that gap, so
  // the compiler reproduces the authored Tarmogoyf exactly and the card is held
  // to the full ground-truth check like everything else.
  //
  // Birds of Paradise used to live here too: "{T}: Add one mana of any color" had no
  // faithful form, because a fixed `produces` bundle adds one of EACH colour and
  // would have made Birds tap for five mana. Core's modal `producesOptions` (one
  // tap = one chosen mode) closed that gap, so the compiler now reproduces the
  // authored Birds exactly and the card is held to the full ground-truth check.
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
        // Modal sources (a dual land, Birds of Paradise) carry their modes
        // instead — one tap yields one of them, so the mode LIST must match too.
        expect(definition.producesOptions ?? []).toEqual(authored.producesOptions ?? []);
      }
      // The tapped-entry drawback is a whole turn of tempo — a dual land that
      // forgot it would make every deck containing it simulate too fast.
      expect(definition.entersTapped ?? false).toBe(authored.entersTapped ?? false);

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
    // THE BLOCKED HALF IS NO LONGER A POOL CARD, and that is the news: the last
    // one was Cryptic Command, whose modes are now announced at cast (CR
    // 601.2b/c), so every hand-authored card compiles from its printed text.
    // Liliana compiles (planeswalkers), Tarmogoyf compiles (the star P/T box),
    // Snapcaster compiles (graveyard targeting plus grants on a non-battlefield
    // card).
    //
    // The partition still has to be PROVEN to separate, though — a test whose
    // blocked half is empty by construction would pass even if `compileCards`
    // stopped blocking anything at all. So the blocked half is a split-card
    // RECORD WITH NO FACE DATA — split cards themselves compile now, but only
    // from a record that carries its two faces; this one carries the combined
    // name alone, so both halves would have to be guessed (see
    // `SECOND_CASTABLE_FACE_GAP`).
    const bolt = scryfallFor(CARD_POOL.find((c) => c.name === 'Lightning Bolt')!);
    const liliana = scryfallFor(CARD_POOL.find((c) => c.name === 'Liliana of the Veil')!);
    const goyf = scryfallFor(CARD_POOL.find((c) => c.name === 'Tarmogoyf')!);
    const snapcaster = scryfallFor(CARD_POOL.find((c) => c.name === 'Snapcaster Mage')!);
    const cryptic = scryfallFor(CARD_POOL.find((c) => c.name === 'Cryptic Command')!);
    const split: CompilableCard = {
      id: 'split-fire-ice',
      name: 'Fire // Ice',
      manaCost: { generic: 0, W: 0, U: 0, B: 0, R: 1, G: 0, C: 0, other: [] },
      typeLine: { supertypes: [], types: ['Instant'], subtypes: [] },
      oracleText: 'Fire deals 2 damage divided as you choose among one or two targets.',
      power: null,
      toughness: null,
      keywords: [],
    };

    const { playable, blocked } = compileCards([bolt, liliana, goyf, snapcaster, cryptic, split]);

    expect(playable.map((card) => card.name)).toEqual([
      'Lightning Bolt',
      'Liliana of the Veil',
      'Tarmogoyf',
      'Snapcaster Mage',
      'Cryptic Command',
    ]);
    expect(blocked.map((entry) => entry.card.name)).toEqual(['Fire // Ice']);
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

  // GROUND TRUTH for the target restriction. The printed target phrase is not
  // decoration: "to target creature" and "to target player or planeswalker" are
  // different cards from "to any target", and compiling all three to the same
  // unrestricted `dealDamage` is exactly what made Flame Slash a 1-mana 4-damage
  // any-target spell and let Lava Spike kill creatures.
  //
  // "or planeswalker" is a REAL third kind now that planeswalkers exist: the
  // player-or-planeswalker and creature-or-planeswalker phrases compile to their
  // own restrictions the engine enforces. 'any' is omitted from the
  // params because it IS the default, so an unrestricted card compiles to exactly
  // the data it always did.
  it.each([
    ['any target', undefined],
    ['target creature or player', undefined],
    ['target creature, player, or planeswalker', undefined],
    ['target player or planeswalker', 'playerOrPlaneswalker'],
    ['target player', 'player'],
    ['target creature', 'creature'],
    ['target creature or planeswalker', 'creatureOrPlaneswalker'],
  ])('compiles a damage spell targeting "%s" as targets=%s', (targetPhrase, restriction) => {
    const result = compileCard(
      makeCard({
        name: 'Test Spike',
        typeLine: { supertypes: [], types: ['Sorcery'], subtypes: ['Arcane'] },
        manaCost: { generic: 0, W: 0, U: 0, B: 0, R: 1, G: 0, C: 0, other: [] },
        oracleText: `Test Spike deals 3 damage to ${targetPhrase}.`,
      }),
    );

    expect(result.status, JSON.stringify(result.missing)).toBe('complete');
    expect(result.definition.effects).toEqual([
      {
        primitive: 'dealDamage',
        params: restriction === undefined ? { amount: 3 } : { amount: 3, targets: restriction },
      },
    ]);
  });

  // The same restriction has to survive the two-clause "damage AND you gain life"
  // template, in BOTH its printed spellings — otherwise Sorin's Vengeance (a
  // player-only 10-damage sorcery) compiles back into an any-target spell.
  it.each([
    'Test Helix deals 3 damage to target player or planeswalker and you gain 3 life.',
    'Test Helix deals 3 damage to target player or planeswalker. You gain 3 life.',
  ])('keeps the restriction through the damage-and-lifegain template (%s)', (oracleText) => {
    const result = compileCard(
      makeCard({
        name: 'Test Helix',
        typeLine: { supertypes: [], types: ['Instant'], subtypes: [] },
        manaCost: { generic: 0, W: 1, U: 0, B: 0, R: 1, G: 0, C: 0, other: [] },
        oracleText,
      }),
    );

    expect(result.status, JSON.stringify(result.missing)).toBe('complete');
    expect(result.definition.effects).toEqual([
      { primitive: 'dealDamage', params: { amount: 3, targets: 'playerOrPlaneswalker' } },
      { primitive: 'gainLife', params: { amount: 3 } },
    ]);
  });

  // "Target opponent" is narrower than any restriction the engine can express
  // (it has no "a player who isn't you"), so the compiler must refuse it rather
  // than flatten it to 'player' and let the spell be aimed at its own caster.
  it('refuses a damage spell restricted to an opponent', () => {
    const result = compileCard(
      makeCard({
        name: 'Test Sting',
        typeLine: { supertypes: [], types: ['Sorcery'], subtypes: [] },
        manaCost: { generic: 0, W: 0, U: 0, B: 1, R: 0, G: 0, C: 0, other: [] },
        oracleText: 'Test Sting deals 2 damage to target opponent.',
      }),
    );

    // The engine now HAS a "player who isn't you" restriction, so this card is
    // implementable and must actually be implemented — refusing it would be the
    // compiler being stricter than the engine requires.
    expect(result.status, `missing: ${JSON.stringify(result.missing)}`).toBe('complete');
    expect(result.definition.effects).toEqual([
      { primitive: 'dealDamage', params: { amount: 2, targets: 'opponent' } },
    ]);
  });

  // Removal, combat tricks and counterspells were never aimed wrongly — their
  // primitives already refuse the wrong kind of object. What they lacked was
  // MTG's "a spell with no legal target cannot be cast", which is what made
  // "Counter target spell. You gain 3 life." a free three life on an empty stack.
  it.each([
    ['Destroy target creature.', 'destroyTarget', 'creature'],
    ['Exile target creature.', 'exileTarget', 'creature'],
    ['Tap target creature.', 'tapTarget', 'creature'],
    ['Counter target spell.', 'counterSpell', 'spell'],
  ])('restricts %s to targets=%s', (oracleText, primitive, restriction) => {
    const result = compileCard(
      makeCard({
        name: 'Test Removal',
        typeLine: { supertypes: [], types: ['Instant'], subtypes: [] },
        manaCost: { generic: 1, W: 0, U: 1, B: 0, R: 0, G: 0, C: 0, other: [] },
        oracleText,
      }),
    );

    expect(result.status, JSON.stringify(result.missing)).toBe('complete');
    expect(result.definition.effects?.[0]?.primitive).toBe(primitive);
    expect(result.definition.effects?.[0]?.params?.targets).toBe(restriction);
  });

  it('restricts a targeted pump to a creature', () => {
    const result = compileCard(
      makeCard({
        name: 'Test Growth',
        typeLine: { supertypes: [], types: ['Instant'], subtypes: [] },
        manaCost: { generic: 0, W: 0, U: 0, B: 0, R: 0, G: 1, C: 0, other: [] },
        oracleText: 'Target creature gets +3/+3 until end of turn.',
      }),
    );

    expect(result.status, JSON.stringify(result.missing)).toBe('complete');
    expect(result.definition.effects).toEqual([
      { primitive: 'pumpUntilEndOfTurn', params: { power: 3, toughness: 3, targets: 'creature' } },
    ]);
  });

  // Prowess prints a NEGATIVE type filter. Compiling it as the positive pair
  // instant+sorcery quietly dropped every artifact/enchantment/planeswalker, so
  // Monastery Swiftspear failed to grow off ten cards in this very pool.
  it('compiles "noncreature spell" as a negative trigger filter, not instant+sorcery', () => {
    const result = compileCard(
      makeCard({
        name: 'Test Prowess',
        typeLine: { supertypes: [], types: ['Creature'], subtypes: ['Monk'] },
        manaCost: { generic: 0, W: 0, U: 0, B: 0, R: 1, G: 0, C: 0, other: [] },
        power: 1,
        toughness: 2,
        oracleText: 'Whenever you cast a noncreature spell, Test Prowess gets +1/+1 until end of turn.',
      }),
    );

    expect(result.status, JSON.stringify(result.missing)).toBe('complete');
    expect(result.definition.triggers).toHaveLength(1);
    expect(result.definition.triggers![0]!.condition).toEqual({
      on: 'castSpell',
      who: 'you',
      spellTypeNoneOf: ['creature'],
    });
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

  it('compiles a plain {X} burn spell: the cost carries xCost and the damage reads the cast-time X', () => {
    // A Blaze-shaped card. (Real Fireball adds "divided among any number of
    // targets", which is still a template gap — see the test below.)
    const result = compileCard(
      makeCard({
        name: 'Blaze',
        typeLine: { supertypes: [], types: ['Sorcery'], subtypes: [] },
        manaCost: { generic: 0, W: 0, U: 0, B: 0, R: 1, G: 0, C: 0, other: ['X'] },
        power: null,
        toughness: null,
        oracleText: 'Blaze deals X damage to any target.',
        keywords: [],
      }),
    );

    expect(result.status, JSON.stringify(result.missing)).toBe('complete');
    expect(result.definition.xCost).toBe(1);
    expect(result.definition.cost).toEqual({ R: 1 });
    expect(result.definition.effects).toEqual([
      { primitive: 'dealDamage', params: { amount: { chosenX: true } } },
    ]);
  });

  it('still reports an {X} template the effect table cannot compile (real Fireball)', () => {
    const result = compileCard(
      makeCard({
        name: 'Fireball',
        typeLine: { supertypes: [], types: ['Sorcery'], subtypes: [] },
        manaCost: { generic: 0, W: 0, U: 0, B: 0, R: 1, G: 0, C: 0, other: ['X'] },
        power: null,
        toughness: null,
        oracleText:
          'This spell costs {1} more to cast for each target beyond the first.\nFireball deals X damage divided evenly, rounded down, among any number of targets.',
        keywords: [],
      }),
    );

    expect(result.status).toBe('incomplete');
    expect(result.missing.length).toBeGreaterThan(0);
  });

  it('does NOT read "deals X damage" as the cast-time X on a card whose cost has no {X}', () => {
    // The X here is defined by a clause the compiler cannot read; compiling the
    // damage against a cast-time X that does not exist would deal 0 forever.
    const result = compileCard(
      makeCard({
        name: 'Not An X Cost',
        typeLine: { supertypes: [], types: ['Sorcery'], subtypes: [] },
        manaCost: { generic: 1, W: 0, U: 0, B: 0, R: 1, G: 0, C: 0, other: [] },
        power: null,
        toughness: null,
        oracleText: 'Not An X Cost deals X damage to any target.',
        keywords: [],
      }),
    );

    expect(result.status).toBe('incomplete');
    expect(result.definition.xCost).toBeUndefined();
  });

  /**
   * §3.143 — the two symbol families this probe used to pin as REFUSED now
   * compile, so the probe was flipped rather than deleted: what it is really
   * guarding is that the component table is CLOSED, and a flipped probe with no
   * refusal left in it would stop guarding that the day the table widened.
   */
  it('compiles a Phyrexian symbol into a cost that can be paid with life', () => {
    const result = compileCard(
      makeCard({
        name: 'Phyrexian Thing',
        typeLine: { supertypes: [], types: ['Instant'], subtypes: [] },
        manaCost: { generic: 1, W: 0, U: 0, B: 0, R: 0, G: 0, C: 0, other: ['W/P'] },
        power: null,
        toughness: null,
        oracleText: 'You gain 2 life.',
        keywords: [],
      }),
    );

    expect(result.status).toBe('complete');
    expect(formatManaCost(result.definition.cost ?? {})).toBe('{1}{W/P}');
    // CR 202.3c — the Phyrexian symbol counts as the coloured one, so this is
    // mana value 2 and a WHITE card however it ends up being paid.
    expect(convertedManaCost(result.definition.cost ?? {})).toBe(2);
    expect(colorsOfDefinition(result.definition)).toEqual(['W']);
    expect(phyrexianLifeOptions(result.definition.cost ?? {}, 20)).toEqual([0, 2]);
  });

  it('compiles a monocolour hybrid symbol at its printed mana value (CR 202.3b)', () => {
    const result = compileCard(
      makeCard({
        name: 'Hybrid Thing',
        typeLine: { supertypes: [], types: ['Instant'], subtypes: [] },
        manaCost: { generic: 0, W: 0, U: 0, B: 0, R: 0, G: 0, C: 0, other: ['2/R', '2/R'] },
        power: null,
        toughness: null,
        oracleText: 'You gain 2 life.',
        keywords: [],
      }),
    );

    expect(result.status).toBe('complete');
    expect(formatManaCost(result.definition.cost ?? {})).toBe('{2/R}{2/R}');
    // The GREATEST component, not one per symbol: {2/R}{2/R} is 4, not 2.
    expect(convertedManaCost(result.definition.cost ?? {})).toBe(4);
    expect(colorsOfDefinition(result.definition)).toEqual(['R']);
  });

  /**
   * Two cards, not one, and that is the point: a single card printing BOTH a
   * bare `{S}` and an `{S/W}` reports either way, so it would stay green with
   * the component table wide open. Each unreadable SHAPE is pinned separately —
   * the symbol with no slash (nothing to split), and the symbol whose SHAPE the
   * hybrid regex accepts and whose PIECE the closed table refuses.
   */
  it('still reports a bare symbol outside the component table', () => {
    const result = compileCard(
      makeCard({
        name: 'Snowy Thing',
        typeLine: { supertypes: [], types: ['Instant'], subtypes: [] },
        manaCost: { generic: 1, W: 0, U: 0, B: 0, R: 0, G: 0, C: 0, other: ['S'] },
        power: null,
        toughness: null,
        oracleText: 'You gain 2 life.',
        keywords: [],
      }),
    );

    expect(result.status).toBe('incomplete');
    expect(result.missing.map((gap) => gap.missingEngineSystem)).toContain(UNPAYABLE_MANA_SYMBOL_GAP);
  });

  it('still reports a HYBRID symbol one of whose pieces is outside the table', () => {
    const result = compileCard(
      makeCard({
        name: 'Snowy Hybrid',
        typeLine: { supertypes: [], types: ['Instant'], subtypes: [] },
        manaCost: { generic: 1, W: 0, U: 0, B: 0, R: 0, G: 0, C: 0, other: ['S/W'] },
        power: null,
        toughness: null,
        oracleText: 'You gain 2 life.',
        keywords: [],
      }),
    );

    expect(result.status).toBe('incomplete');
    expect(result.missing.map((gap) => gap.missingEngineSystem)).toContain(UNPAYABLE_MANA_SYMBOL_GAP);
    // The refusal names the symbol, so the next unreadable one is diagnosable.
    expect(result.missing.map((gap) => gap.text)).toContain('{S/W}');
  });

  it('compiles kicker: the cost line, and a kicked rider that runs only when paid', () => {
    // Into-the-Roil-shaped rider on a supported main clause.
    const result = compileCard(
      makeCard({
        name: 'Kicked Bolt',
        typeLine: { supertypes: [], types: ['Instant'], subtypes: [] },
        manaCost: { generic: 0, W: 0, U: 0, B: 0, R: 1, G: 0, C: 0, other: [] },
        power: null,
        toughness: null,
        oracleText:
          'Kicker {1}{U} (You may pay an additional {1}{U} as you cast this spell.)\nKicked Bolt deals 2 damage to any target. If this spell was kicked, draw a card.',
        keywords: ['Kicker'],
      }),
    );

    expect(result.status, JSON.stringify(result.missing)).toBe('complete');
    expect(result.definition.kicker).toEqual({ generic: 1, U: 1 });
    expect(result.definition.effects).toEqual([
      { primitive: 'dealDamage', params: { amount: 2 } },
      { primitive: 'ifKicked', params: { effects: [{ primitive: 'drawCards', params: { count: 1 } }] } },
    ]);
  });

  it('compiles the "deals M damage instead" kicked form as one switched damage ref (Burst Lightning)', () => {
    const result = compileCard(
      makeCard({
        name: 'Burst Lightning',
        typeLine: { supertypes: [], types: ['Instant'], subtypes: [] },
        manaCost: { generic: 0, W: 0, U: 0, B: 0, R: 1, G: 0, C: 0, other: [] },
        power: null,
        toughness: null,
        oracleText:
          'Kicker {4} (You may pay an additional {4} as you cast this spell.)\nBurst Lightning deals 2 damage to any target. If this spell was kicked, it deals 4 damage to that target instead.',
        keywords: ['Kicker'],
      }),
    );

    expect(result.status, JSON.stringify(result.missing)).toBe('complete');
    expect(result.definition.kicker).toEqual({ generic: 4 });
    expect(result.definition.effects).toEqual([
      { primitive: 'dealDamage', params: { amount: { base: 2, kicked: 4 } } },
    ]);
  });

  it('compiles multikicker as a COUNT, never flattened into a single kick', () => {
    const result = compileCard(
      makeCard({
        name: 'Multi Thing',
        typeLine: { supertypes: [], types: ['Sorcery'], subtypes: [] },
        manaCost: { generic: 1, W: 0, U: 0, B: 0, R: 1, G: 0, C: 0, other: [] },
        power: null,
        toughness: null,
        oracleText: 'Multikicker {R}\nMulti Thing deals 2 damage to any target.',
        keywords: ['Multikicker'],
      }),
    );

    expect(result.status, `missing: ${JSON.stringify(result.missing)}`).toBe('complete');
    // `multikicker`, NOT `kicker`: the two ask different questions (a count vs a
    // yes/no), and compiling one as the other would cap the card at one kick.
    expect(result.definition.multikicker).toEqual({ R: 1 });
    expect(result.definition.kicker).toBeUndefined();
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
    // Menace was the example here, then ward, then indestructible, then SKULK —
    // every one of them is implemented now, and the stand-in has had to move each
    // time. (Skulk went, then HORSEMANSHIP — §3.102 gave it a `KeywordFlags` flag
    // and a `blockRestriction` naming that flag, alongside fear and intimidate
    // whose exceptions name a colour or a card type instead. Then CUMULATIVE
    // UPKEEP, until §3.106 made it an upkeep trigger with an age-scaled bill.)
    // The point of the test has never changed: an ability we cannot model
    // must be REPORTED, never silently dropped.
    // BANDING is the current stand-in:
    // the Alpha combat-grouping rule (CR 702.22) whose damage-assignment half
    // needs the defending player to divide an attacker's damage among a band,
    // which is a combat system rather than a flag.
    const result = compileCard(
      makeCard({
        name: 'Banded Beast',
        typeLine: { supertypes: [], types: ['Creature'], subtypes: ['Beast'] },
        manaCost: { generic: 2, W: 0, U: 0, B: 0, R: 0, G: 1, C: 0, other: [] },
        power: 3,
        toughness: 3,
        oracleText: 'Banding',
        keywords: ['Banding'],
      }),
    );

    expect(result.status).toBe('incomplete');
    expect(result.missing.some((gap) => /banding/i.test(gap.text))).toBe(true);
  });

  it('compiles SKULK, which IS modelled now', () => {
    const result = compileCard(
      makeCard({
        name: 'Sneaky Rogue',
        typeLine: { supertypes: [], types: ['Creature'], subtypes: ['Rogue'] },
        manaCost: { generic: 1, W: 0, U: 0, B: 1, R: 0, G: 0, C: 0, other: [] },
        power: 2,
        toughness: 1,
        oracleText: 'Skulk',
        keywords: ['Skulk'],
      }),
    );

    expect(result.status).toBe('complete');
    expect(result.definition?.keywords?.blockRestriction).toEqual({ blockerPowerAtMostMine: true });
  });

  it('compiles menace, which IS modelled now', () => {
    const result = compileCard(
      makeCard({
        name: 'Menacing Beast',
        typeLine: { supertypes: [], types: ['Creature'], subtypes: ['Beast'] },
        manaCost: { generic: 2, W: 0, U: 0, B: 0, R: 0, G: 1, C: 0, other: [] },
        power: 3,
        toughness: 3,
        oracleText: 'Menace',
        keywords: ['Menace'],
      }),
    );

    expect(result.status, `missing: ${JSON.stringify(result.missing)}`).toBe('complete');
    expect(result.definition.keywords).toMatchObject({ menace: true });
  });


  it('compiles fear, intimidate and horsemanship into block restrictions (§3.102)', () => {
    // Three keywords, one shape: "can't be blocked except by creatures that ARE
    // something". Compiled as `blockRestriction` payloads rather than bare flags,
    // because the rule is a per-pair legality test — which is what that structure
    // is for, and what `canBlock` already enforces.
    const compile = (name: string, keyword: string, colors: readonly string[]) =>
      compileCard(
        makeCard({
          name,
          typeLine: { supertypes: [], types: ['Creature'], subtypes: ['Horror'] },
          manaCost: { generic: 2, W: 0, U: 0, B: 0, R: 0, G: 0, C: 0, other: [] },
          power: 2,
          toughness: 2,
          colors: colors as never,
          oracleText: keyword,
          keywords: [keyword],
        }),
      );

    const fear = compile('Feared Thing', 'Fear', ['B']);
    expect(fear.status, `missing: ${JSON.stringify(fear.missing)}`).toBe('complete');
    expect(fear.definition.keywords?.blockRestriction?.blockerMustMatchAnyOf).toEqual([
      { kind: 'artifact' },
      { kind: 'color', color: 'B' },
    ]);

    const intimidate = compile('Intimidating Thing', 'Intimidate', ['R']);
    expect(intimidate.status, `missing: ${JSON.stringify(intimidate.missing)}`).toBe('complete');
    expect(intimidate.definition.keywords?.blockRestriction?.blockerMustMatchAnyOf).toEqual([
      { kind: 'artifact' },
      { kind: 'sharesColorWithAttacker' },
    ]);

    // Horsemanship carries BOTH halves: the flag is what a blocker is checked
    // for, the restriction is what names it. One without the other is a horseman
    // no horseman can block, or a keyword nothing reads.
    const horse = compile('Wei Rider', 'Horsemanship', ['R']);
    expect(horse.status, `missing: ${JSON.stringify(horse.missing)}`).toBe('complete');
    expect(horse.definition.keywords).toMatchObject({ horsemanship: true });
    expect(horse.definition.keywords?.blockRestriction?.blockerMustHaveAnyOf).toEqual(['horsemanship']);
  });
  it('compiles devoid into printed colourlessness (§3.104)', () => {
    // ⚠️ THE WHOLE POINT IS THE COLOURED PIPS. Colour is DERIVED from the cost
    // when `CardDefinition.colors` is absent, so a devoid card costing {3}{B}
    // that merely compiled would play as a BLACK creature — a legal target for
    // "destroy target black creature", stopped by protection from black, and
    // counted by every anyOfColors filter. Asserting only `status === complete`
    // would pass on exactly that broken card.
    const result = compileCard(
      makeCard({
        name: 'Eldrazi Drone',
        typeLine: { supertypes: [], types: ['Creature'], subtypes: ['Eldrazi', 'Drone'] },
        manaCost: { generic: 3, W: 0, U: 0, B: 1, R: 0, G: 0, C: 0, other: [] },
        power: 3,
        toughness: 3,
        colors: [] as never,
        oracleText: 'Devoid',
        keywords: ['Devoid'],
      }),
    );
    expect(result.status, `missing: ${JSON.stringify(result.missing)}`).toBe('complete');
    // `[]` and not absent: absent means "read my pips", which is the bug.
    expect(result.definition.colors).toEqual([]);
    expect(colorsOfDefinition(result.definition)).toEqual([]);

    // The control: the SAME cost without devoid is black, which is what makes
    // the assertion above evidence of anything.
    const coloured = compileCard(
      makeCard({
        name: 'Ordinary Horror',
        typeLine: { supertypes: [], types: ['Creature'], subtypes: ['Horror'] },
        manaCost: { generic: 3, W: 0, U: 0, B: 1, R: 0, G: 0, C: 0, other: [] },
        power: 3,
        toughness: 3,
        colors: ['B'] as never,
        oracleText: '',
        keywords: [],
      }),
    );
    expect(colorsOfDefinition(coloured.definition)).toEqual(['B']);
  });
  it('compiles bushido into a blocks-or-becomes-blocked trigger (§3.103)', () => {
    // Scryfall prints the payload on the LINE ("Bushido 1") and the bare word in
    // `keywords` ("Bushido"). Both have to be answered: the line by the rule, the
    // word by the sweep's TRIGGER_BACKED_KEYWORDS table. Answering only the first
    // is what this card did for one build — the ability compiled and the card
    // still reported the keyword as unmodelled.
    const compile = (name: string, line: string) =>
      compileCard(
        makeCard({
          name,
          typeLine: { supertypes: [], types: ['Creature'], subtypes: ['Rat', 'Samurai'] },
          manaCost: { generic: 3, W: 0, U: 0, B: 0, R: 0, G: 0, C: 0, other: [] },
          power: 3,
          toughness: 2,
          colors: ['B'] as never,
          oracleText: line,
          keywords: ['Bushido'],
        }),
      );

    const one = compile('Nezumi Ronin', 'Bushido 1');
    expect(one.status, `missing: ${JSON.stringify(one.missing)}`).toBe('complete');
    expect(one.definition.triggers).toHaveLength(1);
    const trigger = one.definition.triggers?.[0];
    expect(trigger?.condition.on).toBe('blocksOrBecomesBlocked');
    expect(trigger?.effects).toEqual([
      { primitive: 'pumpUntilEndOfTurn', params: { power: 1, toughness: 1 } },
    ]);

    // The number is the whole payload, so it has to reach the pump — a bushido
    // that always pumped +1/+1 would play every Samurai in the block weaker
    // than printed.
    const two = compile('Kentaro, the Smiling Cat', 'Bushido 2');
    expect(two.status, `missing: ${JSON.stringify(two.missing)}`).toBe('complete');
    expect(two.definition.triggers?.[0]?.effects).toEqual([
      { primitive: 'pumpUntilEndOfTurn', params: { power: 2, toughness: 2 } },
    ]);

    // ⚠️ The sweep guard is keyed on COMPILED EVIDENCE, not on the word. A
    // bushido whose line the rule table cannot match must still report, or the
    // table would absolve exactly the cards it failed to implement.
    const unparsed = compile('Bushido Mystery', 'Bushido X');
    expect(unparsed.status).not.toBe('complete');
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

  // A tapped dual land is three printed abilities at once (enters tapped, a
  // modal mana ability, an ETB trigger) and every one of them is modelled, so
  // the whole card is genuinely playable.
  it('compiles a tapped dual land whose mana ability offers a choice', () => {
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

    expect(result.status, JSON.stringify(result.missing)).toBe('complete');
    expect(result.definition.entersTapped).toBe(true);
    // ONE tap is worth one mana of either colour — two modes, never a bundle.
    expect(result.definition.producesOptions).toEqual([{ U: 1 }, { B: 1 }]);
    expect(result.definition.produces).toBeUndefined();
    expect(result.definition.triggers?.[0]?.effects).toEqual([
      { primitive: 'gainLife', params: { amount: 1 } },
    ]);
  });

  it('compiles "add one mana of any color" as five single-colour modes', () => {
    const result = compileCard(
      makeCard({
        name: 'Manalith',
        typeLine: { supertypes: [], types: ['Artifact'], subtypes: [] },
        manaCost: { generic: 3, W: 0, U: 0, B: 0, R: 0, G: 0, C: 0, other: [] },
        oracleText: '{T}: Add one mana of any color.',
      }),
    );

    expect(result.status, JSON.stringify(result.missing)).toBe('complete');
    expect(result.definition.producesOptions).toEqual([
      { W: 1 },
      { U: 1 },
      { B: 1 },
      { R: 1 },
      { G: 1 },
    ]);
  });

  it('compiles a mana ability whose colours depend on the board', () => {
    const result = compileCard(
      makeCard({
        name: 'Board-Dependent Land',
        typeLine: { supertypes: [], types: ['Land'], subtypes: [] },
        oracleText: '{T}: Add one mana of any color that a land you control could produce.',
      }),
    );

    expect(result.status, JSON.stringify(result.missing)).toBe('complete');
    // The derivation is recorded, NOT the answer: which colours are actually
    // available is asked of the live board every time the ability is offered, so
    // no board's answer is ever frozen onto this shared definition.
    // (mana-templates.test.ts pins the whole partition.)
    expect(result.definition.manaAbilities).toEqual([{ derivedColors: 'landsYouControl' }]);
  });

  it('still reports a mana colour derived from an object the engine does not have', () => {
    const result = compileCard(
      makeCard({
        name: 'Command Tower',
        typeLine: { supertypes: [], types: ['Land'], subtypes: [] },
        oracleText: "{T}: Add one mana of any color in your commander's color identity.",
      }),
    );
    expect(result.status).toBe('incomplete');
    expect(result.missing.map((gap) => gap.missingEngineSystem).join(' | ')).toContain('commander');
  });

  it('compiles a self-pumping cast trigger (the printed prowess template)', () => {
    const result = compileCard(
      makeCard({
        name: 'Kiln Fiend',
        typeLine: { supertypes: [], types: ['Creature'], subtypes: ['Elemental'] },
        manaCost: { generic: 1, W: 0, U: 0, B: 0, R: 1, G: 0, C: 0, other: [] },
        power: 1,
        toughness: 1,
        oracleText:
          'Whenever you cast an instant or sorcery spell, Kiln Fiend gets +3/+0 until end of turn.',
      }),
    );

    expect(result.status, JSON.stringify(result.missing)).toBe('complete');
    expect(result.definition.triggers).toHaveLength(2); // one per spell type
    for (const trigger of result.definition.triggers!) {
      expect(trigger.effects).toEqual([
        { primitive: 'pumpUntilEndOfTurn', params: { power: 3, toughness: 0 } },
      ]);
    }
  });

  // A triggered ability is AIMED as it goes on the stack now (core's
  // `TriggeredAbility.targets`), so a body that names a target compiles — and the
  // restriction has to travel onto the ability, because the ability is what gets
  // aimed. A trigger carrying the effects but not the restriction would be aimed
  // at nothing and resolve blank, which is the failure this asserts against.
  it.each([
    [
      'When Aimed Kavu enters, Aimed Kavu deals 4 damage to target creature.',
      'creature',
      [{ primitive: 'dealDamage', params: { amount: 4, targets: 'creature' } }],
    ],
    [
      'When Aimed Kavu enters, Aimed Kavu deals 2 damage to any target.',
      'any',
      [{ primitive: 'dealDamage', params: { amount: 2 } }],
    ],
    [
      'When Aimed Kavu enters, destroy target creature.',
      'creature',
      [{ primitive: 'destroyTarget', params: { targets: 'creature' } }],
    ],
    [
      'Whenever Aimed Kavu attacks, target creature gets +2/+2 until end of turn.',
      'creature',
      [{ primitive: 'pumpUntilEndOfTurn', params: { power: 2, toughness: 2, targets: 'creature' } }],
    ],
  ])('compiles a trigger that names a target (%s)', (oracleText, restriction, effects) => {
    const result = compileCard(aimedKavu(oracleText));

    expect(result.status, JSON.stringify(result.missing)).toBe('complete');
    expect(result.definition.triggers).toHaveLength(1);
    const trigger = result.definition.triggers![0]!;
    expect(trigger.targets).toBe(restriction);
    expect(trigger.effects).toEqual(effects);
  });

  it('leaves an untargeted trigger declaring NO targets at all', () => {
    // The absence matters: `targets` present means "stop and aim me", so an ETB
    // that draws a card must not acquire one.
    const result = compileCard(aimedKavu('When Aimed Kavu enters, draw a card.'));
    expect(result.status).toBe('complete');
    expect(result.definition.triggers![0]!.targets).toBeUndefined();
  });

  it('REFUSES a trigger body that would need two separate targets', () => {
    // One printed template, two aims. Quietly pointing both halves at one object
    // would be a card playing differently from its text, so it keeps reporting.
    const result = compileCard(
      aimedKavu('When Aimed Kavu enters, destroy target creature. Aimed Kavu deals 2 damage to any target.'),
    );
    expect(result.status).toBe('incomplete');
    expect(result.definition.triggers ?? []).toHaveLength(0);
  });
});

/**
 * The rejection message is a product surface twice over: the import dialog shows
 * it to the user, and `data/expansion-report.json` groups by it to rank what
 * engine work would unlock the most real cards. "A rules template the compiler
 * does not recognize yet" tells nobody anything, so the common printed shapes
 * must each name a buildable feature.
 */
describe('explainUnsupported — every common rejection names a real engine feature', () => {
  const DEFAULT_EXPLANATION = 'a rules template the compiler does not recognize yet';

  it.each([
    ['pyroclasm deals 2 damage to each creature', 'a group-damage template the compiler does not recognize yet'],
    // A trigger that names a target COMPILES now — core aims it as the ability
    // goes on the stack — so the example here has to be a targeted trigger whose
    // BODY still has no template: two separate targets in one ability.
    [
      'when ~ enters, return two target creatures to their owners\' hands',
      'a targeted-trigger template the compiler does not recognize yet',
    ],
    ['destroy target artifact or enchantment', 'a filtered-targeting template the compiler does not recognize yet'],
    ['counter target noncreature spell', 'a filtered-targeting template the compiler does not recognize yet'],
    // "Counter target spell unless its controller pays {3}" COMPILES now (Mana
    // Leak — see `optional-payment.test.ts`), so the example here has to be a
    // payment shape that still does not: the mechanism exists, this template
    // does not.
    ['destroy target creature unless its controller pays {2}', 'an optional-payment template the compiler does not recognize yet'],
    ['other creatures you control get +1/+1', 'a static-buff template the compiler does not recognize yet'],
    ['gain control of target creature until end of turn', 'a gain-control template the compiler does not recognize yet'],
    ['target creature you control fights target creature you don\'t control', 'a fight template the compiler does not recognize yet'],
    ['when ~ leaves the battlefield, create a 3/3 green beast creature token', 'a leaves-the-battlefield template the compiler does not recognize yet'],
    ['cascade', 'named keyword mechanics with their own subsystem'],
    [
      'when ~ enters, it deals 4 damage to target creature with flying',
      'a targeted-trigger template the compiler does not recognize yet',
    ],
    ['you draw two cards and lose 2 life', 'a compound draw/lose template the compiler does not recognize yet'],
  ])('explains %s', (clause, expected) => {
    expect(explainUnsupported(clause)).toBe(expected);
  });

  it('still falls back to the generic explanation for genuinely novel text', () => {
    expect(explainUnsupported('do a barrel roll')).toBe(DEFAULT_EXPLANATION);
  });
});

/** Build a `CompilableCard` for a synthetic test card. */
/** A 2/2 creature whose only printed line is `oracleText` — the trigger fixture. */
function aimedKavu(oracleText: string): CompilableCard {
  return makeCard({
    name: 'Aimed Kavu',
    typeLine: { supertypes: [], types: ['Creature'], subtypes: ['Beast'] },
    manaCost: { generic: 2, W: 0, U: 0, B: 0, R: 1, G: 0, C: 0, other: [] },
    power: 2,
    toughness: 2,
    oracleText,
  });
}

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
