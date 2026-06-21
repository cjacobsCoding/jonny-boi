/**
 * The event→state fold is the replay viewer's correctness backbone (the brief):
 * folding the event log up to step N must reproduce the right life totals and the
 * right board (which permanents are in play, tapped or not), and the key-moment
 * scan must flag deaths, lethal-range crossings, and the game end at the right
 * indices. Pure logic, fast — no sim involved.
 */
import { describe, expect, it } from 'vitest';
import type { GameEvent } from '@jonny-boi/core';
import {
  foldState,
  findKeyMoments,
  DEFAULT_STARTING_LIFE,
  LETHAL_RANGE_LIFE,
} from './replay-fold.js';

/** A small scripted game's event log, enough to exercise life + board folding. */
const SCRIPT: readonly GameEvent[] = [
  { type: 'gameStart', seed: 1, startingPlayer: 'A' },
  { type: 'turnBegin', turn: 1, activePlayer: 'A' },
  { type: 'landPlayed', player: 'A', instanceId: 10 }, // A: land 10
  { type: 'spellCast', player: 'A', instanceId: 11, name: 'Bear', castTypes: ['creature'] },
  { type: 'zoneChange', instanceId: 11, from: 'stack', to: 'battlefield' }, // A: creature 11
  { type: 'tapped', instanceId: 10 }, // tap the land
  { type: 'turnBegin', turn: 2, activePlayer: 'B' },
  { type: 'landPlayed', player: 'B', instanceId: 20 }, // B: land 20
  { type: 'damageDealt', source: 11, target: 'B', amount: 3, combat: true },
  { type: 'lifeChanged', player: 'B', delta: -3, to: 17 }, // B → 17
  { type: 'untapped', instanceId: 10, player: 'A' }, // A's land untaps
  { type: 'lifeChanged', player: 'B', delta: -13, to: 4 }, // B → 4 (lethal range)
  { type: 'creatureDied', instanceId: 11, name: 'Bear' }, // creature 11 dies
  { type: 'lifeChanged', player: 'B', delta: -4, to: 0 },
  { type: 'playerLost', player: 'B', reason: 'life' },
  { type: 'gameOver', winner: 'A' },
];

describe('foldState', () => {
  it('the opening state (index -1) is untouched: full life, empty boards', () => {
    const s = foldState(SCRIPT, -1);
    expect(s.sides.A.life).toBe(DEFAULT_STARTING_LIFE);
    expect(s.sides.B.life).toBe(DEFAULT_STARTING_LIFE);
    expect(s.sides.A.board).toHaveLength(0);
    expect(s.sides.B.board).toHaveLength(0);
    expect(s.gameOver).toBe(false);
  });

  it('builds the board from land/creature entries and tracks tapped state', () => {
    // After index 5 (the land tap), A controls land 10 (tapped) + creature 11.
    const s = foldState(SCRIPT, 5);
    expect(s.sides.A.board).toHaveLength(2);
    const land = s.sides.A.board.find((p) => p.instanceId === 10);
    const bear = s.sides.A.board.find((p) => p.instanceId === 11);
    expect(land?.tapped).toBe(true);
    expect(bear?.tapped).toBe(false);
    expect(s.sides.B.board).toHaveLength(0);
  });

  it('applies life changes by absolute total and untaps a permanent', () => {
    const s = foldState(SCRIPT, 10); // through the untap of land 10
    expect(s.sides.B.life).toBe(17);
    expect(s.sides.A.board.find((p) => p.instanceId === 10)?.tapped).toBe(false);
  });

  it('removes a creature from the board when it dies', () => {
    const beforeDeath = foldState(SCRIPT, 11); // B at 4, bear still alive
    expect(beforeDeath.sides.A.board.some((p) => p.instanceId === 11)).toBe(true);
    const afterDeath = foldState(SCRIPT, 12); // creatureDied
    expect(afterDeath.sides.A.board.some((p) => p.instanceId === 11)).toBe(false);
    // The land survives.
    expect(afterDeath.sides.A.board.some((p) => p.instanceId === 10)).toBe(true);
  });

  it('folding the whole log marks the game over with the winner', () => {
    const s = foldState(SCRIPT, SCRIPT.length - 1);
    expect(s.gameOver).toBe(true);
    expect(s.winner).toBe('A');
    expect(s.sides.B.life).toBe(0);
  });

  it('an index past the end is clamped (no out-of-range)', () => {
    const s = foldState(SCRIPT, 9999);
    expect(s.gameOver).toBe(true);
  });

  it('uses controllerOf for a zoneChange onto the battlefield with no prior owner', () => {
    const log: readonly GameEvent[] = [
      { type: 'zoneChange', instanceId: 77, from: 'hand', to: 'battlefield' },
    ];
    const s = foldState(log, 0, { controllerOf: (id) => (id === 77 ? 'B' : undefined) });
    expect(s.sides.B.board.some((p) => p.instanceId === 77)).toBe(true);
    expect(s.sides.A.board).toHaveLength(0);
  });
});

describe('findKeyMoments', () => {
  it('flags the death, the lethal-range crossing, and the game end with indices', () => {
    const moments = findKeyMoments(SCRIPT);
    const kinds = moments.map((m) => m.kind);
    expect(kinds).toContain('death');
    expect(kinds).toContain('lethalRange');
    expect(kinds).toContain('gameOver');

    const lethal = moments.find((m) => m.kind === 'lethalRange');
    // The first crossing is when B drops to 4 (index 11), not the earlier 17.
    expect(lethal?.eventIndex).toBe(11);

    const gameOver = moments.find((m) => m.kind === 'gameOver');
    expect(gameOver?.eventIndex).toBe(SCRIPT.length - 1);
    expect(gameOver?.label).toMatch(/A wins/);
  });

  it('only flags lethal range once per uninterrupted descent', () => {
    // Two drops below the threshold in a row → a single lethalRange moment.
    const log: readonly GameEvent[] = [
      { type: 'lifeChanged', player: 'A', delta: -16, to: LETHAL_RANGE_LIFE - 1 },
      { type: 'lifeChanged', player: 'A', delta: -1, to: LETHAL_RANGE_LIFE - 2 },
    ];
    const lethal = findKeyMoments(log).filter((m) => m.kind === 'lethalRange');
    expect(lethal).toHaveLength(1);
  });

  it('re-arms lethal range after the player climbs back above the threshold', () => {
    const log: readonly GameEvent[] = [
      { type: 'lifeChanged', player: 'A', delta: -16, to: 4 }, // into range
      { type: 'lifeChanged', player: 'A', delta: 10, to: 14 }, // out of range
      { type: 'lifeChanged', player: 'A', delta: -12, to: 2 }, // back into range
    ];
    const lethal = findKeyMoments(log).filter((m) => m.kind === 'lethalRange');
    expect(lethal).toHaveLength(2);
  });
});
