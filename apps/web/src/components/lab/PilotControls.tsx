import type { ReactElement } from 'react';
import {
  estimateRunSeconds,
  isCostlyPilot,
  labPilots,
  pilotLabel,
  pilotProfile,
  relativeCostText,
} from '../../lib/sim/pilots.js';
import { durationText } from '../../lib/sim-format.js';
import './pilot.css';

/**
 * **The pilot controls — who plays the games, what it costs, and what played the
 * result you are looking at.**
 *
 * Three small pieces that always appear together in the same order:
 *
 *   - {@link PilotPicker} — the choice, in the config bar beside the hero and the
 *     seed, because it is the same kind of thing: part of the question.
 *   - {@link RunCostNote} — the price of that choice, next to the Run button,
 *     BEFORE the run. The hybrid pilot is ~1400× the heuristic's decision cost, so
 *     the same gauntlet is thirty seconds or most of a day depending on this one
 *     dropdown. A warning that appears after the fact is not a warning.
 *   - {@link PilotStamp} — the label on a finished result. A win rate is a
 *     measurement of a deck AS PLAYED BY a pilot; shown without one it reads as an
 *     absolute property of the deck, which it is not.
 *
 * The stamp is deliberately worded as a fact about simulation, not a caveat about
 * this app: nothing here is broken or approximate. Two pilots produce two correct
 * answers to two different questions.
 */

/** The pilot picker: a select plus the honest one-liner for the current choice. */
export function PilotPicker({
  pilotId,
  onPilot,
  disabled,
}: {
  pilotId: string;
  onPilot: (id: string) => void;
  disabled?: boolean;
}): ReactElement {
  const profile = pilotProfile(pilotId);
  const cost = relativeCostText(pilotId);
  return (
    <label className="lab-field pilot-field">
      <span className="section-label">AI pilot (both seats)</span>
      <select
        className="select"
        value={pilotId}
        onChange={(e) => onPilot(e.target.value)}
        disabled={disabled}
        aria-label="AI pilot"
      >
        {labPilots().map((option) => (
          <option key={option.id} value={option.id}>
            {option.label}
            {option.isDefault ? ' (default)' : ''}
            {relativeCostText(option.id) ? ` — ${relativeCostText(option.id)}` : ''}
          </option>
        ))}
      </select>
      <span className="pilot-field__blurb">
        {profile.blurb}
        {cost && <> {cost.charAt(0).toUpperCase() + cost.slice(1)}.</>}
      </span>
    </label>
  );
}

/**
 * The estimated wall-clock cost of the run that is about to be started.
 *
 * `games` is the run's own planned game count — each panel knows its own, and a
 * search knows only an approximation, hence `approximate`. Rendered for every
 * pilot so the baseline has a number too: "about 20 seconds" next to Heuristic is
 * what makes "about 8 hours" next to Hybrid legible as a choice rather than as an
 * alarm.
 */
export function RunCostNote({
  pilotId,
  games,
  workerCount,
  approximate = false,
}: {
  pilotId: string;
  games: number;
  workerCount: number;
  approximate?: boolean;
}): ReactElement {
  const seconds = estimateRunSeconds(games, pilotId, workerCount);
  const costly = isCostlyPilot(pilotId);
  const gamesText = `${approximate ? '~' : ''}${games.toLocaleString()} game${games === 1 ? '' : 's'}`;

  return (
    <p className={`pilot-cost${costly ? ' pilot-cost--costly' : ''}`} role="note">
      <strong>{pilotLabel(pilotId)}</strong> · {gamesText} ·{' '}
      {seconds === null ? (
        <>run time unknown — this pilot’s speed has never been measured</>
      ) : (
        <>
          estimated {durationText(seconds)} on {workerCount} worker
          {workerCount === 1 ? '' : 's'}
        </>
      )}
      {costly && seconds !== null && (
        <> — this is a long run. Leave the tab open; closing it cancels the run.</>
      )}
    </p>
  );
}

/**
 * The provenance line under a finished result. Short, factual, always present —
 * including for the default pilot, because a label that only appears when
 * something is unusual teaches the reader that its absence means "absolute".
 */
export function PilotStamp({ pilotId }: { pilotId: string }): ReactElement {
  return (
    <p className="pilot-stamp">
      Measured with the <strong>{pilotLabel(pilotId)}</strong> pilot on both seats. Win rates and
      verdicts are relative to this level of play — a stronger pilot on both sides shrinks the edge
      a deck gets from punishing weak play, so a different pilot gives different (also correct)
      numbers.
    </p>
  );
}
