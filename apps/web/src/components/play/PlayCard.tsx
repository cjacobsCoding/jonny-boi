import { useState, type ReactElement } from 'react';
import { getCard, cardImage } from '../../lib/cards.js';
import { ManaCost } from '../ManaCost.js';

/**
 * A compact, reusable card chip for the hotseat hand/stack (DRY: hand + stack +
 * target prompts all render a card the same way). Resolves Scryfall art via the
 * bundled card index (same source as `CardArt`/`PermanentTile`), degrading to a
 * labeled fallback when the instance has no pool card (e.g. a token) or art is
 * unavailable — never a broken image.
 *
 * ⚠️ PLAY-SURFACE IMAGES LOAD EAGERLY. Bug report 20260901_202314: "Some cards
 * were blank. They showed up when I hovered over them." The hand and the board
 * are never off-screen — there is nothing to defer — and `loading="lazy"` on
 * an image inside a scrolling, transformed, `:has()`-sized play surface left
 * Chrome waiting for an intersection it only re-evaluated once a hover
 * repainted the slot. Lazy loading belongs to the long grids (the Cards
 * browser, `CardArt`), not to the twenty images a player is looking at.
 * `play-surface-images.test.ts` pins this structurally. A face that fails to
 * load (offline, a Scryfall miss) shows the name rather than a broken image.
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
  // A face whose image failed to load falls back to the chip's named layout —
  // a blank rectangle is the one thing a card must never be.
  const [faceBroken, setFaceBroken] = useState(false);
  const showFull = Boolean(fullFace) && !faceBroken;
  // The name alone is useless on a card the player just tried and failed to use.
  const tooltip = reason ? `${name} — ${reason}` : name;
  const className = `play-card${showFull ? ' play-card--full' : ''}${
    selected ? ' play-card--selected' : ''
  }${disabled ? ' play-card--disabled' : ''}${onClick && !disabled ? ' play-card--actionable' : ''}`;

  const inner = showFull ? (
    <>
      {/*
        draggable={false} IS the land-play fix (bug reports 20260827_205353 +
        205443). An <img> is natively draggable, and this one fills the whole
        card — so pressing a card and moving a few pixels started a BROWSER
        image-drag: it cancels the pointer stream (our drag machine never
        commits) and swallows the mouseup (the click never fires). The reporter's
        clip shows three mousedowns on a hand card with no mouseup ever recorded.
        Synthetic-event tests cannot catch this: dispatched pointers never start
        a native drag. Belt and braces live on the hand containers (onDragStart
        preventDefault) and in CSS (user-drag: none).
      */}
      <img
        className="play-card__face"
        src={fullFace}
        alt={name}
        loading="eager"
        decoding="async"
        draggable={false}
        onError={() => setFaceBroken(true)}
      />
      {badge && <span className="play-card__badge">{badge}</span>}
    </>
  ) : (
    <>
      <div className="play-card__art">
        {art && !faceBroken ? (
          <img
            src={art}
            alt={name}
            loading="eager"
            decoding="async"
            draggable={false}
            onError={() => setFaceBroken(true)}
          />
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

/**
 * A face-down card back (the opponent's hidden hand), fanned so that a big hand
 * costs no more height than a small one. The overlap is a token rather than a
 * literal (§3.62) because the player's own hand now fans by the same rule, and
 * two hands drifting apart on the same board reads as a bug.
 */
export function CardBack({ index }: { index: number }): ReactElement {
  return (
    <div
      className="play-card play-card--back"
      aria-hidden="true"
      style={{ marginLeft: index === 0 ? 0 : 'calc(-1 * var(--play-back-overlap))' }}
    >
      <span className="play-card__back-mark">⚙</span>
    </div>
  );
}
