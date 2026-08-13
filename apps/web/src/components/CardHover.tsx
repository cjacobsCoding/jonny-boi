import { useCallback, useState, type ReactElement, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { getCard, cardImage } from '../lib/cards.js';
import { previewPlacement, type PreviewAnchor } from './card-hover-position.js';
import './card-hover.css';

/**
 * Wraps any board element so hovering it raises a **full, readable card** beside
 * the cursor — the whole card face, not the cropped art the tiles show. Watching
 * a game is unreadable otherwise: the battlefield tiles are art crops with a
 * name, and a `title` attribute is a slow, plain-text tooltip that can't show
 * rules text at all.
 *
 * Self-contained on purpose: it owns its own hover state and portals the panel to
 * `document.body`, so a caller only wraps its children and no app-wide provider
 * or layout change is needed. The panel is `position: fixed` and clamped to the
 * viewport, so it never opens off-screen at the board's edges.
 *
 * Degrades safely: with no `cardId`, an unknown id, or a card with no image, it
 * renders the children alone and never opens an empty panel.
 */
export function CardHover({
  cardId,
  children,
  className,
}: {
  /**
   * Scryfall id of the card to preview. Accepts `null` because replay permanents
   * carry `cardId: string | null` for tokens and instances with no pool card;
   * either absence simply renders the children with no preview.
   */
  readonly cardId?: string | null;
  readonly children: ReactNode;
  readonly className?: string;
}): ReactElement {
  const [anchor, setAnchor] = useState<PreviewAnchor | undefined>(undefined);

  const card = cardId ? getCard(cardId) : undefined;
  // `large` is the readable face; `cardImage` degrades through the sizes it has.
  const image = card ? cardImage(card, 'large') : undefined;
  const previewable = Boolean(image);

  const track = useCallback(
    (event: { clientX: number; clientY: number }) => {
      if (!previewable) return;
      setAnchor({ x: event.clientX, y: event.clientY });
    },
    [previewable],
  );

  const clear = useCallback(() => setAnchor(undefined), []);

  return (
    <span
      className={className}
      onMouseEnter={track}
      onMouseMove={track}
      onMouseLeave={clear}
      // Keyboard parity: focusing a tile shows the same preview.
      onFocus={(event) => {
        if (!previewable) return;
        const box = event.currentTarget.getBoundingClientRect();
        setAnchor({ x: box.right, y: box.top });
      }}
      onBlur={clear}
    >
      {children}
      {anchor && image && card
        ? createPortal(<CardHoverPanel anchor={anchor} image={image} name={card.name} />, document.body)
        : null}
    </span>
  );
}

/**
 * The floating panel itself. Placement (including the off-screen clamping) lives
 * in the pure, unit-tested `previewPlacement`; this component only reads the live
 * viewport and paints the result.
 */
function CardHoverPanel({
  anchor,
  image,
  name,
}: {
  readonly anchor: PreviewAnchor;
  readonly image: string;
  readonly name: string;
}): ReactElement {
  const { left, top, width } = previewPlacement(anchor, {
    width: window.innerWidth,
    height: window.innerHeight,
  });

  return (
    <div
      className="card-hover-preview"
      style={{ left: `${left}px`, top: `${top}px`, width: `${width}px` }}
      role="tooltip"
      aria-label={name}
    >
      <img className="card-hover-preview__img" src={image} alt={name} decoding="async" />
    </div>
  );
}
