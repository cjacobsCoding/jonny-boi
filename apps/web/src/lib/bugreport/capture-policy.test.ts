/**
 * Tests for the capture's decisions.
 *
 * These exist because of what could NOT be tested any other way. The rasteriser
 * is a third-party library that needs a real, VISIBLE browser: in a backgrounded
 * tab it never resolves at all, so no automated check here can prove the picture
 * comes out right. What CAN be pinned is every decision around it — the region
 * captured, what gets skipped, and the bound that keeps a hang from freezing the
 * app — and each of those was a defect first and a test second.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  CAPTURE_TIMEOUT_MS,
  captureFailureNote,
  captureOptionsFor,
  dataUrlToBytes,
  isOffScreen,
  lastAnchoringChild,
  prunableChildIndices,
  withTimeout,
} from './capture-policy.js';

const VIEWPORT = { width: 1280, height: 720 };

describe('isOffScreen', () => {
  it('keeps anything visible, including a sliver at an edge', () => {
    expect(isOffScreen({ left: 0, top: 0, right: 100, bottom: 100 }, VIEWPORT)).toBe(false);
    // One row of pixels showing is still part of the frame the reporter sees.
    expect(isOffScreen({ left: 0, top: 719, right: 100, bottom: 900 }, VIEWPORT)).toBe(false);
    expect(isOffScreen({ left: -50, top: 10, right: 0, bottom: 60 }, VIEWPORT)).toBe(false);
  });

  it('drops what is entirely outside, in every direction', () => {
    expect(isOffScreen({ left: 0, top: -300, right: 100, bottom: -1 }, VIEWPORT)).toBe(true);
    expect(isOffScreen({ left: 0, top: 721, right: 100, bottom: 900 }, VIEWPORT)).toBe(true);
    expect(isOffScreen({ left: -200, top: 0, right: -1, bottom: 100 }, VIEWPORT)).toBe(true);
    expect(isOffScreen({ left: 1281, top: 0, right: 1400, bottom: 100 }, VIEWPORT)).toBe(true);
  });
});

describe('captureOptionsFor', () => {
  it('sizes the output to the VIEWPORT, not the page', () => {
    const options = captureOptionsFor(VIEWPORT, { x: 0, y: 0 });
    expect(options.width).toBe(1280);
    expect(options.height).toBe(720);
  });

  it('translates the clone by the scroll offset, so the visible part is in frame', () => {
    const options = captureOptionsFor(VIEWPORT, { x: 0, y: 1500 });
    expect(options.style.transform).toBe('translate(0px, -1500px)');
    expect(options.style.transformOrigin).toBe('top left');
  });

  it('handles a horizontal scroll too', () => {
    expect(captureOptionsFor(VIEWPORT, { x: 40, y: 10 }).style.transform).toBe(
      'translate(-40px, -10px)',
    );
  });

  it('rounds sub-pixel values rather than emitting fractions into CSS', () => {
    const options = captureOptionsFor({ width: 1279.6, height: 719.4 }, { x: 12.7, y: 0.2 });
    expect(options.width).toBe(1280);
    expect(options.height).toBe(719);
    expect(options.style.transform).toBe('translate(-13px, 0px)');
  });

  it('never describes a zero-area canvas, whatever it is handed', () => {
    for (const viewport of [
      { width: 0, height: 0 },
      { width: -5, height: -5 },
      { width: Number.NaN, height: Number.POSITIVE_INFINITY },
    ]) {
      const options = captureOptionsFor(viewport, { x: Number.NaN, y: 0 });
      expect(options.width).toBeGreaterThanOrEqual(1);
      expect(options.height).toBeGreaterThanOrEqual(1);
      expect(options.style.transform).toContain('translate(');
      expect(options.style.transform).not.toContain('NaN');
    }
  });
});

describe('withTimeout', () => {
  it('passes a value through when the work finishes in time', async () => {
    await expect(withTimeout(Promise.resolve('done'), 1000, 'work')).resolves.toBe('done');
  });

  it('passes the original failure through, not a timeout, when the work rejects', async () => {
    await expect(withTimeout(Promise.reject(new Error('boom')), 1000, 'work')).rejects.toThrow(
      'boom',
    );
  });

  it('gives up on work that never settles — the case that freezes the app', async () => {
    vi.useFakeTimers();
    try {
      const hangs = new Promise<string>(() => {
        /* deliberately never settles, like a rasterisation in a hidden tab */
      });
      const guarded = withTimeout(hangs, CAPTURE_TIMEOUT_MS, 'page rasterisation');
      const assertion = expect(guarded).rejects.toThrow(
        `page rasterisation timed out after ${CAPTURE_TIMEOUT_MS} ms`,
      );
      await vi.advanceTimersByTimeAsync(CAPTURE_TIMEOUT_MS + 1);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('has a FINITE budget — an unbounded one is the defect this guards', () => {
    expect(Number.isFinite(CAPTURE_TIMEOUT_MS)).toBe(true);
    expect(CAPTURE_TIMEOUT_MS).toBeGreaterThan(0);
  });
});

