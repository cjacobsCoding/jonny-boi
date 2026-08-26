import { describe, expect, it } from 'vitest';

import { NAV_FITS, NAV_OVERFLOW_EPSILON_PX, computeNavOverflow } from './nav-overflow.js';

/**
 * The finding this guards: TMB-JB-0002 — at 390px the nav strip ended after
 * "Play" with nothing to distinguish "this is all of it" from "there is more
 * off-screen". The numbers below mirror that capture: a ~370px strip holding
 * ~600px of tabs.
 */
const PHONE_STRIP_WIDTH = 370;
const PHONE_CONTENT_WIDTH = 600;

describe('computeNavOverflow — which ends still hide tabs', () => {
  it('shows no cues when every tab fits (desktop)', () => {
    expect(computeNavOverflow(0, 1200, 600)).toEqual({ start: false, end: false });
    expect(computeNavOverflow(0, 600, 600)).toEqual({ start: false, end: false });
  });

  it('cues the trailing end on an unscrolled phone strip — the TMB-JB-0002 frame', () => {
    expect(computeNavOverflow(0, PHONE_STRIP_WIDTH, PHONE_CONTENT_WIDTH)).toEqual({
      start: false,
      end: true,
    });
  });

  it('cues both ends mid-swipe', () => {
    expect(computeNavOverflow(100, PHONE_STRIP_WIDTH, PHONE_CONTENT_WIDTH)).toEqual({
      start: true,
      end: true,
    });
  });

  it('drops the trailing cue once the last tab is reached', () => {
    const maxScrollLeft = PHONE_CONTENT_WIDTH - PHONE_STRIP_WIDTH;
    expect(computeNavOverflow(maxScrollLeft, PHONE_STRIP_WIDTH, PHONE_CONTENT_WIDTH)).toEqual({
      start: true,
      end: false,
    });
  });

  it('tolerates the fractional scroll positions real devices settle on', () => {
    const maxScrollLeft = PHONE_CONTENT_WIDTH - PHONE_STRIP_WIDTH;
    // Momentum scrolling on Android routinely stops within a fraction of a
    // pixel of the end; the cue must not flicker back on for that.
    expect(
      computeNavOverflow(maxScrollLeft - 0.5, PHONE_STRIP_WIDTH, PHONE_CONTENT_WIDTH).end,
    ).toBe(false);
    expect(computeNavOverflow(0.5, PHONE_STRIP_WIDTH, PHONE_CONTENT_WIDTH).start).toBe(false);
  });

  it('treats sub-epsilon overflow as fitting — no cue for content that cannot be revealed', () => {
    expect(
      computeNavOverflow(0, PHONE_STRIP_WIDTH, PHONE_STRIP_WIDTH + NAV_OVERFLOW_EPSILON_PX),
    ).toEqual(NAV_FITS);
  });

  it('starts cueing just past the epsilon', () => {
    const slack = NAV_OVERFLOW_EPSILON_PX + 0.01;
    expect(computeNavOverflow(0, PHONE_STRIP_WIDTH, PHONE_STRIP_WIDTH + slack).end).toBe(true);
  });
});
