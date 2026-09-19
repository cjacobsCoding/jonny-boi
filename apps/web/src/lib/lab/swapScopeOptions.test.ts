/**
 * THE "HOW MANY COPIES" MENU FOLLOWS THE LINE (§3.165).
 *
 * > "if there is only one copy of the card in the deck, it shouldn't give all
 * > those options to swap 1, 2, 3, ect- that makes no sense"
 */
import { describe, expect, it } from 'vitest';
import { copiesForScope } from '@jonny-boi/sim';
import { reconcileScope, scopeFromOptionValue, scopeOptionValue, swapScopeOptions } from './swapScopeOptions.js';

describe('swapScopeOptions', () => {
  it('a 1-of has exactly one choice — the copy', () => {
    const options = swapScopeOptions(1);
    expect(options).toHaveLength(1);
    expect(options[0]!.scope).toBe('one');
    expect(options[0]!.label).toMatch(/only copy/);
  });

  it('a 2-of offers the playset and the single copy, and no "exactly 2" (that IS the playset)', () => {
    expect(swapScopeOptions(2).map((o) => o.value)).toEqual(['playset', 'one']);
  });

  it('a 4-of offers the playset, the single copy, and exactly 2 and 3', () => {
    const options = swapScopeOptions(4);
    expect(options.map((o) => o.value)).toEqual(['playset', 'one', '2', '3']);
    expect(options[0]!.label).toMatch(/All 4 copies/);
    // Every choice moves a DIFFERENT number of copies out of the line — the
    // whole point of trimming the menu is that no two entries mean the same.
    const moved = options.map((o) => copiesForScope(4, o.scope));
    expect(new Set(moved).size).toBe(moved.length);
    expect(moved).toEqual([4, 1, 2, 3]);
  });

  it('with no card picked yet, the two named questions', () => {
    expect(swapScopeOptions(undefined).map((o) => o.value)).toEqual(['playset', 'one']);
  });

  it('a nonsense line is treated as one', () => {
    expect(swapScopeOptions(0)).toHaveLength(1);
    expect(swapScopeOptions(2.7).map((o) => o.value)).toEqual(['playset', 'one']);
  });
});

describe('the option value round-trips a scope', () => {
  it('named scopes and counts', () => {
    for (const scope of ['playset', 'one', { copies: 2 }, { copies: 3 }] as const) {
      expect(scopeFromOptionValue(scopeOptionValue(scope))).toEqual(scope);
    }
    expect(scopeFromOptionValue('garbage')).toEqual({ copies: 1 });
  });
});

describe('reconcileScope — picking a 1-of after a 4-of cannot leave "exactly 3" selected', () => {
  it('keeps a scope the new menu still offers, else snaps to the first entry', () => {
    expect(reconcileScope({ copies: 3 }, swapScopeOptions(4))).toEqual({ copies: 3 });
    expect(reconcileScope({ copies: 3 }, swapScopeOptions(1))).toBe('one');
    expect(reconcileScope('playset', swapScopeOptions(1))).toBe('one');
    expect(reconcileScope('one', swapScopeOptions(3))).toBe('one');
    expect(reconcileScope({ copies: 3 }, swapScopeOptions(3)), '"exactly 3" of a 3-of is the playset').toBe('playset');
  });
});