describe('captureFailureNote', () => {
  it('names the cause AND what the report still carries', () => {
    const note = captureFailureNote(new Error('timed out'));
    expect(note).toContain('timed out');
    // Without this half, a reader sees "screenshot failed" and assumes the whole
    // report is junk.
    expect(note).toContain('state dump');
    expect(note).toContain('console ring');
  });
});

describe('dataUrlToBytes', () => {
  it('decodes the payload after the comma', () => {
    // "hi" in base64.
    expect(Array.from(dataUrlToBytes('data:text/plain;base64,aGk='))).toEqual([104, 105]);
  });

  it('returns nothing for a string that is not a data URL, rather than throwing', () => {
    expect(dataUrlToBytes('').length).toBe(0);
    expect(dataUrlToBytes('not-a-data-url').length).toBe(0);
  });
});

describe('pruning the below-fold tail', () => {
  const FOLD = 800;

  it('drops the trailing children that start below the fold', () => {
    // Four rows of a grid; the last two are scrolled off the bottom.
    expect(prunableChildIndices([0, 400, 900, 1400], FOLD)).toEqual([2, 3]);
  });

  it('keeps everything when nothing is below the fold', () => {
    expect(prunableChildIndices([0, 100, 200], FOLD)).toEqual([]);
  });

  it('keeps a below-fold child that is followed by a visible one', () => {
    // Removing from the MIDDLE can re-flow the ones after it, so only a
    // trailing run is ever safe to drop.
    expect(prunableChildIndices([0, 900, 200, 1400], FOLD)).toEqual([3]);
  });

  it('keeps a child scrolled off the TOP — it is holding the rest down', () => {
    expect(prunableChildIndices([-500, -100, 300], FOLD)).toEqual([]);
  });

  it('treats the fold as inclusive, so a child starting exactly at it stays', () => {
    expect(prunableChildIndices([0, FOLD], FOLD)).toEqual([]);
    expect(prunableChildIndices([0, FOLD + 1], FOLD)).toEqual([1]);
  });

  it('never drops a child it could not measure — the <option> regression', () => {
    // <option> elements have no bounding box. An earlier rule dropped every
    // child after the last MEASURABLE one, which emptied the sort dropdown: the
    // capture came back with a blank box where the word "Name" should be. A
    // boxless child is cheap to keep and may be drawing something.
    expect(prunableChildIndices([null, null, null], FOLD)).toEqual([]);
    expect(prunableChildIndices([0, null, null], FOLD)).toEqual([]);
  });

  it('never drops a child whose position is not a finite number', () => {
    expect(prunableChildIndices([0, Number.NaN, Number.POSITIVE_INFINITY], FOLD)).toEqual([]);
  });

  it('does not let a boxless LAST child block pruning — the launcher regression', () => {
    // The reporter's own launcher is position:fixed at the bottom of the
    // viewport and is the last node in the body. While it anchored the run,
    // nothing anywhere in the document was pruned and a capture took 11 s.
    expect(prunableChildIndices([0, 1200, 1600, null], FOLD)).toEqual([1, 2]);
  });

  it('reports the anchor separately from what is prunable', () => {
    expect(lastAnchoringChild([0, 400, 900, 1400], FOLD)).toBe(1);
    expect(lastAnchoringChild([null, null], FOLD)).toBe(-1);
    // A child scrolled off the top still anchors: it is on the page.
    expect(lastAnchoringChild([-500, 900], FOLD)).toBe(0);
  });

  it('handles an empty child list', () => {
    expect(prunableChildIndices([], FOLD)).toEqual([]);
    expect(lastAnchoringChild([], FOLD)).toBe(-1);
  });
});
