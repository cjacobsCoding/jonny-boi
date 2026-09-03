/**
 * THE PREFILTER CONTRACT (DESIGN §3.53): `TRIGGER_EVENT_SOURCES` must be a
 * SUPERSET of what `conditionMatches` can match, for every condition kind — or
 * the collector's event-type prefilter would skip the scan on an event a live
 * trigger was entitled to fire on, which is a silently-missing trigger, this
 * repo's most-feared defect shape.
 *
 * Method: for every `TriggerEvent`, fire its CANONICAL matching event through
 * `conditionMatches` (the real matcher — no mocks) and assert both halves:
 * the condition genuinely matches it, and the event's type is listed for that
 * condition. A case rewritten onto a different event type then fails the
 * second assertion here rather than silently never firing behind the filter.
 * The record's completeness over `TriggerEvent` is compile-checked by its
 * `Record` shape, so a NEW condition kind cannot ship unlisted at all.
 */

import { describe, expect, it } from 'vitest';
import type { GameEvent } from './events.js';
import {
  conditionMatches,
  eventTypeWatchBit,
  TRIGGER_EVENT_SOURCES,
  watchedEventMaskOf,
  type TriggerCondition,
  type TriggerEvent,
  type TriggerSource,
} from './triggers.js';

const SOURCE_ID = 11;
const OTHER_ID = 22;

/**
 * One canonical (condition, matching event) pair per condition kind. `subject`
 * rides along for the two board-watching kinds, resolved the way the runtime
 * resolves it.
 */
const CANONICAL: Readonly<
  Record<
    TriggerEvent,
    {
      readonly condition: TriggerCondition;
      readonly event: GameEvent;
      readonly subject?: { controller: 'A' | 'B'; card: { def: { types: readonly string[] } } };
    }
  >
> = {
  etb: {
    condition: { on: 'etb' },
    event: { type: 'zoneChange', instanceId: SOURCE_ID, from: 'hand', to: 'battlefield' },
  },
  attacks: {
    condition: { on: 'attacks' },
    event: { type: 'attackersDeclared', attackers: [SOURCE_ID] },
  },
  blocksOrBecomesBlocked: {
    condition: { on: 'blocksOrBecomesBlocked' },
    event: { type: 'blockersDeclared', blocks: [{ blocker: OTHER_ID, attacker: SOURCE_ID }] },
  },
  // The combat keyword family (DESIGN §3.107). Exalted's event reads the lone
  // attacker as its SUBJECT, resolved the way the runtime resolves it.
  creatureAttacksAlone: {
    condition: { on: 'creatureAttacksAlone' },
    event: { type: 'attackersDeclared', attackers: [OTHER_ID] },
    subject: { controller: 'A', card: { def: { types: ['creature'] } } },
  },
  blocks: {
    condition: { on: 'blocks' },
    event: { type: 'blockersDeclared', blocks: [{ blocker: SOURCE_ID, attacker: OTHER_ID }] },
  },
  becomesBlocked: {
    condition: { on: 'becomesBlocked' },
    event: { type: 'blockersDeclared', blocks: [{ blocker: OTHER_ID, attacker: SOURCE_ID }] },
  },
  becomesBlockedByCreature: {
    condition: { on: 'becomesBlockedByCreature' },
    event: { type: 'blockersDeclared', blocks: [{ blocker: OTHER_ID, attacker: SOURCE_ID }] },
  },
  dies: {
    condition: { on: 'dies' },
    event: { type: 'creatureDied', instanceId: SOURCE_ID, name: 'Canary' },
  },
  leaves: {
    condition: { on: 'leaves' },
    event: { type: 'zoneChange', instanceId: SOURCE_ID, from: 'battlefield', to: 'exile' },
  },
  // §3.111 — Rancor's "put into a graveyard from the battlefield".
  putIntoGraveyardFromBattlefield: {
    condition: { on: 'putIntoGraveyardFromBattlefield' },
    event: { type: 'zoneChange', instanceId: SOURCE_ID, from: 'battlefield', to: 'graveyard' },
  },
  castSpell: {
    condition: { on: 'castSpell', who: 'you' },
    event: { type: 'spellCast', player: 'A', instanceId: OTHER_ID, name: 'Bolt', castTypes: ['instant'] },
  },
  upkeep: {
    condition: { on: 'upkeep', who: 'you' },
    event: { type: 'stepBegin', step: 'upkeep', activePlayer: 'A' },
  },
  drawStep: {
    condition: { on: 'drawStep', who: 'you' },
    event: { type: 'stepBegin', step: 'draw', activePlayer: 'A' },
  },
  precombatMain: {
    condition: { on: 'precombatMain', who: 'you' },
    event: { type: 'stepBegin', step: 'precombatMain', activePlayer: 'A' },
  },
  endStep: {
    condition: { on: 'endStep', who: 'you' },
    event: { type: 'stepBegin', step: 'end', activePlayer: 'A' },
  },
  beginCombat: {
    condition: { on: 'beginCombat', who: 'you' },
    event: { type: 'stepBegin', step: 'beginCombat', activePlayer: 'A' },
  },
  gainLife: {
    condition: { on: 'gainLife', who: 'you' },
    event: { type: 'gainLife', player: 'A', amount: 3 },
  },
  combatDamageToPlayer: {
    condition: { on: 'combatDamageToPlayer' },
    event: { type: 'damageDealt', source: SOURCE_ID, target: 'B', amount: 2, combat: true },
  },
  permanentEnters: {
    condition: { on: 'permanentEnters', who: 'you' },
    event: { type: 'zoneChange', instanceId: OTHER_ID, from: 'hand', to: 'battlefield' },
    subject: { controller: 'A', card: { def: { types: ['creature'] } } },
  },
  permanentDies: {
    condition: { on: 'permanentDies', who: 'you' },
    event: { type: 'zoneChange', instanceId: OTHER_ID, from: 'battlefield', to: 'graveyard' },
    subject: { controller: 'A', card: { def: { types: ['creature'] } } },
  },
  drawsCard: {
    condition: { on: 'drawsCard', who: 'you' },
    event: { type: 'drawCard', player: 'A', instanceId: OTHER_ID },
  },
};

