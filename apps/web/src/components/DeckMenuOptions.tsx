import { Fragment, type ReactElement } from 'react';
import {
  menuItemsOfOrigin,
  type DeckMenuItem,
} from '../lib/decklist/deckMenu.js';
import {
  DECK_ORIGINS,
  DECK_ORIGIN_ATTR,
  originPresentation,
  type DeckOrigin,
} from '../lib/decklist/deckOrigin.js';
import './deck-origin.css';

/**
 * The `<option>`s inside any deck-choice `<select>`, grouped by where the deck
 * came from.
 *
 * ## Why a shared component and not two `menu.map()` calls
 *
 * The Play setup and the online lobby each rendered their own flat list, so
 * "Selesnya Blink" (built-in) sat one row below "Selesnya Blink (copy) · 60
 * cards" (yours) with nothing but a suffix between them. A player who had copied
 * a deck saw what looked like the same deck twice. Both surfaces now render THIS,
 * so a change to how origins are presented reaches every picker at once
 * (CLAUDE.md rule 12).
 *
 * `<optgroup>` is the right tool rather than a styled div: it is the native
 * grouping affordance, so it survives the OS-rendered dropdown on Android and
 * iOS, where no CSS of ours applies at all. An empty group is omitted — a lone
 * "Your decks" heading over nothing reads as decks that failed to load.
 */
export function DeckMenuOptions({ menu }: { menu: readonly DeckMenuItem[] }): ReactElement {
  // Group order is the TABLE's key order, so a new origin needs no edit here and
  // the running order lives in exactly one place. (This comment used to claim
  // "the user's own decks first"; the table has never said that, and a comment
  // that describes an order the code does not have is worse than none.)
  const order = Object.keys(DECK_ORIGINS) as readonly DeckOrigin[];
  const groups = order
    .map((origin) => ({ origin, items: menuItemsOfOrigin(menu, origin) }))
    .filter((group) => group.items.length > 0);

  return (
    <>
      {groups.map(({ origin, items }) => {
        const presentation = originPresentation(origin);
        return (
          <Fragment key={origin}>
            <optgroup label={presentation.groupLabel}>
              {items.map((item) => (
                // The origin marker rides on the option too, so a guard (and the
                // browser harness) can ask what a rendered row IS without
                // re-parsing its label text.
                <option key={item.key} value={item.key} {...{ [DECK_ORIGIN_ATTR]: origin }}>
                  {item.label}
                </option>
              ))}
            </optgroup>
          </Fragment>
        );
      })}
    </>
  );
}

/**
 * The note shown under a deck `<select>` saying what KIND of deck is currently
 * picked — for any origin that has something to say about itself.
 *
 * Deliberately NOT a warning and never disabling anything: playing a gauntlet
 * deck, or one of the owner's paper decks, directly is a feature these pickers
 * offer on purpose. It says what the pick is so the choice is never a surprise,
 * and points at the thing the player probably wanted if it was.
 *
 * ⚠️ This was `BuiltinDeckNote`, hard-coded to one origin, and adding a second
 * kind of bundled deck would have meant a second near-identical component and a
 * branch at both call sites. The sentence is a COLUMN in `DECK_ORIGINS`
 * (`pickerNote`) instead, so a new origin is still one row (CLAUDE.md rule 2).
 * An origin with an empty note renders nothing, which is how "your own decks"
 * stays unbadged.
 */
export function DeckOriginNote({ origin }: { origin: DeckOrigin | undefined }): ReactElement {
  if (!origin) return <></>;
  const presentation = originPresentation(origin);
  if (presentation.pickerNote === '') return <></>;
  return (
    <p className="deck-origin-note" {...{ [DECK_ORIGIN_ATTR]: origin }}>
      <span className={`deck-origin-badge deck-origin-badge--${origin}`}>
        <span aria-hidden="true">{presentation.glyph}</span> {presentation.badge}
      </span>{' '}
      {presentation.pickerNote}
    </p>
  );
}
