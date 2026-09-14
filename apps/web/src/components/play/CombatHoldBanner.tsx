/**
 * §10 — THE COMBAT BEAT, ANNOUNCED.
 *
 * Caleb: *"Animations when block phase is over and damage is being distributed
 * … so you can clearly see what's happening."* The pause is the feature; this
 * strip is only what tells you it is deliberate and how to leave it.
 *
 * ⚠️ SMALL, AND PINNED TO THE TOP. Everything it exists to reveal happens at the
 * MIDLINE between the two seats, so a centred card like `SpellHoldCard`'s would
 * cover the very advance the beat is for.
 *
 * The wording comes from the KIND table — `label` and `shows` are facts about
 * the row, and re-writing them here would be a second answer to what the pause
 * is for.
 *
 * ## ITS OWN MODULE, because BOTH boards mount it
 *
 * It began as a private function inside `PlayBoard.tsx`, which is the shape
 * §3.143 GAP-20 already cost this repo once: a component the online board could
 * not reach is a component the online board does not get. `PlayBoard` and
 * `OnlineBoard` now render this same element, so a re-wording or a restyle
 * cannot land on one board and miss the other, and
 * `online-board-parity.test.ts` compares the two boards' rendered banner
 * markup so a divergence fails rather than ships (rule 12).
 */
import type { ReactElement } from 'react';
import { COMBAT_HOLD_KINDS, type CombatHold } from '../../lib/play/combat-hold.js';
/**
 * The `.combat-hold*` rules live in the scene's stylesheet beside the rest of
 * the play surface's chrome. Imported HERE rather than left to the mounting
 * board, so the strip carries its own appearance onto any board that mounts it
 * — the online board has no `.board-scene`, and nothing else there would pull
 * this sheet in.
 */
import './board-scene.css';

export function CombatHoldBanner({
  hold,
  onSkip,
}: {
  hold: CombatHold;
  onSkip?: () => void;
}): ReactElement {
  const row = COMBAT_HOLD_KINDS[hold.kind];
  return (
    <div
      className={`combat-hold combat-hold--${hold.kind}`}
      /* `status`, NOT `dialog`, for the reason SpellHoldCard records: this
         announces and is dismissed by a timer. It promises no modality and no
         focus trap, and `verify-game-resume.mjs` reads `[role="dialog"]` to
         decide whether the game parked a QUESTION — which this never is. */
      role="status"
      aria-live="polite"
    >
      <span className="combat-hold__label">{row.label}</span>
      <span className="combat-hold__shows">{row.shows}</span>
      <button type="button" className="btn btn--ghost combat-hold__skip" onClick={onSkip}>
        Skip
      </button>
    </div>
  );
}
