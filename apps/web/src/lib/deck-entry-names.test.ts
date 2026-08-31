import { describe, expect, it } from 'vitest';
import { allCards } from './cards.js';
import {
  addCard,
  describeMissingCard,
  fromExport,
  toExport,
  validateDeck,
  type Deck,
  type DeckEntry,
} from './deck.js';

/**
 * A deck entry has to be able to say WHICH card it is when its id stops
 * resolving.
 *
 * Reported live off the deployed build: Solo setup refused to start with
 * `unknown card "f413a83d-a40d-434c-b20a-4c707c0527fa" … deck size 56 is below
 * the minimum of 60`. The id is a real Scryfall uuid for a card outside the
 * 605-card pool, and the saved record was `{ cardId, count }` and nothing else —
 * so neither the player nor we could learn which of the sixty cards had gone
 * missing, or even that anything was missing until a game was started.
 *
 * The root cause was not the out-of-pool id. It was that the name was KNOWN at
 * every point the entry could have been created and was thrown away anyway.
 */

/** A Scryfall-shaped id that is deliberately not in the pool. */
const ABSENT_ID = 'f413a83d-a40d-434c-b20a-4c707c0527fa';

function deckOf(cards: DeckEntry[]): Deck {
  return { id: 'd1', name: 'Test', cards, updatedAt: '2026-01-01T00:00:00.000Z' };
}

describe('a deck entry remembers its card name', () => {
  const realCard = allCards[0]!;

  it('records the name when a card is added from the pool', () => {
    const deck = addCard(deckOf([]), realCard);
    expect(deck.cards[0]).toMatchObject({ cardId: realCard.id, count: 1, name: realCard.name });
  });

  it('keeps the name when more copies are added', () => {
    const deck = addCard(addCard(deckOf([]), realCard), realCard);
    expect(deck.cards).toHaveLength(1);
    expect(deck.cards[0]).toMatchObject({ count: 2, name: realCard.name });
  });
});

describe('validateDeck never reports a bare uuid', () => {
  it('names the missing card when the entry recorded one', () => {
    const issues = validateDeck(deckOf([{ cardId: ABSENT_ID, count: 4, name: 'Snapcaster Mage' }]));
    const missing = issues.find((issue) => issue.message.includes('Snapcaster Mage'));
    expect(missing, `no issue named the card. Got: ${issues.map((i) => i.message).join(' | ')}`)
      .toBeDefined();
    expect(missing!.severity).toBe('warning');
    // The id stays for a bug report, but it is no longer the whole message.
    expect(missing!.message).toContain(ABSENT_ID);
    expect(missing!.message.indexOf('Snapcaster Mage')).toBeLessThan(
      missing!.message.indexOf(ABSENT_ID),
    );
  });

  it('says the name is unrecoverable rather than inventing one', () => {
    const message = describeMissingCard({ cardId: ABSENT_ID, count: 4 });
    expect(message).toContain(ABSENT_ID);
    expect(message).toMatch(/re-import/i);
  });

  it('counts copies correctly in the message', () => {
    expect(describeMissingCard({ cardId: ABSENT_ID, count: 1, name: 'Ponder' })).toContain('1 copy');
    expect(describeMissingCard({ cardId: ABSENT_ID, count: 4, name: 'Ponder' })).toContain(
      '4 copies',
    );
  });

  /**
   * The failing message a user actually sees must never be JUST an id. This is
   * the assertion that fails on the old code for every entry in the deck.
   */
  it('leaves no unknown-card issue that is only an id', () => {
    const issues = validateDeck(
      deckOf([
        { cardId: ABSENT_ID, count: 4, name: 'Snapcaster Mage' },
        { cardId: `${ABSENT_ID}-2`, count: 2, name: 'Brainstorm' },
      ]),
    );
    for (const issue of issues.filter((i) => i.message.includes(ABSENT_ID))) {
      expect(issue.message).toMatch(/Snapcaster Mage|Brainstorm/);
    }
  });
});

describe('the name survives export and import', () => {
  it('round-trips the recorded name for an out-of-pool card', () => {
    const deck = deckOf([{ cardId: ABSENT_ID, count: 4, name: 'Snapcaster Mage' }]);
    const reimported = fromExport(JSON.parse(JSON.stringify(toExport(deck))));
    expect(reimported.cards[0]).toMatchObject({ cardId: ABSENT_ID, name: 'Snapcaster Mage' });
  });

  it('prefers the pool’s current name over a stale one in the file', () => {
    const real = allCards[0]!;
    const reimported = fromExport({
      name: 'Stale',
      cards: [{ cardId: real.id, count: 1, name: 'A Name From Two Years Ago' }],
    });
    expect(reimported.cards[0]!.name).toBe(real.name);
  });

  it('names an in-pool card even when the file carried no name at all', () => {
    const real = allCards[0]!;
    const reimported = fromExport({ name: 'Old', cards: [{ cardId: real.id, count: 1 }] });
    expect(reimported.cards[0]!.name).toBe(real.name);
  });

  it('omits the name key entirely when nothing can supply one', () => {
    const reimported = fromExport({ name: 'Broken', cards: [{ cardId: ABSENT_ID, count: 4 }] });
    expect('name' in reimported.cards[0]!).toBe(false);
  });

  it('ignores a blank name in the file rather than recording it', () => {
    const reimported = fromExport({
      name: 'Broken',
      cards: [{ cardId: ABSENT_ID, count: 4, name: '   ' }],
    });
    expect('name' in reimported.cards[0]!).toBe(false);
  });
});
