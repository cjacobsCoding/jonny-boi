/**
 * The trigger-condition vocabulary added for the counters-matter templates:
 * begin-of-combat, end step, life gain, ANY creature's death, and this
 * permanent's combat damage to a player.
 *
 * Each is pinned from both sides — it fires on the event it names, and it does
 * NOT fire on the near-miss event that would make it a different card. The
 * near-miss half is the one that matters: a lifegain trigger that also fired on
 * life LOST, or an any-creature-dies trigger that fired only for its own source,
 * would still look implemented while playing nothing like the printed card.
 */

import { describe, expect, it } from 'vitest';
import { conditionMatches } from './triggers.js';
import type { GameEvent } from './events.js';
import type { CardInstance, InstanceId, PlayerId } from './state.js';

const SOURCE: InstanceId = 7;
const OTHER: InstanceId = 9;
const ME: PlayerId = 'A';
const THEM: PlayerId = 'B';

const matches = (condition: Parameters<typeof conditionMatches>[0], event: GameEvent): boolean =>
  conditionMatches(condition, event, SOURCE, ME);

describe('step triggers', () => {
  it('beginCombat fires on YOUR begin-combat step and not the opponent’s', () => {
    const condition = { on: 'beginCombat', who: 'you' } as const;
    expect(matches(condition, { type: 'stepBegin', step: 'beginCombat', activePlayer: ME })).toBe(true);
    expect(matches(condition, { type: 'stepBegin', step: 'beginCombat', activePlayer: THEM })).toBe(false);
    // The near miss: another step of the same turn.
    expect(matches(condition, { type: 'stepBegin', step: 'upkeep', activePlayer: ME })).toBe(false);
  });

  it('endStep with who "any" fires on both players’ end steps', () => {
    const yours = { on: 'endStep', who: 'you' } as const;
    const each = { on: 'endStep', who: 'any' } as const;
    expect(matches(yours, { type: 'stepBegin', step: 'end', activePlayer: ME })).toBe(true);
    expect(matches(yours, { type: 'stepBegin', step: 'end', activePlayer: THEM })).toBe(false);
    expect(matches(each, { type: 'stepBegin', step: 'end', activePlayer: THEM })).toBe(true);
    // "end" is the end STEP, not the cleanup step that follows it.
    expect(matches(each, { type: 'stepBegin', step: 'cleanup', activePlayer: ME })).toBe(false);
  });
});

describe('life-gain triggers', () => {
  it('fires when YOU gain life', () => {
    const condition = { on: 'gainLife', who: 'you' } as const;
    expect(matches(condition, { type: 'gainLife', player: ME, amount: 3 })).toBe(true);
    expect(matches(condition, { type: 'gainLife', player: THEM, amount: 3 })).toBe(false);
  });

  it('does NOT fire on life LOST, which `lifeChanged` also reports', () => {
    const condition = { on: 'gainLife', who: 'you' } as const;
    expect(matches(condition, { type: 'lifeChanged', player: ME, delta: -3, to: 17 })).toBe(false);
    // Nor on the positive half of lifeChanged: `gainLife` is the event a printed
    // "whenever you gain life" watches, and it is emitted alongside.
    expect(matches(condition, { type: 'lifeChanged', player: ME, delta: 3, to: 23 })).toBe(false);
  });
});

describe('any-creature-dies triggers', () => {
  it('fires for ANOTHER creature’s death as well as its own', () => {
    const condition = { on: 'creatureDies' } as const;
    expect(matches(condition, { type: 'creatureDied', instanceId: OTHER, name: 'Bear' })).toBe(true);
    expect(matches(condition, { type: 'creatureDied', instanceId: SOURCE, name: 'Me' })).toBe(true);
  });

  it('a `who` scope narrows it to one player’s creatures, and needs the controller', () => {
    const yours = { on: 'creatureDies', who: 'you' } as const;
    expect(matches(yours, { type: 'creatureDied', instanceId: OTHER, name: 'Bear', controller: ME })).toBe(true);
    expect(matches(yours, { type: 'creatureDied', instanceId: OTHER, name: 'Bear', controller: THEM })).toBe(false);
    // An event that does not name the controller (an older log fold) cannot
    // satisfy a scoped filter, so it does not fire.
    expect(matches(yours, { type: 'creatureDied', instanceId: OTHER, name: 'Bear' })).toBe(false);
  });

  it('the SELF-only "dies" condition still fires for its own death alone', () => {
    const condition = { on: 'dies' } as const;
    expect(matches(condition, { type: 'creatureDied', instanceId: SOURCE, name: 'Me' })).toBe(true);
    expect(matches(condition, { type: 'creatureDied', instanceId: OTHER, name: 'Bear' })).toBe(false);
  });
});

