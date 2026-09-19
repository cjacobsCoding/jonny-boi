/**
 * A MANA ABILITY WHOSE AMOUNT THE BOARD DECIDES — DESIGN §3.164.
 *
 * Gaea's Cradle, Axebane Guardian, Karametra's Acolyte and Selvala's parley,
 * as engine data, driven through the real action loop and the real planner:
 *
 *  - the amount is read as the ability is activated, off the board of that
 *    moment — three creatures, three green; none, a tap that adds nothing;
 *  - "in any combination of colors" takes a split that sums to the amount over
 *    the ability's colours, refuses one that does not, and refuses a split on
 *    an ability that prints no combination;
 *  - the PLANNER sees the same amount — it funds a three-pip spell off a Cradle
 *    and three creatures, and plans nothing from a parley, whose amount does
 *    not exist until the reveal;
 *  - the parley reveals, adds per nonland card, gains life through the one
 *    life-gain funnel, and then both players draw.
 */
import { describe, expect, it } from 'vitest';
import {
  applyAction,
  createGame,
  DEFAULT_RULES,
  generateLegalActions,
  planManaPayment,
  type CardDefinition,
  type CardInstance,
  type GameAction,
  type GameState,
  type InstanceId,
  type PlayerId,
} from './index.js';
import { manaAmountOf, scaleProduction, splitMatchesAmount } from './mana-amount.js';
import { NO_MOD } from './internal/continuous.js';
import { creatureDef, deckOf, landDef } from './test-fixtures.js';

const FOREST = landDef('Forest', 'G');
const BEAR = creatureDef('bear', 2, 2, { cost: { generic: 1, G: 1 }, name: 'Test Bear' });
const WALL = creatureDef('wall', 0, 4, { cost: { generic: 1, G: 1 }, name: 'Test Wall', keywords: { defender: true } });

/** "{T}: Add {G} for each creature you control." */
const CRADLE: CardDefinition = {
  id: 'cradle',
  name: 'Test Cradle',
  types: ['land'],
  legendary: true,
  manaAbilities: [{ produces: [{ G: 1 }], amount: { countOf: 'creaturesYouControl' } }],
};

/** "{T}: Add X mana in any combination of colors, where X is the number of creatures you control with defender." */
const AXEBANE: CardDefinition = {
  id: 'axebane',
  name: 'Test Axebane',
  types: ['creature'],
  cost: { generic: 2, G: 1 },
  power: 0,
  toughness: 3,
  keywords: { defender: true },
  manaAbilities: [
    {
      produces: [{ W: 1 }, { U: 1 }, { B: 1 }, { R: 1 }, { G: 1 }],
      amount: { countOf: 'creaturesYouControlWithDefender' },
      anyCombination: true,
    },
  ],
};

/** "{T}: Add an amount of {G} equal to this creature's power." */
const CLEARCUTTER: CardDefinition = {
  id: 'clearcutter',
  name: 'Test Clearcutter',
  types: ['creature'],
  power: 3,
  toughness: 3,
  manaAbilities: [{ produces: [{ G: 1 }], amount: { countOf: 'sourcePower' } }],
};

/** Selvala's parley, as a rider on an EMPTY mode. */
const PARLEY: CardDefinition = {
  id: 'parley',
  name: 'Test Parley',
  types: ['creature'],
  power: 2,
  toughness: 4,
  manaAbilities: [
    { produces: [{}], rider: { parley: { manaPerNonland: { G: 1 }, lifePerNonland: 1, thenEachPlayerDraws: true } } },
  ],
};

/** A {G}{G}{G} sorcery, to make the planner earn its three. */
const TRIPLE_GREEN: CardDefinition = {
  id: 'triple',
  name: 'Test Triple',
  types: ['sorcery'],
  cost: { G: 3 },
  effects: [{ primitive: 'testMark' }],
};

function atMain(): GameState {
  const { state } = createGame({ seed: 5, startingPlayer: 'A', decks: { A: deckOf(FOREST, 40), B: deckOf(FOREST, 40) } });
  let s = state;
  for (let guard = 0; guard < 200 && s.step !== 'precombatMain'; guard++) {
    s = applyAction(s, { kind: 'passPriority', player: s.priorityPlayer }, DEFAULT_RULES).state;
  }
  s.players.A.hand = [];
  s.players.B.hand = [];
  s.players.A.manaPool = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
  return s;
}

function place(state: GameState, def: CardDefinition, controller: PlayerId, zone: 'battlefield' | 'hand' = 'battlefield'): CardInstance {
  const inst: CardInstance = {
    instanceId: state.nextInstanceId++,
    def,
    controller,
    owner: controller,
    zone,
    tapped: false,
    summoningSick: false,
    damageMarked: 0,
    markedByDeathtouch: false,
    counters: {},
  };
  if (zone === 'hand') state.players[controller].hand.push(inst);
  else state.battlefield.push(inst);
  return inst;
}

