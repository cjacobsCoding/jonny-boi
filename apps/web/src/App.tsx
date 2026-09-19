import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactElement,
} from 'react';
import { attribution, allAvailableCards } from './lib/cards.js';
import { corpusVersion, loadCorpus, subscribeToCorpus } from './lib/cards/corpus.js';
import { BugReporter } from './components/BugReporter.js';
import { registerStateSection } from './lib/bugreport/state-dump.js';
import { importedCardCount, subscribeToImportedCards } from './lib/decklist/importedCards.js';
import { NAV_FITS, computeNavOverflow, type NavOverflow } from './lib/nav-overflow.js';
import { appUpdater, updateResumeFlag } from './lib/update/updater.js';
import { UpdatePill } from './components/UpdatePill.js';
import { StorageAlert } from './components/StorageAlert.js';
import { useDecks } from './lib/useDecks.js';
import { useSimWorker } from './lib/useSimWorker.js';
import { useLabSelection } from './lib/useLabSelection.js';
import { SAMPLE_DECKS } from '@jonny-boi/sim';
import { AboutView, STORAGE_READOUT_ANCHOR_ID } from './views/AboutView.js';
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

/** Narrow an arbitrary string (e.g. from the update-resume flag) to a ViewId. */
function asViewId(value: string | undefined): ViewId | null {
  return VIEWS.some((v) => v.id === value) ? (value as ViewId) : null;
}

/**
 * The view the app opens on. Normally 'cards' — but when THIS load was caused
 * by an app update applying itself (lib/update/updater.ts wrote the flag just
 * before reloading), it is the view the user was on, so the update is
 * invisible instead of a teleport to the front page.
 */
function initialView(): ViewId {
  return asViewId(updateResumeFlag()?.view) ?? 'cards';
}

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
  // §3.167 — the corpus tier joins the count the moment it arrives, and the
  // shell starts fetching it at mount so the browser rarely has to wait.
  useSyncExternalStore(subscribeToCorpus, corpusVersion, () => 0);
  useEffect(() => {
    void loadCorpus();
  }, []);
  const cardCount = allAvailableCards().length;

  const [view, setView] = useState<ViewId>(initialView);
  const decks = useDecks();

  // The updater needs to know the current view so an update-triggered reload
  // can bring the user back to it, and — once, after an update reload — the
  // viewport is put back where it was. (The Play view separately restores its
  // own game + scroll from the persisted game record.)
  useEffect(() => {
    appUpdater.reportAppView(view);
  }, [view]);
  useEffect(() => {
    const flag = updateResumeFlag();
    if (flag) window.scrollTo(0, flag.scrollY);
  }, []);

  // On phones the nav is a swipe strip with a hidden scrollbar, and a clipped
  // edge used to end in flat background — four of the seven tabs were
  // undiscoverable at 390px (TMB-JB-0002). Measure the strip and mark each
  // edge that still hides tabs; styles.css turns the marks into an edge fade
  // plus a chevron. Desktop never overflows, so the marks stay off there.
  const navRef = useRef<HTMLElement | null>(null);
  const [navMore, setNavMore] = useState<NavOverflow>(NAV_FITS);
  useEffect(() => {
    const nav = navRef.current;
    if (nav === null) return undefined;
    const measure = (): void => {
      const next = computeNavOverflow(nav.scrollLeft, nav.clientWidth, nav.scrollWidth);
      // Preserve identity when nothing changed so scroll events don't re-render.
      setNavMore((prev) => (prev.start === next.start && prev.end === next.end ? prev : next));
    };
    measure();
    nav.addEventListener('scroll', measure, { passive: true });
    // Rotation/resize moves the overflow edge without any scroll event. Fall
    // back to window resize where ResizeObserver is missing (old WebViews).
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(nav);
    if (observer === null) window.addEventListener('resize', measure);
    return () => {
      nav.removeEventListener('scroll', measure);
      observer?.disconnect();
      if (observer === null) window.removeEventListener('resize', measure);
    };
  }, []);

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

  // What every bug report says about where the reporter WAS, without the
  // reporter knowing anything about views or decks. Registered as a section
  // (CLAUDE.md rule 3's seam) rather than passed in piece by piece, so any other
  // surface can add its own state to every future report the same way.
  useEffect(
    () =>
      registerStateSection('app', () =>
        [
          `view ${view}`,
          `cards_available ${cardCount}`,
          `decks ${decks.decks.length}`,
          `active_deck ${decks.activeDeck ? `${decks.activeDeck.name} (${decks.activeDeck.cards.length} entries)` : 'none'}`,
          ...decks.decks.map(
            (d) => `deck ${d.name} — ${d.cards.length} entries, updated ${d.updatedAt}`,
          ),
        ].join('\n'),
      ),
    [view, cardCount, decks],
  );

  const activeViewLabel = VIEWS.find((v) => v.id === view)?.label ?? view;

  // "See what is using storage" has to actually arrive at the readout, not at
  // the top of the About page. The view switch is state, so the element does not
  // exist yet when this runs — scroll on the next frame, once it has mounted.
  const openStorageReadout = useCallback(() => {
    setView('about');
    requestAnimationFrame(() => {
      document.getElementById(STORAGE_READOUT_ANCHOR_ID)?.scrollIntoView({ block: 'start' });
    });
  }, []);

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
        <div
          className={`app__nav-wrap${navMore.start ? ' app__nav-wrap--more-start' : ''}${
            navMore.end ? ' app__nav-wrap--more-end' : ''
          }`}
        >
          <nav className="app__nav" aria-label="Primary" ref={navRef}>
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
        </div>
      </header>

      {/*
        A failed save is reported HERE, above the view switch and at the moment
        it happens. Mounted in the shell for the same reason the bug reporter is:
        storage fails on whatever screen you are on, and a message inside one
        view would have to be navigated to in order to be seen.
      */}
      <StorageAlert onOpenStorageReadout={openStorageReadout} />

      <main className="app__main">
        {view === 'cards' && <CardsView />}
        {view === 'deck' && <DeckBuilderView decks={decks} />}
        {view === 'play' && <PlayView decks={decks} />}
        {view === 'lab' && <LabView decks={decks} sim={labSim} selection={labSelection} />}
        {view === 'match' && <MatchView decks={decks} sim={matchSim} />}
        {view === 'proxies' && <ProxiesView decks={decks} />}
        {view === 'about' && <AboutView decks={decks} />}
      </main>

      <footer className="app__footer">
        {cardCount.toLocaleString()} cards · {attribution}
      </footer>

      {/*
        The bug reporter mounts ONCE here, above the view switch: press B (or tap
        the button) from any view and the screen freezes on the frame the problem
        is on. A view would have to be navigated to, which loses that frame.
      */}
      <BugReporter screenName={activeViewLabel} />
      {/* The "update ready" pill — app-shell chrome, visible from any view. */}
      <UpdatePill />
    </div>
  );
}
