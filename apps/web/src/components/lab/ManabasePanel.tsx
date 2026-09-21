import { useMemo, useState, type ReactElement } from 'react';
import {
  DEFAULT_MANABASE_SWEEPS,
  DUAL_LAND_FAMILIES,
  generateManabaseVariants,
  LAND_DROP_TURNS,
  COLOUR_SCREW_FROM_TURN,
  LANDS_ON_BATTLEFIELD_TURN,
  type Deck as SimDeck,
  type DualLandFamilyId,
  type ManabaseReport,
  type ManabaseSweep,
  type ManabaseVariant,
  type ManabaseVariantResult,
  type MeanCI,
  type ProportionCI,
  type ReliabilityMetricComparison,
  type StatsConfig,
  type SwapVerdict,
  SWAP_VERDICT_REASON_BY_KEY,
} from '@jonny-boi/sim';
import { FidelityNote } from '../FidelityNote.js';
import { RunSlider } from './RunSlider.js';
import { PilotStamp, RunCostNote } from './PilotControls.js';
import {
  ciStr,
  gamesToSettleText,
  pct,
  pValueStr,
  reasonContextOf,
  signedPct,
  throughputText,
  verdictDisplay,
  verdictReasonDisplay,
} from '../../lib/sim-format.js';
import { estimateSuggestionGames } from '../../lib/sim/plan.js';
import { loadCardPool } from '../../lib/sim-pool.js';
import type { GamesConfig, PanelProps } from './panel-types.js';
import './manabase-panel.css';

/**
 * THE MANABASE EXPERIMENTS (DESIGN §3.175) — "try other manabases".
 *
 * Variants of the hero that differ ONLY in lands — a land-count sweep, a
 * colour-mix sweep, dual-land playsets from the pool — each played against the
 * base with the same paired machinery the A/B tab uses, and reported on TWO
 * axes side by side: the win rate (paired verdict, Holm-corrected over the
 * family) and the measured reliability of the draws (missed land drops, colour
 * screw, lands by turn four — read off the real games, never modelled). The two
 * are never blended; the rule that picks a recommendation is printed.
 *
 * The family is enumerated here too, before the run, so the panel can show
 * exactly which manabases will be tested and which it cannot build for this
 * deck and why — the same pure generator the worker runs, on the same settings.
 */
