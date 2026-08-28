/**
 * PRICING THE §3.49 LEDGER (DESIGN §3.52).
 *
 * §3.49 proved twenty registered primitives had no value entry — each scoring
 * the flat `modeUnknownEffectScore`, each a §3.42-class blind spot ("every
 * candidate ties, the first offered wins"). This file is the per-entry proof
 * for the fourteen priced here, in §3.42's own style: two candidates, the
 * right one must win; a self-harm case must price negative where the rules
 * say it is one; and the OFF switch (`priceLedgeredEffects: false`) must
 * reproduce the pre-§3.52 model exactly, because that contract is what makes
 * the §3.52 strength/throughput measurements re-runnable in one process.
 *
 * Fixtures follow blink-value.test.ts: a real library (an empty one prices
 * every draw as decking yourself — the §3.42 fixture bug), real pool cards
 * where the card's identity is the test (Angel of Serenity's aim), inline
 * param-shaped refs everywhere else, since entries price by PARAMS SHAPE.
 */
import { describe, expect, it } from 'vitest';
import type {
  CardDefinition,
  CardInstance,
  EffectRef,
  GameState,
  InstanceId,
  PendingChoice,
  PlayerId,
} from '@jonny-boi/core';
import { normalizeChoiceRequest, validateChoiceAnswer } from '@jonny-boi/core';
import { CARD_POOL } from '@jonny-boi/cards';
import { DEFAULT_HEURISTIC_WEIGHTS, type HeuristicWeights } from './weights.js';
import {
  LEDGER_PRICING_OFF_WEIGHTS,
  resolutionValueContext,
  valueOfEffects,
} from './effect-value.js';
import { answerChoiceHeuristically } from './choices.js';
import { cardValueContext } from './card-value.js';
import { boardIndex } from './board-stats.js';

const WEIGHTS = DEFAULT_HEURISTIC_WEIGHTS;

/** The pre-§3.52 value model, as one merged weight set (the ablation arm). */
const OFF_WEIGHTS: HeuristicWeights = Object.freeze({ ...WEIGHTS, ...LEDGER_PRICING_OFF_WEIGHTS });

// --- fixtures (the blink-value.test.ts shape) --------------------------------------

function pooled(name: string): CardDefinition {
  const c = CARD_POOL.find((e) => e.name === name);
  if (!c) throw new Error('pool missing ' + name);
  return c;
}

const VANILLA: CardDefinition = {
  id: 'lp-vanilla',
  name: 'lp-vanilla',
  types: ['creature'],
  power: 2,
  toughness: 2,
  cost: { generic: 2 },
};

const BIG: CardDefinition = { ...VANILLA, id: 'lp-big', name: 'lp-big', power: 5, toughness: 5, cost: { generic: 5 } };
const SMALL: CardDefinition = { ...VANILLA, id: 'lp-small', name: 'lp-small', power: 1, toughness: 1, cost: { generic: 1 } };
const WALL: CardDefinition = { ...VANILLA, id: 'lp-wall', name: 'lp-wall', power: 0, toughness: 4, cost: { generic: 2 } };

interface Placed {
  readonly state: GameState;
  readonly place: (def: CardDefinition, controller: PlayerId) => InstanceId;
  readonly toGraveyard: (def: CardDefinition, owner: PlayerId) => InstanceId;
}

function freshState(librarySize = 20): Placed {
  const library = (owner: PlayerId) =>
    Array.from({ length: librarySize }, (_, i) => ({
      instanceId: (owner === 'A' ? 900 : 950) + i,
      def: VANILLA,
      controller: owner,
      owner,
      zone: 'library',
    })) as unknown as CardInstance[];
  const seat = (owner: PlayerId) => ({
    life: 20,
    hand: [],
    library: library(owner),
    graveyard: [],
    exile: [],
    command: [],
    manaPool: { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 },
    landsPlayedThisTurn: 0,
    hasLost: false,
  });
  const state = {
    battlefield: [] as CardInstance[],
    players: { A: seat('A'), B: seat('B') },
    nextInstanceId: 1,
    stack: [],
    continuous: [],
    turnNumber: 1,
    step: 'precombatMain',
    activePlayer: 'A',
    priorityPlayer: 'A',
    gameOver: false,
  } as unknown as GameState;
  const place = (def: CardDefinition, controller: PlayerId): InstanceId => {
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
      attachedTo: null,
      counters: {},
    } as unknown as CardInstance);
    return id;
  };
  const toGraveyard = (def: CardDefinition, owner: PlayerId): InstanceId => {
    const id = state.nextInstanceId++;
    state.players[owner].graveyard.push({
      instanceId: id,
      def,
      controller: owner,
      owner,
      zone: 'graveyard',
      damageMarked: 0,
      counters: {},
    } as unknown as CardInstance);
    return id;
  };
  return { state, place, toGraveyard };
}

