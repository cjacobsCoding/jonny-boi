import { useEffect, type ReactElement } from 'react';
import { getCard, cardImage } from '../../lib/cards.js';
import { ManaCost } from '../ManaCost.js';

/**
 * THE CARD ZOOM — one full-size card overlay for every play surface.
 *
 * Bug report 20260825_210026: "I should be able to click on them or hover to
 * see the full card as a big overlay!" Small tiles are how a whole battlefield
 * fits on a phone, but a game of reading cards needs a way to actually READ
 * one. Every zoomable surface funnels here (hand, mulligan, battlefield, both
 * boards) so the answer to "show me this card" is one component, not four.
 *
 * Dismissal is deliberately promiscuous — click anywhere, Escape, the ✕ — since
 * an overlay a player struggles to close is worse than none.
 */
export function CardZoomOverlay({
  cardId,
  name,
  onClose,
}: {
  cardId: string;
  name: string;
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
          <img className="card-zoom__img" src={image} alt={name} decoding="async" />
        ) : (
          // No image (a token, an art-less import): a readable text face beats
          // a broken frame. Name, cost and type line are what a player needs.
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
