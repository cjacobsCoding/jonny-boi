import { describe, expect, it } from 'vitest';
import { addMana, canPay, convertedManaCost, emptyPool, payCost, poolTotal } from './mana.js';

describe('mana', () => {
  it('empty pool has zero of everything', () => {
    const p = emptyPool();
    expect(poolTotal(p)).toBe(0);
  });

  it('addMana is immutable and accumulates', () => {
    const p0 = emptyPool();
    const p1 = addMana(p0, 'U', 2);
    expect(p0.U).toBe(0);
    expect(p1.U).toBe(2);
    expect(poolTotal(p1)).toBe(2);
  });

  it('convertedManaCost sums all pips', () => {
    expect(convertedManaCost({ generic: 2, U: 1 })).toBe(3);
    expect(convertedManaCost({ W: 1, B: 1, R: 1 })).toBe(3);
    expect(convertedManaCost({})).toBe(0);
  });

  it('pays a colored cost from matching color', () => {
    let pool = emptyPool();
    pool = addMana(pool, 'U', 1);
    pool = addMana(pool, 'C', 2);
    const r = payCost(pool, { generic: 2, U: 1 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(poolTotal(r.pool)).toBe(0);
  });

  it('rejects when a specific color is short', () => {
    let pool = emptyPool();
    pool = addMana(pool, 'C', 3);
    const r = payCost(pool, { U: 1 });
    expect(r.ok).toBe(false);
  });

  it('rejects when generic cannot be covered', () => {
    let pool = emptyPool();
    pool = addMana(pool, 'C', 1);
    expect(canPay(pool, { generic: 2 })).toBe(false);
  });

  it('spends colorless before colored for the generic portion', () => {
    let pool = emptyPool();
    pool = addMana(pool, 'C', 1);
    pool = addMana(pool, 'G', 1);
    // Pay {1}{G}: G symbol from G, generic {1} should take the C first.
    const r = payCost(pool, { generic: 1, G: 1 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(poolTotal(r.pool)).toBe(0);
  });

  it('does not mutate the input pool', () => {
    const pool = addMana(emptyPool(), 'R', 3);
    payCost(pool, { generic: 1 });
    expect(pool.R).toBe(3);
  });
});
