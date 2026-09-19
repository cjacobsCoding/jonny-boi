import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import {
  DEFAULT_TRIM_CONFIG,
  deckFingerprint,
  type TrimCut,
  type LandRatio,
  type TrimOnImprovement,
  type TrimOnNoImprovement,
  type TrimRoundKind,
  type TrimRoundReport,
  type TrimRow,
  type TrimSettings,
} from '@jonny-boi/sim';
import { FidelityNote } from '../FidelityNote.js';
import { RunSlider } from './RunSlider.js';
import { PilotStamp, RunCostNote } from './PilotControls.js';
import { ciStr, pct, pValueStr, signedPct, throughputText, verdictDisplay } from '../../lib/sim-format.js';
import { estimateSuggestionGames } from '../../lib/sim/plan.js';
import type { GamesConfig, PanelProps } from './panel-types.js';
import type { ApplyCutResult } from '../../lib/lab/trimApply.js';
import {
  FIRST_ROUND_KIND,
  landRatioOfWebDeck,
  stepAfterApply,
  stepAfterRound,
  targetProblem,
} from '../../lib/lab/trimSession.js';
import './trim-panel.css';

/** The target-size input's bounds (named in `lab-config`). */
export interface TargetConfig {
  readonly default: number;
  readonly min: number;
  readonly max: number;
  readonly step: number;
}

/** Where a session stands. A closed set; the panel renders each state by name. */
export type SessionStatus =
  | 'idle'
  /** A round is in flight, or an applied cut is waiting for the deck to catch up. */
  | 'running'
  /** Ask mode: a round improved the deck and the winner awaits the user. */
  | 'asking'
  /** No removal improved the deck and nothing is left to widen to. */
  | 'exhausted'
  | 'target-reached'
  /** The user stopped, cancelled, or an apply could not be made. */
  | 'stopped';

interface Session {
  /** The deck this session trims; a different hero ends it. */
  readonly deckId: string;
  /** The land ratio when the session began — read from the first round's report. */
  readonly base: LandRatio | null;
  readonly rounds: readonly TrimRoundReport[];
  /** Removals applied this session, with the round that found each. */
  readonly applied: readonly { readonly row: TrimRow; readonly round: number; readonly onTheEdge: boolean }[];
  readonly status: SessionStatus;
  /**
   * Set after an apply while the hero has not yet shrunk to the expected size:
   * the next round must be issued on the UPDATED deck, which arrives on a later
   * render, so the panel waits for it rather than racing it.
   */
  readonly continueAt?: { readonly expectedSize: number; readonly lastRound: number };
  /** A one-line note about why the session stopped, when it did. */
  readonly stopNote?: string;
}

const IDLE_SESSION = (deckId: string): Session => ({
  deckId,
  base: null,
  rounds: [],
  applied: [],
  status: 'idle',
});

/**
 * THE TRIM PANEL (DESIGN §3.174) — "bring this deck down to N".
 *
 * Thin by design: the sim decides what a round means (`prepareTrimRound`,
 * `finishTrimRound`), `lib/lab/trimSession.ts` decides what follows a round,
 * and this component only issues rounds, shows their reports, and applies what
 * the user (or auto mode) chose. Each round is ONE sim request through the same
 * hook every other panel uses, so the progress bar and Cancel are the Lab's own.
 *
 * The session lives here, in component state, exactly as Suggest's focus and
 * sliders do: leaving the tab ends the session's memory (the deck edits it
 * already applied are saved), and a different hero starts fresh.
 */
