/**
 * THE COMBAT TRIGGERS WITH A SUBJECT (DESIGN §3.107) — exalted, flanking,
 * rampage and the self-pump combat triggers, as core sees them: four
 * `TriggerEvent`s and the `triggeringInstances` seam that carries "that
 * creature" / "the blocking creature" from the declaration to the body.
 *
 * Two layers, deliberately:
 *   - the MATCHER (`matchTriggers`), where the semantics worth pinning live —
 *     which objects an event is about and how MANY times one declaration
 *     fires (CR 509.1h says once; CR 702.25b says once per blocker for
 *     flanking) — driven directly, as `blocks-trigger.test.ts` does;
 *   - the ENGINE, end to end, with a probe primitive that reads
 *     `ctx.triggeringInstances` — proving the seam survives the stack, the
 *     clone at the action boundary, and the resolution frame. The real pump
 *     that reads it lives in `cards`, and is played there.
 */

import { describe, expect, it } from 'vitest';
import type { CardDefinition } from './card.js';
import type { GameEvent } from './events.js';
import { aggregateFor } from './internal/continuous.js';
import { effectivePower, effectiveToughness } from './internal/stats.js';
import type { CardInstance, GameState, InstanceId, PlayerId } from './state.js';
import { creatureDef, landDef } from './test-fixtures.js';
import {
  matchTriggers,
  triggeringInstancesFor,
  type TriggerSource,
  type TriggerSubject,
  type TriggeredAbility,
} from './triggers.js';
import { act, advanceTo, newGame, pass, putOnBattlefield, registryWith, givePriorityTo, nonActive } from './conformance/harness.js';

// --- the matcher -------------------------------------------------------------------

const PUMP_TRIGGERING = { primitive: 'pumpTriggering', params: { power: 1, toughness: 1 } };

function ability(condition: TriggeredAbility['condition'], label: string): TriggeredAbility {
  return { condition, effects: [PUMP_TRIGGERING], label };
}

function source(instanceId: number, controller: PlayerId, ...triggers: TriggeredAbility[]): TriggerSource {
  return { instanceId, controller, name: `Source ${instanceId}`, triggers };
}

function attackers(...ids: number[]): GameEvent {
  return { type: 'attackersDeclared', attackers: ids } as GameEvent;
}

function blocks(...pairs: Array<[blocker: number, attacker: number]>): GameEvent {
  return { type: 'blockersDeclared', blocks: pairs.map(([blocker, attacker]) => ({ blocker, attacker })) } as GameEvent;
}

/** A subject resolver standing for "instance N is controlled by …". */
function controlledBy(owners: Readonly<Record<number, PlayerId>>): (id: InstanceId) => TriggerSubject | undefined {
  return (id) => {
    const controller = owners[id];
    if (controller === undefined) return undefined;
    return { controller, card: { instanceId: id, def: { id: 'x', name: 'x', types: ['creature'] } } as CardInstance };
  };
}

describe('creatureAttacksAlone — exalted\'s event', () => {
  const EXALTED = ability({ on: 'creatureAttacksAlone' }, 'Exalted');

  it('fires when one creature you control attacks, carrying that creature', () => {
    const pending = matchTriggers([source(1, 'A', EXALTED)], attackers(50), controlledBy({ 50: 'A' }));
    expect(pending).toHaveLength(1);
    expect(pending[0]?.triggeringInstances).toEqual([50]);
  });

  it('the source need not be the attacker — a land with exalted fires for the attacker', () => {
    const pending = matchTriggers([source(7, 'A', EXALTED)], attackers(50), controlledBy({ 50: 'A' }));
    expect(pending).toHaveLength(1);
  });

  it('does NOT fire when two creatures attack — nothing attacked alone (CR 506.5)', () => {
    expect(matchTriggers([source(1, 'A', EXALTED)], attackers(50, 51), controlledBy({ 50: 'A', 51: 'A' }))).toHaveLength(0);
  });

  it('does NOT fire for the OPPONENT\'s lone attacker', () => {
    expect(matchTriggers([source(1, 'A', EXALTED)], attackers(50), controlledBy({ 50: 'B' }))).toHaveLength(0);
  });

  it('every exalted permanent fires once — three sources, three abilities', () => {
    const pending = matchTriggers(
      [source(1, 'A', EXALTED), source(2, 'A', EXALTED), source(3, 'A', EXALTED)],
      attackers(50),
      controlledBy({ 50: 'A' }),
    );
    expect(pending).toHaveLength(3);
  });

  it('matches nothing without a resolvable subject', () => {
    expect(matchTriggers([source(1, 'A', EXALTED)], attackers(50))).toHaveLength(0);
  });
});

