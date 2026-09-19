import { useEffect, useMemo, useState, useSyncExternalStore, type ReactElement } from 'react';
import type { NormalizedCard } from '@jonny-boi/data-tools';
import { allAvailableCards } from '../lib/cards.js';
import { importedCardCount, subscribeToImportedCards } from '../lib/decklist/importedCards.js';
import {
  corpusState,
  corpusVersion,
  loadCorpus,
  retryCorpus,
  subscribeToCorpus,
} from '../lib/cards/corpus.js';
import { isPlayableCard } from '../lib/cards/playable.js';
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
  // `importedCount` is an INVISIBLE dependency, not an unnecessary one:
  // `allAvailableCards()` reads a module-level registry that deck import mutates,
  // so nothing in this call expression changes when the pool does. Drop it (as the
  // rule suggests) and an imported card stays missing from the browser until an
  // unrelated re-render happens to rebuild the memo.
  // §3.167 — and whenever the corpus tier arrives (or fails): the same
  // invisible-dependency shape as the imported count above.
  const corpusTick = useSyncExternalStore(subscribeToCorpus, corpusVersion, () => 0);
  useEffect(() => {
    void loadCorpus();
  }, []);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const pool = useMemo(() => allAvailableCards(), [importedCount, corpusTick]);
  const results = useMemo(
    () => queryCards(pool, query, { isPlayable: isPlayableCard }),
    [pool, query],
  );
  const playableCount = useMemo(
    () => (query.playable === 'all' ? results.filter(isPlayableCard).length : results.length),
    [results, query.playable],
  );
  const corpus = corpusState();

  return (
    <section aria-label="Card browser">
      <div className="cards-view__actions">
        <button type="button" className="btn btn--primary" onClick={() => setAddOpen(true)}>
          + Add card
        </button>
      </div>
      <CardToolbar
        query={query}
        onChange={setQuery}
        resultCount={results.length}
        playableCount={playableCount}
      />
      {corpus.state === 'loading' && (
        <p className="cards-view__notice" role="status">
          Loading the rest of Scryfall’s cards… showing the {pool.length.toLocaleString()} the
          engine plays meanwhile.
        </p>
      )}
      {corpus.state === 'failed' && (
        <p className="cards-view__notice cards-view__notice--failed" role="alert">
          The full card list could not be loaded ({corpus.error}) — showing the{' '}
          {pool.length.toLocaleString()} cards the engine plays. It needs one visit online.{' '}
          <button type="button" className="btn btn--ghost" onClick={() => void retryCorpus()}>
            Try again
          </button>
        </p>
      )}
      <CardGrid cards={results} onSelect={setSelected} isPlayable={isPlayableCard} />
      {selected && <CardDetail card={selected} onClose={() => setSelected(null)} />}
      {addOpen && <AddCardDialog onClose={() => setAddOpen(false)} />}
    </section>
  );
}
