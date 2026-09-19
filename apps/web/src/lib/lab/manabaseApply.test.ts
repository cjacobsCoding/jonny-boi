/**
 * APPLYING A MANABASE VARIANT TO A SAVED DECK (DESIGN §3.175, acceptance 4):
 * the deck ends up with the variant's land entries and nothing else changed —
 * and the result agrees, card for card, with the deck the sim actually played.
 */
import { describe, expect, it } from 'vitest';
import { applyManabase, generateManabaseVariants, loadDeck, type ManabaseVariant } from '@jonny-boi/sim';
import { allAvailableCards, getCard } from '../cards.js';
import { deckSize, type Deck } from '../deck.js';
import { loadCardPool } from '../sim-pool.js';
import { toSimPayload } from '../sim-format.js';
import { applyManabaseToDeck } from './manabaseApply.js';

/** A saved deck's id for a card, by the name the WEB INDEX prints (a DFC names both faces). */
function id(name: string): string {
  const card = allAvailableCards().find((c) => c.name === name);
  if (!card) throw new Error(`no pool card named "${name}"`);
  return card.id;
}

/** A two-colour saved deck: 24 lands, playsets and part-sets, 60 cards. */
function gwDeck(): Deck {
  const entries: Array<[string, number]> = [
    ['Llanowar Elves', 4],
    ['Wall of Blossoms', 4],
    ['Elvish Visionary', 2],
    ['Lone Missionary', 2],
    ['Wood Elves', 3],
    ['Eternal Witness', 3],
    ['Attended Knight', 3],
    ['Thragtusk', 4],
    ['Restoration Angel', 2],
    ['Cloudshift', 4],
    ['Conjurer\'s Closet', 3],
    ['Wall of Omens', 2],
    ['Selesnya Guildgate', 2],
    ['Forest', 12],
    ['Plains', 10],
  ];
  return {
    id: 'gw',
    name: 'GW Test',
    cards: entries.map(([name, count]) => ({ cardId: id(name), count, name })),
    updatedAt: new Date(0).toISOString(),
  };
}

/** Copies per card NAME, so a pool id and a saved printing id compare as one card. */
function countsByName(deck: Deck): Map<string, number> {
  const counts = new Map<string, number>();
  for (const entry of deck.cards) {
    const name = getCard(entry.cardId)?.name ?? entry.name ?? entry.cardId;
    counts.set(name, (counts.get(name) ?? 0) + entry.count);
  }
  return counts;
}

function variantsFor(deck: Deck): readonly ManabaseVariant[] {
  return generateManabaseVariants(toSimPayload(deck), loadCardPool()).variants;
}

describe('applyManabaseToDeck', () => {
  const deck = gwDeck();
  const variants = variantsFor(deck);

  it('a land-TYPE variant replaces two basics of each colour with the dual and nothing else', () => {
    const variant = variants.find((v) => v.kind === 'type')!;
    const result = applyManabaseToDeck(deck, variant);
    expect(result.applied).toBe(true);
    expect(result.note).toBe(`Applied “${variant.label}” to “GW Test”.`);
    expect(deckSize(result.deck)).toBe(60);

    const before = countsByName(deck);
    const after = countsByName(result.deck);
    const dual = variant.steps[0]!.inName;
    expect(after.get(dual)).toBe(4);
    expect(after.get('Forest')).toBe(10);
    expect(after.get('Plains')).toBe(8);
    for (const [name, count] of before) {
      if (name === 'Forest' || name === 'Plains') continue;
      expect(after.get(name), name).toBe(count);
    }
  });

  it('a land-COUNT variant moves one basic and one nonland, keeping the size', () => {
    const variant = variants.find((v) => v.key === 'count:-1')!;
    const result = applyManabaseToDeck(deck, variant);
    expect(result.applied).toBe(true);
    const after = countsByName(result.deck);
    const step = variant.steps[0]!;
    expect(after.get(step.outName)).toBe(countsByName(deck).get(step.outName)! - 1);
    expect(after.get(step.inName)).toBe((countsByName(deck).get(step.inName) ?? 0) + 1);
    expect(deckSize(result.deck)).toBe(60);
  });

  it('agrees card for card with the deck the sim built and played', () => {
    const pool = loadCardPool();
    for (const variant of variants) {
      const web = applyManabaseToDeck(deck, variant);
      expect(web.applied, variant.label).toBe(true);
      const played = loadDeck(applyManabase(toSimPayload(deck), variant, pool), pool);
      const playedCounts = new Map<string, number>();
      for (const def of played.library) playedCounts.set(def.name, (playedCounts.get(def.name) ?? 0) + 1);
      expect(countsByName(web.deck), variant.label).toEqual(playedCounts);
    }
  });

  it('is all or nothing: a deck edited since the run is left untouched, with the reason', () => {
    const variant = variants.find((v) => v.kind === 'type')!;
    const edited: Deck = { ...deck, cards: deck.cards.map((e) => (e.name === 'Plains' ? { ...e, count: 1 } : e)) };
    const result = applyManabaseToDeck(edited, variant);
    expect(result.applied).toBe(false);
    expect(result.deck).toBe(edited);
    expect(result.note).toBe(`Not applied: “${variant.label}” needs 2 Plains and the deck has 1.`);
  });

  it('matches a modal double-faced card by its FRONT face, as the pool and the variant name it', () => {
    // The web index names Skyclave Cleric by both faces; the pool's definition
    // (and so a count step) says "Skyclave Cleric". A deck holding the MDFC
    // must still be found when the step names the front face.
    const mdfc: Deck = {
      ...deck,
      cards: deck.cards.map((e) =>
        e.name === 'Wall of Omens' ? { cardId: id('Skyclave Cleric // Skyclave Basilica'), count: 2, name: 'Skyclave Cleric // Skyclave Basilica' } : e,
      ),
    };
    const step = { outId: 'pool-id-unused', outName: 'Skyclave Cleric', inId: id('Forest'), inName: 'Forest', copies: 1 };
    const variant: ManabaseVariant = {
      key: 'count:+1',
      kind: 'count',
      label: '25 lands (+1 Forest, −1 Skyclave Cleric)',
      note: '',
      steps: [step],
      landCount: 25,
      slotsChanged: 1,
    };
    const result = applyManabaseToDeck(mdfc, variant);
    expect(result.applied).toBe(true);
    const after = countsByName(result.deck);
    expect(after.get('Skyclave Cleric // Skyclave Basilica')).toBe(1);
    expect(after.get('Forest')).toBe(13);
  });

  it('gathers copies across two printings of the same basic', () => {
    const variant = variants.find((v) => v.kind === 'type')!;
    const forest = deck.cards.find((e) => e.name === 'Forest')!;
    const split: Deck = {
      ...deck,
      cards: deck.cards.flatMap((e) =>
        e === forest ? [{ ...e, count: 1 }, { cardId: 'other-forest-printing', count: 11, name: 'Forest' }] : [e],
      ),
    };
    const result = applyManabaseToDeck(split, variant);
    expect(result.applied).toBe(true);
    expect(countsByName(result.deck).get('Forest')).toBe(10);
    expect(countsByName(result.deck).get(variant.steps[0]!.inName)).toBe(4);
  });
});
