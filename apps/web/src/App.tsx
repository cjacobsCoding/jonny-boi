import { useState, type ReactElement } from 'react';
import { attribution, allCards } from './lib/cards.js';
import { useDecks } from './lib/useDecks.js';
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
] as const;

type ViewId = (typeof VIEWS)[number]['id'];

/**
 * App shell: a sticky professional header (brand + nav), the active view, and a
 * footer carrying the Scryfall attribution (etiquette). Routing is local state —
 * the PWA is a single-page shell, so we avoid a router dependency for two views.
 */
export function App(): ReactElement {
  const [view, setView] = useState<ViewId>('cards');
  const decks = useDecks();

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
        {view === 'lab' && <LabView decks={decks} />}
        {view === 'match' && <MatchView decks={decks} />}
        {view === 'proxies' && <ProxiesView decks={decks} />}
      </main>

      <footer className="app__footer">
        {allCards.length} curated cards · {attribution}
      </footer>
    </div>
  );
}
