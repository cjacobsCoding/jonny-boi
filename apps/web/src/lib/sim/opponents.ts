/**
 * Resolving the gauntlet opponent list — the ONE place that decides which sample
 * decks a run faces and, crucially, **in what order**.
 *
 * Order is not cosmetic once a run is parallel: every shard identifies itself by
 * an opponent INDEX, and opponent `i` seeds its matchup from `gameSeedFor(seed, i)`.
 * If the planner on the main thread and the worker that loads the deck disagreed
 * about which deck index 3 is, the run would still finish and would still look
 * plausible — with silently wrong seeds. So both sides call this function.
 *
 * Pure and DOM-free (it reads only `SAMPLE_DECKS`), so it is testable in Node and
 * safe to import from a worker.
 */
import { SAMPLE_DECKS } from '@jonny-boi/sim';

/**
 * The canonical opponent names for a run.
 *
 * - An empty selection means "the whole gauntlet".
 * - Unknown names are skipped rather than crashing the run (a saved selection can
 *   outlive a renamed sample deck).
 * - The hero never fights itself.
 *
 * The result is ordered by `SAMPLE_DECKS`, not by the caller's selection order,
 * so re-checking the same boxes in a different order cannot change a run's seeds
 * and therefore cannot change its numbers.
 */
export function resolveOpponentNames(
  selected: readonly string[],
  heroName: string,
): readonly string[] {
  const wanted = selected.length > 0 ? new Set(selected) : null;
  const names: string[] = [];
  for (const deck of SAMPLE_DECKS) {
    if (deck.name === heroName) continue;
    if (wanted && !wanted.has(deck.name)) continue;
    names.push(deck.name);
  }
  return names;
}
