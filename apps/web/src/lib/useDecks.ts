import { useCallback, useEffect, useRef, useState } from 'react';
import type { NormalizedCard } from '@jonny-boi/data-tools';
import {
  type Deck,
  addCard as addCardToDeck,
  removeCard as removeCardFromDeck,
  removeUnresolved as removeUnresolvedFromDeck,
  dismissRevisionNote as dismissRevisionNoteOnDeck,
  createDeck,
} from './deck.js';
import {
  loadSettledSeeds,
  planRevisions,
  planSeeding,
  recordSettledSeeds,
  reconcileUnresolved,
  type SettledSeed,
} from './decklist/paperDecks.js';
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
   * Drop a card the pool cannot supply from the active deck's wish-list.
   *
   * The counterpart of {@link removeCard} for the one part of a deck that has no
   * card in the grid to step down. Without it a seeded deck would carry a line
   * he could never clear, which is not "editable like any other deck".
   */
  removeUnresolvedCard: (name: string) => void;
  /**
   * Dismiss the note that the app added cards to the active deck at his
   * request (§3.162). The cards stay; only the message goes.
   */
  dismissRevisionNote: (id: string) => void;
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

  /**
   * Seeds settled by this session's load, waiting for the decks to be stored.
   *
   * ⚠️ A ref and not state, on purpose: recording a seed as delivered BEFORE its
   * deck is safely on disk is how a deck gets marked done and then lost, which
   * is the failure `docs/PLAY-HISTORY-AND-STORAGE.md` §1 documents. The persist
   * effect below drains this only after `saveDecks` reports success.
   */
  const pendingSeedRecord = useRef<SettledSeed[]>([]);

  // Initial load — recover gracefully if storage is empty/corrupt.
  useEffect(() => {
    const { decks: loaded, corrupt } = loadDecks();
    setReadCorrupt(corrupt);
    if (corrupt) {
      // ⚠️ NOTHING is seeded onto an unreadable blob. His decks may well still
      // be in there; adding to what we could not read, and then writing it back,
      // is the second and unrecoverable way to lose them. `loadDecks` has
      // already told him what happened, and `mayPersistDecks` blocks the write.
      const starter = createDeck(DEFAULT_DECK_NAME);
      setDecks([starter]);
      setActiveId(starter.id);
      return;
    }

    // His transcribed paper decks join the ONE collection here, as ordinary
    // decks of his own — add-only, name-collision-safe, once per profile.
    const settledBefore = loadSettledSeeds();
    const plan = planSeeding(loaded, settledBefore);
    // §3.162 — the additions he asked for, applied once to his copy of a deck
    // seeded earlier (a fresh mint above already holds them).
    const revised = planRevisions(plan.decks, new Set([...settledBefore, ...plan.settled.map((s) => s.id)]));
    const reconciled = reconcileUnresolved(revised.decks);
    pendingSeedRecord.current = [...plan.settled, ...revised.settled];

    if (reconciled.length === 0) {
      const starter = createDeck(DEFAULT_DECK_NAME);
      setDecks([starter]);
      setActiveId(starter.id);
      return;
    }
    setDecks(reconciled);
    const storedActive = loadActiveDeckId();
    const exists = reconciled.some((deck) => deck.id === storedActive);
    setActiveId(exists ? storedActive : reconciled[0]!.id);
  }, []);

  // Persist whenever decks or the active selection change. `saveDecks` reports
  // its own failure to the user through the persistence notice registry, which
  // the app shell renders — this effect deliberately does not swallow anything.
  useEffect(() => {
    if (!mayPersistDecks({ readCorrupt, deckCount: decks.length })) return;
    const result = saveDecks(decks);
    // The ledger goes SECOND, and only on a successful deck write. A seed marked
    // delivered whose deck did not make it to disk would never be offered again.
    if (result.ok && pendingSeedRecord.current.length > 0) {
      recordSettledSeeds(pendingSeedRecord.current);
      pendingSeedRecord.current = [];
    }
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

  const removeUnresolvedCard = useCallback(
    (name: string) => updateActive((deck) => removeUnresolvedFromDeck(deck, name)),
    [updateActive],
  );

  const dismissRevisionNote = useCallback(
    (id: string) => updateActive((deck) => dismissRevisionNoteOnDeck(deck, id)),
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
    removeUnresolvedCard,
    dismissRevisionNote,
    setEntryPrinting,
    replaceActive,
    importDeck,
    updateDeck,
  };
}

