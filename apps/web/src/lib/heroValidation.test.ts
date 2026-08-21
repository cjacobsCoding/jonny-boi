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

/** Scryfall ids are uuids; the old failure surfaced these instead of names. */
const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** Build an imported-card fixture with a uuid id, as a real import has. */
function importedFixture(
  id: string,
  name: string,
  playable: boolean,
): Parameters<typeof registerImportedCards>[0][number] {
  const base = {
    card: { ...UNPLAYABLE_CARD.card, id, name },
    ...(playable
      ? { definition: { id, name, types: ['Land'], produces: ['R'] } }
      : { missing: [{ text: `${name} does something new.`, missingEngineSystem: 'a rules template' }] }),
  };
  return base as unknown as Parameters<typeof registerImportedCards>[0][number];
}

/**
 * The entries the live app answered for with bare uuids, minus one.
 *
 * `Sacred Foundry` was captured here as a failed import and has since entered the
 * CURATED pool, so it is no longer an example of anything unplayable — see
 * {@link CURATED_BUT_FAILED_IMPORT}, where it now earns its keep as the
 * regression for DESIGN §3.37.
 */
const UNPLAYABLE_IMPORTS = [
  importedFixture('2588f348-d7a3-46c8-9ace-dca53ed5ef99', 'Ajani, Nacatl Pariah', false),
  importedFixture('3407eb6e-b74d-4159-a801-d7163937953c', "Phlage, Titan of Fire's Fury", false),
  importedFixture('37108cd4-bbab-4ce3-9ed6-f60e8422e703', 'Ragavan, Nimble Pilferer', false),
];

/**
 * A card that is BOTH curated and a failed import — the §3.37 bug, in the shape
 * the suite already had lying around.
 *
 * `Sacred Foundry` is in the pool with a hand-verified definition, and this
 * fixture says its import failed. The pool must win: blaming it would be the
 * exact defect a user reported as "⚠ 10 cards not playable" over a deck of
 * cards the engine plays perfectly well.
 */
const CURATED_BUT_FAILED_IMPORT = importedFixture(
  '45181cb8-2090-4471-ba90-e5a8f04d525f',
  'Sacred Foundry',
  false,
);

/** Imports from the same deck that DID compile — they must not be blamed. */
const PLAYABLE_IMPORTS = [
  importedFixture('c5acf2a5-40f4-433d-a74d-1cb56c521464', 'Arid Mesa', true),
  importedFixture('dab520d0-20b4-4273-ba6b-eb07f85ea433', 'Marsh Flats', true),
];

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

  it('names EVERY unplayable card in a real imported deck, and no uuids', () => {
    // The shape actually captured from the app: a Modern Boros list imported
    // live produced a 7-entry deck of which four entries had no definition, and
    // the Match viewer answered with four bare uuids and nothing else. Scryfall
    // ids are uuids, so "contains no uuid" is the precise regression assertion.
    registerImportedCards([...UNPLAYABLE_IMPORTS, ...PLAYABLE_IMPORTS, CURATED_BUT_FAILED_IMPORT]);
    const deck: Deck = {
      ...healthyDeck(),
      cards: [
        ...UNPLAYABLE_IMPORTS.map((c) => ({ cardId: c.card.id, count: 4 })),
        ...PLAYABLE_IMPORTS.map((c) => ({ cardId: c.card.id, count: 4 })),
        { cardId: CURATED_BUT_FAILED_IMPORT.card.id, count: 4 },
      ],
    };

    const problems = validateHero(deck);

    expect(problems).toHaveLength(1);
    for (const imported of UNPLAYABLE_IMPORTS) {
      expect(problems[0]).toContain(imported.card.name);
    }
    expect(problems[0]).not.toMatch(UUID_PATTERN);
    // A card the engine CAN play must not be blamed alongside them.
    for (const playable of PLAYABLE_IMPORTS) {
      expect(problems[0]).not.toContain(playable.card.name);
    }
    // …and neither must a CURATED card whose import happened to fail (§3.37).
    expect(
      problems[0],
      'Sacred Foundry is in the curated pool — a failed import of it must not shadow that',
    ).not.toContain(CURATED_BUT_FAILED_IMPORT.card.name);
  });
});
