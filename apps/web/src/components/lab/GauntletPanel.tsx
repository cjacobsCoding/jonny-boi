import { useState, type ReactElement } from 'react';
import { WinRateBar } from '../WinRateBar.js';
import { FidelityNote } from '../FidelityNote.js';
import { RunSlider } from './RunSlider.js';
import { ciStr, pct, throughputText } from '../../lib/sim-format.js';
import type { PanelProps, GamesConfig } from './panel-types.js';

/**
 * Gauntlet panel: run the hero against the chosen opponents and show a per-
 * opponent win-rate + 95% CI table with win-rate bars, plus the overall record
 * and in-browser throughput.
 */
export function GauntletPanel({
  heroPayload,
  heroLegal,
  chosenOpponents,
  seed,
  sim,
  gamesConfig,
}: PanelProps & { gamesConfig: GamesConfig }): ReactElement {
  const [games, setGames] = useState(gamesConfig.default);
  const running = sim.status === 'running';
  const canRun = heroLegal && heroPayload !== null && chosenOpponents.length > 0 && !running;

  const result =
    sim.status === 'done' && sim.result?.kind === 'gauntlet' ? sim.result : null;

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
            })
          }
        >
          Run gauntlet
        </button>
        {chosenOpponents.length === 0 && (
          <span className="lab-hint">Select at least one opponent above.</span>
        )}
      </div>

      {result && (
        <div className="lab-results">
          <table className="lab-table">
            <thead>
              <tr>
                <th>Opponent</th>
                <th>Record</th>
                <th>Win rate (95% CI)</th>
                <th className="lab-table__bar-col">Win rate</th>
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
                    <WinRateBar ci={m.winRateA} label={m.deckB} />
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
                  <WinRateBar ci={result.result.overallWinRate} label="Overall" />
                </td>
              </tr>
            </tfoot>
          </table>

          <p className="lab-throughput">
            {result.result.totalGames.toLocaleString()} games ·{' '}
            {throughputText(result.gamesPerSecond)}
            {result.result.totalDraws > 0 && <> · {result.result.totalDraws} timeout draws</>} ·
            seed {seed}
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
