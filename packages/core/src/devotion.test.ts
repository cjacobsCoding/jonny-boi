/**
 * DEVOTION (CR 700.5) AND THE GODS' TYPE LAYER — DESIGN §3.163.
 *
 * Both directions of the layer are pinned, because each fails differently: a
 * god that never STOPS being a creature is a 5/5 indestructible body for three
 * mana (a strictly better card), and a god that never STARTS being one again is
 * a card playing weaker than printed. And the zone reset is pinned, because a
 * god that died as a non-creature form must be a creature CARD in the graveyard
 * — or every reanimation and "creature card" count on it reads wrong.
 */
import { describe, expect, it } from 'vitest';
import {
  applyAction,
  createGame,
  DEFAULT_RULES,
  evaluateDerivedCount,
  generateLegalActions,
  isCreature,
  type CardDefinition,
  type CardInstance,
  type GameState,
  type InstanceId,
  type PlayerId,
} from './index.js';
import { devotionOfCost, devotionTo, nonCreatureFormOf, settleDevotionForms } from './devotion.js';
import { moveToZone, resetInstanceForNewZone } from './internal/zones.js';
import { creatureDef, deckOf, landDef } from './test-fixtures.js';

const PLAINS = landDef('Plains', 'W');

/** Heliod's shape: an indestructible 5/5 enchantment creature for {2}{W}, a creature only at devotion 5. */
const SUN_GOD: CardDefinition = {
  id: 'sun-god',
  name: 'Test Sun God',
  types: ['enchantment', 'creature'],
  cost: { generic: 2, W: 1 },
  power: 5,
  toughness: 5,
  legendary: true,
  keywords: { indestructible: true },
  creatureUnlessDevotion: { colors: ['W'], min: 5 },
};

/** A two-colour god: devotion to red AND green, less than seven. */
const REVELS_GOD: CardDefinition = {
  id: 'revels-god',
  name: 'Test Revels God',
  types: ['enchantment', 'creature'],
  cost: { generic: 3, R: 1, G: 1 },
  power: 6,
  toughness: 5,
  creatureUnlessDevotion: { colors: ['R', 'G'], min: 7 },
};

/** {W}{W} — two white pips. */
const ACOLYTE = creatureDef('acolyte', 2, 2, { cost: { W: 2 }, name: 'Test Acolyte' });
/** {1}{W} — one. */
const SQUIRE = creatureDef('squire', 1, 1, { cost: { generic: 1, W: 1 }, name: 'Test Squire' });

function board(): GameState {
  const { state } = createGame({ seed: 3, decks: { A: deckOf(PLAINS, 40), B: deckOf(PLAINS, 40) } });
  state.battlefield = [];
  return state;
}

function place(state: GameState, def: CardDefinition, controller: PlayerId): CardInstance {
  const inst: CardInstance = {
    instanceId: state.nextInstanceId++,
    def,
    controller,
    owner: controller,
    zone: 'battlefield',
    tapped: false,
    summoningSick: false,
    damageMarked: 0,
    markedByDeathtouch: false,
    counters: {},
  };
  state.battlefield.push(inst);
  return inst;
}

describe('devotionOfCost — CR 700.5, one printed cost', () => {
  it('counts the coloured pips of the named colour and nothing else', () => {
    expect(devotionOfCost({ generic: 2, W: 1 }, ['W'])).toBe(1);
    expect(devotionOfCost({ W: 2 }, ['W'])).toBe(2);
    expect(devotionOfCost({ generic: 2, W: 1 }, ['U'])).toBe(0);
    expect(devotionOfCost({ generic: 5 }, ['W']), 'generic is not devotion').toBe(0);
    expect(devotionOfCost(undefined, ['W']), 'a land has no cost').toBe(0);
  });

  it('counts a hybrid symbol for EITHER colour, and once for the pair', () => {
    const hybrid = { hybrid: [['W', 'U']] } as const;
    expect(devotionOfCost(hybrid, ['W'])).toBe(1);
    expect(devotionOfCost(hybrid, ['U'])).toBe(1);
    expect(devotionOfCost(hybrid, ['W', 'U']), 'one symbol, one point').toBe(1);
    expect(devotionOfCost(hybrid, ['B'])).toBe(0);
    // A Phyrexian symbol is a coloured symbol (CR 107.4f).
    expect(devotionOfCost({ hybrid: [['W', { life: 2 }]] }, ['W'])).toBe(1);
    // A two-generic hybrid ({2/W}) is a white symbol too.
    expect(devotionOfCost({ hybrid: [[{ generic: 2 }, 'W']] }, ['W'])).toBe(1);
  });

  it('a pair sums both colours across a board, and a hybrid is still one', () => {
    const s = board();
    place(s, REVELS_GOD, 'A'); // {3}{R}{G} = 2 toward red-and-green
    place(s, creatureDef('bolt-bear', 2, 2, { cost: { R: 2 } }), 'A'); // 2
    place(s, creatureDef('gruul', 2, 2, { cost: { hybrid: [['R', 'G']] } }), 'A'); // 1, not 2
    place(s, creatureDef('theirs', 2, 2, { cost: { R: 3 } }), 'B'); // not yours
    expect(devotionTo(s, 'A', ['R', 'G'])).toBe(5);
    expect(devotionTo(s, 'A', ['R'])).toBe(4);
    expect(devotionTo(s, 'B', ['R'])).toBe(3);
  });
});

