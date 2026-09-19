/**
 * Apply a tested MANABASE variant to one of the user's decks (DESIGN §3.175).
 *
 * A variant is a list of in-place replacement steps (`ManabaseVariant.steps`) —
 * the very list the worker folded through `applyManabase` to build the deck it
 * played. This folds the SAME steps through the Lab's existing apply path,
 * `applySwapToDeck`, so what was tested and what lands in the saved deck cannot
 * drift: two Forests and two Plains become four Temple Gardens, and nothing else
 * moves.
 *
 * ALL OR NOTHING. A step that cannot be honoured in full (the deck was edited
 * since the run, a printing the pool does not carry) leaves the deck exactly as
 * it was and says why. A half-applied manabase is a deck nobody tested.
 */

import type { ManabaseVariant } from '@jonny-boi/sim';
import { getCard, getCardByName } from '../cards.js';
import type { Deck } from '../deck.js';
import { applySwapToDeck } from '../decklist/applySwapToDeck.js';

/** What applying a variant did — or why it could not be done. */
export interface ApplyManabaseResult {
  /** The updated deck; identical to the input when `applied` is false. */
  readonly deck: Deck;
  readonly applied: boolean;
  /** One line for the Lab's status strip. */
  readonly note: string;
}

/**
 * The saved deck's entries that ARE `name`, by the card each id resolves to.
 * Matched by NAME because a saved deck holds a printing id and the variant
 * names the pool's printing; the two are the same card to the rules.
 */
function entriesNamed(deck: Deck, name: string): readonly { readonly cardId: string; readonly count: number }[] {
  const key = name.trim().toLowerCase();
  return deck.cards.filter((entry) => (getCard(entry.cardId)?.name ?? entry.name ?? '').trim().toLowerCase() === key);
}

/** The id the deck should add for a variant's in card: the pool's, or the index's by name. */
function inCardIdFor(step: ManabaseVariant['steps'][number]): string | undefined {
  if (getCard(step.inId)) return step.inId;
  return getCardByName(step.inName)?.id;
}

export function applyManabaseToDeck(deck: Deck, variant: ManabaseVariant): ApplyManabaseResult {
  let current = deck;
  for (const step of variant.steps) {
    const inId = inCardIdFor(step);
    if (!inId) {
      return { deck, applied: false, note: `Not applied: ${step.inName} is not in the card pool.` };
    }
    let remaining = step.copies;
    // Gather copies across every line of the out card (a deck may hold two
    // printings of Forest), in decklist order, exactly as the sim's builder does.
    for (const line of entriesNamed(current, step.outName)) {
      if (remaining <= 0) break;
      const result = applySwapToDeck(current, line.cardId, inId, Math.min(remaining, line.count));
      if (result.copiesMoved === 0) {
        return { deck, applied: false, note: `Not applied: ${result.problem ?? `could not move ${step.outName} → ${step.inName}.`}` };
      }
      current = result.deck;
      remaining -= result.copiesMoved;
      if (result.problem) {
        // The in card hit its copy limit — the deck has changed since the run.
        return { deck, applied: false, note: `Not applied: ${result.problem}` };
      }
    }
    if (remaining > 0) {
      const have = entriesNamed(deck, step.outName).reduce((sum, line) => sum + line.count, 0);
      return {
        deck,
        applied: false,
        note: `Not applied: “${variant.label}” needs ${step.copies} ${step.outName} and the deck has ${have}.`,
      };
    }
  }
  return {
    deck: current,
    applied: true,
    note: `Applied “${variant.label}” to “${deck.name}”.`,
  };
}
