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
 * Order matters. An unsupported card is reported FIRST, with what it needs,
 * because the sim's own validator would also reject it, but only by id — and
 * the sim's other findings are then withheld, because it counts only the cards
 * it resolved and would call the deck short by exactly the unsupported copies.
 * The one rule that can be judged over every entry regardless, the size rule,
 * is added back so a deck that is short AND unsupported says both at once.
 *
 * Pure: no React, no worker, no DOM — it reads the card pool and returns strings.
 */

import { DEFAULT_DECK_RULES, validateDeck as validateSimDeck, type Deck as SimDeck } from '@jonny-boi/sim';
import { loadCardPool } from './sim-pool.js';
import { type Deck } from './deck.js';
import { deckHealthProblems } from './decklist/deckHealth.js';
import { deckSizeProblems } from './play/setup.js';
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

  // Support first — and through the SAME funnel Play and the deck builder use.
  // This used to be a private list of names that said which cards were holding
  // the deck up but never what they needed, so "check the deck panel for what the
  // engine still needs" was the answer to a question we could just answer here.
  // It is also why the Lab and Play could disagree: they asked two different
  // functions. The size rule rides along (see `deckSizeProblems`), because the
  // sim's validator cannot be asked once cards fail to resolve: it would count
  // the deck short by exactly the unsupported copies.
  const simDeck = toSimPayload(hero) as SimDeck;
  const unsupported = deckHealthProblems(hero.cards);
  if (unsupported.length > 0) return [...unsupported, ...deckSizeProblems(simDeck, DEFAULT_DECK_RULES)];

  // `SimDeckPayload` is structurally the sim's `Deck` (name/archetype/cards), so
  // the authoritative check is the sim's own — not a UI approximation of it.
  return validateSimDeck(simDeck, loadCardPool());
}
