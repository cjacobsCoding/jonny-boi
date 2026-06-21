import type { ReactElement } from 'react';
import type { CardQuery } from '../lib/filter.js';
import { COLOR_FILTERS, TYPE_FILTERS, SORT_OPTIONS, type SortId } from '../lib/config.js';

interface CardToolbarProps {
  query: CardQuery;
  onChange: (query: CardQuery) => void;
  /** Number of cards currently matching, for the result counter. */
  resultCount: number;
}

/** Toggle a value in a readonly set, returning a new set (immutable). */
function toggle(set: ReadonlySet<string>, value: string): Set<string> {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

/**
 * Search + color/type filters + mana-value sort. Drives the {@link CardQuery}
 * for both the Cards browser and the Deck Builder's pool (DRY — one toolbar).
 */
export function CardToolbar({ query, onChange, resultCount }: CardToolbarProps): ReactElement {
  return (
    <div className="toolbar">
      <input
        className="input toolbar__search"
        type="search"
        placeholder="Search cards by name…"
        value={query.search}
        onChange={(event) => onChange({ ...query, search: event.target.value })}
        aria-label="Search cards by name"
      />

      <div className="filter-group" role="group" aria-label="Filter by color">
        {COLOR_FILTERS.map(({ code, label }) => {
          const active = query.colors.has(code);
          return (
            <button
              key={code}
              type="button"
              className={`chip chip--color chip-color--${code}${active ? ' chip--active' : ''}`}
              aria-pressed={active}
              title={label}
              onClick={() => onChange({ ...query, colors: toggle(query.colors, code) })}
            >
              {code}
            </button>
          );
        })}
      </div>

      <div className="filter-group" role="group" aria-label="Filter by type">
        {TYPE_FILTERS.map((type) => {
          const active = query.types.has(type);
          return (
            <button
              key={type}
              type="button"
              className={`chip${active ? ' chip--active' : ''}`}
              aria-pressed={active}
              onClick={() => onChange({ ...query, types: toggle(query.types, type) })}
            >
              {type}
            </button>
          );
        })}
      </div>

      <select
        className="select"
        value={query.sort}
        onChange={(event) => onChange({ ...query, sort: event.target.value as SortId })}
        aria-label="Sort cards"
      >
        {SORT_OPTIONS.map(({ id, label }) => (
          <option key={id} value={id}>
            {label}
          </option>
        ))}
      </select>

      <span className="result-count" aria-live="polite">
        {resultCount} card{resultCount === 1 ? '' : 's'}
      </span>
    </div>
  );
}