describe('the type layer — a god is a creature exactly while devotion reaches its number', () => {
  it('short of devotion it is NOT a creature; every reader of its def agrees', () => {
    const s = board();
    const god = place(s, SUN_GOD, 'A'); // 1 white pip
    place(s, ACOLYTE, 'A'); // +2 = 3
    expect(settleDevotionForms(s), 'the pass changed something').toBe(true);
    expect(isCreature(god.def)).toBe(false);
    expect(god.def.types).toEqual(['enchantment']);
    expect(god.def.creatureForm, 'the form remembers its base').toBe(SUN_GOD);
    expect(god.def.power, 'every other characteristic is kept').toBe(5);
    expect(god.def.keywords?.indestructible).toBe(true);
    expect(evaluateDerivedCount(s, 'creaturesYouControl', 'A'), 'the derived count sees an enchantment').toBe(1);
    expect(evaluateDerivedCount(s, 'devotionToWhite', 'A'), 'and the devotion row counts it anyway').toBe(3);
    expect(settleDevotionForms(s), 'idempotent').toBe(false);
  });

  it('at devotion five it is a creature again — the same object, its base definition', () => {
    const s = board();
    const god = place(s, SUN_GOD, 'A');
    place(s, ACOLYTE, 'A'); // 3
    settleDevotionForms(s);
    expect(isCreature(god.def)).toBe(false);
    place(s, ACOLYTE, 'A'); // 5
    expect(settleDevotionForms(s)).toBe(true);
    expect(god.def, 'the very base definition, not a copy of it').toBe(SUN_GOD);
    expect(isCreature(god.def)).toBe(true);
    // The form object is memoised: the same non-creature form every time.
    expect(nonCreatureFormOf(SUN_GOD)).toBe(nonCreatureFormOf(SUN_GOD));
  });

  it('counts the god’s OWN pips, and only its controller’s board', () => {
    const s = board();
    const god = place(s, SUN_GOD, 'A'); // 1
    place(s, ACOLYTE, 'A'); // 3
    place(s, SQUIRE, 'A'); // 4
    place(s, ACOLYTE, 'B'); // theirs — not counted
    settleDevotionForms(s);
    expect(isCreature(god.def), 'four is short').toBe(false);
    place(s, SQUIRE, 'A'); // 5
    settleDevotionForms(s);
    expect(isCreature(god.def)).toBe(true);
  });

  it('a two-colour god counts either colour, a hybrid symbol once', () => {
    const s = board();
    const god = place(s, REVELS_GOD, 'A'); // 2
    place(s, creatureDef('r', 2, 2, { cost: { R: 2 } }), 'A'); // 4
    place(s, creatureDef('g', 2, 2, { cost: { G: 2 } }), 'A'); // 6
    settleDevotionForms(s);
    expect(isCreature(god.def), 'six is short of seven').toBe(false);
    place(s, creatureDef('rg', 1, 1, { cost: { hybrid: [['R', 'G']] } }), 'A'); // 7
    settleDevotionForms(s);
    expect(isCreature(god.def)).toBe(true);
  });

  it('the zone reset restores the base form — a dead god is a creature CARD again', () => {
    const s = board();
    const god = place(s, SUN_GOD, 'A');
    settleDevotionForms(s);
    expect(isCreature(god.def)).toBe(false);
    resetInstanceForNewZone(god);
    expect(god.def).toBe(SUN_GOD);
    expect(isCreature(god.def)).toBe(true);
  });
});

