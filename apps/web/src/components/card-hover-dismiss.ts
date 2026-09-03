/**
 * WHEN a hover preview must close — the pure half of `CardHover`'s dismissal
 * (bug report 20260901_205453, a Forest preview stuck over the whole board).
 *
 * A preview is a claim that the pointer is over its anchor. Every signal below
 * is a moment that claim may have silently become false, and the table says for
 * each one whether it closes the preview regardless (a press, a scroll, Escape,
 * the window blurring — after any of those the player is no longer "hovering"
 * in any sense that matters) or only when the pointer is observed OUTSIDE the
 * anchor (a plain move over the anchor is the hover continuing).
 */
export type HoverSignal = 'move' | 'press' | 'scroll' | 'escape' | 'otherKey' | 'blur';

/** Whether the signal closes the preview even when the pointer is over the anchor. */
const CLOSES_UNCONDITIONALLY: Readonly<Record<HoverSignal, boolean>> = Object.freeze({
  move: false,
  press: true,
  scroll: true,
  escape: true,
  otherKey: false,
  blur: true,
});

/** Whether the signal closes the preview when the pointer is NOT over the anchor. */
const CLOSES_WHEN_OUTSIDE: Readonly<Record<HoverSignal, boolean>> = Object.freeze({
  move: true,
  press: true,
  scroll: true,
  escape: true,
  otherKey: false,
  blur: true,
});

/** Should an open preview close on this signal, given where the event landed? */
export function hoverShouldClose(signal: HoverSignal, targetInsideAnchor: boolean): boolean {
  return targetInsideAnchor ? CLOSES_UNCONDITIONALLY[signal] : CLOSES_WHEN_OUTSIDE[signal];
}