/** Price one ref for seat A, aimed at `targets`, under `weights`. */
function price(
  state: GameState,
  ref: EffectRef,
  targets: readonly (InstanceId | PlayerId)[] = [],
  weights: HeuristicWeights = WEIGHTS,
): number {
  const index = boardIndex(state);
  const base = resolutionValueContext(state, 'A', weights, cardValueContext(state, index));
  return valueOfEffects([ref], { ...base, targets: [...targets] });
}

// --- scry / surveil -----------------------------------------------------------------

describe('pricing scry and surveil (selection, deepened, capped at a draw)', () => {
  const scry = (count: number): EffectRef => ({ primitive: 'scry', params: { count } });

  it('scry 3 beats scry 1 — depth is worth something', () => {
    const { state } = freshState();
    expect(price(state, scry(3))).toBeGreaterThan(price(state, scry(1)));
  });

  it('never beats drawing a card, at any depth', () => {
    const { state } = freshState();
    for (const count of [1, 2, 3, 7, 50]) {
      expect(price(state, scry(count))).toBeLessThanOrEqual(WEIGHTS.modeDrawCardValue);
    }
  });

  it('an empty library scries nothing and prices zero', () => {
    const { state } = freshState(0);
    expect(price(state, scry(2))).toBe(0);
  });

  it("the OPPONENT's scry prices negative from our seat", () => {
    const { state } = freshState();
    expect(price(state, { primitive: 'scry', params: { count: 2, who: 'opponent' } })).toBeLessThan(0);
  });

  it('surveil prices exactly as scry — the graveyard difference is deliberately unpriced', () => {
    const { state } = freshState();
    expect(price(state, { primitive: 'surveil', params: { count: 2 } })).toBe(price(state, scry(2)));
  });
});

// --- addCounters ---------------------------------------------------------------------

describe('pricing +1/+1 / -1/-1 counters (the §3.42 aiming shape)', () => {
  const plus = (amount: number): EffectRef => ({ primitive: 'addCounters', params: { amount } });

  it('a +2/+2 aimed at OUR creature beats the same aimed at THEIRS — which is a mistake, priced as one', () => {
    const { state, place } = freshState();
    const mine = place(VANILLA, 'A');
    const theirs = place(VANILLA, 'B');
    expect(price(state, plus(2), [mine])).toBeGreaterThan(0);
    expect(price(state, plus(2), [theirs])).toBeLessThan(0);
  });

  it('a -2/-2 aimed at THEIR 2/2 prices as the removal it is; aimed at ours, as the mistake it is', () => {
    const { state, place } = freshState();
    const mine = place(VANILLA, 'A');
    const theirs = place(VANILLA, 'B');
    expect(price(state, plus(-2), [theirs])).toBeGreaterThanOrEqual(WEIGHTS.removalBaseScore);
    expect(price(state, plus(-2), [mine])).toBeLessThan(0);
  });

  it('a -1/-1 that only trims a 5/5 is worth less than the kill', () => {
    const { state, place } = freshState();
    const big = place(BIG, 'B');
    const trim = price(state, plus(-1), [big]);
    expect(trim).toBeGreaterThan(0);
    expect(trim).toBeLessThan(WEIGHTS.removalBaseScore);
  });

  it('the GROUP form scales with the bodies it actually reaches', () => {
    const one = freshState();
    one.place(VANILLA, 'A');
    const three = freshState();
    three.place(VANILLA, 'A');
    three.place(VANILLA, 'A');
    three.place(VANILLA, 'A');
    const each: EffectRef = { primitive: 'addCounters', params: { amount: 1, each: true, scope: 'you' } };
    const small = price(one.state, each);
    const large = price(three.state, each);
    expect(small).toBeGreaterThan(0);
    expect(large).toBe(3 * small);
  });

  it('the SELF form ("~ enters with two +1/+1 counters") prices positive with no target at all', () => {
    const { state } = freshState();
    expect(price(state, { primitive: 'addCounters', params: { amount: 2, self: true } })).toBeGreaterThan(0);
  });
});

