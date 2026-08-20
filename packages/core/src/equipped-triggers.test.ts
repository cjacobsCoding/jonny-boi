/**
 * TRIGGERS SCOPED TO THE ATTACHED HOST — "Whenever **equipped creature** deals
 * combat damage to a player, …" and "Whenever **equipped creature** attacks, …".
 *
 * The whole difficulty of this family is that the trigger's SOURCE and its
 * WATCHED OBJECT are two different permanents: the ability belongs to the Sword,
 * but the thing that has to swing is the creature carrying it. Every wrong
 * implementation of that fails silently and in the same direction — a trigger
 * that fires on the wrong object gives a card an ability it does not have — so
 * each half is asserted separately here rather than inferred from a win rate:
 *
 *   - it fires for the HOST's combat damage, and the source is the EQUIPMENT;
 *   - it does not fire for an unequipped creature's damage;
 *   - it does not fire at all while the Equipment is attached to nothing;
 *   - it FOLLOWS the Equipment when the Equipment moves, including when the
 *     attachment changes between two events of the SAME action (the case a
 *     cached `attachedTo` gets wrong, which is why the runtime holds a live
 *     reference instead).
 */

import { describe, expect, it } from 'vitest';
import {
  EQUIPMENT_WHEN_ILLEGAL,
  applyAction,
  conditionMatches,
  createGame,
  DEFAULT_RULES,
  type CardDefinition,
  type CardInstance,
  type GameAction,
  type GameEvent,
  type GameState,
  type InstanceId,
  type PlayerId,
  type TriggeredAbility,
} from './index.js';
import { createEffectRegistry } from './effects.js';
import { createTriggerCollector } from './internal/triggers-runtime.js';
import { creatureDef, deckOf, landDef } from './test-fixtures.js';

const ISLAND = landDef('Island', 'U');

/** "Whenever equipped creature deals combat damage to a player, draw a card." */
const SABOTEUR_TRIGGER: TriggeredAbility = {
  condition: { on: 'combatDamageToPlayer', watches: 'attachedHost' },
  effects: [{ primitive: 'drawCards', params: { count: 1 } }],
  label: 'Equipped creature deals combat damage: draw a card',
};

/** A Sword that only carries the trigger — the buff is irrelevant to this file. */
const SWORD: CardDefinition = {
  id: 'test:sword',
  name: 'Test Sword',
  types: ['artifact'],
  subtypes: ['equipment'],
  cost: { generic: 2 },
  attachment: {
    attachesTo: { anyOfTypes: ['creature'], controller: 'you' },
    whenIllegal: EQUIPMENT_WHEN_ILLEGAL,
    modifies: { power: 1 },
  },
  triggers: [SABOTEUR_TRIGGER],
};

/** The same ability printed on the creature itself, for the contrast cases. */
const SABOTEUR: CardDefinition = {
  ...creatureDef('Saboteur', 2, 2),
  triggers: [
    {
      condition: { on: 'combatDamageToPlayer' },
      effects: [{ primitive: 'drawCards', params: { count: 1 } }],
      label: 'Deals combat damage: draw a card',
    },
  ],
};

// --- driving a real combat -------------------------------------------------------

function act(state: GameState, action: GameAction): { state: GameState; events: readonly GameEvent[] } {
  const r = applyAction(state, action, DEFAULT_RULES, createEffectRegistry());
  const rejected = r.events.find((e) => e.type === 'actionRejected');
  if (rejected) throw new Error(`unexpected rejection: ${(rejected as { reason: string }).reason}`);
  return r;
}

