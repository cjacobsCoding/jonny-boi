import type { ReactElement } from 'react';
import {
  STEP_STOPS,
  stepStopIsOn,
  type PriorityStops,
  type StepStopKey,
  type TurnSide,
} from '../../lib/play/priority-stops.js';

/** The two columns of the stops menu, named so the copy is data too. */
const SIDES: readonly { readonly side: TurnSide; readonly title: string }[] = Object.freeze([
  { side: 'mine', title: 'On your turn' },
  { side: 'theirs', title: "On the opponent's turn" },
]);

/**
 * WHERE THE GAME STOPS — the per-step stop toggles, the two stack switches and
 * the full-control override (§3.119; bug report 20260901_211359, "How do we
 * make playing with an Instant card in hand less obnoxious?").
 *
 * Rendered entirely from `STEP_STOPS`, so adding a step is a ROW in that table
 * and this component does not change. It is a settings dialog rather than a
 * strip of chips in the action bar for one measured reason: there are twenty
 * step stops, and twenty chips is the bar nobody can read — the bar carries the
 * two controls players change mid-game (the menu button and full control).
 */
export function StopsMenu({
  stops,
  onToggleStep,
  onSwitch,
  onClose,
}: {
  stops: PriorityStops;
  onToggleStep: (key: StepStopKey, on: boolean) => void;
  onSwitch: (which: 'stopOnOpponentStack' | 'stopOnOwnStack' | 'fullControl', on: boolean) => void;
  onClose: () => void;
}): ReactElement {
  return (
    <div className="stops-menu" role="dialog" aria-modal="true" aria-label="Where the game stops">
      <div className="stops-menu__card">
        <h3>Where should the game stop?</h3>
        <p className="stops-menu__intro">
          The game passes through steps where you have nothing to do. Tick a step to be given
          priority in it whenever you hold an instant-speed play. A real decision — a question, an
          attack or a block — always stops, whatever is ticked here.
        </p>
        <div className="stops-menu__cols">
          {SIDES.map(({ side, title }) => (
            <div key={side}>
              <div className="stops-menu__group-title">{title}</div>
              {STEP_STOPS.filter((row) => row.side === side).map((row) => (
                <label key={row.key} className="stops-menu__row">
                  <input
                    type="checkbox"
                    checked={stepStopIsOn(stops, row.key)}
                    onChange={(e) => onToggleStep(row.key, e.currentTarget.checked)}
                  />
                  {row.label}
                </label>
              ))}
            </div>
          ))}
        </div>
        <div className="stops-menu__switches">
          <label className="stops-menu__row">
            <input
              type="checkbox"
              checked={stops.stopOnOpponentStack}
              onChange={(e) => onSwitch('stopOnOpponentStack', e.currentTarget.checked)}
            />
            Stop when the opponent casts or activates something (so you can respond)
          </label>
          <label className="stops-menu__row">
            <input
              type="checkbox"
              checked={stops.stopOnOwnStack}
              onChange={(e) => onSwitch('stopOnOwnStack', e.currentTarget.checked)}
            />
            Stop over your OWN spells and triggers too (Strionic Resonator wants this)
          </label>
          <label className="stops-menu__row">
            <input
              type="checkbox"
              checked={stops.fullControl}
              onChange={(e) => onSwitch('fullControl', e.currentTarget.checked)}
            />
            Full control — stop in every window where you could do anything at all
          </label>
        </div>
        <div className="stops-menu__actions">
          <button type="button" className="btn btn--primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