describe('TRIGGER_EVENT_SOURCES is a superset of what conditionMatches matches', () => {
  for (const [kind, pair] of Object.entries(CANONICAL) as readonly [
    TriggerEvent,
    (typeof CANONICAL)[TriggerEvent],
  ][]) {
    it(`${kind}: its canonical event matches, and that event's type is listed`, () => {
      const matched = conditionMatches(
        pair.condition,
        pair.event,
        SOURCE_ID,
        'A',
        pair.subject as Parameters<typeof conditionMatches>[4],
      );
      // Half one: the canonical pair is REAL — if this fails, the test's pair
      // is wrong, not the mapping, and it must be fixed before it can vouch.
      expect(matched, `canonical ${kind} pair no longer matches`).toBe(true);
      // Half two: the prefilter would have let this event through — both as the
      // declared list and as the live bitmask a collector actually consults.
      expect(
        TRIGGER_EVENT_SOURCES[kind],
        `conditionMatches(${kind}) matched a '${pair.event.type}' event the prefilter would drop`,
      ).toContain(pair.event.type);
      const mask = watchedEventMaskOf([
        {
          instanceId: SOURCE_ID,
          controller: 'A',
          name: 'Canary',
          triggers: [{ condition: pair.condition, effects: [] }],
        },
      ]);
      expect(
        mask & eventTypeWatchBit(pair.event.type),
        `the ${kind} watch mask would drop its own canonical '${pair.event.type}' event`,
      ).not.toBe(0);
    });
  }

  it('the union mask covers every source and filters what nobody watches', () => {
    const source: TriggerSource = {
      instanceId: SOURCE_ID,
      controller: 'A',
      name: 'Canary',
      triggers: [
        { condition: { on: 'etb' }, effects: [] },
        { condition: { on: 'gainLife', who: 'you' }, effects: [] },
      ],
    };
    const mask = watchedEventMaskOf([source]);
    expect(mask & eventTypeWatchBit('zoneChange')).not.toBe(0);
    expect(mask & eventTypeWatchBit('gainLife')).not.toBe(0);
    // An event type nobody watches stays filtered…
    expect(mask & eventTypeWatchBit('attackersDeclared')).toBe(0);
    // …and a type NO trigger kind can ever watch has no bit at all.
    expect(eventTypeWatchBit('manaAdded')).toBe(0);
  });
});
