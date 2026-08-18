/**
 * Gaining control of a permanent.
 *
 * This is the mechanic that was deliberately deferred twice, because the naive
 * version is silently wrong: `CardInstance.controller` is read in ~55 places
 * across combat, priority, targeting, triggers, statics and attachments, so a
 * half-applied control change gives you a creature that changes sides for
 * targeting but still attacks for its old controller.
 *
 * The chosen shape writes the base field and records how to revert, which makes
 * all 55 reads correct at once and leaves exactly one new thing to get wrong:
 * the revert. So that is what these tests hammer — end of turn, death, and a
 * second effect stealing the same creature.
 */

import { describe, expect, it } from 'vitest';
import { createGame } from './engine.js';
import { deckOf, landDef } from './test-fixtures.js';
import { expireContinuousEffects, applyControlChange } from './internal/continuous.js';
import type { CardDefinition } from './card.js';
import type { CardInstance, GameState, InstanceId, PlayerId } from './state.js';
import type { GameEvent } from './events.js';

const BEAR: CardDefinition = {
  id: 'bear',
  name: 'Bear',
  types: ['creature'],
  power: 2,
  toughness: 2,
};

/** A source permanent for the stealing effect (the spell's controller). */
const THIEF: CardDefinition = { id: 'thief', name: 'Thief', types: ['enchantment'] };

function board(): GameState {
  const { state } = createGame({
    seed: 4,
    decks: { A: deckOf(landDef('Mountain', 'R'), 30), B: deckOf(landDef('Mountain', 'R'), 30) },
  });
  state.battlefield = [];
  state.continuous = [];
  return state;
}

function place(state: GameState, def: CardDefinition, controller: PlayerId): CardInstance {
  const instance: CardInstance = {
    instanceId: state.nextInstanceId++,
    def,
    controller,
    owner: controller,
    zone: 'battlefield',
    tapped: false,
    summoningSick: false,
    damageMarked: 0,
    markedByDeathtouch: false,
    counters: {},
  };
  state.battlefield.push(instance);
  return instance;
}

/** Collect events so control changes can be asserted on the log too. */
function collector(): { emit: (e: GameEvent) => void; events: GameEvent[] } {
  const events: GameEvent[] = [];
  return { emit: (e) => events.push(e), events };
}

describe('taking control', () => {
  it('moves the permanent to the stealing player', () => {
    const state = board();
    const victim = place(state, BEAR, 'B');
    const thief = place(state, THIEF, 'A');
    const { emit, events } = collector();

    const change = applyControlChange(state, victim.instanceId, thief.instanceId, emit);

    expect(victim.controller).toBe('A');
    expect(change).toEqual({ instanceId: victim.instanceId, from: 'B', to: 'A' });
    expect(events.some((e) => e.type === 'controlChanged')).toBe(true);
  });

  it('makes the stolen creature summoning-sick for its new controller', () => {
    // Rule 302.6 — otherwise a Threaten with no haste rider would let you swing
    // with a creature you just took, which is strictly better than printed.
    const state = board();
    const victim = place(state, BEAR, 'B');
    const thief = place(state, THIEF, 'A');
    victim.summoningSick = false;

    applyControlChange(state, victim.instanceId, thief.instanceId, collector().emit);

    expect(victim.summoningSick).toBe(true);
  });

  it('does nothing when the target is already yours', () => {
    const state = board();
    const mine = place(state, BEAR, 'A');
    const thief = place(state, THIEF, 'A');

    expect(applyControlChange(state, mine.instanceId, thief.instanceId, collector().emit)).toBeUndefined();
    expect(mine.controller).toBe('A');
  });

  it('does nothing when the source has already left the battlefield', () => {
    const state = board();
    const victim = place(state, BEAR, 'B');
    const ghostId = 9999 as InstanceId;

    expect(applyControlChange(state, victim.instanceId, ghostId, collector().emit)).toBeUndefined();
    expect(victim.controller).toBe('B');
  });

  it('a SPELL source steals for its named caster (the source is never on the battlefield)', () => {
    // Act of Treason's shape: the stealing effect resolves from the stack, so
    // there is no source permanent to read a controller from — the resolution
    // passes the caster explicitly. Without the fallback this silently no-oped.
    const state = board();
    const victim = place(state, BEAR, 'B');
    const spellId = 9999 as InstanceId;
    const { emit, events } = collector();

    const change = applyControlChange(state, victim.instanceId, spellId, emit, 'A');
    expect(victim.controller).toBe('A');
    expect(victim.summoningSick).toBe(true);
    expect(change).toEqual({ instanceId: victim.instanceId, from: 'B', to: 'A' });
    expect(events.some((e) => e.type === 'controlChanged')).toBe(true);
  });
});

describe('handing it back', () => {
  /** Steal `victim` for `thief`, registered as an end-of-turn continuous effect. */
  function steal(state: GameState, victim: CardInstance, thief: CardInstance): void {
    const change = applyControlChange(state, victim.instanceId, thief.instanceId, collector().emit);
    state.continuous.push({
      id: state.nextInstanceId++,
      targetInstanceId: victim.instanceId,
      sourceInstanceId: thief.instanceId,
      duration: 'endOfTurn',
      ...(change ? { controlChange: change } : {}),
    });
  }

  it('returns the creature at end of turn', () => {
    const state = board();
    const victim = place(state, BEAR, 'B');
    const thief = place(state, THIEF, 'A');
    steal(state, victim, thief);
    expect(victim.controller).toBe('A');

    expireContinuousEffects(state, 'endOfTurn', collector().emit);

    expect(victim.controller, 'a stolen creature must go home at end of turn').toBe('B');
  });

  it('makes it summoning-sick again on the way back', () => {
    const state = board();
    const victim = place(state, BEAR, 'B');
    const thief = place(state, THIEF, 'A');
    steal(state, victim, thief);
    victim.summoningSick = false;

    expireContinuousEffects(state, 'endOfTurn', collector().emit);

    expect(victim.summoningSick).toBe(true);
  });

  it('does not resurrect a creature that died while stolen', () => {
    const state = board();
    const victim = place(state, BEAR, 'B');
    const thief = place(state, THIEF, 'A');
    steal(state, victim, thief);

    // It dies while under A's control: gone from the battlefield.
    state.battlefield = state.battlefield.filter((c) => c.instanceId !== victim.instanceId);

    expect(() => expireContinuousEffects(state, 'endOfTurn', collector().emit)).not.toThrow();
    expect(state.battlefield.some((c) => c.instanceId === victim.instanceId)).toBe(false);
  });

  it('does not stomp a LATER effect that took the same creature', () => {
    // A steals B's bear, then B steals it back with a second effect. When A's
    // effect expires it must not yank the creature away from B's newer one —
    // the later effect owns the revert.
    const state = board();
    const victim = place(state, BEAR, 'B');
    const thiefA = place(state, THIEF, 'A');
    const thiefB = place(state, { ...THIEF, id: 'thief-b' }, 'B');

    steal(state, victim, thiefA);
    expect(victim.controller).toBe('A');
    steal(state, victim, thiefB);
    expect(victim.controller).toBe('B');

    // Expire A's effect only (both are endOfTurn here, so expire everything and
    // check the net result is still B's — the creature never lands on A).
    expireContinuousEffects(state, 'endOfTurn', collector().emit);

    expect(
      victim.controller,
      'the creature must end up with its original controller, never stranded with the first thief',
    ).toBe('B');
  });
});
