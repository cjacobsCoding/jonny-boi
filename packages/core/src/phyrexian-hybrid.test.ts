/**
 * §3.143 — PHYREXIAN AND MONOCOLOUR HYBRID MANA, the two printed symbol families
 * the cost shape used to refuse, played through real games.
 *
 * One structure carries all three hybrid families (`ManaCost.hybrid` is a list
 * of SYMBOLS, each a list of COMPONENTS), so the tests here are really about the
 * four questions a symbol is asked, each of which fails silently when wrong:
 *
 *  - **mana value** (CR 202.3b/c): the greatest component, and 0 for the life
 *    one — so `{2/W}` is 2 and `{W/P}` is 1 HOWEVER it was paid. Get this wrong
 *    and cost reduction, the curve, every "mana value N or less" filter and the
 *    card index's pip reconciliation are all wrong together, with no crash.
 *  - **colour identity** (CR 202.2b): a fact about the printed cost, never about
 *    the payment. A Dismember paid entirely with life is still black.
 *  - **payment**: the search must find ANY assignment the pool covers, and must
 *    spend EXACTLY the life it was told to — a search free to under-spend would
 *    quietly overrule a caster who paid life to keep mana up.
 *  - **the offer**: one cast per fundable reading, and never a reading the
 *    player cannot afford. CR 118.4 caps the life at the live total (paying to
 *    exactly zero is legal, and promptly lethal).
 */

import { describe, expect, it } from 'vitest';
import {
  addMana,
  applyAction,
  canPay,
  colorsOfDefinition,
  convertedManaCost,
  createGame,
  DEFAULT_RULES,
  dumpState,
  emptyPool,
  formatManaCost,
  generateLegalActions,
  hybridSymbolManaValue,
  minimumManaValue,
  payCost,
  phyrexianLifeOptions,
  PHYREXIAN_LIFE_PRICE,
  type CardDefinition,
  type GameAction,
  type GameState,
  type InstanceId,
  type ManaColor,
  type ManaCost,
} from './index.js';
import { createEffectRegistry, type EffectRegistry } from './effects.js';
import { deckOf, landDef } from './test-fixtures.js';

const SWAMP = landDef('Swamp', 'B');
const WASTES = landDef('Wastes', 'C');

/** Dismember: `{1}{B/P}{B/P}` — two Phyrexian symbols, mana value 3. */
const DISMEMBER: ManaCost = {
  generic: 1,
  hybrid: [
    ['B', { life: PHYREXIAN_LIFE_PRICE }],
    ['B', { life: PHYREXIAN_LIFE_PRICE }],
  ],
};

/** Gut Shot: `{R/P}` — one Phyrexian symbol and nothing else. */
const GUT_SHOT: ManaCost = { hybrid: [['R', { life: PHYREXIAN_LIFE_PRICE }]] };

/** Flame Javelin: `{2/R}{2/R}{2/R}` — monocolour hybrid, mana value 6. */
const FLAME_JAVELIN: ManaCost = {
  hybrid: [
    [{ generic: 2 }, 'R'],
    [{ generic: 2 }, 'R'],
    [{ generic: 2 }, 'R'],
  ],
};

/** Kitchen Finks: `{1}{G/W}{G/W}` — the colour/colour family, unchanged. */
const KITCHEN_FINKS: ManaCost = {
  generic: 1,
  hybrid: [
    ['G', 'W'],
    ['G', 'W'],
  ],
};