export function TrimPanel({
  hero,
  heroPayload,
  heroLegal,
  chosenOpponents,
  seed,
  pilotId,
  sim,
  gamesConfig,
  targetConfig,
  defaultSettings,
  onApplyCut,
}: PanelProps & {
  gamesConfig: GamesConfig;
  targetConfig: TargetConfig;
  defaultSettings: TrimSettings;
  /** Apply a removal to the hero, or `undefined` when the hero is not editable. */
  onApplyCut?: (cuts: readonly TrimCut[]) => ApplyCutResult;
}): ReactElement {
  const [games, setGames] = useState(gamesConfig.default);
  const [targetSize, setTargetSize] = useState(defaultSettings.targetSize);
  const [onImprovement, setOnImprovement] = useState<TrimOnImprovement>(defaultSettings.onImprovement);
  const [onNoImprovement, setOnNoImprovement] = useState<TrimOnNoImprovement>(defaultSettings.onNoImprovement);
  const settings: TrimSettings = { targetSize, onImprovement, onNoImprovement };

  const heroId = hero?.id ?? '';
  const [session, setSession] = useState<Session>(() => IDLE_SESSION(heroId));
  // A different hero is a different session — never carry rounds across decks.
  useEffect(() => {
    setSession((current) => (current.deckId === heroId ? current : IDLE_SESSION(heroId)));
  }, [heroId]);

  const deckSize = hero ? hero.cards.reduce((sum, entry) => sum + entry.count, 0) : 0;
  const ratio = useMemo(() => (hero ? landRatioOfWebDeck(hero) : null), [hero]);
  const heroFingerprint = heroPayload ? deckFingerprint(heroPayload) : null;
  const problem = hero ? targetProblem(targetSize, deckSize, targetConfig.min) : 'Pick a hero deck.';

  const running = sim.status === 'running';
  const busy = running || session.status === 'running';
  const canStart =
    heroLegal && heroPayload !== null && chosenOpponents.length > 0 && !busy && problem === null;

  /** Issue one round on the CURRENT hero. */
  const issueRound = (round: number, roundKind: TrimRoundKind, base: LandRatio | null): void => {
    if (!heroPayload) return;
    sim.run({
      kind: 'trim',
      hero: heroPayload,
      opponentNames: chosenOpponents,
      gamesPerCandidate: games,
      seed,
      round,
      roundKind,
      targetSize,
      pilotId,
      ...(base ? { baseLandRatio: base } : {}),
    });
  };

  /** Apply a row, record it, and either continue (once the deck shrinks) or stop. */
  const apply = (row: TrimRow, round: number, onTheEdge: boolean, then: 'continue' | 'stop'): void => {
    if (!onApplyCut) return;
    const result = onApplyCut(row.cuts);
    if (result.copiesRemoved === 0) {
      setSession((s) => ({ ...s, status: 'stopped', stopNote: result.problem ?? 'The removal could not be applied.' }));
      return;
    }
    setSession((s) => ({
      ...s,
      applied: [...s.applied, { row, round, onTheEdge }],
      ...(then === 'continue'
        ? { status: 'running', continueAt: { expectedSize: deckSize - result.copiesRemoved, lastRound: round } }
        : { status: 'stopped', stopNote: `Stopped after applying — the deck is ${deckSize - result.copiesRemoved} cards.` }),
    }));
  };

  // 1. A round finished: act on it exactly once, and only if it describes THIS deck.
  const handledRef = useRef<unknown>(null);
  const result = sim.status === 'done' && sim.result?.kind === 'trim' ? sim.result : null;
  useEffect(() => {
    if (!result || handledRef.current === result) return;
    handledRef.current = result;
    const report = result.result;
    if (session.status !== 'running' || report.deckFingerprint !== heroFingerprint) return; // stale: another deck, or an older session
    const base = session.base ?? report.reading.base;
    const step = stepAfterRound(report, settings);
    setSession((s) => ({ ...s, base, rounds: [...s.rounds, report] }));
    switch (step.kind) {
      case 'apply':
        apply(step.row, report.round, false, 'continue');
        break;
      case 'ask':
        // A hero that cannot be edited has nothing to answer: report and stop.
        setSession((s) =>
          onApplyCut
            ? { ...s, status: 'asking' }
            : { ...s, status: 'stopped', stopNote: 'An improving removal was found — copy this deck to your decks to apply it.' },
        );
        break;
      case 'widen':
        issueRound(step.round, step.roundKind, base);
        break;
      case 'exhausted':
        setSession((s) => ({ ...s, status: 'exhausted' }));
        break;
    }
    // The effect keys on the result's identity; the closures read current props.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result]);

  // 2. An applied cut landed in the deck: the next round runs on the smaller deck.
  useEffect(() => {
    const pending = session.continueAt;
    if (!pending || deckSize !== pending.expectedSize) return;
    const next = stepAfterApply(deckSize, targetSize, pending.lastRound);
    if (next.kind === 'round') {
      setSession((s) => ({ ...s, continueAt: undefined }));
      issueRound(next.round, next.roundKind, session.base);
    } else {
      setSession((s) => ({ ...s, continueAt: undefined, status: 'target-reached' }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.continueAt, deckSize]);

  // 3. The run stopped without a result (Cancel, or an error the Lab shows above).
  const wasRunningRef = useRef(false);
  useEffect(() => {
    if (running) {
      wasRunningRef.current = true;
      return;
    }
    if (wasRunningRef.current && (sim.status === 'idle' || sim.status === 'error')) {
      wasRunningRef.current = false;
      setSession((s) =>
        s.status === 'running' && !s.continueAt
          ? { ...s, status: 'stopped', stopNote: sim.status === 'error' ? 'The round failed — see the error above.' : 'Cancelled.' }
          : s,
      );
    }
  }, [running, sim.status]);

  const start = (): void => {
    if (!canStart) return;
    handledRef.current = null;
    setSession({ ...IDLE_SESSION(heroId), status: 'running' });
    issueRound(0, FIRST_ROUND_KIND, null);
  };

  const stop = (): void => {
    if (running) sim.cancel();
    setSession((s) => ({ ...s, status: 'stopped', continueAt: undefined, stopNote: 'Stopped.' }));
  };

  const toCut = Math.max(0, deckSize - targetSize);
  const distinct = hero ? Math.min(hero.cards.length, DEFAULT_TRIM_CONFIG.maxCandidatesPerRound) : 0;
  const lastReport = session.rounds[session.rounds.length - 1];

  return (
    <div className="lab-section trim">
      <p className="lab-section__intro">
        Bring the deck down toward a target size. Each round tests removing one copy of every
        card with the same paired A/B test the other tabs use; a removal that proves better is
        applied (or offered), the deck shrinks by one, and the next round begins. Removals take
        mana into account — after enough nonland cuts, a land cut is due, and the panel shows the
        arithmetic.
      </p>

      {hero && ratio && (
        <p className="trim-standing" role="status">
          <strong>{hero.name}</strong> is <strong>{deckSize}</strong> cards · target{' '}
          <strong>{targetSize}</strong>
          {problem === null && (
            <>
              {' '}
              → <strong>{toCut}</strong> to cut
            </>
          )}{' '}
          · lands {ratio.lands}/{ratio.size}
          {ratio.size > 0 && <> ({pct(ratio.lands / ratio.size)})</>}
        </p>
      )}

      <div className="lab-controls trim-controls">
        <label className="lab-field trim-target">
          <span className="section-label">Target size</span>
          <input
            className="input"
            type="number"
            min={targetConfig.min}
            max={targetConfig.max}
            step={targetConfig.step}
            value={targetSize}
            disabled={busy}
            onChange={(e) => setTargetSize(Number(e.target.value))}
            aria-label="Target deck size"
          />
        </label>
        <RunSlider
          label="Games per finalist"
          value={games}
          min={gamesConfig.min}
          max={gamesConfig.max}
          step={gamesConfig.step}
          disabled={busy}
          onChange={setGames}
          hint="Depth the winning removal reaches, per round"
        />
        <button type="button" className="btn btn--primary" disabled={!canStart} onClick={start}>
          {session.rounds.length > 0 && !busy ? 'Start again' : 'Start trimming'}
        </button>
        {busy && (
          <button type="button" className="btn btn--ghost" onClick={stop}>
            Stop
          </button>
        )}
      </div>
      {problem !== null && hero && <p className="lab-hint trim-problem">{problem}</p>}
      {!onApplyCut && hero && (
        <p className="lab-hint">
          This is a bundled gauntlet deck, so removals can be tested but not applied — copy it to
          your decks in the Deck Builder to trim it for real.
        </p>
      )}

      <fieldset className="trim-setting">
        <legend>On an improving removal</legend>
        <label>
          <input
            type="radio"
            name="trim-on-improvement"
            value="ask"
            checked={onImprovement === 'ask'}
            disabled={busy}
            onChange={() => setOnImprovement('ask')}
          />
          Show it and ask before applying
        </label>
        <label>
          <input
            type="radio"
            name="trim-on-improvement"
            value="auto"
            checked={onImprovement === 'auto'}
            disabled={busy || !onApplyCut}
            onChange={() => setOnImprovement('auto')}
          />
          Apply it and keep looking
        </label>
      </fieldset>
      <fieldset className="trim-setting">
        <legend>When nothing improves</legend>
        <label>
          <input
            type="radio"
            name="trim-on-no-improvement"
            value="pause"
            checked={onNoImprovement === 'pause'}
            disabled={busy}
            onChange={() => setOnNoImprovement('pause')}
          />
          Pause and tell me
        </label>
        <label>
          <input
            type="radio"
            name="trim-on-no-improvement"
            value="keep-looking"
            checked={onNoImprovement === 'keep-looking'}
            disabled={busy}
            onChange={() => setOnNoImprovement('keep-looking')}
          />
          Keep looking — widen to nonland + land pairs
        </label>
      </fieldset>

      {chosenOpponents.length > 0 && hero && (
        <RunCostNote
          pilotId={pilotId}
          games={estimateSuggestionGames(Math.max(1, distinct), games)}
          workerCount={sim.workerCount}
          approximate
        />
      )}
      {chosenOpponents.length > 0 && hero && (
        <p className="lab-hint">Per round — one round per card cut, {toCut} to reach the target.</p>
      )}

      {session.rounds.length > 0 && (
        <SessionSummary session={session} deckSize={deckSize} targetSize={targetSize} />
      )}

      {session.rounds.map((report) => (
        <RoundCard
          key={`${report.round}-${report.roundKind}`}
          report={report}
          pilotId={result?.pilotId ?? pilotId}
          seed={seed}
          isLatest={report === lastReport}
          status={session.status}
          applied={session.applied.find((a) => a.round === report.round)?.row ?? null}
          canApply={onApplyCut !== undefined && report === lastReport && (session.status === 'asking' || session.status === 'exhausted')}
          onApply={(row, onTheEdge, then) => apply(row, report.round, onTheEdge, then)}
          onStop={() => setSession((s) => ({ ...s, status: 'stopped', stopNote: 'Stopped without applying.' }))}
        />
      ))}

      {session.rounds.length === 0 && !busy && (
        <p className="lab-placeholder">
          Set a target and start. Verdicts are only “better” or “worse” when the paired test
          clears significance after correcting for every removal tried in the round; a round where
          nothing clears it reports every row and the most likely improving removal.
        </p>
      )}
    </div>
  );
}

/** Where the session stands, in one line above the rounds. */
function SessionSummary({
  session,
  deckSize,
  targetSize,
}: {
  session: Session;
  deckSize: number;
  targetSize: number;
}): ReactElement {
  const cuts = session.applied.map((a) => a.row.label);
  const status = ((): string => {
    switch (session.status) {
      case 'running':
        return session.continueAt ? 'applying…' : 'round in progress…';
      case 'asking':
        return 'an improving removal is waiting for you';
      case 'exhausted':
        return 'no removal proved better — see the last round';
      case 'target-reached':
        return 'target reached';
      case 'stopped':
        return session.stopNote ?? 'stopped';
      case 'idle':
        return '';
    }
  })();
  return (
    <p className={`trim-summary trim-summary--${session.status}`} role="status">
      <strong>
        {session.rounds.length} round{session.rounds.length === 1 ? '' : 's'}
      </strong>
      {cuts.length > 0 ? <> · cut {cuts.join(', ')}</> : <> · nothing cut yet</>} · now {deckSize} cards
      (target {targetSize}) · {status}
    </p>
  );
}

/**
 * One round's report: the reading, the verdict, the table, the honesty lines.
 * Exported (as a component, not a page) so a static render can pin the markup a
 * finished round produces — the panel only reaches it through effects.
 */
export function RoundCard({
  report,
  pilotId,
  seed,
  isLatest,
  status,
  applied,
  canApply,
  onApply,
  onStop,
}: {
  report: TrimRoundReport;
  pilotId: string;
  seed: number;
  isLatest: boolean;
  status: SessionStatus;
  applied: TrimRow | null;
  canApply: boolean;
  onApply: (row: TrimRow, onTheEdge: boolean, then: 'continue' | 'stop') => void;
  onStop: () => void;
}): ReactElement {
  const winner = report.winner;
  const edge = report.edgeCandidate;
  const kindLabel = report.roundKind === 'pairs' ? 'nonland + land pairs' : 'single cards';
  return (
    <section className={`lab-results trim-round${isLatest ? ' trim-round--latest' : ''}`} aria-label={`Round ${report.round + 1}`}>
      <h3 className="trim-round__title">
        Round {report.round + 1} · {kindLabel} · {report.deckSize} cards → target {report.targetSize}
      </h3>
      <p className="trim-reading">{report.reading.explanation}</p>

      {winner ? (
        <div className="verdict-banner verdict-banner--better">
          <span className="verdict-banner__label">BETTER without</span>
          <span className="verdict-banner__detail">
            −1× {winner.label} · {signedPct(winner.evaluation.delta)} win rate · p {pValueStr(winner.adjustedPValue)} ·{' '}
            {winner.gamesPlayed} paired games
          </span>
          {applied && applied.key === winner.key && (
            <span className="verdict-banner__apply verdict-banner__apply--done">✓ Applied</span>
          )}
          {canApply && status === 'asking' && !applied && (
            <span className="trim-actions">
              <button type="button" className="btn btn--primary" onClick={() => onApply(winner, false, 'continue')}>
                Apply and keep trimming
              </button>
              <button type="button" className="btn btn--ghost" onClick={() => onApply(winner, false, 'stop')}>
                Apply and stop
              </button>
              <button type="button" className="btn btn--ghost" onClick={onStop}>
                Stop without applying
              </button>
            </span>
          )}
        </div>
      ) : (
        <div className="verdict-banner verdict-banner--inconclusive">
          <span className="verdict-banner__label">Nothing proved better</span>
          <span className="verdict-banner__detail">
            {report.rows.length === 0
              ? 'No removal could be evaluated.'
              : edge
                ? `Most likely improving removal: −1× ${edge.label} · ${signedPct(edge.evaluation.delta)} · p ${pValueStr(edge.adjustedPValue)} — inconclusive, on the edge.`
                : 'Every removal was proven worse — this deck does not want to be smaller by any of these cuts.'}
          </span>
          {edge && applied && applied.key === edge.key && (
            <span className="verdict-banner__apply verdict-banner__apply--done">✓ Applied on the edge</span>
          )}
          {edge && canApply && status === 'exhausted' && !applied && (
            <span className="trim-actions">
              <button
                type="button"
                className="btn btn--ghost trim-edge-apply"
                onClick={() => onApply(edge, true, 'continue')}
                title="This removal did NOT clear significance. Applying it is your call, not the engine’s."
              >
                Apply on-the-edge and keep trimming
              </button>
              <button type="button" className="btn btn--ghost" onClick={() => onApply(edge, true, 'stop')}>
                Apply on-the-edge and stop
              </button>
            </span>
          )}
        </div>
      )}

      <PilotStamp pilotId={pilotId} />
      <p className="lab-section__intro">
        Base deck win rate this round: <strong>{ciStr(report.baseWinRate)}</strong>
      </p>

      {report.rows.length > 0 && (
        <table className="lab-table">
          <thead>
            <tr>
              <th>#</th>
              <th>Cut</th>
              <th>Base%</th>
              <th>Without%</th>
              <th>Delta</th>
              <th>p-value</th>
              <th>Games</th>
              <th>Verdict</th>
            </tr>
          </thead>
          <tbody>
            {report.rows.map((row) => {
              const ev = row.evaluation;
              const v = verdictDisplay(ev.verdict);
              return (
                <tr key={row.key} className={row === winner ? 'trim-row--winner' : row === edge ? 'trim-row--edge' : undefined}>
                  <td className="lab-table__num">{row.rank}</td>
                  <td title={row.priorReasons.join('; ')}>
                    −1× {row.label}
                    {row.cuts.some((c) => c.isLand) && <span className="trim-land-tag"> land</span>}
                  </td>
                  <td className="lab-table__num">{pct(ev.baseWinRate.p)}</td>
                  <td className="lab-table__num">{pct(ev.variantWinRate.p)}</td>
                  <td className="lab-table__num">{signedPct(ev.delta)}</td>
                  <td className="lab-table__num" title={`uncorrected p = ${pValueStr(row.rawPValue)}`}>
                    {pValueStr(row.adjustedPValue)}
                  </td>
                  <td
                    className="lab-table__num"
                    title={row.elimination ? `dropped after wave ${row.elimination.wave}: ${row.elimination.detail}` : undefined}
                  >
                    {row.gamesPlayed}
                    {row.elimination ? '*' : ''}
                  </td>
                  <td>
                    <span className={`verdict-tag verdict-tag--${v.tone}`}>{v.label}</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      <p className="lab-coverage">
        Evaluated {report.candidatesEvaluated} of {report.notes.candidatesGenerated} removals
        {report.skipped.filter((s) => s.reason === 'capped').length > 0 && (
          <> ({report.skipped.filter((s) => s.reason === 'capped').length} capped for budget)</>
        )}
        {report.skipped.filter((s) => s.reason === 'illegal').length > 0 && (
          <>; {report.skipped.filter((s) => s.reason === 'illegal').length} skipped (illegal deck)</>
        )}
        . {report.waves.length} wave{report.waves.length === 1 ? '' : 's'}; {report.multipleComparisons.familySize} tests
        corrected by {report.multipleComparisons.method}
        {report.multipleComparisons.demotedByCorrection > 0 && (
          <> ({report.multipleComparisons.demotedByCorrection} demoted)</>
        )}
        .
      </p>
      <p className="lab-throughput">
        {report.notes.totalGamesRun.toLocaleString()} games
        {report.notes.gamesAvoided > 0 && <> · {report.notes.gamesAvoided.toLocaleString()} avoided by adaptive sampling</>}
        {report.notes.gamesPerSecond !== undefined && <> · {throughputText(report.notes.gamesPerSecond)}</>}
        {report.notes.workersUsed !== undefined && <> · {report.notes.workersUsed} workers</>} · seed {seed} · pilot{' '}
        {pilotId}
      </p>
      <p className="lab-hint trim-pairing-note">{report.pairingNote}</p>
      <FidelityNote text={report.notes.fidelityCaveat} />
    </section>
  );
}
