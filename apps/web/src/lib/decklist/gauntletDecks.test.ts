/**
 * Gauntlet decks in the deck builder.
 *
 * The trap here is the id mismatch: sim decks name cards, web decks use Scryfall
 * UUIDs. A copy that silently dropped what it could not resolve would hand back a
 * short deck that looks fine — so these pin that a copy is either complete, or
 * reports exactly what is missing.
 */
import { describe, expect, it } from 'vitest';
import { SAMPLE_DECKS } from '@jonny-boi/sim';
import {
  copiesOfGauntletDeck,
  copyGauntletDeck,
  describeExistingCopies,
  describeGauntletCopy,
  gauntletDecks,
  gauntletHeroDecks,
  isGauntletDeckId,
  GAUNTLET_DECK_ID_PREFIX,
} from './gauntletDecks.js';
import { deckSize } from '../deck.js';
import { getCard } from '../cards.js';
import { toSimPayload } from '../sim-format.js';
import { unsupportedCardNames } from '../deck.js';

/** Total cards in a bundled sim deck. */
function simSize(deck: (typeof SAMPLE_DECKS)[number]): number {
  return deck.cards.reduce((n, e) => n + e.count, 0);
}

describe('listing the gauntlet decks', () => {
  it('lists every bundled deck with its archetype and size', () => {
    const list = gauntletDecks();
    expect(list.length).toBe(SAMPLE_DECKS.length);
    expect(list.length).toBeGreaterThan(0);
    for (const entry of list) {
      expect(entry.name.length).toBeGreaterThan(0);
      expect(entry.archetype.length).toBeGreaterThan(0);
      expect(entry.size).toBe(simSize(entry.deck));
    }
  });

  it('reports the real deck size (the gauntlet decks are full decks)', () => {
    for (const entry of gauntletDecks()) {
      expect(entry.size).toBeGreaterThanOrEqual(60);
    }
  });
});

describe('copying a gauntlet deck into an editable one', () => {
  it('resolves every card, so the copy is the same size as the original', () => {
    for (const sample of SAMPLE_DECKS) {
      const copy = copyGauntletDeck(sample);
      expect(copy.unresolved, `${sample.name} had unresolved cards`).toEqual([]);
      expect(deckSize(copy.deck), `${sample.name} changed size when copied`).toBe(simSize(sample));
    }
  });

  it('converts card NAMES into pool UUIDs, which is what the builder keys on', () => {
    const copy = copyGauntletDeck(SAMPLE_DECKS[0]!);
    for (const entry of copy.deck.cards) {
      // Every id must resolve in the pool — a leftover name would silently break
      // every downstream surface (art, curve, validation, play).
      expect(getCard(entry.cardId), `unresolvable id ${entry.cardId}`).toBeDefined();
    }
  });

  /**
   * The mint site of the provenance the built-in list reads. Pinned HERE as well
   * as at the view, because the two claims are different: the view test proves
   * the list SAYS "already copied" when a deck carries provenance; this proves a
   * copy actually gets it. Breaking only the stamp left the view test green.
   */
  it('stamps the copy with the built-in deck it came from', () => {
    for (const sample of SAMPLE_DECKS) {
      const copy = copyGauntletDeck(sample);
      expect(copy.deck.copiedFrom, `${sample.name} copy lost its provenance`).toBe(sample.name);
    }
  });

  it('reports a copy that already exists, by the COPY’s name after a rename', () => {
    const sample = SAMPLE_DECKS[0]!;
    const mine = { ...copyGauntletDeck(sample).deck, name: 'Acidic Angels' };
    // The reported defect in one assertion: a renamed copy must still be found.
    const found = copiesOfGauntletDeck(sample.name, [mine]);
    expect(found).toHaveLength(1);
    expect(describeExistingCopies(found)).toContain('Acidic Angels');
    // ...and must not be attributed to a different built-in deck.
    expect(copiesOfGauntletDeck(SAMPLE_DECKS[1]!.name, [mine])).toEqual([]);
  });

  it('does not count the Lab hero decks as copies the user has made', () => {
    // `gauntletHeroDecks()` runs the same copy path, so they carry provenance
    // too. Counting them would report every built-in deck as already copied
    // before the user had copied anything.
    const heroes = gauntletHeroDecks();
    for (const sample of SAMPLE_DECKS) {
      expect(copiesOfGauntletDeck(sample.name, heroes), `${sample.name}`).toEqual([]);
    }
  });

  it('gives the copy its own identity so editing it cannot touch the original', () => {
    const sample = SAMPLE_DECKS[0]!;
    const a = copyGauntletDeck(sample);
    const b = copyGauntletDeck(sample);
    expect(a.deck.id).not.toBe(b.deck.id);
    expect(a.deck.name).toContain(sample.name);
    expect(a.deck.name).not.toBe(sample.name); // suffixed, so it reads as a copy
    // Mutating the copy must not reach the bundled data.
    a.deck.cards[0]!.count = 99;
    expect(simSize(sample)).toBe(simSize(SAMPLE_DECKS[0]!));
  });

  it('merges duplicate entries rather than emitting the same card twice', () => {
    const copy = copyGauntletDeck({
      name: 'Dupes',
      archetype: 'test',
      cards: [
        { cardId: 'Forest', count: 2 },
        { cardId: 'Forest', count: 3 },
      ],
    } as (typeof SAMPLE_DECKS)[number]);
    expect(copy.deck.cards).toHaveLength(1);
    expect(copy.deck.cards[0]!.count).toBe(5);
  });

  it('REPORTS a name the pool does not know instead of quietly shrinking the deck', () => {
    const copy = copyGauntletDeck({
      name: 'Partly Unknown',
      archetype: 'test',
      cards: [
        { cardId: 'Forest', count: 4 },
        { cardId: 'Definitely Not A Real Card', count: 4 },
      ],
    } as (typeof SAMPLE_DECKS)[number]);

    expect(copy.unresolved).toEqual(['Definitely Not A Real Card']);
    expect(deckSize(copy.deck)).toBe(4);
    expect(describeGauntletCopy(copy)).toContain('Definitely Not A Real Card');
  });

  it('says plainly when a copy is complete', () => {
    const copy = copyGauntletDeck(SAMPLE_DECKS[0]!);
    const text = describeGauntletCopy(copy);
    expect(text).toContain('ready to edit');
    expect(text).not.toContain('could not be resolved');
  });
});

