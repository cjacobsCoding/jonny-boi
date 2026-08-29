/**
 * "{T}, SACRIFICE THIS ARTIFACT: Add one mana of any color" — the Treasure
 * shape, and the reason `ManaAbilityCost.sacrificeSelf` exists.
 *
 * The fidelity edge: the sacrifice is part of the COST. A Treasure that added
 * its mana and stayed on the battlefield would be a Mox — strictly better than
 * printed, and five of them win games the real card does not. So the assertions
 * are paired: the mana ARRIVES and the permanent is GONE, through the same
 * graveyard path every sacrifice uses (so leaves-the-battlefield rules see it).
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

/** The rules-defined Treasure face, as the cards package authors it. */
const TREASURE: CardDefinition = {
  id: 'token:treasure',
  name: 'Treasure',
  types: ['artifact'],
  subtypes: ['Treasure'],
  manaAbilities: [
    {
      produces: [{ W: 1 }, { U: 1 }, { B: 1 }, { R: 1 }, { G: 1 }],
      cost: { sacrificeSelf: true },
    },
  ],
};

function place(state: GameState, def: CardDefinition, controller: PlayerId): InstanceId {
  const id = state.nextInstanceId++;
  state.battlefield.push({
    instanceId: id,
    def,
    controller,
    owner: controller,
    zone: 'battlefield',
    tapped: false,
    summoningSick: false,
    damageMarked: 0,
    markedByDeathtouch: false,
    counters: {},
  });
  return id;
}

describe('a sacrifice-cost mana ability (the Treasure shape)', () => {
  it('adds the chosen color AND removes the source — never a Mox', () => {
    const reg = createEffectRegistry();
    const { state } = createGame({ seed: 11, decks: { A: deckOf(ISLAND, 40), B: deckOf(ISLAND, 40) }, registry: reg });
    const treasureId = place(state, TREASURE, 'A');

    // Offered: five modes, one per color, exactly as any any-color source.
    const offers = generateLegalActions(state).filter(
      (a) => a.kind === 'tapForMana' && a.instanceId === treasureId,
    );
    expect(offers.length).toBe(5);

    const r = applyAction(
      state,
      { kind: 'tapForMana', player: 'A', instanceId: treasureId, mode: 2 },
      DEFAULT_RULES,
      reg,
    );
    const rejected = r.events.find((e) => e.type === 'actionRejected');
    expect(rejected, JSON.stringify(rejected)).toBeUndefined();

    // The mana arrived (mode 2 is black in the canonical WUBRG order)…
    expect(r.state.players.A.manaPool.B).toBe(1);
    expect(poolTotal(r.state.players.A.manaPool)).toBe(1);
    // …and the Treasure is GONE from the battlefield.
    expect(r.state.battlefield.find((c) => c.instanceId === treasureId)).toBeUndefined();
    // Sacrificing is a zone change the rest of the rules can see.
    expect(r.events.some((e) => e.type === 'zoneChange' && (e as { instanceId: InstanceId }).instanceId === treasureId)).toBe(
      true,
    );
  });
});
