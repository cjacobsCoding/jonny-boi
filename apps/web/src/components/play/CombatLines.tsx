import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import {
  EMPTY_MEASUREMENT,
  arcGradient,
  arcSegments,
  arcStroke,
  dashCycleLength,
  measurementSignature,
  type ArcEnd,
  type CombatArc,
  type MeasuredRect,
  type Measurement,
} from '../../lib/play/combat-lines.js';
import type { PlayerId } from '@jonny-boi/core';
import { seatAnchor, type SeatAnchorKind } from '../../lib/play/animations.js';
import { COMBAT_ADVANCE_CONFIG, COMBAT_ARC_CONFIG } from '../../lib/play/play-config.js';
import { usePrefersReducedMotion } from './AnimationLayer.js';
import './combat-arcs.css';

/**
 * COMBAT ARCS (§3.143 / UX-14) — fiery arced arrows for attack and block pairs.
 *
 * WHICH arcs exist and WHERE each curve, arrowhead and stroke go are both the
 * pure, unit-tested `combat-lines.ts`; this component only reads the live DOM
 * and paints the answer. It replaces §3.57's straight blocker segments: an arc
 * with an arrowhead says which way a relationship points, which a line with a
 * dot at one end never did.
 *
 * **The arrowhead marks the object being acted upon** — an attack arc points at
 * what is being attacked, a block arc points at the attacker being blocked.
 * That convention is stated once, in `combat-lines.ts`, and is the same for
 * both kinds so there is nothing to remember.
 *
 * ## Why this layer is PORTALLED to `document.body`
 *
 * UX-9 puts a CSS 3D scene on the board, and `getBoundingClientRect()` on a
 * 3D-transformed ancestor returns the PROJECTED box. Two consequences, both
 * handled here rather than left to whoever wires the board:
 *
 * 1. **One coordinate space.** The old overlay measured tiles in viewport space
 *    and then subtracted its container's origin to draw in board-local space.
 *    Under a scene transform those are two different spaces and the difference
 *    is nonsense. This layer measures in viewport space and draws in viewport
 *    space, with no subtraction anywhere.
 * 2. **`position: fixed` has to mean the viewport.** It does not, inside a
 *    transformed ancestor — a transform makes the element the containing block
 *    for its fixed descendants. Portalling out of the board subtree makes that
 *    structural rather than a promise another lane has to keep, and it is the
 *    same trick `CardHover` already uses for the same reason.
 *
 * The container ref is still required, but only as the QUERY SCOPE (find this
 * board's tiles, not another mounted board's) and as the CLIP rect, which
 * reproduces the clipping the board's own `overflow` used to provide.
 *
 * Purely decorative: `pointer-events: none`, `aria-hidden`, and any end that
 * cannot be measured simply contributes no arc.
 */
