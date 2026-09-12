import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from 'react';
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
 * ## ⚠️ THE PANEL IS POINTER-INTERACTIVE NOW, AND THE BRIDGE IS WHY IT CAN BE
 * (§3.143 wave 3 / GAP-E). Waves 1 and 2 left this panel `pointer-events: none`
 * with the note "so the glossary pops inside the preview are visible-but-not
 * hoverable". That note understated it to the point of being wrong: opening a
 * pop is a JS `onMouseEnter` on a `PopTrigger` span, and a span inside a
 * pointer-transparent panel receives no `mouseenter` at all — so the pops in
 * here could never open, not merely be awkward. And the preview is the ONLY
 * surface that shows a battlefield permanent's PRINTED rules text: the tile
 * renders `rules: 'aftermarketOnly'`, and `CardZoomOverlay` is reachable from
 * the graveyard/exile lists and a peeked prisoner, never from a creature in
 * play. Net result: "hovering over any ability like vigilance … on any card"
 * was unreachable on the battlefield, which is the surface it matters on.
 *
 * The reason for `pointer-events: none` was real, though, and it is the thing
 * that has to be solved rather than deleted: the panel is portaled to `<body>`
 * and floats OVER the board, so the moment it accepts the pointer it also
 * intercepts the `mousemove` stream that keeps it open. Turning it on alone
 * makes the preview flicker — the pointer leaves the anchor, the document-wide
 * net sees a move "outside the anchor", the panel closes, the pointer is back
 * over the anchor, the panel re-opens.
 *
 * So the anchor is no longer the whole hover region. The region is the anchor,
 * the panel, and the CORRIDOR between them (the panel is placed a
 * `CARD_PREVIEW_CURSOR_GAP_PX` gap away from the cursor, and crossing that gap
 * must not count as leaving) — the pure, tested `hoverRegionContains`. Outside
 * that region every existing dismissal rule applies unchanged, so the
 * stuck-preview net below is intact: any move that is genuinely elsewhere still
 * closes the panel on the next mouse event.
 *
 * The cost, stated plainly: while a preview is open the panel shields the board
 * beneath it, so a press aimed at a tile under the panel dismisses the preview
 * instead of hitting the tile, and the second press lands. That is the trade the
 * pointer-transparent version was buying, and it buys back a feature that could
 * not be used at all. (A pointer-transparent panel would ALSO let the tiles it
 * covers open previews of their own while this one stayed open under the
 * corridor rule — two stacked previews, which is worse than one extra click.)
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
/* -------------------------------------------------------------------------- */
/* The hover REGION — pure, so the one part with real logic is testable in Node */
/* -------------------------------------------------------------------------- */

/**
 * An axis-aligned box in viewport pixels. Structurally a `DOMRect`, so a caller
 * passes one straight from `getBoundingClientRect()` with no conversion.
 */
export interface HoverBox {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/** A point in viewport pixels (the cursor). */
export interface HoverPoint {
  readonly x: number;
  readonly y: number;
}

function boxHasArea(box: HoverBox): boolean {
  return box.right > box.left && box.bottom > box.top;
}

function boxContains(box: HoverBox, point: HoverPoint): boolean {
  return point.x >= box.left && point.x <= box.right && point.y >= box.top && point.y <= box.bottom;
}

/**
 * Is the cursor still somewhere that means "this preview is being used"?
 *
 * Three places count, and the third is the whole point (see the module header):
 *
 *  1. the ANCHOR — the tile/card the preview was opened from;
 *  2. the PANEL — the preview itself, now that it accepts the pointer, because
 *     that is where the glossary triggers live;
 *  3. the CORRIDOR between them — `previewPlacement` deliberately leaves a
 *     `CARD_PREVIEW_CURSOR_GAP_PX` gap so the panel never sits under the cursor,
 *     and a player reaching for a keyword crosses that gap over bare board. A
 *     move in the gap must not read as "the pointer went somewhere else".
 *
 * The corridor is the horizontal band BETWEEN the two boxes (empty when they
 * already overlap horizontally), spanning their combined vertical extent so a
 * diagonal reach toward the panel's top or bottom still counts. It is only as
 * wide as the gap itself — a couple of dozen pixels — which is why widening the
 * region this way does not turn into "the preview never closes": everything
 * outside those few pixels behaves exactly as it did before.
 *
 * A collapsed box (an anchor that measured nothing, a panel not yet laid out)
 * contributes NOTHING rather than a degenerate strip at x=0 — the honest answer
 * for "I could not measure this" is "the pointer is not in it".
 */
export function hoverRegionContains(
  point: HoverPoint,
  anchor: HoverBox | undefined,
  panel: HoverBox | undefined,
): boolean {
  const liveAnchor = anchor !== undefined && boxHasArea(anchor) ? anchor : undefined;
  const livePanel = panel !== undefined && boxHasArea(panel) ? panel : undefined;
  if (liveAnchor !== undefined && boxContains(liveAnchor, point)) return true;
  if (livePanel !== undefined && boxContains(livePanel, point)) return true;
  if (liveAnchor === undefined || livePanel === undefined) return false;

  // Orientation-agnostic: `previewPlacement` flips the panel to the anchor's
  // LEFT near the viewport's right edge, and the same two expressions describe
  // the gap either way.
  const gapStart = Math.min(liveAnchor.right, livePanel.right);
  const gapEnd = Math.max(liveAnchor.left, livePanel.left);
  if (gapEnd <= gapStart) return false; // horizontally overlapping: no gap to cross
  const bandTop = Math.min(liveAnchor.top, livePanel.top);
  const bandBottom = Math.max(liveAnchor.bottom, livePanel.bottom);
  return point.x >= gapStart && point.x <= gapEnd && point.y >= bandTop && point.y <= bandBottom;
}

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
  // The panel's LIVE box, measured rather than recomputed: `previewPlacement`
  // already decided where it goes, and asking the element itself means there is
  // one answer to "where is the panel" instead of two that can drift (rule 12).
  const panelEl = useRef<HTMLDivElement>(null);

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

