import { useState, type ReactElement } from 'react';
import { WinRateBar } from '../WinRateBar.js';
import { FidelityNote } from '../FidelityNote.js';
import { CardHover } from '../CardHover.js';
import { RunSlider } from './RunSlider.js';
import { ciStr, signedPct, pValueStr, throughputText, verdictDisplay } from '../../lib/sim-format.js';
import { VERDICT_ALPHA } from '../../lib/lab-config.js';
import { DEFAULT_SWAP_SCOPE, GAMES_PER_PAIRED_GAME, type SwapScope } from '@jonny-boi/sim';
import { PilotStamp, RunCostNote } from './PilotControls.js';
import type { PanelProps, GamesConfig } from './panel-types.js';
import type { CardOption } from './panel-types.js';
import { CardPicker } from './CardPicker.js';
import { reconcileScope, scopeFromOptionValue, scopeOptionValue, swapScopeOptions } from '../../lib/lab/swapScopeOptions.js';
import './swap-scope.css';

/**
 * The A/B single-card swap test — the product's signature feature. Pick a card to
 * cut (from the hero) and one to add (from the pool), run the paired evaluation,
 * and show the verdict prominently: BETTER / WORSE / INCONCLUSIVE, with base →
 * variant win-rates, the delta, the McNemar p-value, and the paired 2×2 table.
 */