export function CombatLines({
  lines,
  containerRef,
  measureKey,
}: {
  /** The arcs to draw, from `combatArcPairs` — the one funnel, via `BoardScene`. */
  lines: readonly CombatArc[];
  /**
   * The board container. Used to SCOPE the tile query and to clip the overlay
   * to the board's visible box — NOT as a coordinate origin (see the module
   * comment).
   */
  containerRef: RefObject<HTMLElement | null>;
  /**
   * Any value that changes when tile positions may have moved (the session
   * object works) — re-measure without watching the whole DOM.
   */
  measureKey: unknown;
}): ReactElement | null {
  const [measured, setMeasured] = useState<Measurement>(EMPTY_MEASUREMENT);
  const committed = useRef<string | null>(null);
  const reducedMotion = usePrefersReducedMotion();
  // SVG `url(#…)` references need a document-unique, fragment-safe id. React's
  // generated ids carry colons, which are legal in an `id` but fragile inside a
  // `url()`, so keep only the safe characters.
  const idPrefix = useId().replace(/[^a-zA-Z0-9_-]/g, '');

  /**
   * The ONE place a measurement becomes what is on screen. Returns whether the
   * picture actually changed, so a pass that found nothing new costs no render
   * — which is what makes the settling watch and the scroll listener below
   * affordable.
   */
  const commit = useCallback((next: Measurement): boolean => {
    const signature = measurementSignature(next);
    if (signature === committed.current) return false;
    committed.current = signature;
    setMeasured(next);
    return true;
  }, []);

  // A measurement pass, then rAF passes until the picture stops changing.
  //
  // UX-12/UX-13 slide attackers and blockers toward each other AFTER the
  // declaration that produced these arcs, so a single pass at declaration time
  // would pin every arrow to where its tile used to be — for the whole combat,
  // since nothing re-renders until the next action. Re-measuring until two
  // consecutive frames agree costs two frames when nothing moves and the real
  // travel time when something does.
  useLayoutEffect(() => {
    let frame = 0;
    let stable = 0;
    const deadline = Date.now() + ARC_SETTLE_MS;
    const tick = (): void => {
      stable = commit(measureArcs(containerRef.current, lines)) ? 0 : stable + 1;
      if (stable >= ARC_SETTLE_STABLE_FRAMES || Date.now() >= deadline) return;
      if (typeof window.requestAnimationFrame !== 'function') return;
      frame = window.requestAnimationFrame(tick);
    };
    tick();
    return () => {
      if (frame !== 0) window.cancelAnimationFrame(frame);
    };
    // `measureKey` re-measures on new frames; `lines` on assignment changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lines, measureKey]);

  useEffect(() => {
    const remeasure = (): void => {
      commit(measureArcs(containerRef.current, lines));
    };
    window.addEventListener('resize', remeasure);
    // The overlay no longer scrolls with the tiles it points at (it is fixed and
    // portalled), so an ancestor scrolling moves them out from under it. The
    // board's own scrollers do not bubble a scroll event, hence capture.
    window.addEventListener('scroll', remeasure, { capture: true, passive: true });
    return () => {
      window.removeEventListener('resize', remeasure);
      window.removeEventListener('scroll', remeasure, { capture: true });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lines]);

  const { segments, clip } = measured;
  if (segments.length === 0 || clip === null) return null;

  const clipId = `${idPrefix}-arc-clip`;
  const gradientId = (index: number): string => `${idPrefix}-arc-${index}`;
  const emberCycle = dashCycleLength(COMBAT_ARC_CONFIG.emberDashArray);
  // Reduced motion drops the ember elements entirely (the CSS gate is the
  // second, independent guard) — but never the arcs themselves, which carry the
  // information. A cycle of 0 means the dash pattern has no length to travel.
  const embers = !reducedMotion && emberCycle > 0;

  return createPortal(
    <svg className="combat-arcs" aria-hidden="true" style={cssVariables(emberCycle)}>
      <defs>
        {/* Reproduces the clipping the board's own `overflow` used to do for an
            in-tree overlay: an arc to a tile scrolled out of the board must not
            paint over the action bar. */}
        <clipPath id={clipId}>
          <rect x={clip.left} y={clip.top} width={clip.width} height={clip.height} />
        </clipPath>
        {/* One ramp per arc, in USER SPACE from tail to arrowhead, so the flame
            runs along the arc and the hot tip lands on the head. It ramps by
            projection onto the chord rather than by arc length — SVG has no
            path-following gradient short of a mesh, and at these bows the
            difference is a few percent of the ramp position. */}
        {segments.map((segment, index) => (
          <linearGradient
            key={segment.key}
            id={gradientId(index)}
            gradientUnits="userSpaceOnUse"
            x1={segment.start.x}
            y1={segment.start.y}
            x2={segment.end.x}
            y2={segment.end.y}
          >
            {arcGradient(segment.kind, COMBAT_ARC_CONFIG).map((stop) => (
              <stop key={stop.offsetFraction} offset={stop.offsetFraction} stopColor={stop.color} />
            ))}
          </linearGradient>
        ))}
      </defs>
      <g clipPath={`url(#${clipId})`}>
        {/* Static geometry only, so the blur can be cached between frames. */}
        <g className="combat-arcs__halo">
          {segments.map((segment, index) =>
            // A committed pair burns; a half-built one does not. The glow is
            // half of what makes "declared" read differently from "drafting".
            segment.declared ? (
              <path
                key={segment.key}
                d={segment.path}
                stroke={`url(#${gradientId(index)})`}
                strokeWidth={COMBAT_ARC_CONFIG.strokeWidthPx + ARC_HALO_SPREAD * COMBAT_ARC_CONFIG.glowBlurPx}
              />
            ) : null,
          )}
        </g>
        <g className="combat-arcs__body">
          {segments.map((segment, index) => {
            const stroke = arcStroke(segment.declared, COMBAT_ARC_CONFIG);
            const paint = `url(#${gradientId(index)})`;
            const ramp = arcGradient(segment.kind, COMBAT_ARC_CONFIG);
            // The ramp's LAST stop is its hot tip; embers are flecks of that
            // colour travelling up the flame. Derived from the palette rather
            // than a second colour nobody tuned. A ramp with no stops (nothing
            // in the shipped config, but the type allows it) means no embers.
            const emberColor = ramp[ramp.length - 1]?.color;
            return (
              <g key={segment.key}>
                <path
                  d={segment.path}
                  stroke={paint}
                  strokeWidth={stroke.widthPx}
                  strokeDasharray={stroke.dashArray}
                />
                <polygon points={segment.arrowPoints} fill={paint} />
                {embers && emberColor !== undefined ? (
                  <path
                    className="combat-arcs__ember"
                    d={segment.path}
                    stroke={emberColor}
                    strokeWidth={stroke.widthPx}
                  />
                ) : null}
              </g>
            );
          })}
        </g>
      </g>
    </svg>,
    document.body,
  );
}

/**
 * How much wider than the arc its halo is drawn, as a multiple of the config's
 * glow blur: the blur radius spills that far to EACH side, so `2 × blur` is the
 * band a Gaussian glow of that radius actually occupies.
 */
const ARC_HALO_SPREAD = 2;

/**
 * How long tiles may still be travelling after the arcs change. Derived from
 * the advance the board plays (UX-12/13), not chosen: the last tile in a
 * staggered charge starts moving `staggerMs × maxStaggered` after the first and
 * then takes `advanceMs` itself.
 */
const ARC_SETTLE_MS =
  COMBAT_ADVANCE_CONFIG.advanceMs + COMBAT_ADVANCE_CONFIG.staggerMs * COMBAT_ADVANCE_CONFIG.maxStaggered;

/**
 * Consecutive identical frames that end the settling watch. Two, not one: a
 * CSS transition passing through its own inflection can produce two frames that
 * round to the same path, and stopping there would freeze the arcs mid-flight.
 */
const ARC_SETTLE_STABLE_FRAMES = 2;

/**
 * Where a SEAT sits on screen, in preference order — first measurable wins.
 *
 * An attack on a player points AT that player's LIFE TOTAL, which `SeatPanel`
 * publishes as `life:<seat>` (§3.143 GAP-13). The creature row stays as the
 * second row rather than being deleted: a board that renders a seat without the
 * life readout (the effects bench's stage, a future compact layout) still gets
 * an honest destination instead of no arc. A seat NEITHER row can measure
 * contributes no arc — the overlay never invents a destination.
 *
 * Spelled from `seatAnchor`, not as literals: the publisher and this reader must
 * not be able to disagree about the name, which is precisely how the life anchor
 * came to be aimed at and never published.
 */
const SEAT_ANCHOR_ORDER: readonly SeatAnchorKind[] = ['life', 'board'];

/** Measure every arc's ends inside `container`; unmeasurable ends drop out. */
function measureArcs(container: HTMLElement | null, arcs: readonly CombatArc[]): Measurement {
  if (!container || arcs.length === 0) return EMPTY_MEASUREMENT;
  const clip = rectOf(container);
  // One cache per pass: a lethal alpha strike points many arcs at one seat, and
  // a blocked attacker is the head of every arc its blockers draw.
  const cache = new Map<string, MeasuredRect | undefined>();
  const measure = (end: ArcEnd): MeasuredRect | undefined => {
    const key = end.at === 'permanent' ? `p${end.instanceId}` : `s${end.seat}`;
    if (cache.has(key)) return cache.get(key);
    const found = end.at === 'permanent' ? permanentRect(container, end.instanceId) : seatRect(container, end.seat);
    cache.set(key, found);
    return found;
  };
  return { segments: arcSegments(arcs, measure, COMBAT_ARC_CONFIG), clip };
}

function permanentRect(container: HTMLElement, instanceId: number): MeasuredRect | undefined {
  const el = container.querySelector(`[data-perm-id="${instanceId}"]`);
  return el instanceof HTMLElement ? rectOf(el) : undefined;
}

function seatRect(container: HTMLElement, seat: PlayerId): MeasuredRect | undefined {
  for (const kind of SEAT_ANCHOR_ORDER) {
    const el = container.querySelector(`[data-anim-anchor="${seatAnchor(kind, seat)}"]`);
    if (el instanceof HTMLElement) return rectOf(el);
  }
  return undefined;
}

/**
 * The one place a DOM rect becomes geometry. Viewport coordinates, exactly as
 * the browser reports them — under a 3D scene that is the PROJECTED box, which
 * is precisely what the arc should connect, because it is what the player sees.
 */
function rectOf(el: HTMLElement): MeasuredRect {
  const rect = el.getBoundingClientRect();
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
}

/**
 * The tuned numbers, handed to the stylesheet as custom properties. The
 * stylesheet therefore holds no second copy of a value from `play-config.ts` —
 * one answer to one question, across the TS/CSS boundary too.
 */
function cssVariables(emberCycle: number): CSSProperties {
  return {
    '--combat-arc-glow-px': `${COMBAT_ARC_CONFIG.glowBlurPx}px`,
    '--combat-arc-ember-dash': COMBAT_ARC_CONFIG.emberDashArray,
    '--combat-arc-ember-ms': `${COMBAT_ARC_CONFIG.emberPeriodMs}ms`,
    // Negative: the dashes travel forward, toward the arrowhead.
    '--combat-arc-ember-cycle': `${-emberCycle}`,
  } as CSSProperties;
}
