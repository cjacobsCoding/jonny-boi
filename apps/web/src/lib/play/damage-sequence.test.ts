/**
 * §3.143 / UX-15 — the pure damage-distribution fold.
 *
 * Every behavioural claim the module makes has a test here, because Caleb's
 * standing complaint is that bugs he finds by PLAYING should have been caught by
 * a test. In particular this file pins:
 *  - the round split (a first-strike combat must read as two rounds, and a
 *    trample/multi-block must NOT be split into several);
 *  - the one case the round split provably cannot see, so nobody "discovers" it
 *    later as a bug rather than as the documented limitation it is;
 *  - the cap: a twenty-creature combat degrades to a condensed presentation and
 *    the whole sequence is bounded, with nothing silently dropped;
 *  - the shared clock between this fold and `deriveAnimations`, which is what
 *    stops a creature vanishing while the hit that killed it is in flight.
 */
import { describe, expect, it } from 'vitest';
import type { GameEvent, InstanceId, PlayerId } from '@jonny-boi/core';
import {
  DAMAGE_BENCH_ROWS,
  damageHoldMsFor,
  deriveDamageSequence,
  sequenceDurationMs,
  type DamageBeat,
} from './damage-sequence.js';
import { deriveAnimations, type AnimationCardInfo } from './animations.js';
import { DAMAGE_ANIM_CONFIG } from './play-config.js';

const { travelMs, impactMs, staggerMs, settleHoldMs, maxPerBatch, maxTotalMs } = DAMAGE_ANIM_CONFIG;

const hit = (source: InstanceId, target: InstanceId | PlayerId, amount = 2, combat = true): GameEvent => ({
  type: 'damageDealt',
  source,
  target,
  amount,
  combat,
});

const prevented = (source: InstanceId, target: InstanceId | PlayerId, amount = 2): GameEvent => ({
  type: 'damagePrevented',
  source,
  target,
  amount,
  combat: true,
});

const died = (instanceId: InstanceId): GameEvent => ({ type: 'creatureDied', instanceId, name: `c${instanceId}` });

function plan(events: readonly GameEvent[], startIndex = 0, reducedMotion = false): DamageBeat[] {
  return [...deriveDamageSequence(events, { reducedMotion, startIndex })];
}

/** The recipient of a beat, as the string the module keys ends by. */
function endOf(beat: DamageBeat): string {
  return beat.to.where === 'tile' ? `tile:${beat.to.instanceId}` : `seat:${beat.to.seat}`;
}

describe('deriveDamageSequence — one hit at a time', () => {
  it('a creature hitting a creature travels from source tile to recipient tile', () => {
    expect(plan([hit(1, 2, 3)])).toMatchObject([
      {
        kind: 'hit',
        roundIndex: 0,
        from: { where: 'tile', instanceId: 1 },
        to: { where: 'tile', instanceId: 2 },
        amount: 3,
        outcome: 'dealt',
        combat: true,
        lethal: false,
        startMs: 0,
        travelMs,
        impactMs,
      },
    ]);
  });

  it('a creature hitting a PLAYER lands at that seat — the end the vfx table used to drop', () => {
    expect(plan([hit(1, 'B', 4)])).toMatchObject([{ to: { where: 'seat', seat: 'B' }, amount: 4 }]);
  });

  it('noncombat damage (a burn spell, a fight) animates too, and says so', () => {
    expect(plan([hit(1, 'B', 3, false)])).toMatchObject([{ combat: false, amount: 3 }]);
  });

  it('prevented damage still travels, and arrives as prevented (never lethal)', () => {
    expect(plan([prevented(1, 2, 3), died(2)])).toMatchObject([{ outcome: 'prevented', amount: 3, lethal: false }]);
  });

  it('an event type outside the table produces nothing, and so does a zero-amount hit', () => {
    expect(plan([{ type: 'drawCard', player: 'A', instanceId: 1 }])).toEqual([]);
    expect(plan([hit(1, 2, 0)])).toEqual([]);
  });

  it('reduced motion derives NOTHING at all', () => {
    expect(plan([hit(1, 2, 3), hit(2, 1, 3)], 0, true)).toEqual([]);
  });

  it('keys are minted from the ABSOLUTE event index, so two batches never collide', () => {
    expect(plan([hit(1, 2)], 5)[0]?.key).toBe('5');
    expect(plan([hit(1, 2)], 6)[0]?.key).toBe('6');
    const mixed = plan([hit(1, 2), hit(1, 3), hit(3, 1)], 40);
    expect(new Set(mixed.map((b) => b.key)).size).toBe(mixed.length);
  });
});

