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
import { shortenStorageKey } from './state-dump.js';
import {
  attemptNote,
  CAPTURE_ATTEMPTS,
  CAPTURE_TIMEOUT_MS,
  captureFailureNote,
  captureOptionsFor,
  dataUrlToBytes,
  isOffScreen,
  lastAnchoringChild,
  optionIsPrunable,
  prunableChildIndices,
  pruningAllowedIn,
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

  it('never prunes the rows of a table — the one-row-fills-the-list regression (20260918_215728)', () => {
    // The rasteriser copies computed heights onto the clone, so a table with
    // its below-fold rows dropped keeps its full height and the surviving row
    // is stretched across it. Table parts keep every child; a div grid does not.
    for (const part of ['TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'tbody']) {
      expect(pruningAllowedIn(part), part).toBe(false);
    }
    for (const block of ['DIV', 'UL', 'SECTION', 'MAIN', 'BODY']) {
      expect(pruningAllowedIn(block), block).toBe(true);
    }
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

/**
 * §3.119 — bug report 20260902_231525: "bug reporter not working, says screen
 * could not be captured", with `page rasterisation timed out after 12000 ms`
 * filed from the Lab.
 *
 * Measured from the report's OWN clip: 10,540 DOM nodes, of which 5,140 are
 * `<option>` — the A/B Swap tab's two card pickers over the whole pool. The
 * below-fold pruning cannot touch them (an `<option>` has no box, and dropping
 * boxless children once emptied a dropdown's label), so the narrower rule is
 * the one that holds: a CLOSED select paints only its selected option.
 */
describe('option pruning (the Lab timeout)', () => {
  it('drops the unselected options of a closed select — 5,138 of the Lab’s 5,140', () => {
    expect(optionIsPrunable({ selected: false, multiple: false, size: 0 })).toBe(true);
    expect(optionIsPrunable({ selected: false, multiple: false, size: 1 })).toBe(true);
  });

  it('KEEPS the selected option — the sort-dropdown regression must not come back', () => {
    expect(optionIsPrunable({ selected: true, multiple: false, size: 0 })).toBe(false);
  });

  it('keeps every option of a list box, which really does draw them', () => {
    expect(optionIsPrunable({ selected: false, multiple: true, size: 0 })).toBe(false);
    expect(optionIsPrunable({ selected: false, multiple: false, size: 6 })).toBe(false);
  });
});

describe('the capture attempt ladder', () => {
  it('tries the honest picture first, then one that gives up art and fonts', () => {
    expect(CAPTURE_ATTEMPTS.map((a) => a.id)).toEqual(['full', 'reduced']);
    const [full, reduced] = CAPTURE_ATTEMPTS;
    expect(full?.timeoutMs).toBe(CAPTURE_TIMEOUT_MS);
    expect(full?.skipFonts).toBe(false);
    expect(full?.dropImages).toBe(false);
    expect(reduced?.skipFonts).toBe(true);
    expect(reduced?.dropImages).toBe(true);
    // The fallback exists to FINISH, so it must not be given a longer rope.
    expect(reduced?.timeoutMs).toBeLessThan(CAPTURE_TIMEOUT_MS);
  });

  it('the clean attempt carries no note; the degraded one says what it gave up', () => {
    expect(attemptNote(CAPTURE_ATTEMPTS[0]!)).toBe('');
    expect(attemptNote(CAPTURE_ATTEMPTS[1]!)).toMatch(/timed out/);
    expect(attemptNote(CAPTURE_ATTEMPTS[1]!)).toMatch(/without card art/);
  });

  it('every attempt has a finite, positive budget', () => {
    for (const attempt of CAPTURE_ATTEMPTS) {
      expect(Number.isFinite(attempt.timeoutMs)).toBe(true);
      expect(attempt.timeoutMs).toBeGreaterThan(0);
    }
  });
});

describe('the dump does not drown in one feature’s keys', () => {
  it('elides a long key, keeping the prefix that names it and a distinguishing tail', () => {
    // The reporter's longest real key: the whole decklist inside the key.
    const long = `jonny-boi.suggest-history.v1.heuristic.${'a'.repeat(600)}:4|${'b'.repeat(60)}:4`;
    const short = shortenStorageKey(long);
    expect(short.length).toBeLessThanOrEqual(80);
    expect(short.startsWith('jonny-boi.suggest-history.v1.heuristic.')).toBe(true);
    expect(short).toContain('…');
    // Two keys that differ only at the end are still told apart.
    expect(shortenStorageKey(`${long}X`)).not.toBe(short);
  });

  it('leaves an ordinary key exactly as it is', () => {
    expect(shortenStorageKey('jonny-boi.decks.v1')).toBe('jonny-boi.decks.v1');
  });
});
