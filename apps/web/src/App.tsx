import { useState, useSyncExternalStore, type ReactElement } from 'react';
import { attribution, allAvailableCards } from './lib/cards.js';
import { importedCardCount, subscribeToImportedCards } from './lib/decklist/importedCards.js';
import { useDecks } from './lib/useDecks.js';
import { useSimWorker } from './lib/useSimWorker.js';
import { useLabSelection } from './lib/useLabSelection.js';
import { SAMPLE_DECKS } from '@jonny-boi/sim';
import { AboutView } from './views/AboutView.js';
import { CardsView } from './views/CardsView.js';
import { DeckBuilderView } from './views/DeckBuilderView.js';
import { LabView } from './views/LabView.js';
import { MatchView } from './views/MatchView.js';
import { PlayView } from './views/PlayView.js';
import { ProxiesView } from './views/ProxiesView.js';

/** The top-level views the header navigates between. */
const VIEWS = [
  { id: 'cards', label: 'Cards' },
  { id: 'deck', label: 'Deck Builder' },
  { id: 'play', label: 'Play' },
  { id: 'lab', label: 'Lab' },
  { id: 'match', label: 'Watch a Game' },
  { id: 'proxies', label: 'Proxies' },
  { id: 'about', label: 'About' },
] as const;

type ViewId = (typeof VIEWS)[number]['id'];

/**
 * App shell: a sticky professional header (brand + nav), the active view, and a
 * footer carrying the Scryfall attribution (etiquette). Routing is local state —
 * the PWA is a single-page shell, so we avoid a router dependency for two views.
 */
export function App(): ReactElement {
  // The footer count must be the LIVE pool, not the bundled curated slice — it
  // read a stale, never-changing number that looked hardcoded, and stayed wrong
  // after adding a card. Subscribing to the imported-card store keeps it honest.
  useSyncExternalStore(subscribeToImportedCards, importedCardCount, importedCardCount);
  const cardCount = allAvailableCards().length;

  const [view, setView] = useState<ViewId>('cards');
  const decks = useDecks();

  // The sim workers live HERE, above the views, so a run survives navigation.
  // Owned by `LabView`/`MatchView` they were destroyed the moment you switched
  // tabs — a long gauntlet you left to check a card list was silently thrown
  // away, with no indication it had even stopped. Each surface keeps its own
  // worker so a replay and a gauntlet can be in flight at once.
  const labSim = useSimWorker();
  const matchSim = useSimWorker();
  // The Lab's hero/seed/opponent choices live here too, so a result and the
  // question that produced it survive navigation together.
  const labSelection = useLabSelection(SAMPLE_DECKS.map((d) => d.name));

  return (
    <div className="app">
      <header className="app__header">
        <div className="app__brand">
          <span className="app__brand-mark" aria-hidden="true">
            ⚙
          </span>
          <span>jonny-boi</span>
          <span style={{ color: 'var(--color-fg-faint)', fontSize: 'var(--text-xs)' }}>
            deck lab
          </span>
        </div>
        <nav className="app__nav" aria-label="Primary">
          {VIEWS.map(({ id, label }) => (
            <button
              key={id}
              type="button"
              className={`nav-link${view === id ? ' nav-link--active' : ''}`}
              aria-current={view === id ? 'page' : undefined}
              onClick={() => setView(id)}
            >
              {label}
            </button>
          ))}
        </nav>
      </header>

      <main className="app__main">
        {view === 'cards' && <CardsView />}
        {view === 'deck' && <DeckBuilderView decks={decks} />}
        {view === 'play' && <PlayView decks={decks} />}
        {view === 'lab' && <LabView decks={decks} sim={labSim} selection={labSelection} />}
        {view === 'match' && <MatchView decks={decks} sim={matchSim} />}
        {view === 'proxies' && <ProxiesView decks={decks} />}
        {view === 'about' && <AboutView />}
      </main>

      <footer className="app__footer">
        {cardCount} cards · {attribution}
      </footer>
    </div>
  );
}

