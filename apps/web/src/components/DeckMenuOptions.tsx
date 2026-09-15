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
  // Order matters: the user's own decks first, because that is what they are
  // usually reaching for. Driven off the table so a new origin needs no edit here.
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
 * The note shown under a deck `<select>` when the chosen deck is a built-in one.
 *
 * Deliberately NOT a warning and never disabling anything: playing a gauntlet
 * deck directly is a feature the Play setup offers on purpose. It says what the
 * pick is so the choice is never a surprise, and points at the thing the player
 * probably wanted if it was.
 */
export function BuiltinDeckNote({ origin }: { origin: DeckOrigin | undefined }): ReactElement {
  if (origin !== 'builtin') return <></>;
  const presentation = originPresentation('builtin');
  return (
    <p className="deck-origin-note" {...{ [DECK_ORIGIN_ATTR]: 'builtin' }}>
      <span className="deck-origin-badge deck-origin-badge--builtin">
        <span aria-hidden="true">{presentation.glyph}</span> {presentation.badge}
      </span>{' '}
      You can play it as-is. To tune it, copy it in the Deck Builder.
    </p>
  );
}
