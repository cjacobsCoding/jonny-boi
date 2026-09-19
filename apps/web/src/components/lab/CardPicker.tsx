/**
 * THE CARD PICKER — type to filter, with the browser's own filters one click
 * away (DESIGN §3.165).
 *
 * > "Anytime we have a card selector dropdown like this in the app, we must make
 * > it one where you can type to filter, and expose advanced settings to filter
 * > further too - to help you find the one card."
 *
 * A combobox in the WAI-ARIA sense: a text input that filters a listbox of
 * cards, arrow keys to move, Enter to pick, Escape to close. The filtering and
 * ranking are `lib/lab/cardPicker.ts` (pure, tested); the colour and type chips
 * are the card browser's own vocabulary (`COLOR_FILTERS`, `TYPE_FILTERS`), so a
 * filter here means what it means in the Cards view. Every selector that picks
 * ONE card from a list of any size goes through this component — the Lab's cut
 * and add pickers today, and whatever comes next.
 *
 * ⚠️ The candidate list is the caller's (the hero's cards for "cut", the whole
 * pool for "add"); this component never decides which cards are pickable. A
 * card the caller lists but the pool cannot describe is still offered, by name.
 */
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactElement } from 'react';
import type { NormalizedCard } from '@jonny-boi/data-tools';
import { getCard } from '../../lib/cards.js';
import { COLOR_FILTERS, TYPE_FILTERS } from '../../lib/config.js';
import { EMPTY_QUERY, type CardQuery } from '../../lib/filter.js';
import {
  hasAdvancedFilters,
  listPickableCardsWithin,
  type CardPickerFilters,
  type ManaValueBounds,
  type PickableCard,
} from '../../lib/lab/cardPicker.js';
import { ManaCost } from '../ManaCost.js';
import './card-picker.css';

export interface CardPickerProps {
  /** What the picker is for — the visible label and the accessible name. */
  readonly label: string;
  /** The cards that may be picked. Order is irrelevant; the model ranks. */
  readonly options: readonly PickableCard[];
  /** The picked card's id, or `''` for none. */
  readonly value: string;
  readonly onChange: (cardId: string) => void;
  readonly disabled?: boolean;
  readonly placeholder?: string;
}

function toggle(set: ReadonlySet<string>, code: string): ReadonlySet<string> {
  const next = new Set(set);
  if (next.has(code)) next.delete(code);
  else next.add(code);
  return next;
}

/** A stand-in record for an option the pool cannot describe — offered by name, unfiltered by kind. */
function describedCard(option: PickableCard): NormalizedCard {
  return (
    getCard(option.cardId) ??
    ({
      id: option.cardId,
      name: option.name,
      manaCost: { generic: 0, W: 0, U: 0, B: 0, R: 0, G: 0, C: 0, other: [] },
      cmc: 0,
      typeLine: { supertypes: [], types: [], subtypes: [] },
      rawTypeLine: '',
      oracleText: '',
      power: null,
      toughness: null,
      colors: [],
      colorIdentity: [],
      keywords: [],
      set: '',
    } as unknown as NormalizedCard)
  );
}