/** A board with the given permanents in play under A, parked at declare-attackers. */
function board(defs: readonly CardDefinition[]): { state: GameState; ids: InstanceId[] } {
  const g = createGame({ seed: 3, decks: { A: deckOf(ISLAND, 40), B: deckOf(ISLAND, 40) } });
  let state = g.state;
  let nextId = state.nextInstanceId;
  const ids = defs.map((def) => {
    const id = nextId++;
    state.battlefield.push(instance(id, def, 'A'));
    return id;
  });
  state.nextInstanceId = nextId;
  let guard = 0;
  while (state.step !== 'declareAttackers' && !state.gameOver && guard++ < 300) {
    state = act(state, { kind: 'passPriority', player: state.priorityPlayer }).state;
  }
  return { state, ids };
}

function instance(instanceId: InstanceId, def: CardDefinition, controller: PlayerId): CardInstance {
  return {
    instanceId,
    def,
    controller,
    owner: controller,
    zone: 'battlefield',
    tapped: false,
    summoningSick: false,
    damageMarked: 0,
    markedByDeathtouch: false,
    counters: {},
    attachedTo: null,
  };
}

function find(state: GameState, id: InstanceId): CardInstance {
  const found = state.battlefield.find((c) => c.instanceId === id);
  if (!found) throw new Error(`no instance ${id} on the battlefield`);
  return found;
}

/**
 * Attack with `attackers`, take it through combat damage, and return every
 * trigger that reached the stack on the way.
 */
function swing(state: GameState, attackers: readonly InstanceId[]): readonly GameEvent[] {
  const declared = act(state, { kind: 'declareAttackers', player: 'A', attackers: [...attackers] });
  let s = declared.state;
  // The attack triggers go on the stack DURING the declaration, so the events of
  // that action are part of what this returns — collecting only the later passes
  // would make an `attacks` trigger look like it never fired.
  const seen: GameEvent[] = [...declared.events];
  let guard = 0;
  while (s.step !== 'postcombatMain' && !s.gameOver && guard++ < 300) {
    const r = act(s, { kind: 'passPriority', player: s.priorityPlayer });
    s = r.state;
    seen.push(...r.events);
  }
  return seen;
}

/** The labels of the triggers that were put on the stack, in order. */
function triggerLabels(events: readonly GameEvent[]): string[] {
  return events.filter((e) => e.type === 'triggerPutOnStack').map((e) => (e as { label: string }).label);
}