export function SwapPanel({
  hero,
  heroPayload,
  heroLegal,
  chosenOpponents,
  seed,
  pilotId,
  sim,
  onApplySwap,
  gamesConfig,
  outOptions,
  inOptions,
}: PanelProps & {
  gamesConfig: GamesConfig;
  outOptions: readonly CardOption[];
  inOptions: readonly CardOption[];
}): ReactElement {
  const [games, setGames] = useState(gamesConfig.default);
  // Defaults to the sim's own default so the UI and a CLI run agree.
  const [scope, setScope] = useState<SwapScope>(DEFAULT_SWAP_SCOPE);
  // Default ON: a decided swap finishes in a fraction of the games and an
  // undecided one costs nothing extra, so the only reason to turn it off is
  // wanting the tightest possible delta estimate rather than just the verdict.
  const [untilDecided, setUntilDecided] = useState(true);
  const [outId, setOutId] = useState<string>(outOptions[0]?.cardId ?? '');
  const [inId, setInId] = useState<string>('');
  // §3.165 — which RESULT "Apply to my deck" has already been pressed for, by
  // identity: a new run is a new object and gets a live button again, while
  // the one that was applied stays visibly applied.
  const [appliedFor, setAppliedFor] = useState<object | null>(null);

  // §3.165 — the copies menu follows the CUT card's line: a 1-of has one
  // choice, an N-of offers the playset, one, and every count between. When the
  // cut changes, a scope the new line cannot express snaps to the menu's first.
  const outLine = outOptions.find((o) => o.cardId === outId)?.count;
  const scopeOptions = swapScopeOptions(outId === '' ? undefined : outLine);
  // Derived at render rather than written back by an effect: the stored choice
  // is what the player last picked; what the run USES is that choice if the
  // line still offers it, else the menu's first entry.
  const effectiveScope = reconcileScope(scope, scopeOptions);

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
  // A paired run plays BOTH decks on every game index — the honest game count is
  // twice the pairs, which is also what the progress bar counts.
  const plannedGames = games * chosenOpponents.length * GAMES_PER_PAIRED_GAME;
  const verdict = e ? verdictDisplay(e.verdict) : null;

  return (
    <div className="lab-section">
      <p className="lab-section__intro">
        Swap a card and get a paired, significance-tested verdict. Both decks play the SAME games
        (common random numbers), so the only difference is the swapped card.
      </p>

      <div className="lab-controls lab-controls--swap">
        {/* §3.165 — type-to-filter pickers with the browser's filters one click
            away, in place of two native selects (the "add" one listed the whole
            7,000-card pool). The cut picker lists the hero's cards with their
            copy counts; the add picker lists the pool. */}
        <div className="lab-field lab-field--picker">
          <CardPicker
            label="Cut (out)"
            options={outOptions}
            value={outId}
            onChange={setOutId}
            disabled={running}
            placeholder="Type a card in your deck…"
          />
        </div>
        <span className="lab-swap-arrow" aria-hidden="true">
          →
        </span>
        <div className="lab-field lab-field--picker">
          <CardPicker
            label="Add (in)"
            options={inOptions}
            value={inId}
            onChange={setInId}
            disabled={running}
            placeholder="Type any card in the pool…"
          />
        </div>
      </div>

      <label className="lab-field lab-scope">
        <span className="section-label">How many copies</span>
        {/*
          §3.136 — the named scopes PLUS a count. Suggestions can now recommend a
          swap at "2 of 3", so this tab has to be able to verify one at the same
          scope; a Lab that recommends what it cannot test contradicts itself.
        */}
        <select
          className="select"
          value={scopeOptionValue(effectiveScope)}
          onChange={(ev) => setScope(scopeFromOptionValue(ev.target.value))}
          disabled={running || scopeOptions.length === 1}
          aria-label="How many copies to swap"
        >
          {scopeOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <span className="lab-scope__hint">
          {effectiveScope === 'playset'
            ? 'Every copy of the cut card is replaced. Much larger effect, so a verdict is reachable in far fewer games.'
            : effectiveScope === 'one'
              ? 'One copy is replaced. A small effect — expect “inconclusive” unless you run a lot of games.'
              : `Up to ${effectiveScope.copies} copies are replaced (fewer if the deck runs fewer). The more copies, the larger the effect and the sooner a verdict lands.`}
        </span>
      </label>

      <label className="lab-field lab-scope">
        <span className="section-label">Stop when decided</span>
        <span className="lab-scope__row">
          <input
            type="checkbox"
            checked={untilDecided}
            disabled={running}
            onChange={(ev) => setUntilDecided(ev.target.checked)}
            aria-label="Stop as soon as the result is decided"
          />
          <span>Stop early once the verdict is certain</span>
        </span>
        <span className="lab-scope__hint">
          {untilDecided
            ? 'Checks four times as it goes and stops as soon as the answer is in — a clear result can finish in a quarter of the games. Each check uses a stricter bar so the verdict is just as reliable.'
            : 'Plays every game you asked for. Slower, but gives the tightest estimate of the delta.'}
        </span>
      </label>

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
              swapScope: effectiveScope,
              untilDecided,
              pilotId,
            })
          }
        >
          Run A/B test
        </button>
        {sameCard && <span className="lab-hint">Pick two different cards.</span>}
      </div>

      {chosenOpponents.length > 0 && (
        <RunCostNote pilotId={pilotId} games={plannedGames} workerCount={sim.workerCount} />
      )}

      {result && e && verdict && (
        <div className="lab-results">
          <div className={`verdict-banner verdict-banner--${verdict.tone}`}>
            <span className="verdict-banner__label">{verdict.label}</span>
            <span className="verdict-banner__detail">
              −{e.copiesSwapped}×{' '}
              <CardHover cardId={e.swap.out} className="lab-card-name">
                {e.outName}
              </CardHover>{' '}
              +{e.copiesSwapped}×{' '}
              <CardHover cardId={e.swap.in} className="lab-card-name">
                {e.inName}
              </CardHover>{' '}
              · {signedPct(e.delta)} win rate
            </span>
            {onApplySwap &&
              (() => {
                // Pressing Apply records THIS result; the button then says it
                // applied instead of offering the same change forever.
                const applied = appliedFor === result;
                return (
                  <button
                    type="button"
                    className={`btn verdict-banner__apply ${applied ? 'btn--ghost verdict-banner__apply--done' : 'btn--primary'}`}
                    disabled={applied}
                    onClick={() => {
                      onApplySwap(outId, inId, e.copiesSwapped);
                      setAppliedFor(result);
                    }}
                    title={
                      applied
                        ? `${hero?.name ?? 'Your deck'} now runs this change — open Deck Builder to see it`
                        : `Make this change to ${hero?.name ?? 'your deck'}`
                    }
                  >
                    {applied ? `✓ Applied to ${hero?.name ?? 'your deck'}` : 'Apply to my deck'}
                  </button>
                );
              })()}
          </div>

          <PilotStamp pilotId={result.pilotId} />

          {result.sequential?.stoppedEarly && (
            /*
             * Told, never implied. The reader is looking at a smaller n than they
             * asked for, and the only honest way to present that is to say so and
             * say why the verdict still holds at the alpha on the banner.
             */
            <p className="lab-hint">
              Stopped after {result.sequential.looksTaken} of 4 checks —{' '}
              {result.sequential.gamesPlayed} of {games} games per opponent. Each check used a
              stricter bar (alpha {result.sequential.perLookAlpha}) so the verdict is as reliable as
              the full run.
            </p>
          )}

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
            {(e.nGames * GAMES_PER_PAIRED_GAME).toLocaleString()} matches ·{' '}
            {throughputText(result.gamesPerSecond)} · seed {seed} · pilot {result.pilotId}
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
