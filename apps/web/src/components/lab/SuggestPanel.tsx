import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import { FidelityNote } from '../FidelityNote.js';
import { CardHover } from '../CardHover.js';
import { RunSlider } from './RunSlider.js';
import {
  ciStr,
  gamesToSettleText,
  pct,
  signedPct,
  pValueStr,
  reasonContextOf,
  throughputText,
  verdictDisplay,
  verdictReasonDisplay,
} from '../../lib/sim-format.js';
import {
  clearSuggestionHistory,
  historyRejectionText,
  otherPilotHistories,
  readSuggestionHistory,
  writeSuggestionHistory,
  type OtherPilotHistory,
} from '../../lib/sim/history-store.js';
import { estimateSuggestionGames } from '../../lib/sim/plan.js';
import { pilotLabel } from '../../lib/sim/pilots.js';
import { PilotStamp, RunCostNote } from './PilotControls.js';
import type { PanelProps, GamesConfig, CardOption } from './panel-types.js';
import type { SimDeckPayload } from '../../lib/sim-protocol.js';
import {
  SAMPLE_DECKS,
  describeGap,
  familyOf,
  findRoleGaps,
  referenceProfile,
  shapeOf,
  type Deck as SimDeck,
  type SuggestionHistory,
} from '@jonny-boi/sim';
import { loadCardPool } from '../../lib/sim-pool.js';
import { toSimPayload } from '../../lib/sim-format.js';
import type { Deck } from '../../lib/deck.js';
import './suggest-focus.css';

/**
 * The suggestion engine surface: rank candidate single-card swaps that improve
 * the hero. Shows the ranked table (out → in, base% → variant%, delta, p-value,
 * verdict), plus the honest coverage note (evaluated/total, capped-by-budget,
 * illegal skips) and the shared fidelity caveat. Two sliders trade speed vs
 * confidence: games-per-candidate and the candidate cap.
 *
 * ## The search REMEMBERS
 *
 * The engine's search is progressive: hand it what earlier runs learned and it
 * skips settled losers, spends its budget on candidates nobody has tried, and
 * refines the ones that looked promising. That record is plain JSON the engine
 * hands back, and this panel is what persists it — per deck, keyed by the
 * decklist's content fingerprint (`lib/sim/history-store.ts`).
 *
 * So the panel has to SAY so. A user who cannot see that run two is building on
 * run one has no way to tell progressive search from a coin flip, and no way to
 * start over when they want a clean read. Hence the banner above the button and
 * the Reset next to it — and hence the honest line when a saved record was
 * rejected because the deck changed underneath it.
 *
 * ## The record belongs to a DECK **and a PILOT**
 *
 * The record accumulates across runs, and its `candidates` list is the
 * Holm–Bonferroni family every verdict is corrected against. Both of those make it
 * evidence, not a cache — so it is partitioned by pilot as well as by decklist, and
 * each pilot's search is kept side by side rather than one overwriting the other
 * (`lib/sim/history-store.ts` explains why pooling would be statistically invalid).
 * The banner names the pilot, the Reset button names the pilot it will forget, and
 * a line lists the searches other pilots still hold.
 */