describe('a trigger that watches the EQUIPPED creature', () => {
  it('fires when the HOST deals combat damage to a player — and the source is the Equipment', () => {
    const { state, ids } = board([SABOTEUR, SWORD]);
    const [creature, sword] = ids as [InstanceId, InstanceId];
    find(state, sword).attachedTo = creature;

    const events = swing(state, [creature]);
    const fired = events.filter((e) => e.type === 'triggerPutOnStack') as Array<{
      sourceInstanceId: InstanceId;
      controller: PlayerId;
      label: string;
    }>;
    // Two abilities watched that one hit: the creature's own, and the Sword's.
    expect(fired.map((f) => f.label)).toEqual([
      'Deals combat damage: draw a card',
      'Equipped creature deals combat damage: draw a card',
    ]);
    // The Sword's trigger belongs to the SWORD, not to the creature that swung.
    const swordTrigger = fired.find((f) => f.label.startsWith('Equipped'));
    expect(swordTrigger?.sourceInstanceId).toBe(sword);
    expect(swordTrigger?.controller).toBe('A');
  });

  it('does NOT fire while the Equipment is attached to nothing', () => {
    const { state, ids } = board([SABOTEUR, SWORD]);
    const [creature] = ids as [InstanceId, InstanceId];
    // The Sword is on the battlefield and equipped to no one.
    const events = swing(state, [creature]);
    expect(triggerLabels(events)).toEqual(['Deals combat damage: draw a card']);
  });

  it('does NOT fire for a creature the Equipment is not attached to', () => {
    const { state, ids } = board([SABOTEUR, SWORD, creatureDef('Bystander', 2, 2)]);
    const [saboteur, sword, bystander] = ids as [InstanceId, InstanceId, InstanceId];
    find(state, sword).attachedTo = bystander;

    // The saboteur connects; the Sword is on the OTHER creature, which stayed home.
    const events = swing(state, [saboteur]);
    expect(triggerLabels(events)).toEqual(['Deals combat damage: draw a card']);
  });

  it('follows the Equipment when it moves to another creature', () => {
    const { state, ids } = board([creatureDef('First', 2, 2), creatureDef('Second', 2, 2), SWORD]);
    const [first, second, sword] = ids as [InstanceId, InstanceId, InstanceId];

    find(state, sword).attachedTo = first;
    expect(triggerLabels(swing(state, [first, second]))).toEqual([
      'Equipped creature deals combat damage: draw a card',
    ]);

    // Re-equip to the other creature; the same two attackers now fire it once for
    // the SECOND one. (One fire either way — what is being asserted is that the
    // trigger followed, which a source-id comparison alone would not show.)
    find(state, sword).attachedTo = second;
    const after = swing(state, [first, second]);
    expect(triggerLabels(after)).toEqual(['Equipped creature deals combat damage: draw a card']);
  });

  it('also scopes "whenever equipped creature ATTACKS" to the host', () => {
    const attackWatcher: CardDefinition = {
      ...SWORD,
      id: 'test:banner',
      name: 'Test Banner',
      triggers: [
        {
          condition: { on: 'attacks', watches: 'attachedHost' },
          effects: [{ primitive: 'drawCards', params: { count: 1 } }],
          label: 'Equipped creature attacks: draw a card',
        },
      ],
    };
    const { state, ids } = board([creatureDef('Carrier', 2, 2), creatureDef('Other', 2, 2), attackWatcher]);
    const [carrier, other, banner] = ids as [InstanceId, InstanceId, InstanceId];

    find(state, banner).attachedTo = carrier;
    expect(triggerLabels(swing(state, [other]))).toEqual([]);

    const withCarrier = board([creatureDef('Carrier', 2, 2), creatureDef('Other', 2, 2), attackWatcher]);
    const [c2, , b2] = withCarrier.ids as [InstanceId, InstanceId, InstanceId];
    find(withCarrier.state, b2).attachedTo = c2;
    expect(triggerLabels(swing(withCarrier.state, [c2]))).toEqual([
      'Equipped creature attacks: draw a card',
    ]);
  });
});

describe('the attached-host watch reads the CURRENT attachment', () => {
  /**
   * The regression this file exists for. The runtime caches one `TriggerSource`
   * per permanent and rebuilds it only when the controller or the ability list
   * changes — so a `TriggerSource` that copied `attachedTo` would answer with
   * the attachment the Equipment had when it was first seen this action.
   *
   * Here the attachment changes BETWEEN two emitted events without anything else
   * about the Equipment changing. A live reference follows it; a copy does not.
   */
  it('follows an attachment that changes between two events of one action', () => {
    const g = createGame({ seed: 5, decks: { A: deckOf(ISLAND, 40), B: deckOf(ISLAND, 40) } });
    const state = g.state;
    const first = instance(state.nextInstanceId++, creatureDef('First', 2, 2), 'A');
    const second = instance(state.nextInstanceId++, creatureDef('Second', 2, 2), 'A');
    const sword = instance(state.nextInstanceId++, SWORD, 'A');
    state.battlefield.push(first, second, sword);
    sword.attachedTo = first.instanceId;

    const log: GameEvent[] = [];
    const collector = createTriggerCollector(state, (e) => log.push(e));
    const hit = (source: InstanceId): GameEvent => ({
      type: 'damageDealt',
      source,
      target: 'B',
      amount: 2,
      combat: true,
    });

    collector.emit(hit(first.instanceId));
    expect(collector.flush()).toBe(1);

    // Move the Sword WITHOUT touching its controller or its ability list.
    sword.attachedTo = second.instanceId;
    collector.emit(hit(first.instanceId));
    expect(collector.flush()).toBe(0); // the old host no longer counts
    collector.emit(hit(second.instanceId));
    expect(collector.flush()).toBe(1); // the new one does
  });

  it('stops firing the moment the Equipment falls off mid-action', () => {
    const g = createGame({ seed: 6, decks: { A: deckOf(ISLAND, 40), B: deckOf(ISLAND, 40) } });
    const state = g.state;
    const host = instance(state.nextInstanceId++, creatureDef('Host', 2, 2), 'A');
    const sword = instance(state.nextInstanceId++, SWORD, 'A');
    state.battlefield.push(host, sword);
    sword.attachedTo = host.instanceId;

    const collector = createTriggerCollector(state, () => {});
    const hit: GameEvent = { type: 'damageDealt', source: host.instanceId, target: 'B', amount: 2, combat: true };
    collector.emit(hit);
    expect(collector.flush()).toBe(1);

    // The state-based actions unattach it (its host died to first-strike damage).
    sword.attachedTo = null;
    collector.emit(hit);
    expect(collector.flush()).toBe(0);
  });
});