describe('§3.143 mana value (CR 202.3b/c)', () => {
  it('a hybrid symbol is worth its GREATEST component', () => {
    expect(hybridSymbolManaValue(['G', 'W'])).toBe(1);
    expect(hybridSymbolManaValue([{ generic: 2 }, 'W'])).toBe(2);
    expect(hybridSymbolManaValue(['W', { life: 2 }])).toBe(1);
    // A compleated planeswalker's three-component symbol: two colours or 2 life.
    expect(hybridSymbolManaValue(['G', 'U', { life: 2 }])).toBe(1);
  });

  it('matches the printed mana value of each real card', () => {
    expect(convertedManaCost(DISMEMBER)).toBe(3);
    expect(convertedManaCost(GUT_SHOT)).toBe(1);
    expect(convertedManaCost(FLAME_JAVELIN)).toBe(6);
    expect(convertedManaCost(KITCHEN_FINKS)).toBe(3);
  });

  it('is unchanged by HOW the symbol was paid', () => {
    // The cost object the engine charges is the printed one; the life a cast
    // spends is a fact about the cast, never a field on the cost. So there is
    // nothing a payment could do to move this number — which is the rule.
    const paid = payCost(addMana(emptyPool(), 'C', 1), DISMEMBER, undefined, 4);
    expect(paid.ok).toBe(true);
    expect(convertedManaCost(DISMEMBER)).toBe(3);
  });

  it('the cheapest reading is a LOWER bound, never above the true mana value', () => {
    expect(minimumManaValue(DISMEMBER, 0)).toBe(3);
    expect(minimumManaValue(DISMEMBER, 4)).toBe(1);
    // Two symbols, 2 life: only ONE could really be life-paid, so the true
    // minimum is 2. The bound says 1 — under-filtering is safe, over-filtering
    // would make a castable card invisible to the pilot.
    expect(minimumManaValue(DISMEMBER, 2)).toBe(1);
    expect(minimumManaValue(FLAME_JAVELIN, 20)).toBe(6);
    expect(minimumManaValue({ generic: 3, R: 1 }, 20)).toBe(4);
  });
});

describe('§3.143 colour identity (CR 202.2b)', () => {
  const defWith = (cost: ManaCost, id: string): CardDefinition => ({
    id,
    name: id,
    types: ['instant'],
    cost,
  });

  it('a Phyrexian symbol makes the card its colour', () => {
    expect(colorsOfDefinition(defWith(DISMEMBER, 'dis'))).toEqual(['B']);
    expect(colorsOfDefinition(defWith(GUT_SHOT, 'gut'))).toEqual(['R']);
  });

  it('a monocolour hybrid is its colour, and its generic half adds none', () => {
    expect(colorsOfDefinition(defWith(FLAME_JAVELIN, 'jav'))).toEqual(['R']);
  });

  it('colour/colour hybrid answers both, in canonical WUBRG order', () => {
    // The order is the same one a card printing {W}{G} gets. Before §3.143 a
    // hybrid cost answered in PRINTED order and a fixed one in WUBRG order —
    // two answers to one question, now one walk over the five pips.
    expect(colorsOfDefinition(defWith(KITCHEN_FINKS, 'finks'))).toEqual(['W', 'G']);
  });
});

describe('§3.143 rendering', () => {
  it('prints each family the way the card does', () => {
    expect(formatManaCost(DISMEMBER)).toBe('{1}{B/P}{B/P}');
    expect(formatManaCost(GUT_SHOT)).toBe('{R/P}');
    expect(formatManaCost(FLAME_JAVELIN)).toBe('{2/R}{2/R}{2/R}');
    expect(formatManaCost(KITCHEN_FINKS)).toBe('{1}{G/W}{G/W}');
  });
});

