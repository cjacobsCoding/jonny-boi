import { useEffect, useMemo, useState, type ReactElement } from 'react';
import {
  JOINT_CONFOUND_NOTE,
  JOINT_HONEST_CLAIM,
  JOINT_MAX_ROUNDS,
  JOINT_NOT_GATED_ON,
  JOINT_PARTNER_RULES,
  JOINT_PHASES,
  advanceJointSearch,
  describeJointOutcome,
  generateJointMoves,
  interruptJointSearch,
  jointBudgetRemaining,
  jointStopReasonOf,
  nextJointPhase,
  startJointSearch,
  type Deck as SimDeck,
  type JointMove,
  type JointMoveSet,
  type JointPartnerRuleId,
  type JointPhaseReport,
  type JointSearchState,
  type LandCountRow,
  type SwapVerdict,
} from '@jonny-boi/sim';
import { FidelityNote } from '../FidelityNote.js';
import { RunSlider } from './RunSlider.js';
import { PilotStamp } from './PilotControls.js';
import {
  gamesToSettleText,
  pct,
  pValueStr,
  reasonContextOf,
  signedPct,
  verdictDisplay,
  verdictReasonDisplay,
} from '../../lib/sim-format.js';
import { SWAP_VERDICT_REASON_BY_KEY } from '@jonny-boi/sim';
import { loadCardPool } from '../../lib/sim-pool.js';
import type { GamesConfig, PanelProps } from './panel-types.js';
import './joint-panel.css';

/**
 * THE JOINT MANABASE + SPELL SEARCH (DESIGN §3.177) — "find a best mana ratio
 * for this deck, and the cards that go with it".
 *
 * > "Some decks may need different ratios. … The hard part is its not as simple
 * > as trying 25 or 23… For 25, you'd need to also take out a non-land card….
 * > Which in turn affects the ratio…"
 *
 * The panel runs ONE PHASE per request — the manabase moves with the spells
 * pinned, then the spell moves with the manabase pinned — and keeps the search's
 * state (`JointSearchState`) between them. That is what makes an expensive
 * search something a person can watch, stop and resume instead of an hour-long
 * black box: the budget is spent a phase at a time, with the games spent shown
 * against the games allowed, and every accepted move lands on a PATH that can be
 * audited move by move.
 *
 * What it never says is "the perfect ratio". `JOINT_HONEST_CLAIM` is printed
 * verbatim, and a round that ends without a proved improvement is reported as
 * inconclusive or as a LOCAL optimum, which is a different claim from "this deck
 * is the best there is".
 */