describe('conditionMatches — the pure half', () => {
  const SOURCE = 1 as InstanceId;
  const HOST = 2 as InstanceId;
  const OTHER = 3 as InstanceId;
  const damage = (source: InstanceId): GameEvent => ({
    type: 'damageDealt',
    source,
    target: 'B',
    amount: 1,
    combat: true,
  });

  it('matches the HOST and not the source itself', () => {
    const condition = { on: 'combatDamageToPlayer', watches: 'attachedHost' } as const;
    expect(conditionMatches(condition, damage(HOST), SOURCE, 'A', undefined, HOST)).toBe(true);
    expect(conditionMatches(condition, damage(SOURCE), SOURCE, 'A', undefined, HOST)).toBe(false);
    expect(conditionMatches(condition, damage(OTHER), SOURCE, 'A', undefined, HOST)).toBe(false);
  });

  it('matches NOTHING when attached to nothing — it never falls back to itself', () => {
    const condition = { on: 'combatDamageToPlayer', watches: 'attachedHost' } as const;
    for (const attached of [null, undefined]) {
      expect(conditionMatches(condition, damage(SOURCE), SOURCE, 'A', undefined, attached)).toBe(false);
      expect(conditionMatches(condition, damage(HOST), SOURCE, 'A', undefined, attached)).toBe(false);
    }
  });

  it('leaves the default (self) watch byte-for-byte as it was', () => {
    const condition = { on: 'combatDamageToPlayer' } as const;
    expect(conditionMatches(condition, damage(SOURCE), SOURCE, 'A')).toBe(true);
    expect(conditionMatches(condition, damage(HOST), SOURCE, 'A')).toBe(false);
    // An `attachedTo` handed to a self-watching condition is ignored, not honoured.
    expect(conditionMatches(condition, damage(HOST), SOURCE, 'A', undefined, HOST)).toBe(false);
    expect(conditionMatches(condition, damage(SOURCE), SOURCE, 'A', undefined, HOST)).toBe(true);
  });

  it('scopes the other self-referential events the same way', () => {
    const attacked: GameEvent = { type: 'attackersDeclared', player: 'A', attackers: [HOST] };
    expect(conditionMatches({ on: 'attacks', watches: 'attachedHost' }, attacked, SOURCE, 'A', undefined, HOST)).toBe(
      true,
    );
    expect(conditionMatches({ on: 'attacks' }, attacked, SOURCE, 'A', undefined, HOST)).toBe(false);

    const died: GameEvent = { type: 'creatureDied', instanceId: HOST, name: 'Host' };
    expect(conditionMatches({ on: 'dies', watches: 'attachedHost' }, died, SOURCE, 'A', undefined, HOST)).toBe(true);
    expect(conditionMatches({ on: 'dies', watches: 'attachedHost' }, died, SOURCE, 'A', undefined, null)).toBe(false);
  });
});