describe('§3.143 payment', () => {
  const poolOf = (counts: Partial<Record<ManaColor, number>>) => {
    let pool = emptyPool();
    for (const [color, amount] of Object.entries(counts)) {
      pool = addMana(pool, color as ManaColor, amount as number);
    }
    return pool;
  };

  it('monocolour hybrid pays with EITHER the colour or the generic amount', () => {
    expect(canPay(poolOf({ R: 3 }), FLAME_JAVELIN)).toBe(true); // three {R}
    expect(canPay(poolOf({ C: 6 }), FLAME_JAVELIN)).toBe(true); // three {2}
    expect(canPay(poolOf({ R: 1, C: 4 }), FLAME_JAVELIN)).toBe(true); // one {R}, two {2}
    expect(canPay(poolOf({ C: 5 }), FLAME_JAVELIN)).toBe(false); // one pip short
  });

  it('pays a mixed reading the greedy choice would have failed', () => {
    // {2/R}{2/R} with one R and two colourless: paying BOTH with {2} needs four,
    // and paying both with {R} needs two R. Only the mixed assignment works,
    // which is why the search is exhaustive rather than greedy.
    const cost: ManaCost = {
      hybrid: [
        [{ generic: 2 }, 'R'],
        [{ generic: 2 }, 'R'],
      ],
    };
    const pool = poolOf({ R: 1, C: 2 });
    expect(canPay(pool, cost)).toBe(true);
    expect(payCost(pool, cost).ok).toBe(true);
  });

  it('a Phyrexian symbol is unpayable with life the payment was not given', () => {
    // No life offered ⇒ the colour is the only reading, and an empty pool fails.
    expect(canPay(emptyPool(), GUT_SHOT)).toBe(false);
    expect(canPay(emptyPool(), GUT_SHOT, undefined, PHYREXIAN_LIFE_PRICE)).toBe(true);
  });

  it('spends EXACTLY the life it was told to, never less', () => {
    // The pool covers the whole cost in mana, but the caster said 4 life — a
    // search free to under-spend would have overruled them and kept their life.
    const pool = poolOf({ B: 2, C: 1 });
    expect(canPay(pool, DISMEMBER, undefined, 4)).toBe(true);
    const paid = payCost(pool, DISMEMBER, undefined, 4);
    expect(paid.ok).toBe(true);
    // Only the {1} was charged; both B stayed in the pool.
    if (paid.ok) expect(paid.pool.B).toBe(2);
  });

  it('refuses a life amount no assignment of symbols adds up to', () => {
    // Two symbols at 2 life each: 0, 2 and 4 are payable; 3 is not a reading.
    expect(canPay(poolOf({ B: 2, C: 1 }), DISMEMBER, undefined, 3)).toBe(false);
    expect(canPay(poolOf({ C: 1 }), DISMEMBER, undefined, 6)).toBe(false);
  });

  it('enumerates the readings a life total allows, capped by CR 118.4', () => {
    expect(phyrexianLifeOptions(DISMEMBER, 20)).toEqual([0, 2, 4]);
    // At 3 life, paying 4 would go below zero; paying 2 (to exactly 1) is legal.
    expect(phyrexianLifeOptions(DISMEMBER, 3)).toEqual([0, 2]);
    // At exactly 2, paying to EXACTLY zero is the player's call to make.
    expect(phyrexianLifeOptions(GUT_SHOT, 2)).toEqual([0, 2]);
    expect(phyrexianLifeOptions(GUT_SHOT, 1)).toEqual([0]);
    // A cost with no Phyrexian symbol is one reading — every cost in the game
    // but a handful, which is why the offer loop stays a single pass.
    expect(phyrexianLifeOptions(FLAME_JAVELIN, 20)).toEqual([0]);
    expect(phyrexianLifeOptions({ generic: 2, R: 1 }, 20)).toEqual([0]);
  });
});

// --- played through a real game ---------------------------------------------------

const SEED = 0x9f11;

/** Life the fixture spell gains, so "it resolved" is read off the board. */
const LIFE_GAIN = 3;

function registry(): EffectRegistry {
  const reg = createEffectRegistry();
  reg.register('markResolved', (ctx) => {
    ctx.state.players[ctx.controller].life += LIFE_GAIN;
    ctx.emit({
      type: 'lifeChanged',
      player: ctx.controller,
      delta: LIFE_GAIN,
      to: ctx.state.players[ctx.controller].life,
    });
  });
  return reg;
}

function act(state: GameState, action: GameAction, reg: EffectRegistry): GameState {
  const result = applyAction(state, action, DEFAULT_RULES, reg);
  const rejected = result.events.find((e) => e.type === 'actionRejected');
  if (rejected) {
    throw new Error(`unexpected rejection: ${(rejected as { reason: string }).reason}\n${dumpState(state)}`);
  }
  return result.state;
}

