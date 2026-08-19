/**
 * The pilot actually USES the rich mana sources — and weighs what they cost.
 *
 * A mana ability the engine offers but no pilot ever taps is inert: a deck built
 * on pain lands would measure as if it had no mana at all, which corrupts exactly
 * the A/B verdicts this project exists to produce. And a pilot that taps a pain
 * land *carelessly* is the opposite failure — it would burn life the printed card
 * charges and make the deck look worse than it is.
 *
 * Both halves are pinned here:
 *   1. the pilot funds and casts a real spell off a pain land, and the damage
 *      actually lands;
 *   2. given a painless source that closes the same shortfall, it takes that one
 *      instead — the preference lives in core's shared `planManaPayment`, so the
 *      hotseat UI's auto-tap inherits it rather than having a second opinion.
 */

import { describe, expect, it } from 'vitest';
import {
  applyAction,
  createGame,
  createRng,
  generateLegalActions,
  planManaPayment,
  type CardDefinition,
  type CardInstance,
  type DeckList,
  type GameAction,
  type GameState,
} from '@jonny-boi/core';
import { createHeuristicPilot } from './heuristic.js';
import { createTestRegistry, giveHand, landDef } from './test-support.js';

/** Adarkar Wastes' shape, in red/white: painless {C}, or a painful colour. */
const PAIN_LAND: CardDefinition = {
  id: 'pain-land',
  name: 'Pain Land',
  types: ['land'],
  manaAbilities: [
    { produces: [{ C: 1 }] },
    { produces: [{ R: 1 }, { W: 1 }], rider: { damageToController: 1 } },
  ],
};

/** A cheap red burn spell, so the only way to cast it is a red source. */
const BOLT: CardDefinition = {
  id: 'bolt',
  name: 'Bolt',
  types: ['sorcery'],
  cost: { R: 1 },
  effects: [{ primitive: 'dealDamage', params: { amount: 3, targets: 'any' } }],
};

function stubDeck(): DeckList {
  return { cards: Array.from({ length: 30 }, (_, i) => landDef(`L${i}`, 'R')) };
}

/**
 * A's precombat main with a lethal Bolt in hand and `lands` on the battlefield.
 * The cast is lethal, so no scoring threshold can talk the pilot out of it and a
 * pilot that does not cast is genuinely failing to see the mana.
 */
function position(lands: readonly CardDefinition[], life = 20): GameState {
  const { state } = createGame({ seed: 11, decks: { A: stubDeck(), B: stubDeck() } });
  state.step = 'precombatMain';
  state.activePlayer = 'A';
  state.priorityPlayer = 'A';
  state.stack = [];
  state.players.A.hand = [];
  state.players.B.hand = [];
  state.players.A.landsPlayedThisTurn = 1;
  state.players.A.life = life;
  state.players.B.life = 2;

  const placed = giveHand(state, 'A', [...lands]);
  state.players.A.hand = [];
  for (const land of placed) {
    land.zone = 'battlefield';
    land.summoningSick = false;
    state.battlefield.push(land as CardInstance);
  }
  giveHand(state, 'A', [BOLT]);
  return state;
}

/** Drive the pilot's own actions until it commits the cast, or give up. */
function driveToCast(start: GameState): { state: GameState; cast?: GameAction; taps: GameAction[] } {
  const reg = createTestRegistry();
  const pilot = createHeuristicPilot();
  let state = start;
  const taps: GameAction[] = [];
  for (let ply = 0; ply < 12; ply++) {
    const legal = generateLegalActions(state);
    const action = pilot.chooseAction({ view: state, legalActions: legal, rng: createRng(4) });
    if (action.kind === 'castSpell') return { state, cast: action, taps };
    if (action.kind !== 'tapForMana') break;
    taps.push(action);
    state = applyAction(state, action, undefined, reg).state;
  }
  return { state, taps };
}

describe('heuristic pilot vs the rich mana sources', () => {
  it('funds and casts a spell off a pain land, and really takes the damage', () => {
    const reg = createTestRegistry();
    const start = position([PAIN_LAND]);
    const { state, cast, taps } = driveToCast(start);

    expect(cast, 'the pilot never found the mana on a pain land').toBeDefined();
    // It had to use the PAINFUL mode — the painless one makes {C}, which cannot
    // pay {R} — so the life really came off.
    expect(taps).toHaveLength(1);
    expect(state.players.A.life).toBe(19);
    const result = applyAction(state, cast as GameAction, undefined, reg);
    expect(result.events.some((e) => e.type === 'actionRejected')).toBe(false);
    expect(result.events.some((e) => e.type === 'spellCast')).toBe(true);
  });

  it('prefers a painless source that closes the same shortfall', () => {
    const mountain = landDef('Mountain', 'R');
    const { state, cast, taps } = driveToCast(position([PAIN_LAND, mountain]));
    expect(cast, 'the pilot never cast').toBeDefined();
    expect(taps).toHaveLength(1);
    // The Mountain, not the pain land: same {R}, no life.
    const tapped = state.battlefield.find((p) => p.tapped);
    expect(tapped?.def.name).toBe('Mountain');
    expect(state.players.A.life).toBe(20);
  });

  it('will not plan a payment that kills its own controller', () => {
    // At 1 life the coloured mode is still LEGAL — a rider is not a cost, and a
    // player may choose to die (the engine allows it, `mana-ability-model.test.ts`
    // pins that). What the planner will not do is choose it while funding a
    // spell, because a plan that kills the caster is not a plan.
    const state = position([PAIN_LAND], 1);
    const legal = generateLegalActions(state);
    expect(legal.some((a) => a.kind === 'tapForMana' && a.mode === 1)).toBe(true);
    expect(planManaPayment(state, 'A', { R: 1 }, legal)).toBeUndefined();
    // …and it still funds anything the painless mode can pay for.
    expect(planManaPayment(state, 'A', { generic: 1 }, legal)?.map((t) => t.mode)).toEqual([0]);
  });
});
