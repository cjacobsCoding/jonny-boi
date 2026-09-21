import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import {
  DEFAULT_TRIM_CONFIG,
  TRIM_STOP_REASON_WORDING,
  deckFingerprint,
  type TrimCut,
  type LandRatio,
  type TrimOnImprovement,
  type TrimOnNoImprovement,
  type TrimRoundKind,
  type TrimRoundReport,
  type TrimRow,
  type TrimSettings,
  type TrimSpend,
  type TrimStopReason,
} from '@jonny-boi/sim';
import { FidelityNote } from '../FidelityNote.js';
import { RunSlider } from './RunSlider.js';
import { PilotStamp, RunCostNote } from './PilotControls.js';
import {
  ciStr,
  gamesToSettleText,
  pct,
  pValueStr,
  signedPct,
  throughputText,
  reasonContextOf,
  verdictDisplay,
  verdictReasonDisplay,
} from '../../lib/sim-format.js';
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
  /**
   * The search ended on its own terms. WHICH terms is `Session.stopReason` —
   * §3.179 split the old `'exhausted'` because it meant both "nothing helps" and
   * "ran out of road while still unsure", and printed the first while meaning
   * the second.
   */
  | 'finished'
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
  /** Why the search ended, when `status` is `'finished'`. Its words come from the sim's table. */
  readonly stopReason?: TrimStopReason;
  /** What the session has spent, so the budget stop can print its own arithmetic. */
  readonly spend: TrimSpend;
  /**
   * The per-candidate depth the NEXT round will ask for. Grows when a round ends
   * unsure with the kinds spent — this is the "keep looking" lever (§3.179).
   */
  readonly gamesPerCandidate: number;
  /**
   * Set after an apply while the hero has not yet shrunk to the expected size:
   * the next round must be issued on the UPDATED deck, which arrives on a later
   * render, so the panel waits for it rather than racing it.
   */
  readonly continueAt?: { readonly expectedSize: number; readonly lastRound: number };
  /** A one-line note about why the session stopped, when it did. */
  readonly stopNote?: string;
}

