import { useMemo, type ReactElement } from 'react';
import { SAMPLE_DECKS } from '@jonny-boi/sim';
import { allAvailableCards } from '../lib/cards.js';
import { isPlayableCard } from '../lib/cards/playable.js';
import { resolveEntries, type Deck } from '../lib/deck.js';
import { gauntletHeroDecks, isGauntletDeckId } from '../lib/decklist/gauntletDecks.js';
import { applySwapToDeck, describeApplied } from '../lib/decklist/applySwapToDeck.js';
import { getCard } from '../lib/cards.js';
import './lab-apply.css';
import type { DecksApi } from '../lib/useDecks.js';
import { toSimPayload } from '../lib/sim-format.js';
import { validateHero } from '../lib/heroValidation.js';
import type { SimWorkerApi } from '../lib/useSimWorker.js';
import type { LabSelection } from '../lib/useLabSelection.js';
import {
  GAUNTLET_GAMES,
  SWAP_GAMES,
  SUGGEST_GAMES,
  SUGGEST_MAX_CANDIDATES,
} from '../lib/lab-config.js';
import { TRIM_DEFAULT_SETTINGS, TRIM_TARGET_SIZE } from '../lib/lab-config.js';
import { applyCutToDeck, describeCutApplied } from '../lib/lab/trimApply.js';
import type { TrimCut } from '@jonny-boi/sim';
import { RunStatus } from '../components/RunStatus.js';
import { GauntletPanel } from '../components/lab/GauntletPanel.js';
import { PilotPicker } from '../components/lab/PilotControls.js';
import { SwapPanel } from '../components/lab/SwapPanel.js';
import { SuggestPanel } from '../components/lab/SuggestPanel.js';
import { TrimPanel } from '../components/lab/TrimPanel.js';
import type { CardOption } from '../components/lab/panel-types.js';

/** The Lab's sub-tabs — the things you can run against the gauntlet. */
const LAB_TABS = [
  { id: 'gauntlet', label: 'Gauntlet' },
  { id: 'swap', label: 'A/B Swap Test' },
  { id: 'suggest', label: 'Suggestions' },
  { id: 'trim', label: 'Trim' },
] as const;

/**
 * The Lab (DESIGN §3.7): pick one of your saved decks as the hero, choose which
 * gauntlet decks to test against, then run a gauntlet, an A/B single-card swap,
 * or a ranked suggestions search — all in a Web Worker so the UI never freezes.
 */
export function LabView({
  decks,
  sim,
  selection,
}: {
  decks: DecksApi;
  sim: SimWorkerApi;
  selection: LabSelection;
}): ReactElement {
  const {
    tab,
    setTab,
    heroId,
    setHeroId,
    seed,
    setSeed,
    pilotId,
    setPilotId,
    opponentNames,
    setOpponentNames,
    applyNote,
    setApplyNote,
  } = selection;

  // Anything selectable as the hero: your saved decks, then the gauntlet decks.
  // The gauntlet decks are decks — being able to test one against the field (or
  // against the rest of it) is the obvious first question to ask the lab, and
  // it also means the Lab is usable before you have built anything yourself.
  const heroCandidates = useMemo(() => [...decks.decks, ...gauntletHeroDecks()], [decks.decks]);

  const hero =
    heroCandidates.find((d) => d.id === heroId) ?? decks.activeDeck ?? heroCandidates[0] ?? null;

  // The hero validated through the SIM's own rules (60-card / 4-of), so the
  // message matches exactly what the engine would reject — not a UI approximation.
  const heroProblems = useMemo(() => validateHero(hero), [hero]);
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

  // §3.174 — applying a REMOVAL edits the hero the same way a swap does: through
  // the deck module's own funnel, with a note that says what left. The result is
  // returned because the trim panel's auto mode has to know whether the deck
  // actually shrank before it issues the next round.
  const onApplyCut = canEditHero
    ? (cuts: readonly TrimCut[]) => {
        const result = applyCutToDeck(hero, cuts);
        if (result.copiesRemoved > 0) decks.updateDeck(result.deck);
        setApplyNote(describeCutApplied(result, hero.name));
        return result;
      }
    : undefined;

  const sharedProps = {
    hero,
    heroPayload,
    heroLegal,
    chosenOpponents,
    seed,
    pilotId,
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
        pilotId={pilotId}
        onPilot={(id) => {
          // Same reasoning as changing the hero: the result on screen was measured
          // by the OLD pilot, and leaving it up next to a picker that now says
          // something else is how a user comes to believe a win rate is a property
          // of the deck rather than of the run that produced it.
          setPilotId(id);
          sim.reset();
        }}
        runDisabled={sim.status === 'running'}
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
        {tab === 'gauntlet' && <GauntletPanel {...sharedProps} gamesConfig={GAUNTLET_GAMES} />}
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
            // §3.136 — the SAME hero card list the A/B tab cuts from, so the two
            // tabs can never offer different cards for the same deck.
            cutOptions={hero ? heroOutOptions(hero) : []}
          />
        )}
        {tab === 'trim' && (
          <TrimPanel
            {...sharedProps}
            // §3.174 — games per finalist REUSES the Suggest slider: the trim runs
            // the same adaptive ladder, one round per card cut.
            gamesConfig={SUGGEST_GAMES}
            targetConfig={TRIM_TARGET_SIZE}
            defaultSettings={TRIM_DEFAULT_SETTINGS}
            {...(onApplyCut ? { onApplyCut } : {})}
          />
        )}
      </div>
    </div>
  );
}

/** The hero's distinct cards, as out-swap options (named, deduped, sorted). */
function heroOutOptions(hero: Deck): CardOption[] {
  const options: CardOption[] = [];
  for (const { card, count } of resolveEntries(hero)) {
    options.push({ cardId: card.id, name: card.name, count });
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
 * fails if they diverge — see `apps/web/src/data/card-index.test.ts`, which is
 * also the only honest place to read the current count. Don't quote a card count
 * here — the last one went stale — and don't reintroduce a hand-maintained
 * shortlist.)
 */
function poolInOptions(): CardOption[] {
  // §3.167 — the browsable pool is the whole of Scryfall; the Lab offers only
  // what the engine can PLAY, because a swap it cannot simulate is not a test.
  return allAvailableCards()
    .filter(isPlayableCard)
    .map((c) => ({ cardId: c.id, name: c.name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The top config bar: hero picker, seed, and the gauntlet-opponent toggles. */
/** One labelled group of hero options; renders nothing when the group is empty. */
function HeroOptionGroup({
  label,
  decks,
}: {
  label: string;
  decks: readonly Deck[];
}): ReactElement {
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
  pilotId,
  onPilot,
  runDisabled,
  eligibleOpponents,
  chosen,
  onToggleOpponent,
}: {
  heroCandidates: readonly Deck[];
  heroId: string | null;
  onHero: (id: string) => void;
  seed: number;
  onSeed: (seed: number) => void;
  pilotId: string;
  onPilot: (id: string) => void;
  runDisabled: boolean;
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

      {/* The pilot sits with the hero and the seed, not with the sliders: it
          changes what the numbers MEAN, not merely how long they take to get. */}
      <div className="lab-config__row">
        <PilotPicker pilotId={pilotId} onPilot={onPilot} disabled={runDisabled} />
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
