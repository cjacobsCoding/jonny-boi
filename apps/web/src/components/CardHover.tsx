import { useCallback, useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { getCard, cardImage } from '../lib/cards.js';
import { CardFace } from './play/CardFace.js';
import { previewPlacement, type PreviewAnchor } from './card-hover-position.js';
import { hoverShouldClose, type HoverSignal } from './card-hover-dismiss.js';
import type { CharacteristicExplanation } from '@jonny-boi/core';
import './card-hover.css';

/**
 * Wraps any board element so hovering it raises a **full, readable card** beside
 * the cursor — the whole card face, not the cropped art the tiles show. Watching
 * a game is unreadable otherwise: the battlefield tiles are art crops with a
 * name, and a `title` attribute is a slow, plain-text tooltip that can't show
 * rules text at all.
 *
 * ## ⚠️ THE PREVIEW IS A `CardFace`, NOT A PRINTED `<img>` (§3.143 GAP-7)
 * A battlefield tile under an aura prints **5/6**. Until wave 2 the thing you
 * hovered it with to read it was the bare Scryfall scan, which prints 4/5 — two
 * answers to one question, on the exact surface a player opens to check. So the
 * preview renders lane P's `CardFace` at `size="full"`, carrying the SAME
 * `explanation` the surface it was opened from is carrying. That is also what
 * makes the merged keyword line reachable ("vigilance, first strike, **flying**"):
 * a 96px tile can only show the condensed aftermarket words, and this preview is
 * where the whole line is read.
 *
 * Every card-bearing surface in the app already wraps in this component, so
 * passing `explanation` through is also what puts the glossary and the
 * aftermarket styling on the hand, the stack, the prompts and the mulligan
 * without a sixth card renderer (scope §2.4).
 *
 * ⚠️ The panel stays `pointer-events: none` — it must never steal the hover that
 * opened it — so the glossary pops INSIDE the preview are visible-but-not
 * hoverable. The surfaces where a pop is genuinely reachable with a mouse are
 * the ones mounted in the page: the battlefield tile and `CardZoomOverlay`.
 *
 * Self-contained on purpose: it owns its own hover state and portals the panel to
 * `document.body`, so a caller only wraps its children and no app-wide provider
 * or layout change is needed. The panel is `position: fixed` and clamped to the
 * viewport, so it never opens off-screen at the board's edges.
 *
 * Degrades safely: with no `cardId`, an unknown id, or a card with no image, it
 * renders the children alone and never opens an empty panel.
 *
 * ⚠️ DISMISSAL IS NOT LEFT TO `mouseleave` ALONE. Bug report 20260901_205453
 * ("A forest got stuck on my screen — it's even over the debug overlay"): a
 * preview opened over a land tile and never closed, because the pointer left
 * the tile through a path that fires no `mouseleave` — a drag with pointer
 * capture in flight, a modal prompt appearing over the tile, the tile being
 * re-rendered under a still pointer. So while a preview is open the component
 * ALSO listens document-wide and closes on any signal that means "the cursor
 * is no longer over the anchor": a move whose target is outside the anchor, a
 * press anywhere, a scroll, a wheel, Escape, the window losing focus. The rule
 * for which signals close is the pure, tested `hoverShouldClose`.
 */
export function CardHover({
  cardId,
  explanation,
  name,
  isCreature,
  unavailableReason,
  children,
  className,
}: {
  /**
   * Scryfall id of the card to preview. Accepts `null` because replay permanents
   * carry `cardId: string | null` for tokens and instances with no pool card;
   * either absence simply renders the children with no preview.
   */
  readonly cardId?: string | null;
  /**
   * Core's characteristic breakdown for the object being hovered, when the
   * surface has one (`BoardPermanent.explanation`). Absent is a real answer — a
   * card in hand or on the stack is not on the battlefield and nothing is
   * modifying it — and renders the plain printed card with its glossary intact.
   */
  readonly explanation?: CharacteristicExplanation | undefined;
  /** Display name, for the token/no-pool-card case. Defaults to the pool card's. */
  readonly name?: string;
  /** Whether to draw a P/T box; the caller knows the type line, core does not. */
  readonly isCreature?: boolean;
  /** Why there is no provenance here, when the surface genuinely cannot supply it. */
  readonly unavailableReason?: string;
  readonly children: ReactNode;
  readonly className?: string;
}): ReactElement {
  const [anchor, setAnchor] = useState<PreviewAnchor | undefined>(undefined);
  const anchorEl = useRef<HTMLSpanElement>(null);

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

  // The document-wide safety net, installed ONLY while a preview is open so an
  // idle board pays nothing for it.
  useEffect(() => {
    if (!anchor) return undefined;
    const closeIf = (signal: HoverSignal) => (event: Event): void => {
      const inside = event.target instanceof Node && (anchorEl.current?.contains(event.target) ?? false);
      if (hoverShouldClose(signal, inside)) clear();
    };
    const onMove = closeIf('move');
    const onDown = closeIf('press');
    const onScroll = closeIf('scroll');
    const onKey = (event: KeyboardEvent): void => {
      if (hoverShouldClose(event.key === 'Escape' ? 'escape' : 'otherKey', false)) clear();
    };
    const onBlur = (): void => {
      if (hoverShouldClose('blur', false)) clear();
    };
    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('scroll', onScroll, true);
    document.addEventListener('wheel', onScroll, { capture: true, passive: true });
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', onBlur);
    return () => {
      document.removeEventListener('mousemove', onMove, true);
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('scroll', onScroll, true);
      document.removeEventListener('wheel', onScroll, true);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('blur', onBlur);
    };
  }, [anchor, clear]);

  return (
    <span
      ref={anchorEl}
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
        ? createPortal(
            <CardHoverPanel
              anchor={anchor}
              cardId={card.id}
              name={name ?? card.name}
              {...(explanation !== undefined ? { explanation } : {})}
              {...(isCreature !== undefined ? { isCreature } : {})}
              {...(unavailableReason !== undefined ? { unavailableReason } : {})}
            />,
            document.body,
          )
        : null}
    </span>
  );
}

/**
 * The floating panel itself. Placement (including the off-screen clamping) lives
 * in the pure, unit-tested `previewPlacement`; this component only reads the live
 * viewport and paints the result.
 *
 * The card inside it is `CardFace` — see the module header. The panel keeps the
 * sizing and the clamping; the face keeps every decision about what the card
 * currently SAYS, so there is one card renderer and not two (scope §2.4).
 */
function CardHoverPanel({
  anchor,
  cardId,
  name,
  explanation,
  isCreature,
  unavailableReason,
}: {
  readonly anchor: PreviewAnchor;
  readonly cardId: string;
  readonly name: string;
  readonly explanation?: CharacteristicExplanation | undefined;
  readonly isCreature?: boolean;
  readonly unavailableReason?: string;
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
      <CardFace
        className="card-hover-preview__face"
        size="full"
        cardId={cardId}
        name={name}
        {...(explanation !== undefined ? { explanation } : {})}
        {...(isCreature !== undefined ? { isCreature } : {})}
        {...(unavailableReason !== undefined ? { unavailableReason } : {})}
      />
    </div>
  );
}