export function SuggestPanel({
  hero,
  heroPayload,
  heroLegal,
  chosenOpponents,
  seed,
  pilotId,
  sim,
  onApplySwap,
  gamesConfig,
  maxCandidatesConfig,
  cutOptions,
}: PanelProps & {
  gamesConfig: GamesConfig;
  maxCandidatesConfig: GamesConfig;
  /** The hero's cards, for the §3.136 focus picker. */
  cutOptions: readonly CardOption[];
}): ReactElement {
  const [games, setGames] = useState(gamesConfig.default);
  const [maxCandidates, setMaxCandidates] = useState(maxCandidatesConfig.default);
  /**
   * §3.136 — the focus. `cutFocus` empty means "search the whole deck", which is
   * what the panel always did; `copies` is how much of a card a candidate swap
   * moves, defaulting to the whole playset exactly as the engine does.
   */
  const [cutFocus, setCutFocus] = useState<ReadonlySet<string>>(() => new Set());
  const [copies, setCopies] = useState<number | 'playset'>('playset');
  const focusSummary =
    cutFocus.size === 0 && copies === 'playset'
      ? '— whole deck, whole playsets'
      : `— ${cutFocus.size === 0 ? 'whole deck' : `${cutFocus.size} card${cutFocus.size === 1 ? '' : 's'}`}, ${
          copies === 'playset' ? 'whole playsets' : `${copies} cop${copies === 1 ? 'y' : 'ies'}`
        }`;

  const running = sim.status === 'running';
  const canRun = heroLegal && heroPayload !== null && chosenOpponents.length > 0 && !running;

  const result = sim.status === 'done' && sim.result?.kind === 'suggest' ? sim.result : null;
  const report = result?.result ?? null;

  const { stored, rejected, others, refresh } = useStoredHistory(heroPayload, pilotId);

  // A finished run's record replaces the stored one FOR THE PILOT THAT PLAYED IT —
  // `result.pilotId`, not the picker's current value, because the picker may have
  // moved while the run was in flight and filing evidence under the wrong pilot is
  // exactly the pooling this partition exists to prevent. Writing it here — where
  // the deck that was tuned is in hand — keeps persistence out of the worker pool,
  // which has no business knowing about localStorage.
  const reportPilotId = result?.pilotId;
  useEffect(() => {
    if (!report || !reportPilotId) return;
    writeSuggestionHistory(report.history, reportPilotId);
    refresh();
  }, [report, reportPilotId, refresh]);

  const cappedCount = report?.skipped.filter((s) => s.reason === 'capped').length ?? 0;
  const illegalCount = report?.skipped.filter((s) => s.reason === 'illegal').length ?? 0;
  const settledCount = report?.skipped.filter((s) => s.reason === 'settled').length ?? 0;

  return (
    <div className="lab-section">
      <p className="lab-section__intro">
        Let the engine propose the next card swap and prove whether it helps. Every candidate gets a
        cheap scout batch; the budget then concentrates on the ones still plausibly better, so only
        finalists are played to full depth. Verdicts are corrected for testing many cards at once.
      </p>

      <DeckShapeNote hero={hero} />

      <SearchMemory
        stored={stored}
        rejected={rejected}
        others={others}
        pilotId={pilotId}
        disabled={running}
        onReset={() => {
          if (heroPayload) clearSuggestionHistory(heroPayload, pilotId);
          refresh();
        }}
      />

      <div className="lab-controls">
        <RunSlider
          label="Games per finalist"
          value={games}
          min={gamesConfig.min}
          max={gamesConfig.max}
          step={gamesConfig.step}
          disabled={running}
          onChange={setGames}
          hint="Depth the winner reaches"
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
              pilotId,
              // Carrying the record is what makes a re-run explore new ground.
              ...(stored ? { history: stored } : {}),
              // §3.136 — the focus, when the player narrowed it.
              ...(cutFocus.size > 0 ? { cutOnly: [...cutFocus] } : {}),
              ...(copies === 'playset' ? {} : { swapScope: { copies } }),
            })
          }
        >
          {stored ? `Suggest swaps (run ${stored.runsCompleted + 1})` : 'Suggest swaps'}
        </button>
      </div>

      {/*
        §3.136 — FOCUS THE SEARCH. Asked for directly: "can the Suggestions tab be
        scoped to looking at just specific cards in the deck? And at specific
        amounts to swap? … maybe I have 3 elvish visionaries but I want to look
        for suggestions to swap out 2 of them."

        Collapsed by default so the common "just search everything" run is still
        one click, and the summary line says what the current focus is rather than
        making the player open it to find out.
      */}
      <details className="suggest-focus">
        <summary>
          Focus the search <span className="suggest-focus__summary">{focusSummary}</span>
        </summary>
        <div className="suggest-focus__body">
          <div className="suggest-focus__scope">
            <label htmlFor="suggest-copies">Swap</label>
            <select
              id="suggest-copies"
              className="select"
              value={String(copies)}
              disabled={running}
              onChange={(ev) =>
                setCopies(ev.target.value === 'playset' ? 'playset' : Number(ev.target.value))
              }
            >
              <option value="playset">the whole playset — does this card belong at all?</option>
              <option value="1">1 copy — is the last copy earning its slot?</option>
              <option value="2">2 copies</option>
              <option value="3">3 copies</option>
              <option value="4">4 copies</option>
            </select>
          </div>

          <fieldset className="suggest-focus__cards">
            <legend>
              Consider cutting
              {cutFocus.size > 0 && (
                <button type="button" className="btn btn--ghost" onClick={() => setCutFocus(new Set())}>
                  Clear ({cutFocus.size})
                </button>
              )}
            </legend>
            <p className="suggest-focus__hint">
              Tick nothing to search the whole deck. Ticking cards restricts the search to swapping
              those out — far fewer candidates, so each one gets more games.
            </p>
            <div className="suggest-focus__grid">
              {cutOptions.map((o) => (
                <label key={o.cardId} className="suggest-focus__card">
                  <input
                    type="checkbox"
                    checked={cutFocus.has(o.cardId)}
                    disabled={running}
                    onChange={(ev) =>
                      setCutFocus((prev) => {
                        const next = new Set(prev);
                        if (ev.target.checked) next.add(o.cardId);
                        else next.delete(o.cardId);
                        return next;
                      })
                    }
                  />
                  {o.name}
                  {o.count !== undefined && <span className="suggest-focus__count"> ×{o.count}</span>}
                </label>
              ))}
            </div>
          </fieldset>
        </div>
      </details>

      {chosenOpponents.length > 0 && (
        <RunCostNote
          pilotId={pilotId}
          games={estimateSuggestionGames(maxCandidates, games)}
          workerCount={sim.workerCount}
          approximate
        />
      )}

      {report && result && (
        <div className="lab-results">
          <PilotStamp pilotId={result.pilotId} />
          <p className="lab-section__intro">
            Base deck gauntlet win rate: <strong>{ciStr(report.baseGauntletWinRate)}</strong>
          </p>

          {report.suggestions.length === 0 ? (
            <p className="lab-placeholder">
              No candidate swaps were evaluated (none legal, all capped, or all settled by earlier
              runs). Try raising the candidate cap, or reset the saved search above.
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
                  <th>Games</th>
                  <th>Verdict</th>
                  {/* §3.179 — INCONCLUSIVE was three different answers wearing one word. */}
                  <th>Why</th>
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
                        {/* Bug report 20260918_215728 — the card names are the ONE hover
                            funnel's anchors, so the real card is a hover away here too. */}
                        <CardHover cardId={ev.swap.out} className="lab-card-name">
                          {s.outName}
                        </CardHover>{' '}
                        →{' '}
                        <CardHover cardId={ev.swap.in} className="lab-card-name">
                          {s.inName}
                        </CardHover>
                      </td>
                      <td className="lab-table__num">{pct(ev.baseWinRate.p)}</td>
                      <td className="lab-table__num">{pct(ev.variantWinRate.p)}</td>
                      <td className="lab-table__num">{signedPct(ev.delta)}</td>
                      {/* The CORRECTED p is what the verdict was decided from, so
                          it is the one shown; the raw p is a weaker claim. */}
                      <td className="lab-table__num" title={`uncorrected p = ${pValueStr(s.rawPValue)}`}>
                        {pValueStr(s.adjustedPValue)}
                      </td>
                      <td
                        className="lab-table__num"
                        title={s.elimination ? `dropped after wave ${s.elimination.wave}: ${s.elimination.detail}` : undefined}
                      >
                        {s.gamesPlayed}
                        {s.elimination ? '*' : ''}
                      </td>
                      <td>
                        <span className={`verdict-tag verdict-tag--${v.tone}`}>{v.label}</span>
                      </td>
                      <td className="trim-why" title={verdictReasonDisplay(ev.verdictReason, reasonContextOf(s, report.notes.stats)).detail}>
                        {verdictReasonDisplay(ev.verdictReason, reasonContextOf(s, report.notes.stats)).label}
                        {ev.gamesToSettle && (
                          <span className="trim-settle" title={gamesToSettleText(ev.gamesToSettle)}>
                            {' '}
                            (~{ev.gamesToSettle.additionalPairedGames.toLocaleString()} more)
                          </span>
                        )}
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
            {settledCount > 0 && <> {settledCount} settled by earlier runs.</>}
            {illegalCount > 0 && <> {illegalCount} skipped (illegal variant).</>}
            {report.waves.length > 0 && (
              <>
                {' '}
                {report.waves.length} rounds; {report.multipleComparisons.familySize} tests corrected
                by {report.multipleComparisons.method}
                {report.multipleComparisons.demotedByCorrection > 0 && (
                  <> ({report.multipleComparisons.demotedByCorrection} demoted)</>
                )}
                .
              </>
            )}
            {report.notes.historyRejected && (
              <> Saved search discarded: {report.notes.historyRejected}.</>
            )}
          </p>
          <p className="lab-throughput">
            {report.notes.totalGamesRun.toLocaleString()} games
            {report.notes.gamesAvoided > 0 && (
              <> · {report.notes.gamesAvoided.toLocaleString()} avoided by adaptive sampling</>
            )}
            {report.notes.variantGamesSkipped > 0 && (
              <> · {report.notes.variantGamesSkipped.toLocaleString()} free (card never drawn)</>
            )}
            {report.notes.gamesPerSecond !== undefined && (
              <> · {throughputText(report.notes.gamesPerSecond)}</>
            )}
            {report.notes.workersUsed !== undefined && <> · {report.notes.workersUsed} workers</>}{' '}
            · seed {seed} · pilot {result.pilotId}
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

/**
 * What earlier runs on THIS deck WITH THIS PILOT already know, the searches other
 * pilots have saved, and the button to forget this one.
 *
 * Kept a separate component so the "is this a fresh search or run four?" question
 * has one obvious answer on screen rather than being inferable from the results
 * table after the fact.
 *
 * The "other pilots" line is not decoration. Records are partitioned by pilot
 * because pooling them would invalidate the Holm–Bonferroni correction and let one
 * pilot's "settled loser" hide a card the other pilot would love — but a partition
 * the user cannot see is indistinguishable from a deletion, and a user who thinks
 * their evidence is gone will press Reset and make it true.
 */
/** How many gaps to print. Past a few it stops being a reading and becomes a list. */
const MAX_GAPS_SHOWN = 3;

/**
 * §3.137 — WHAT KIND OF DECK IS THIS, AND WHAT IS IT MISSING.
 *
 * Reported as a question: "is there any consideration to 'what kind of deck does
 * it seem to be' … 'this deck has no removal - that seems bad for this type of
 * deck'." This is the answer, and it is shown BEFORE a run rather than inside a
 * finished report, because "your deck runs no removal" is worth knowing before
 * you spend ten thousand games finding out.
 *
 * Every number comes from real decklists (the bundled field), never a
 * hand-written idea of what a deck should look like — and the sample size is
 * printed, because the same-family cohort is sometimes small enough that the
 * comparison falls back to the whole field.
 */
function DeckShapeNote({ hero }: { hero: Deck | null }): ReactElement | null {
  const reading = useMemo(() => {
    if (!hero) return null;
    try {
      const pool = loadCardPool();
      const deck = toSimPayload(hero) as SimDeck;
      const shape = shapeOf(deck, pool);
      if (shape.spells === 0) return null; // an empty deck has no shape to read
      const family = familyOf(deck, shape);
      const reference = referenceProfile(family, SAMPLE_DECKS, pool, deck.name);
      return { family, reference, gaps: findRoleGaps(shape, reference) };
    } catch {
      // A deck the pool cannot resolve is not worth an error here — the panel's
      // job is suggestions, and the legality banner already speaks for it.
      return null;
    }
  }, [hero]);

  if (!reading) return null;
  const { family, reference, gaps } = reading;
  const cohort = reference.fellBackToField
    ? `all ${reference.sampleSize} decks in the field`
    : `the ${reference.sampleSize} ${reference.family} decks in the field`;

  return (
    <div className="deck-shape-note">
      <span className="deck-shape-note__family">
        {family === 'unknown' ? 'Deck shape' : `Looks like a ${family} deck`}
      </span>{' '}
      <span className="deck-shape-note__cohort">— compared with {cohort}:</span>
      {gaps.length === 0 ? (
        <span className="deck-shape-note__ok"> nothing looks out of place.</span>
      ) : (
        <ul className="deck-shape-note__gaps">
          {gaps.slice(0, MAX_GAPS_SHOWN).map((gap) => (
            <li key={gap.role} className={`deck-shape-note__gap deck-shape-note__gap--${gap.kind}`}>
              {describeGap(gap)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function SearchMemory({
  stored,
  rejected,
  others,
  pilotId,
  disabled,
  onReset,
}: {
  stored: SuggestionHistory | null;
  rejected: string | null;
  others: readonly OtherPilotHistory[];
  pilotId: string;
  disabled: boolean;
  onReset: () => void;
}): ReactElement | null {
  const kept =
    others.length === 0 ? null : (
      <span className="lab-memory__aside">
        Kept separately:{' '}
        {others
          .map((o) => `${pilotLabel(o.pilotId)} (${o.runsCompleted} run${o.runsCompleted === 1 ? '' : 's'})`)
          .join(', ')}
        . Switch pilot to resume.
      </span>
    );

  if (rejected) {
    return (
      <p className="lab-memory lab-memory--stale">
        Starting a fresh search — {rejected}.{kept}
      </p>
    );
  }
  if (!stored || stored.runsCompleted === 0) {
    return (
      <p className="lab-memory">
        First search on this deck with the <strong>{pilotLabel(pilotId)}</strong> pilot. The next
        run will build on what this one finds instead of repeating it.
        {kept}
      </p>
    );
  }
  return (
    <p className="lab-memory">
      <strong>
        Run {stored.runsCompleted + 1} · {stored.candidates.length} candidate
        {stored.candidates.length === 1 ? '' : 's'} carried over
      </strong>{' '}
      from {stored.runsCompleted} earlier {stored.runsCompleted === 1 ? 'run' : 'runs'} with the{' '}
      {pilotLabel(pilotId)} pilot. Settled losers are skipped and the budget goes to untried swaps.
      {kept}
      <button
        type="button"
        className="btn btn--ghost lab-memory__reset"
        disabled={disabled}
        onClick={onReset}
        title={`Forget what the ${pilotLabel(pilotId)} pilot has learned about this deck. Other pilots’ searches are untouched.`}
      >
        Reset {pilotLabel(pilotId)} search
      </button>
    </p>
  );
}

/**
 * The stored record for the current hero AND pilot, re-read whenever either
 * changes — plus a summary of what the other pilots have saved for this deck.
 */
function useStoredHistory(
  hero: SimDeckPayload | null,
  pilotId: string,
): {
  stored: SuggestionHistory | null;
  rejected: string | null;
  others: readonly OtherPilotHistory[];
  refresh: () => void;
} {
  const [state, setState] = useState<{
    stored: SuggestionHistory | null;
    rejected: string | null;
    others: readonly OtherPilotHistory[];
  }>({ stored: null, rejected: null, others: [] });

  const fingerprint = hero ? JSON.stringify(hero.cards) : null;
  const refresh = useCallback(() => {
    if (!hero) {
      setState({ stored: null, rejected: null, others: [] });
      return;
    }
    const found = readSuggestionHistory(hero, pilotId);
    setState({
      stored: found.history ?? null,
      rejected: found.rejected ? historyRejectionText(found.rejected) : null,
      others: otherPilotHistories(hero, pilotId),
    });
    // `hero` is re-created on every render; its CONTENT is what matters, and the
    // fingerprint below is what actually changes when the deck does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fingerprint, pilotId]);

  useEffect(refresh, [refresh]);
  return { ...state, refresh };
}
