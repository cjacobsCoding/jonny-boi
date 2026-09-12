/**
 * §3.143 — THE PILOT'S PHYREXIAN POLICY, pinned in both directions.
 *
 * "Pay 2 life instead of {B}" is not a free discount, and the two ways of
 * getting it wrong are opposite:
 *
 *  - **Always pay.** A pilot that takes the life price whenever it is offered
 *    bleeds itself for mana it was not going to spend on anything, and every A/B
 *    verdict over a deck containing a Phyrexian card measures that bleed instead
 *    of the card. That is a real strength bug, not a cosmetic one.
 *  - **Never pay.** A pilot that only ever reads the all-mana cost cannot cast
 *    Dismember off one land at 20 life, which is the whole reason the symbol is
 *    printed — the mechanic is then inert, and the card measures as unplayable.
 *
 * The policy is two rules, and each gets a test: MANA BEFORE LIFE (the cheapest
 * fundable reading wins, so life is spent only when the board cannot produce the
 * colour), and NEVER BELOW THE DANGER LINE (the remaining total must stay above
 * `desperateLifeThreshold` — the same line `answerPayLife` holds a shockland to,
 * so the pilot has one answer to "how low may I take myself by choice").
 */

import { describe, expect, it } from 'vitest';
import {
  applyAction,
  createGame,
  createRng,
  generateLegalActions,
  PHYREXIAN_LIFE_PRICE,
  type CardDefinition,
  type DeckList,
  type GameAction,
  type GameState,
} from '@jonny-boi/core';
import { createHeuristicPilot } from './heuristic.js';
import { DEFAULT_HEURISTIC_WEIGHTS } from './weights.js';
import { createTestRegistry, giveHand, landDef } from './test-support.js';

/**
 * Dismember-shaped: `{1}{B/P}{B/P}`, and its body is the one primitive
 * `createTestRegistry` really registers, so a resolution here is a real one.
 */
const DISMEMBER: CardDefinition = {
  id: 'dismember',
  name: 'Dismember',
  types: ['instant'],
  timing: 'instant',
  cost: {
    generic: 1,
    hybrid: [
      ['B', { life: PHYREXIAN_LIFE_PRICE }],
      ['B', { life: PHYREXIAN_LIFE_PRICE }],
    ],
  },
  effects: [{ primitive: 'dealDamage', params: { amount: 5, targets: 'any' } }],
};

function stubDeck(): DeckList {
  return { cards: Array.from({ length: 30 }, (_, i) => landDef(`L${i}`, 'B')) };
}

/**
 * A's precombat main with `lands` untapped lands of `color`, Dismember in hand,
 * A at `life`, and B one Dismember away from dead — so nothing in the scorer can
 * talk the pilot out of the cast and the only thing under test is the PRICE.
 */
function position(options: {
  readonly lands: number;
  readonly color: 'B' | 'C';
  readonly life: number;
}): GameState {
  const { state } = createGame({ seed: 11, decks: { A: stubDeck(), B: stubDeck() } });
  state.step = 'precombatMain';
  state.activePlayer = 'A';
  state.priorityPlayer = 'A';
  state.stack = [];
  state.players.A.hand = [];
  state.players.B.hand = [];
  state.players.A.landsPlayedThisTurn = 1; // no land drop to distract the pilot
  state.players.A.life = options.life;
  state.players.B.life = 5;
  const lands = giveHand(
    state,
    'A',
    Array.from({ length: options.lands }, (_, i) => landDef(`L${i}`, options.color)),
  );
  state.players.A.hand = [];
  for (const land of lands) {
    land.zone = 'battlefield';
    land.summoningSick = false;
    state.battlefield.push(land);
  }
  giveHand(state, 'A', [DISMEMBER]);
  return state;
}

/** Drive the pilot's own plies until it commits a cast, or give up. */
function pilotCast(state: GameState): Extract<GameAction, { kind: 'castSpell' }> | undefined {
  const reg = createTestRegistry();
  const pilot = createHeuristicPilot();
  let current = state;
  for (let ply = 0; ply < 12; ply++) {
    const legal = generateLegalActions(current);
    const action = pilot.chooseAction({ view: current, legalActions: legal, rng: createRng(5) });
    if (action.kind === 'castSpell') return action;
    if (action.kind !== 'tapForMana') return undefined; // the pilot is doing something else
    current = applyAction(current, action, undefined, reg).state;
  }
  return undefined;
}

const THRESHOLD = DEFAULT_HEURISTIC_WEIGHTS.desperateLifeThreshold;

describe('§3.143 the pilot pays MANA before life', () => {
  it('casts for the all-mana reading when the board makes the colour', () => {
    // Three black sources and 20 life: the life price buys nothing, because the
    // mana it would save was not going anywhere else this turn.
    const cast = pilotCast(position({ lands: 3, color: 'B', life: 20 }));
    expect(cast).toBeDefined();
    expect(cast?.phyrexianLife ?? 0).toBe(0);
  });

  it('pays the MINIMUM life the board forces, not the maximum offered', () => {
    // Two black and one colourless would also fund "{1} and 4 life"; the pilot
    // must take the cheaper reading it can actually pay.
    const state = position({ lands: 2, color: 'B', life: 20 });
    state.battlefield.push({
      ...state.battlefield[0]!,
      instanceId: state.nextInstanceId++,
      def: landDef('W0', 'C'),
    });
    const cast = pilotCast(state);
    expect(cast).toBeDefined();
    expect(cast?.phyrexianLife ?? 0).toBe(0);
  });
});

describe('§3.143 the pilot pays life when that is the only way through', () => {
  it('casts off a single colourless land at a comfortable life total', () => {
    // One land, no black anywhere: the printed alternative is the whole reason
    // this card is castable, and a pilot that never reads it leaves the spell in
    // hand forever.
    const cast = pilotCast(position({ lands: 1, color: 'C', life: 20 }));
    expect(cast).toBeDefined();
    expect(cast?.phyrexianLife).toBe(2 * PHYREXIAN_LIFE_PRICE);
  });

  it('refuses the same cast once the price would cross the danger line', () => {
    // The identical board, at a life total where paying 4 leaves the pilot at or
    // below the line it already treats as desperate. Same card, same mana, and
    // the only thing that changed is how much the price costs.
    const risky = THRESHOLD + 2 * PHYREXIAN_LIFE_PRICE; // paying 4 lands exactly ON the line
    const cast = pilotCast(position({ lands: 1, color: 'C', life: risky }));
    expect(cast).toBeUndefined();
  });

  it('pays at one point above the line and declines at one point below it', () => {
    // The boundary itself, so a change to the rule cannot slip through as "a
    // bit more cautious". `answerPayLife` is pinned the same way.
    const justAbove = position({ lands: 1, color: 'C', life: THRESHOLD + 2 * PHYREXIAN_LIFE_PRICE + 1 });
    expect(pilotCast(justAbove)?.phyrexianLife).toBe(2 * PHYREXIAN_LIFE_PRICE);

    const justBelow = position({ lands: 1, color: 'C', life: THRESHOLD + 2 * PHYREXIAN_LIFE_PRICE });
    expect(pilotCast(justBelow)).toBeUndefined();
  });
});
