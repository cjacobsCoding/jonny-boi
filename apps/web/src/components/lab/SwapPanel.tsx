import { useState, type ReactElement } from 'react';
import { WinRateBar } from '../WinRateBar.js';
import { FidelityNote } from '../FidelityNote.js';
import { RunSlider } from './RunSlider.js';
import { ciStr, signedPct, pValueStr, verdictDisplay } from '../../lib/sim-format.js';
import { VERDICT_ALPHA } from '../../lib/lab-config.js';
import type { PanelProps, GamesConfig } from './panel-types.js';
import type { CardOption } from './panel-types.js';

/**
 * The A/B single-card swap test — the product's signature feature. Pick a card to
 * cut (from the hero) and one to add (from the pool), run the paired evaluation,
 * and show the verdict prominently: BETTER / WORSE / INCONCLUSIVE, with base →
 * variant win-rates, the delta, the McNemar p-value, and the paired 2×2 table.
 */
export function SwapPanel({
  heroPayload,
  heroLegal,
  chosenOpponents,
  seed,
  sim,
  gamesConfig,
  outOptions,
  inOptions,
}: PanelProps & {
  gamesConfig: GamesConfig;
  outOptions: readonly CardOption[];
  inOptions: readonly CardOption[];
}): ReactElement {
  const [games, setGames] = useState(gamesConfig.default);
  const [outId, setOutId] = useState<string>(outOptions[0]?.cardId ?? '');
  const [inId, setInId] = useState<string>('');

  const running = sim.status === 'running';
  const sameCard = outId !== '' && outId === inId;
  const canRun =
    heroLegal &&
    heroPayload !== null &&
    chosenOpponents.length > 0 &&
    outId !== '' &&
    inId !== '' &&
    !sameCard &&
    !running;

  const result = sim.status === 'done' && sim.result?.kind === 'swap' ? sim.result : null;
  const e = result ? result.result : null;
  const verdict = e ? verdictDisplay(e.verdict) : null;

  return (
    <div className="lab-section">
      <p className="lab-section__intro">
        Swap one card and get a paired, significance-tested verdict. Both decks play the SAME games
        (common random numbers), so the only difference is the swapped card.
      </p>

      <div className="lab-controls lab-controls--swap">
        <label className="lab-field">
          <span className="section-label">Cut (out)</span>
          <select
            className="select"
            value={outId}
            onChange={(ev) => setOutId(ev.target.value)}
            disabled={running}
            aria-label="Card to cut"
          >
            {outOptions.map((o) => (
              <option key={o.cardId} value={o.cardId}>
                {o.name}
              </option>
            ))}
          </select>
        </label>
        <span className="lab-swap-arrow" aria-hidden="true">
          →
        </span>
        <label className="lab-field">
          <span className="section-label">Add (in)</span>
          <select
            className="select"
            value={inId}
            onChange={(ev) => setInId(ev.target.value)}
            disabled={running}
            aria-label="Card to add"
          >
            <option value="">Pick a card…</option>
            {inOptions.map((o) => (
              <option key={o.cardId} value={o.cardId}>
                {o.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="lab-controls">
        <RunSlider
          label="Games per opponent"
          value={games}
          min={gamesConfig.min}
          max={gamesConfig.max}
          step={gamesConfig.step}
          disabled={running}
          onChange={setGames}
          hint="Paired runs play both base & variant per game"
        />
        <button
          type="button"
          className="btn btn--primary"
          disabled={!canRun}
          onClick={() =>
            heroPayload &&
            sim.run({
              kind: 'swap',
              hero: heroPayload,
              opponentNames: chosenOpponents,
              outCardId: outId,
              inCardId: inId,
              gamesPerOpponent: games,
              seed,
            })
          }
        >
          Run A/B test
        </button>
        {sameCard && <span className="lab-hint">Pick two different cards.</span>}
      </div>

      {result && e && verdict && (
        <div className="lab-results">
          <div className={`verdict-banner verdict-banner--${verdict.tone}`}>
            <span className="verdict-banner__label">{verdict.label}</span>
            <span className="verdict-banner__detail">
              −{e.outName} +{e.inName} · {signedPct(e.delta)} win rate
            </span>
          </div>

          <div className="swap-compare">
            <div className="swap-compare__row">
              <span className="swap-compare__name">Base ({e.baseDeck})</span>
              <WinRateBar ci={e.baseWinRate} label="Base" />
              <span className="swap-compare__ci">{ciStr(e.baseWinRate)}</span>
            </div>
            <div className="swap-compare__row">
              <span className="swap-compare__name">Variant (with {e.inName})</span>
              <WinRateBar ci={e.variantWinRate} label="Variant" />
              <span className="swap-compare__ci">{ciStr(e.variantWinRate)}</span>
            </div>
          </div>

          <dl className="swap-stats">
            <div>
              <dt>Delta (variant − base)</dt>
              <dd>{signedPct(e.delta)}</dd>
            </div>
            <div>
              <dt>McNemar p-value</dt>
              <dd>{pValueStr(e.pValue)}</dd>
            </div>
            <div>
              <dt>Paired games</dt>
              <dd>{e.nGames.toLocaleString()}</dd>
            </div>
            <div>
              <dt>Significance (α)</dt>
              <dd>{VERDICT_ALPHA}</dd>
            </div>
          </dl>

          <table className="lab-table lab-table--paired">
            <caption className="section-label">Paired outcomes (2×2)</caption>
            <thead>
              <tr>
                <th>Both won</th>
                <th>Base only</th>
                <th>Variant only</th>
                <th>Neither</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="lab-table__num">{e.paired.bothWon}</td>
                <td className="lab-table__num">{e.paired.baseOnly}</td>
                <td className="lab-table__num">{e.paired.variantOnly}</td>
                <td className="lab-table__num">{e.paired.neither}</td>
              </tr>
            </tbody>
          </table>

          <p className="lab-throughput">
            {(e.nGames * 2).toLocaleString()} matches · {result.gamesPerSecond.toFixed(0)} games/sec
            · seed {seed}
          </p>
          <FidelityNote />
        </div>
      )}

      {!e && !running && (
        <p className="lab-placeholder">
          Choose a card to cut and a card to add, then run the test. The verdict is only “better” or
          “worse” when the paired test clears p &lt; {VERDICT_ALPHA}; otherwise it stays honest at
          INCONCLUSIVE.
        </p>
      )}
    </div>
  );
}