  /**
   * Is this pointer position still inside the anchor/panel/corridor region?
   *
   * ONE reader of `hoverRegionContains`, used by both the document-wide net and
   * the anchor's own `mouseleave`, so the two cannot disagree about where the
   * preview lives (rule 12).
   */
  const inRegion = useCallback((point: HoverPoint): boolean => {
    return hoverRegionContains(
      point,
      anchorEl.current?.getBoundingClientRect(),
      panelEl.current?.getBoundingClientRect(),
    );
  }, []);

  // The document-wide safety net, installed ONLY while a preview is open so an
  // idle board pays nothing for it.
  useEffect(() => {
    if (!anchor) return undefined;
    const closeIf = (signal: HoverSignal) => (event: Event): void => {
      // "Inside" now means inside the whole hover REGION, not just the anchor —
      // see the module header. Two readings, because neither alone is enough:
      // DOM containment catches a glossary trigger inside the panel however the
      // panel happens to be laid out, and the GEOMETRIC region catches the
      // corridor (bare board, so the target is the board) and any child that
      // opts out of pointer events, such as a closed `.card-face__pop`.
      const node = event.target instanceof Node ? event.target : null;
      const containedBy =
        node !== null &&
        ((anchorEl.current?.contains(node) ?? false) || (panelEl.current?.contains(node) ?? false));
      const inside =
        containedBy ||
        (isPointerish(event) ? inRegion({ x: event.clientX, y: event.clientY }) : false);
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
  }, [anchor, clear, inRegion]);

  return (
    <span
      ref={anchorEl}
      className={className}
      onMouseEnter={track}
      onMouseMove={track}
      // NOT a bare `clear` any more: leaving the anchor toward the panel is how
      // a player reaches the glossary, and this fires the instant the pointer
      // crosses the tile's edge. It still closes for every OTHER exit — and the
      // document-wide net above closes it anyway on the next move outside the
      // region, so a pointer that leaves without ever firing `mousemove` (the
      // 20260901_205453 stuck-Forest path) is still covered.
      onMouseLeave={(event) => {
        if (!inRegion({ x: event.clientX, y: event.clientY })) clear();
      }}
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
              panelRef={panelEl}
              onLeave={clear}
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
 * Does this DOM event carry a viewport position? `MouseEvent` (and so
 * `PointerEvent`) does; `scroll`, `keydown` and `blur` do not, and asking them
 * for `clientX` would silently read 0 and place the cursor in the top-left
 * corner — an answer that is wrong rather than absent.
 */
function isPointerish(event: Event): event is MouseEvent {
  return typeof MouseEvent === 'function' && event instanceof MouseEvent;
}

/**
 * The floating panel itself. Placement (including the off-screen clamping) lives
 * in the pure, unit-tested `previewPlacement`; this component only reads the live
 * viewport and paints the result.
 *
 * The card inside it is `CardFace` — see the module header. The panel keeps the
 * sizing and the clamping; the face keeps every decision about what the card
 * currently SAYS, so there is one card renderer and not two (scope §2.4).
 *
 * It takes a ref because the owner MEASURES it: the hover region includes the
 * panel now, and the panel's own box is the honest source for where it is.
 */
function CardHoverPanel({
  panelRef,
  onLeave,
  anchor,
  cardId,
  name,
  explanation,
  isCreature,
  unavailableReason,
}: {
  readonly panelRef: RefObject<HTMLDivElement>;
  /** Leaving the panel itself ends the hover — the direct, immediate close. */
  readonly onLeave: () => void;
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
      ref={panelRef}
      className="card-hover-preview"
      style={{ left: `${left}px`, top: `${top}px`, width: `${width}px` }}
      role="tooltip"
      aria-label={name}
      onMouseLeave={onLeave}
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
