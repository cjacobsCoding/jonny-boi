/**
 * **`cloneState` must copy the whole pool, restrictions included.**
 *
 * The engine clones the state at every action boundary, and `clonePlayer` is a
 * hand-written FIELD-BY-FIELD copy — which is fast, and which is also exactly the
 * shape of bug that has bitten three branches on this repo: a new field is added
 * to a state object, the clone is not taught about it, and the value silently
 * reverts one action later. Nothing throws, no test that does not look for it
 * fails, and the engine simply plays a different game.
 *
 * For a mana pool that failure is a card change, not a glitch. A cloned pool that
 * lost its spend restrictions holds Ancient Ziggurat mana that can pay for
 * anything — a strictly better land than the printed one, in every game the sim
 * plays, in exactly the direction that flatters a deck built around it.
 *
 * So this file asserts the pool survives a clone with its restrictions, AND that
 * the copy is genuinely independent: spending restricted mana in the clone must
 * not touch the original.
 */

import { describe, expect, it } from 'vitest';
import { cloneState } from './internal/clone.js';
import {
  createGame,
  emptyPool,
  payCost,
  restrictedTotal,
  spendPurposeFor,
  usableMana,
  type CardDefinition,
  type ManaSpendRestriction,
} from './index.js';
import { createEffectRegistry } from './effects.js';
import { deckOf, landDef } from './test-fixtures.js';

const CREATURES_ONLY: ManaSpendRestriction = {
  label: 'only to cast a creature spell',
  allow: [{ purpose: 'cast', types: ['creature'] }],
};

const BEAR: CardDefinition = {
  id: 'Bear',
  name: 'Grizzly Bears',
  types: ['creature'],
  power: 2,
  toughness: 2,
  cost: { generic: 1, G: 1 },
};

function newGame() {
  const { state } = createGame({
    seed: 3,
    decks: { A: deckOf(landDef('Forest', 'G'), 40), B: deckOf(landDef('Forest', 'G'), 40) },
    registry: createEffectRegistry(),
  });
  return state;
}

describe('cloneState carries mana spend restrictions', () => {
  it('a cloned pool still refuses what the original refused', () => {
    const state = newGame();
    state.players.A.manaPool = {
      ...emptyPool(),
      G: 2,
      restricted: [{ color: 'G', amount: 2, restriction: CREATURES_ONLY }],
    };

    const copy = cloneState(state);
    const pool = copy.players.A.manaPool;
    expect(pool.G).toBe(2);
    expect(restrictedTotal(pool)).toBe(2);
    // The question that matters is not "is the array there" but "does the copy
    // still answer the same way", so it is asked through the payment path.
    expect(usableMana(pool, 'G', undefined)).toBe(0);
    expect(usableMana(pool, 'G', spendPurposeFor(BEAR, 'cast'))).toBe(2);
  });

  it('an unrestricted pool clones to the plain six-colour shape (no empty array)', () => {
    const state = newGame();
    state.players.A.manaPool = { ...emptyPool(), G: 1 };
    const copy = cloneState(state);
    // The `undefined` is the hot-path contract that `canPay`/`payCost` branch on.
    expect(copy.players.A.manaPool.restricted).toBeUndefined();
  });

  it('spending in the clone does not disturb the original', () => {
    const state = newGame();
    state.players.A.manaPool = {
      ...emptyPool(),
      G: 2,
      restricted: [{ color: 'G', amount: 2, restriction: CREATURES_ONLY }],
    };
    const copy = cloneState(state);

    const paid = payCost(copy.players.A.manaPool, { G: 1 }, spendPurposeFor(BEAR, 'cast'));
    expect(paid.ok).toBe(true);
    if (!paid.ok) return;
    copy.players.A.manaPool = paid.pool;

    // The parcels are shared BY REFERENCE between the two pools, which is only
    // safe because they are immutable — every spend builds new parcels in a new
    // array. If that ever stops being true, this is the assertion that catches it.
    expect(restrictedTotal(copy.players.A.manaPool)).toBe(1);
    expect(restrictedTotal(state.players.A.manaPool)).toBe(2);
    expect(state.players.A.manaPool.G).toBe(2);
  });
});
