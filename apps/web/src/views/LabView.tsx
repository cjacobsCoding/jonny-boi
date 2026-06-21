import { useMemo, useState, type ReactElement } from 'react';
import {
  SAMPLE_DECKS,
  validateDeck as validateSimDeck,
  type Deck as SimDeck,
} from '@jonny-boi/sim';
import { allCards } from '../lib/cards.js';
import { loadCardPool } from '../lib/sim-pool.js';
import { resolveEntries, deckSize, type Deck } from '../lib/deck.js';
import type { DecksApi } from '../lib/useDecks.js';
import { toSimPayload } from '../lib/sim-format.js';
import { useSimWorker } from '../lib/useSimWorker.js';
import {
  DEFAULT_LAB_SEED,
  GAUNTLET_GAMES,
  SWAP_GAMES,
  SUGGEST_GAMES,
  SUGGEST_MAX_CANDIDATES,
} from '../lib/lab-config.js';
import { RunStatus } from '../components/RunStatus.js';
import { GauntletPanel } from '../components/lab/GauntletPanel.js';
import { SwapPanel } from '../components/lab/SwapPanel.js';
import { SuggestPanel } from '../components/lab/SuggestPanel.js';
import type { CardOption } from '../components/lab/panel-types.js';

/** The Lab's sub-tabs — the three things you can run against the gauntlet. */
const LAB_TABS = [
  { id: 'gauntlet', label: 'Gauntlet' },
  { id: 'swap', label: 'A/B Swap Test' },
  { id: 'suggest', label: 'Suggestions' },
] as const;

type LabTabId = (typeof LAB_TABS)[number]['id'];

/**
 * The Lab (DESIGN §3.7): pick one of your saved decks as the hero, choose which
 * gauntlet decks to test against, then run a gauntlet, an A/B single-card swap,
 * or a ranked suggestions search — all in a Web Worker so the UI never freezes.
 */
export function LabView({ decks }: { decks: DecksApi }): ReactElement {
  const [tab, setTab] = useState<LabTabId>('gauntlet');
  const [heroId, setHeroId] = useState<string | null>(decks.activeDeck?.id ?? null);
  const [seed, setSeed] = useState(DEFAULT_LAB_SEED);
  const [opponentNames, setOpponentNames] = useState<string[]>(() =>
    SAMPLE_DECKS.map((d) => d.name),
  );

  const sim = useSimWorker();

  const hero =
    decks.decks.find((d) => d.id === heroId) ?? decks.activeDeck ?? decks.decks[0] ?? null;

  // The hero validated through the SIM's own rules (60-card / 4-of), so the
  // message matches exactly what the engine would reject — not a UI approximation.
  const heroProblems = useMemo(() => (hero ? validateHero(hero) : ['No deck selected.']), [hero]);
  const heroLegal = heroProblems.length === 0;

  // Eligible gauntlet opponents exclude the hero (you don't fight yourself).
  const eligibleOpponents = useMemo(
    () => SAMPLE_DECKS.filter((d) => d.name !== hero?.name),
    [hero?.name],
  );
  const chosenOpponents = opponentNames.filter((n) => eligibleOpponents.some((d) => d.name === n));

  if (decks.decks.length === 0 || (decks.decks.length === 1 && deckSize(decks.decks[0]!) === 0)) {
    return <EmptyDecksPrompt />;
  }

  const heroPayload = hero ? toSimPayload(hero) : null;

  const sharedProps = {
    hero,
    heroPayload,
    heroLegal,
    chosenOpponents,
    seed,
    sim,
  };

  return (
    <div className="lab">
      <LabConfigBar
        decks={decks}
        heroId={hero?.id ?? null}
        onHero={(id) => {
          setHeroId(id);
          sim.reset();
        }}
        seed={seed}
        onSeed={setSeed}
        eligibleOpponents={eligibleOpponents.map((d) => d.name)}
        chosen={chosenOpponents}
        onToggleOpponent={(name) =>
          setOpponentNames((current) =>
            current.includes(name) ? current.filter((n) => n !== name) : [...current, name],
          )
        }
      />

      {!heroLegal && (
        <div className="lab-alert" role="alert">
          <strong>{hero?.name ?? 'This deck'} isn’t ready to run:</strong>
          <ul>
            {heroProblems.map((p, i) => (
              <li key={i}>{p}</li>
            ))}
          </ul>
          <p>Fix it in the Deck Builder, then come back.</p>
        </div>
      )}

      <nav className="lab-tabs" aria-label="Lab mode">
        {LAB_TABS.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            className={`lab-tab${tab === id ? ' lab-tab--active' : ''}`}
            aria-current={tab === id ? 'true' : undefined}
            onClick={() => {
              setTab(id);
              sim.reset();
            }}
          >
            {label}
          </button>
        ))}
      </nav>

      {sim.status === 'running' && <RunStatus progress={sim.progress} onCancel={sim.cancel} />}
      {sim.status === 'error' && (
        <div className="lab-alert lab-alert--error" role="alert">
          <strong>The run failed:</strong> {sim.error}
        </div>
      )}

      <div className="lab-panel">
        {tab === 'gauntlet' && (
          <GauntletPanel {...sharedProps} gamesConfig={GAUNTLET_GAMES} />
        )}
        {tab === 'swap' && (
          <SwapPanel
            {...sharedProps}
            gamesConfig={SWAP_GAMES}
            outOptions={hero ? heroOutOptions(hero) : []}
            inOptions={poolInOptions()}
          />
        )}
        {tab === 'suggest' && (
          <SuggestPanel
            {...sharedProps}
            gamesConfig={SUGGEST_GAMES}
            maxCandidatesConfig={SUGGEST_MAX_CANDIDATES}
          />
        )}
      </div>
    </div>
  );
}

