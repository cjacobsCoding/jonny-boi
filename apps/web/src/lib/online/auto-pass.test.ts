import { describe, expect, it } from 'vitest';
import type { GameAction } from '@jonny-boi/core';
import {
  alreadyPassedFrame,
  shouldAutoPass,
  shouldAutoPassNow,
  type PriorityWindow,
} from './auto-pass.js';

const PASS: GameAction = { kind: 'passPriority', player: 'A' };
const PLAY_LAND: GameAction = { kind: 'playLand', player: 'A', instanceId: 7 };
const CAST: GameAction = { kind: 'castSpell', player: 'A', instanceId: 9, targets: [] };

/** A window where passing is the only thing on offer — the case we auto-advance. */
function emptyWindow(over: Partial<PriorityWindow> = {}): PriorityWindow {
  return {
    yourTurn: true,
    legalActions: [PASS],
    stackSize: 0,
    awaitingOwnChoice: false,
    tapCastableCount: 0,
    ...over,
  };
}

describe('shouldAutoPass', () => {
  it('passes a window whose only legal action is passPriority', () => {
    expect(shouldAutoPass(emptyWindow())).toBe(true);
  });

  it('is the fix for the opening upkeep/draw windows that made the game look frozen', () => {
    // Both seats are handed priority in `upkeep` and again in `draw` with nothing
    // but a pass available. That is four dead clicks before the first land drop.
    for (const step of ['upkeep', 'draw']) {
      expect(shouldAutoPass(emptyWindow()), `step ${step}`).toBe(true);
    }
  });

  it('never acts for a seat that does not hold priority', () => {
    expect(shouldAutoPass(emptyWindow({ yourTurn: false }))).toBe(false);
  });

  it('stops when any real action is available', () => {
    expect(shouldAutoPass(emptyWindow({ legalActions: [PASS, PLAY_LAND] }))).toBe(false);
    expect(shouldAutoPass(emptyWindow({ legalActions: [PASS, CAST] }))).toBe(false);
  });

  it('stops when something is on the stack, so a response window is never skipped', () => {
    expect(shouldAutoPass(emptyWindow({ stackSize: 1 }))).toBe(false);
  });

  it('stops when a resolving card has parked a question for this seat', () => {
    expect(shouldAutoPass(emptyWindow({ awaitingOwnChoice: true }))).toBe(false);
  });

  it('stops when the client could fund a cast by tapping', () => {
    // The server never lists these (it only offers casts the pool already covers),
    // so checking `legalActions` alone would skip a window the player CAN use.
    expect(shouldAutoPass(emptyWindow({ tapCastableCount: 1 }))).toBe(false);
  });

  it('still advances when untapped lands exist but nothing is castable', () => {
    // Gating on "has untapped lands" would switch auto-pass off from the first
    // land drop onward — i.e. every turn but the first. Mana empties at the end
    // of the step, so tapping with nothing to cast accomplishes nothing.
    expect(shouldAutoPass(emptyWindow({ tapCastableCount: 0 }))).toBe(true);
  });

  it('leaves a blocking decision alone', () => {
    // `declareBlockers` is a non-pass legal action, so a seat under attack stops
    // here instead of being advanced past its blocks.
    const block: GameAction = { kind: 'declareBlockers', player: 'A', blocks: [] };
    expect(shouldAutoPass(emptyWindow({ legalActions: [PASS, block] }))).toBe(false);
  });

  it('does nothing when no pass is offered at all', () => {
    expect(shouldAutoPass(emptyWindow({ legalActions: [] }))).toBe(false);
  });
});

/**
 * The composed decision the online board acts on (§10 of
 * docs/MTGA-UX-OVERHAUL.md). The board never calls `shouldAutoPass` directly:
 * the hold argument is required, so a caller that forgets the combat beat does
 * not compile.
 */
describe('shouldAutoPassNow', () => {
  it('is exactly shouldAutoPass when no beat is owed', () => {
    expect(shouldAutoPassNow(emptyWindow(), false)).toBe(shouldAutoPass(emptyWindow()));
    expect(shouldAutoPassNow(emptyWindow(), false)).toBe(true);
  });

  it('refuses to advance while combat is being held on screen', () => {
    // THE §10 gate. Without it the board passes priority underneath the beat,
    // the server resolves combat damage and end-of-combat, and the blocks the
    // player just confirmed are gone before a frame is painted.
    expect(shouldAutoPassNow(emptyWindow(), true)).toBe(false);
  });

  it('never turns a window the RULES refused into an advance', () => {
    // The hold can only ever subtract: it is a presentation pause layered on
    // top of a legality question, never a second answer to it.
    for (const refused of [
      emptyWindow({ yourTurn: false }),
      emptyWindow({ stackSize: 1 }),
      emptyWindow({ awaitingOwnChoice: true }),
      emptyWindow({ tapCastableCount: 1 }),
    ]) {
      expect(shouldAutoPassNow(refused, false)).toBe(false);
      expect(shouldAutoPassNow(refused, true)).toBe(false);
    }
  });
});

describe('alreadyPassedFrame', () => {
  it('suppresses a second pass for the frame we already passed on', () => {
    const frame = { id: 'a' };
    expect(alreadyPassedFrame(frame, frame)).toBe(true);
  });

  it('allows a pass for each newly pushed frame', () => {
    expect(alreadyPassedFrame({ id: 'a' }, { id: 'a' })).toBe(false);
    expect(alreadyPassedFrame(null, { id: 'a' })).toBe(false);
  });

  it('does not treat a repeated step as a duplicate — the declareBlockers deadlock', () => {
    // A seat passes in `declareBlockers`, blockers are declared, and priority comes
    // back around in the SAME step with the stack still empty. Keyed on
    // turn/step/priority that second window looks identical and never advances;
    // keyed on the frame the server pushed, it is correctly a new decision.
    const beforeBlocks = { turnNumber: 1, step: 'declareBlockers', blocks: [] };
    const afterBlocks = { turnNumber: 1, step: 'declareBlockers', blocks: [] };
    expect(alreadyPassedFrame(beforeBlocks, afterBlocks)).toBe(false);
  });
});