export function CardPicker({ label, options, value, onChange, disabled, placeholder }: CardPickerProps): ReactElement {
  const id = useId();
  const listId = `${id}-list`;
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [active, setActive] = useState(0);
  const [showFilters, setShowFilters] = useState(false);
  const [query, setQuery] = useState<CardQuery>(EMPTY_QUERY);
  const [manaValue, setManaValue] = useState<ManaValueBounds>({});
  const rootRef = useRef<HTMLDivElement>(null);

  const countById = useMemo(() => new Map(options.map((o) => [o.cardId, o.count])), [options]);
  const candidates = useMemo(() => options.map(describedCard), [options]);
  const filters: CardPickerFilters = { query: { ...query, search: text }, manaValue };
  const listing = useMemo(
    () => listPickableCardsWithin(candidates, { ...query, search: text }, manaValue),
    [candidates, query, text, manaValue],
  );
  const picked = options.find((o) => o.cardId === value);

  // Close on a click anywhere else — the listbox is not modal.
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const pick = (cardId: string): void => {
    onChange(cardId);
    setText('');
    setOpen(false);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setOpen(true);
      setActive((i) => Math.min(i + 1, Math.max(listing.rows.length - 1, 0)));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (event.key === 'Enter') {
      const row = listing.rows[active];
      if (open && row) {
        event.preventDefault();
        pick(row.id);
      }
    } else if (event.key === 'Escape') {
      setOpen(false);
      setText('');
    }
  };

  const advanced = hasAdvancedFilters(filters);

  return (
    <div className={`card-picker${open ? ' card-picker--open' : ''}`} ref={rootRef}>
      <label className="card-picker__label section-label" htmlFor={id}>
        {label}
      </label>
      <div className="card-picker__row">
        <input
          id={id}
          className="input card-picker__input"
          type="text"
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={open && listing.rows[active] ? `${listId}-${active}` : undefined}
          autoComplete="off"
          disabled={disabled}
          placeholder={picked ? picked.name : (placeholder ?? 'Type a card name…')}
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            setActive(0);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
        />
        <button
          type="button"
          className={`btn btn--ghost card-picker__filters-toggle${advanced ? ' card-picker__filters-toggle--active' : ''}`}
          aria-pressed={showFilters}
          disabled={disabled}
          onClick={() => {
            setShowFilters((v) => !v);
            setOpen(true);
          }}
          title="Filter by colour, type and mana value"
        >
          Filters{advanced ? ' •' : ''}
        </button>
      </div>
      {picked && !open && (
        <div className="card-picker__picked" aria-live="polite">
          <span className="card-picker__picked-name">{picked.name}</span>
          {picked.count !== undefined && <span className="card-picker__count">×{picked.count}</span>}
        </div>
      )}

      {open && (
        <div className="card-picker__popover">
          {showFilters && (
            <div className="card-picker__filters">
              <div className="filter-group" role="group" aria-label={`${label}: filter by color`}>
                {COLOR_FILTERS.map(({ code, label: colourLabel }) => {
                  const on = query.colors.has(code);
                  return (
                    <button
                      key={code}
                      type="button"
                      className={`chip chip--color chip-color--${code}${on ? ' chip--active' : ''}`}
                      aria-pressed={on}
                      title={colourLabel}
                      onClick={() => setQuery({ ...query, colors: toggle(query.colors, code) })}
                    >
                      {code}
                    </button>
                  );
                })}
              </div>
              <div className="filter-group" role="group" aria-label={`${label}: filter by type`}>
                {TYPE_FILTERS.map((type) => {
                  const on = query.types.has(type);
                  return (
                    <button
                      key={type}
                      type="button"
                      className={`chip${on ? ' chip--active' : ''}`}
                      aria-pressed={on}
                      onClick={() => setQuery({ ...query, types: toggle(query.types, type) })}
                    >
                      {type}
                    </button>
                  );
                })}
              </div>
              <div className="card-picker__mv" role="group" aria-label={`${label}: mana value`}>
                <span>Mana value</span>
                <input
                  className="input card-picker__mv-input"
                  type="number"
                  min={0}
                  inputMode="numeric"
                  aria-label="Minimum mana value"
                  placeholder="min"
                  value={manaValue.min ?? ''}
                  onChange={(event) =>
                    setManaValue({ ...manaValue, min: event.target.value === '' ? undefined : Number(event.target.value) })
                  }
                />
                <span aria-hidden="true">–</span>
                <input
                  className="input card-picker__mv-input"
                  type="number"
                  min={0}
                  inputMode="numeric"
                  aria-label="Maximum mana value"
                  placeholder="max"
                  value={manaValue.max ?? ''}
                  onChange={(event) =>
                    setManaValue({ ...manaValue, max: event.target.value === '' ? undefined : Number(event.target.value) })
                  }
                />
                {advanced && (
                  <button
                    type="button"
                    className="btn btn--ghost card-picker__clear"
                    onClick={() => {
                      setQuery(EMPTY_QUERY);
                      setManaValue({});
                    }}
                  >
                    Clear filters
                  </button>
                )}
              </div>
            </div>
          )}
          <ul id={listId} className="card-picker__list" role="listbox" aria-label={label}>
            {listing.rows.length === 0 && (
              <li className="card-picker__empty" role="presentation">
                No card matches{text ? ` “${text}”` : ''}
                {advanced ? ' with these filters' : ''}.
              </li>
            )}
            {listing.rows.map((card, index) => {
              const count = countById.get(card.id);
              return (
                <li
                  key={card.id}
                  id={`${listId}-${index}`}
                  role="option"
                  aria-selected={card.id === value}
                  className={`card-picker__option${index === active ? ' card-picker__option--active' : ''}${card.id === value ? ' card-picker__option--picked' : ''}`}
                  onMouseDown={(event) => {
                    // mousedown, not click: the input blurs on click and the
                    // document listener above would close the list first.
                    event.preventDefault();
                    pick(card.id);
                  }}
                  onMouseEnter={() => setActive(index)}
                >
                  <span className="card-picker__option-name">{card.name}</span>
                  {count !== undefined && <span className="card-picker__count">×{count}</span>}
                  <span className="card-picker__option-type">{card.rawTypeLine}</span>
                  <span className="card-picker__option-cost">
                    <ManaCost cost={card.manaCost} />
                  </span>
                </li>
              );
            })}
          </ul>
          <div className="card-picker__footer" aria-live="polite">
            {listing.omitted > 0
              ? `${listing.rows.length} of ${listing.total} shown — keep typing to narrow it down`
              : `${listing.total} card${listing.total === 1 ? '' : 's'}`}
          </div>
        </div>
      )}
    </div>
  );
}