describe('through the engine — the layer is settled where the board changes', () => {
  /** A's precombat main, hands emptied, mana floating. */
  function atMain(): GameState {
    const { state } = createGame({ seed: 9, startingPlayer: 'A', decks: { A: deckOf(PLAINS, 40), B: deckOf(PLAINS, 40) } });
    let s = state;
    for (let guard = 0; guard < 200 && s.step !== 'precombatMain'; guard++) {
      s = applyAction(s, { kind: 'passPriority', player: s.priorityPlayer }, DEFAULT_RULES).state;
    }
    s.players.A.hand = [];
    s.players.B.hand = [];
    s.players.A.manaPool = { W: 9, U: 9, B: 9, R: 9, G: 9, C: 9 };
    return s;
  }

  function inHand(state: GameState, def: CardDefinition, player: PlayerId): InstanceId {
    const inst: CardInstance = {
      instanceId: state.nextInstanceId++,
      def,
      controller: player,
      owner: player,
      zone: 'hand',
      tapped: false,
      summoningSick: false,
      damageMarked: 0,
      markedByDeathtouch: false,
      counters: {},
    };
    state.players[player].hand.push(inst);
    return inst.instanceId;
  }

  function resolveAll(state: GameState): GameState {
    let s = state;
    for (let guard = 0; guard < 20 && s.stack.length > 0; guard++) {
      s = applyAction(s, { kind: 'passPriority', player: s.priorityPlayer }, DEFAULT_RULES).state;
    }
    return s;
  }

  it('a god cast onto an empty board ENTERS as a non-creature, and becomes one as devotion arrives', () => {
    let s = atMain();
    const godId = inHand(s, SUN_GOD, 'A');
    s = applyAction(s, { kind: 'castSpell', player: 'A', instanceId: godId }, DEFAULT_RULES).state;
    s = resolveAll(s);
    const onBoard = () => s.battlefield.find((c) => c.instanceId === godId)!;
    expect(onBoard(), 'it resolved').toBeDefined();
    expect(isCreature(onBoard().def), 'devotion 1 — an enchantment').toBe(false);
    // Two {W}{W} creatures take white devotion to 5.
    for (let i = 0; i < 2; i++) {
      const id = inHand(s, ACOLYTE, 'A');
      s = applyAction(s, { kind: 'castSpell', player: 'A', instanceId: id }, DEFAULT_RULES).state;
      s = resolveAll(s);
    }
    expect(devotionTo(s, 'A', ['W'])).toBe(5);
    expect(isCreature(onBoard().def), 'a creature now, settled by the entry funnel').toBe(true);
    expect(onBoard().def).toBe(SUN_GOD);
  });

  it('a non-creature god is offered no attack; a creature god is', () => {
    const s = atMain();
    const god = place(s, SUN_GOD, 'A');
    god.summoningSick = false;
    settleDevotionForms(s);
    // Walk to the declare-attackers step.
    let t = s;
    for (let guard = 0; guard < 20 && t.step !== 'declareAttackers'; guard++) {
      t = applyAction(t, { kind: 'passPriority', player: t.priorityPlayer }, DEFAULT_RULES).state;
    }
    const offers = (state: GameState) =>
      generateLegalActions(state).filter((a) => a.kind === 'declareAttackers' && (a as { attackers?: readonly InstanceId[] }).attackers?.includes(god.instanceId));
    expect(offers(t), 'an enchantment cannot attack').toHaveLength(0);
  });

  it('a god that leaves comes back to hand as a creature card, and the one left behind re-settles', () => {
    const s = atMain();
    const godA = place(s, SUN_GOD, 'A');
    const godB = place(s, { ...SUN_GOD, id: 'sun-god-2', name: 'Test Sun God Two' }, 'A');
    place(s, ACOLYTE, 'A');
    place(s, SQUIRE, 'A'); // 1 + 1 + 2 + 1 = 5: both creatures
    settleDevotionForms(s);
    expect(isCreature(godA.def)).toBe(true);
    expect(isCreature(godB.def)).toBe(true);
    // Bounce one through the SBA-free zone funnel used by every removal.
    moveToZone(s, godB, 'hand', () => {}, 'A');
    expect(isCreature(godB.def), 'a creature card in hand').toBe(true);
    expect(godB.def.creatureForm).toBeUndefined();
    expect(devotionTo(s, 'A', ['W'])).toBe(4);
    expect(isCreature(godA.def), 'the god left behind lost its fifth pip and its creature-hood').toBe(false);
  });
});