// --- ifKicked (the wrapper) -----------------------------------------------------------

describe('pricing "if this spell was kicked" (a WRAPPER — the body must be read)', () => {
  const DRAW: EffectRef[] = [{ primitive: 'drawCards', params: { count: 2 } }];
  const kicked = (effects: readonly EffectRef[]): EffectRef => ({ primitive: 'ifKicked', params: { effects } });

  it('a rich body outprices an empty one — the §3.42 wrapper requirement', () => {
    const { state } = freshState();
    expect(price(state, kicked(DRAW))).toBeGreaterThan(price(state, kicked([])));
  });

  it('is worth a SHARE of the body while the kicker is unpaid, the FULL body once a resolution says kicked, and NOTHING once it says unkicked', () => {
    const { state } = freshState();
    const index = boardIndex(state);
    const body = valueOfEffects(DRAW, {
      ...resolutionValueContext(state, 'A', WEIGHTS, cardValueContext(state, index)),
      targets: [],
    });
    expect(price(state, kicked(DRAW))).toBeCloseTo(body * WEIGHTS.kickedClauseValueShare);

    (state as { resolution?: { targets: unknown[]; kicked?: boolean } }).resolution = { targets: [], kicked: true };
    expect(price(state, kicked(DRAW))).toBeCloseTo(body);

    (state as unknown as { resolution: { kicked?: boolean } }).resolution.kicked = false;
    expect(price(state, kicked(DRAW))).toBe(0);
  });
});

// --- exileUntilLeaves / returnExiledByThis ---------------------------------------------

describe('pricing the jail (exile until this leaves) — the Angel of Serenity aim', () => {
  const JAIL: EffectRef = {
    primitive: 'exileUntilLeaves',
    params: { max: 3, targets: 'creatureOnBattlefieldOrInGraveyard' },
  };

  it("orders the aims the way the card is played: their board, then our yard, then their yard — and never our board", () => {
    const { state, place, toGraveyard } = freshState();
    const theirBoard = place(VANILLA, 'B');
    const ourBoard = place(VANILLA, 'A');
    const ourYard = toGraveyard(BIG, 'A');
    const theirYard = toGraveyard(BIG, 'B');

    const jailTheirBoard = price(state, JAIL, [theirBoard]);
    const jailOurYard = price(state, JAIL, [ourYard]);
    const jailTheirYard = price(state, JAIL, [theirYard]);
    const jailOurBoard = price(state, JAIL, [ourBoard]);

    expect(jailTheirBoard).toBeGreaterThan(jailOurYard);
    expect(jailOurYard).toBeGreaterThan(jailTheirYard);
    expect(jailTheirYard).toBe(0);
    expect(jailOurBoard).toBeLessThan(0);
  });

  it('the release half prices zero — never the upside the flat constant claimed it was', () => {
    const { state } = freshState();
    expect(price(state, { primitive: 'returnExiledByThis', params: { to: 'hand' } })).toBe(0);
  });

  it("REAL CONSUMER: Angel of Serenity's parked trigger aims at exactly the opponent's creatures, not its controller's own", () => {
    const angel = pooled('Angel of Serenity');
    const trigger = (angel.triggers ?? []).find((t) => t.condition.on === 'etb');
    if (!trigger) throw new Error('Angel of Serenity lost its ETB trigger');

    const { state, place } = freshState();
    const ourOther = place(VANILLA, 'A');
    const theirBig = place(BIG, 'B');
    const theirSmall = place(SMALL, 'B');
    state.stack.push({
      kind: 'trigger',
      instanceId: 9001,
      sourceInstanceId: 1,
      controller: 'A',
      effects: trigger.effects,
      targets: [],
      label: 'Enters: jail up to three',
      awaitingTargets: 'creatureOnBattlefieldOrInGraveyard',
    } as unknown as GameState['stack'][number]);
    const choice = normalizeChoiceRequest(
      {
        kind: 'selectTargets',
        chooser: 'A',
        prompt: 'Choose up to three targets',
        candidates: [
          { ref: ourOther, name: 'ours', controller: 'A' },
          { ref: theirBig, name: 'their big', controller: 'B' },
          { ref: theirSmall, name: 'their small', controller: 'B' },
        ],
        restriction: 'creatureOnBattlefieldOrInGraveyard',
        min: 0,
        max: 3,
      },
      { id: 11, sourceInstanceId: 9001, sourceName: angel.name },
    ) as PendingChoice;
    state.pendingChoice = choice;

    const action = answerChoiceHeuristically(state, choice, WEIGHTS);
    if (action.kind !== 'answerChoice' || action.answer.kind !== 'selectTargets') throw new Error('wrong shape');
    expect(validateChoiceAnswer(choice, action.answer).ok).toBe(true);
    // The biggest threat first, the small one second, its OWN creature never —
    // "up to three" does not mean "always three".
    expect(action.answer.targets).toEqual([theirBig, theirSmall]);
  });
});