function tap(state: GameState, id: InstanceId, extra: Partial<Extract<GameAction, { kind: 'tapForMana' }>> = {}) {
  return applyAction(state, { kind: 'tapForMana', player: 'A', instanceId: id, ...extra } as GameAction, DEFAULT_RULES);
}

function rejectionOf(result: ReturnType<typeof applyAction>): string | undefined {
  const r = result.events.find((e) => e.type === 'actionRejected') as { reason?: string } | undefined;
  return r?.reason;
}

describe('manaAmountOf — the closed vocabulary, read off the board', () => {
  it('a named battlefield count, a filtered count, the source’s own power, and the zero floor', () => {
    const s = atMain();
    const cradle = place(s, CRADLE, 'A');
    expect(manaAmountOf(s, cradle, { countOf: 'creaturesYouControl' })).toBe(0);
    place(s, BEAR, 'A');
    place(s, BEAR, 'A');
    place(s, BEAR, 'B'); // theirs
    expect(manaAmountOf(s, cradle, { countOf: 'creaturesYouControl' })).toBe(2);
    expect(manaAmountOf(s, cradle, { countOf: 'permanentsMatching', filter: { anyOfTypes: ['creature'] }, scope: 'any' })).toBe(3);
    const cutter = place(s, CLEARCUTTER, 'A');
    expect(manaAmountOf(s, cutter, { countOf: 'sourcePower' }, NO_MOD)).toBe(3);
    expect(manaAmountOf(s, cutter, { countOf: 'sourcePower' }, { ...NO_MOD, power: -5 })).toBe(0);
  });

  it('scaleProduction and splitMatchesAmount', () => {
    expect(scaleProduction({ G: 1 }, 3)).toEqual({ G: 3 });
    expect(scaleProduction({ G: 1 }, 1)).toEqual({ G: 1 });
    expect(scaleProduction({ G: 1, C: 2 }, 0)).toEqual({});
    const colours = [{ W: 1 }, { U: 1 }, { B: 1 }, { R: 1 }, { G: 1 }];
    expect(splitMatchesAmount({ G: 2, W: 1 }, 3, colours)).toBe(true);
    expect(splitMatchesAmount({ G: 2 }, 3, colours), 'short').toBe(false);
    expect(splitMatchesAmount({ G: 4 }, 3, colours), 'over').toBe(false);
    expect(splitMatchesAmount({ C: 3 }, 3, colours), 'a colour the ability does not offer').toBe(false);
    expect(splitMatchesAmount({ G: 1.5, W: 1.5 }, 3, colours), 'whole numbers').toBe(false);
  });
});

describe('through the engine', () => {
  it('a Cradle taps for one green per creature, read at activation — and for nothing on an empty board', () => {
    let s = atMain();
    const cradle = place(s, CRADLE, 'A');
    let r = tap(s, cradle.instanceId);
    expect(rejectionOf(r)).toBeUndefined();
    expect(r.state.players.A.manaPool.G, 'no creatures — a tap that adds nothing').toBe(0);
    s = atMain();
    const cradle2 = place(s, CRADLE, 'A');
    place(s, BEAR, 'A');
    place(s, BEAR, 'A');
    place(s, BEAR, 'A');
    r = tap(s, cradle2.instanceId);
    expect(rejectionOf(r)).toBeUndefined();
    expect(r.state.players.A.manaPool.G).toBe(3);
  });

  it('Axebane: a mode is the whole amount in that colour; a split is accepted when it sums, refused when it does not', () => {
    const s = atMain();
    const axe = place(s, AXEBANE, 'A'); // a defender itself: 1
    place(s, WALL, 'A'); // 2
    place(s, BEAR, 'A'); // not a defender
    // mode 4 is {G}
    let r = tap(s, axe.instanceId, { mode: 4 });
    expect(rejectionOf(r)).toBeUndefined();
    expect(r.state.players.A.manaPool.G).toBe(2);
    // a split across two colours
    r = tap(s, axe.instanceId, { mode: 4, split: { G: 1, W: 1 } });
    expect(rejectionOf(r)).toBeUndefined();
    expect(r.state.players.A.manaPool).toMatchObject({ G: 1, W: 1 });
    // short, over, wrong colour
    expect(rejectionOf(tap(s, axe.instanceId, { split: { G: 1 } }))).toMatch(/exactly 2 mana/);
    expect(rejectionOf(tap(s, axe.instanceId, { split: { G: 3 } }))).toMatch(/exactly 2 mana/);
    expect(rejectionOf(tap(s, axe.instanceId, { split: { C: 2 } }))).toMatch(/exactly 2 mana/);
  });

  it('a split on an ability that prints no combination is refused, by name', () => {
    const s = atMain();
    const cradle = place(s, CRADLE, 'A');
    place(s, BEAR, 'A');
    expect(rejectionOf(tap(s, cradle.instanceId, { split: { G: 1 } }))).toMatch(/one colour per activation/);
    const forest = s.battlefield.find((c) => c.def.id === FOREST.id && c.controller === 'A');
    if (forest) expect(rejectionOf(tap(s, forest.instanceId, { split: { G: 1 } }))).toMatch(/no amount to split/);
  });

  it('the source’s own power is read LAYERED — a pumped Clearcutter taps for more', () => {
    const s = atMain();
    const cutter = place(s, CLEARCUTTER, 'A');
    let r = tap(s, cutter.instanceId);
    expect(r.state.players.A.manaPool.G).toBe(3);
    // A +2/+2 until end of turn, through the engine's own continuous list.
    s.continuous.push({ id: 1, targetInstanceId: cutter.instanceId, sourceInstanceId: cutter.instanceId, duration: 'endOfTurn', power: 2, toughness: 2 } as never);
    r = tap(s, cutter.instanceId);
    expect(r.state.players.A.manaPool.G).toBe(5);
  });
});

