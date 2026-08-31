/**
 * §3.57 report 4 — the declare-attackers hint must match the buttons on
 * screen: with no eligible attackers the only control is "Pass priority", so
 * the copy must not promise an "attack with none" button that does not exist.
 *
 * §3.59 — the same rule on the blocking side, found in the SHIPPED build: a
 * defender with an empty battlefield was told to "tap … your creature, to
 * block". These tests pin both halves and, deliberately, the symmetry between
 * them: whatever the attack branch promises about declaring-vs-responding, the
 * block branch must promise too.
 */
import { describe, expect, it } from 'vitest';
import { actionBarHint, NO_ATTACKERS_HINT, NO_BLOCKERS_HINT } from './action-hints.js';

const base = {
  isAttackWindow: true,
  hasAttackers: true,
  isBlockWindow: true,
  hasBlockers: true,
  hasEnemyWalkers: false,
  mainPhaseFlavor: 'hotseat',
} as const;

describe('actionBarHint — declare attackers', () => {
  it('says "no attackers — pass" when the attack template is absent/empty', () => {
    const hint = actionBarHint('declareAttackers', { ...base, hasAttackers: false });
    expect(hint).toBe(NO_ATTACKERS_HINT);
    expect(hint).not.toMatch(/attack with none/i);
  });

  it('keeps the normal copy when the seat can actually attack', () => {
    expect(actionBarHint('declareAttackers', base)).toMatch(/attack with none/i);
    expect(actionBarHint('declareAttackers', { ...base, hasEnemyWalkers: true })).toMatch(/planeswalker/i);
  });

  it('the defender responding in the same step gets the response copy, not attack copy', () => {
    const hint = actionBarHint('declareAttackers', { ...base, isAttackWindow: false, hasAttackers: false });
    expect(hint).toMatch(/respon/i);
    expect(hint).not.toBe(NO_ATTACKERS_HINT);
  });
});

describe('actionBarHint — declare blockers (§3.59)', () => {
  it('says "no creatures to block with" instead of naming a creature the seat lacks', () => {
    const hint = actionBarHint('declareBlockers', { ...base, hasBlockers: false });
    expect(hint).toBe(NO_BLOCKERS_HINT);
    expect(hint).not.toMatch(/tap an attacker/i);
    // The reported failure verbatim: copy that tells you to use "your creature"
    // when you control none. It must not come back on this path.
    expect(hint).not.toMatch(/your creature/i);
  });

  it('keeps the assignment copy when the defender actually has blockers', () => {
    expect(actionBarHint('declareBlockers', base)).toMatch(/tap an attacker, then your creature/i);
  });

  it('the attacking seat responding in the same step gets the response copy', () => {
    const hint = actionBarHint('declareBlockers', { ...base, isBlockWindow: false, hasBlockers: false });
    expect(hint).toMatch(/respon/i);
    expect(hint).not.toBe(NO_BLOCKERS_HINT);
  });

  it('treats both combat steps the same way — no seat is ever told to use what it lacks', () => {
    // The symmetry itself, so a future edit to one branch cannot quietly
    // re-open the defect on the other.
    const empty = { ...base, hasAttackers: false, hasBlockers: false };
    expect(actionBarHint('declareAttackers', empty)).toBe(NO_ATTACKERS_HINT);
    expect(actionBarHint('declareBlockers', empty)).toBe(NO_BLOCKERS_HINT);
    for (const step of ['declareAttackers', 'declareBlockers']) {
      const responding = actionBarHint(step, { ...empty, isAttackWindow: false, isBlockWindow: false });
      expect(responding).toMatch(/respon/i);
    }
  });
});

describe('actionBarHint — the shared table', () => {
  it('keeps each board’s main-phase flavor', () => {
    expect(actionBarHint('precombatMain', base)).toBe(
      'Play a land or cast a spell from your hand, or pass to advance.',
    );
    expect(actionBarHint('postcombatMain', { ...base, mainPhaseFlavor: 'online' })).toMatch(/tap your sources/i);
  });

  it('covers blockers and the default response window', () => {
    expect(actionBarHint('declareBlockers', base)).toMatch(/block/i);
    expect(actionBarHint('upkeep', base)).toMatch(/pass priority/i);
  });
});