// --- gainControl -----------------------------------------------------------------------

describe('pricing theft-for-the-turn (Act of Treason)', () => {
  const THEFT: EffectRef = { primitive: 'gainControl', params: { untap: true, haste: true } };

  it('steals the biggest body — and stealing your own prices as the blank it is', () => {
    const { state, place } = freshState();
    const big = place(BIG, 'B');
    const small = place(SMALL, 'B');
    const mine = place(BIG, 'A');
    expect(price(state, THEFT, [big])).toBeGreaterThan(price(state, THEFT, [small]));
    expect(price(state, THEFT, [mine])).toBeLessThan(0);
  });

  it('sits between tapping the body and killing it — they get it back at cleanup', () => {
    const { state, place } = freshState();
    const big = place(BIG, 'B');
    const theft = price(state, THEFT, [big]);
    const tap = price(state, { primitive: 'tapTarget' }, [big]);
    const kill = price(state, { primitive: 'destroyTarget' }, [big]);
    expect(theft).toBeGreaterThan(tap);
    expect(theft).toBeLessThan(kill);
  });

  it('a 0-power wall still prices positive — theft denies the block, exactly as a tap does', () => {
    const { state, place } = freshState();
    const wall = place(WALL, 'B');
    expect(price(state, THEFT, [wall])).toBeGreaterThan(0);
  });
});

// --- grantKeywordToYoursUntilEndOfTurn ---------------------------------------------------

describe('pricing the mass keyword grant (Boros Charm\'s indestructible mode)', () => {
  const GRANT: EffectRef = {
    primitive: 'grantKeywordToYoursUntilEndOfTurn',
    params: { keywords: { indestructible: true } },
  };

  it('is worth NOTHING on an empty board — where the flat constant used to beat drawing a card', () => {
    const { state } = freshState();
    expect(price(state, GRANT)).toBe(0);
  });

  it('scales with the bodies it actually reaches, and stays below removal', () => {
    const { state, place } = freshState();
    place(VANILLA, 'A');
    const one = price(state, GRANT);
    place(VANILLA, 'A');
    place(VANILLA, 'A');
    const three = price(state, GRANT);
    expect(one).toBeGreaterThan(0);
    expect(three).toBe(3 * one);
    expect(three).toBeLessThan(WEIGHTS.removalBaseScore);
  });
});

// --- mill --------------------------------------------------------------------------------

describe('pricing mill', () => {
  const mill = (amount: number, self = false): EffectRef => ({
    primitive: 'mill',
    params: self ? { amount, self: true } : { amount },
  });

  it('milling the opponent is small positive pressure; milling yourself is the same rate as a loss', () => {
    const { state } = freshState();
    expect(price(state, mill(6))).toBeGreaterThan(0);
    expect(price(state, mill(6))).toBeLessThan(WEIGHTS.modeDrawCardValue);
    expect(price(state, mill(6, true))).toBe(-price(state, mill(6)));
  });

  it('EMPTYING their library prices as the near-win the decking rule makes it', () => {
    const { state } = freshState(5);
    expect(price(state, mill(5))).toBe(WEIGHTS.lethalBurnScore);
  });

  it('emptying our OWN library prices as the catastrophe the draw entry already knows', () => {
    const { state } = freshState(5);
    expect(price(state, mill(5, true))).toBe(-WEIGHTS.modeSelfDeckPenalty);
  });
});

// --- dealDamageToEach ----------------------------------------------------------------------

