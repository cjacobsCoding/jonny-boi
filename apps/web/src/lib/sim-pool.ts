/**
 * A main-thread handle on the sim's curated card pool, used ONLY for cheap,
 * synchronous, game-free work: validating the hero deck's legality before a run
 * (`validateDeck` needs a pool). It is built once and memoized — loading the pool
 * is just indexing in-memory card data, no I/O.
 *
 * The heavy sim (which plays games) runs in the Web Worker, never here. This
 * keeps the legal/illegal deck check instant in the UI so we can show a guided
 * message instead of dispatching an obviously-illegal deck to the worker.
 */
import { loadCardPool as loadSimPool } from '@jonny-boi/cards';
import type { CardPool } from '@jonny-boi/cards';
import { importedDefinitions, subscribeToImportedCards } from './decklist/importedCards.js';

let cached: CardPool | null = null;

// Importing a deck adds playable definitions to the pool, so the memoized pool
// must be rebuilt on the next read — otherwise a freshly imported deck would
// fail validation against a stale pool.
subscribeToImportedCards(() => {
  cached = null;
});

/**
 * The pool the UI validates against: the curated cards plus every card deck
 * import compiled to a genuinely playable definition. Memoized (rebuilt when the
 * imported set changes). Warnings are silenced — stubbed curated mechanics are
 * intended and documented.
 */
export function loadCardPool(): CardPool {
  if (cached) return cached;
  cached = loadSimPool({ onWarn: () => {}, extraCards: importedDefinitions() });
  return cached;
}
