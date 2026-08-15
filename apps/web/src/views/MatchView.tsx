import { useMemo, useState, type ReactElement } from 'react';
import { SAMPLE_DECKS } from '@jonny-boi/sim';
import { deckSize } from '../lib/deck.js';
import type { DecksApi } from '../lib/useDecks.js';
import { toSimPayload } from '../lib/sim-format.js';
import { validateHero } from '../lib/heroValidation.js';
import { useSimWorker } from '../lib/useSimWorker.js';
import {
  DEFAULT_REPLAY_SEED,
  MAX_REPLAY_EVENTS,
} from '../lib/replay-config.js';
import { RunStatus } from '../components/RunStatus.js';
import { FidelityNote } from '../components/FidelityNote.js';
import { MatchReplay } from '../components/match/MatchReplay.js';

/**
 * The Match view (DESIGN §3.7 — watch a single AI-vs-AI game): pick a saved deck as
 * the hero, an opponent from the sample gauntlet, and a seed, then run ONE traced
 * game in the sim Web Worker and scrub through it turn by turn. Same worker/protocol
 * the rest of the Lab uses (DRY) — cancellable, never freezing the main thread.
 */
export function MatchView({ decks }: { decks: DecksApi }): ReactElement {
  const [heroId, setHeroId] = useState<string | null>(decks.activeDeck?.id ?? null);
  const [opponentName, setOpponentName] = useState<string>('');
  const [seed, setSeed] = useState(DEFAULT_REPLAY_SEED);

  const sim = useSimWorker();

  const hero = decks.decks.find((d) => d.id === heroId) ?? decks.activeDeck ?? decks.decks[0] ?? null;

  const heroProblems = useMemo(() => validateHero(hero), [hero]);
  const heroLegal = heroProblems.length === 0;

  const eligibleOpponents = useMemo(
    () => SAMPLE_DECKS.filter((d) => d.name !== hero?.name),
    [hero?.name],
  );

  // Default the opponent to the first eligible one, and never leave it on the hero.
  const chosenOpponent =
    eligibleOpponents.find((d) => d.name === opponentName)?.name ??
    eligibleOpponents[0]?.name ??
    '';

  if (decks.decks.length === 0 || (decks.decks.length === 1 && deckSize(decks.decks[0]!) === 0)) {
    return <EmptyDecksPrompt />;
  }

  const heroPayload = hero ? toSimPayload(hero) : null;
  const running = sim.status === 'running';
  const canRun = heroLegal && heroPayload !== null && chosenOpponent !== '' && !running;
  const trace = sim.status === 'done' && sim.result?.kind === 'match' ? sim.result.result : null;

  return (
    <div className="lab">
      <div className="lab-config">
        <div className="lab-config__row">
          <label className="lab-field">
            <span className="section-label">Hero deck</span>
            <select
              className="select"
              value={hero?.id ?? ''}
              onChange={(e) => {
                setHeroId(e.target.value);
                sim.reset();
              }}
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
            <span className="section-label">Opponent</span>
            <select
              className="select"
              value={chosenOpponent}
              onChange={(e) => {
                setOpponentName(e.target.value);
                sim.reset();
              }}
              aria-label="Opponent deck"
            >
              {eligibleOpponents.map((d) => (
                <option key={d.name} value={d.name}>
                  {d.name}
                </option>
              ))}
            </select>
          </label>

          <label className="lab-field">
            <span className="section-label">Seed</span>
            <input
              className="input"
              type="number"
              value={seed}
              onChange={(e) => setSeed(Number(e.target.value) || 0)}
              aria-label="Seed"
              style={{ width: '9rem' }}
            />
          </label>
        </div>
      </div>

      {!heroLegal && (
        <div className="lab-alert" role="alert">
          <strong>{hero?.name ?? 'This deck'} isn’t ready to watch:</strong>
          <ul>
            {heroProblems.map((p, i) => (
              <li key={i}>{p}</li>
            ))}
          </ul>
          <p>Fix it in the Deck Builder, then come back.</p>
        </div>
      )}

      <div className="lab-controls">
        <button
          type="button"
          className="btn btn--primary"
          disabled={!canRun}
          onClick={() =>
            heroPayload &&
            sim.run({
              kind: 'match',
              hero: heroPayload,
              opponentName: chosenOpponent,
              seed,
              maxEvents: MAX_REPLAY_EVENTS,
            })
          }
        >
          Watch a game
        </button>
        <span className="lab-hint">
          One AI-vs-AI game from this seed — step or play through it below.
        </span>
      </div>

      {running && <RunStatus progress={sim.progress} onCancel={sim.cancel} />}
      {sim.status === 'error' && (
        <div className="lab-alert lab-alert--error" role="alert">
          <strong>The match failed:</strong> {sim.error}
        </div>
      )}

      <div className="lab-panel">
        {trace ? (
          <>
            <MatchReplay key={`${trace.seed}-${trace.seats.A.deckName}-${trace.seats.B.deckName}`} trace={trace} />
            <div className="replay-footer">
              <span>
                {trace.turns} turns · {trace.actions.toLocaleString()} actions · seed {trace.seed}
              </span>
              <FidelityNote />
            </div>
          </>
        ) : (
          !running && (
            <p className="lab-placeholder">
              Pick a hero and an opponent, then <strong>Watch a game</strong> to replay it
              turn-by-turn: life totals, both boards, and a scrolling event log.
            </p>
          )
        )}
      </div>
    </div>
  );
}

/** Shown when there are no real saved decks to watch. */
function EmptyDecksPrompt(): ReactElement {
  return (
    <div className="empty-state">
      <div className="empty-state__title">No deck to watch yet</div>
      <p>
        The Match viewer plays one of your saved decks against a gauntlet opponent. Head to the{' '}
        <strong>Deck Builder</strong>, build a 60-card deck, and it will show up here.
      </p>
    </div>
  );
}
