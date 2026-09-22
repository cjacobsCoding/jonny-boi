/**
 * WHAT A LAB PICKER MAY OFFER — one answer, for every Lab control (§3.181).
 *
 * Two questions, and every card chooser in the Lab asks one of them:
 *
 *   - "which cards are in the hero's deck?"  → {@link heroOutOptions}
 *   - "which cards could be brought in?"     → {@link poolInOptions}
 *
 * ## ⚠️ THE IN-LIST MUST BE THE FULL ENGINE POOL
 *
 * Carried over verbatim from the rule `LabView` records, because it is the
 * reason this module has to be shared rather than copied:
 *
 * > Suggestions generates its candidates from that pool, so when this list was
 * > historically drawn from a smaller subset the Lab could recommend a swap —
 * > Kalonian Tusker for Birds of Paradise — that you then could not select in
 * > the A/B tab to verify. The two lists have to be drawn from the same pool or
 * > the feature contradicts itself.
 *
 * §3.181 adds a THIRD consumer of that list: the Suggest panel's bring-in
 * focus. A focus control that offered a different set of cards from the search
 * it restricts would be the same contradiction wearing a new hat — you would
 * pin a card the search cannot consider, and get an empty ranking with no
 * explanation. So the derivation moved here, where all three can read it.
 *
 * Do NOT quote a card count in this file: the last one that was written down
 * went stale, and `apps/web/src/data/card-index.test.ts` is the only honest
 * place to read the current number. Do not reintroduce a hand-maintained
 * shortlist either — `cardOptions.test.ts` fails if this stops returning the
 * whole playable pool.
 *
 * Pure: no DOM, no network. `allAvailableCards` reads the generated index.
 */
import { allAvailableCards } from '../cards.js';
import { isPlayableCard } from '../cards/playable.js';
import { resolveEntries, type Deck } from '../deck.js';
import type { CardOption } from '../../components/lab/panel-types.js';

/** Every distinct card the hero runs, with its copy count, by name. */
export function heroOutOptions(hero: Deck): CardOption[] {
  const options: CardOption[] = [];
  for (const { card, count } of resolveEntries(hero)) {
    options.push({ cardId: card.id, name: card.name, count });
  }
  return options.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Every card you can bring IN on a swap — the full playable pool, by name.
 *
 * §3.167 — the browsable pool is the whole of Scryfall; the Lab offers only
 * what the engine can PLAY, because a swap it cannot simulate is not a test.
 */
export function poolInOptions(): CardOption[] {
  return allAvailableCards()
    .filter(isPlayableCard)
    .map((c) => ({ cardId: c.id, name: c.name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