function rejection(state: GameState, action: GameAction, reg: EffectRegistry): string | undefined {
  const result = applyAction(state, action, DEFAULT_RULES, reg);
  const rejected = result.events.find((e) => e.type === 'actionRejected');
  return rejected ? (rejected as { reason: string }).reason : undefined;
}

function pass(state: GameState, reg: EffectRegistry): GameState {
  return act(state, { kind: 'passPriority', player: state.priorityPlayer }, reg);
}

function gameAtMain(reg: EffectRegistry, land: CardDefinition): GameState {
  const created = createGame({
    seed: SEED,
    startingPlayer: 'A',
    registry: reg,
    decks: { A: deckOf(land, 40), B: deckOf(land, 40) },
  });
  let state = created.state;
  let guard = 0;
  while (state.step !== 'precombatMain' && !state.gameOver && guard++ < 50) state = pass(state, reg);
  state.players.A.hand = [];
  state.players.B.hand = [];
  return state;
}

function giveCard(state: GameState, def: CardDefinition): InstanceId {
  const instanceId = state.nextInstanceId++;
  state.players.A.hand.push({
    instanceId,
    def,
    controller: 'A',
    owner: 'A',
    zone: 'hand',
    tapped: false,
    summoningSick: false,
    damageMarked: 0,
    markedByDeathtouch: false,
    counters: {},
  });
  return instanceId;
}

