import type { ReactElement } from 'react';
import { getCard, cardImage } from '../../lib/cards.js';
import { ManaCost } from '../ManaCost.js';

/**
 * A compact, reusable card chip for the hotseat hand/stack (DRY: hand + stack +
 * target prompts all render a card the same way). Resolves Scryfall art via the
 * bundled card index (same source as `CardArt`/`PermanentTile`), degrading to a
 * labeled fallback when the instance has no pool card (e.g. a token) or art is
 * unavailable — never a broken image.
 */
export function PlayCard({
  cardId,
  name,
  selected,
  disabled,
  badge,
  reason,
  face = 'chip',
  onClick,
}: {
  cardId: string;
  name: string;
  selected?: boolean;
  disabled?: boolean;
  /** Small corner annotation (e.g. "Land", "instant"). */
  badge?: string;
  /**
   * How much of the card to show. `'chip'` is the compact art-crop tile (stack,
   * prompts, battlefield contexts). `'full'` renders the ENTIRE card image —
   * the fix for bug report 20260825_205937 ("Cut off card title - not ok!!!"):
   * a 96px chip squeezed "Angel of Serenity" plus three pips into one row, and
   * no ellipsis rule can win that fight. The printed card already carries its
   * own name and cost, so the full face has nothing left to truncate.
   */
  face?: 'chip' | 'full';
  /**
   * Why this card can't be used right now. Shown as the tooltip instead of the bare
   * name, so a greyed card explains itself rather than looking like a dead control.
   */
  reason?: string;
  onClick?: () => void;
}): ReactElement {
  const card = getCard(cardId);
  const fullFace = face === 'full' ? (card ? cardImage(card, 'normal') : undefined) : undefined;
  const art = card ? cardImage(card, 'art_crop') : undefined;
  // The name alone is useless on a card the player just tried and failed to use.
  const tooltip = reason ? `${name} — ${reason}` : name;
  const className = `play-card${face === 'full' && fullFace ? ' play-card--full' : ''}${
    selected ? ' play-card--selected' : ''
  }${disabled ? ' play-card--disabled' : ''}${onClick && !disabled ? ' play-card--actionable' : ''}`;

  const inner = fullFace ? (
    <>
      <img className="play-card__face" src={fullFace} alt={name} loading="lazy" decoding="async" />
      {badge && <span className="play-card__badge">{badge}</span>}
    </>
  ) : (
    <>
      <div className="play-card__art">
        {art ? (
          <img src={art} alt={name} loading="lazy" decoding="async" />
        ) : (
          <span className="play-card__fallback">{name}</span>
        )}
        {badge && <span className="play-card__badge">{badge}</span>}
      </div>
      <div className="play-card__foot">
        <span className="play-card__name" title={name}>
          {name}
        </span>
        {card && <ManaCost cost={card.manaCost} />}
      </div>
    </>
  );

  if (onClick) {
    return (
      <button type="button" className={className} onClick={onClick} disabled={disabled} title={tooltip}>
        {inner}
      </button>
    );
  }
  return (
    <div className={className} title={tooltip} aria-label={tooltip}>
      {inner}
    </div>
  );
}

/** A face-down card back (the opponent's hidden hand). */
export function CardBack({ index }: { index: number }): ReactElement {
  return (
    <div className="play-card play-card--back" aria-hidden="true" style={{ marginLeft: index === 0 ? 0 : '-2.2rem' }}>
      <span className="play-card__back-mark">⚙</span>
    </div>
  );
}
