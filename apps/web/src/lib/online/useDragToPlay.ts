/**
 * React glue for `drag-to-play.ts` — all decisions live in that pure module; this
 * hook only moves DOM facts (pointer positions, the drop zone's rect) in and
 * renders the machine's answers out.
 *
 * Wiring model: the HAND CONTAINER gets the pointer handlers (event delegation —
 * cards mark themselves draggable with a `data-drag-id` attribute), and the drop
 * zone is whatever element the caller hangs `dropRef` on. On a successful drop the
 * hook calls `onDrop(id)`, which the board points at the SAME handler a click
 * uses — drag is an alternate gesture for the identical action, never a second
 * code path that could disagree with the server.
 *
 * Two browser realities handled here rather than in the pure machine:
 * - `setPointerCapture` on the pressed card keeps the move/up stream flowing to
 *   us even when the finger leaves the element (and lets the ghost ignore
 *   pointer events without losing the gesture);
 * - after a real drag, browsers still synthesize a `click` on the pressed
 *   element. `onClickCapture` swallows exactly that one click (flag set on a
 *   dragging release, cleared on use) so one gesture cannot play a card AND
 *   re-trigger its click handler.
 */
import { useRef, useState, type PointerEvent as ReactPointerEvent, type MouseEvent as ReactMouseEvent } from 'react';
import type { InstanceId } from '@jonny-boi/core';
import {
  DRAG_IDLE,
  cancelDrag,
  moveDrag,
  pressCard,
  releaseDrag,
  type DragState,
} from './drag-to-play.js';
import { DRAG_START_THRESHOLD_PX } from './online-config.js';

/** The attribute a draggable card wrapper carries (value: its instance id). */
export const DRAG_ID_ATTR = 'data-drag-id';

export interface DragToPlay {
  /** Spread onto the hand container. */
  readonly handProps: {
    onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void;
    onPointerMove: (e: ReactPointerEvent<HTMLElement>) => void;
    onPointerUp: (e: ReactPointerEvent<HTMLElement>) => void;
    onPointerCancel: (e: ReactPointerEvent<HTMLElement>) => void;
    onClickCapture: (e: ReactMouseEvent<HTMLElement>) => void;
  };
  /** Hang this on the element that accepts drops (the viewer's battlefield). */
  readonly dropRef: (el: HTMLElement | null) => void;
  /** The live drag for rendering (ghost offset + drop highlight), or null. */
  readonly drag: { readonly id: InstanceId; readonly dx: number; readonly dy: number; readonly overDrop: boolean } | null;
}

export function useDragToPlay(onDrop: (id: InstanceId) => void): DragToPlay {
  const [state, setState] = useState<DragState>(DRAG_IDLE);
  const dropEl = useRef<HTMLElement | null>(null);
  /** Swallow the single synthesized click that follows a real drag's release. */
  const suppressNextClick = useRef(false);
  // The handlers read the freshest state directly (pointer moves outpace renders);
  // `setState` still drives the ghost/highlight re-render.
  const live = useRef<DragState>(DRAG_IDLE);
  const update = (next: DragState): void => {
    live.current = next;
    setState(next);
  };

  const draggableFrom = (e: ReactPointerEvent<HTMLElement>): { id: InstanceId; el: HTMLElement } | null => {
    const el = (e.target as HTMLElement).closest<HTMLElement>(`[${DRAG_ID_ATTR}]`);
    if (!el) return null;
    const raw = el.getAttribute(DRAG_ID_ATTR);
    if (raw === null || raw === '') return null;
    return { id: Number(raw) as InstanceId, el };
  };

  const handProps: DragToPlay['handProps'] = {
    onPointerDown: (e) => {
      // Primary button / first touch only — a right-click is never a drag.
      if (e.button !== 0) return;
      const hit = draggableFrom(e);
      if (!hit) return;
      try {
        hit.el.setPointerCapture(e.pointerId);
      } catch {
        // Capture is an enhancement (keeps the stream when the pointer leaves the
        // hand), not a requirement — a pointer the browser no longer considers
        // active (or a synthetic one in tests) must not kill the gesture.
      }
      update(pressCard(hit.id, e.clientX, e.clientY));
    },
    onPointerMove: (e) => {
      if (live.current.phase === 'idle') return;
      const rect = dropEl.current?.getBoundingClientRect() ?? null;
      update(moveDrag(live.current, e.clientX, e.clientY, rect, DRAG_START_THRESHOLD_PX));
    },
    onPointerUp: () => {
      const { next, dropId, wasDrag } = releaseDrag(live.current);
      update(next);
      if (wasDrag) suppressNextClick.current = true;
      if (dropId !== null) onDrop(dropId);
    },
    onPointerCancel: () => {
      update(cancelDrag());
    },
    onClickCapture: (e) => {
      if (!suppressNextClick.current) return;
      suppressNextClick.current = false;
      e.preventDefault();
      e.stopPropagation();
    },
  };

  return {
    handProps,
    dropRef: (el) => {
      dropEl.current = el;
    },
    drag: state.phase === 'dragging' ? { id: state.id, dx: state.dx, dy: state.dy, overDrop: state.overDrop } : null,
  };
}
