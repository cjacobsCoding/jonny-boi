import { useState, type CSSProperties, type ReactElement } from 'react';
import { getCard, cardImage } from '../../lib/cards.js';
import { ManaCost } from '../ManaCost.js';
import { CardFace } from './CardFace.js';

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
 * `play-surface-images.test.ts` pins this structurally — and it still holds,
 * because `CardFace` marks its art eager for the same reason.
 *
 * ## The FULL face is a live {@link CardFace} (§3.143 / UX-17.4, wave 2)
 *
 * …drawn at the `compact` size since bug report 20260917_220137: a hand card
 * is a printed scan at 96–148px, and the full live text box at that size was
 * unreadable and climbed over the art. The scan prints the rules; the face
 * overlays only the aftermarket words, and the readable text with its glossary
 * is the hover preview, which `PlayBoard` wraps around every hand card.
 *
 * Caleb asked for a glossary tooltip *"on any card"*, and this component draws
 * the hand (both boards), the mulligan grid, the stack faces and the choice
 * prompt's source and candidates — five of the six surfaces a player ever reads
 * a card on. It used to emit a bare `<img>`, so every one of those was a
 * picture: hovering "vigilance" explained nothing, because there was no text
 * node to hover. Delegating the full face to `CardFace` gives all five the ONE
 * renderer lane P built (spec §2.4 — "one component with one props contract,
 * adopted by every site — not a sixth renderer") rather than teaching each
 * mount site its own trick. `play-card-live-face.test.ts` pins the adoption.
 *
 * With no `explanation` prop `CardFace` renders the plain printed card plus the
 * glossary — which is the honest state here: a card in hand, on the stack or in
 * a prompt has no continuous-effect index behind it to attribute anything to.
 *
 * ⚠️ ONE degradation moved rather than survived: the full face's `onError` →
 * named-plate fallback lived on the `<img>` this file used to own, and
 * `CardFace` owns that element now. A card with NO image at all still falls
 * back here (`hasFullFace` below); a card whose image URL 404s at runtime shows
 * `CardFace`'s art `alt` — the card's name — instead of the chip plate. Closing
 * that last gap is one `onError` inside `CardFace`; it is in this lane's report
 * as a contract for lane WB, not silently forgotten.
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
  // Whether a full face is DRAWABLE at all — a token, an uncompiled import or a
  // Scryfall miss has no image, and those degrade to the chip's named layout
  // exactly as before. `CardFace` re-resolves the image itself (it asks for
  // `large`, the readable one); this only answers "is there a card to draw".
  const hasFullFace = face === 'full' && card !== undefined && cardImage(card, 'normal') !== undefined;
  const art = card ? cardImage(card, 'art_crop') : undefined;
  // A CHIP whose art failed to load falls back to its named layout — a blank
  // rectangle is the one thing a card must never be. (The full face's own
  // error path moved into `CardFace` with the element it hangs off; see the
  // module doc.)
  const [faceBroken, setFaceBroken] = useState(false);
  const showFull = hasFullFace;
  // The name alone is useless on a card the player just tried and failed to use.
  const tooltip = reason ? `${name} — ${reason}` : name;
  const className = `play-card${showFull ? ' play-card--full' : ''}${
    selected ? ' play-card--selected' : ''
  }${disabled ? ' play-card--disabled' : ''}${onClick && !disabled ? ' play-card--actionable' : ''}`;

  const inner = showFull ? (
    <>
      {/*
        The live face. `className` hands it the box the <img> used to fill —
        `.play-card__face` is `width/height: 100%`, so every mount site that
        sizes `.play-card--full` (board-fit, stack-panel, choice-prompt) keeps
        sizing the face with no change of its own.

        draggable={false} IS the land-play fix (bug reports 20260827_205353 +
        205443), and it rides along: an <img> is natively draggable, and this one
        fills the whole card — so pressing a card and moving a few pixels started
        a BROWSER image-drag, which cancels the pointer stream (our drag machine
        never commits) and swallows the mouseup (the click never fires). The
        reporter's clip shows three mousedowns on a hand card with no mouseup
        ever recorded. Synthetic-event tests cannot catch this: dispatched
        pointers never start a native drag. `CardFace` sets the attribute for the
        same documented reason; `no-native-drag.test.ts` pins it for both.
      */}
      <CardFace size="compact" cardId={cardId} name={name} className="play-card__face" />
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

  // The live face's tooltips are absolutely-positioned children, and
  // `.play-card` is `overflow: hidden` (styles.css) — which CLIPS every one of
  // them to the 148px card, so the pop a player hovers would exist and be
  // invisible. `card-face.css` records the same constraint for its own box
  // ("`overflow` on any ancestor CLIPS an absolutely-positioned pop"). Inline
  // rather than a new rule because styles.css belongs to another lane, and a
  // second `.play-card--full` block in a third stylesheet is one more thing for
  // the cascade to decide by import order (board-fit.css §"Rule 1" is the scar).
  const style: CSSProperties | undefined = showFull ? LIVE_FACE_STYLE : undefined;

  if (onClick) {
    return (
      <button
        type="button"
        className={className}
        style={style}
        onClick={onClick}
        disabled={disabled}
        title={tooltip}
      >
        {inner}
      </button>
    );
  }
  return (
    <div className={className} style={style} title={tooltip} aria-label={tooltip}>
      {inner}
    </div>
  );
}

/** See the call site: un-clips {@link CardFace}'s glossary pops. */
const LIVE_FACE_STYLE: CSSProperties = Object.freeze({ overflow: 'visible' });

/**
 * A face-down card back — the ONE answer to "what does a card the viewer may
 * not identify look like", used by the opponent's hidden hand and by the
 * face-down half of an opened exile (CR 702.143a, a foretold card).
 *
 * Fanned by `index` so that a big hand costs no more height than a small one.
 * The overlap is a token rather than a literal (§3.62) because the player's own
 * hand now fans by the same rule, and two hands drifting apart on the same board
 * reads as a bug. `index={0}` lays a back out on its own, which is what a zone
 * list wants — there the backs are countable items, not a fan.
 *
 * ⚠️ NOTHING IDENTIFYING MAY BE PASSED HERE. `label` is prose about the
 * SITUATION ("Face down in exile — only its owner may look at it"), never about
 * the card; there is deliberately no `name` or `cardId` prop for one to arrive
 * in. Without a label the back is decorative and hidden from assistive tech, as
 * the hand's fan is; with one it is an item a screen reader can count, which is
 * what a zone panel needs.
 */
export function CardBack({ index, label }: { index: number; label?: string }): ReactElement {
  const identity =
    label === undefined
      ? ({ 'aria-hidden': true } as const)
      : ({ role: 'img', 'aria-label': label, title: label } as const);
  return (
    <div
      className="play-card play-card--back"
      {...identity}
      style={{ marginLeft: index === 0 ? 0 : 'calc(-1 * var(--play-back-overlap))' }}
    >
      <span className="play-card__back-mark" aria-hidden="true">
        ⚙
      </span>
    </div>
  );
}