export function JointPanel({
  hero,
  heroPayload,
  heroLegal,
  chosenOpponents,
  seed,
  pilotId,
  sim,
  onApplyJointMove,
  gamesConfig,
  radiusConfig,
  partnersConfig,
  budgetGamesConfig,
  budgetSecondsConfig,
  autoContinueDefault,
}: PanelProps & {
  gamesConfig: GamesConfig;
  radiusConfig: GamesConfig;
  partnersConfig: GamesConfig;
  budgetGamesConfig: GamesConfig;
  budgetSecondsConfig: GamesConfig;
  autoContinueDefault: boolean;
  /** Apply an accepted move to the hero deck; `undefined` when it cannot be edited. */
  onApplyJointMove?: (move: JointMove) => void;
}): ReactElement {
  const [games, setGames] = useState(gamesConfig.default);
  const [radius, setRadius] = useState(radiusConfig.default);
  const [partners, setPartners] = useState(partnersConfig.default);
  const [budgetGames, setBudgetGames] = useState(budgetGamesConfig.default);
  const [budgetSeconds, setBudgetSeconds] = useState(budgetSecondsConfig.default);
  const [partnerRule, setPartnerRule] = useState<JointPartnerRuleId>(JOINT_PARTNER_RULES[0].id);
  const [autoContinue, setAutoContinue] = useState(autoContinueDefault);
  const [search, setSearch] = useState<JointSearchState | null>(null);
  /** The phase report already folded in, so one result is never counted twice. */
  const [folded, setFolded] = useState<JointPhaseReport | null>(null);
  const [applyProblem, setApplyProblem] = useState<string | null>(null);
  /** A phase auto-continue queued; issued once the applied deck has arrived. */
  const [pending, setPending] = useState<JointSearchState | null>(null);

  const running = sim.status === 'running';
  const result = sim.status === 'done' && sim.result?.kind === 'joint-phase' ? sim.result : null;
  const report = result?.result ?? null;

  // The moves the NEXT phase will try — enumerated here from the same pure
  // generator the worker runs, on the same settings, so the preview and the run
  // cannot describe different families.
  const upcoming: (typeof JOINT_PHASES)[number]['id'] = search ? (nextJointPhase(search) ?? 'manabase') : 'manabase';
  const preview = useMemo<{ set: JointMoveSet | null; error: string | null }>(() => {
    if (!heroPayload) return { set: null, error: null };
    try {
      return {
        set: generateJointMoves(heroPayload as SimDeck, loadCardPool(), {
          phase: upcoming,
          partnerRule,
          countRadius: radius,
          mixRadius: radius,
          partnersPerCountStep: partners,
        }),
        error: null,
      };
    } catch (err) {
      return { set: null, error: err instanceof Error ? err.message : String(err) };
    }
  }, [heroPayload, upcoming, partnerRule, radius, partners]);

  const moveCount = preview.set?.moves.length ?? 0;
  const finished = search?.stopped !== undefined;
  const canRun = heroLegal && heroPayload !== null && chosenOpponents.length > 0 && moveCount > 0 && !running && !finished;
  const phaseLabel = JOINT_PHASES.find((p) => p.id === upcoming)?.label ?? upcoming;
  const remaining = search ? jointBudgetRemaining(search) : null;

  /** Issue the next phase against the deck as it now stands. */
  const runPhase = (state: JointSearchState): void => {
    if (!heroPayload) return;
    const phase = nextJointPhase(state);
    if (phase === undefined) return;
    sim.run({
      kind: 'joint-phase',
      hero: heroPayload,
      opponentNames: chosenOpponents,
      gamesPerMove: games,
      seed,
      pilotId,
      phase,
      round: state.round,
      partnerRule,
      radius,
      partnersPerCountStep: partners,
    });
  };

  const start = (): void => {
    const state = startJointSearch(heroPayload as SimDeck, { maxGames: budgetGames, maxSeconds: budgetSeconds });
    setSearch(state);
    setFolded(null);
    setApplyProblem(null);
    setPending(null);
    runPhase(state);
  };

  // Fold a finished phase into the search exactly ONCE, then either hand its
  // winner to the deck or stop. `advanceJointSearch` owns every decision — the
  // accept, the budget, the round cap and the local optimum — so the panel and
  // the headless driver cannot disagree about when a search is over.
  //
  // In an effect, not in render: applying a move calls back into the Lab to
  // rewrite the saved deck, and a parent update during a child's render is the
  // bug React warns about. `folded` is the idempotence guard — a re-render with
  // the same report must not accept the same move twice.
  useEffect(() => {
    if (!report || report === folded || !search || search.stopped !== undefined) return;
    const next = advanceJointSearch(search, report, loadCardPool());
    const winner = report.verdict === 'improved' ? report.winner : undefined;
    if (winner && onApplyJointMove) onApplyJointMove(winner.move);
    else if (winner) {
      setApplyProblem('This deck is read-only, so the accepted move was not saved. Copy it into a deck of your own to run a search.');
    }
    setFolded(report);
    setSearch(next);
    // Auto-continue QUEUES the next phase rather than issuing it here. The move
    // was just handed to the Lab, which rewrites the saved deck; the updated
    // hero has not reached this component yet, so issuing the request from this
    // effect would run the next phase against the deck BEFORE the move — the
    // silent kind of wrong, since it still returns a full report.
    if (autoContinue && next.stopped === undefined && winner && onApplyJointMove) setPending(next);
    // `search`/`autoContinue` are read, never depended on: the guard is `report`
    // against `folded`, and re-running this on a settings change would fold a
    // phase twice.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [report, folded]);

  // Issue a QUEUED phase once the applied deck has arrived. `hero` is the
  // identity that changes when the Lab saves a deck (`heroPayload` is rebuilt
  // every render and cannot be depended on), so this fires in the commit that
  // carries the new decklist — and does nothing when there is no queue.
  useEffect(() => {
    if (!pending) return;
    setPending(null);
    runPhase(pending);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending, hero]);

  return (
    <div className="lab-section">
      <p className="lab-section__intro">
        Optimise the manabase and the spells <strong>together</strong>. In a 60-card deck one fewer
        land is one more spell, so a land count cannot be tested on its own — this search alternates:
        it holds the spells fixed and looks for the best manabase move, then holds the manabase fixed
        and looks for the best spell move, and repeats until a full round finds nothing better, the
        budget runs out, or you stop it.
      </p>
      <p className="joint-confound" data-testid="joint-confound">
        {JOINT_CONFOUND_NOTE}
      </p>

      <fieldset className="joint-settings" disabled={running || search !== null}>
        <legend>How a land count picks its partner spell</legend>
        {JOINT_PARTNER_RULES.map((rule) => (
          <label key={rule.id} className="joint-rule">
            <input
              type="radio"
              name="joint-partner-rule"
              value={rule.id}
              checked={partnerRule === rule.id}
              onChange={() => setPartnerRule(rule.id)}
            />
            <span>
              <strong>{rule.label}</strong>
              <span className="joint-rule__note">{rule.note}</span>
            </span>
          </label>
        ))}
      </fieldset>

      <div className="lab-controls">
        <RunSlider
          label="Games per finalist"
          value={games}
          min={gamesConfig.min}
          max={gamesConfig.max}
          step={gamesConfig.step}
          disabled={running || search !== null}
          onChange={setGames}
          hint="Per opponent; the ladder drops clear losers early"
        />
        <RunSlider
          label="Land-count reach"
          value={radius}
          min={radiusConfig.min}
          max={radiusConfig.max}
          step={radiusConfig.step}
          disabled={running || search !== null}
          onChange={setRadius}
          hint="Steps each way per phase — a later round reaches further"
        />
        <RunSlider
          label="Partners per count"
          value={partners}
          min={partnersConfig.min}
          max={partnersConfig.max}
          step={partnersConfig.step}
          disabled={running || search !== null}
          onChange={setPartners}
          hint="Spells each land count is measured against"
        />
      </div>

      <div className="lab-controls">
        <RunSlider
          label="Budget — games"
          value={budgetGames}
          min={budgetGamesConfig.min}
          max={budgetGamesConfig.max}
          step={budgetGamesConfig.step}
          disabled={running || search !== null}
          onChange={setBudgetGames}
          hint="The search stops when this runs out"
        />
        <RunSlider
          label="Budget — seconds"
          value={budgetSeconds}
          min={budgetSecondsConfig.min}
          max={budgetSecondsConfig.max}
          step={budgetSecondsConfig.step}
          disabled={running || search !== null}
          onChange={setBudgetSeconds}
          hint="Whichever budget binds first stops it, and it says which"
        />
        <label className="joint-auto">
          <input type="checkbox" checked={autoContinue} onChange={(e) => setAutoContinue(e.target.checked)} />
          Keep going on its own after an improving phase
        </label>
      </div>

      {preview.error && (
        <p className="lab-alert" role="alert">
          This deck cannot be read: {preview.error}
        </p>
      )}
      {preview.set && (
        <p className="joint-base" data-testid="joint-base">
          <strong>As built:</strong> {preview.set.base.description}
        </p>
      )}

      <div className="lab-controls">
        {search === null ? (
          <button type="button" className="btn btn--primary" disabled={!canRun} onClick={start}>
            Start the search — {moveCount} {phaseLabel.toLowerCase()} move{moveCount === 1 ? '' : 's'} first
          </button>
        ) : (
          <>
            <button
              type="button"
              className="btn btn--primary"
              disabled={!canRun}
              onClick={() => runPhase(search)}
              data-testid="joint-next-phase"
            >
              Run the {phaseLabel.toLowerCase()} phase — {moveCount} move{moveCount === 1 ? '' : 's'}
            </button>
            <button
              type="button"
              className="btn"
              disabled={running || finished}
              onClick={() => setSearch(interruptJointSearch(search))}
              data-testid="joint-stop"
            >
              Stop here
            </button>
            <button type="button" className="btn" disabled={running} onClick={() => {
                setSearch(null);
                setFolded(null);
                setApplyProblem(null);
                setPending(null);
                sim.reset();
              }}>
              Start over
            </button>
          </>
        )}
      </div>

      {search && (
        <p className="joint-spend" data-testid="joint-spend">
          <strong>Spent so far:</strong> {search.spend.games.toLocaleString()} of {search.budget.maxGames.toLocaleString()} games
          {' · '}
          {search.spend.seconds.toFixed(1)} of {search.budget.maxSeconds} seconds
          {' · '}
          {search.spend.phasesRun} phase{search.spend.phasesRun === 1 ? '' : 's'} over round {Math.min(search.round + 1, JOINT_MAX_ROUNDS)} of{' '}
          {JOINT_MAX_ROUNDS}
          {remaining && !finished && (
            <>
              {' · '}
              {remaining.games.toLocaleString()} games left
            </>
          )}
        </p>
      )}

      {applyProblem && (
        <p className="lab-alert" role="alert">
          {applyProblem}
        </p>
      )}

      {search && search.path.length > 0 && (
        <div className="joint-path" data-testid="joint-path">
          <h4>The path — every move this search accepted, in order</h4>
          <ol>
            {search.path.map((step, i) => (
              <li key={`${step.round}-${step.phase}-${step.move.key}-${i}`}>
                <span className="joint-path__phase">
                  round {step.round + 1} · {JOINT_PHASES.find((p) => p.id === step.phase)?.label ?? step.phase}
                </span>
                <strong>{step.move.label}</strong>
                <span className={`verdict verdict--${verdictDisplay(step.verdict).tone}`}>
                  {verdictDisplay(step.verdict).label}
                </span>
                {/* §3.179 — carried off the accepted move's evaluation, not re-derived. */}
                <span className="trim-why">{SWAP_VERDICT_REASON_BY_KEY[step.verdictReason].label}</span>
                <span className="joint-path__delta">
                  {signedPct(step.delta)} · p {pValueStr(step.adjustedPValue)} · {step.gamesPlayed} games · now{' '}
                  {step.landCount} lands in {step.deckSize}
                </span>
              </li>
            ))}
          </ol>
        </div>
      )}

      {search && finished && (
        <div className="joint-outcome" data-testid="joint-outcome">
          <h4>{jointStopReasonOf(search.stopped as NonNullable<typeof search.stopped>).label}</h4>
          <p>{jointStopReasonOf(search.stopped as NonNullable<typeof search.stopped>).meaning}</p>
          <p className="joint-claim" data-testid="joint-claim">
            {JOINT_HONEST_CLAIM}
          </p>
          <p className="lab-coverage">{describeJointOutcome(search)}</p>
        </div>
      )}

      {report && result && (
        <div className="lab-results">
          <PilotStamp pilotId={result.pilotId} />
          <p className="lab-section__intro">
            {JOINT_PHASES.find((p) => p.id === report.phase)?.label} phase, round {report.round + 1} —{' '}
            {JOINT_PHASES.find((p) => p.id === report.phase)?.question} Base deck ({report.base.landCount} lands in{' '}
            {report.deckSize}) won <strong>{pct(report.baseWinRate.p)}</strong> of these games.{' '}
            {report.verdict === 'improved' ? (
              <>
                The best move proved better: <strong>{report.winner?.move.label}</strong>.
              </>
            ) : (
              <>
                <strong>Nothing in this phase proved better.</strong> That is INCONCLUSIVE, not "everything is
                worse" — the on-the-edge row below is the largest difference the correction could not call.
              </>
            )}
          </p>

          {report.landCounts.length > 0 && <LandCountTable rows={report.landCounts} />}

          {report.rows.length === 0 ? (
            <p className="lab-placeholder">No move was evaluated in this phase.</p>
          ) : (
            <table className="lab-table joint-table" data-testid="joint-moves">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Move</th>
                  <th>Games</th>
                  <th>Δ win rate</th>
                  <th>p (corrected)</th>
                  <th>Verdict</th>
                </tr>
              </thead>
              <tbody>
                {report.rows.map((row) => (
                  <tr key={row.key} className={row.key === report.winner?.key ? 'joint-table__winner' : undefined}>
                    <td>{row.rank}</td>
                    <td>
                      <strong>{row.move.label}</strong>
                      <span className="joint-table__note">{row.move.note}</span>
                    </td>
                    <td>{row.gamesPlayed}</td>
                    <td>{signedPct(row.evaluation.delta)}</td>
                    <td>{pValueStr(row.adjustedPValue)}</td>
                    <td>
                      <span className={`verdict verdict--${verdictDisplay(row.evaluation.verdict).tone}`}>
                        {verdictDisplay(row.evaluation.verdict).label}
                      </span>
                      {/* §3.179 — the reason the verdict is what it is, from the sim's table. */}
                      <span
                        className="trim-why"
                        title={verdictReasonDisplay(row.evaluation.verdictReason, reasonContextOf(row, report.notes.stats)).detail}
                      >
                        {' '}
                        {verdictReasonDisplay(row.evaluation.verdictReason, reasonContextOf(row, report.notes.stats)).label}
                        {row.evaluation.gamesToSettle && (
                          <span className="trim-settle" title={gamesToSettleText(row.evaluation.gamesToSettle)}>
                            {' '}
                            (~{row.evaluation.gamesToSettle.additionalPairedGames.toLocaleString()} more)
                          </span>
                        )}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {report.edge && (
            <p className="lab-coverage" data-testid="joint-edge">
              On the edge: <strong>{report.edge.move.label}</strong> at {signedPct(report.edge.evaluation.delta)} (p{' '}
              {pValueStr(report.edge.adjustedPValue)}) — the largest difference this phase could not call. It was
              NOT accepted.
            </p>
          )}

          <p className="lab-coverage">
            Tried {report.rows.length} of {report.notes.candidatesGenerated} enumerated moves
            {report.capped.length > 0 && <> ({report.capped.length} past the cap, not played)</>}.
            {report.skipped.length > 0 && <> {report.skipped.length} could not be built for this deck.</>}
            {report.failures.length > 0 && <> {report.failures.length} failed while playing.</>} This phase played{' '}
            {report.gamesPlayed.toLocaleString()} games in {report.elapsedSeconds.toFixed(1)}s;{' '}
            {report.multipleComparisons.familySize} tests corrected by {report.multipleComparisons.method}.
          </p>

          {report.skipped.length > 0 && (
            <details className="joint-skipped">
              <summary>{report.skipped.length} moves this deck cannot reach, and why</summary>
              <ul>
                {report.skipped.map((row, i) => (
                  <li key={`${row.family}-${row.label}-${i}`}>
                    <strong>{row.label}</strong> — {row.reason}
                  </li>
                ))}
              </ul>
            </details>
          )}

          <p className="lab-coverage joint-not-gated" data-testid="joint-not-gated">
            {JOINT_NOT_GATED_ON.map((row) => (
              <span key={row.id}>
                <strong>Not used to accept a move — {row.label}:</strong> {row.reason}{' '}
              </span>
            ))}
          </p>
          <FidelityNote />
        </div>
      )}

      <p className="lab-coverage joint-claim-foot">{JOINT_HONEST_CLAIM}</p>
    </div>
  );
}

/**
 * WHAT IS THE BEST MANA RATIO? — one row per land count this phase reached, each
 * judged by its BEST partner, with the number of partners it had printed beside
 * it. A count judged on one partner is the confounded reading and the row says
 * so rather than presenting it as the best deck at that count.
 */
function LandCountTable({ rows }: { readonly rows: readonly LandCountRow[] }): ReactElement {
  return (
    <div className="joint-counts" data-testid="joint-land-counts">
      <h4>Land counts, each judged by its best partner spell</h4>
      <p className="joint-counts__caption">
        A count is attributed to the deck you would actually BUILD at it — the best of the partner spells
        it was measured against. A row that says ONE partner is the confounded reading: the count and that
        one spell moved together, so it cannot separate them.
      </p>
      <table className="lab-table">
        <thead>
          <tr>
            <th>Lands</th>
            <th>Partners tried</th>
            <th>Best partner</th>
            <th>Δ win rate</th>
            <th>Verdict</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.landCount} className={row.isBase ? 'joint-counts__base' : undefined}>
              <td>
                {row.landCount}
                {row.isBase && <span className="joint-counts__tag">as built</span>}
              </td>
              <td>{row.isBase ? '—' : row.partnersTested}</td>
              <td>
                {row.isBase ? '—' : (row.best?.move.partner?.name ?? '—')}
                <span className="joint-table__note">{row.note}</span>
              </td>
              <td>{row.isBase ? '—' : signedPct(row.delta)}</td>
              <td>
                {row.isBase ? (
                  <span className="verdict">baseline</span>
                ) : (
                  <>
                    <span className={`verdict verdict--${verdictDisplay(row.verdict as SwapVerdict).tone}`}>
                      {verdictDisplay(row.verdict as SwapVerdict).label}
                    </span>
                    {/*
                      §3.179 — the land-count rollup summarises its best partner,
                      so the reason it prints IS that partner's. The base row has
                      no test and therefore no reason, which is why the field is
                      optional rather than defaulted to something that reads true.
                    */}
                    {row.verdictReason && (
                      <span className="trim-why"> {SWAP_VERDICT_REASON_BY_KEY[row.verdictReason].label}</span>
                    )}
                  </>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
