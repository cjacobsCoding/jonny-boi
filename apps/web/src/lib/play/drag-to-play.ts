/**
 * Drag-to-play: the PURE state machine behind dragging a hand card onto your own
 * battlefield. This closes the other half of the "unplayable online" report — the
 * user's first instinct was to DRAG the land out ("I cant even drag lands out to
 * play them"), and no drag existed at all, on any board, ever.
 *
 * Built for Pointer Events, not HTML5 drag-and-drop, on purpose: `dragstart`/`drop`
 * never fire on touch browsers, and this PWA ships to Android. One pointer-based
 * path behaves identically for mouse and finger; the DOM glue lives in
 * `useDragToPlay.ts` and stays thin because every decision is made here.
 *
 * Shared by BOTH boards. It was born in `lib/online` purely to respect that
 * branch's file claim; bug report 20260825_210220 asked for the same gesture in
 * solo/pass-and-play, so it now lives here where both can reach it.
 *
 * The machine is deliberately conservative about what counts as a drag:
 * - a press is only ARMED — nothing visible happens, and a release before the
 *   movement threshold is a plain click (the existing click path handles it);
 * - crossing the threshold makes it a DRAGGING ghost that follows the pointer;
 * - releasing over the drop zone plays the card; anywhere else cancels cleanly.
 * That threshold is what keeps tap-to-play working on touch screens: without it,
 * every tap would register as a zero-distance drag and die on release.
 */
import type { InstanceId } from '@jonny-boi/core';

/** An axis-aligned box in viewport coordinates (what getBoundingClientRect gives). */
export interface DropRect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/** Is the point inside the rect? Edges count as inside — a drop on the border drops. */
export function pointInRect(x: number, y: number, rect: DropRect): boolean {
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

export type DragState =
  /** Nothing in flight. */
  | { readonly phase: 'idle' }
  /** Pointer is down on a draggable card, but hasn't moved far enough to commit. */
  | { readonly phase: 'armed'; readonly id: InstanceId; readonly startX: number; readonly startY: number }
  /** A live drag: the ghost is offset (dx, dy) from where the press started. */
  | {
      readonly phase: 'dragging';
      readonly id: InstanceId;
      readonly startX: number;
      readonly startY: number;
      readonly dx: number;
      readonly dy: number;
      readonly overDrop: boolean;
    };

export const DRAG_IDLE: DragState = Object.freeze({ phase: 'idle' });

/** Press on a draggable card: arm, but do not visibly start anything yet. */
export function pressCard(id: InstanceId, x: number, y: number): DragState {
  return { phase: 'armed', id, startX: x, startY: y };
}

/**
 * Pointer moved. An armed press commits to dragging once it travels
 * `thresholdPx` from where it started (Euclidean — direction doesn't matter);
 * a live drag just tracks the pointer and whether it is over the drop zone.
 * `dropRect` is null when the zone isn't rendered (defensive: never over).
 */
export function moveDrag(
  state: DragState,
  x: number,
  y: number,
  dropRect: DropRect | null,
  thresholdPx: number,
): DragState {
  if (state.phase === 'idle') return state;
  const dx = x - state.startX;
  const dy = y - state.startY;
  if (state.phase === 'armed' && Math.hypot(dx, dy) < thresholdPx) return state;
  return {
    phase: 'dragging',
    id: state.id,
    startX: state.startX,
    startY: state.startY,
    dx,
    dy,
    overDrop: dropRect !== null && pointInRect(x, y, dropRect),
  };
}

/**
 * Pointer released. Returns the card to play (only a live drag released over the
 * drop zone plays anything) and whether the release concluded a real drag — the
 * caller uses `wasDrag` to swallow the browser's follow-up click so one gesture
 * can't submit twice. An armed-but-unmoved release reports `wasDrag: false`,
 * which is what lets it fall through to the normal click handler.
 */
export function releaseDrag(state: DragState): {
  readonly next: DragState;
  readonly dropId: InstanceId | null;
  readonly wasDrag: boolean;
} {
  const wasDrag = state.phase === 'dragging';
  const dropId = state.phase === 'dragging' && state.overDrop ? state.id : null;
  return { next: DRAG_IDLE, dropId, wasDrag };
}

/** Abort (pointer cancelled, card became unplayable mid-drag, etc.). */
export function cancelDrag(): DragState {
  return DRAG_IDLE;
}
