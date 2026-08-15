import { useMemo, useState, useSyncExternalStore, type ReactElement } from 'react';
import type { NormalizedCard } from '@jonny-boi/data-tools';
import { allAvailableCards } from '../lib/cards.js';
import {
  importedCardCount,
  subscribeToImportedCards,
} from '../lib/decklist/importedCards.js';
import { queryCards, EMPTY_QUERY, type CardQuery } from '../lib/filter.js';
import { CardToolbar } from '../components/CardToolbar.js';
import { CardGrid } from '../components/CardGrid.js';
import { CardDetail } from '../components/CardDetail.js';
import { AddCardDialog } from '../components/AddCardDialog.js';

/**
 * The Cards browser: search + filter + sort the full pool, view a grid of real
 * Scryfall art, and open a detail modal on click.
 *
 * "The full pool" means curated cards PLUS everything imported or added à la
 * carte — this browser is the app's answer to "what cards do I have?", so a card
 * the user just added has to appear here or adding it looks like it failed. It
 * subscribes to the imported-card store so a new card shows up immediately,
 * without a reload.
 */
export function CardsView(): ReactElement {
  const [query, setQuery] = useState<CardQuery>(EMPTY_QUERY);
  const [selected, setSelected] = useState<NormalizedCard | null>(null);
  const [addOpen, setAddOpen] = useState(false);

  // Re-render whenever the imported set changes. The count is a cheap, stable
  // snapshot: it changes exactly when the card list does.
  const importedCount = useSyncExternalStore(subscribeToImportedCards, importedCardCount, () => 0);
  const pool = useMemo(() => allAvailableCards(), [importedCount]);
  const results = useMemo(() => queryCards(pool, query), [pool, query]);

  return (
    <section aria-label="Card browser">
      <div className="cards-view__actions">
        <button type="button" className="btn btn--primary" onClick={() => setAddOpen(true)}>
          + Add card
        </button>
      </div>
      <CardToolbar query={query} onChange={setQuery} resultCount={results.length} />
      <CardGrid cards={results} onSelect={setSelected} />
      {selected && <CardDetail card={selected} onClose={() => setSelected(null)} />}
      {addOpen && <AddCardDialog onClose={() => setAddOpen(false)} />}
    </section>
  );
}
