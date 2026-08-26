import { useLayoutEffect, type ReactElement } from 'react';
import { CardBack } from './PlayCard.js';

/**
 * The mulligan step AS SEEN WHILE THE COMPUTER DECIDES — card backs, nothing else.
 *
 * This exists because the human `MulliganScreen` rendered the computer's seven
 * face-up for the auto-keep delay (bug report 20260825_210108, "a flash of my
 * opponents hand"). The guarantee is STRUCTURAL: these props carry a hand
 * COUNT, not a hand, so no future reordering of effects can leak card
 * identities through this screen — the data is simply not here to leak.
 */
export function AiMulliganScreen({
  name,
  handCount,
}: {
  name: string;
  /** How many backs to draw. Never the cards themselves — see the header. */
  handCount: number;
}): ReactElement {
  return (
    <div className="mulligan" aria-label={`${name} is deciding their opening hand`}>
      <h2 className="mulligan__title">{name} is looking at their opening hand…</h2>
      <div className="play-hand play-hand--hidden">
        {Array.from({ length: handCount }).map((_, i) => (
          <CardBack key={i} index={i} />
        ))}
      </div>
    </div>
  );
}

/**
 * Acknowledge a handoff nobody human will ever see. Rendered in place of the
 * `HandoffScreen` when the handoff is addressed to the computer's seat: fires
 * `onReady` BEFORE the browser paints (layout effect, not a timeout), so the
 * "pass the device to Computer" screen never appears even for a frame.
 */
export function AutoReady({ onReady }: { onReady: () => void }): null {
  useLayoutEffect(() => {
    onReady();
    // Deliberately no dependency array cleanup dance: this component exists for
    // exactly one render of one phase transition and is unmounted by its own
    // `onReady` changing the phase.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}