describe('blocks — the blocker\'s half alone', () => {
  const BLOCKS = ability({ on: 'blocks' }, 'Blocks');

  it('fires for the creature that blocked, carrying what it blocked', () => {
    const pending = matchTriggers([source(10, 'B', BLOCKS)], blocks([10, 20]));
    expect(pending).toHaveLength(1);
    expect(pending[0]?.triggeringInstances).toEqual([20]);
  });

  it('does NOT fire for the creature that became blocked', () => {
    expect(matchTriggers([source(20, 'A', BLOCKS)], blocks([10, 20]))).toHaveLength(0);
  });
});

describe('becomesBlocked — the attacker\'s half alone, ONE fire per declaration', () => {
  const BECOMES_BLOCKED = ability({ on: 'becomesBlocked' }, 'Becomes blocked');

  it('fires for the creature that became blocked, carrying every blocker', () => {
    const pending = matchTriggers([source(20, 'A', BECOMES_BLOCKED)], blocks([10, 20], [11, 20], [12, 21]));
    expect(pending).toHaveLength(1);
    expect(pending[0]?.triggeringInstances).toEqual([10, 11]);
  });

  it('⚠️ a triple-blocked attacker fires ONCE (CR 509.1h)', () => {
    expect(matchTriggers([source(20, 'A', BECOMES_BLOCKED)], blocks([10, 20], [11, 20], [12, 20]))).toHaveLength(1);
  });

  it('does NOT fire for the blocker', () => {
    expect(matchTriggers([source(10, 'B', BECOMES_BLOCKED)], blocks([10, 20]))).toHaveLength(0);
  });
});

describe('becomesBlockedByCreature — flanking\'s event, ONE fire PER BLOCKER', () => {
  const FLANKING = ability({ on: 'becomesBlockedByCreature', counterpartLacksKeyword: 'flanking' }, 'Flanking');

  it('⚠️ a triple-blocked attacker fires THREE times, each carrying one blocker (CR 702.25b)', () => {
    const pending = matchTriggers([source(20, 'A', FLANKING)], blocks([10, 20], [11, 20], [12, 20]));
    expect(pending.map((p) => p.triggeringInstances)).toEqual([[10], [11], [12]]);
  });

  it('an unblocked attacker fires nothing', () => {
    expect(matchTriggers([source(20, 'A', FLANKING)], blocks([10, 21]))).toHaveLength(0);
  });

  it('triggeringInstancesFor answers the same question for every kind', () => {
    expect(triggeringInstancesFor({ on: 'becomesBlockedByCreature' }, blocks([10, 20], [11, 20]), 20)).toEqual([10, 11]);
    expect(triggeringInstancesFor({ on: 'blocks' }, blocks([10, 20]), 10)).toEqual([20]);
    expect(triggeringInstancesFor({ on: 'creatureAttacksAlone' }, attackers(50), 1)).toEqual([50]);
    // Every pre-existing kind yields undefined, so it is pushed exactly as before.
    expect(triggeringInstancesFor({ on: 'attacks' }, attackers(50), 50)).toBeUndefined();
    expect(triggeringInstancesFor({ on: 'blocksOrBecomesBlocked' }, blocks([10, 20]), 20)).toBeUndefined();
  });
});

