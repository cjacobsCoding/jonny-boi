import { useEffect, useMemo, useState, useSyncExternalStore, type ReactElement } from 'react';
import type { NormalizedCard } from '@jonny-boi/data-tools';
import { allAvailableCards, cardPoolVersion, subscribeToCardPool } from '../lib/cards.js';
import { browseIndexStatus, describeBrowseIndex, ensureBrowseIndex, subscribeToBrowseIndex } from '../lib/cards/browseIndex.js';
import { queryCards, EMPTY_QUERY, type CardQuery } from '../lib/filter.js';
import { CardToolbar } from '../components/CardToolbar.js';
import './catalogue-status.css';
import { CardGrid } from '../components/CardGrid.js';
import { CardDetail } from '../components/CardDetail.js';
import { AddCardDialog } from '../components/AddCardDialog.js';

/**
 * The Cards browser: search + filter + sort the full pool, view a grid of real
 * Scryfall art, and open a detail modal on click.
 *
 * "The full pool" means curated cards PLUS everything imported or added à la
 * carte PLUS — once it has loaded — every other card Scryfall knows
 * (`lib/cards/browseIndex.ts`): this browser is the app's answer to "what cards
 * are there?". A browse-only card is shown, searchable and addable; whether it
 * can be PLAYED is the deck builder's and the setup screen's question, and they
 * answer it by name. The view subscribes to the one card-pool signal so an
 * import or the catalogue arriving shows up immediately, without a reload, and
 * it says plainly when the catalogue is loading or could not be loaded — a
 * browser that quietly showed a quarter of Scryfall would look complete.
 */
export function CardsView(): ReactElement {
  const [query, setQuery] = useState<CardQuery>(EMPTY_QUERY);
  const [selected, setSelected] = useState<NormalizedCard | null>(null);
  const [addOpen, setAddOpen] = useState(false);

  // Re-render whenever the available set changes — an import OR the catalogue
  // arriving. The version is a cheap, stable snapshot: it changes exactly when
  // the card list does.
  const poolVersion = useSyncExternalStore(subscribeToCardPool, cardPoolVersion, cardPoolVersion);
  const catalogue = useSyncExternalStore(subscribeToBrowseIndex, browseIndexStatus, browseIndexStatus);
  // This is the view that wants the whole catalogue; ask for it on mount. Idempotent.
  useEffect(() => {
    void ensureBrowseIndex();
  }, []);
  // `poolVersion` is an INVISIBLE dependency, not an unnecessary one:
  // `allAvailableCards()` reads module-level registries that deck import and the
  // catalogue loader mutate, so nothing in this call expression changes when the
  // pool does. Drop it (as the rule suggests) and a new card stays missing from
  // the browser until an unrelated re-render happens to rebuild the memo.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const pool = useMemo(() => allAvailableCards(), [poolVersion]);
  const catalogueNote = describeBrowseIndex(catalogue);
  const results = useMemo(() => queryCards(pool, query), [pool, query]);

  return (
    <section aria-label="Card browser">
      <div className="cards-view__actions">
        <button type="button" className="btn btn--primary" onClick={() => setAddOpen(true)}>
          + Add card
        </button>
      </div>
      <CardToolbar query={query} onChange={setQuery} resultCount={results.length} />
      {catalogueNote && (
        <p className="cards-view__catalogue" role="status">
          {catalogueNote}
          {catalogue.kind === 'failed' && (
            <>
              {' '}
              <button type="button" className="btn btn--ghost btn--small" onClick={() => void ensureBrowseIndex()}>
                Try again
              </button>
            </>
          )}
        </p>
      )}
      <CardGrid cards={results} onSelect={setSelected} />
      {selected && <CardDetail card={selected} onClose={() => setSelected(null)} />}
      {addOpen && <AddCardDialog onClose={() => setAddOpen(false)} />}
    </section>
  );
}
