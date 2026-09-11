import type { ReactElement } from 'react';
import type { InstanceId } from '@jonny-boi/core';
import type { GraveyardCardView } from '../../lib/play/graveyard-cast.js';
import { CardHover } from '../CardHover.js';
import { PlayCard } from './PlayCard.js';

/**
 * The opened graveyard — shared verbatim by the hotseat and online boards (one
 * panel, not two). The graveyard is a PUBLIC zone, so listing its cards reveals
 * nothing; what the panel adds is the flashback AFFORDANCE: a castable card is
 * clickable with the same `PlayCard` treatment as the hand (badge, disabled
 * state, why-disabled tooltip), and clicking it routes through the SAME cast
 * chokepoint the board's hand clicks use — the panel itself decides nothing.
 *
 * ## Every card here is hoverable (§3.143 GAP-9 / UX-10)
 * "Hovering over any ability like vigilance for example, ON ANY CARD, should
 * show a tooltip explaining clearly what that ability does." The graveyard was
 * one of the surfaces with no preview at all: a `PlayCard` chip is an art crop
 * and a name. Wrapping each one in the app's single hover funnel raises the full
 * `CardFace` — printed text rendered as text, every ability word glossed —
 * without this panel gaining a card renderer of its own.
 *
 * No `explanation` is passed, and that is the honest answer rather than an
 * omission: a card in a graveyard is not on the battlefield, so nothing is
 * continuously modifying it and there is no breakdown to show.
 */
export function GraveyardPanel({
  ownerName,
  cards,
  onActivate,
  onClose,
}: {
  ownerName: string;
  cards: readonly GraveyardCardView[];
  /** Start the cast of a castable card (the board's single cast chokepoint). */
  onActivate: (id: InstanceId) => void;
  onClose: () => void;
}): ReactElement {
  return (
    <div className="graveyard-panel" role="region" aria-label={`${ownerName} graveyard`}>
      <div className="graveyard-panel__head">
        <span className="graveyard-panel__title">⚰ {ownerName}'s graveyard</span>
        <button type="button" className="btn btn--ghost" onClick={onClose}>
          Close
        </button>
      </div>
      <div className="graveyard-panel__cards">
        {cards.length === 0 && <span className="seat__empty">Empty graveyard</span>}
        {cards.map((c) => (
          <CardHover key={c.instanceId} cardId={c.cardId} name={c.name}>
            <PlayCard
              cardId={c.cardId}
              name={c.name}
              badge={c.badge}
              disabled={!c.actionable}
              reason={c.actionable ? undefined : c.reason}
              onClick={c.actionable ? () => onActivate(c.instanceId) : undefined}
            />
          </CardHover>
        ))}
      </div>
    </div>
  );
}