// --- the engine, end to end ----------------------------------------------------------

/**
 * The probe: pump every triggering instance by the params, so what reaches the
 * body is observable as effective P/T on the board. `+1/+1` for exalted and
 * `-1/-1` for flanking, exactly as the printed cards read.
 */
const registry = registryWith({
  pumpTriggering: (ctx) => {
    const power = typeof ctx.params.power === 'number' ? ctx.params.power : 0;
    const toughness = typeof ctx.params.toughness === 'number' ? ctx.params.toughness : 0;
    for (const id of ctx.triggeringInstances ?? []) {
      ctx.addContinuousEffect({ target: id, power, toughness, duration: 'endOfTurn' });
    }
  },
});

const BEAR = creatureDef('Bear', 2, 2);
const FLANKER_KEYWORDED = creatureDef('Flanking Blocker', 2, 2, { keywords: { flanking: true } });

/** Exalted as core sees it: a land whose trigger watches the lone attacker. */
const CATHEDRAL_OF_WAR: CardDefinition = {
  ...landDef('Cathedral of War', 'C'),
  triggers: [{ condition: { on: 'creatureAttacksAlone' }, effects: [PUMP_TRIGGERING], label: 'Exalted' }],
};

/** Flanking as core sees it: the flag plus the per-blocker trigger. */
const BENALISH_CAVALRY: CardDefinition = {
  ...creatureDef('Benalish Cavalry', 2, 2, { keywords: { flanking: true } }),
  triggers: [
    {
      condition: { on: 'becomesBlockedByCreature', counterpartLacksKeyword: 'flanking' },
      effects: [{ primitive: 'pumpTriggering', params: { power: -1, toughness: -1 } }],
      label: 'Flanking',
    },
  ],
};

function statsOf(state: GameState, id: InstanceId): { power: number; toughness: number } {
  const inst = state.battlefield.find((c) => c.instanceId === id)!;
  const mod = aggregateFor(state, id);
  return { power: effectivePower(inst, mod), toughness: effectiveToughness(inst, mod) };
}

/** Declare `ids` as attackers for A and resolve whatever triggered. */
function attackAndResolve(state: GameState, ids: readonly InstanceId[]): GameState {
  const declare = advanceTo(state, 'declareAttackers', registry);
  let s = act(declare, { kind: 'declareAttackers', player: 'A', attackers: [...ids] }, registry);
  // Both pass: the triggers on the stack resolve, one per pass pair.
  for (let guard = 0; guard < 20 && s.stack.length > 0; guard++) s = pass(pass(s, registry), registry);
  return s;
}

describe('exalted, end to end — "that creature" is the attacker, not the source', () => {
  it('a Bear attacking alone under a Cathedral of War is 3/3 by the time blockers are declared', () => {
    const state = newGame({ registry });
    const bear = putOnBattlefield(state, 'A', BEAR);
    putOnBattlefield(state, 'A', CATHEDRAL_OF_WAR);
    const after = attackAndResolve(state, [bear.instanceId]);
    expect(statsOf(after, bear.instanceId)).toEqual({ power: 3, toughness: 3 });
  });

  it('two Bears attacking together get nothing', () => {
    const state = newGame({ registry });
    const one = putOnBattlefield(state, 'A', BEAR);
    const two = putOnBattlefield(state, 'A', BEAR);
    putOnBattlefield(state, 'A', CATHEDRAL_OF_WAR);
    const after = attackAndResolve(state, [one.instanceId, two.instanceId]);
    expect(statsOf(after, one.instanceId)).toEqual({ power: 2, toughness: 2 });
    expect(statsOf(after, two.instanceId)).toEqual({ power: 2, toughness: 2 });
  });

  it('three exalted sources make a lone attacker +3/+3 — once per instance (CR 702.90b)', () => {
    const state = newGame({ registry });
    const bear = putOnBattlefield(state, 'A', BEAR);
    for (let i = 0; i < 3; i++) putOnBattlefield(state, 'A', CATHEDRAL_OF_WAR);
    const after = attackAndResolve(state, [bear.instanceId]);
    expect(statsOf(after, bear.instanceId)).toEqual({ power: 5, toughness: 5 });
  });

  it('the pump wears off at cleanup', () => {
    const state = newGame({ registry });
    const bear = putOnBattlefield(state, 'A', BEAR);
    putOnBattlefield(state, 'A', CATHEDRAL_OF_WAR);
    const after = attackAndResolve(state, [bear.instanceId]);
    const nextTurn = advanceTo(after, 'upkeep', registry);
    expect(nextTurn.turnNumber).toBe(state.turnNumber + 1);
    expect(statsOf(nextTurn, bear.instanceId)).toEqual({ power: 2, toughness: 2 });
  });
});

