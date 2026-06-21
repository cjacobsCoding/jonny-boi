import type { ReactElement } from 'react';
import type { NormalizedCard } from '@jonny-boi/data-tools';
import { displayRarity } from '../lib/cards.js';
import { CardArt } from './CardArt.js';
import { ManaCost } from './ManaCost.js';

interface CardTileProps {
  card: NormalizedCard;
  /** Open the detail view for this card. */
  onSelect: (card: NormalizedCard) => void;
  /** When provided, the tile shows an in-deck count + add/remove stepper. */
  deck?: {
    count: number;
    canAdd: boolean;
    onAdd: (card: NormalizedCard) => void;
    onRemove: (card: NormalizedCard) => void;
  };
}

/**
 * The single reusable card tile (DRY: card markup lives only here). Shows art,
 * name, mana cost as pips, type line, rarity, and P/T. Clicking the art/name
 * opens the detail view; when in deck-builder context it also renders a copy
 * count badge and an add/remove stepper.
 */
export function CardTile({ card, onSelect, deck }: CardTileProps): ReactElement {
  const pt =
    card.power !== null && card.toughness !== null ? `${card.power}/${card.toughness}` : null;

  return (
    <div className="card-tile">
      {deck && deck.count > 0 && (
        <span className="count-badge" aria-label={`${deck.count} in deck`}>
          {deck.count}
        </span>
      )}
      <button
        type="button"
        className="card-tile__art"
        onClick={() => onSelect(card)}
        aria-label={`View ${card.name}`}
        style={{ all: 'unset', cursor: 'pointer', display: 'block' }}
      >
        <CardArt card={card} size="normal" />
      </button>
      <div className="card-tile__body">
        <div className="card-tile__name-row">
          <span className="card-tile__name" title={card.name}>
            {card.name}
          </span>
          <ManaCost cost={card.manaCost} />
        </div>
        <span className="card-tile__type" title={card.rawTypeLine}>
          {card.rawTypeLine}
        </span>
        <div className="card-tile__meta">
          <span className={`rarity rarity--${card.rarity}`}>{displayRarity(card.rarity)}</span>
          {pt && <span className="pt">{pt}</span>}
        </div>
        {deck && (
          <div className="card-tile__deck-controls">
            <div className="stepper">
              <button
                type="button"
                className="stepper__btn"
                onClick={() => deck.onRemove(card)}
                disabled={deck.count === 0}
                aria-label={`Remove one ${card.name}`}
              >
                −
              </button>
              <span className="stepper__count" aria-live="polite">
                {deck.count}
              </span>
              <button
                type="button"
                className="stepper__btn"
                onClick={() => deck.onAdd(card)}
                disabled={!deck.canAdd}
                aria-label={`Add one ${card.name}`}
              >
                +
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