describe('gauntlet decks are selectable as the Lab hero', () => {
  it('offers every gauntlet deck as a full, legal hero deck', () => {
    const heroes = gauntletHeroDecks();
    expect(heroes).toHaveLength(SAMPLE_DECKS.length);
    for (const hero of heroes) {
      expect(isGauntletDeckId(hero.id), `${hero.name} needs a gauntlet id`).toBe(true);
      // A hero must be a real, complete deck or the Lab refuses to run it. These
      // are the two conditions `lib/heroValidation.ts` gates on.
      expect(deckSize(hero), `${hero.name} is not a full deck`).toBeGreaterThanOrEqual(60);
      expect(
        unsupportedCardNames(hero),
        `${hero.name} holds a card the engine cannot play`,
      ).toEqual([]);
    }
  });

  it('keeps the EXACT deck name, so the Lab excludes it from its own opponents', () => {
    const heroes = gauntletHeroDecks();
    for (const sample of SAMPLE_DECKS) {
      const hero = heroes.find((h) => h.id === `${GAUNTLET_DECK_ID_PREFIX}${sample.name}`);
      expect(hero, `no hero for ${sample.name}`).toBeDefined();
      // The Lab filters opponents by name; a suffix here would make a deck fight
      // itself, which is both nonsense and a silently skewed win rate.
      expect(hero!.name).toBe(sample.name);
      const opponents = SAMPLE_DECKS.filter((d) => d.name !== hero!.name);
      expect(opponents).toHaveLength(SAMPLE_DECKS.length - 1);
    }
  });

  it('gives gauntlet heroes stable ids, so a selection survives a reload', () => {
    expect(gauntletHeroDecks().map((d) => d.id)).toEqual(gauntletHeroDecks().map((d) => d.id));
    expect(isGauntletDeckId('gauntlet:Mono-Red Aggro')).toBe(true);
    expect(isGauntletDeckId('local-1234'), 'a saved deck is not a gauntlet deck').toBe(false);
  });

  it('converts to a sim payload the harness can actually load', () => {
    for (const hero of gauntletHeroDecks()) {
      const payload = toSimPayload(hero);
      expect(payload.name).toBe(hero.name);
      const size = payload.cards.reduce((n, e) => n + e.count, 0);
      expect(size, `${hero.name} lost cards converting to a sim payload`).toBeGreaterThanOrEqual(60);
    }
  });

  it('legacy: a complete copy still reports cleanly', () => {
    const copy = copyGauntletDeck(SAMPLE_DECKS[0]!);
    const text = describeGauntletCopy(copy);
    expect(text).toContain('ready to edit');
    expect(text).not.toContain('could not be resolved');
  });
});