const IDLE_SESSION = (deckId: string, gamesPerCandidate: number): Session => ({
  deckId,
  base: null,
  rounds: [],
  applied: [],
  status: 'idle',
  spend: { games: 0, seconds: 0, rounds: 0 },
  gamesPerCandidate,
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
  const [session, setSession] = useState<Session>(() => IDLE_SESSION(heroId, games));
  // A different hero is a different session — never carry rounds across decks.
  // Adjusted DURING render (React's pattern for state that follows a prop), so
  // no frame ever shows one deck's rounds under another deck's name.
  if (session.deckId !== heroId) setSession(IDLE_SESSION(heroId, games));

  const deckSize = hero ? hero.cards.reduce((sum, entry) => sum + entry.count, 0) : 0;
  const ratio = useMemo(() => (hero ? landRatioOfWebDeck(hero) : null), [hero]);
  const heroFingerprint = heroPayload ? deckFingerprint(heroPayload) : null;
  const problem = hero ? targetProblem(targetSize, deckSize, targetConfig.min) : 'Pick a hero deck.';

  const running = sim.status === 'running';
  const busy = running || session.status === 'running';
  const canStart =
    heroLegal && heroPayload !== null && chosenOpponents.length > 0 && !busy && problem === null;

  /**
   * Issue one round on the CURRENT hero, at a NAMED depth.
   *
   * ⚠️ `gamesPerCandidate` is a parameter and no longer the slider's value
   * directly: a deepening round (§3.179) asks for more than the user typed, and
   * reading the slider here would silently undo the deepening — the round would
   * be re-run at exactly the depth that already failed to answer it.
   */
  const issueRound = (
    round: number,
    roundKind: TrimRoundKind,
    base: LandRatio | null,
    gamesPerCandidate: number,
  ): void => {
    if (!heroPayload) return;
    sim.run({
      kind: 'trim',
      hero: heroPayload,
      opponentNames: chosenOpponents,
      gamesPerCandidate,
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
    // The spend this round added, folded in BEFORE the step is decided — the
    // budget stop must see the round that just ran, or it would always be one
    // round out of date and could only ever fire after overspending.
    const spend: TrimSpend = {
      games: session.spend.games + report.notes.totalGamesRun,
      seconds: session.spend.seconds + (report.notes.elapsedSeconds ?? 0),
      rounds: session.spend.rounds + 1,
    };
    const step = stepAfterRound(report, settings, spend, session.gamesPerCandidate);
    setSession((s) => ({ ...s, base, rounds: [...s.rounds, report], spend }));
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
        issueRound(step.round, step.roundKind, base, session.gamesPerCandidate);
        break;
      case 'deepen':
        setSession((s) => ({ ...s, gamesPerCandidate: step.gamesPerCandidate }));
        issueRound(step.round, step.roundKind, base, step.gamesPerCandidate);
        break;
      case 'stopped':
        setSession((s) => ({ ...s, status: 'finished', stopReason: step.reason }));
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
      setSession((s) => ({ ...s, continueAt: undefined, gamesPerCandidate: games }));
      // A smaller deck is a new question: back to the depth the user asked for,
      // not the deep rate the previous impasse needed. Mirrors `trimDeck`.
      issueRound(next.round, next.roundKind, session.base, games);
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
    setSession({ ...IDLE_SESSION(heroId, games), status: 'running' });
    issueRound(0, FIRST_ROUND_KIND, null, games);
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
          canApply={onApplyCut !== undefined && report === lastReport && (session.status === 'asking' || session.status === 'finished')}
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
  // ⚠️ THE STOP REASON'S WORDS COME FROM THE SIM'S TABLE, not from a switch here.
  // A second wording table in the panel is how "exhausted" came to be printed for
  // two opposite situations (§3.179); `trim-panel.test.ts` enumerates
  // TRIM_STOP_REASONS and fails if any reason renders without its words.
  const stopRow = session.stopReason ? TRIM_STOP_REASON_WORDING[session.stopReason] : undefined;
  const status = ((): string => {
    switch (session.status) {
      case 'running':
        return session.continueAt ? 'applying…' : 'round in progress…';
      case 'asking':
        return 'an improving removal is waiting for you';
      case 'finished':
        return stopRow ? `${stopRow.label} — ${stopRow.detail}` : 'the search ended';
      case 'target-reached':
        return TRIM_STOP_REASON_WORDING['target-reached'].label;
      case 'stopped':
        return session.stopNote ?? 'stopped';
      case 'idle':
        return '';
    }
  })();
  return (
    <p className={`trim-summary trim-summary--${session.status}`} role="status" data-testid="trim-summary">
      <strong>
        {session.rounds.length} round{session.rounds.length === 1 ? '' : 's'}
      </strong>
      {cuts.length > 0 ? <> · cut {cuts.join(', ')}</> : <> · nothing cut yet</>} · now {deckSize} cards
      (target {targetSize}) · {status}
      {session.spend.rounds > 0 && (
        <>
          {' · '}
          <span data-testid="trim-spend">
            {session.spend.games.toLocaleString()} games · {session.spend.seconds.toFixed(1)}s · depth{' '}
            {session.gamesPerCandidate}/candidate
          </span>
        </>
      )}
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
        <div className="verdict-banner verdict-banner--inconclusive" data-testid="trim-no-winner">
          {/*
            ⚠️ TWO DIFFERENT HEADLINES, because the round verdict now says which
            happened (§3.179). "Nothing proved better" was printed for both, and
            with almost every row inconclusive it was ALWAYS the wrong one — the
            deck had not been shown to resist trimming, it had not been measured
            deeply enough to say anything at all.
          */}
          <span className="verdict-banner__label">
            {report.verdict === 'unsure' ? 'Not measured deeply enough to tell' : 'Nothing proved better'}
          </span>
          <span className="verdict-banner__detail">
            {report.rows.length === 0
              ? 'No removal could be evaluated.'
              : report.verdict === 'unsure'
                ? `No removal cleared the bar, and some rows are still unreadable at ${report.rows[0]?.gamesPlayed ?? 0} paired games — this is NOT "nothing helps". Keep looking will run the ladder again deeper.`
                : 'Every removal was measured deeply enough to call, and none improved the deck — more games would not change that.'}
          </span>
          {edge && (
            <span className="verdict-banner__detail" data-testid="trim-edge-line">
              {`Most likely improving removal: −1× ${edge.label} · ${signedPct(edge.evaluation.delta)} · p ${pValueStr(edge.adjustedPValue)} — ${verdictReasonDisplay(edge.evaluation.verdictReason, reasonContextOf(edge)).label}, on the edge.`}
            </span>
          )}
          {edge && applied && applied.key === edge.key && (
            <span className="verdict-banner__apply verdict-banner__apply--done">✓ Applied on the edge</span>
          )}
          {edge && canApply && status === 'finished' && !applied && (
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
              {/* §3.179 — INCONCLUSIVE was three different answers wearing one word. */}
              <th>Why</th>
            </tr>
          </thead>
          <tbody>
            {report.rows.map((row) => {
              const ev = row.evaluation;
              const v = verdictDisplay(ev.verdict);
              const why = verdictReasonDisplay(ev.verdictReason, reasonContextOf(row, report.notes.stats));
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
                  <td className="trim-why" title={why.detail}>
                    {why.label}
                    {ev.gamesToSettle && (
                      <span className="trim-settle" title={gamesToSettleText(ev.gamesToSettle)}>
                        {' '}
                        (~{ev.gamesToSettle.additionalPairedGames.toLocaleString()} more)
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <p className="trim-bar-note" data-testid="trim-bar-note">
        Read at <strong>{report.notes.stats.alpha}</strong> (alpha), with at least{' '}
        <strong>{report.notes.stats.minGamesForVerdict}</strong> paired games required before any verdict but
        inconclusive. A “~N more” figure is an <em>estimate</em> from the observed discordant split, not a promise.
      </p>

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
