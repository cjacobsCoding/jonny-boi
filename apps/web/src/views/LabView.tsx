import { useMemo, type ReactElement } from 'react';
import {
  SAMPLE_DECKS,
  validateDeck as validateSimDeck,
  type Deck as SimDeck,
} from '@jonny-boi/sim';
import { allAvailableCards } from '../lib/cards.js';
import { loadCardPool } from '../lib/sim-pool.js';
import { resolveEntries, unsupportedCardNames, type Deck } from '../lib/deck.js';
import { gauntletHeroDecks, isGauntletDeckId } from '../lib/decklist/gauntletDecks.js';
import { applySwapToDeck, describeApplied } from '../lib/decklist/applySwapToDeck.js';
import { getCard } from '../lib/cards.js';
import './lab-apply.css';
import type { DecksApi } from '../lib/useDecks.js';
import { toSimPayload } from '../lib/sim-format.js';
import type { SimWorkerApi } from '../lib/useSimWorker.js';
import type { LabSelection } from '../lib/useLabSelection.js';
import {
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


/**
 * The Lab (DESIGN §3.7): pick one of your saved decks as the hero, choose which
 * gauntlet decks to test against, then run a gauntlet, an A/B single-card swap,
 * or a ranked suggestions search — all in a Web Worker so the UI never freezes.
 */
export function LabView({ decks, sim, selection }: { decks: DecksApi; sim: SimWorkerApi; selection: LabSelection }): ReactElement {
  const { tab, setTab, heroId, setHeroId, seed, setSeed, opponentNames, setOpponentNames, applyNote, setApplyNote } = selection;


  // Anything selectable as the hero: your saved decks, then the gauntlet decks.
  // The gauntlet decks are decks — being able to test one against the field (or
  // against the rest of it) is the obvious first question to ask the lab, and
  // it also means the Lab is usable before you have built anything yourself.
  const heroCandidates = useMemo(() => [...decks.decks, ...gauntletHeroDecks()], [decks.decks]);

  const hero =
    heroCandidates.find((d) => d.id === heroId) ??
    decks.activeDeck ??
    heroCandidates[0] ??
    null;

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

  // Only truly stuck when there is nothing at all to run — which no longer happens,
  // since the gauntlet decks are always available as heroes. A brand-new user can
  // open the Lab and immediately see how the meta decks fare against each other.
  if (heroCandidates.length === 0) {
    return <EmptyDecksPrompt />;
  }

  const heroPayload = hero ? toSimPayload(hero) : null;

  // Applying a verdict edits the hero — only possible for a deck the user owns.
  // A gauntlet deck is bundled build data; copy it in the builder first.
  const canEditHero = hero !== null && !isGauntletDeckId(hero.id);

  const onApplySwap = canEditHero
    ? (outCardId: string, inCardId: string, copies: number): void => {
        const result = applySwapToDeck(hero, outCardId, inCardId, copies);
        if (result.copiesMoved > 0) decks.updateDeck(result.deck);
        setApplyNote(
          describeApplied(
            result,
            getCard(outCardId)?.name ?? 'card',
            getCard(inCardId)?.name ?? 'card',
            hero.name,
          ),
        );
      }
    : undefined;

  const sharedProps = {
    hero,
    heroPayload,
    heroLegal,
    chosenOpponents,
    seed,
    sim,
    onApplySwap,
  };

  return (
    <div className="lab">
      <LabConfigBar
        heroCandidates={heroCandidates}
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

      {applyNote && (
        <p className="lab-apply-note" role="status">
          {applyNote}
        </p>
      )}

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

/**
 * Every card you can bring IN on a swap.
 *
 * Must be the FULL engine pool. Suggestions generates its candidates from that
 * pool, so when this list was historically drawn from a smaller subset the Lab
 * could recommend a swap — Kalonian Tusker for Birds of Paradise — that you then
 * could not select in the A/B tab to verify. The two lists have to be drawn from
 * the same pool or the feature contradicts itself.
 *
 * (The card index is no longer a subset: it is DERIVED from the pool and a test
 * fails if they diverge — see `apps/web/src/data/card-index.test.ts`. Both lists
 * are 156 cards today. Don't reintroduce a hand-maintained shortlist here.)
 */
function poolInOptions(): CardOption[] {
  return [...allAvailableCards()]
    .map((c) => ({ cardId: c.id, name: c.name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Validate the hero through the sim's pool + rules (the authoritative check).
 *
 * Unsupported imported cards are named FIRST. The sim's own check would reject
 * them too, but only as `unknown card "<uuid>"` — true and useless. A deck you
 * just imported deserves to be told which card is holding it up and why.
 */
function validateHero(hero: Deck): string[] {
  const unsupported = unsupportedCardNames(hero);
  if (unsupported.length > 0) {
    return [
      `${unsupported.length} card${unsupported.length === 1 ? '' : 's'} in this deck can’t be simulated yet: ${unsupported.join(', ')}. ` +
        'The deck itself is fine — swap them out to run the Lab, or check the deck panel for what the engine still needs.',
    ];
  }
  const pool = loadCardPool();
  // `SimDeckPayload` is structurally the sim's `Deck` (name/archetype/cards).
  return validateSimDeck(toSimPayload(hero) as SimDeck, pool);
}

/** The top config bar: hero picker, seed, and the gauntlet-opponent toggles. */
/** One labelled group of hero options; renders nothing when the group is empty. */
function HeroOptionGroup({ label, decks }: { label: string; decks: readonly Deck[] }): ReactElement {
  if (decks.length === 0) return <></>;
  return (
    <optgroup label={label}>
      {decks.map((d) => (
        <option key={d.id} value={d.id}>
          {d.name} · {d.cards.reduce((s, e) => s + e.count, 0)} cards
        </option>
      ))}
    </optgroup>
  );
}

function LabConfigBar({
  heroCandidates,
  heroId,
  onHero,
  seed,
  onSeed,
  eligibleOpponents,
  chosen,
  onToggleOpponent,
}: {
  heroCandidates: readonly Deck[];
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
            {/* Grouped so it is obvious which decks are yours and which are the
                bundled meta decks you are being tested against. */}
            <HeroOptionGroup
              label="Your decks"
              decks={heroCandidates.filter((d) => !isGauntletDeckId(d.id))}
            />
            <HeroOptionGroup
              label="Gauntlet decks"
              decks={heroCandidates.filter((d) => isGauntletDeckId(d.id))}
            />
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




