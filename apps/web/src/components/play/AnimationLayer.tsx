import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
  type RefObject,
} from 'react';
import type { GameEvent, InstanceId } from '@jonny-boi/core';
import { getCard, cardImage } from '../../lib/cards.js';
import {
  deriveAnimations,
  type AnimationCardInfo,
  type AnimationDescriptor,
} from '../../lib/play/animations.js';
import { ANIMATION_CONFIG } from '../../lib/play/play-config.js';

/**
 * The ZONE-CHANGE ANIMATION LAYER (§3.57) — the DOM half of `animations.ts`.
 *
 * The pure model decided WHAT animates (a draw's card back, a mill/discard's
 * face, a death's ghost); this layer decides WHERE, by measuring the board's
 * `data-anim-anchor` elements (zone counters, hand regions) and the last-known
 * tile rects, then plays each sprite as a CSS-transitioned flight and retires
 * it. Everything here is presentation: killing this layer changes nothing
 * about the game.
 *
 * Reduced motion is honored twice: `useZoneAnimations` derives NOTHING when
 * `prefers-reduced-motion` matches (no sprite is ever mounted), and the CSS
 * disables the transitions besides.
 */

/** Resolve an anchor element's rect inside `root` ("library:A", "hand:B"…). */
function anchorRect(root: HTMLElement | null, anchor: string): DOMRect | undefined {
  if (!root) return undefined;
  const el = root.querySelector(`[data-anim-anchor="${anchor}"]`);
  return el instanceof HTMLElement ? el.getBoundingClientRect() : undefined;
}

/** Watch the OS-level reduced-motion preference (live, not just at mount). */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState<boolean>(() =>
    typeof window.matchMedia === 'function'
      ? window.matchMedia(REDUCED_MOTION_QUERY).matches
      : false,
  );
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia(REDUCED_MOTION_QUERY);
    const onChange = (): void => setReduced(media.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);
  return reduced;
}

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

/**
 * Fold the session's cumulative event log into live sprites. The baseline is
 * the log length AT MOUNT, so a board opening mid-game (or after a hotseat
 * handoff) never replays history — only events appended while the board is on
 * screen animate.
 */
export function useZoneAnimations(
  events: readonly GameEvent[],
  lookup: (id: InstanceId) => AnimationCardInfo | undefined,
): { readonly sprites: readonly AnimationDescriptor[]; readonly retire: (key: string) => void } {
  const [sprites, setSprites] = useState<readonly AnimationDescriptor[]>([]);
  const reducedMotion = usePrefersReducedMotion();
  // Baseline at mount: everything already in the log happened before we watched.
  const seen = useRef<number>(events.length);

  useEffect(() => {
    if (events.length <= seen.current) {
      // A rematch swaps in a shorter log; re-baseline instead of replaying it.
      seen.current = events.length;
      return;
    }
    const startIndex = seen.current;
    const fresh = events.slice(startIndex);
    seen.current = events.length;
    // `lookup` swaps identity together with `events` (both derive from the
    // session), so depending on it adds no extra derivations — a lookup-only
    // run sees nothing fresh and is a no-op.
    const derived = deriveAnimations(fresh, { reducedMotion, startIndex, lookup });
    if (derived.length > 0) setSprites((current) => [...current, ...derived]);
  }, [events, reducedMotion, lookup]);

  const retire = useCallback((key: string): void => {
    setSprites((current) => current.filter((sprite) => sprite.key !== key));
  }, []);

  return { sprites, retire };
}

/** The overlay itself: one transient element per in-flight descriptor. */
export function AnimationLayer({
  sprites,
  boardRootRef,
  tileRectOf,
  onDone,
}: {
  sprites: readonly AnimationDescriptor[];
  /** The board container the anchors are queried inside (read in effects only). */
  boardRootRef: RefObject<HTMLElement | null>;
  /** Last-known battlefield tile rect (captured before the tile left the DOM). */
  tileRectOf: (id: InstanceId) => DOMRect | undefined;
  onDone: (key: string) => void;
}): ReactElement | null {
  if (sprites.length === 0) return null;
  return (
    <div className="anim-layer" aria-hidden="true">
      {sprites.map((sprite) =>
        sprite.kind === 'death' ? (
          <DeathGhost key={sprite.key} sprite={sprite} tileRectOf={tileRectOf} boardRootRef={boardRootRef} onDone={onDone} />
        ) : (
          <FlightSprite key={sprite.key} sprite={sprite} boardRootRef={boardRootRef} onDone={onDone} />
        ),
      )}
    </div>
  );
}

/** Where one flight starts and ends, per kind (anchors by seat). */
function flightAnchors(sprite: AnimationDescriptor): { from: string; fromFallback?: string; to: string; toFallback?: string } {
  const seat = sprite.seat;
  if (sprite.kind === 'draw') {
    return { from: `library:${seat}`, to: `hand:${seat}`, toFallback: `hand-count:${seat}` };
  }
  if (sprite.kind === 'mill') {
    return { from: `library:${seat}`, to: `graveyard:${seat}` };
  }
  // discard
  return { from: `hand:${seat}`, fromFallback: `hand-count:${seat}`, to: `graveyard:${seat}` };
}

/** Flight duration per kind (named knobs, not inline numbers). */
function flightDurationMs(kind: AnimationDescriptor['kind']): number {
  return kind === 'draw' ? ANIMATION_CONFIG.drawFlightMs : ANIMATION_CONFIG.graveFlightMs;
}

