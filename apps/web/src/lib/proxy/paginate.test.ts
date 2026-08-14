import { describe, expect, it } from 'vitest';
import {
  buildPages,
  expandCopies,
  paginate,
  totalCopies,
  type CountedProxyCard,
} from './paginate.js';

const card = (name: string, qty: number): CountedProxyCard => ({
  name,
  imageUrl: `https://img/${name}.png`,
  qty,
});

describe('expandCopies', () => {
  it('expands quantities to one entry per copy, preserving order', () => {
    const out = expandCopies([card('Bolt', 2), card('Mountain', 3)]);
    expect(out.map((c) => c.name)).toEqual(['Bolt', 'Bolt', 'Mountain', 'Mountain', 'Mountain']);
  });

  it('drops non-positive and fractional-down quantities safely', () => {
    const out = expandCopies([card('Zero', 0), { ...card('Half', 1), qty: 1.9 }]);
    expect(out.map((c) => c.name)).toEqual(['Half']);
  });

  // Regression: an unbounded expansion built one DOM node per copy, so a
  // mistyped `2000 Mountain` froze the main thread for seconds per keystroke.
  it('stops at the cap instead of expanding an enormous quantity', () => {
    const out = expandCopies([card('Mountain', 9999)], 12);
    expect(out).toHaveLength(12);
  });

  it('spends the cap across entries in list order', () => {
    const out = expandCopies([card('Bolt', 4), card('Mountain', 100)], 6);
    expect(out.map((c) => c.name)).toEqual([
      'Bolt',
      'Bolt',
      'Bolt',
      'Bolt',
      'Mountain',
      'Mountain',
    ]);
  });

  it('leaves a list under the cap untouched', () => {
    expect(expandCopies([card('Bolt', 4)], 100)).toHaveLength(4);
  });
});

describe('totalCopies', () => {
  it('reports what the list asked for, independent of any cap', () => {
    expect(totalCopies([card('Mountain', 9999), card('Bolt', 4)])).toBe(10003);
  });

  it('ignores non-positive quantities', () => {
    expect(totalCopies([card('Zero', 0), { ...card('Neg', 1), qty: -5 }])).toBe(0);
  });
});

describe('paginate', () => {
  it('chunks into pages of N (19 → 9 / 9 / 1)', () => {
    const cards = Array.from({ length: 19 }, (_, i) => ({
      name: `c${i}`,
      imageUrl: `https://img/${i}.png`,
    }));
    const pages = paginate(cards, 9);
    expect(pages.map((p) => p.length)).toEqual([9, 9, 1]);
  });

  it('returns no pages for an empty list', () => {
    expect(paginate([], 9)).toEqual([]);
  });

  it('throws on a non-positive per-page size', () => {
    expect(() => paginate([], 0)).toThrow();
  });
});

describe('buildPages', () => {
  it('expands then paginates (4+9+9 = 22 cards → 9/9/4 at 9 per page)', () => {
    const pages = buildPages([card('Bolt', 4), card('Mountain', 9), card('Island', 9)], 9);
    expect(pages.map((p) => p.length)).toEqual([9, 9, 4]);
    expect(pages[0]!.slice(0, 4).map((c) => c.name)).toEqual(['Bolt', 'Bolt', 'Bolt', 'Bolt']);
  });

  it('bounds the page count when a quantity is absurd', () => {
    const pages = buildPages([card('Mountain', 9999)], 9, 36);
    expect(pages).toHaveLength(4);
    expect(pages.flat()).toHaveLength(36);
  });

  it('carries a DFC back-face label through expansion', () => {
    const pages = buildPages(
      [{ name: 'Delver', imageUrl: 'front.png', qty: 1, faceLabel: 'back' }],
      9,
    );
    expect(pages[0]![0]!.faceLabel).toBe('back');
  });
});
