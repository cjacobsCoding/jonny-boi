/**
 * THE deck-choice menu: the player's own decks and the built-in gauntlet decks
 * — for every surface that asks "which deck?".
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
import { validateChoice, type DeckChoice } from '../play/setup.js';
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
 * His own decks (non-empty) first, then the built-in gauntlet decks.
 *
 * ⚠️ ARRAY ORDER IS NOT RENDER ORDER — `DeckMenuOptions` groups by origin, and
 * the groups run in `DECK_ORIGINS` key order. What this order DOES decide is the
 * default pick: {@link defaultSeatKeys} walks it in order for the first two decks
 * that can actually be started.
 *
 * ⚠️ A deck of his is listed WHOLE, short or not, and deliberately: the shortfall
 * is reported by `validateChoice` under the control, naming what is wrong.
 * Hiding a short deck would put us back where this started — his decks not being
 * in the app, with no explanation. A transcribed deck needs no special case here
 * at all: by the time this runs it is one of his saved decks like any other.
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

/**
 * Which decks the two seats START on: the first two that can actually be played,
 * in menu order, seat B avoiding seat A's deck when it can.
 *
 * ⚠️ It used to be `menu[0]` and `menu[1]`, full stop — and the menu lists his
 * own decks first. The moment his transcribed paper decks were seeded as saved
 * decks (§3.157), seat B defaulted to the one that cannot start — 49 cards, five
 * of them unsupported — so the default Solo setup opened with Start disabled and
 * a legality message under it, and the board-fits harness, which sets only seat
 * A, could never start a game: `main` went red on the merge that seeded them and
 * stayed red. A setup screen that opens un-startable is a worse first impression
 * than one that opens on a deck that can, and a harness that trips over it is
 * telling us so.
 *
 * Legality is asked of {@link validateChoice} — the same answer the Start button
 * itself is gated on — never re-derived here. When NOTHING in the menu is legal
 * the seats fall back to the first rows, so the screen still shows a pick and the
 * problem text under it says why it cannot start.
 */
export function defaultSeatKeys(menu: readonly DeckMenuItem[]): { readonly a: string; readonly b: string } {
  const legal = menu.filter((item) => validateChoice(item.choice).length === 0);
  const a = legal[0] ?? menu[0];
  const b = legal.find((item) => item !== a) ?? a ?? menu[1] ?? menu[0];
  return { a: a?.key ?? '', b: b?.key ?? '' };
}

/** The items of one origin, in menu order. Used to fill one `<optgroup>`. */
export function menuItemsOfOrigin(
  menu: readonly DeckMenuItem[],
  origin: DeckOrigin,
): readonly DeckMenuItem[] {
  return menu.filter((item) => item.origin === origin);
}
