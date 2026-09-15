import { useCallback, useEffect, useState } from 'react';
import type { NormalizedCard } from '@jonny-boi/data-tools';
import {
  type Deck,
  addCard as addCardToDeck,
  removeCard as removeCardFromDeck,
  createDeck,
} from './deck.js';
import {
  withEntryPrinting,
  withoutEntryPrinting,
  type EntryPrinting,
} from './printings/entryPrinting.js';
import { DEFAULT_DECK_NAME } from './config.js';
import {
  loadDecks,
  mayPersistDecks,
  saveDecks,
  loadActiveDeckId,
  saveActiveDeckId,
} from './storage.js';

/** Imperative API the deck builder uses to mutate persisted deck state. */
export interface DecksApi {
  decks: Deck[];
  activeDeck: Deck | null;
  selectDeck: (id: string) => void;
  newDeck: () => void;
  deleteDeck: (id: string) => void;
  renameActive: (name: string) => void;
  addCard: (card: NormalizedCard) => void;
  removeCard: (cardId: string) => void;
  /**
   * Choose the Scryfall printing this slot of the active deck uses, or pass
   * `null` to go back to the pool's default art. Art only — the card's identity
   * is its `cardId` and this never touches it.
   */
  setEntryPrinting: (cardId: string, printing: EntryPrinting | null) => void;
  /** Replace the active deck wholesale (used by import). */
  replaceActive: (deck: Deck) => void;
  /** Add an externally-created deck and make it active (used by import). */
  importDeck: (deck: Deck) => void;
  /**
   * Replace a deck BY ID, wherever it sits in the collection. Unlike
   * `replaceActive`, this does not assume the deck being edited is the selected
   * one — the Lab's hero can be any saved deck, so applying a verdict to it must
   * not silently write over whichever deck happens to be active.
   */
  updateDeck: (deck: Deck) => void;
}

/**
 * React hook owning the saved-deck collection. Loads from localStorage on mount,
 * persists on every change, and tracks the active deck. All deck mutations route
 * through the pure functions in `deck.ts` so logic stays testable and the hook
 * only manages state + persistence.
 */
export function useDecks(): DecksApi {
  const [decks, setDecks] = useState<Deck[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);

  /**
   * Set when the stored deck blob exists but would not parse. While it is true
   * the hook NEVER writes: overwriting an unreadable blob with the starter deck
   * this hook is about to create is a second way to lose the same decks, and it
   * is unrecoverable. `loadDecks` has already told the user what happened.
   */
  const [readCorrupt, setReadCorrupt] = useState(false);

  // Initial load — recover gracefully if storage is empty/corrupt.
  useEffect(() => {
    const { decks: loaded, corrupt } = loadDecks();
    setReadCorrupt(corrupt);
    if (loaded.length === 0) {
      const starter = createDeck(DEFAULT_DECK_NAME);
      setDecks([starter]);
      setActiveId(starter.id);
      return;
    }
    setDecks(loaded);
    const storedActive = loadActiveDeckId();
    const exists = loaded.some((deck) => deck.id === storedActive);
    setActiveId(exists ? storedActive : loaded[0]!.id);
  }, []);

  // Persist whenever decks or the active selection change. `saveDecks` reports
  // its own failure to the user through the persistence notice registry, which
  // the app shell renders — this effect deliberately does not swallow anything.
  useEffect(() => {
    if (mayPersistDecks({ readCorrupt, deckCount: decks.length })) saveDecks(decks);
  }, [decks, readCorrupt]);
  useEffect(() => {
    if (readCorrupt) return;
    saveActiveDeckId(activeId);
  }, [activeId, readCorrupt]);

  const activeDeck = decks.find((deck) => deck.id === activeId) ?? null;

  const updateActive = useCallback(
    (mutate: (deck: Deck) => Deck) => {
      setDecks((current) =>
        current.map((deck) => (deck.id === activeId ? mutate(deck) : deck)),
      );
    },
    [activeId],
  );

  const selectDeck = useCallback((id: string) => setActiveId(id), []);

  const newDeck = useCallback(() => {
    const deck = createDeck(DEFAULT_DECK_NAME);
    setDecks((current) => [...current, deck]);
    setActiveId(deck.id);
  }, []);

  const deleteDeck = useCallback(
    (id: string) => {
      setDecks((current) => {
        const remaining = current.filter((deck) => deck.id !== id);
        const next = remaining.length > 0 ? remaining : [createDeck(DEFAULT_DECK_NAME)];
        // Re-point the active deck if we deleted it.
        setActiveId((active) => (active === id ? next[0]!.id : active));
        return next;
      });
    },
    [],
  );

  const renameActive = useCallback(
    (name: string) => updateActive((deck) => ({ ...deck, name })),
    [updateActive],
  );

  const addCard = useCallback(
    (card: NormalizedCard) => updateActive((deck) => addCardToDeck(deck, card)),
    [updateActive],
  );

  const removeCard = useCallback(
    (cardId: string) => updateActive((deck) => removeCardFromDeck(deck, cardId)),
    [updateActive],
  );

  const setEntryPrinting = useCallback(
    (cardId: string, printing: EntryPrinting | null) =>
      updateActive((deck) =>
        printing === null
          ? withoutEntryPrinting(deck, cardId)
          : withEntryPrinting(deck, cardId, printing),
      ),
    [updateActive],
  );

  const replaceActive = useCallback(
    (deck: Deck) => updateActive((current) => ({ ...deck, id: current.id })),
    [updateActive],
  );

  const importDeck = useCallback((deck: Deck) => {
    setDecks((current) => [...current, deck]);
    setActiveId(deck.id);
  }, []);

  const updateDeck = useCallback((deck: Deck) => {
    setDecks((current) => current.map((d) => (d.id === deck.id ? deck : d)));
  }, []);

  return {
    decks,
    activeDeck,
    selectDeck,
    newDeck,
    deleteDeck,
    renameActive,
    addCard,
    removeCard,
    setEntryPrinting,
    replaceActive,
    importDeck,
    updateDeck,
  };
}

