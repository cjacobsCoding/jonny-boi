/**
 * §3.57 — which blocker→attacker lines exist per frame (the SVG only draws
 * what this decides).
 */
import { describe, expect, it } from 'vitest';
import { blockerLinePairs } from './combat-lines.js';

const NO_DRAFT = new Map<number, number>();

describe('blockerLinePairs', () => {
  it('draws the local draft (dashed/undeclared) while declaring blockers', () => {
    const lines = blockerLinePairs({
      step: 'declareBlockers',
      declaredBlocks: [],
      draftAssign: new Map([
        [21, 31],
        [22, 31],
      ]),
    });
    expect(lines).toEqual([
      { blocker: 21, attacker: 31, declared: false },
      { blocker: 22, attacker: 31, declared: false },
    ]);
  });

  it('draws declared blocks through damage and end of combat', () => {
    for (const step of ['declareBlockers', 'combatDamage', 'endCombat']) {
      const lines = blockerLinePairs({
        step,
        declaredBlocks: [{ blocker: 21, attacker: 31 }],
        draftAssign: NO_DRAFT,
      });
      expect(lines, step).toEqual([{ blocker: 21, attacker: 31, declared: true }]);
    }
  });

  it('a declared block wins over a stale draft entry for the same blocker', () => {
    const lines = blockerLinePairs({
      step: 'declareBlockers',
      declaredBlocks: [{ blocker: 21, attacker: 31 }],
      draftAssign: new Map([[21, 32]]),
    });
    expect(lines).toEqual([{ blocker: 21, attacker: 31, declared: true }]);
  });

  it('draws nothing outside combat steps, and no draft after the declare step', () => {
    expect(
      blockerLinePairs({ step: 'precombatMain', declaredBlocks: [{ blocker: 1, attacker: 2 }], draftAssign: NO_DRAFT }),
    ).toEqual([]);
    expect(
      blockerLinePairs({ step: 'combatDamage', declaredBlocks: undefined, draftAssign: new Map([[21, 31]]) }),
    ).toEqual([]);
  });
});
