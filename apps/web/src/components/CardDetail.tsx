import { useEffect, type ReactElement } from 'react';
import type { NormalizedCard } from '@jonny-boi/data-tools';
import { cardImage, displayRarity } from '../lib/cards.js';
import { ManaCost } from './ManaCost.js';

interface CardDetailProps {
  card: NormalizedCard;
  onClose: () => void;
}

/**
 * The single reusable card detail view (DRY). Renders a large card image plus
 * full data: mana cost, type line, oracle text, P/T, colors, keywords, set, and
 * rarity. Shown as a modal; closes on overlay click or the Escape key.
 */
export function CardDetail({ card, onClose }: CardDetailProps): ReactElement {
  // Escape-to-close + restore focus discipline keeps the modal keyboard-friendly.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const imageUrl = cardImage(card, 'large');
  const pt =
    card.power !== null && card.toughness !== null ? `${card.power}/${card.toughness}` : null;

  return (
    <div className="modal-overlay" onClick={onClose} role="presentation">
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={card.name}
        onClick={(event) => event.stopPropagation()}
        style={{ position: 'relative' }}
      >
        <button type="button" className="modal__close" onClick={onClose} aria-label="Close">
          ✕
        </button>
        <div className="modal__art">
          {imageUrl ? (
            <img src={imageUrl} alt={card.name} />
          ) : (
            <div className="card-fallback">
              <span className="card-fallback__name">{card.name}</span>
              <span>{card.rawTypeLine}</span>
            </div>
          )}
        </div>
        <div className="modal__body">
          <div className="card-tile__name-row">
            <h2 className="modal__title">{card.name}</h2>
            <ManaCost cost={card.manaCost} />
          </div>
          <div className="modal__type">{card.rawTypeLine}</div>

          {card.oracleText && <p className="oracle-text">{card.oracleText}</p>}

          {card.keywords.length > 0 && (
            <div className="keyword-tags">
              {card.keywords.map((keyword) => (
                <span key={keyword} className="tag">
                  {keyword}
                </span>
              ))}
            </div>
          )}

          <dl className="data-grid">
            <dt>Mana value</dt>
            <dd>{card.cmc}</dd>
            {pt && (
              <>
                <dt>Power / Toughness</dt>
                <dd>{pt}</dd>
              </>
            )}
            <dt>Colors</dt>
            <dd>{card.colors.length > 0 ? card.colors.join(' / ') : 'Colorless'}</dd>
            <dt>Rarity</dt>
            <dd className={`rarity rarity--${card.rarity}`}>{displayRarity(card.rarity)}</dd>
            <dt>Set</dt>
            <dd>
              {card.set.toUpperCase()} · #{card.collectorNumber}
            </dd>
          </dl>
        </div>
      </div>
    </div>
  );
}
