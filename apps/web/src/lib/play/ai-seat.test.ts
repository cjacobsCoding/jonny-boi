/**
 * The AI seat: WHEN the computer acts, and WHAT it plays.
 *
 * Kept away from React on purpose — the interesting rules ("is it the pilot's
 * move", "the pilot never invents an illegal action") are decidable from a
 * session alone, and a test that needs a rendered board to ask them is a test
 * nobody runs.
 */
import { describe, expect, it } from 'vitest';
import { createRng } from '@jonny-boi/core';
import { createDefaultAiRegistry, DEFAULT_PILOT_ID } from '@jonny-boi/ai';
import { aiAction, aiMustAct } from './ai-seat.js';
import { createSoloVsAiTransport } from './seat.js';
import { startHotseatGame, type DeckChoice } from './setup.js';
import { GameSession } from './session.js';
import { SAMPLE_DECKS } from '@jonny-boi/sim';

const pilot = createDefaultAiRegistry().getPilot(DEFAULT_PILOT_ID)!;

function soloGame(): GameSession {
  const choice: DeckChoice = { source: 'sample', deck: SAMPLE_DECKS[0]! };
  const started = startHotseatGame({ choiceA: choice, choiceB: choice, seed: 4242, startingPlayer: 'A' });
  if (!started.ok) throw new Error('sample decks must be legal');
  return GameSession.fromCreated(started.game.created, started.game.registry, { A: 'You', B: 'Computer' });
}

describe('the solo transport', () => {
  const seats = { A: { id: 'A' as const, name: 'You' }, B: { id: 'B' as const, name: 'Computer' } };

  it('hides the computer\u2019s hand and shows yours', () => {
    const t = createSoloVsAiTransport(seats, 'A');
    expect(t.localControls('A'), 'you drive your own seat').toBe(true);
    expect(t.localControls('B'), 'the pilot\u2019s hand must stay hidden').toBe(false);
  });

  it('never asks you to hand the device to a computer', () => {
    const t = createSoloVsAiTransport(seats, 'A');
    expect(t.requiresHandoff('A', 'B')).toBe(false);
    expect(t.requiresHandoff('B', 'A')).toBe(false);
  });
});

describe('when the computer acts', () => {
  it('acts only on its own priority', () => {
    const s = soloGame();
    // Seat A starts, so the pilot in seat B waits.
    expect(aiMustAct(s, s.state.priorityPlayer)).toBe(true);
    const other = s.state.priorityPlayer === 'A' ? 'B' : 'A';
    expect(aiMustAct(s, other)).toBe(false);
  });

  it('never acts once the game is over', () => {
    const s = soloGame();
    const ended = s.concede('A', 'B');
    expect(aiMustAct(ended, 'A')).toBe(false);
    expect(aiMustAct(ended, 'B')).toBe(false);
  });
});

describe('what the computer plays', () => {
  it('only ever returns an action the engine already offered', () => {
    // The whole safety property of the driver. A pilot that invented an action
    // would be rejected by the engine and, without this, could wedge the game.
    const s = soloGame();
    const rng = createRng(7);
    const action = aiAction(s, pilot, rng);
    expect(action).toBeDefined();
    expect(s.legalActions()).toContainEqual(action);
  });

  it('is deterministic for a given seed - a solo game replays', () => {
    const s = soloGame();
    expect(aiAction(s, pilot, createRng(99))).toEqual(aiAction(s, pilot, createRng(99)));
  });

  it('drives a real game forward rather than stalling', () => {
    // Play both seats with the pilot for a while: the point is that submitting
    // what `aiAction` returns actually ADVANCES the game, which a driver that
    // returned a rejected action would not.
    let s = soloGame();
    const rng = createRng(11);
    const startTurn = s.state.turnNumber;
    for (let i = 0; i < 400 && !s.gameOver; i++) {
      const action = aiAction(s, pilot, rng);
      if (!action) break;
      const result = s.submit(action);
      expect(result.rejected, 'the pilot proposed something the engine refused').toBeFalsy();
      s = result.session;
    }
    expect(s.state.turnNumber, 'the game never got past its first turn').toBeGreaterThan(startTurn);
  });
});
