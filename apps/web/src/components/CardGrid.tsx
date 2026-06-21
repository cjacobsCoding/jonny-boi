import type { ReactElement } from 'react';
import type { NormalizedCard } from '@jonny-boi/data-tools';
import { CardTile } from './CardTile.js';

interface CardGridProps {
  cards: readonly NormalizedCard[];
  onSelect: (card: NormalizedCard) => void;
  /** Optional per-card deck-control factory (deck-builder context). */
  deckControls?: (card: NormalizedCard) => {
    count: number;
    canAdd: boolean;
    onAdd: (card: NormalizedCard) => void;
    onRemove: (card: NormalizedCard) => void;
  };
}

/**
 * Responsive grid of {@link CardTile}s with a friendly empty state when no card
 * matches the active query (DESIGN.md §6).
 */
export function CardGrid({ cards, onSelect, deckControls }: CardGridProps): ReactElement {
  if (cards.length === 0) {
    return (
      <div className="empty-state">
        <div className="empty-state__title">No cards match.</div>
        <p>Try clearing the search or loosening the color and type filters.</p>
      </div>
    );
  }
  return (
    <div className="card-grid">
      {cards.map((card) => (
        <CardTile
          key={card.id}
          card={card}
          onSelect={onSelect}
          deck={deckControls ? deckControls(card) : undefined}
        />
      ))}
    </div>
  );
}
