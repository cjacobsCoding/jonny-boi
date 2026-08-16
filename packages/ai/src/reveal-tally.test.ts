/**
 * The reveal tracker in isolation. The seam's end-to-end behaviour (masking,
 * per-game isolation, non-interference with play) is proved on real games in
 * `packages/sim/src/observation.test.ts`; this file pins the tally's own rules,
 * which are easy to get subtly wrong and invisible when they are.
 */

import { describe, expect, it } from 'vitest';
import { createOpponentRevealObserver, createRevealTrackingPilot } from './reveal-tally.js';
import type { GameStartInfo, Observation } from './observation.js';
import type { DecisionContext, Pilot } from './pilot.js';
import type { GameAction } from '@jonny-boi/core';

const SEAT_A_WATCHING_B: GameStartInfo = { seat: 'A', opponent: 'B', startingPlayer: 'A' };

function feed(observations: readonly Observation[], info: GameStartInfo = SEAT_A_WATCHING_B) {
  const observer = createOpponentRevealObserver(info);
  for (const o of observations) observer.observe(o);
  return observer.reveals();
}

describe('opponent reveal tracker', () => {
  it('starts empty', () => {
    const reveals = feed([]);
    expect(reveals.cardsDrawn).toBe(0);
    expect(reveals.landsPlayed).toBe(0);
    expect(reveals.spellsCast).toBe(0);
    expect(reveals.spellNames.size).toBe(0);
    expect(reveals.knownInstanceIds.size).toBe(0);
    expect(reveals.manaProduced.R).toBe(0);
  });

  it('counts the opponent and ignores itself — the whole point of the seat field', () => {
    const reveals = feed([
      { type: 'drawCard', player: 'B' },
      { type: 'drawCard', player: 'A' },
      { type: 'landPlayed', player: 'B', instanceId: 10 },
      { type: 'landPlayed', player: 'A', instanceId: 11 },
      { type: 'spellCast', player: 'B', instanceId: 20, name: 'Lightning Bolt', castTypes: ['instant'] },
      { type: 'spellCast', player: 'A', instanceId: 21, name: 'Counterspell', castTypes: ['instant'] },
      { type: 'manaAdded', player: 'B', color: 'R', amount: 2 },
      { type: 'manaAdded', player: 'A', color: 'U', amount: 1 },
    ]);
    expect(reveals.cardsDrawn).toBe(1);
    expect(reveals.landsPlayed).toBe(1);
    expect(reveals.spellsCast).toBe(1);
    expect(reveals.manaProduced.R).toBe(2);
    expect(reveals.manaProduced.U).toBe(0);
    expect([...reveals.knownInstanceIds]).toEqual([10, 20]);
    expect(reveals.spellNames.get('Counterspell')).toBeUndefined();
  });

  it('accumulates repeated casts by name — the beginnings of archetype inference', () => {
    const bolt = (instanceId: number): Observation => ({
      type: 'spellCast',
      player: 'B',
      instanceId,
      name: 'Lightning Bolt',
      castTypes: ['instant'],
    });
    const reveals = feed([bolt(1), bolt(2), bolt(3)]);
    expect(reveals.spellsCast).toBe(3);
    expect(reveals.spellNames.get('Lightning Bolt')).toBe(3);
    expect(reveals.knownInstanceIds.size).toBe(3);
  });

  it('watches the other seat when the pilot sits in B', () => {
    const reveals = feed([{ type: 'drawCard', player: 'A' }, { type: 'drawCard', player: 'B' }], {
      seat: 'B',
      opponent: 'A',
      startingPlayer: 'A',
    });
    expect(reveals.cardsDrawn).toBe(1);
  });

  it('ignores an observation it has no rule for, rather than throwing', () => {
    const reveals = feed([
      { type: 'stepBegin', step: 'upkeep', activePlayer: 'B' },
      { type: 'actionRejected', reason: 'nope' },
      { type: 'zoneChange', from: 'battlefield', to: 'hand' },
    ]);
    expect(reveals.spellsCast).toBe(0);
  });
});

describe('reveal-tracking pilot wrapper', () => {
  const pass: GameAction = { kind: 'passPriority', player: 'A' };
  const base: Pilot = {
    id: 'stub',
    description: 'always passes',
    chooseAction: () => pass,
  };

  it('creates a FRESH observer for every game — never reuses one', () => {
    const pilot = createRevealTrackingPilot(base);
    const first = pilot.createGameObserver!(SEAT_A_WATCHING_B);
    const second = pilot.createGameObserver!(SEAT_A_WATCHING_B);
    expect(first).not.toBe(second);
    first.observe({ type: 'drawCard', player: 'B' });
    expect(first.reveals().cardsDrawn).toBe(1);
    expect(second.reveals().cardsDrawn).toBe(0);
  });

  it('delegates the decision unchanged, and survives a context with no observer', () => {
    let seen = 0;
    const pilot = createRevealTrackingPilot(base, () => {
      seen++;
    });
    const ctx = { view: {}, legalActions: [pass], rng: () => 0 } as unknown as DecisionContext<
      ReturnType<NonNullable<typeof pilot.createGameObserver>>
    >;
    expect(pilot.chooseAction(ctx)).toBe(pass);
    // No observer in the context ⇒ nothing to report, and no crash. This is the
    // "a harness that does not drive the seam" case, e.g. `apps/web`'s replay.
    expect(seen).toBe(0);
  });
});