describe('combat-damage-to-a-player triggers', () => {
  const condition = { on: 'combatDamageToPlayer' } as const;

  it('fires for this permanent’s combat damage to a player', () => {
    expect(
      matches(condition, { type: 'damageDealt', source: SOURCE, target: THEM, amount: 2, combat: true }),
    ).toBe(true);
  });

  it('does not fire for NON-combat damage, another source, or damage to a creature', () => {
    expect(
      matches(condition, { type: 'damageDealt', source: SOURCE, target: THEM, amount: 2, combat: false }),
    ).toBe(false);
    expect(
      matches(condition, { type: 'damageDealt', source: OTHER, target: THEM, amount: 2, combat: true }),
    ).toBe(false);
    // A creature/planeswalker target is an InstanceId (a number), never a PlayerId.
    expect(
      matches(condition, { type: 'damageDealt', source: SOURCE, target: OTHER, amount: 2, combat: true }),
    ).toBe(false);
  });
});

describe('another-permanent-enters triggers', () => {
  /** A battlefield view holding one entering permanent. */
  function view(instanceId: InstanceId, controller: PlayerId, types: readonly string[], colorPip?: 'G') {
    const card = {
      instanceId,
      controller,
      def: {
        id: `t:${instanceId}`,
        name: `T${instanceId}`,
        types,
        ...(colorPip ? { cost: { generic: 0, W: 0, U: 0, B: 0, R: 0, G: 1, C: 0 } } : {}),
      },
      counters: {},
    } as unknown as CardInstance;
    return { battlefield: [card] };
  }

  const entered = (instanceId: InstanceId): GameEvent => ({
    type: 'zoneChange',
    instanceId,
    from: 'stack',
    to: 'battlefield',
  });

  it('fires for another creature you control and not for the opponent’s', () => {
    const condition = {
      on: 'permanentEtb',
      who: 'you',
      entering: { anyOfTypes: ['creature'] },
    } as const;
    expect(conditionMatches(condition, entered(OTHER), SOURCE, ME, view(OTHER, ME, ['creature']))).toBe(true);
    expect(conditionMatches(condition, entered(OTHER), SOURCE, ME, view(OTHER, THEM, ['creature']))).toBe(false);
    // A land arriving is not a creature arriving.
    expect(conditionMatches(condition, entered(OTHER), SOURCE, ME, view(OTHER, ME, ['land']))).toBe(false);
  });

  it('the printed word "another" excludes the source’s own arrival', () => {
    const another = {
      on: 'permanentEtb',
      who: 'you',
      excludeSelf: true,
      entering: { anyOfTypes: ['creature'] },
    } as const;
    const plain = { on: 'permanentEtb', who: 'you', entering: { anyOfTypes: ['creature'] } } as const;
    expect(conditionMatches(another, entered(SOURCE), SOURCE, ME, view(SOURCE, ME, ['creature']))).toBe(false);
    expect(conditionMatches(plain, entered(SOURCE), SOURCE, ME, view(SOURCE, ME, ['creature']))).toBe(true);
  });

  it('never fires without a state view — an unverifiable filter must not fire', () => {
    const condition = { on: 'permanentEtb', who: 'you', entering: { anyOfTypes: ['creature'] } } as const;
    expect(conditionMatches(condition, entered(OTHER), SOURCE, ME)).toBe(false);
  });

  it('honours a colour filter ("another GREEN creature you control")', () => {
    const condition = {
      on: 'permanentEtb',
      who: 'you',
      entering: { anyOfTypes: ['creature'], anyOfColors: ['G'] },
    } as const;
    expect(conditionMatches(condition, entered(OTHER), SOURCE, ME, view(OTHER, ME, ['creature'], 'G'))).toBe(true);
    expect(conditionMatches(condition, entered(OTHER), SOURCE, ME, view(OTHER, ME, ['creature']))).toBe(false);
  });
});
