/**
 * Which ends of a horizontally scrolling strip still have content past them.
 *
 * The header nav becomes a swipe strip on phones, and a strip that hides its
 * scrollbar is indistinguishable from a complete row — at 390px the bar ended
 * after "Play" and four of the seven destinations were undiscoverable
 * (TMB-JB-0002). `App.tsx` feeds this the strip's live scroll metrics and
 * turns the answer into the `.app__nav-wrap--more-*` classes that draw the
 * edge fades and chevrons in `styles.css`.
 *
 * Pure on purpose: the DOM reads happen in the component; the decision is
 * arithmetic, so it can be unit-tested without a layout engine.
 */

/**
 * Browsers report fractional scroll positions (zoom, DPI scaling, momentum
 * settle), so "at the end" must tolerate sub-pixel remainders or the cue
 * flickers on the very devices it exists for.
 */
export const NAV_OVERFLOW_EPSILON_PX = 1;

export interface NavOverflow {
  /** True when content continues past the start (left, in LTR) edge. */
  readonly start: boolean;
  /** True when content continues past the end (right, in LTR) edge. */
  readonly end: boolean;
}

/** The no-overflow answer, shared so callers can seed state without a DOM read. */
export const NAV_FITS: NavOverflow = { start: false, end: false };

/**
 * Decide which overflow cues a scroll strip needs, from the three numbers the
 * DOM exposes: `scrollLeft`, `clientWidth` and `scrollWidth`.
 */
export function computeNavOverflow(
  scrollLeft: number,
  clientWidth: number,
  scrollWidth: number,
  epsilonPx: number = NAV_OVERFLOW_EPSILON_PX,
): NavOverflow {
  const maxScrollLeft = scrollWidth - clientWidth;
  if (maxScrollLeft <= epsilonPx) {
    return NAV_FITS; // everything fits: a fade here would claim content that does not exist
  }
  return {
    start: scrollLeft > epsilonPx,
    end: scrollLeft < maxScrollLeft - epsilonPx,
  };
}
