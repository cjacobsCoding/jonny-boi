/**
 * "Can this deck actually be run?" — the one answer, for every surface that runs one.
 *
 * The Lab and the Match viewer both hand a deck to the sim, so both must ask the
 * same question and get the same words back. This used to be a private
 * `validateHero` copied into each view, and the copies had already drifted: the
 * Lab named unsupported imported cards, the Match viewer did not, so watching a
 * game with a freshly imported deck failed with the sim's raw
 * `unknown card "<uuid>"` — true and useless (DESIGN §1.3, one mechanism per
 * concept).
 *
 * Order matters. An unsupported imported card is reported FIRST and on its own,
 * because the sim's own validator would also reject it, but only by id. A deck
 * you just imported deserves to be told which card is holding it up.
 *
 * Pure: no React, no worker, no DOM — it reads the card pool and returns strings.
 */

import { validateDeck as validateSimDeck, type Deck as SimDeck } from '@jonny-boi/sim';
import { loadCardPool } from './sim-pool.js';
import { unsupportedCardNames, type Deck } from './deck.js';
import { toSimPayload } from './sim-format.js';

/** Shown when no deck is selected at all — not a validation failure, an empty state. */
export const NO_DECK_SELECTED = 'No deck selected.';

/**
 * Why this deck cannot be simulated, as user-facing lines. Empty means it can.
 *
 * @param hero The deck to check, or `null` when nothing is selected.
 */
export function validateHero(hero: Deck | null): string[] {
  if (!hero) return [NO_DECK_SELECTED];

  const unsupported = unsupportedCardNames(hero);
  if (unsupported.length > 0) {
    const count = `${unsupported.length} card${unsupported.length === 1 ? '' : 's'}`;
    return [
      `${count} in this deck can’t be simulated yet: ${unsupported.join(', ')}. ` +
        'The deck itself is fine — swap them out to run it, or check the deck panel ' +
        'for what the engine still needs.',
    ];
  }

  // `SimDeckPayload` is structurally the sim's `Deck` (name/archetype/cards), so
  // the authoritative check is the sim's own — not a UI approximation of it.
  return validateSimDeck(toSimPayload(hero) as SimDeck, loadCardPool());
}
