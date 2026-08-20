/**
 * The pilot USES restricted mana, and never spends it illegally.
 *
 * Both halves matter to the lab's verdicts, and they fail in opposite directions:
 *
 *  1. **A pilot that ignores restricted mana** measures Ancient Ziggurat as a
 *     land that produces nothing, so a creature deck built on it looks broken.
 *     The mana model growing is worth nothing if no pilot ever taps it.
 *  2. **A pilot that plans an illegal payment** is worse: it funds a Lightning
 *     Bolt off a Ziggurat, the engine rejects the cast, and the pilot has tapped
 *     its board for nothing — a self-inflicted mana screw that shows up as a
 *     deck being bad rather than as a bug.
 *
 * And one preference: restricted mana should be spent FIRST when it legally can.
 * It is the least flexible resource on the board — mana that is not spent on this
 * creature spell is very likely never spent at all. The preference lives in
 * core's shared `planManaPayment` (extending the flexibility ordering that was
 * already there), so the hotseat and online auto-tap inherit it rather than
 * holding a second opinion.
 */

import { describe, expect, it } from 'vitest';
import {
  applyAction,
  createGame,
  createRng,
  generateLegalActions,
  planManaPayment,
  spendPurposeFor,
  type CardDefinition,
  type CardInstance,
  type DeckList,
  type GameAction,
  type GameState,
  type ManaSpendRestriction,
} from '@jonny-boi/core';
import { createHeuristicPilot } from './heuristic.js';
import { createTestRegistry, giveHand, landDef } from './test-support.js';

const CREATURES_ONLY: ManaSpendRestriction = {
  label: 'only to cast a creature spell',
  allow: [{ purpose: 'cast', types: ['creature'] }],
};

/** Ancient Ziggurat: any colour, creature spells only. */
const ZIGGURAT: CardDefinition = {
  id: 'ziggurat',
  name: 'Ancient Ziggurat',
  types: ['land'],
  manaAbilities: [
    {
      produces: [{ W: 1 }, { U: 1 }, { B: 1 }, { R: 1 }, { G: 1 }],
      spendRestriction: CREATURES_ONLY,
    },
  ],
};

/** A one-mana creature the Ziggurat can legally fund. */
const GRUNT: CardDefinition = {
  id: 'grunt',
  name: 'Grunt',
  types: ['creature'],
  power: 2,
  toughness: 2,
  cost: { R: 1 },
};

/** A one-mana burn spell the Ziggurat may NOT fund. */
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

/** A's precombat main with `hand` in hand and `lands` on the battlefield. */
function position(lands: readonly CardDefinition[], hand: readonly CardDefinition[]): GameState {
  const { state } = createGame({ seed: 11, decks: { A: stubDeck(), B: stubDeck() } });
  state.step = 'precombatMain';
  state.activePlayer = 'A';
  state.priorityPlayer = 'A';
  state.stack = [];
  state.players.A.hand = [];
  state.players.B.hand = [];
  state.players.A.landsPlayedThisTurn = 1;
  state.players.B.life = 2;

  const placed = giveHand(state, 'A', [...lands]);
  state.players.A.hand = [];
  for (const land of placed) {
    land.zone = 'battlefield';
    land.summoningSick = false;
    state.battlefield.push(land as CardInstance);
  }
  giveHand(state, 'A', [...hand]);
  return state;
}

/** Drive the pilot's own actions until it commits a cast, or give up. */
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

describe('heuristic pilot vs restricted mana', () => {
  it('funds and casts a creature off Ancient Ziggurat — the source is not inert', () => {
    const reg = createTestRegistry();
    const { state, cast, taps } = driveToCast(position([ZIGGURAT], [GRUNT]));
    expect(cast, 'the pilot never found the mana on Ancient Ziggurat').toBeDefined();
    expect(taps).toHaveLength(1);
    const result = applyAction(state, cast as GameAction, undefined, reg);
    expect(result.events.some((e) => e.type === 'actionRejected')).toBe(false);
    expect(result.events.some((e) => e.type === 'spellCast')).toBe(true);
  });

  it('does NOT tap a Ziggurat toward a burn spell it could never pay for', () => {
    // The failure this guards against is not "the pilot passes" — it is the pilot
    // tapping its only land, having the cast rejected, and having mana-screwed
    // itself for the turn.
    const { taps, cast } = driveToCast(position([ZIGGURAT], [BOLT]));
    expect(cast).toBeUndefined();
    expect(taps).toHaveLength(0);
  });

  it('the shared planner refuses the illegal payment and allows the legal one', () => {
    const state = position([ZIGGURAT], [BOLT, GRUNT]);
    const legal = generateLegalActions(state);
    expect(planManaPayment(state, 'A', { R: 1 }, legal, spendPurposeFor(BOLT, 'cast'))).toBeUndefined();
    expect(planManaPayment(state, 'A', { R: 1 }, legal, spendPurposeFor(GRUNT, 'cast'))).toHaveLength(1);
  });

  it('spends the restricted source FIRST when both would do', () => {
    // A Mountain and a Ziggurat, one {R} owed for a creature. Both close the same
    // shortfall; the Ziggurat is the one that is otherwise stranded, so it goes.
    const mountain = landDef('Mountain', 'R');
    const { state, cast, taps } = driveToCast(position([mountain, ZIGGURAT], [GRUNT]));
    expect(cast, 'the pilot never cast').toBeDefined();
    expect(taps).toHaveLength(1);
    expect(state.battlefield.find((p) => p.tapped)?.def.name).toBe('Ancient Ziggurat');
  });

  it('keeps the restricted source when the spell cannot use it', () => {
    // The mirror of the case above: same board, a burn spell instead. Now the
    // Ziggurat must be left alone and the Mountain spent.
    const mountain = landDef('Mountain', 'R');
    const { state, cast, taps } = driveToCast(position([mountain, ZIGGURAT], [BOLT]));
    expect(cast, 'the pilot never cast').toBeDefined();
    expect(taps).toHaveLength(1);
    expect(state.battlefield.find((p) => p.tapped)?.def.name).toBe('Mountain');
  });
});