describe('pricing "deals N damage to each …" (Pyroclasm / Guttersnipe)', () => {
  const SWEEP2: EffectRef = { primitive: 'dealDamageToEach', params: { amount: 2, creatures: true } };

  it('positive when it clears their board and spares ours; negative the other way around', () => {
    const good = freshState();
    good.place(SMALL, 'B');
    good.place(SMALL, 'B');
    good.place(BIG, 'A');
    expect(price(good.state, SWEEP2)).toBeGreaterThan(0);

    const bad = freshState();
    bad.place(SMALL, 'A');
    bad.place(SMALL, 'A');
    bad.place(BIG, 'B');
    expect(price(bad.state, SWEEP2)).toBeLessThan(0);
  });

  it("the Guttersnipe half — damage to each opponent — prices as face damage, and as the WIN when it is lethal", () => {
    const { state } = freshState();
    expect(price(state, { primitive: 'dealDamageToEach', params: { amount: 2, opponents: true } })).toBe(
      WEIGHTS.burnFaceBaseScore,
    );
    state.players.B.life = 2;
    expect(price(state, { primitive: 'dealDamageToEach', params: { amount: 2, opponents: true } })).toBe(
      WEIGHTS.lethalBurnScore,
    );
  });

  it('"each player" charges our own life at the loseLife rate', () => {
    const { state } = freshState();
    const both = price(state, { primitive: 'dealDamageToEach', params: { amount: 2, players: true } });
    const oppOnly = price(state, { primitive: 'dealDamageToEach', params: { amount: 2, opponents: true } });
    expect(both).toBeLessThan(oppOnly);
    expect(both).toBe(oppOnly - 2 * WEIGHTS.modeLifePerPointValue);
  });
});

// --- the small honest entries -----------------------------------------------------------

describe('the small honest entries', () => {
  it('chooseAsEnters prices ZERO — the naming is free, the payoff is the static that reads it', () => {
    const { state } = freshState();
    expect(price(state, { primitive: 'chooseAsEnters' })).toBe(0);
  });

  it('handToBottomThenDraw is selection for whoever wheels — ours positive, theirs negative, empty hand zero', () => {
    const { state } = freshState();
    expect(price(state, { primitive: 'handToBottomThenDraw' })).toBe(0); // empty hand
    state.players.A.hand.push({
      instanceId: 700,
      def: VANILLA,
      controller: 'A',
      owner: 'A',
      zone: 'hand',
    } as unknown as CardInstance);
    expect(price(state, { primitive: 'handToBottomThenDraw' })).toBe(WEIGHTS.modeSelectionValue);
  });

  it('persistReturn is a creature-return floor shrunk by its -1/-1 counters, never negative', () => {
    const { state } = freshState();
    const one = price(state, { primitive: 'persistReturn', params: { minusCounters: 1 } });
    expect(one).toBeGreaterThan(0);
    expect(one).toBeLessThan(WEIGHTS.castCreatureBaseScore);
    expect(price(state, { primitive: 'persistReturn', params: { minusCounters: 50 } })).toBe(0);
  });

  it('transformRevealTop prices as the selection-adjacent look it is', () => {
    const { state } = freshState();
    expect(price(state, { primitive: 'transformRevealTop' })).toBe(WEIGHTS.modeSelectionValue);
  });
});

// --- the OFF switch (the §3.52 measurement contract) ---------------------------------------

describe('LEDGER_PRICING_OFF_WEIGHTS reproduces the pre-§3.52 model exactly', () => {
  it('every ledgered ref scores the flat unknown constant again, wrapper bodies unread', () => {
    const { state, place } = freshState();
    const theirs = place(BIG, 'B');
    const flat = WEIGHTS.modeUnknownEffectScore;
    expect(price(state, { primitive: 'scry', params: { count: 3 } }, [], OFF_WEIGHTS)).toBe(flat);
    expect(price(state, { primitive: 'addCounters', params: { amount: 2 } }, [theirs], OFF_WEIGHTS)).toBe(flat);
    const rich: EffectRef = {
      primitive: 'ifKicked',
      params: { effects: [{ primitive: 'drawCards', params: { count: 2 } }] },
    };
    expect(price(state, rich, [], OFF_WEIGHTS)).toBe(flat);
    expect(price(state, { primitive: 'ifKicked', params: { effects: [] } }, [], OFF_WEIGHTS)).toBe(flat);
  });

  it('the ids the FIRST table prices are untouched by the switch', () => {
    const { state, place } = freshState();
    const theirs = place(BIG, 'B');
    expect(price(state, { primitive: 'destroyTarget' }, [theirs], OFF_WEIGHTS)).toBe(
      price(state, { primitive: 'destroyTarget' }, [theirs]),
    );
  });
});
