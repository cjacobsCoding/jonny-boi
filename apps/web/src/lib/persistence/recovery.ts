/**
 * CAN A LOST DECK ACTUALLY BE GOT BACK? — an honest answer, computed.
 *
 * ## The rule this module was written under
 *
 * A deck lost to a failed write is GONE. It was never on disk. No amount of UI
 * can bring it back, and pretending otherwise would be a worse failure than the
 * silent one it followed — the user would stop looking for the decklist they
 * still have somewhere else.
 *
 * So this module does not invent a recovery. It asks one narrow, checkable
 * question: **is a decklist already sitting on this disk that the deck list does
 * not contain?** Two places genuinely hold one, because they store decks
 * RESOLVED rather than by reference (a deliberate decision in `persist.ts`, so
 * that editing a deck cannot rewrite history under a game in progress):
 *
 *   - the ONE in-progress game (`jonny-boi.play.inProgress.v1`), and
 *   - every entry in the game library (`jonny-boi.play.history.v1`).
 *
 * A `PersistedSetup` carries `deckA` and `deckB` as full `{cardId, count, name}`
 * lists. That is a real deck, not a reference to one — so if the user played a
 * deck that later failed to save, it is still there, and offering it back is a
 * genuine restore rather than a hopeful one.
 *
 * ## What it deliberately will NOT offer
 *
 * The built-in gauntlet decks. Every game is played against one, so without this
 * filter the "lost decks" list would be mostly meta decks the user never made,
 * burying the one row that matters. The discriminator is their NAME, which is
 * fixed data in `@jonny-boi/sim`.
 */
import { SAMPLE_DECKS } from '@jonny-boi/sim';
import type { Deck as SimDeck } from '@jonny-boi/sim';
import type { Deck, DeckEntry } from '../deck.js';
import { readHistory } from '../play/history.js';
import { readSavedGame } from '../play/persist.js';

/** A decklist found on disk that the saved-deck list does not have. */
export interface RecoverableDeck {
  /** Stable within one scan, so the UI can key a list and a button. */
  readonly key: string;
  readonly name: string;
  readonly cards: DeckEntry[];
  /** Where it was found, in words the readout shows. */
  readonly source: 'the game in progress' | 'the game library';
  /** Epoch ms of the record it came from — newest offered first. */
  readonly seenAt: number;
}

/** Names of the built-in gauntlet decks, which are never the user's work. */
const SAMPLE_DECK_NAMES: ReadonlySet<string> = new Set(SAMPLE_DECKS.map((d) => d.name));

/**
 * Content identity for a decklist: sorted `cardId:count` pairs.
 *
 * Deliberately ignores the deck's NAME and its local id. A deck recovered from a
 * game record has neither in common with the saved deck it might duplicate, so
 * matching on anything else would offer the user a deck they already have.
 */
function contentKey(cards: readonly { cardId: string; count: number }[]): string {
  return [...cards]
    .map((c) => `${c.cardId}:${c.count}`)
    .sort()
    .join('|');
}

/** A persisted sim decklist → the saved-deck shape, art and local id aside. */
function toEntries(deck: SimDeck): DeckEntry[] {
  return deck.cards.map((c) => ({
    cardId: c.cardId,
    count: c.count,
    ...(c.name === undefined ? {} : { name: c.name }),
  }));
}

/**
 * Every decklist on disk that the saved-deck list does not already contain.
 *
 * Returns an empty array when there is nothing to offer — which is the common
 * and correct answer, and the reason the UI must render "nothing to recover"
 * rather than a hopeful prompt.
 */
export function recoverableDecks(saved: readonly Deck[]): readonly RecoverableDeck[] {
  const have = new Set(saved.map((deck) => contentKey(deck.cards)));
  const found = new Map<string, RecoverableDeck>();

  const consider = (
    deck: SimDeck | undefined,
    source: RecoverableDeck['source'],
    seenAt: number,
  ): void => {
    if (!deck || !Array.isArray(deck.cards) || deck.cards.length === 0) return;
    if (SAMPLE_DECK_NAMES.has(deck.name)) return;
    const key = contentKey(deck.cards);
    if (have.has(key)) return;
    const existing = found.get(key);
    // The same deck can appear in many games. Keep the most recent sighting, and
    // prefer the in-progress game's copy: it is the one the user is closest to.
    if (existing && (existing.source === 'the game in progress' || existing.seenAt >= seenAt)) {
      return;
    }
    found.set(key, { key, name: deck.name, cards: toEntries(deck), source, seenAt });
  };

  try {
    const inProgress = readSavedGame();
    if (inProgress) {
      consider(inProgress.setup.deckA, 'the game in progress', inProgress.savedAt);
      consider(inProgress.setup.deckB, 'the game in progress', inProgress.savedAt);
    }
  } catch {
    // A record that will not read is not a recovery source. The storage readout
    // reports storage health; this function only ever ADDS options, so finding
    // none here is a smaller answer, never a wrong one.
  }

  try {
    for (const entry of readHistory()) {
      consider(entry.record.setup.deckA, 'the game library', entry.updatedAt);
      consider(entry.record.setup.deckB, 'the game library', entry.updatedAt);
    }
  } catch {
    // Same reasoning as above.
  }

  return [...found.values()].sort((a, b) => b.seenAt - a.seenAt);
}

/** Turn one offer into a real saved deck. The caller adds it through `useDecks`. */
export function asDeck(recoverable: RecoverableDeck, now: number = Date.now()): Deck {
  return {
    id: `recovered-${now.toString(36)}-${recoverable.key.length.toString(36)}`,
    name: recoverable.name,
    cards: recoverable.cards,
    updatedAt: new Date(now).toISOString(),
  };
}
