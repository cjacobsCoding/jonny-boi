/**
 * Skip-logic tests: stepping lands on frames where something happened, and never
 * gets stuck or runs off either end of the trace.
 */

import { describe, expect, it } from 'vitest';
import type { GameEvent } from '@jonny-boi/core';
import { isNotableFrame, nextNotableFrame } from './replay-skip.js';
import type { MatchTrace, ReplayFrame } from './replay-types.js';

/** An empty side (no cards anywhere) — frames here only need to exist. */
const EMPTY_SIDE = {
  life: 20,
  handCount: 0,
  libraryCount: 0,
  graveyardCount: 0,
  hand: [],
  library: [],
  graveyard: [],
  manaPool: {},
  board: [],
} as const;

/** A frame whose newest event is `eventIndex`. */
function frame(eventIndex: number, gameOver = false): ReplayFrame {
  return {
    eventIndex,
    turn: 1,
    step: 'precombatMain',
    activePlayer: 'A',
    sides: { A: EMPTY_SIDE, B: EMPTY_SIDE },
    stackSize: 0,
    gameOver,
    winner: null,
  };
}

/**
 * A trace over the given events, one frame per event. `priorityPassed` is
 * bookkeeping the log omits, so those frames are quiet; `landPlayed` is printed,
 * so those frames are notable.
 */
function traceOf(events: readonly GameEvent[]): MatchTrace {
  return {
    seats: {
      A: { player: 'A', deckName: 'A', pilot: 'heuristic' },
      B: { player: 'B', deckName: 'B', pilot: 'heuristic' },
    },
    events,
    frames: events.map((_, index) => frame(index)),
    names: {},
    cardIds: {},
    outcome: { kind: 'timeout' },
    seed: 1,
    turns: 1,
    actions: events.length,
    truncated: false,
  };
}

const QUIET: GameEvent = { type: 'priorityPassed', player: 'A' } as GameEvent;
const LOUD: GameEvent = {
  type: 'landPlayed',
  player: 'A',
  instanceId: 1,
  name: 'Mountain',
} as GameEvent;

describe('isNotableFrame', () => {
  it('always stops on the opening and final frames', () => {
    const trace = traceOf([QUIET, QUIET, QUIET, QUIET]);
    expect(isNotableFrame(trace, 0)).toBe(true);
    expect(isNotableFrame(trace, trace.frames.length - 1)).toBe(true);
  });

  it('skips a frame whose only new event is bookkeeping', () => {
    const trace = traceOf([LOUD, QUIET, QUIET, LOUD, QUIET]);
    expect(isNotableFrame(trace, 1)).toBe(false);
    expect(isNotableFrame(trace, 2)).toBe(false);
  });

  it('stops on a frame where something the log prints happened', () => {
    const trace = traceOf([LOUD, QUIET, QUIET, LOUD, QUIET]);
    expect(isNotableFrame(trace, 3)).toBe(true);
  });

  it('stops on the frame that ends the game', () => {
    const trace = traceOf([LOUD, QUIET, QUIET, QUIET, QUIET]);
    const frames = [...trace.frames];
    frames[2] = frame(2, true);
    expect(isNotableFrame({ ...trace, frames }, 2)).toBe(true);
  });
});

describe('nextNotableFrame', () => {
  it('fast-forwards past a run of quiet frames', () => {
    const trace = traceOf([LOUD, QUIET, QUIET, LOUD, QUIET, QUIET]);
    expect(nextNotableFrame(trace, 0, 1)).toBe(3);
  });

  it('steps backward to the previous notable frame', () => {
    const trace = traceOf([LOUD, QUIET, QUIET, LOUD, QUIET, QUIET]);
    expect(nextNotableFrame(trace, 3, -1)).toBe(0);
  });

  it('always moves, even when the rest of the trace is quiet', () => {
    const trace = traceOf([LOUD, QUIET, QUIET, QUIET]);
    const next = nextNotableFrame(trace, 1, 1);
    expect(next).toBeGreaterThan(1);
    expect(next).toBe(trace.frames.length - 1);
  });

  it('clamps at the ends rather than running off the trace', () => {
    const trace = traceOf([LOUD, QUIET, LOUD]);
    expect(nextNotableFrame(trace, trace.frames.length - 1, 1)).toBe(trace.frames.length - 1);
    expect(nextNotableFrame(trace, 0, -1)).toBe(0);
  });
});
