/**
 * Apply a lab-tested REMOVAL to one of the user's decks (DESIGN §3.174).
 *
 * The trim's whole point is the Apply: a round says "the deck is better without
 * one Swamp", and this is what makes it so. It is the web-side counterpart of
 * the sim's `applyTrimCut` — that one builds the sim `Deck` the arm played,
 * this one edits the saved web `Deck` — and both remove exactly the copies the
 * candidate named, one per card.
 *
 * It composes the deck module's own `removeCard` (the one place a web deck
 * loses a copy) rather than rewriting entries here, so a trim's removal and a
 * builder's minus-click are the same operation. Never throws: a card the deck no
 * longer holds (edited since the round ran) is REPORTED, and the rest of the
 * cuts still apply.
 */
import type { TrimCut } from '@jonny-boi/sim';
import { countOf, removeCard, type Deck } from '../deck.js';

/** What applying a removal did — or why part of it could not be done. */
export interface ApplyCutResult {
  /** The updated deck. Identical to the input when nothing was removed. */
  readonly deck: Deck;
  /** Copies actually removed across every cut. */
  readonly copiesRemoved: number;
  /** Cards that were removed, by name, in order. */
  readonly removed: readonly string[];
  /** Set when one or more cuts named a card the deck no longer holds. */
  readonly problem?: string;
}

/** Remove ONE copy of each card in `cuts` from `deck`. */
export function applyCutToDeck(deck: Deck, cuts: readonly TrimCut[]): ApplyCutResult {
  let next = deck;
  const removed: string[] = [];
  const missing: string[] = [];
  for (const cut of cuts) {
    if (countOf(next, cut.cardId) === 0) {
      missing.push(cut.name);
      continue;
    }
    next = removeCard(next, cut.cardId);
    removed.push(cut.name);
  }
  return {
    deck: removed.length > 0 ? next : deck,
    copiesRemoved: removed.length,
    removed,
    ...(missing.length > 0
      ? { problem: `${missing.join(' and ')} ${missing.length === 1 ? 'is' : 'are'} no longer in this deck.` }
      : {}),
  };
}

/** A one-line confirmation for the UI after applying. */
export function describeCutApplied(result: ApplyCutResult, deckName: string): string {
  if (result.copiesRemoved === 0) return result.problem ?? 'Nothing changed.';
  const cuts = result.removed.map((name) => `1× ${name}`).join(' and ');
  const base = `Cut ${cuts} from “${deckName}”.`;
  return result.problem ? `${base} ${result.problem}` : base;
}
