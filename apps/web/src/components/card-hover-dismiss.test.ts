/**
 * Bug report 20260901_205453 — "A forest got stuck on my screen — it's even
 * over the debug overlay". The preview closed only on the anchor's own
 * `mouseleave`, which the browser does not fire when the pointer leaves via a
 * captured drag, a modal appearing over the tile, or the tile re-rendering
 * under a still cursor. These pin the closing rule `CardHover` now applies
 * document-wide while a preview is open.
 */
import { describe, expect, it } from 'vitest';
import { hoverShouldClose, type HoverSignal } from './card-hover-dismiss.js';

describe('hoverShouldClose', () => {
  it('a move OUTSIDE the anchor closes the preview — the missing mouseleave', () => {
    expect(hoverShouldClose('move', false)).toBe(true);
  });

  it('a move over the anchor is the hover continuing', () => {
    expect(hoverShouldClose('move', true)).toBe(false);
  });

  it('a press, a scroll, Escape and the window blurring close it wherever the pointer is', () => {
    for (const signal of ['press', 'scroll', 'escape', 'blur'] as const) {
      expect(hoverShouldClose(signal, true), `${signal} inside`).toBe(true);
      expect(hoverShouldClose(signal, false), `${signal} outside`).toBe(true);
    }
  });

  it('an ordinary key press does not (typing a note must not flicker the preview)', () => {
    expect(hoverShouldClose('otherKey', true)).toBe(false);
    expect(hoverShouldClose('otherKey', false)).toBe(false);
  });

  it('every signal has an answer in both positions (the table is closed)', () => {
    const all: HoverSignal[] = ['move', 'press', 'scroll', 'escape', 'otherKey', 'blur'];
    for (const signal of all) {
      expect(typeof hoverShouldClose(signal, true)).toBe('boolean');
      expect(typeof hoverShouldClose(signal, false)).toBe('boolean');
    }
  });
});
