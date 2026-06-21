import { useMemo, useState, type ReactElement } from 'react';
import type { NormalizedCard } from '@jonny-boi/data-tools';
import { allCards } from '../lib/cards.js';
import { queryCards, EMPTY_QUERY, type CardQuery } from '../lib/filter.js';
import { CardToolbar } from '../components/CardToolbar.js';
import { CardGrid } from '../components/CardGrid.js';
import { CardDetail } from '../components/CardDetail.js';

/**
 * The Cards browser: search + filter + sort the full pool, view a grid of real
 * Scryfall art, and open a detail modal on click.
 */
export function CardsView(): ReactElement {
  const [query, setQuery] = useState<CardQuery>(EMPTY_QUERY);
  const [selected, setSelected] = useState<NormalizedCard | null>(null);

  const results = useMemo(() => queryCards(allCards, query), [query]);

  return (
    <section aria-label="Card browser">
      <CardToolbar query={query} onChange={setQuery} resultCount={results.length} />
      <CardGrid cards={results} onSelect={setSelected} />
      {selected && <CardDetail card={selected} onClose={() => setSelected(null)} />}
    </section>
  );
}
