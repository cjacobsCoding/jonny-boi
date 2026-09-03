/**
 * THE PILOT PLAYS THE UPKEEP-COST FAMILY (§3.106).
 *
 *  1. **An upkeep bill is priced, not reflexively paid.** `payManaOrElse` marks
 *     an echo / cumulative-upkeep / "sacrifice unless you pay" bill with the
 *     permanent at stake, and the pilot pays when the mana is spare or the
 *     permanent is worth the tempo — and lets a 1/1 with a five-mana echo go.
 *  2. **Suspend is chosen for the card that cannot be cast this turn**, funded
 *     through the same tap planner every spell uses, and never for a card the
 *     pilot could simply cast.
 *  3. **A time-counter permanent is worth less the fewer upkeeps it has left**,
 *     so a choice that ranks what to sacrifice reaches for the vanishing one.
 */

import { describe, expect, it } from 'vitest';
import {
  applyAction,
  createGame,
  createRng,
  generateLegalActions,
  FADE_COUNTER,
  TIME_COUNTER,
  type CardDefinition,
  type DeckList,
  type GameAction,
  type GameState,
  type PayManaChoice,
} from '@jonny-boi/core';
import { answerChoiceHeuristically } from './choices.js';
import { cardValue, cardValueContext } from './card-value.js';
import { createHeuristicPilot } from './heuristic.js';
import { createTestRegistry, giveHand, landDef } from './test-support.js';
import { DEFAULT_HEURISTIC_WEIGHTS } from './weights.js';

const W = DEFAULT_HEURISTIC_WEIGHTS;

function creature(id: string, power: number, toughness: number, cost: CardDefinition['cost']): CardDefinition {
  return { id, name: id, types: ['creature'], power, toughness, cost };
}

/** A seven-drop with Suspend 4—{1}{R}, and a two-drop with Suspend 2—{R}. */
const GARGADON: CardDefinition = {
  ...creature('Gargadon', 7, 5, { generic: 5, R: 2 }),
  suspend: { count: 4, cost: { generic: 1, R: 1 }, upkeep: [{ primitive: 'suspendTick' }] },
};
const RIFT_BOLT: CardDefinition = {
  id: 'Rift Bolt',
  name: 'Rift Bolt',
  types: ['sorcery'],
  timing: 'sorcery',
  cost: { generic: 2, R: 1 },
  targets: 'any',
  effects: [{ primitive: 'dealDamage', params: { amount: 3 } }],
  suspend: { count: 1, cost: { R: 1 }, upkeep: [{ primitive: 'suspendTick' }] },
};

function stubDeck(): DeckList {
  return { cards: Array.from({ length: 30 }, (_, i) => landDef(`L${i}`, 'R')) };
}

/** A's main phase with `landCount` untapped Mountains and an empty hand. */
function boardWith(landCount: number): GameState {
  const { state } = createGame({ seed: 11, decks: { A: stubDeck(), B: stubDeck() } });
  state.step = 'precombatMain';
  state.activePlayer = 'A';
  state.priorityPlayer = 'A';
  state.stack = [];
  state.players.A.hand = [];
  state.players.B.hand = [];
  const mountains = giveHand(state, 'A', Array.from({ length: landCount }, (_, i) => landDef(`M${i}`, 'R')));
  state.players.A.hand = [];
  for (const land of mountains) {
    land.zone = 'battlefield';
    land.summoningSick = false;
    state.battlefield.push(land);
  }
  state.players.A.landsPlayedThisTurn = 1;
  return state;
}

/** Drive the pilot until it takes an action of `kind`, applying its taps. */
function driveUntil(state: GameState, kind: GameAction['kind'], plies = 12): GameAction | undefined {
  const reg = createTestRegistry();
  const pilot = createHeuristicPilot();
  let current = state;
  for (let ply = 0; ply < plies; ply++) {
    const action = pilot.chooseAction({ view: current, legalActions: generateLegalActions(current), rng: createRng(99) });
    if (action.kind === kind) return action;
    if (action.kind !== 'tapForMana') return undefined;
    current = applyAction(current, action, undefined, reg).state;
  }
  return undefined;
}

describe('the pilot and suspend (CR 702.62a)', () => {
  it('suspends the seven-drop it cannot cast this turn, tapping toward the suspend cost first', () => {
    const state = boardWith(2);
    giveHand(state, 'A', [GARGADON]);
    const action = driveUntil(state, 'suspendCard');
    expect(action, 'the pilot never suspended the uncastable Gargadon').toBeDefined();
  });

  it('does NOT suspend a card it can simply cast — the spell scorer owns that card', () => {
    const state = boardWith(3);
    giveHand(state, 'A', [RIFT_BOLT]);
    const action = driveUntil(state, 'suspendCard');
    expect(action).toBeUndefined();
    // …and it does cast it.
    expect(driveUntil(state, 'castSpell')).toBeDefined();
  });

  it('suspends Rift Bolt when it cannot be cast (one Mountain), since waiting a turn beats holding it', () => {
    const state = boardWith(1);
    giveHand(state, 'A', [RIFT_BOLT]);
    expect(driveUntil(state, 'suspendCard')).toBeDefined();
  });
});

