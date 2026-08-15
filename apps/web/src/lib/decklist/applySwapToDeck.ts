/**
 * Apply a lab-tested swap to one of the user's decks.
 *
 * The Lab could tell you a swap was better and then leave you to go make it by
 * hand in the builder — find the card, click minus the right number of times,
 * find the other card, click plus. That is the one action a verdict is FOR, and
 * a hand-applied swap is also where a typo silently invalidates the next test.
 *
 * Mirrors `applySwap` in `packages/sim` (which builds the *variant* the test
 * actually played) but operates on the web `Deck` shape and respects the deck's
 * copy limit rather than throwing. The two must agree on what a swap means, so
 * this replaces the same number of copies the evaluation reports having moved.
 */

import { getCard } from '../cards.js';
import { maxCopiesFor, type Deck } from '../deck.js';

/** What applying a swap did — or why it could not be done. */
export interface ApplySwapResult {
  /** The updated deck. Identical to the input when `problem` is set. */
  readonly deck: Deck;
  /** Copies actually moved (may be fewer than asked if the in card hit its limit). */
  readonly copiesMoved: number;
  /** Set when the swap could not be applied at all; the deck is unchanged. */
  readonly problem?: string;
}

/**
 * Move `copies` of `outCardId` to `inCardId` in `deck`.
 *
 * Never throws and never produces an illegal deck: if the in card would exceed
 * its copy limit we move as many as legally fit and REPORT the shortfall, rather
 * than silently building a deck the sim will later refuse to load.
 */
export function applySwapToDeck(
  deck: Deck,
  outCardId: string,
  inCardId: string,
  copies: number,
): ApplySwapResult {
  if (outCardId === inCardId) {
    return { deck, copiesMoved: 0, problem: 'That swap replaces a card with itself.' };
  }

  const inCard = getCard(inCardId);
  if (!inCard) {
    return { deck, copiesMoved: 0, problem: 'The card to add is not in the card pool.' };
  }

  const outEntry = deck.cards.find((e) => e.cardId === outCardId);
  if (!outEntry) {
    const outName = getCard(outCardId)?.name ?? 'That card';
    return { deck, copiesMoved: 0, problem: `${outName} is no longer in this deck.` };
  }

  // Never remove more than the deck actually holds — the deck may have been
  // edited since the test ran.
  const wanted = Math.max(1, Math.min(copies, outEntry.count));

  // Adding must respect the copy limit, counting what the deck already has.
  const limit = maxCopiesFor(inCard);
  const existingIn = deck.cards.find((e) => e.cardId === inCardId)?.count ?? 0;
  const room = Math.max(0, limit - existingIn);
  const moved = Math.min(wanted, room);
  if (moved === 0) {
    return {
      deck,
      copiesMoved: 0,
      problem: `Already at the maximum ${limit} copies of ${inCard.name}.`,
    };
  }

  // Replace IN PLACE so the decklist keeps its order — the same reasoning as the
  // sim's `applySwap`, and it keeps the list readable after repeated swaps.
  const cards = deck.cards
    .map((entry) => {
      if (entry.cardId === outCardId) {
        const remaining = entry.count - moved;
        return remaining > 0
          ? [{ ...entry, count: remaining }, { cardId: inCardId, count: moved }]
          : [{ cardId: inCardId, count: moved }];
      }
      return [entry];
    })
    .flat();

  // Merge if the in card already had its own line elsewhere.
  const merged: Deck['cards'] = [];
  for (const entry of cards) {
    const existing = merged.find((e) => e.cardId === entry.cardId);
    if (existing) existing.count += entry.count;
    else merged.push({ ...entry });
  }

  const shortfall = wanted - moved;
  return {
    deck: { ...deck, cards: merged, updatedAt: new Date().toISOString() },
    copiesMoved: moved,
    problem:
      shortfall > 0
        ? `Moved ${moved} of ${wanted} — ${inCard.name} is capped at ${limit} copies.`
        : undefined,
  };
}

/** A one-line confirmation for the UI after applying. */
export function describeApplied(
  result: ApplySwapResult,
  outName: string,
  inName: string,
  deckName: string,
): string {
  if (result.copiesMoved === 0) return result.problem ?? 'Nothing changed.';
  const base = `Swapped ${result.copiesMoved}× ${outName} → ${result.copiesMoved}× ${inName} in “${deckName}”.`;
  return result.problem ? `${base} ${result.problem}` : base;
}