describe('deriveDamageSequence — lethality comes from the ENGINE, not from arithmetic', () => {
  it('a creature that dies after the round marks the hit that killed it', () => {
    const beats = plan([hit(1, 2, 5), hit(2, 1, 1), died(2)]);
    expect(beats.find((b) => endOf(b) === 'tile:2')?.lethal).toBe(true);
    expect(beats.find((b) => endOf(b) === 'tile:1')?.lethal).toBe(false);
  });

  it('a death of something this batch never damaged marks nothing', () => {
    expect(plan([hit(1, 2, 1), died(9)]).every((b) => !b.lethal)).toBe(true);
  });

  it('a player losing the game marks the face hit that did it', () => {
    const beats = plan([hit(1, 'B', 20), { type: 'playerLost', player: 'B', reason: 'life' }]);
    expect(beats).toMatchObject([{ to: { where: 'seat', seat: 'B' }, lethal: true }]);
  });

  it('a kill by a SPELL is still marked, even though `stackResolved` sits between the two events', () => {
    // The engine resolves the spell (damage), emits `stackResolved`, THEN runs
    // state-based actions. A fold that forgot the round at the first untabulated
    // event would lose every spell kill — this is that guard.
    const beats = plan([hit(7, 2, 3, false), { type: 'stackResolved', instanceId: 7, name: 'Bolt' }, died(2)]);
    expect(beats).toMatchObject([{ lethal: true }]);
  });
});

describe('deriveDamageSequence — rounds (first strike must read as two)', () => {
  it('a DOUBLE STRIKER hitting the same blocker twice is two rounds, separated by the settle beat', () => {
    const beats = plan([hit(1, 2, 2), hit(1, 2, 2)]);
    expect(beats.map((b) => b.roundIndex)).toEqual([0, 1]);
    // Round 1 starts only after round 0's hit has landed AND settled.
    expect(beats[1]?.startMs).toBe(travelMs + impactMs + settleHoldMs);
  });

  it('a TRAMPLER hitting its blocker and the player is ONE round (same source, two recipients)', () => {
    const beats = plan([hit(1, 2, 2), hit(1, 'B', 3)]);
    expect(beats.map((b) => b.roundIndex)).toEqual([0, 0]);
    expect(beats.map((b) => b.startMs)).toEqual([0, staggerMs]);
  });

  it('an attacker blocked by THREE creatures is one round, not three', () => {
    const beats = plan([hit(1, 2, 1), hit(1, 3, 1), hit(1, 4, 1)]);
    expect(beats.map((b) => b.roundIndex)).toEqual([0, 0, 0]);
  });

  it('a death between two damage runs splits them (state-based actions run BETWEEN steps)', () => {
    const beats = plan([hit(1, 2, 5), died(2), hit(3, 'B', 4)]);
    expect(beats.map((b) => b.roundIndex)).toEqual([0, 1]);
  });

  it('an untabulated event between two damage runs splits them — the SAFE default', () => {
    const beats = plan([hit(1, 2, 1), { type: 'stepBegin', step: 'combatDamage', activePlayer: 'A' }, hit(3, 4, 1)]);
    expect(beats.map((b) => b.roundIndex)).toEqual([0, 1]);
  });

  it('the COMPANION events the engine emits inside one assignment do NOT split a round', () => {
    // Every one of these is a real emission site inside `applyDamageResult` /
    // `replaceDamage`: life loss, the lifelink gain, poison, a walker's loyalty,
    // a battle's defense, infect's -1/-1 counters, a replacement firing.
    const beats = plan([
      hit(1, 'B', 3),
      { type: 'lifeChanged', player: 'B', delta: -3, to: 17 },
      { type: 'gainLife', player: 'A', amount: 3 },
      { type: 'poisonChanged', player: 'B', delta: 1, to: 1 },
      { type: 'loyaltyChanged', instanceId: 5, delta: -2, to: 1 },
      { type: 'defenseChanged', instanceId: 6, delta: -1, to: 3 },
      { type: 'counterAdded', instanceId: 2, kind: '-1/-1', amount: 2 },
      hit(4, 2, 2),
    ]);
    expect(beats.map((b) => b.roundIndex)).toEqual([0, 0]);
  });

  it('⚠️ THE DOCUMENTED BLIND SPOT: a first-strike round that kills nothing and repeats no pair reads as ONE round', () => {
    // A 2/2 first-striker and a 3/3 vanilla, both unblocked. Two damage steps in
    // the engine; ONE round in the log, because nothing died and no source/
    // recipient pair repeats. The hits still animate individually — what is lost
    // is the beat between the rounds.
    //
    // THIS IS NOT AN ACCEPTED DEFECT, IT IS AN UNMET REQUIREMENT WITH A KNOWN
    // FIX: core must say which combat-damage step a hit belonged to (a `round`
    // field on `damageDealt`, or a `combatDamageStep` marker event). The day it
    // does, this expectation flips to [0, 1] and the pair rule can be deleted.
    const beats = plan([hit(1, 'B', 2), hit(3, 'B', 3)]);
    expect(beats.map((b) => b.roundIndex)).toEqual([0, 0]);
  });
});