function giveLands(state: GameState, count: number, def: CardDefinition): void {
  for (let i = 0; i < count; i++) {
    state.battlefield.push({
      instanceId: state.nextInstanceId++,
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
}

/** Tap every one of A's untapped lands into the pool. */
function tapAll(state: GameState, reg: EffectRegistry): GameState {
  let next = state;
  for (;;) {
    const tap = generateLegalActions(next, DEFAULT_RULES).find(
      (a) => a.kind === 'tapForMana' && a.player === 'A',
    );
    if (!tap) return next;
    next = act(next, tap, reg);
  }
}

const DISMEMBER_CARD: CardDefinition = {
  id: 'dismember',
  name: 'Dismember',
  types: ['instant'],
  timing: 'instant',
  cost: DISMEMBER,
  effects: [{ primitive: 'markResolved' }],
};

const JAVELIN_CARD: CardDefinition = {
  id: 'flame-javelin',
  name: 'Flame Javelin',
  types: ['instant'],
  timing: 'instant',
  cost: FLAME_JAVELIN,
  effects: [{ primitive: 'markResolved' }],
};

function castOffers(state: GameState, instanceId: InstanceId): Extract<GameAction, { kind: 'castSpell' }>[] {
  return generateLegalActions(state, DEFAULT_RULES).filter(
    (a): a is Extract<GameAction, { kind: 'castSpell' }> => a.kind === 'castSpell' && a.instanceId === instanceId,
  );
}

describe('§3.143 in a real game — Phyrexian', () => {
  it('offers one cast per fundable reading, and only the fundable ones', () => {
    const reg = registry();
    let state = gameAtMain(reg, SWAMP);
    const id = giveCard(state, DISMEMBER_CARD);
    giveLands(state, 3, SWAMP);
    state = tapAll(state, reg);
    // Three black floating pays every reading: {1}{B}{B}, {1}{B}+2, {1}+4.
    expect(castOffers(state, id).map((a) => a.phyrexianLife ?? 0)).toEqual([0, 2, 4]);
  });

  it('offers only the LIFE reading when the board cannot make the colour', () => {
    const reg = registry();
    let state = gameAtMain(reg, WASTES);
    const id = giveCard(state, DISMEMBER_CARD);
    giveLands(state, 1, WASTES);
    state = tapAll(state, reg);
    // One colourless pays the {1} and nothing else, so both {B/P} must be life.
    expect(castOffers(state, id).map((a) => a.phyrexianLife ?? 0)).toEqual([4]);
  });

  it('charges the life, spares the mana, and resolves the spell', () => {
    const reg = registry();
    let state = gameAtMain(reg, SWAMP);
    const id = giveCard(state, DISMEMBER_CARD);
    giveLands(state, 3, SWAMP);
    state = tapAll(state, reg);
    const lifeBefore = state.players.A.life;
    state = act(state, { kind: 'castSpell', player: 'A', instanceId: id, phyrexianLife: 4 }, reg);
    expect(state.players.A.life).toBe(lifeBefore - 4);
    // Only the {1} was charged — the two black mana the caster kept are the
    // whole reason to pay life, and a payment that spent them anyway would have
    // made the decision meaningless.
    expect(state.players.A.manaPool.B).toBe(2);
    state = pass(pass(state, reg), reg);
    expect(state.players.A.life).toBe(lifeBefore - 4 + LIFE_GAIN);
  });

  it('caps the reading at the live life total (CR 118.4)', () => {
    const reg = registry();
    let state = gameAtMain(reg, WASTES);
    const id = giveCard(state, DISMEMBER_CARD);
    giveLands(state, 1, WASTES);
    state.players.A.life = 3;
    state = tapAll(state, reg);
    // 4 life would go below zero, so the only remaining reading needs black
    // mana this board cannot make — the card is not on the menu at all.
    expect(castOffers(state, id)).toEqual([]);
  });

  it('paying to exactly zero is legal, and loses the game to the SBAs', () => {
    const reg = registry();
    let state = gameAtMain(reg, WASTES);
    const id = giveCard(state, DISMEMBER_CARD);
    giveLands(state, 1, WASTES);
    state.players.A.life = 4;
    state = tapAll(state, reg);
    expect(castOffers(state, id).map((a) => a.phyrexianLife ?? 0)).toEqual([4]);
    state = act(state, { kind: 'castSpell', player: 'A', instanceId: id, phyrexianLife: 4 }, reg);
    expect(state.players.A.life).toBe(0);
    expect(state.gameOver).toBeTruthy();
  });

  it('refuses a life amount the menu never offered', () => {
    const reg = registry();
    let state = gameAtMain(reg, SWAMP);
    const id = giveCard(state, DISMEMBER_CARD);
    giveLands(state, 3, SWAMP);
    state = tapAll(state, reg);
    // 3 is not an assignment of two 2-life symbols; 6 is more than they price.
    expect(rejection(state, { kind: 'castSpell', player: 'A', instanceId: id, phyrexianLife: 3 }, reg)).toMatch(
      /not a way to pay/,
    );
    expect(rejection(state, { kind: 'castSpell', player: 'A', instanceId: id, phyrexianLife: 6 }, reg)).toMatch(
      /not a way to pay/,
    );
  });
});

describe('§3.143 in a real game — monocolour hybrid', () => {
  it('casts for the generic reading when the board makes no red', () => {
    const reg = registry();
    let state = gameAtMain(reg, WASTES);
    const id = giveCard(state, JAVELIN_CARD);
    giveLands(state, 6, WASTES);
    state = tapAll(state, reg);
    expect(castOffers(state, id).map((a) => a.phyrexianLife ?? 0)).toEqual([0]);
    const lifeBefore = state.players.A.life;
    state = act(state, { kind: 'castSpell', player: 'A', instanceId: id }, reg);
    // Six colourless paid three {2} symbols; no life changed hands.
    expect(state.players.A.manaPool.C).toBe(0);
    expect(state.players.A.life).toBe(lifeBefore);
    state = pass(pass(state, reg), reg);
    expect(state.players.A.life).toBe(lifeBefore + LIFE_GAIN);
  });

  it('is not castable one pip short of the generic reading', () => {
    const reg = registry();
    let state = gameAtMain(reg, WASTES);
    const id = giveCard(state, JAVELIN_CARD);
    giveLands(state, 5, WASTES);
    state = tapAll(state, reg);
    expect(castOffers(state, id)).toEqual([]);
  });
});
