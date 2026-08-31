import { Fragment, type ReactElement } from 'react';
import type { NormalizedCard } from '@jonny-boi/data-tools';
import { printLabel } from '../lib/proxy/prints.js';
import type { usePrints } from '../lib/proxy/usePrints.js';
import { PROXY_THUMBNAIL_WIDTH_PX } from '../lib/proxy/config.js';
import {
  isChosenPrinting,
  printingFromOption,
  type EntryPrinting,
} from '../lib/printings/entryPrinting.js';

/**
 * The per-deck-entry "which printing is this slot?" control: a badge showing the
 * chosen set, a toggle that opens a thumbnail picker, and a reset.
 *
 * It reuses the Proxies printings stack wholesale — the same on-demand Scryfall
 * lookup, the same TTL cache, the same {@link printLabel} — because a deck slot
 * and a proxy sheet are asking Scryfall the identical question ("every printing
 * of this exact name"), and two clients for one question is how they drift.
 *
 * The `prints` hook is passed IN rather than created here: one lookup is in
 * flight at a time across the whole deck list, so a hook per row would let a
 * slow response for one card land in another card's picker.
 */
export function DeckEntryPrinting({
  card,
  printing,
  prints,
  onChoose,
  onReset,
}: {
  card: NormalizedCard;
  /** The slot's chosen printing, or undefined while it is on the default art. */
  printing: EntryPrinting | undefined;
  prints: ReturnType<typeof usePrints>;
  onChoose: (cardId: string, printing: EntryPrinting) => void;
  onReset: (cardId: string) => void;
}): ReactElement {
  const open = prints.activeName === card.name;
  const badge = printing?.set ?? (printing ? 'custom' : undefined);

  // A Fragment, not a wrapper: the toggle belongs INLINE in the deck row next to
  // the +/− steppers, while the picker has to drop onto its own full-width line
  // below it. One element cannot be in both places, and a wrapper would force
  // the picker into the narrow column the toggle occupies.
  return (
    <Fragment>
      <span className="entry-printing">
        <button
          type="button"
          className={`entry-printing__toggle${printing ? ' entry-printing__toggle--custom' : ''}`}
          aria-expanded={open}
          onClick={() => (open ? prints.clear() : void prints.load(card.name))}
          title={
            printing?.label ?? `Choose which printing of ${card.name} this deck slot uses`
          }
        >
          {/* The set code IS the affordance when one is chosen: it says both
              "this slot is customised" and "customised to what" in three
              characters, which is all a dense deck list has room for. */}
          {badge ?? 'Printing'}
        </button>
        {printing && (
          <button
            type="button"
            className="entry-printing__reset"
            onClick={() => onReset(card.id)}
            aria-label={`Use the default printing of ${card.name}`}
            title={`Use the default printing of ${card.name}`}
          >
            ↺
          </button>
        )}
      </span>

      {open && (
        <div className="entry-printing__picker">
          {prints.status === 'loading' && (
            <p className="entry-printing__hint">Loading printings…</p>
          )}
          {prints.status === 'error' && (
            <p className="entry-printing__hint">
              Couldn’t reach Scryfall — printings need a connection. Try again.
            </p>
          )}
          {prints.status === 'done' && prints.prints.length === 0 && (
            <p className="entry-printing__hint">No alternate printings found.</p>
          )}
          {prints.prints.length > 0 && (
            <div className="entry-printing__grid">
              {prints.prints.map((option) => {
                const chosen = isChosenPrinting(printing, option.scryfallId);
                const label = printLabel(option);
                return (
                  <button
                    key={option.scryfallId}
                    type="button"
                    className={`entry-print${chosen ? ' entry-print--chosen' : ''}`}
                    aria-pressed={chosen}
                    title={label}
                    onClick={() => onChoose(card.id, printingFromOption(option, label))}
                  >
                    <img
                      className="entry-print__img"
                      src={option.thumbnailUrl}
                      alt={label}
                      width={PROXY_THUMBNAIL_WIDTH_PX}
                      loading="lazy"
                      decoding="async"
                      // Native image-drag hijacks pointer gestures (§3.54); every
                      // <img> the app ships has to opt out of it.
                      draggable={false}
                    />
                    <span className="entry-print__set">{option.set ?? '—'}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
    </Fragment>
  );
}