describe('deriveDamageSequence — the cap degrades, it does not drop', () => {
  /** One round of `n` hits, each from its own source, onto three recipients. */
  function bigRound(n: number, startSource = 100): GameEvent[] {
    return Array.from({ length: n }, (_, i) => hit(startSource + i, i % 3 === 0 ? 2 : i % 3 === 1 ? 3 : 'B', 1 + (i % 3)));
  }

  it('a round at exactly the cap still animates hit by hit', () => {
    const beats = plan(bigRound(maxPerBatch));
    expect(beats).toHaveLength(maxPerBatch);
    expect(beats.every((b) => b.kind === 'hit')).toBe(true);
    expect(sequenceDurationMs(beats)).toBeLessThanOrEqual(maxTotalMs);
  });

  it('one hit past the cap CONDENSES: one bloom per recipient, carrying that recipient’s total', () => {
    const events = bigRound(maxPerBatch + 1);
    const beats = plan(events);
    expect(beats.every((b) => b.kind === 'condensed')).toBe(true);
    expect(beats.every((b) => b.from === null)).toBe(true);
    // One beat per DISTINCT recipient, and every one of them still on screen.
    expect(beats).toHaveLength(3);
    // The amounts are the real sums — nothing was rounded away.
    const expected = new Map<string, number>();
    for (const e of events) {
      if (e.type !== 'damageDealt') continue;
      const key = typeof e.target === 'number' ? `tile:${e.target}` : `seat:${e.target}`;
      expected.set(key, (expected.get(key) ?? 0) + e.amount);
    }
    for (const beat of beats) expect(beat.amount).toBe(expected.get(endOf(beat)));
    // All at once: a condensed round does not stagger, and it does not travel.
    expect(new Set(beats.map((b) => b.startMs)).size).toBe(1);
    expect(beats.every((b) => b.travelMs === 0)).toBe(true);
  });

  it('a condensed round still says which recipients DIED', () => {
    const beats = plan([...bigRound(maxPerBatch + 1), died(2)]);
    expect(beats.find((b) => endOf(b) === 'tile:2')?.lethal).toBe(true);
    expect(beats.find((b) => endOf(b) === 'tile:3')?.lethal).toBe(false);
  });

  it('a monstrous combat is BOUNDED: no input can run past maxTotalMs + one condensed round', () => {
    // 40 rounds of 5 hits — far past anything a real game produces, which is the
    // point: the bound must be a property of the planner, not of the input.
    const events: GameEvent[] = [];
    for (let round = 0; round < 40; round++) {
      for (let i = 0; i < 5; i++) events.push(hit(1 + i, 200 + round, 2));
      events.push(died(200 + round)); // forces a round boundary each time
    }
    const beats = plan(events);
    const worstCase = maxTotalMs + impactMs + settleHoldMs;
    expect(sequenceDurationMs(beats)).toBeLessThanOrEqual(worstCase);
    // NOTHING WAS SILENTLY DROPPED: every recipient that took damage is shown.
    const shown = new Set(beats.map(endOf));
    for (let round = 0; round < 40; round++) expect(shown.has(`tile:${200 + round}`)).toBe(true);
  });

  it('the budget is spent in order: an early round animates in full, a late one condenses', () => {
    const events: GameEvent[] = [];
    for (let round = 0; round < 6; round++) {
      events.push(hit(1, 300 + round, 2));
      events.push(died(300 + round));
    }
    const beats = plan(events);
    expect(beats[0]?.kind).toBe('hit');
    expect(beats[beats.length - 1]?.kind).toBe('condensed');
    expect(sequenceDurationMs(beats)).toBeLessThanOrEqual(maxTotalMs + impactMs + settleHoldMs);
  });

  it('sequenceDurationMs is 0 for an empty plan', () => {
    expect(sequenceDurationMs([])).toBe(0);
  });
});