describe('the planner sees the same amount', () => {
  it('funds {G}{G}{G} from a Cradle and three creatures, tapping the Cradle once', () => {
    const s = atMain();
    // Lands the game dealt A stay untapped; the Cradle is the only source that
    // can make three on its own, and the plan must not need the rest.
    s.battlefield = s.battlefield.filter((c) => c.controller !== 'A');
    place(s, CRADLE, 'A');
    place(s, BEAR, 'A');
    place(s, BEAR, 'A');
    place(s, BEAR, 'A');
    const plan = planManaPayment(s, 'A', TRIPLE_GREEN.cost!, generateLegalActions(s), TRIPLE_GREEN);
    expect(plan, 'a plan exists').toBeDefined();
    expect(plan!.length, 'one tap of the Cradle').toBe(1);
    expect(plan![0]!.instanceId).toBe(s.battlefield.find((c) => c.def.id === 'cradle')!.instanceId);
  });

  it('plans NOTHING from a Cradle on an empty board, and nothing from a parley', () => {
    const s = atMain();
    s.battlefield = s.battlefield.filter((c) => c.controller !== 'A');
    place(s, CRADLE, 'A');
    expect(planManaPayment(s, 'A', { G: 1 }, generateLegalActions(s), TRIPLE_GREEN), 'no creatures — no green').toBeUndefined();
    const parley = place(s, PARLEY, 'A');
    // Selvala is herself a creature, so the Cradle now makes one — and the plan
    // taps the CRADLE for it, never the parley, whose mode plans as nothing.
    const plan = planManaPayment(s, 'A', { G: 1 }, generateLegalActions(s), TRIPLE_GREEN);
    expect(plan?.map((t) => t.instanceId)).toEqual([s.battlefield.find((c) => c.def.id === 'cradle')!.instanceId]);
    expect(planManaPayment(s, 'A', { G: 2 }, generateLegalActions(s), TRIPLE_GREEN), 'two green: the parley is not counted on').toBeUndefined();
    void parley;
  });
});

describe('the parley (Selvala, Explorer Returned)', () => {
  it('reveals both top cards, adds per nonland card, gains the life through the funnel, then both draw', () => {
    const s = atMain();
    const selvala = place(s, PARLEY, 'A');
    // Rig the tops: A reveals a creature card (nonland), B reveals a Forest.
    const nonland: CardInstance = { ...place(s, BEAR, 'A', 'hand'), zone: 'library' };
    s.players.A.hand = [];
    s.players.A.library.unshift(nonland);
    const handA = s.players.A.hand.length;
    const handB = s.players.B.hand.length;
    const libA = s.players.A.library.length;
    const libB = s.players.B.library.length;
    const life = s.players.A.life;
    const r = tap(s, selvala.instanceId);
    expect(rejectionOf(r)).toBeUndefined();
    const reveals = r.events.filter((e) => e.type === 'cardRevealed') as Array<{ player: PlayerId; name: string; matched?: boolean }>;
    expect(reveals.map((e) => [e.player, e.matched])).toEqual([['A', true], ['B', false]]);
    expect(r.state.players.A.manaPool.G, 'one nonland card — one green').toBe(1);
    expect(r.state.players.A.life, 'and one life').toBe(life + 1);
    expect(r.events.some((e) => e.type === 'gainLife'), 'as a life-gain event "whenever you gain life" can see').toBe(true);
    expect(r.state.players.A.hand.length, 'A drew').toBe(handA + 1);
    expect(r.state.players.B.hand.length, 'B drew').toBe(handB + 1);
    expect(r.state.players.A.library.length).toBe(libA - 1);
    expect(r.state.players.B.library.length).toBe(libB - 1);
    expect(r.state.players.A.hand.some((c) => c.instanceId === nonland.instanceId), 'the revealed card is the one drawn').toBe(true);
  });

  it('two lands revealed: no mana, no life, and still both draw', () => {
    const s = atMain();
    const selvala = place(s, PARLEY, 'A');
    const life = s.players.A.life;
    const handA = s.players.A.hand.length;
    const r = tap(s, selvala.instanceId);
    expect(r.state.players.A.manaPool.G).toBe(0);
    expect(r.state.players.A.life).toBe(life);
    expect(r.events.some((e) => e.type === 'gainLife')).toBe(false);
    expect(r.state.players.A.hand.length).toBe(handA + 1);
  });
});