/** The hero's distinct cards, as out-swap options (named, deduped, sorted). */
function heroOutOptions(hero: Deck): CardOption[] {
  const options: CardOption[] = [];
  for (const { card } of resolveEntries(hero)) {
    options.push({ cardId: card.id, name: card.name });
  }
  return options.sort((a, b) => a.name.localeCompare(b.name));
}

/** The full curated pool, as in-swap options (you can bring in any pool card). */
function poolInOptions(): CardOption[] {
  return [...allCards]
    .map((c) => ({ cardId: c.id, name: c.name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Validate the hero through the sim's pool + rules (the authoritative check). */
function validateHero(hero: Deck): string[] {
  const pool = loadCardPool();
  // `SimDeckPayload` is structurally the sim's `Deck` (name/archetype/cards).
  return validateSimDeck(toSimPayload(hero) as SimDeck, pool);
}

/** The top config bar: hero picker, seed, and the gauntlet-opponent toggles. */
function LabConfigBar({
  decks,
  heroId,
  onHero,
  seed,
  onSeed,
  eligibleOpponents,
  chosen,
  onToggleOpponent,
}: {
  decks: DecksApi;
  heroId: string | null;
  onHero: (id: string) => void;
  seed: number;
  onSeed: (seed: number) => void;
  eligibleOpponents: readonly string[];
  chosen: readonly string[];
  onToggleOpponent: (name: string) => void;
}): ReactElement {
  return (
    <div className="lab-config">
      <div className="lab-config__row">
        <label className="lab-field">
          <span className="section-label">Hero deck</span>
          <select
            className="select"
            value={heroId ?? ''}
            onChange={(e) => onHero(e.target.value)}
            aria-label="Hero deck"
          >
            {decks.decks.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name} · {d.cards.reduce((s, e) => s + e.count, 0)} cards
              </option>
            ))}
          </select>
        </label>

        <label className="lab-field">
          <span className="section-label">Base seed</span>
          <input
            className="input"
            type="number"
            value={seed}
            onChange={(e) => onSeed(Number(e.target.value) || 0)}
            aria-label="Base seed"
            style={{ width: '9rem' }}
          />
        </label>
      </div>

      <div className="lab-field">
        <span className="section-label">Gauntlet opponents</span>
        <div className="filter-group">
          {eligibleOpponents.map((name) => {
            const active = chosen.includes(name);
            return (
              <button
                key={name}
                type="button"
                className={`chip${active ? ' chip--active' : ''}`}
                aria-pressed={active}
                onClick={() => onToggleOpponent(name)}
              >
                {name}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/** Shown when there are no real saved decks to run. */
function EmptyDecksPrompt(): ReactElement {
  return (
    <div className="empty-state">
      <div className="empty-state__title">No deck to test yet</div>
      <p>
        The Lab runs one of your saved decks against the meta gauntlet. Head to the{' '}
        <strong>Deck Builder</strong>, build a 60-card deck, and it will show up here as a hero.
      </p>
    </div>
  );
}
