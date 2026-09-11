import { useEffect, type ReactElement } from 'react';
import { getCard, cardImage } from '../../lib/cards.js';
import { ManaCost } from '../ManaCost.js';
import { CardFace } from './CardFace.js';
import type { CharacteristicExplanation } from '@jonny-boi/core';

/**
 * THE CARD ZOOM — one full-size card overlay for every play surface.
 *
 * Bug report 20260825_210026: "I should be able to click on them or hover to
 * see the full card as a big overlay!" Small tiles are how a whole battlefield
 * fits on a phone, but a game of reading cards needs a way to actually READ
 * one. Every zoomable surface funnels here (hand, mulligan, battlefield, both
 * boards) so the answer to "show me this card" is one component, not four.
 *
 * ## ⚠️ IT SHOWS THE CARD'S CURRENT TRUTH, NOT ITS PRINTED SCAN (§3.143 GAP-7)
 * This overlay used to render a bare Scryfall `<img>`, so a creature the board
 * showed as 5/6 was inspected at 4/5 — two answers to one question (rule 12), on
 * the one surface a player opens specifically to read a card. It now renders
 * lane P's `CardFace`, carrying whatever `explanation` the surface it was opened
 * from carries.
 *
 * It is also the surface where UX-17.4 is genuinely reachable with a mouse: a
 * modal dialog has live pointer events, so every ability word here — printed or
 * granted — opens its glossary tooltip. (`CardHover`'s preview is deliberately
 * `pointer-events: none`, so its pops are visible but not hoverable.)
 *
 * Dismissal is deliberately promiscuous — click anywhere, Escape, the ✕ — since
 * an overlay a player struggles to close is worse than none.
 */
export function CardZoomOverlay({
  cardId,
  name,
  explanation,
  isCreature,
  unavailableReason,
  onClose,
}: {
  cardId: string;
  name: string;
  /**
   * Core's breakdown for the object being zoomed, when the surface opening the
   * zoom has one. Absent renders the plain printed card with its glossary
   * intact, which is the right answer for a card in hand or in a graveyard.
   */
  readonly explanation?: CharacteristicExplanation | undefined;
  readonly isCreature?: boolean;
  /** Why provenance is unavailable here, when the surface cannot supply it. */
  readonly unavailableReason?: string;
  onClose: () => void;
}): ReactElement {
  const card = getCard(cardId);
  const image = card ? cardImage(card, 'normal') : undefined;

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="card-zoom" role="dialog" aria-label={`${name}, full card`} onClick={onClose}>
      <div className="card-zoom__body">
        {image ? (
          <CardFace
            className="card-face--zoomed"
            size="full"
            cardId={cardId}
            name={name}
            {...(explanation !== undefined ? { explanation } : {})}
            {...(isCreature !== undefined ? { isCreature } : {})}
            {...(unavailableReason !== undefined ? { unavailableReason } : {})}
          />
        ) : (
          // No image (a token, an art-less import): a readable text face beats
          // a broken frame. Name, cost and type line are what a player needs.
          // `CardFace` would degrade to a bare name plate here, which says less.
          <div className="card-zoom__fallback">
            <div className="card-zoom__fallback-name">{name}</div>
            {card && <ManaCost cost={card.manaCost} />}
            {card?.rawTypeLine && <div className="card-zoom__fallback-type">{card.rawTypeLine}</div>}
            {card?.oracleText && <p className="card-zoom__fallback-text">{card.oracleText}</p>}
          </div>
        )}
        <button type="button" className="btn card-zoom__close" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </div>
    </div>
  );
}