describe('the pilot and an upkeep bill (echo, cumulative upkeep, "sacrifice unless you pay")', () => {
  /** A parked "pay {cost} or sacrifice `stake`" question, as `payManaOrElse` raises it. */
  function bill(state: GameState, stake: number, cost: CardDefinition['cost']): PayManaChoice {
    return {
      id: 1,
      kind: 'payMana',
      chooser: 'A',
      prompt: 'echo',
      sourceInstanceId: stake,
      sourceName: 'stake',
      valence: 'gain',
      cost: cost ?? {},
      affordable: true,
      stakeInstanceId: stake,
      min: 1,
      max: 1,
    } as PayManaChoice;
  }
  const answerOf = (state: GameState, choice: PayManaChoice): boolean =>
    (answerChoiceHeuristically(state, choice, W) as { answer: { pay: boolean } }).answer.pay;

  it('pays a 3/3’s {1}{G} echo — the body is worth the two mana', () => {
    const state = boardWith(3);
    const [troll] = giveHand(state, 'A', [creature('Albino Troll', 3, 3, { generic: 1, G: 1 })]);
    state.players.A.hand = [];
    troll!.zone = 'battlefield';
    state.battlefield.push(troll!);
    // A three-drop in hand: paying {1}{G} of three mana strands it, so this is
    // the worth-vs-tempo branch, not the spare-mana one.
    giveHand(state, 'A', [creature('Three Drop', 3, 3, { generic: 3 })]);
    expect(answerOf(state, bill(state, troll!.instanceId, { generic: 1, G: 1 }))).toBe(true);
  });

  it('declines a 1/1’s {3}{G}{G} echo (Deranged Hermit keeps its squirrels instead)', () => {
    const state = boardWith(5);
    const [hermit] = giveHand(state, 'A', [creature('Deranged Hermit', 1, 1, { generic: 3, G: 2 })]);
    state.players.A.hand = [];
    hermit!.zone = 'battlefield';
    state.battlefield.push(hermit!);
    giveHand(state, 'A', [creature('Five Drop', 4, 4, { generic: 5 })]);
    expect(answerOf(state, bill(state, hermit!.instanceId, { generic: 3, G: 2 }))).toBe(false);
  });

  it('pays even a poor permanent’s bill when the mana is SPARE — nothing in hand needs it', () => {
    const state = boardWith(5);
    const [hermit] = giveHand(state, 'A', [creature('Deranged Hermit', 1, 1, { generic: 3, G: 2 })]);
    state.players.A.hand = [];
    hermit!.zone = 'battlefield';
    state.battlefield.push(hermit!);
    expect(answerOf(state, bill(state, hermit!.instanceId, { generic: 3, G: 2 }))).toBe(true);
  });

  it('declines a bill whose stake has already left the battlefield, and an unaffordable one', () => {
    const state = boardWith(5);
    expect(answerOf(state, bill(state, 424_242, { generic: 1 }))).toBe(false);
    const [troll] = giveHand(state, 'A', [creature('Albino Troll', 3, 3, { generic: 1, G: 1 })]);
    troll!.zone = 'battlefield';
    state.battlefield.push(troll!);
    expect(answerOf(state, { ...bill(state, troll!.instanceId, { generic: 1 }), affordable: false })).toBe(false);
  });
});

describe('a time-counter permanent is worth less the fewer upkeeps it has left', () => {
  it('ranks a Blastoderm on its last fade counter below a plain 5/5, and a fresh one at par', () => {
    const state = boardWith(2);
    const [plain, fresh, dying] = giveHand(state, 'A', [
      creature('Plain 5/5', 5, 5, { generic: 5 }),
      creature('Fresh Blastoderm', 5, 5, { generic: 4 }),
      creature('Dying Blastoderm', 5, 5, { generic: 4 }),
    ]);
    state.players.A.hand = [];
    for (const c of [plain!, fresh!, dying!]) {
      c.zone = 'battlefield';
      state.battlefield.push(c);
    }
    fresh!.counters = { [FADE_COUNTER]: W.temporaryPermanentHorizon };
    dying!.counters = { [FADE_COUNTER]: 0 };
    const ctx = cardValueContext(state);
    expect(cardValue(fresh, W, ctx)).toBe(cardValue(plain, W, ctx));
    expect(cardValue(dying, W, ctx)).toBeLessThan(cardValue(plain, W, ctx));
    // Vanishing counts its counters as-is (it dies as the LAST one leaves).
    dying!.counters = { [TIME_COUNTER]: 1 };
    expect(cardValue(dying, W, ctx)).toBeCloseTo(cardValue(plain, W, ctx) / W.temporaryPermanentHorizon);
  });
});