export function ManabasePanel({
  hero,
  heroPayload,
  heroLegal,
  chosenOpponents,
  seed,
  pilotId,
  sim,
  onApplyManabase,
  gamesConfig,
  radiusConfig,
}: PanelProps & {
  gamesConfig: GamesConfig;
  radiusConfig: GamesConfig;
  /** Apply a tested variant to the hero deck; `undefined` when the hero cannot be edited. */
  onApplyManabase?: (variant: ManabaseVariant) => void;
}): ReactElement {
  const [games, setGames] = useState(gamesConfig.default);
  const [radius, setRadius] = useState(radiusConfig.default);
  const [sweeps, setSweeps] = useState<{ count: boolean; mix: boolean; type: boolean }>({ ...DEFAULT_MANABASE_SWEEPS });
  const [families, setFamilies] = useState<ReadonlySet<DualLandFamilyId>>(() => new Set(DUAL_LAND_FAMILIES.map((f) => f.id)));
  /** Which variant of which RESULT was applied — a new run gets live buttons again. */
  const [applied, setApplied] = useState<{ readonly result: object; readonly key: string } | null>(null);

  const running = sim.status === 'running';
  const allFamilies = families.size === DUAL_LAND_FAMILIES.length;
  const familyList = useMemo(() => DUAL_LAND_FAMILIES.map((f) => f.id).filter((id) => families.has(id)), [families]);

  // The family this run WILL test — the worker enumerates the same list from the
  // same settings, so what is previewed is what is played.
  const preview = useMemo<{ sweep: ManabaseSweep | null; error: string | null }>(() => {
    if (!heroPayload) return { sweep: null, error: null };
    try {
      const sweep = generateManabaseVariants(heroPayload as SimDeck, loadCardPool(), {
        sweeps,
        countRadius: radius,
        mixRadius: radius,
        families: familyList,
      });
      return { sweep, error: null };
    } catch (err) {
      return { sweep: null, error: err instanceof Error ? err.message : String(err) };
    }
  }, [heroPayload, sweeps, radius, familyList]);

  const variantCount = preview.sweep?.variants.length ?? 0;
  const canRun = heroLegal && heroPayload !== null && chosenOpponents.length > 0 && variantCount > 0 && !running;

  const result = sim.status === 'done' && sim.result?.kind === 'manabase' ? sim.result : null;
  const report = result?.result ?? null;

  return (
    <div className="lab-section">
      <p className="lab-section__intro">
        Try other manabases. Every variant changes ONLY the lands (a land-count step also moves one
        nonland so the deck stays the same size), plays the same games as the base deck, and is
        judged twice: by win rate, and by how reliably it actually drew and cast — measured, not
        modelled. The two are shown side by side and never blended into one number.
      </p>

      {preview.error && (
        <p className="lab-alert" role="alert">
          The manabase cannot be read: {preview.error}
        </p>
      )}
      {preview.sweep && (
        <p className="manabase-base" data-testid="manabase-base">
          <strong>As built:</strong> {preview.sweep.base.description}
        </p>
      )}

      <fieldset className="manabase-sweeps" disabled={running}>
        <legend>Sweeps</legend>
        <label>
          <input type="checkbox" checked={sweeps.count} onChange={(e) => setSweeps({ ...sweeps, count: e.target.checked })} />
          Land count ±{radius} — trade the most-played basic for the cheapest nonland with room, and back
        </label>
        <label>
          <input type="checkbox" checked={sweeps.mix} onChange={(e) => setSweeps({ ...sweeps, mix: e.target.checked })} />
          Colour mix ±{radius} — shift basics from one colour to another
        </label>
        <label>
          <input type="checkbox" checked={sweeps.type} onChange={(e) => setSweeps({ ...sweeps, type: e.target.checked })} />
          Land types — a playset of each plain dual from the pool that fits the deck's colours, replacing two basics of each
        </label>
        {sweeps.type && (
          <div className="manabase-families">
            <span className="manabase-families__label">Dual families:</span>
            {DUAL_LAND_FAMILIES.map((family) => (
              <label key={family.id} className="chip-check" title={family.label}>
                <input
                  type="checkbox"
                  checked={families.has(family.id)}
                  onChange={(e) =>
                    setFamilies((prev) => {
                      const next = new Set(prev);
                      if (e.target.checked) next.add(family.id);
                      else next.delete(family.id);
                      return next;
                    })
                  }
                />
                {family.id}
              </label>
            ))}
          </div>
        )}
      </fieldset>

      <div className="lab-controls">
        <RunSlider
          label="Games per finalist"
          value={games}
          min={gamesConfig.min}
          max={gamesConfig.max}
          step={gamesConfig.step}
          disabled={running}
          onChange={setGames}
          hint="Per opponent; the ladder drops clear losers early"
        />
        <RunSlider
          label="Sweep radius"
          value={radius}
          min={radiusConfig.min}
          max={radiusConfig.max}
          step={radiusConfig.step}
          disabled={running}
          onChange={setRadius}
          hint="Steps each way for count and mix"
        />
        <button
          type="button"
          className="btn btn--primary"
          disabled={!canRun}
          onClick={() =>
            heroPayload &&
            sim.run({
              kind: 'manabase',
              hero: heroPayload,
              opponentNames: chosenOpponents,
              gamesPerVariant: games,
              seed,
              pilotId,
              sweeps,
              radius,
              ...(allFamilies ? {} : { families: familyList }),
            })
          }
        >
          Try {variantCount} manabase{variantCount === 1 ? '' : 's'}
        </button>
      </div>

      {preview.sweep && <SweepPreview sweep={preview.sweep} />}

      {chosenOpponents.length > 0 && variantCount > 0 && (
        <RunCostNote
          pilotId={pilotId}
          games={estimateSuggestionGames(variantCount, games * chosenOpponents.length)}
          workerCount={sim.workerCount}
          approximate
        />
      )}

      {report && result && (
        <div className="lab-results">
          <PilotStamp pilotId={result.pilotId} />
          <p className="lab-section__intro">
            Base deck ({report.base.landCount} lands) gauntlet win rate:{' '}
            <strong>{ciStr(report.baseGauntletWinRate)}</strong> · missed a land drop in{' '}
            <strong>{pct(report.baseReliability.missedLandDrop.p)}</strong> of games · colour-screwed in{' '}
            <strong>{pct(report.baseReliability.colourScrew.p)}</strong> · {report.baseReliability.landsOnTurn4.mean.toFixed(2)}{' '}
            lands at the start of turn {LANDS_ON_BATTLEFIELD_TURN}
          </p>

          <Recommendation report={report} />

          {report.results.length === 0 ? (
            <p className="lab-placeholder">No manabase variant was evaluated.</p>
          ) : (
            <div className="manabase-table-wrap">
              <table className="lab-table manabase-table">
                <thead>
                  <tr>
                    <th rowSpan={2}>#</th>
                    <th rowSpan={2}>Manabase</th>
                    <th rowSpan={2}>Games</th>
                    <th colSpan={4} className="manabase-table__axis">
                      Win rate (paired, corrected)
                    </th>
                    <th colSpan={3} className="manabase-table__axis">
                      Reliability (measured, base → variant)
                    </th>
                    <th rowSpan={2} aria-label="Apply this manabase" />
                  </tr>
                  <tr>
                    <th>Base → Variant</th>
                    <th>Δ</th>
                    <th>p</th>
                    <th>Verdict</th>
                    <th>
                      Missed drop
                      <span className="manabase-table__sub">
                        turns {LAND_DROP_TURNS.from}–{LAND_DROP_TURNS.to}
                      </span>
                    </th>
                    <th>
                      Colour screw
                      <span className="manabase-table__sub">turn {COLOUR_SCREW_FROM_TURN}+</span>
                    </th>
                    <th>
                      Lands
                      <span className="manabase-table__sub">start of turn {LANDS_ON_BATTLEFIELD_TURN}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {report.results.map((row) => (
                    <VariantRow
                      key={row.variant.key}
                      row={row}
                      stats={report.notes.stats}
                      recommended={report.recommended?.variant.key === row.variant.key}
                      applied={applied?.result === result && applied.key === row.variant.key}
                      onApply={
                        onApplyManabase
                          ? () => {
                              onApplyManabase(row.variant);
                              setApplied({ result, key: row.variant.key });
                            }
                          : undefined
                      }
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <p className="lab-coverage">
            Tested {report.results.length} of {report.notes.candidatesGenerated} enumerated manabases
            {report.capped.length > 0 && <> ({report.capped.length} past the cap, not played)</>}.
            {report.skipped.length > 0 && <> {report.skipped.length} could not be built for this deck.</>}
            {report.failures.length > 0 && <> {report.failures.length} failed while playing.</>}
            {report.waves.length > 0 && (
              <>
                {' '}
                {report.waves.length} round{report.waves.length === 1 ? '' : 's'};{' '}
                {report.multipleComparisons.familySize} tests corrected by {report.multipleComparisons.method}
                {report.multipleComparisons.demotedByCorrection > 0 && (
                  <> ({report.multipleComparisons.demotedByCorrection} demoted)</>
                )}
                .
              </>
            )}
          </p>
          <p className="lab-coverage manabase-not-measured" data-testid="manabase-not-measured">
            {report.notMeasured.map((m) => (
              <span key={m.id}>
                <strong>{m.label}: NOT MEASURED</strong> — {m.reason}.
              </span>
            ))}
            {' '}
            Missed drops the pilot could have made (a land in hand, none played):{' '}
            {report.baseReliability.heldLandGames} base game{report.baseReliability.heldLandGames === 1 ? '' : 's'}.
          </p>
          {(report.skipped.length > 0 || report.capped.length > 0) && (
            <details className="manabase-skipped">
              <summary>Not tested ({report.skipped.length + report.capped.length})</summary>
              <ul>
                {report.skipped.map((s, i) => (
                  <li key={`s${i}`}>
                    {s.label} — {s.reason}
                  </li>
                ))}
                {report.capped.map((v) => (
                  <li key={v.key}>{v.label} — past the cap of variants one run may test</li>
                ))}
              </ul>
            </details>
          )}
          <p className="lab-throughput">
            {report.notes.totalGamesRun.toLocaleString()} games
            {report.notes.gamesAvoided > 0 && <> · {report.notes.gamesAvoided.toLocaleString()} avoided by adaptive sampling</>}
            {report.notes.variantGamesSkipped > 0 && (
              <> · {report.notes.variantGamesSkipped.toLocaleString()} free (changed lands never drawn)</>
            )}
            {report.notes.gamesPerSecond !== undefined && <> · {throughputText(report.notes.gamesPerSecond)}</>}
            {report.notes.workersUsed !== undefined && <> · {report.notes.workersUsed} workers</>} · seed {seed} · pilot{' '}
            {result.pilotId}
          </p>
          <FidelityNote text={report.notes.fidelityCaveat} />
        </div>
      )}

      {!report && !running && (
        <p className="lab-placeholder">
          Choose the sweeps, then run. A variant is called BETTER or WORSE on win rate only when the
          paired test clears significance after correcting for the whole family; reliability is
          judged the same way on each metric, so a short run reads INCONCLUSIVE rather than guessing.
        </p>
      )}
      {hero && !onApplyManabase && (
        <p className="lab-hint">Bundled gauntlet decks are read-only — copy one in the Deck Builder to apply a manabase to it.</p>
      )}
    </div>
  );
}

/** The enumerated family, collapsed — what WILL be tested, and what cannot be. */
function SweepPreview({ sweep }: { sweep: ManabaseSweep }): ReactElement {
  return (
    <details className="manabase-preview" data-testid="manabase-preview">
      <summary>
        {sweep.variants.length} manabase{sweep.variants.length === 1 ? '' : 's'} to test
        {sweep.skipped.length > 0 && <> · {sweep.skipped.length} cannot be built for this deck</>}
      </summary>
      <ul className="manabase-preview__list">
        {sweep.variants.map((v) => (
          <li key={v.key}>
            <KindBadge kind={v.kind} /> {v.label}
            <span className="manabase-preview__note"> — {v.note}</span>
          </li>
        ))}
      </ul>
      {sweep.skipped.length > 0 && (
        <ul className="manabase-preview__list manabase-preview__list--skipped">
          {sweep.skipped.map((s, i) => (
            <li key={i}>
              <KindBadge kind={s.kind} /> {s.label}
              <span className="manabase-preview__note"> — {s.reason}</span>
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}

const KIND_LABEL: Readonly<Record<ManabaseVariant['kind'], string>> = {
  count: 'count',
  mix: 'mix',
  type: 'type',
};

function KindBadge({ kind }: { kind: ManabaseVariant['kind'] }): ReactElement {
  return <span className={`manabase-kind manabase-kind--${kind}`}>{KIND_LABEL[kind]}</span>;
}

/** The rule, stated, and what it picked. */
function Recommendation({ report }: { report: ManabaseReport }): ReactElement {
  const pick = report.recommended;
  return (
    <div className={`manabase-recommend${pick ? ' manabase-recommend--pick' : ''}`} data-testid="manabase-recommend">
      <p className="manabase-recommend__pick">
        {pick ? (
          <>
            <strong>Recommended:</strong> {pick.variant.label}{' '}
            <span className="manabase-recommend__why">
              — win rate {verdictDisplay(pick.evaluation.verdict).label.toLowerCase()} ({signedPct(pick.evaluation.delta)});
              reliability {pick.reliability.metrics.some((m) => m.verdict === 'better') ? 'better' : 'not worse'}.
            </span>
          </>
        ) : (
          <>
            <strong>No recommendation:</strong> no variant is measurably better than the base on either axis in this run.
          </>
        )}
      </p>
      <p className="manabase-recommend__rule">{report.recommendationRule}</p>
    </div>
  );
}

/** How a reliability verdict reads: it is about reliability, not wins. */
const RELIABILITY_VERDICT_LABEL: Readonly<Record<SwapVerdict, string>> = {
  better: 'more reliable',
  worse: 'less reliable',
  inconclusive: 'no difference shown',
};

function ReliabilityCell({
  metric,
  base,
  variant,
}: {
  metric: ReliabilityMetricComparison | undefined;
  base: ProportionCI | MeanCI;
  variant: ProportionCI | MeanCI;
}): ReactElement {
  const fmt = (v: ProportionCI | MeanCI): string => ('mean' in v ? v.mean.toFixed(2) : pct(v.p));
  const tone = metric ? verdictDisplay(metric.verdict).tone : 'inconclusive';
  return (
    <td className="lab-table__num manabase-table__reliability">
      <span className="manabase-table__pair">
        {fmt(base)} → <strong>{fmt(variant)}</strong>
      </span>
      {metric && (
        {/*
          §3.179 — the reliability tag keeps its own vocabulary ("more reliable"
          reads better here than "BETTER"), but the REASON is the shared one and
          rides in the hover, so "no difference shown" can no longer hide "we did
          not play enough games to see one".
        */}
        <span
          className={`verdict-tag verdict-tag--${tone} manabase-table__tag`}
          title={`paired p = ${pValueStr(metric.pValue)} over ${metric.nPaired} games — ${
            SWAP_VERDICT_REASON_BY_KEY[metric.verdictReason].label
          }`}
        >
          {RELIABILITY_VERDICT_LABEL[metric.verdict]}
          <span className="manabase-table__why"> · {SWAP_VERDICT_REASON_BY_KEY[metric.verdictReason].label}</span>
        </span>
      )}
    </td>
  );
}

function VariantRow({
  row,
  recommended,
  applied,
  onApply,
  stats,
}: {
  row: ManabaseVariantResult;
  recommended: boolean;
  applied: boolean;
  onApply: (() => void) | undefined;
  /** The bar THIS run was read at (§3.179) — never the panel's current slider. */
  stats: StatsConfig;
}): ReactElement {
  const ev = row.evaluation;
  const v = verdictDisplay(ev.verdict);
  const metric = (id: ReliabilityMetricComparison['id']) => row.reliability.metrics.find((m) => m.id === id);
  return (
    <tr className={recommended ? 'manabase-table__row--pick' : undefined} data-variant={row.variant.key}>
      <td className="lab-table__num">{row.rank}</td>
      <td>
        <KindBadge kind={row.variant.kind} /> {row.variant.label}
        <span className="manabase-table__note">{row.variant.note}</span>
      </td>
      <td className="lab-table__num" title={row.elimination ? `dropped after wave ${row.elimination.wave}: ${row.elimination.detail}` : undefined}>
        {row.gamesPlayed}
        {row.elimination ? '*' : ''}
      </td>
      <td className="lab-table__num">
        {pct(ev.baseWinRate.p)} → <strong>{pct(ev.variantWinRate.p)}</strong>
      </td>
      <td className="lab-table__num">{signedPct(ev.delta)}</td>
      <td className="lab-table__num" title={`uncorrected p = ${pValueStr(row.rawPValue)}`}>
        {pValueStr(row.adjustedPValue)}
      </td>
      <td>
        <span className={`verdict-tag verdict-tag--${v.tone}`}>{v.label}</span>
        <span className="trim-why" title={verdictReasonDisplay(ev.verdictReason, reasonContextOf(row, stats)).detail}>
          {' '}
          {verdictReasonDisplay(ev.verdictReason, reasonContextOf(row, stats)).label}
          {ev.gamesToSettle && (
            <span className="trim-settle" title={gamesToSettleText(ev.gamesToSettle)}>
              {' '}
              (~{ev.gamesToSettle.additionalPairedGames.toLocaleString()} more)
            </span>
          )}
        </span>
      </td>
      <ReliabilityCell metric={metric('missedLandDrop')} base={row.reliability.base.missedLandDrop} variant={row.reliability.variant.missedLandDrop} />
      <ReliabilityCell metric={metric('colourScrew')} base={row.reliability.base.colourScrew} variant={row.reliability.variant.colourScrew} />
      <ReliabilityCell metric={metric('landsOnTurn4')} base={row.reliability.base.landsOnTurn4} variant={row.reliability.variant.landsOnTurn4} />
      <td>
        {onApply && (
          <button
            type="button"
            className={`btn lab-table__apply ${applied ? 'btn--ghost manabase-table__apply--done' : 'btn--ghost'}`}
            disabled={applied}
            onClick={onApply}
            title={applied ? 'Your deck now runs this manabase — open Deck Builder to see it' : `Replace your deck's lands with “${row.variant.label}”`}
          >
            {applied ? '✓ Applied' : 'Apply'}
          </button>
        )}
      </td>
    </tr>
  );
}
