/**
 * THE deck-choice menu: the player's saved decks, the owner's bundled PAPER
 * decks, and the built-in gauntlet decks — for every surface that asks "which
 * deck?".
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
import { OWNER_DECKS, SAMPLE_DECKS, transcribedSize } from '@jonny-boi/sim';
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
 * Saved decks (non-empty) first, then the built-in gauntlet decks, then the
 * owner's paper decks.
 *
 * ⚠️ ARRAY ORDER IS NOT RENDER ORDER — `DeckMenuOptions` groups by origin, and
 * the groups run in `DECK_ORIGINS` key order. What this order DOES decide is the
 * default pick: `SetupScreen` seeds seat A with `menu[0]` and seat B with
 * `menu[1]`. Paper decks are appended LAST for exactly that reason. Two of the
 * three are short of cards the pool does not carry yet, and defaulting a seat to
 * a deck that cannot start would greet the player with "Not ready" before they
 * had chosen anything.
 *
 * ⚠️ Paper decks are listed WHOLE, short or not, and deliberately: the shortfall
 * is reported by `validateChoice` under the control, naming every missing card.
 * Hiding a short deck would put us back where this feature started — his decks
 * not being in the app, with no explanation.
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
  const owner: DeckMenuItem[] = OWNER_DECKS.map((d) => ({
    key: `owner:${d.name}`,
    label: `${d.name} · ${transcribedSize(d)} cards (${DECK_ORIGINS.owner.labelSuffix})`,
    choice: { source: 'owner', deck: d },
    origin: 'owner',
  }));
  return [...saved, ...samples, ...owner];
}

/** The items of one origin, in menu order. Used to fill one `<optgroup>`. */
export function menuItemsOfOrigin(
  menu: readonly DeckMenuItem[],
  origin: DeckOrigin,
): readonly DeckMenuItem[] {
  return menu.filter((item) => item.origin === origin);
}
