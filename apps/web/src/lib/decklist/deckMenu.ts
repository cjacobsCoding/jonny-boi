/**
 * THE deck-choice menu: the player's saved decks plus the bundled built-in
 * gauntlet decks, for every surface that asks "which deck?".
 *
 * ## Why this moved out of `lib/online/`
 *
 * There were TWO of these. `lib/online/deck-menu.ts` carried a header claiming it
 * "mirrors the hotseat `SetupScreen` menu … (DRY of the option list)", while
 * `SetupScreen.tsx` kept its own private `buildMenu` with the same body copied
 * out. Two places answering one question — and when the built-in decks needed to
 * be labelled as built-in, both had to be found or one surface would have kept
 * the old ambiguous labels. So the copy is gone and both consumers read this.
 *
 * ## What a row carries
 *
 * Each item names its {@link DeckOrigin}, so the renderer never re-derives where a
 * deck came from: a built-in deck is grouped and suffixed from the ONE table in
 * `deckOrigin.ts`. Built-ins stay in the menu and stay selectable — being able to
 * play a gauntlet deck directly is a real feature, and this changes only how it is
 * LABELLED.
 */
import { SAMPLE_DECKS } from '@jonny-boi/sim';
import type { DecksApi } from '../useDecks.js';
import { deckSize } from '../deck.js';
import type { DeckChoice } from '../play/setup.js';
import { DECK_ORIGINS, type DeckOrigin } from './deckOrigin.js';

/** A flat menu item combining a label, a stable key, and the resolved choice. */
export interface DeckMenuItem {
  readonly key: string;
  readonly label: string;
  readonly choice: DeckChoice;
  /** Which kind of deck this is — the renderer groups on it, never on the key. */
  readonly origin: DeckOrigin;
}

/**
 * Saved decks (non-empty) first, then the built-in gauntlet decks.
 *
 * The label carries the origin suffix because an `<option>` can hold nothing but
 * text — no badge, no icon. The `<optgroup>` heading (see `DeckMenuOptions`) is
 * the primary signal; the suffix is what survives a screen reader reading one
 * option aloud, and what a collapsed native select shows for the current pick.
 */
export function buildDeckMenu(decks: DecksApi): DeckMenuItem[] {
  const saved: DeckMenuItem[] = decks.decks
    .filter((d) => deckSize(d) > 0)
    .map((d) => ({
      key: `saved:${d.id}`,
      label: `${d.name} · ${deckSize(d)} cards (${DECK_ORIGINS.mine.labelSuffix})`,
      choice: { source: 'saved', deck: d },
      origin: 'mine',
    }));
  const samples: DeckMenuItem[] = SAMPLE_DECKS.map((d) => ({
    key: `sample:${d.name}`,
    label: `${d.name} · ${DECK_ORIGINS.builtin.labelSuffix}`,
    choice: { source: 'sample', deck: d },
    origin: 'builtin',
  }));
  return [...saved, ...samples];
}

/** The items of one origin, in menu order. Used to fill one `<optgroup>`. */
export function menuItemsOfOrigin(
  menu: readonly DeckMenuItem[],
  origin: DeckOrigin,
): readonly DeckMenuItem[] {
  return menu.filter((item) => item.origin === origin);
}
