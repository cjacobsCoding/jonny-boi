import type { ReactElement } from 'react';

/**
 * The "pass the device" interstitial — the hidden-information gate. It fully covers
 * the board (no secret info rendered behind it) until the named incoming player taps
 * to confirm they're ready. Used both between turns and whenever priority passes to
 * the other human to respond, so a player never sees the opponent's hand.
 */
export function HandoffScreen({
  toName,
  context,
  onReady,
}: {
  toName: string;
  /** A short line explaining why control is passing (e.g. "to take your turn"). */
  context: string;
  onReady: () => void;
}): ReactElement {
  return (
    <div className="handoff" role="dialog" aria-modal="true" aria-label="Pass the device">
      <div className="handoff__card">
        <div className="handoff__mark" aria-hidden="true">
          🔄
        </div>
        <h2 className="handoff__title">Pass the device to {toName}</h2>
        <p className="handoff__context">{context}</p>
        <p className="handoff__warn">Everyone else: look away — hands are hidden until {toName} taps below.</p>
        <button type="button" className="btn btn--primary handoff__ready" onClick={onReady} autoFocus>
          I'm {toName} — show my game
        </button>
      </div>
    </div>
  );
}
