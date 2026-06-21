import { useCallback, useEffect, useState } from 'react';
import type { NormalizedCard } from '@jonny-boi/data-tools';
import {
  type Deck,
  addCard as addCardToDeck,
  removeCard as removeCardFromDeck,
  createDeck,
} from './deck.js';
import { DEFAULT_DECK_NAME } from './config.js';
import {
  loadDecks,
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
  /** Replace the active deck wholesale (used by import). */
  replaceActive: (deck: Deck) => void;
  /** Add an externally-created deck and make it active (used by import). */
  importDeck: (deck: Deck) => void;
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

  // Initial load — recover gracefully if storage is empty/corrupt.
  useEffect(() => {
    const loaded = loadDecks();
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

  // Persist whenever decks or the active selection change.
  useEffect(() => {
    if (decks.length > 0) saveDecks(decks);
  }, [decks]);
  useEffect(() => {
    saveActiveDeckId(activeId);
  }, [activeId]);

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

  const replaceActive = useCallback(
    (deck: Deck) => updateActive((current) => ({ ...deck, id: current.id })),
    [updateActive],
  );

  const importDeck = useCallback((deck: Deck) => {
    setDecks((current) => [...current, deck]);
    setActiveId(deck.id);
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
    replaceActive,
    importDeck,
  };
}
