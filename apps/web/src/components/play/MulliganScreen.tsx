import { useState, type ReactElement } from 'react';
import type { InstanceId, PlayerId } from '@jonny-boi/core';
import type { VisibleHandCard } from '../../lib/play/view-model.js';
import { PlayCard } from './PlayCard.js';
import { CardZoomOverlay } from './CardZoomOverlay.js';

/**
 * The London mulligan decision for one player. They see their drawn hand (face-up —
 * this screen is reached only after a handoff confirms the right player is looking)
 * and choose Keep or Mulligan. When they keep after M mulligans, they must bottom M
 * cards: the screen switches to a "pick cards to put on the bottom" selection. Kept
 * deliberately simple but complete, per the brief.
 */
export function MulliganScreen({
  seat,
  name,
  hand,
  mulligansTaken,
  maxMulligans,
  onKeep,
  onMulligan,
}: {
  seat: PlayerId;
  name: string;
  hand: readonly VisibleHandCard[];
  mulligansTaken: number;
  maxMulligans: number;
  /** Keep this hand, bottoming the chosen cards (length must equal mulligansTaken). */
  onKeep: (bottomed: readonly InstanceId[]) => void;
  /** Mulligan again (reshuffle + redraw a full hand). */
  onMulligan: () => void;
}): ReactElement {
  const mustBottom = mulligansTaken; // London: bottom one card per mulligan taken
  const [deciding, setDeciding] = useState<'choose' | 'bottom'>(mustBottom > 0 ? 'choose' : 'choose');
  const [selected, setSelected] = useState<Set<InstanceId>>(new Set());
  /** The card being inspected full-size, if any (report 20260825_210026). */
  const [zoomed, setZoomed] = useState<VisibleHandCard | null>(null);

  const toggle = (id: InstanceId): void => {
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else if (next.size < mustBottom) next.add(id);
      return next;
    });
  };

  const canMulligan = mulligansTaken < maxMulligans;

  // When the player commits to keep but owes bottomed cards, enter bottom-selection.
  const beginKeep = (): void => {
    if (mustBottom === 0) {
      onKeep([]);
      return;
    }
    setDeciding('bottom');
  };

  return (
    <div className="mulligan">
      <h2 className="mulligan__title">{name}, keep this hand?</h2>
      <p className="mulligan__sub">
        {mulligansTaken === 0
          ? 'Your opening hand. Keep it, or mulligan for a fresh seven.'
          : `Mulligan ${mulligansTaken}. ${
              deciding === 'bottom'
                ? `Choose ${mustBottom} card${mustBottom === 1 ? '' : 's'} to put on the bottom (${selected.size}/${mustBottom}).`
                : `If you keep, you'll bottom ${mustBottom} card${mustBottom === 1 ? '' : 's'}.`
            }`}
      </p>

      <div className="mulligan__hand" onDragStart={(e) => e.preventDefault()}>
        {hand.map((c) => (
          // Full faces: the opening hand is exactly where a player reads cards
          // (report 20260825_205937), and each slot carries its own zoom.
          <div
            key={c.instanceId}
            className="hand-card-slot"
            onContextMenu={(e) => {
              e.preventDefault();
              setZoomed(c);
            }}
          >
            <PlayCard
              cardId={c.cardId}
              name={c.name}
              face="full"
              badge={c.isLand ? 'Land' : undefined}
              selected={selected.has(c.instanceId)}
              onClick={deciding === 'bottom' ? () => toggle(c.instanceId) : undefined}
            />
            <button
              type="button"
              className="hand-card-slot__zoom"
              aria-label={`Inspect ${c.name}`}
              title={`Inspect ${c.name}`}
              onClick={() => setZoomed(c)}
            >
              🔍
            </button>
          </div>
        ))}
      </div>
      {zoomed && (
        <CardZoomOverlay cardId={zoomed.cardId} name={zoomed.name} onClose={() => setZoomed(null)} />
      )}

      <div className="mulligan__actions">
        {deciding === 'choose' ? (
          <>
            <button type="button" className="btn btn--primary" onClick={beginKeep}>
              Keep ({hand.length - mustBottom} card{hand.length - mustBottom === 1 ? '' : 's'})
            </button>
            <button type="button" className="btn" onClick={onMulligan} disabled={!canMulligan}>
              {canMulligan ? 'Mulligan' : 'No mulligans left'}
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className="btn btn--primary"
              disabled={selected.size !== mustBottom}
              onClick={() => onKeep([...selected])}
            >
              Confirm bottom {mustBottom}
            </button>
            <button type="button" className="btn btn--ghost" onClick={() => setDeciding('choose')}>
              Back
            </button>
          </>
        )}
      </div>
      <p className="mulligan__seat-hint">Seat {seat}</p>
    </div>
  );
}
