import { describe, expect, it } from 'vitest';
import { computeUpscaledSize } from './upscale.js';

describe('computeUpscaledSize', () => {
  it('scales width and height by the factor, rounding to whole pixels', () => {
    expect(computeUpscaledSize({ width: 745, height: 1040 }, 2)).toEqual({
      width: 1490,
      height: 2080,
    });
    expect(computeUpscaledSize({ width: 100, height: 51 }, 1.5)).toEqual({
      width: 150,
      height: 77, // 76.5 → 77
    });
  });

  it('treats a non-positive or non-finite factor as a 1× no-op', () => {
    expect(computeUpscaledSize({ width: 100, height: 200 }, 0)).toEqual({
      width: 100,
      height: 200,
    });
    expect(computeUpscaledSize({ width: 100, height: 200 }, Number.NaN)).toEqual({
      width: 100,
      height: 200,
    });
  });

  it('never produces a zero/NaN dimension from a bad source', () => {
    expect(computeUpscaledSize({ width: 0, height: 0 }, 2)).toEqual({
      width: 1,
      height: 1,
    });
    expect(computeUpscaledSize({ width: Number.NaN, height: -5 }, 2)).toEqual({
      width: 1,
      height: 1,
    });
  });
});