describe('the shared clock — a creature must not vanish before the hit lands', () => {
  const lookup = (id: InstanceId): AnimationCardInfo => ({ cardId: `c${id}`, name: `Card ${id}`, owner: 'B' });
  const grave = (instanceId: InstanceId): GameEvent => ({
    type: 'zoneChange',
    instanceId,
    from: 'battlefield',
    to: 'graveyard',
  });

  it('damageHoldMsFor reports when the LAST hit on an instance finishes landing', () => {
    const beats = plan([hit(1, 2, 1), hit(3, 2, 1)]);
    expect(damageHoldMsFor(beats, 2)).toBe(staggerMs + travelMs + impactMs);
    expect(damageHoldMsFor(beats, 99)).toBe(0);
  });

  it('a death ghost WAITS exactly as long as the damage plan says, and no longer', () => {
    const events: GameEvent[] = [hit(1, 2, 5), died(2), grave(2)];
    const beats = plan(events);
    const sprites = deriveAnimations(events, {
      reducedMotion: false,
      startIndex: 0,
      lookup,
      deathHoldMsFor: (id) => damageHoldMsFor(beats, id),
    });
    expect(sprites).toHaveLength(1);
    expect(sprites[0]?.delayMs).toBe(travelMs + impactMs);
  });

  it('a death with no damage behind it (a Doom Blade) still vanishes immediately', () => {
    const events: GameEvent[] = [died(2), grave(2)];
    const sprites = deriveAnimations(events, {
      reducedMotion: false,
      startIndex: 0,
      lookup,
      deathHoldMsFor: (id) => damageHoldMsFor(plan(events), id),
    });
    expect(sprites[0]?.delayMs).toBeUndefined();
  });

  it('a MILL is never held — only a death waits for a hit', () => {
    const events: GameEvent[] = [hit(1, 2, 5), { type: 'zoneChange', instanceId: 2, from: 'library', to: 'graveyard' }];
    const sprites = deriveAnimations(events, {
      reducedMotion: false,
      startIndex: 0,
      lookup,
      deathHoldMsFor: () => 999,
    });
    expect(sprites[0]).toMatchObject({ kind: 'mill' });
    expect(sprites[0]?.delayMs).toBeUndefined();
  });
});

describe('the bench table (rule 3) — every button must actually do something', () => {
  it('every row derives at least one beat, so no button is dead', () => {
    for (const row of DAMAGE_BENCH_ROWS) {
      expect(plan(row.events).length, `bench row "${row.id}" derived nothing`).toBeGreaterThan(0);
    }
  });

  it('row ids are unique (they are React keys)', () => {
    expect(new Set(DAMAGE_BENCH_ROWS.map((r) => r.id)).size).toBe(DAMAGE_BENCH_ROWS.length);
  });

  it('the rows that claim a presentation actually produce it', () => {
    const row = (id: string): readonly GameEvent[] =>
      DAMAGE_BENCH_ROWS.find((r) => r.id === id)?.events ?? [];
    expect(new Set(plan(row('firstStrike')).map((b) => b.roundIndex)).size).toBe(2);
    expect(plan(row('condensed')).every((b) => b.kind === 'condensed')).toBe(true);
    expect(plan(row('lethal'))[0]?.lethal).toBe(true);
    expect(plan(row('prevented'))[0]?.outcome).toBe('prevented');
    expect(plan(row('face'))[0]?.to).toEqual({ where: 'seat', seat: 'B' });
    expect(plan(row('trade')).every((b) => b.lethal)).toBe(true);
  });
});
