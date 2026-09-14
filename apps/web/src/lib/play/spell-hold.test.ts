/**
 * The guards for UX-16. The board must pause on an opponent's spell EVEN WHEN
 * the viewer has no response — which is the whole complaint — and must not turn
 * a fast game into a click-through tax.
 */
import { describe, expect, it } from 'vitest';
import { SPELL_HOLD_CONFIG } from './play-config.js';
import { STACK_ENTRY_KINDS } from './stack-view.js';
import {
  HELD_STACK_KINDS,
  HOLD_KINDS,
  HOLD_REFUSALS,
  holdDurationMs,
  spellHoldDecision,
  type HoldRefusal,
  type SpellHoldContext,
} from './spell-hold.js';

const CFG = SPELL_HOLD_CONFIG;

function ctx(overrides: Partial<SpellHoldContext> = {}): SpellHoldContext {
  return {
    viewer: 'A',
    stackTop: { instanceId: 7, controller: 'B', kind: 'spell' },
    viewerWillStop: false,
    announced: new Set<number>(),
    holdsThisTurn: 0,
    gameOver: false,
    ...overrides,
  };
}

/** The reason a decision refused, or null if it held. */
function refusal(c: SpellHoldContext): HoldRefusal | null {
  const d = spellHoldDecision(c, CFG);
  return d.kind === 'refused' ? d.reason : null;
}

describe('the reported case', () => {
  it('an opponent’s spell holds even though the viewer is NOT being stopped for priority', () => {
    const decision = spellHoldDecision(ctx({ viewerWillStop: false }), CFG);
    expect(decision.kind).toBe('hold');
    if (decision.kind !== 'hold') return;
    expect(decision.hold.instanceId).toBe(7);
    expect(decision.hold.controller).toBe('B');
  });

  it('an opponent’s ACTIVATED ability holds too — it is just as invisible', () => {
    expect(refusal(ctx({ stackTop: { instanceId: 7, controller: 'B', kind: 'activated' } }))).toBeNull();
  });
});

describe('what a hold refuses, and why', () => {
  it('the viewer’s OWN object never holds', () => {
    expect(refusal(ctx({ stackTop: { instanceId: 7, controller: 'A', kind: 'spell' } }))).toBe(
      'yourOwnObject',
    );
  });

  it('an empty stack refuses', () => {
    expect(refusal(ctx({ stackTop: null }))).toBe('nothingOnStack');
  });

  it('a TRIGGER does not hold — it is not something the opponent chose to do now', () => {
    expect(refusal(ctx({ stackTop: { instanceId: 7, controller: 'B', kind: 'trigger' } }))).toBe(
      'kindNotHeld',
    );
  });

  it('the same object never holds twice', () => {
    expect(refusal(ctx({ announced: new Set([7]) }))).toBe('alreadyAnnounced');
  });

  it('a hold does not stack on top of a priority STOP', () => {
    expect(refusal(ctx({ viewerWillStop: true }))).toBe('alreadyStopping');
  });

  it('a storm turn spends its budget and then runs at full speed', () => {
    expect(refusal(ctx({ holdsThisTurn: CFG.maxHoldsPerTurn - 1 }))).toBeNull();
    expect(refusal(ctx({ holdsThisTurn: CFG.maxHoldsPerTurn }))).toBe('turnBudgetSpent');
    expect(refusal(ctx({ holdsThisTurn: CFG.maxHoldsPerTurn + 40 }))).toBe('turnBudgetSpent');
  });

  it('a finished game holds nothing', () => {
    expect(refusal(ctx({ gameOver: true }))).toBe('gameOver');
  });

  it('every refusal reason carries a sentence a player could read', () => {
    for (const [reason, sentence] of Object.entries(HOLD_REFUSALS)) {
      expect(sentence.length, reason).toBeGreaterThan(20);
    }
  });
});

describe('how long a hold lasts', () => {
  it('a pointer resting on the card extends it — and is still BOUNDED', () => {
    const idle = holdDurationMs({ pointerOver: false, extensions: 0 }, CFG);
    const reading = holdDurationMs({ pointerOver: true, extensions: 0 }, CFG);
    expect(idle).toBe(CFG.holdMs);
    expect(reading).toBe(CFG.pointerHoldMs);
    expect(reading).toBeGreaterThan(idle);
    expect(Number.isFinite(reading)).toBe(true);
  });

  it('each explicit "keep looking" press adds exactly one extendMs', () => {
    expect(holdDurationMs({ pointerOver: false, extensions: 2 }, CFG)).toBe(
      CFG.holdMs + 2 * CFG.extendMs,
    );
    expect(holdDurationMs({ pointerOver: true, extensions: 1 }, CFG)).toBe(
      CFG.pointerHoldMs + CFG.extendMs,
    );
  });

  it('a nonsense extension count cannot shorten a hold', () => {
    expect(holdDurationMs({ pointerOver: false, extensions: -5 }, CFG)).toBe(CFG.holdMs);
  });
});

describe('the kind table is closed and shared with the stack panel', () => {
  it('every stack kind the panel knows has a hold row with a reason', () => {
    for (const kind of STACK_ENTRY_KINDS) {
      expect(HOLD_KINDS[kind], kind).toBeDefined();
      expect(HOLD_KINDS[kind].why.length, kind).toBeGreaterThan(40);
    }
    // Both directions: no row may name a kind the panel does not have.
    expect(new Set(Object.keys(HOLD_KINDS))).toEqual(new Set(STACK_ENTRY_KINDS));
  });

  it('at least one kind holds, or UX-16 is a feature that never fires', () => {
    expect(HELD_STACK_KINDS.length).toBeGreaterThan(0);
    expect(HELD_STACK_KINDS).toContain('spell');
  });
});
