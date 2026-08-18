import { describe, expect, it } from 'vitest';
import {
  DRAG_IDLE,
  cancelDrag,
  moveDrag,
  pointInRect,
  pressCard,
  releaseDrag,
  type DropRect,
} from './drag-to-play.js';

/** Matches the shipped DRAG_START_THRESHOLD_PX; named here so tests read clearly. */
const THRESHOLD = 8;
const ZONE: DropRect = { left: 100, top: 100, right: 300, bottom: 200 };

describe('pointInRect', () => {
  it('counts edges as inside — a drop on the border drops', () => {
    expect(pointInRect(100, 100, ZONE)).toBe(true);
    expect(pointInRect(300, 200, ZONE)).toBe(true);
    expect(pointInRect(99, 100, ZONE)).toBe(false);
    expect(pointInRect(150, 201, ZONE)).toBe(false);
  });
});

describe('press → small movement → release is a click, not a drag', () => {
  it('stays armed under the threshold so tap-to-play survives on touch screens', () => {
    // A finger tap always wobbles a few pixels; if that registered as a drag,
    // every tap would end as a zero-ish-distance drop and play nothing.
    let s = pressCard(7, 50, 50);
    s = moveDrag(s, 53, 54, ZONE, THRESHOLD); // ~5px — under threshold
    expect(s.phase).toBe('armed');
    const { dropId, wasDrag } = releaseDrag(s);
    expect(dropId).toBeNull();
    expect(wasDrag).toBe(false); // the browser's click must NOT be swallowed
  });
});

describe('a real drag', () => {
  it('commits once the pointer travels the threshold, in any direction', () => {
    const s = moveDrag(pressCard(7, 50, 50), 50, 50 - THRESHOLD, ZONE, THRESHOLD);
    expect(s.phase).toBe('dragging');
  });

  it('tracks the pointer offset and whether it is over the drop zone', () => {
    let s = pressCard(7, 50, 50);
    s = moveDrag(s, 150, 150, ZONE, THRESHOLD);
    expect(s).toMatchObject({ phase: 'dragging', dx: 100, dy: 100, overDrop: true });
    s = moveDrag(s, 50, 400, ZONE, THRESHOLD);
    expect(s).toMatchObject({ phase: 'dragging', dx: 0, dy: 350, overDrop: false });
  });

  it('released over the zone plays the card and flags the follow-up click for suppression', () => {
    const s = moveDrag(pressCard(7, 50, 50), 150, 150, ZONE, THRESHOLD);
    const { next, dropId, wasDrag } = releaseDrag(s);
    expect(dropId).toBe(7);
    expect(wasDrag).toBe(true); // one gesture must not also fire the click path
    expect(next).toBe(DRAG_IDLE);
  });

  it('released anywhere else cancels without playing', () => {
    const s = moveDrag(pressCard(7, 50, 50), 50, 400, ZONE, THRESHOLD);
    const { dropId, wasDrag } = releaseDrag(s);
    expect(dropId).toBeNull();
    expect(wasDrag).toBe(true); // still a drag — the click is still swallowed
  });

  it('never drops when the zone is not rendered', () => {
    const s = moveDrag(pressCard(7, 50, 50), 150, 150, null, THRESHOLD);
    expect(s).toMatchObject({ phase: 'dragging', overDrop: false });
  });

  it('does not un-commit when the pointer wanders back near the start', () => {
    // Once dragging, a pass through the start point must not revert to armed —
    // the ghost would snap home mid-gesture.
    let s = moveDrag(pressCard(7, 50, 50), 150, 150, ZONE, THRESHOLD);
    s = moveDrag(s, 51, 51, ZONE, THRESHOLD);
    expect(s.phase).toBe('dragging');
  });
});

describe('lifecycle edges', () => {
  it('a move with nothing in flight stays idle', () => {
    expect(moveDrag(DRAG_IDLE, 10, 10, ZONE, THRESHOLD)).toBe(DRAG_IDLE);
  });

  it('cancel aborts from any phase', () => {
    expect(cancelDrag()).toBe(DRAG_IDLE);
  });

  it('releasing an idle state is a harmless no-op', () => {
    const { dropId, wasDrag, next } = releaseDrag(DRAG_IDLE);
    expect(dropId).toBeNull();
    expect(wasDrag).toBe(false);
    expect(next).toBe(DRAG_IDLE);
  });
});
