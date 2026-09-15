/**
 * A CHOICE THE GAME SETTLED WITHOUT ASKING, ANNOUNCED.
 *
 * Caleb, on Banisher Priest exiling the only legal creature with no prompt:
 * *"it should show that choice being made so the player understands what has
 * happened."*
 *
 * ⚠️ IT ANNOUNCES; IT DOES NOT ASK. There is no confirm button and nothing waits
 * on the player — a confirmation on every single-target spell would be worse
 * than the bug. `role="status"` carries that promise, and the reason it must NOT
 * become `role="dialog"` is written on `SpellHoldCard` and `CombatHoldBanner`:
 * `verify-game-resume.mjs` reads `[role="dialog"]` to decide whether the game
 * parked a QUESTION, and a timed announcement wearing that role once cost a
 * green harness.
 *
 * ## What it shows, and where each word comes from
 *
 * Nothing here is written in this file. The VERB is the kind row's, the WHY is
 * the engine's own `reason` string, the NAME is the engine's `sourceName`, and
 * the chosen cards are drawn by {@link CardReferenceList} — the same component
 * the stack panel and the opponent-spell hold mount, so "here is a card this is
 * pointing at" looks like itself everywhere (rule 3).
 *
 * ## ITS OWN MODULE, because BOTH boards mount it
 *
 * The lesson `CombatHoldBanner` records: a component living inside
 * `PlayBoard.tsx` is a component the online board does not get (§3.143 GAP-20).
 */
import type { ReactElement } from 'react';
import type { StackTargetView } from '../../lib/play/stack-view.js';
import type { ForcedChoice } from '../../lib/play/forced-choice.js';
import { CardReferenceList } from './CardReferences.js';
import './board-scene.css';

export function ForcedChoiceBanner({
  forced,
  chosen,
  onDismiss,
}: {
  readonly forced: ForcedChoice;
  /**
   * The chosen game objects, already resolved by the mounting board through
   * `stack-view.targetView` — the one funnel for seat-vs-permanent. Empty when
   * the answer named no game object (a number, a mode, a lawful "none"), in
   * which case `forced.words` is the whole of what was chosen.
   */
  readonly chosen: readonly StackTargetView[];
  onDismiss?: () => void;
}): ReactElement {
  return (
    <div
      className={`forced-choice forced-choice--${forced.kind}`}
      role="status"
      aria-live="polite"
      /* The whole sentence, once, for a screen reader — the visual split into a
         headline and a card face is a layout decision, not two announcements. */
      aria-label={`${forced.sourceName} ${forced.verb} ${forced.words.join(', ')}. ${forced.why}.`}
    >
      <div className="forced-choice__head">
        <span className="forced-choice__source">{forced.sourceName}</span>
        <span className="forced-choice__verb">{forced.verb}</span>
        {/* The words are the fallback AND the belt-and-braces: a card that could
            not be drawn (a token, a Scryfall miss) is still NAMED here, so the
            announcement never degrades to an anonymous rectangle. */}
        <span className="forced-choice__words">{forced.words.join(', ')}</span>
      </div>
      <CardReferenceList targets={chosen} presentation="face" className="forced-choice__refs" />
      <div className="forced-choice__foot">
        {/* The engine's own words for WHY it did not ask. Quoting them rather
            than re-writing them is what keeps the explanation true when the
            engine's rule changes. */}
        <span className="forced-choice__why">{forced.why} — you were not asked</span>
        <button type="button" className="btn btn--ghost forced-choice__skip" onClick={onDismiss}>
          Got it
        </button>
      </div>
    </div>
  );
}
