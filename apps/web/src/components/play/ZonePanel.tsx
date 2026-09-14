import type { ReactElement } from 'react';
import type { InstanceId } from '@jonny-boi/core';
import { ZONE_PANELS, type ZonePanelKey, type ZonePanelView } from '../../lib/play/zone-panel.js';
import { CardHover } from '../CardHover.js';
import { CardBack, PlayCard } from './PlayCard.js';

/**
 * AN OPENED ZONE — shared verbatim by the hotseat and online boards, and by the
 * graveyard and exile alike (ONE panel, not four). What the zone is called, what
 * its cast badge says and whether it can hold cards the viewer may not see are
 * all rows of {@link ZONE_PANELS}; this component only draws them.
 *
 * What the panel adds over a count chip is the cast AFFORDANCE: a castable card
 * is clickable with the same `PlayCard` treatment as the hand (badge, disabled
 * state, why-disabled tooltip), and clicking it routes through the SAME cast
 * chokepoint the board's hand clicks use — the panel itself decides nothing.
 * The engine's own offers decide what is castable; this never re-derives
 * legality.
 *
 * ## Every card here is hoverable (§3.143 GAP-9 / UX-10)
 * "Hovering over any ability like vigilance for example, ON ANY CARD, should
 * show a tooltip explaining clearly what that ability does." The graveyard and
 * exile were the two surfaces with no preview at all: a `PlayCard` chip is an
 * art crop and a name. Wrapping each one in the app's single hover funnel
 * raises the full `CardFace` — printed text rendered as text, every ability
 * word glossed — without this panel gaining a card renderer of its own.
 *
 * No `explanation` is passed, and that is the honest answer rather than an
 * omission: a card in a graveyard or in exile is not on the battlefield, so
 * nothing is continuously modifying it and there is no breakdown to show.
 *
 * ## The face-down half
 * Exile is NOT a fully public zone (CR 702.143a — a foretold card is exiled
 * face down and only its owner may look at it). A withheld card reaches this
 * component as a {@link ZonePanelView.hidden} entry carrying a LABEL and
 * nothing else: no name, no card id, no art, no title. There is no identifying
 * data here to leak, because the masking happened in the view model upstream —
 * a component that receives the name and chooses not to render it is a
 * convention, and this has to be a guarantee.
 */
export function ZonePanel({
  zone,
  ownerName,
  view,
  onActivate,
  onClose,
}: {
  zone: ZonePanelKey;
  ownerName: string;
  view: ZonePanelView;
  /** Start the cast of a castable card (the board's single cast chokepoint). */
  onActivate: (id: InstanceId) => void;
  onClose: () => void;
}): ReactElement {
  const spec = ZONE_PANELS[zone];
  const empty = view.cards.length === 0 && view.hidden.length === 0;
  return (
    <div className="zone-panel" role="region" aria-label={`${ownerName} ${spec.title}`}>
      <div className="zone-panel__head">
        <span className="zone-panel__title">
          {spec.icon} {ownerName}'s {spec.title}
        </span>
        <button type="button" className="btn btn--ghost" onClick={onClose}>
          Close
        </button>
      </div>
      <div className="zone-panel__cards">
        {empty && <span className="seat__empty">{spec.emptyText}</span>}
        {view.cards.map((c) => (
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
        {/* Backs, NOT wrapped in the hover funnel: there is nothing to magnify
            and a hover that opens on nothing is worse than no hover at all
            (`card-hover-adoption.test.ts` records the same rule for the
            opponent's hand). `index={0}` on every one is deliberate — the
            hand's fan overlaps its backs to save height, and a zone list wants
            them side by side so the count can be read. */}
        {view.hidden.map((h) => (
          <CardBack key={h.key} index={0} label={h.label} />
        ))}
      </div>
    </div>
  );
}
