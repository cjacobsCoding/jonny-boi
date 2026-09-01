/**
 * "SACRIFICE A <NOUN>" AS AN ACTIVATION COST — Viscera Seer, Goblin
 * Bombardment, Carrion Feeder, Zuran Orb, Scavenger Grounds (§3.61).
 *
 * The cost is paid as the ability is ACTIVATED (CR 602.2b), before it reaches
 * the stack — so there is no resolution in which to ask "which one?". The
 * payer therefore rides the ACTION, and the generator offers one action per
 * legal payer, exactly as it already does for a mana ability's extra cost.
 *
 * What this pins is that the cost is REAL:
 *  - the ability is not offered at all when nobody can pay;
 *  - paying actually sacrifices the named permanent, through the graveyard path
 *    a death takes (a dies-trigger must see it — that IS Viscera Seer);
 *  - an action naming an illegal payer, or naming none, is refused rather than
 *    activating for free.
 */

import { describe, expect, it } from 'vitest';
import {
  applyAction,
  createGame,
  DEFAULT_RULES,
  generateLegalActions,
  type CardDefinition,
  type GameState,
  type InstanceId,
  type PlayerId,
} from './index.js';
import { createEffectRegistry, type EffectRegistry } from './effects.js';
import { deckOf, landDef } from './test-fixtures.js';

const ISLAND = landDef('Island', 'U');

/** Viscera Seer's shape: sacrifice a creature, do a thing. */
const SEER: CardDefinition = {
  id: 'seer',
  name: 'Viscera Seer',
  types: ['creature'],
  power: 1,
  toughness: 1,
  activated: [
    {
      cost: { sacrificeAnother: { anyOfTypes: ['creature'] }, sacrificeExcludesSelf: true },
      effects: [{ primitive: 'testMark' }],
      label: 'Sacrifice a creature: mark',
    },
  ],
};

function creature(id: string): CardDefinition {
  return { id, name: id, types: ['creature'], power: 2, toughness: 2 };
}

function setup(defs: readonly CardDefinition[]): { state: GameState; ids: InstanceId[]; reg: EffectRegistry; marks: number[] } {
  const marks: number[] = [];
  const reg = createEffectRegistry();
  reg.register('testMark', () => void marks.push(1));
  const { state } = createGame({ seed: 11, decks: { A: deckOf(ISLAND, 40), B: deckOf(ISLAND, 40) }, registry: reg });
  const ids: InstanceId[] = [];
  for (const def of defs) {
    const id = state.nextInstanceId++;
    ids.push(id);
    state.battlefield.push({
      instanceId: id,
      def,
      controller: 'A',
      owner: 'A',
      zone: 'battlefield',
      tapped: false,
      summoningSick: false,
      damageMarked: 0,
      markedByDeathtouch: false,
      counters: {},
    });
  }
  return { state, ids, reg, marks };
}

describe('an activation cost that sacrifices another permanent', () => {
  it('is NOT offered when nobody can pay — "another" excludes the source', () => {
    const { state, ids } = setup([SEER]);
    const seerId = ids[0] as InstanceId;
    expect(generateLegalActions(state).filter((a) => a.kind === 'activateAbility' && a.instanceId === seerId)).toEqual(
      [],
    );
  });

  it('offers ONE action per legal payer', () => {
    const { state, ids } = setup([SEER, creature('food-a'), creature('food-b')]);
    const [seerId, a, b] = ids as [InstanceId, InstanceId, InstanceId];
    const offers = generateLegalActions(state).filter(
      (x) => x.kind === 'activateAbility' && x.instanceId === seerId,
    ) as Array<{ costInstanceIds?: readonly InstanceId[] }>;
    expect(offers).toHaveLength(2);
    expect(new Set(offers.flatMap((o) => o.costInstanceIds ?? []))).toEqual(new Set([a, b]));
  });

  it('paying it SACRIFICES the named permanent through the death path', () => {
    const { state, ids, reg } = setup([SEER, creature('food-a')]);
    const [seerId, food] = ids as [InstanceId, InstanceId];
    const r = applyAction(
      state,
      { kind: 'activateAbility', player: 'A' as PlayerId, instanceId: seerId, abilityIndex: 0, costInstanceIds: [food] },
      DEFAULT_RULES,
      reg,
    );
    expect(r.events.find((e) => e.type === 'actionRejected')).toBeUndefined();
    expect(r.state.battlefield.find((c) => c.instanceId === food)).toBeUndefined();
    expect(r.state.players.A.graveyard.some((c) => c.instanceId === food)).toBe(true);
    // A dies-trigger must be able to see it — that is the whole card.
    expect(r.events.some((e) => e.type === 'creatureDied' || e.type === 'zoneChange')).toBe(true);
  });

  it('an action naming NO payer, or an illegal one, is refused', () => {
    const { state, ids, reg } = setup([SEER, creature('food-a')]);
    const [seerId] = ids as [InstanceId, InstanceId];
    for (const costInstanceIds of [undefined, [seerId]]) {
      const r = applyAction(
        state,
        {
          kind: 'activateAbility',
          player: 'A' as PlayerId,
          instanceId: seerId,
          abilityIndex: 0,
          ...(costInstanceIds ? { costInstanceIds } : {}),
        },
        DEFAULT_RULES,
        reg,
      );
      expect(r.events.find((e) => e.type === 'actionRejected')).toBeDefined();
    }
  });
});
