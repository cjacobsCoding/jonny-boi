/**
 * The cards you can bring IN on an A/B swap, and which of them are pickable.
 *
 * Lives here rather than inside `LabView` so the rule is testable against the
 * shipped code path instead of a copy of it — the bug this guards used to be a
 * four-line map buried in a .tsx file.
 *
 * The list must be the FULL engine pool. Suggestions generates its candidates
 * from that pool, so when this list was historically drawn from a smaller subset
 * the Lab could recommend a swap you then could not select in the A/B tab to
 * verify — the feature contradicting itself.
 *
 * But "in the list" is not "playable". An imported card whose printed text the
 * compiler does not implement has a DISPLAY record and no engine definition
 * (`importedCards()` returns every record; `importedDefinitions()` filters to
 * the playable ones). Picking one used to build a variant deck the sim rejects:
 * the run failed before its first game with no indication of which card did it.
 *
 * So an unplayable card is listed and marked, never hidden. Hiding it would be a
 * different bug — the card is visible everywhere else in the app, so its absence
 * here reads as breakage rather than as an explanation.
 */

import { allAvailableCards } from './cards.js';
import { unsupportedReason } from './decklist/importedCards.js';
import type { CardOption } from '../components/lab/panel-types.js';

/**
 * Every card offerable as the "in" side of a swap, sorted by name.
 *
 * A card the engine cannot play carries `unavailable` naming the rules system it
 * still needs; the picker renders those disabled.
 */
export function swapInOptions(): CardOption[] {
  return [...allAvailableCards()]
    .map((card) => {
      const missing = unsupportedReason(card.id);
      if (!missing || missing.length === 0) return { cardId: card.id, name: card.name };
      return {
        cardId: card.id,
        name: card.name,
        unavailable: `can’t be simulated yet — needs ${
          missing[0]?.missingEngineSystem ?? 'an unimplemented rules system'
        }`,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}