describe('flanking, end to end — the BLOCKER shrinks, once per blocker without flanking', () => {
  /** A Cavalry attacks; the defender blocks it with `blockerDefs`; triggers resolve. */
  function blockedBy(blockerDefs: readonly CardDefinition[]): { state: GameState; cavalry: CardInstance; blockers: CardInstance[] } {
    const state = newGame({ registry });
    const cavalry = putOnBattlefield(state, 'A', BENALISH_CAVALRY);
    const blockers = blockerDefs.map((def) => putOnBattlefield(state, 'B', def));
    let s = attackAndResolve(state, [cavalry.instanceId]);
    s = advanceTo(s, 'declareBlockers', registry);
    s = givePriorityTo(s, nonActive(s), registry);
    s = act(
      s,
      { kind: 'declareBlockers', player: 'B', blocks: blockers.map((b) => ({ blocker: b.instanceId, attacker: cavalry.instanceId })) },
      registry,
    );
    for (let guard = 0; guard < 20 && s.stack.length > 0; guard++) s = pass(pass(s, registry), registry);
    return { state: s, cavalry, blockers };
  }

  it('a Bear that blocks Benalish Cavalry is 1/1 before damage', () => {
    const { state, cavalry, blockers } = blockedBy([BEAR]);
    expect(statsOf(state, blockers[0]!.instanceId)).toEqual({ power: 1, toughness: 1 });
    // The attacker itself is untouched — the subject is the blocker.
    expect(statsOf(state, cavalry.instanceId)).toEqual({ power: 2, toughness: 2 });
  });

  it('⚠️ a blocker WITH flanking is exempt, and a gang block shrinks only the one without', () => {
    const { state, blockers } = blockedBy([BEAR, FLANKER_KEYWORDED]);
    expect(statsOf(state, blockers[0]!.instanceId)).toEqual({ power: 1, toughness: 1 });
    expect(statsOf(state, blockers[1]!.instanceId)).toEqual({ power: 2, toughness: 2 });
  });

  it('two blockers without flanking each shrink — two separate abilities (CR 702.25b)', () => {
    const { state, blockers } = blockedBy([BEAR, BEAR]);
    expect(statsOf(state, blockers[0]!.instanceId)).toEqual({ power: 1, toughness: 1 });
    expect(statsOf(state, blockers[1]!.instanceId)).toEqual({ power: 1, toughness: 1 });
  });

  it('and the combat then kills the shrunken blocker while the Cavalry survives', () => {
    const { state, cavalry, blockers } = blockedBy([BEAR]);
    const afterDamage = advanceTo(state, 'postcombatMain', registry);
    expect(afterDamage.battlefield.some((c) => c.instanceId === blockers[0]!.instanceId)).toBe(false);
    expect(afterDamage.battlefield.some((c) => c.instanceId === cavalry.instanceId)).toBe(true);
  });
});
