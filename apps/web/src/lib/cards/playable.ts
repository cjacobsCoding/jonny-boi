/**
 * IS THIS CARD PLAYABLE, AND IF NOT, WHAT DOES IT NEED? (§3.167)
 *
 * Two questions with two costs, kept apart on purpose:
 *
 *  - {@link isPlayableCard} is CHEAP — two map lookups against the memoized
 *    engine pool — because the browser asks it for every one of 32,000 cards
 *    on every keystroke of the search box. It is the same "does the engine
 *    resolve it, by id then by name" that `deckHealth` and the sim use.
 *  - {@link corpusUnsupportedReason} is EXPENSIVE — it runs the Oracle-text
 *    compiler on the card — so it is asked only for the ONE card in front of
 *    the user (a detail view, a hover on the ⚠), and memoised per id. It is
 *    what turns "not playable yet" into "not playable yet — needs morph", which
 *    is what he asked for: *"make it very clear"*.
 *
 * Both read the same sources the rest of the app does; neither keeps a list of
 * its own, so a card that becomes playable (a regeneration, an import that
 * compiled) is playable everywhere at once.
 */
import { compileCard, type UnsupportedClause } from '@jonny-boi/cards';
import type { NormalizedCard } from '@jonny-boi/data-tools';
import { loadCardPool } from '../sim-pool.js';
import { corpusCard } from './corpus.js';

/** Does the engine resolve this card — by id, then by name — right now? */
export function isPlayableCard(card: Pick<NormalizedCard, 'id' | 'name'>): boolean {
  const pool = loadCardPool();
  return pool.get(card.id) !== undefined || pool.getByName(card.name) !== undefined;
}

/**
 * The clauses the compiler cannot play in a CORPUS card's text, memoised per
 * id. `undefined` for anything that is not a corpus card (the pool and the
 * import store answer for their own), and an empty list for a corpus card the
 * compiler cannot even read — reported, not hidden, as "no account of why".
 */
const reasonMemo = new Map<string, readonly UnsupportedClause[]>();

export function corpusUnsupportedReason(id: string): readonly UnsupportedClause[] | undefined {
  const card = corpusCard(id);
  if (card === undefined) return undefined;
  const known = reasonMemo.get(id);
  if (known !== undefined) return known;
  let clauses: readonly UnsupportedClause[];
  try {
    const compiled = compileCard(card as Parameters<typeof compileCard>[0]);
    clauses = compiled.status === 'complete' ? [] : (compiled.missing ?? []);
  } catch {
    clauses = [];
  }
  reasonMemo.set(id, clauses);
  return clauses;
}

/** Tests only. */
export function resetPlayableMemoForTests(): void {
  reasonMemo.clear();
}
