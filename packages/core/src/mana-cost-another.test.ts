/**
 * MANA ABILITIES WITH AN ADDITIONAL COST THAT NAMES ANOTHER PERMANENT —
 * "{T}, Tap an untapped creature you control: Add one mana of any color"
 * (Springleaf Drum) and "{T}, Sacrifice a Food: Add one mana of any color"
 * (Gilded Goose).
 *
 * The payer is part of the ACTION, not a question asked while the ability
 * resolves: a mana ability resolves immediately and may not park one
 * (CR 605.3a). So the generator offers ONE ACTION PER LEGAL PAYER and the
 * apply path charges exactly the payer named — the same shape the colour MODE
 * has always had.
 *
 * The fidelity edge is that the cost is REAL: the mana arrives only when the
 * payer is actually tapped (or sacrificed), and an action naming an illegal
 * payer is refused rather than quietly producing free mana.
 */

import { describe, expect, it } from 'vitest';
import {
  applyAction,
  createGame,
  DEFAULT_RULES,
  generateLegalActions,
  poolTotal,
  type CardDefinition,
  type GameState,
  type InstanceId,
  type PlayerId,
} from './index.js';
import { createEffectRegistry } from './effects.js';
import { deckOf, landDef } from './test-fixtures.js';

const ISLAND = landDef('Island', 'U');
const ANY_COLOR = [{ W: 1 }, { U: 1 }, { B: 1 }, { R: 1 }, { G: 1 }] as const;

/** Springleaf Drum: {T}, Tap an untapped creature you control: Add one of any color. */
const DRUM: CardDefinition = {
  id: 'drum',
  name: 'Springleaf Drum',
  types: ['artifact'],
  manaAbilities: [{ produces: [...ANY_COLOR], cost: { tap: true, tapAnother: { anyOfTypes: ['creature'] } } }],
};

/** Skirk Prospector: Sacrifice a Goblin: Add {R}. (No tap of its own.) */
const PROSPECTOR: CardDefinition = {
  id: 'prospector',
  name: 'Skirk Prospector',
  types: ['creature'],
  subtypes: ['Goblin'],
  power: 1,
  toughness: 1,
  manaAbilities: [{ produces: [{ R: 1 }], cost: { noTap: true, sacrificeAnother: { anyOfSubtypes: ['Goblin'] } } }],
};

function bear(id: string, subtypes: readonly string[] = []): CardDefinition {
  return { id, name: id, types: ['creature'], subtypes: [...subtypes], power: 2, toughness: 2 };
}

function board(defs: ReadonlyArray<readonly [CardDefinition, boolean]>): { state: GameState; ids: InstanceId[] } {
  const reg = createEffectRegistry();
  const { state } = createGame({ seed: 7, decks: { A: deckOf(ISLAND, 40), B: deckOf(ISLAND, 40) }, registry: reg });
  const ids: InstanceId[] = [];
  for (const [def, sick] of defs) {
    const id = state.nextInstanceId++;
    ids.push(id);
    state.battlefield.push({
      instanceId: id,
      def,
      controller: 'A',
      owner: 'A',
      zone: 'battlefield',
      tapped: false,
      summoningSick: sick,
      damageMarked: 0,
      markedByDeathtouch: false,
      counters: {},
    });
  }
  return { state, ids };
}

const reg = createEffectRegistry();

describe('an additional cost that taps another permanent', () => {
  it('offers ONE action per legal payer, and never the source itself', () => {
    const { state, ids } = board([
      [DRUM, false],
      [bear('bear-a'), false],
      [bear('bear-b'), false],
    ]);
    const [drumId, bearA, bearB] = ids as [InstanceId, InstanceId, InstanceId];
    const offers = generateLegalActions(state).filter(
      (a) => a.kind === 'tapForMana' && a.instanceId === drumId,
    ) as Array<{ costInstanceId?: InstanceId; mode?: number }>;
    // five colours × two legal payers, and the Drum is never its own payer.
    expect(offers).toHaveLength(10);
    expect(new Set(offers.map((o) => o.costInstanceId))).toEqual(new Set([bearA, bearB]));
  });

  it('a SUMMONING-SICK creature is not a legal payer (CR 302.6)', () => {
    const { state, ids } = board([
      [DRUM, false],
      [bear('sick'), true],
    ]);
    const drumId = ids[0] as InstanceId;
    expect(generateLegalActions(state).filter((a) => a.kind === 'tapForMana' && a.instanceId === drumId)).toEqual([]);
  });

  it('paying it TAPS the named creature and adds the mana', () => {
    const { state, ids } = board([
      [DRUM, false],
      [bear('bear-a'), false],
    ]);
    const [drumId, bearA] = ids as [InstanceId, InstanceId];
    const r = applyAction(
      state,
      { kind: 'tapForMana', player: 'A' as PlayerId, instanceId: drumId, mode: 1, costInstanceId: bearA },
      DEFAULT_RULES,
      reg,
    );
    expect(r.events.find((e) => e.type === 'actionRejected')).toBeUndefined();
    expect(r.state.players.A.manaPool.U).toBe(1);
    expect(r.state.battlefield.find((c) => c.instanceId === bearA)?.tapped).toBe(true);
    expect(r.state.battlefield.find((c) => c.instanceId === drumId)?.tapped).toBe(true);
  });

  it('an action naming NO payer is refused — never free mana', () => {
    const { state, ids } = board([
      [DRUM, false],
      [bear('bear-a'), false],
    ]);
    const drumId = ids[0] as InstanceId;
    const r = applyAction(
      state,
      { kind: 'tapForMana', player: 'A' as PlayerId, instanceId: drumId, mode: 0 },
      DEFAULT_RULES,
      reg,
    );
    expect(r.events.find((e) => e.type === 'actionRejected')).toBeDefined();
    expect(poolTotal(r.state.players.A.manaPool)).toBe(0);
  });
});

describe('an additional cost that sacrifices another permanent', () => {
  it('sacrifices the named Goblin and adds the mana', () => {
    const { state, ids } = board([
      [PROSPECTOR, false],
      [bear('goblin-friend', ['Goblin']), false],
    ]);
    const [prospectorId, friend] = ids as [InstanceId, InstanceId];
    const r = applyAction(
      state,
      { kind: 'tapForMana', player: 'A' as PlayerId, instanceId: prospectorId, costInstanceId: friend },
      DEFAULT_RULES,
      reg,
    );
    expect(r.events.find((e) => e.type === 'actionRejected')).toBeUndefined();
    expect(r.state.players.A.manaPool.R).toBe(1);
    expect(r.state.battlefield.find((c) => c.instanceId === friend)).toBeUndefined();
    // No {T} in the printed cost, so the Prospector itself stays untapped.
    expect(r.state.battlefield.find((c) => c.instanceId === prospectorId)?.tapped).toBe(false);
  });

  it('a permanent outside the printed filter cannot pay', () => {
    const { state, ids } = board([
      [PROSPECTOR, false],
      [bear('not-a-goblin'), false],
    ]);
    const [prospectorId, notGoblin] = ids as [InstanceId, InstanceId];
    const r = applyAction(
      state,
      { kind: 'tapForMana', player: 'A' as PlayerId, instanceId: prospectorId, costInstanceId: notGoblin },
      DEFAULT_RULES,
      reg,
    );
    expect(r.events.find((e) => e.type === 'actionRejected')).toBeDefined();
    expect(poolTotal(r.state.players.A.manaPool)).toBe(0);
  });
});
