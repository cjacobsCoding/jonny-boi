/**
 * Convert a player's deck choice (a saved web deck OR a bundled sample sim deck) into
 * the protocol `DeckList` that travels over the wire. The server rebuilds and
 * validates the deck from the shared card pool, so we only need the name + the
 * `{ cardId, count }` entries — exactly what both deck shapes already carry. DRY: we
 * reuse the SAME `DeckChoice` the hotseat setup uses (setup.ts).
 */
import type { DeckList } from '@jonny-boi/protocol';
import type { DeckChoice } from '../play/setup.js';

/** Build the wire `DeckList` from a chosen deck. */
export function deckChoiceToDeckList(choice: DeckChoice): DeckList {
  return {
    name: choice.deck.name,
    cards: choice.deck.cards.map((entry) => ({ cardId: entry.cardId, count: entry.count })),
  };
}
