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

let cached: CardPool | null = null;

/** The curated pool, memoized. Warnings are silenced (stubbed mechanics are intended). */
export function loadCardPool(): CardPool {
  if (cached) return cached;
  cached = loadSimPool({ onWarn: () => {} });
  return cached;
}
