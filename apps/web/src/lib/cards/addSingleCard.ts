/**
 * ADD ONE CARD — the à-la-carte path into the card pool.
 *
 * Deck import brings in a whole list; this brings in exactly one card the user
 * names, from anywhere in the app (the card browser, or mid-deck-build). It runs
 * the SAME pipeline as deck import — fuzzy lookup → normalize → compile → store —
 * so a card added this way is screened for unsupported mechanics identically and
 * can never enter a simulation the engine cannot honestly play.
 *
 * The one addition is the {@link recordUnsupported} call: a card we cannot play
 * is not just refused, its missing engine systems are filed on the shared work
 * queue so the gap gets implemented instead of forgotten.
 *
 * Pure w.r.t. the network (the caller injects `fetch`), so every branch is tested
 * without touching Scryfall.
 */

import { compileCard } from '@jonny-boi/cards';
import type { UnsupportedClause } from '@jonny-boi/cards';
import { normalizeCard } from '@jonny-boi/data-tools/pure';
import type { NormalizedCard, RawScryfallCard } from '@jonny-boi/data-tools/pure';
import { getCard, getCardByName } from '../cards.js';
import { registerImportedCards } from '../decklist/importedCards.js';
import { lookupCardByName, type LookupOptions, type NamedLookup } from '../scryfall/named.js';
import type { FetchLike } from '../scryfall/collection.js';
import { recordUnsupported } from './unsupportedRegistry.js';

/** What adding one card produced. */
export type AddCardResult =
  /** Added and fully playable. */
  | { readonly kind: 'added'; readonly card: NormalizedCard }
  /**
   * Added to the pool and browsable, but NOT playable: its printed text needs
   * engine systems that do not exist yet. The gaps are on the work queue.
   */
  | { readonly kind: 'addedUnplayable'; readonly card: NormalizedCard; readonly missing: readonly UnsupportedClause[] }
  /** The card is already known (curated pool or a previous import). */
  | { readonly kind: 'alreadyKnown'; readonly card: NormalizedCard }
  /** The name matched several cards; `suggestions` are real names to pick from. */
  | { readonly kind: 'ambiguous'; readonly suggestions: readonly string[] }
  | { readonly kind: 'notFound'; readonly query: string }
  | { readonly kind: 'error'; readonly message: string };

/**
 * Look up `query` on Scryfall, screen it, and add it to the pool.
 *
 * Returns a discriminated result rather than throwing, because every outcome
 * here is an ordinary thing a user can hit (typo, ambiguous name, a card whose
 * mechanics we don't support yet) and each one needs its own message.
 */
export async function addCardByName(
  query: string,
  fetchImpl: FetchLike,
  options: LookupOptions = {},
): Promise<AddCardResult> {
  const lookup: NamedLookup = await lookupCardByName(query, fetchImpl, options);

  switch (lookup.kind) {
    case 'ambiguous':
      return { kind: 'ambiguous', suggestions: lookup.suggestions };
    case 'notFound':
      return { kind: 'notFound', query: lookup.query };
    case 'error':
      return { kind: 'error', message: lookup.message };
    case 'found':
      break;
  }

  let card: NormalizedCard;
  try {
    card = normalizeCard(lookup.card as RawScryfallCard);
  } catch (err) {
    return { kind: 'error', message: err instanceof Error ? err.message : 'could not read that card' };
  }

  // Already in the curated pool or previously imported: adding again would be a
  // no-op, and saying so is more useful than a silent success. Checked by id AND
  // by name — the fuzzy endpoint returns Scryfall's default printing, whose id
  // rarely matches the printing the pool ships, and a second printing of a known
  // card is a duplicate, not a new card. Answer with the record we already have.
  const known = getCard(card.id) ?? getCardByName(card.name);
  if (known) return { kind: 'alreadyKnown', card: known };

  const compiled = compileCard(card);
  if (compiled.status === 'complete') {
    registerImportedCards([{ card, definition: compiled.definition }]);
    return { kind: 'added', card };
  }

  // Unplayable: keep the card (it is a real card and belongs in the browser and
  // in decklists), but file the engine gaps so they become work rather than a
  // message the user dismisses.
  registerImportedCards([{ card, missing: compiled.missing }]);
  recordUnsupported(card.name, compiled.missing);
  return { kind: 'addedUnplayable', card, missing: compiled.missing };
}

/** A one-line, user-facing summary of an add result. */
export function describeAddResult(result: AddCardResult): string {
  switch (result.kind) {
    case 'added':
      return `Added ${result.card.name} — fully playable.`;
    case 'addedUnplayable': {
      const systems = [...new Set(result.missing.map((m) => m.missingEngineSystem))];
      return `Added ${result.card.name}, but it can't be simulated yet: needs ${systems.join(', ')}.`;
    }
    case 'alreadyKnown':
      return `${result.card.name} is already in your card pool.`;
    case 'ambiguous':
      return result.suggestions.length > 0
        ? `That matches several cards — did you mean ${result.suggestions.slice(0, 3).join(', ')}?`
        : 'That name matches several cards. Try being more specific.';
    case 'notFound':
      return `No card found matching "${result.query}".`;
    case 'error':
      return result.message;
  }
}
