import { describe, expect, it } from 'vitest';

import { contrastRatio, parseHexColor, relativeLuminance } from './contrast.js';

describe('contrast — WCAG 2.1 arithmetic', () => {
  it('spans the full range: identical colors are 1:1, black on white is 21:1', () => {
    expect(contrastRatio('#123456', '#123456')).toBe(1);
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
  });

  it('is order-independent (the lighter color always goes on top)', () => {
    expect(contrastRatio('#9aa6b2', '#0f1419')).toBe(contrastRatio('#0f1419', '#9aa6b2'));
  });

  it('reproduces the reviewer’s measured ratios from TMB-JB-0003/0004', () => {
    // These pairs were measured with `tmb contrast` on real captures. If this
    // implementation drifts from the tool the findings were filed with, every
    // token assertion built on it is meaningless — so anchor it to the same
    // numbers the findings quote.
    expect(contrastRatio('#6b7785', '#121921')).toBeCloseTo(3.88, 2); // TMB-JB-0003, pool count as filed
    expect(contrastRatio('#161d25', '#0f1419')).toBeCloseTo(1.09, 2); // TMB-JB-0004, launcher vs page as filed
    expect(contrastRatio('#4d565e', '#161d25')).toBeCloseTo(2.27, 2); // TMB-JB-0004, dots vs fill as filed
  });

  it('expands #rgb shorthand the CSS way', () => {
    expect(parseHexColor('#fff')).toEqual([255, 255, 255]);
    expect(parseHexColor('#1a2b3c')).toEqual([26, 43, 60]);
    expect(relativeLuminance('#fff')).toBe(relativeLuminance('#ffffff'));
  });

  it('refuses anything that is not a hex color, loudly', () => {
    expect(() => parseHexColor('red')).toThrowError(/Not a hex color/);
    expect(() => parseHexColor('#12345')).toThrowError(/Not a hex color/);
    expect(() => contrastRatio('var(--color-fg)', '#000')).toThrowError(/Not a hex color/);
  });

  it('places white’s luminance at 1 and black’s at 0', () => {
    expect(relativeLuminance('#ffffff')).toBeCloseTo(1, 10);
    expect(relativeLuminance('#000000')).toBe(0);
  });
});
