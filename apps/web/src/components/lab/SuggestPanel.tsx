import { useState, type ReactElement } from 'react';
import { FidelityNote } from '../FidelityNote.js';
import { RunSlider } from './RunSlider.js';
import { ciStr, pct, signedPct, pValueStr, throughputText, verdictDisplay } from '../../lib/sim-format.js';
import type { PanelProps, GamesConfig } from './panel-types.js';

/**
 * The suggestion engine surface: rank candidate single-card swaps that improve
 * the hero. Shows the ranked table (out → in, base% → variant%, delta, p-value,
 * verdict), plus the honest coverage note (evaluated/total, capped-by-budget,
 * illegal skips) and the shared fidelity caveat. Two sliders trade speed vs
 * confidence: games-per-candidate and the candidate cap.
 */
export function SuggestPanel({
  heroPayload,
  heroLegal,
  chosenOpponents,
  seed,
  sim,
  onApplySwap,
  gamesConfig,
  maxCandidatesConfig,
}: PanelProps & { gamesConfig: GamesConfig; maxCandidatesConfig: GamesConfig }): ReactElement {
  const [games, setGames] = useState(gamesConfig.default);
  const [maxCandidates, setMaxCandidates] = useState(maxCandidatesConfig.default);

  const running = sim.status === 'running';
  const canRun = heroLegal && heroPayload !== null && chosenOpponents.length > 0 && !running;

  const result = sim.status === 'done' && sim.result?.kind === 'suggest' ? sim.result : null;
  const report = result?.result ?? null;

  const cappedCount = report?.skipped.filter((s) => s.reason === 'capped').length ?? 0;
  const illegalCount = report?.skipped.filter((s) => s.reason === 'illegal').length ?? 0;

  return (
    <div className="lab-section">
      <p className="lab-section__intro">
        Let the engine propose the next card swap and prove whether it helps. Each candidate is
        judged through the same paired A/B test, then ranked best-first.
      </p>

      <div className="lab-controls">
        <RunSlider
          label="Games per candidate"
          value={games}
          min={gamesConfig.min}
          max={gamesConfig.max}
          step={gamesConfig.step}
          disabled={running}
          onChange={setGames}
          hint="Confidence per swap"
        />
        <RunSlider
          label="Max candidates"
          value={maxCandidates}
          min={maxCandidatesConfig.min}
          max={maxCandidatesConfig.max}
          step={maxCandidatesConfig.step}
          disabled={running}
          onChange={setMaxCandidates}
          hint="Breadth of the search"
        />
        <button
          type="button"
          className="btn btn--primary"
          disabled={!canRun}
          onClick={() =>
            heroPayload &&
            sim.run({
              kind: 'suggest',
              hero: heroPayload,
              opponentNames: chosenOpponents,
              gamesPerCandidate: games,
              maxCandidates,
              seed,
            })
          }
        >
          Suggest swaps
        </button>
      </div>

      {report && (
        <div className="lab-results">
          <p className="lab-section__intro">
            Base deck gauntlet win rate: <strong>{ciStr(report.baseGauntletWinRate)}</strong>
          </p>

          {report.suggestions.length === 0 ? (
            <p className="lab-placeholder">
              No candidate swaps were evaluated (none legal, or all capped). Try raising the
              candidate cap.
            </p>
          ) : (
            <table className="lab-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Out → In</th>
                  <th>Base%</th>
                  <th>Variant%</th>
                  <th>Delta</th>
                  <th>p-value</th>
                  <th>Verdict</th>
                  {/* Acting on the ranking is the point of producing it. */}
                  <th aria-label="Apply this swap" />
                </tr>
              </thead>
              <tbody>
                {report.suggestions.map((s) => {
                  const ev = s.evaluation;
                  const v = verdictDisplay(ev.verdict);
                  return (
                    <tr key={`${ev.swap.out}>${ev.swap.in}`}>
                      <td className="lab-table__num">{s.rank}</td>
                      <td>
                        {s.outName} → {s.inName}
                      </td>
                      <td className="lab-table__num">{pct(ev.baseWinRate.p)}</td>
                      <td className="lab-table__num">{pct(ev.variantWinRate.p)}</td>
                      <td className="lab-table__num">{signedPct(ev.delta)}</td>
                      <td className="lab-table__num">{pValueStr(ev.pValue)}</td>
                      <td>
                        <span className={`verdict-tag verdict-tag--${v.tone}`}>{v.label}</span>
                      </td>
                      <td>
                        {onApplySwap && (
                          <button
                            type="button"
                            className="btn btn--ghost lab-table__apply"
                            onClick={() =>
                              onApplySwap(ev.swap.out, ev.swap.in, ev.copiesSwapped)
                            }
                            title={`Swap ${ev.copiesSwapped}× ${s.outName} for ${s.inName} in your deck`}
                          >
                            Apply
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}

          <p className="lab-coverage">
            Evaluated {report.candidatesEvaluated} of {report.notes.candidatesGenerated} candidates
            {report.notes.cappedByBudget && <> (capped at {maxCandidates})</>}.
            {cappedCount > 0 && <> {cappedCount} capped for budget.</>}
            {illegalCount > 0 && <> {illegalCount} skipped (illegal variant).</>}
          </p>
          <p className="lab-throughput">
            {report.notes.totalGamesRun.toLocaleString()} games
            {report.notes.gamesPerSecond !== undefined && (
              <> · {throughputText(report.notes.gamesPerSecond)}</>
            )}{' '}
            · seed {seed}
          </p>
          <FidelityNote text={report.notes.fidelityCaveat} />
        </div>
      )}

      {!report && !running && (
        <p className="lab-placeholder">
          Tune the sliders and run the search. Lower games = faster but noisier (more
          INCONCLUSIVE); higher = slower but more confident.
        </p>
      )}
    </div>
  );
}
