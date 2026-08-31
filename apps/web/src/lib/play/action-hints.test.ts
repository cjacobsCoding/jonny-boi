/**
 * §3.57 report 4 — the declare-attackers hint must match the buttons on
 * screen: with no eligible attackers the only control is "Pass priority", so
 * the copy must not promise an "attack with none" button that does not exist.
 */
import { describe, expect, it } from 'vitest';
import { actionBarHint, NO_ATTACKERS_HINT } from './action-hints.js';

const base = { isAttackWindow: true, hasAttackers: true, hasEnemyWalkers: false, mainPhaseFlavor: 'hotseat' } as const;

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
