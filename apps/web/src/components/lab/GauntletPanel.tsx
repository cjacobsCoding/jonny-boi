import { useState, type ReactElement } from 'react';
import { WinRateBar } from '../WinRateBar.js';
import { FidelityNote } from '../FidelityNote.js';
import { RunSlider } from './RunSlider.js';
import { ciStr, pct, throughputText } from '../../lib/sim-format.js';
import { PilotStamp, RunCostNote } from './PilotControls.js';
import type { PanelProps, GamesConfig } from './panel-types.js';

/**
 * Gauntlet panel: run the hero against the chosen opponents and show a per-
 * opponent win-rate + 95% CI table with win-rate bars, plus the overall record
 * and in-browser throughput.
 */
/**
 * The interval the Lab aims for. ±5 percentage points is tight enough to tell a
 * good deck from a bad one and loose enough to reach quickly — and naming it once
 * keeps the checkbox label, the hint and the result note from drifting apart.
 */
const GAUNTLET_TARGET_HALF_WIDTH = 0.05;

export function GauntletPanel({
  heroPayload,
  heroLegal,
  chosenOpponents,
  seed,
  pilotId,
  sim,
  gamesConfig,
}: PanelProps & { gamesConfig: GamesConfig }): ReactElement {
  const [games, setGames] = useState(gamesConfig.default);
  /*
   * Default ON. A gauntlet is asked to ESTIMATE a win rate, and a fixed budget
   * usually over- or under-spends for the precision the reader actually wants:
   * the measured run bought +/-3.3% when +/-5% was asked for (§3.94). Off means
   * 'play every game', which is the right choice only when the tightest possible
   * interval matters more than the wait.
   */
  const [untilPrecise, setUntilPrecise] = useState(true);
  /** Whose numbers the table shows. Named once so no column can drift from it. */
  const heroName = heroPayload?.name ?? 'Your deck';
  const running = sim.status === 'running';
  const canRun = heroLegal && heroPayload !== null && chosenOpponents.length > 0 && !running;

  const result =
    sim.status === 'done' && sim.result?.kind === 'gauntlet' ? sim.result : null;
  // Exactly what the plan will play: one game per opponent per game index.
  const plannedGames = games * chosenOpponents.length;

  return (
    <div className="lab-section">
      <p className="lab-section__intro">
        Play your hero against every selected gauntlet deck and measure its win-rate with a 95%
        confidence interval.
      </p>

      <div className="lab-controls">
        <RunSlider
          label="Games per opponent"
          value={games}
          min={gamesConfig.min}
          max={gamesConfig.max}
          step={gamesConfig.step}
          disabled={running}
          onChange={setGames}
          hint="More games → tighter intervals, slower run"
        />
        <button
          type="button"
          className="btn btn--primary"
          disabled={!canRun}
          onClick={() =>
            heroPayload &&
            sim.run({
              kind: 'gauntlet',
              hero: heroPayload,
              opponentNames: chosenOpponents,
              gamesPerOpponent: games,
              seed,
              pilotId,
              ...(untilPrecise ? { untilPrecise: GAUNTLET_TARGET_HALF_WIDTH } : {}),
            })
          }
        >
          Run gauntlet
        </button>
        {chosenOpponents.length === 0 && (
          <span className="lab-hint">Select at least one opponent above.</span>
        )}
      </div>

      <label className="lab-field lab-scope">
        <span className="section-label">Stop when precise enough</span>
        <span className="lab-scope__row">
          <input
            type="checkbox"
            checked={untilPrecise}
            disabled={sim.status === 'running'}
            onChange={(ev) => setUntilPrecise(ev.target.checked)}
            aria-label="Stop once the win rate is measured precisely enough"
          />
          <span>Stop once the win rate is known to within ±5%</span>
        </span>
        <span className="lab-scope__hint">
          {untilPrecise
            ? `Plays a short pilot, then only as many games as that win rate needs — a lopsided deck settles in far fewer. The interval shown is always the one actually earned.`
            : `Plays every game you asked for. Slower, and often tighter than you need.`}
        </span>
      </label>

      {chosenOpponents.length > 0 && (
        <RunCostNote pilotId={pilotId} games={plannedGames} workerCount={sim.workerCount} />
      )}

      {result && (
        <div className="lab-results">
          <PilotStamp pilotId={result.pilotId} />

          {result.precision && (
            /*
             * Told, never implied. The reader asked for a budget and got a
             * different number of games; and when the BUDGET ran out first the
             * interval is wider than the target, which must be said rather than
             * left for them to notice.
             */
            <p className="lab-hint">
              Pilot measured {(result.precision.pilotWinRate * 100).toFixed(0)}% and sized the run to{' '}
              {result.precision.totalGames} of {games} games per opponent.{' '}
              {result.precision.budgetLimited
                ? `Your game budget ran out before ±${Math.round(GAUNTLET_TARGET_HALF_WIDTH * 100)}% was reached — the interval below is wider than that.`
                : `That reached the ±${Math.round(GAUNTLET_TARGET_HALF_WIDTH * 100)}% it was aiming for.`}
            </p>
          )}
          <table className="lab-table">
            <thead>
              {/* ⚠️ Every number in this table is the HERO's, per opponent — the
                  opponent only names the matchup. Saying just "Win rate" beside
                  a column of opponent names invites the exact misreading that
                  sent a healthy deck to be investigated as a broken one: a row
                  reading "Selesnya Blink · 13/100 · 13.0%" is the hero winning
                  13% AGAINST that deck, not that deck winning 13%. §3.65. */}
              <tr>
                <th>Opponent</th>
                <th>{heroName} record</th>
                <th>{heroName} win rate (95% CI)</th>
                <th className="lab-table__bar-col">{heroName} win rate</th>
              </tr>
            </thead>
            <tbody>
              {result.result.matchups.map((m) => (
                <tr key={m.deckB}>
                  <td>{m.deckB}</td>
                  <td className="lab-table__num">
                    {m.winsA}/{m.games}
                  </td>
                  <td>{ciStr(m.winRateA)}</td>
                  <td>
                    {/* The bar is the hero's, so it must not be labelled with
                        the opponent's name — that read as the opponent's bar. */}
                    <WinRateBar ci={m.winRateA} label={`${heroName} vs ${m.deckB}`} />
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td>
                  <strong>Overall</strong>
                </td>
                <td className="lab-table__num">
                  {result.result.totalWins}/{result.result.totalGames}
                </td>
                <td>
                  <strong>{ciStr(result.result.overallWinRate)}</strong>
                </td>
                <td>
                  <WinRateBar ci={result.result.overallWinRate} label={`${heroName} overall`} />
                </td>
              </tr>
            </tfoot>
          </table>

          <p className="lab-throughput">
            {result.result.totalGames.toLocaleString()} games ·{' '}
            {throughputText(result.gamesPerSecond)}
            {result.result.totalDraws > 0 && <> · {result.result.totalDraws} timeout draws</>} ·
            seed {seed} · pilot {result.pilotId}
          </p>
          <FidelityNote />
        </div>
      )}

      {!result && !running && (
        <p className="lab-placeholder">
          Set the games per opponent and run the gauntlet to see win-rate bars. Overall win rate
          will read as {pct(0.5)} when a deck is exactly even.
        </p>
      )}
    </div>
  );
}
