import { describe, expect, it } from 'vitest';
import {
  idleTurnNote,
  isMainPhase,
  reasonCardIsDisabled,
  type DisabledContext,
} from './why-disabled.js';

const LAND = { isLand: true };
const SPELL = { isLand: false };

function ctx(over: Partial<DisabledContext> = {}): DisabledContext {
  return {
    yourTurn: true,
    yourTurnToAct: true,
    step: 'precombatMain',
    waitingOn: 'Alice',
    anyLandOffered: true,
    ...over,
  };
}

describe('isMainPhase', () => {
  it('is true for exactly the two main phases', () => {
    expect(isMainPhase('precombatMain')).toBe(true);
    expect(isMainPhase('postcombatMain')).toBe(true);
    for (const s of ['untap', 'upkeep', 'draw', 'declareAttackers', 'end', 'cleanup']) {
      expect(isMainPhase(s), s).toBe(false);
    }
  });
});

describe('reasonCardIsDisabled', () => {
  it('names the player being waited on when we lack priority', () => {
    expect(reasonCardIsDisabled(ctx({ yourTurn: false }), LAND)).toBe(
      "Waiting for Alice — you don't have priority yet.",
    );
  });

  it('explains the opening upkeep window that made the game look broken', () => {
    // The exact reported state: priority held, hand full, land greyed out.
    expect(reasonCardIsDisabled(ctx({ step: 'upkeep' }), LAND)).toBe(
      'Lands can only be played in your main phase.',
    );
  });

  it('distinguishes a spent land drop from the wrong step', () => {
    expect(reasonCardIsDisabled(ctx({ anyLandOffered: false }), LAND)).toBe(
      "You've already played a land this turn.",
    );
  });

  it("says a land can't be played on the opponent's turn", () => {
    expect(reasonCardIsDisabled(ctx({ yourTurnToAct: false }), LAND)).toBe(
      'You can only play a land on your own turn.',
    );
  });

  it('returns nothing for a land that is actually playable', () => {
    expect(reasonCardIsDisabled(ctx(), LAND)).toBeUndefined();
  });

  it('keeps the spell reason general rather than guessing wrongly', () => {
    // The masked view carries neither the card's timing nor its cost, so naming
    // one specific cause would be a claim we cannot support.
    expect(reasonCardIsDisabled(ctx(), SPELL)).toMatch(/tap lands for mana/);
    expect(reasonCardIsDisabled(ctx({ step: 'upkeep' }), SPELL)).toBe(
      'Only instant-speed plays are allowed in this step.',
    );
  });
});

describe('idleTurnNote', () => {
  it('tells a stuck player to pass when nothing at all is available', () => {
    expect(idleTurnNote({ yourTurn: true, hasAnyPlay: false, step: 'upkeep' })).toMatch(
      /Pass \/ advance/,
    );
  });

  it('stays quiet when the player has something to do', () => {
    expect(
      idleTurnNote({ yourTurn: true, hasAnyPlay: true, step: 'precombatMain' }),
    ).toBeUndefined();
  });

  it('stays quiet for the seat without priority (the bar already says who we wait on)', () => {
    expect(idleTurnNote({ yourTurn: false, hasAnyPlay: false, step: 'upkeep' })).toBeUndefined();
  });
});