/** Extra time past the transition before the sprite retires (cheap safety). */
const RETIRE_SLACK_MS = 80;

/** The center of a rect, as fixed-position coordinates for the sprite box. */
function centerOf(rect: DOMRect, width: number, height: number): { left: number; top: number } {
  return {
    left: rect.left + rect.width / 2 - width / 2,
    top: rect.top + rect.height / 2 - height / 2,
  };
}

/** Card sprite proportions (a Magic card is 63×88mm — keep the ratio honest). */
const CARD_ASPECT = 88 / 63;

/**
 * A card flying between two zone anchors — a BACK for a draw (identity stays
 * hidden), the face art for a mill/discard (public by the time it flies).
 */
function FlightSprite({
  sprite,
  boardRootRef,
  onDone,
}: {
  sprite: AnimationDescriptor;
  boardRootRef: RefObject<HTMLElement | null>;
  onDone: (key: string) => void;
}): ReactElement | null {
  const [style, setStyle] = useState<CSSProperties | null>(null);
  const done = useRef(false);
  const width = ANIMATION_CONFIG.spriteWidthPx;
  const height = Math.round(width * CARD_ASPECT);
  const delayMs = sprite.order * ANIMATION_CONFIG.staggerMs;
  const durationMs = flightDurationMs(sprite.kind);

  useLayoutEffect(() => {
    const boardRoot = boardRootRef.current;
    const anchors = flightAnchors(sprite);
    const from =
      anchorRect(boardRoot, anchors.from) ??
      (anchors.fromFallback ? anchorRect(boardRoot, anchors.fromFallback) : undefined);
    const to =
      anchorRect(boardRoot, anchors.to) ??
      (anchors.toFallback ? anchorRect(boardRoot, anchors.toFallback) : undefined);
    if (!from || !to) {
      // An anchor missing (panel scrolled out of existence, hidden layout) —
      // skip the sprite rather than fly from nowhere. The log tells the story.
      onDone(sprite.key);
      return;
    }
    const start = centerOf(from, width, height);
    const end = centerOf(to, width, height);
    setStyle({
      left: start.left,
      top: start.top,
      width,
      height,
      transitionDuration: `${durationMs}ms`,
      transitionDelay: `${delayMs}ms`,
      // The flight is one transform, set on the NEXT frame (see below).
      transform: 'translate(0px, 0px)',
      ['--anim-dx' as string]: `${end.left - start.left}px`,
      ['--anim-dy' as string]: `${end.top - start.top}px`,
    });
    // Two rAFs: the first commits the start position, the second flips the
    // class so the transition actually runs (a same-frame flip transitions
    // nothing).
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        setStyle((cur) => (cur ? { ...cur, transform: 'translate(var(--anim-dx), var(--anim-dy))' } : cur));
      });
    });
    const timer = window.setTimeout(() => {
      if (!done.current) {
        done.current = true;
        onDone(sprite.key);
      }
    }, delayMs + durationMs + RETIRE_SLACK_MS);
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
      window.clearTimeout(timer);
    };
    // Mounted once per sprite key; the descriptor is immutable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sprite.key]);

  if (!style) return null;
  const card = sprite.cardId ? getCard(sprite.cardId) : undefined;
  const art = card ? cardImage(card, 'art_crop') : undefined;
  return (
    <div className={`anim-sprite anim-sprite--${sprite.kind}`} style={style}>
      {sprite.kind === 'draw' || !art ? (
        <span className="anim-sprite__back">⚙</span>
      ) : (
        <img src={art} alt="" draggable={false} />
      )}
    </div>
  );
}

/**
 * A permanent's ghost fading and shrinking where its tile stood — the §3.57
 * "creatures dying" read. Positioned by the tile rect captured BEFORE the
 * tile left the DOM; when no rect survives (the board re-flowed), it fades at
 * the seat's board row instead of not existing at all.
 */
function DeathGhost({
  sprite,
  tileRectOf,
  boardRootRef,
  onDone,
}: {
  sprite: AnimationDescriptor;
  tileRectOf: (id: InstanceId) => DOMRect | undefined;
  boardRootRef: RefObject<HTMLElement | null>;
  onDone: (key: string) => void;
}): ReactElement | null {
  const [style, setStyle] = useState<CSSProperties | null>(null);
  const [leaving, setLeaving] = useState(false);
  const done = useRef(false);
  const durationMs = ANIMATION_CONFIG.deathFadeMs;
  const delayMs = sprite.order * ANIMATION_CONFIG.staggerMs;

  useLayoutEffect(() => {
    const rect = tileRectOf(sprite.instanceId) ?? anchorRect(boardRootRef.current, `board:${sprite.seat}`);
    if (!rect) {
      onDone(sprite.key);
      return;
    }
    setStyle({
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
      transitionDuration: `${durationMs}ms`,
      transitionDelay: `${delayMs}ms`,
    });
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => setLeaving(true));
    });
    const timer = window.setTimeout(() => {
      if (!done.current) {
        done.current = true;
        onDone(sprite.key);
      }
    }, delayMs + durationMs + RETIRE_SLACK_MS);
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sprite.key]);

  if (!style) return null;
  const card = sprite.cardId ? getCard(sprite.cardId) : undefined;
  const art = card ? cardImage(card, 'art_crop') : undefined;
  return (
    <div className={`anim-ghost${leaving ? ' anim-ghost--leaving' : ''}`} style={style}>
      {art ? <img src={art} alt="" draggable={false} /> : <span className="anim-ghost__name">{sprite.name}</span>}
    </div>
  );
}
