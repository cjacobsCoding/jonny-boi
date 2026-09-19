import { useState, type ReactElement } from 'react';
import type { InstanceId } from '@jonny-boi/core';
import { parseRepeatCount, type ComboPromptView } from '../../lib/play/combo-view.js';
import { PromptFace, type AbilityPromptFaces } from './AbilityPrompts.js';
import './combo-prompt.css';

/**
 * THE INFINITE-COMBO PROMPT (DESIGN §3.177, stage 1).
 *
 * > "it should do a pop up that highlights the infinite combo, and lets you
 * > agree to trigger it infinitely or not — it should also have options to only
 * > trigger it a specific amount of times — up to some large number limit"
 *
 * The engine found the loop the player was stepping through and opened a
 * `comboWindow`; this is that window on screen. It shows the CARDS the loop
 * runs through (their real faces, the board's own lookup), what ONE cycle
 * changes in words ("+1 life, +1 Saproling per cycle"), a number field that
 * starts at a sensible count and says the cap out loud, and three answers:
 *
 *  - **Repeat N times** — `repeatCombo`, the CR 732.4 shortcut;
 *  - **Repeat forever** — stage 2's ∞ value. Drawn now, DISABLED and labelled
 *    "coming next", so the shape of the dialog is final and the day it works
 *    nothing moves;
 *  - **Not now** — `dismissCombo`; the loop is not offered again this turn.
 *
 * The count is validated by `parseRepeatCount` and the button is disabled
 * rather than the value clamped — a wrong number is shown to the player, not
 * rounded for them — and the engine validates it again on submit.
 *
 * Presentational: it renders a {@link ComboPromptView} and reports clicks. It
 * knows nothing of sessions, so the online board can mount it against a
 * server-supplied view the day the protocol carries one.
 */
export function ComboPrompt({
  view,
  faces,
  onRepeat,
  onDismiss,
}: {
  view: ComboPromptView;
  /** The board's face lookup, exactly as the ability prompts take it. */
  faces?: AbilityPromptFaces;
  onRepeat: (times: number) => void;
  onDismiss: () => void;
}): ReactElement {
  const [text, setText] = useState(String(view.defaultTimes));
  const times = parseRepeatCount(text, view.cap);
  return (
    <div className="target-prompt combo-prompt" role="dialog" aria-label="An infinite combo was found">
      <div className="target-prompt__card combo-prompt__card">
        <div className="target-prompt__title">{COMBO_PROMPT_TITLE}</div>
        <p className="combo-prompt__lede">
          {view.cards.length === 1 ? 'This is the piece' : 'These are the pieces'} of the loop you have been
          stepping through — {view.cycleLength} actions each time round. Every time round:
        </p>
        <ul className="combo-prompt__deltas" aria-label="What one cycle changes">
          {view.changes.map((change) => (
            <li key={change} className="combo-prompt__delta">
              {change}
            </li>
          ))}
        </ul>
        <div className="combo-prompt__cards" aria-label="The cards in the loop">
          {view.cards.map((card) => (
            <ComboPiece key={card.instanceId} instanceId={card.instanceId} name={card.name} faces={faces} />
          ))}
        </div>
        <label className="combo-prompt__times">
          <span>Run it</span>
          <input
            className="combo-prompt__count"
            type="number"
            inputMode="numeric"
            min={1}
            max={view.cap}
            step={1}
            value={text}
            aria-label="How many more times to run the loop"
            aria-invalid={times === null}
            onChange={(e) => setText(e.target.value)}
          />
          <span>
            more times <span className="combo-prompt__cap">(up to {view.cap.toLocaleString()})</span>
          </span>
        </label>
        <div className="target-prompt__options combo-prompt__options">
          <button
            type="button"
            className="btn combo-prompt__repeat"
            disabled={times === null}
            onClick={() => {
              if (times !== null) onRepeat(times);
            }}
          >
            {times === null ? `Repeat (enter 1–${view.cap.toLocaleString()})` : `Repeat ${times.toLocaleString()} times`}
          </button>
          <button
            type="button"
            className="btn combo-prompt__forever"
            disabled
            aria-disabled="true"
            title={FOREVER_COMING_NEXT}
          >
            Repeat forever <span className="combo-prompt__soon">{FOREVER_COMING_NEXT}</span>
          </button>
          <button type="button" className="btn btn--ghost combo-prompt__dismiss" onClick={onDismiss}>
            Not now
          </button>
        </div>
        <p className="combo-prompt__note">
          Not now keeps the loop as it is: you can go on stepping through it by hand, and it will not be
          offered again this turn.
        </p>
      </div>
    </div>
  );
}

/** The heading — one string, so the mount test and the player read the same words. */
export const COMBO_PROMPT_TITLE = 'You have found a loop';

/** The label on the disabled ∞ option — stage 2's promise, stated rather than hidden. */
export const FOREVER_COMING_NEXT = 'coming next';

/** One piece of the loop: its face (or a named placeholder) with its name under it. */
function ComboPiece({
  instanceId,
  name,
  faces,
}: {
  instanceId: InstanceId;
  name: string;
  faces?: AbilityPromptFaces;
}): ReactElement {
  return (
    <figure className="combo-prompt__piece">
      <PromptFace target={instanceId} name={name} faces={faces} variant="candidate" />
      <figcaption className="combo-prompt__piece-name">{name}</figcaption>
    </figure>
  );
}
