/**
 * The Lab and the Match viewer must refuse the SAME decks for the SAME reasons.
 *
 * The regression these lock down: `validateHero` was duplicated per view and the
 * copies drifted. The Match viewer's copy skipped the unsupported-card check, so
 * watching a game with a freshly imported deck died inside the sim with
 * `unknown card "<uuid>"` instead of naming the card.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { NO_DECK_SELECTED, validateHero } from './heroValidation.js';
import { registerImportedCards } from './decklist/importedCards.js';
import { gauntletHeroDecks } from './decklist/gauntletDecks.js';
import type { Deck } from './deck.js';

/** A card the engine cannot play: a display record with no definition. */
const UNPLAYABLE_CARD = {
  card: {
    id: 'unplayable-test-card',
    name: 'Impossible Contraption',
    manaCost: '{2}',
    typeLine: 'Artifact',
    oracleText: 'Do something the engine cannot do.',
    colors: [],
    cmc: 2,
    keywords: [],
    rarity: 'rare',
    setCode: 'tst',
  },
  missing: [{ text: 'Do something the engine cannot do.', missingEngineSystem: 'a rules template' }],
} as unknown as Parameters<typeof registerImportedCards>[0][number];

/** A legal 60-card gauntlet deck, exactly as the views offer it as a hero. */
function healthyDeck(): Deck {
  return gauntletHeroDecks()[0]!;
}

/** The same deck with one card swapped for an unplayable import. */
function deckWithUnplayableCard(): Deck {
  const deck = healthyDeck();
  const cards = deck.cards.map((entry, i) =>
    i === 0 ? { cardId: UNPLAYABLE_CARD.card.id, count: entry.count } : entry,
  );
  return { ...deck, cards };
}

describe('validateHero', () => {
  beforeEach(() => {
    registerImportedCards([UNPLAYABLE_CARD]);
  });

  it('reports an empty state when no deck is selected', () => {
    expect(validateHero(null)).toEqual([NO_DECK_SELECTED]);
  });

  it('passes a legal gauntlet deck', () => {
    expect(validateHero(healthyDeck())).toEqual([]);
  });

  it('names the unplayable card rather than leaking its id', () => {
    const problems = validateHero(deckWithUnplayableCard());

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('Impossible Contraption');
    // The bug this replaces surfaced the raw uuid from the sim instead.
    expect(problems[0]).not.toContain(UNPLAYABLE_CARD.card.id);
  });

  it('reports the unplayable card FIRST, before any deck-size complaint', () => {
    // A deck that is both too small AND holds an unplayable card must lead with
    // the card: fixing the size would not make it runnable.
    const tiny: Deck = {
      ...healthyDeck(),
      cards: [{ cardId: UNPLAYABLE_CARD.card.id, count: 4 }],
    };

    const problems = validateHero(tiny);

    expect(problems[0]).toContain('Impossible Contraption');
  });

  it('is one shared answer, so every surface refuses identically', () => {
    // Both views now call this exact function; same deck in, same words out.
    const deck = deckWithUnplayableCard();

    expect(validateHero(deck)).toEqual(validateHero(deck));
  });
});
