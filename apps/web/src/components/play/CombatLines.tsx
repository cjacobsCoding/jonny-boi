import { useEffect, useLayoutEffect, useState, type ReactElement, type RefObject } from 'react';
import type { BlockLine } from '../../lib/play/combat-lines.js';

/**
 * BLOCKER LINES (§3.57) — an SVG overlay connecting each blocker's tile to the
 * attacker it blocks, so combat assignments read at a glance instead of only
 * through the "→ blocks X" markers.
 *
 * WHICH lines exist is the pure `blockerLinePairs` model (unit-tested); this
 * component only measures the tiles (`[data-perm-id]`) inside the board
 * container and draws. A DRAFT line (still being assigned) is dashed; a
 * DECLARED one is solid. Purely decorative: `pointer-events: none`, and a tile
 * that cannot be measured simply contributes no line.
 */
export function CombatLines({
  lines,
  containerRef,
  measureKey,
}: {
  lines: readonly BlockLine[];
  /** The positioned board container the SVG overlays (and measures within). */
  containerRef: RefObject<HTMLElement | null>;
  /**
   * Any value that changes when tile positions may have moved (the session
   * object works) — re-measure without watching the whole DOM.
   */
  measureKey: unknown;
}): ReactElement | null {
  const [segments, setSegments] = useState<readonly LineSegment[]>([]);
  const [size, setSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });

  useLayoutEffect(() => {
    setSegments(measureLines(containerRef.current, lines, setSize));
    // `measureKey` re-measures on new frames; `lines` on assignment changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lines, measureKey]);

  // Window resizes move every tile; re-measure (cheap: a handful of rects).
  useEffect(() => {
    const remeasure = (): void => setSegments(measureLines(containerRef.current, lines, setSize));
    window.addEventListener('resize', remeasure);
    return () => window.removeEventListener('resize', remeasure);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lines]);

  if (segments.length === 0) return null;
  return (
    <svg
      className="combat-lines"
      width={size.w}
      height={size.h}
      viewBox={`0 0 ${size.w} ${size.h}`}
      aria-hidden="true"
    >
      {segments.map((seg) => (
        <g key={`${seg.blocker}:${seg.attacker}`} className={seg.declared ? 'combat-lines__declared' : 'combat-lines__draft'}>
          <line x1={seg.x1} y1={seg.y1} x2={seg.x2} y2={seg.y2} />
          {/* A dot at the blocker end gives the line a direction without an arrowhead. */}
          <circle cx={seg.x1} cy={seg.y1} r={BLOCKER_DOT_RADIUS} />
        </g>
      ))}
    </svg>
  );
}

interface LineSegment {
  readonly blocker: number;
  readonly attacker: number;
  readonly declared: boolean;
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
}

/** Radius of the dot marking the blocker end of a line (px). */
const BLOCKER_DOT_RADIUS = 4;

/** Measure each pair's tiles inside the container; unmeasurable pairs drop out. */
function measureLines(
  container: HTMLElement | null,
  lines: readonly BlockLine[],
  setSize: (size: { w: number; h: number }) => void,
): readonly LineSegment[] {
  if (!container || lines.length === 0) return [];
  const containerRect = container.getBoundingClientRect();
  setSize({ w: containerRect.width, h: containerRect.height });
  const centerOf = (id: number): { x: number; y: number } | undefined => {
    const el = container.querySelector(`[data-perm-id="${id}"]`);
    if (!(el instanceof HTMLElement)) return undefined;
    const rect = el.getBoundingClientRect();
    return {
      x: rect.left + rect.width / 2 - containerRect.left,
      y: rect.top + rect.height / 2 - containerRect.top,
    };
  };
  const out: LineSegment[] = [];
  for (const line of lines) {
    const from = centerOf(line.blocker);
    const to = centerOf(line.attacker);
    if (!from || !to) continue;
    out.push({
      blocker: line.blocker,
      attacker: line.attacker,
      declared: line.declared,
      x1: from.x,
      y1: from.y,
      x2: to.x,
      y2: to.y,
    });
  }
  return out;
}
