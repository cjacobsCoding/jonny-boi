/**
 * INTERACTION MATRIX - the fourth wave: step triggers (+ the triggering player,
 * + the printed intervening "if"), SPLIT cards as CR 709.4 combined objects,
 * as-enters choices, and MANDATORY additional costs.
 *
 * These four landed days after the systems they have to compose with, and NONE
 * of them has a card in the shipped pool - so every cell here builds a real
 * printed RECORD and puts it through the real compiler (`compiled()`), which is
 * the same bar the pool cards meet. Authoring a `CardDefinition` directly would
 * be authoring the answer.
 *
 * The cells this file exists for, in order of how badly they would hide:
 *
 *  - **A split card is ONE object with the SUM of both costs and the UNION of
 *    both type lines (CR 709.4).** Every filter in the engine - a discard's
 *    "mana value 3 or less", a tutor, an anthem, Tarmogoyf's card-type count -
 *    reads a `CardDefinition`, so a split card is legitimately two types at once
 *    and costs more than either half. No filter was written with that in mind.
 *  - **A mandatory additional cost is PAID AS THE SPELL IS CAST**, so it changes
 *    the board the spell then resolves against: revolt turns on, a graveyard
 *    gains a card type, and a star box grows - all while the spell that caused
 *    it is still on the stack and nobody has resolved anything.
 *  - **An as-enters choice is instance memory (CR 400.7)**, so it must survive a
 *    transform (not a zone change) and must NOT survive a bounce.
 *  - **An intervening "if" is checked TWICE (CR 603.4)**, and the second check -
 *    the one at resolution - is the half an implementation forgets.
 */

import { describe, expect, it } from 'vitest';
import {
  chosenSubtypeOf,
  effectivePower,
  effectiveToughness,
  indexContinuous,
  interveningIfHolds,
  isSplitCard,
  matchesCardFilter,
  NO_MOD,
  transformPermanent,
  triggeringPlayerFor,
  turnFactHolds,
  type CardDefinition,
  type GameAction,
  type GameState,
  type InstanceId,
} from '@jonny-boi/core';
import { buildRegistry } from '../pool.js';
import {
  act,
  boardAtMain,
  castCard,
  compiled,
  faceRecord,
  fund,
  isOnBattlefield,
  legal,
  onBattlefield,
  place,
  poolCard,
  record,
  rejectionOf,
  resolvePermanent,
  settle,
  type Registry,
} from './harness.js';

const BEAR: CardDefinition = {
  id: 'matrix-new-bear',
  name: 'Matrix New Bear',
  types: ['creature'],
  cost: { generic: 2 },
  power: 2,
  toughness: 2,
};

const GOBLIN: CardDefinition = { ...BEAR, id: 'matrix-goblin', name: 'Matrix Goblin', subtypes: ['goblin'] };
const ELF: CardDefinition = { ...BEAR, id: 'matrix-elf', name: 'Matrix Elf', subtypes: ['elf'] };

/** {1}{R} + {W} = a mana-value-3 object that is BOTH an instant and a sorcery. */
const WEAR_TEAR = compiled(
  record({
    name: 'Wear // Tear',
    layout: 'split',
    typeLine: { supertypes: [], types: ['Instant'], subtypes: [] },
    faces: [
      faceRecord({
        name: 'Wear',
        manaCost: { generic: 1, W: 0, U: 0, B: 0, R: 1, G: 0, C: 0, other: [] },
        oracleText: 'Destroy target artifact.',
      }),
      faceRecord({
        name: 'Tear',
        manaCost: { generic: 0, W: 1, U: 0, B: 0, R: 0, G: 0, C: 0, other: [] },
        typeLine: { supertypes: [], types: ['Sorcery'], subtypes: [] },
        oracleText: 'Draw a card.',
      }),
    ],
  }),
);

/** "As an additional cost to cast this spell, sacrifice a creature." */
const VILLAGE_RITES = compiled(
  record({
    name: 'Village Rites',
    manaCost: { generic: 0, W: 0, U: 0, B: 1, R: 0, G: 0, C: 0, other: [] },
    oracleText: 'As an additional cost to cast this spell, sacrifice a creature.\nDraw two cards.',
  }),
);

/** A lord that NAMES a creature type as it enters and buffs that type. */
const ADAPTIVE_AUTOMATON = compiled(
  record({
    name: 'Adaptive Automaton',
    manaCost: { generic: 3, W: 0, U: 0, B: 0, R: 0, G: 0, C: 0, other: [] },
    typeLine: { supertypes: [], types: ['Artifact', 'Creature'], subtypes: ['Construct'] },
    power: 2,
    toughness: 2,
    oracleText:
      'As this creature enters, choose a creature type.\nThis creature is the chosen type in addition to its other types.\nOther creatures you control of the chosen type get +1/+1.',
  }),
);

/** "At the beginning of each player's draw step, that player draws an additional card." */
const HOWLING_MINE = compiled(
  record({
    name: 'Matrix Howling Mine',
    manaCost: { generic: 2, W: 0, U: 0, B: 0, R: 0, G: 0, C: 0, other: [] },
    typeLine: { supertypes: [], types: ['Artifact'], subtypes: [] },
    oracleText: "At the beginning of each player's draw step, that player draws an additional card.",
  }),
);

function statsOf(state: GameState, id: InstanceId): { power: number; toughness: number } {
  const inst = onBattlefield(state, id);
  const mod = indexContinuous(state).get(id) ?? NO_MOD;
  return { power: effectivePower(inst, mod), toughness: effectiveToughness(inst, mod) };
}

// --- SPLIT CARDS x everything that reads a CardDefinition -------------------------

describe('CELL: split cards x card filters (CR 709.4 combined object)', () => {
  it('is BOTH type lines and the SUM of both costs, so every filter sees one three-mana object', () => {
    expect(isSplitCard(WEAR_TEAR)).toBe(true);
    expect([...WEAR_TEAR.types].sort()).toEqual(['instant', 'sorcery']);
    expect(WEAR_TEAR.cost).toEqual({ generic: 1, R: 1, W: 1 });

    const state = boardAtMain(buildRegistry());
    const id = place(state, 'A', 'hand', WEAR_TEAR);
    const card = state.players.A.hand.find((c) => c.instanceId === id)!;

    // A filter naming EITHER half's type matches - one card, two types at once.
    expect(matchesCardFilter(card, { anyOfTypes: ['instant'] })).toBe(true);
    expect(matchesCardFilter(card, { anyOfTypes: ['sorcery'] })).toBe(true);
    // And its mana value is the COMBINED 3, not the {1}{R} half a caster pays.
    expect(matchesCardFilter(card, { maxManaValue: 3 })).toBe(true);
    expect(matchesCardFilter(card, { maxManaValue: 2 })).toBe(false);
  });

  it('a split card in a graveyard feeds BOTH its card types to a star box', () => {
    const reg = buildRegistry();
    let state = boardAtMain(reg);
    // The graveyard holds ONE card, and it is worth TWO card types.
    place(state, 'A', 'graveyard', WEAR_TEAR);
    const goyf = resolvePermanent(state, reg, poolCard('Tarmogoyf'), 'A');
    state = goyf.state;
    expect(statsOf(state, goyf.id)).toEqual({ power: 2, toughness: 3 });

    // The control: one ORDINARY instant in the same slot is worth one type.
    let plain = boardAtMain(reg);
    place(plain, 'A', 'graveyard', poolCard('Lightning Bolt'));
    const solo = resolvePermanent(plain, reg, poolCard('Tarmogoyf'), 'A');
    plain = solo.state;
    expect(statsOf(plain, solo.id)).toEqual({ power: 1, toughness: 2 });
  });

  it('both halves are offered as REAL casts - the flag a transforming DFC does not set', () => {
    const reg = buildRegistry();
    const state = boardAtMain(reg);
    const id = place(state, 'A', 'hand', WEAR_TEAR);
    fund(state, 'A');

    const offers = legal(state).filter(
      (a): a is Extract<GameAction, { kind: 'castSpell' }> => a.kind === 'castSpell' && a.instanceId === id,
    );
    const faces = new Set(offers.map((o) => o.face ?? 'front'));
    // The sorcery half needs a sorcery-speed window and this is one, so BOTH
    // halves are on the menu.
    expect(faces.has('back')).toBe(true);
    expect(WEAR_TEAR.backFaceCastable).toBe(true);
    // A transforming DFC's back face is never castable (CR 712.8b) - the same
    // engine, the same shape, exactly one flag apart.
    expect(poolCard('Delver of Secrets').backFaceCastable).not.toBe(true);
  });
});

// --- MANDATORY ADDITIONAL COSTS x legality, turn facts, and the star box ----------

describe('CELL: mandatory additional costs x cast legality (CR 601.2h)', () => {
  it('an unpayable cost makes the spell neither offered NOR accepted', () => {
    const reg = buildRegistry();
    const state = boardAtMain(reg);
    const rites = place(state, 'A', 'hand', VILLAGE_RITES);
    fund(state, 'A');

    // Empty board: nothing to sacrifice.
    expect(legal(state).some((a) => a.kind === 'castSpell' && a.instanceId === rites)).toBe(false);
    // The menu is only half of it - a hand-built action must be refused too.
    expect(rejectionOf(state, { kind: 'castSpell', player: 'A', instanceId: rites }, reg)).toBeDefined();
    // ...and the attempt drew nothing: the card is still in hand.
    expect(state.players.A.hand.map((c) => c.instanceId)).toContain(rites);
  });
});

describe('CELL: mandatory additional costs x turn facts x characteristic-defining P/T', () => {
  it('paying the sacrifice turns REVOLT on and grows a star box while the spell is still on the stack', () => {
    const reg = buildRegistry();
    let state = boardAtMain(reg);
    // One instant in the graveyard, so the Goyf starts at 1/2.
    place(state, 'A', 'graveyard', poolCard('Lightning Bolt'));
    const goyf = resolvePermanent(state, reg, poolCard('Tarmogoyf'), 'A');
    state = goyf.state;
    const fodder = resolvePermanent(state, reg, BEAR, 'A');
    state = fodder.state;
    expect(statsOf(state, goyf.id)).toEqual({ power: 1, toughness: 2 });
    expect(turnFactHolds(state, 'permanentLeftBattlefield', 'A')).toBe(false);

    const rites = place(state, 'A', 'hand', VILLAGE_RITES);
    fund(state, 'A');
    state.priorityPlayer = 'A';
    state = act(state, { kind: 'castSpell', player: 'A', instanceId: rites }, reg);
    state = answerEverySelection(state, reg, fodder.id);

    // The cost is paid AS THE SPELL IS CAST, so every one of these is true while
    // the spell is still on the stack and nothing has resolved:
    expect(state.stack.some((o) => o.instanceId === rites)).toBe(true);
    expect(isOnBattlefield(state, fodder.id)).toBe(false);
    // ...a permanent left the battlefield under A's control, so revolt is ON;
    expect(turnFactHolds(state, 'permanentLeftBattlefield', 'A')).toBe(true);
    // ...and the creature card it became grew the star box by a whole card type.
    expect(statsOf(state, goyf.id)).toEqual({ power: 2, toughness: 3 });
  });

  it('the sacrifice takes an INDESTRUCTIBLE creature, because sacrifice is not destruction', () => {
    const reg = buildRegistry();
    let state = boardAtMain(reg);
    const zetalpa = resolvePermanent(state, reg, poolCard('Zetalpa, Primal Dawn'), 'A');
    state = zetalpa.state;

    const rites = place(state, 'A', 'hand', VILLAGE_RITES);
    fund(state, 'A');
    state.priorityPlayer = 'A';
    // The only creature on the board is indestructible and the spell is STILL
    // offered: CR 702.12b exempts DESTRUCTION, and this is a cost.
    expect(legal(state).some((a) => a.kind === 'castSpell' && a.instanceId === rites)).toBe(true);
    state = act(state, { kind: 'castSpell', player: 'A', instanceId: rites }, reg);
    state = answerEverySelection(state, reg, zetalpa.id);
    expect(isOnBattlefield(state, zetalpa.id)).toBe(false);
  });
});

// --- AS-ENTERS CHOICES x statics, transform, and zone changes ---------------------

describe('CELL: as-enters choices x statics x transform x zone changes (CR 400.7)', () => {
  it('the named type is what the lord own anthem reads, and only that type is buffed', () => {
    const reg = buildRegistry();
    let state = boardAtMain(reg);
    const g = resolvePermanent(state, reg, GOBLIN, 'A');
    state = g.state;
    const e = resolvePermanent(state, reg, ELF, 'A');
    state = e.state;

    const lord = castCard(state, reg, ADAPTIVE_AUTOMATON, 'A');
    state = lord.state;
    expect(state.pendingChoice?.kind).toBe('chooseValue');
    state = answerChosenValue(state, reg, 'goblin');
    state = settle(state, reg);

    // The static's filter reads the value the permanent NAMED, so the Goblin is
    // buffed and the Elf is not - a static reading printed data would buff neither.
    expect(chosenSubtypeOf(onBattlefield(state, lord.id))).toBe('goblin');
    expect(statsOf(state, g.id)).toEqual({ power: 3, toughness: 3 });
    expect(statsOf(state, e.id)).toEqual({ power: 2, toughness: 2 });
  });

  it('a transform KEEPS the choice (not a zone change) and a bounce CLEARS it (CR 400.7)', () => {
    const reg = buildRegistry();
    let state = boardAtMain(reg);
    const g = resolvePermanent(state, reg, GOBLIN, 'A');
    state = g.state;
    // An Elf as well: with only ONE creature type on the board the menu has a
    // single option, the engine answers it itself, and nothing ever parks.
    const e = resolvePermanent(state, reg, ELF, 'A');
    state = e.state;
    const lord = castCard(state, reg, ADAPTIVE_AUTOMATON, 'A');
    state = lord.state;
    state = answerChosenValue(state, reg, 'goblin');
    state = settle(state, reg);
    expect(chosenSubtypeOf(onBattlefield(state, lord.id))).toBe('goblin');

    // Transforming is not a zone change, so the memory must survive it. The lord
    // has no back face, so `transformPermanent` changes no face here - the claim
    // is that it does not wipe instance memory on its way through.
    transformPermanent(state, lord.id, () => {});
    expect(chosenSubtypeOf(onBattlefield(state, lord.id))).toBe('goblin');
    expect(statsOf(state, g.id)).toEqual({ power: 3, toughness: 3 });

    // A BOUNCE is a zone change, and CR 400.7 makes the returning card a NEW
    // object that remembers nothing it once named.
    state = castCard(state, reg, poolCard('Capsize'), 'A', [lord.id]).state;
    state = declineEveryPayment(state, reg);
    const returned = state.players.A.hand.find((c) => c.instanceId === lord.id);
    expect(returned, 'the lord should have been bounced to hand').toBeDefined();
    expect(chosenSubtypeOf(returned!)).toBeUndefined();
    // ...and the anthem went with it.
    expect(statsOf(state, g.id)).toEqual({ power: 2, toughness: 2 });
  });
});

describe('CELL: zone changes x attachments x planeswalkers (the two rival reset funnels)', () => {
  /**
   * There are TWO ways a permanent leaves the battlefield in this engine: core's
   * `moveToZone` + `resetInstanceForNewZone`, and the cards package's
   * `movePermanentTo` (every bounce, every "put into its owner graveyard"
   * primitive). The second used to hand-copy the reset list and had drifted from
   * the first by three fields - so which funnel bounced a permanent decided what
   * it remembered. These are the two survivors nobody had a test for.
   */

  it('a BOUNCED Equipment comes back attached to nothing (CR 400.7)', () => {
    const reg = buildRegistry();
    let state = boardAtMain(reg);
    const bear = resolvePermanent(state, reg, BEAR, 'A');
    state = bear.state;
    const splitter = resolvePermanent(state, reg, poolCard('Bonesplitter'), 'A');
    state = splitter.state;

    fund(state, 'A');
    const equip = legal(state).find(
      (a) => a.kind === 'activateAbility' && a.instanceId === splitter.id && a.targets?.[0] === bear.id,
    );
    state = settle(act(state, equip!, reg), reg);
    expect(onBattlefield(state, splitter.id).attachedTo).toBe(bear.id);
    expect(statsOf(state, bear.id)).toEqual({ power: 4, toughness: 2 });

    // Capsize the Equipment. It must return to hand pointing at NOTHING - a
    // stale host id is how a re-cast Aura arrives already enchanting something.
    state = castCard(state, reg, poolCard('Capsize'), 'A', [splitter.id]).state;
    state = declineEveryPayment(state, reg);
    const returned = state.players.A.hand.find((c) => c.instanceId === splitter.id);
    expect(returned, 'the Equipment should be in hand').toBeDefined();
    expect(returned!.attachedTo).toBeNull();
    expect(statsOf(state, bear.id)).toEqual({ power: 2, toughness: 2 });
  });

  it('a BOUNCED planeswalker may activate again the turn it is replayed (CR 400.7)', () => {
    const reg = buildRegistry();
    let state = boardAtMain(reg);
    const lili = resolvePermanent(state, reg, poolCard('Liliana of the Veil'), 'A');
    state = lili.state;

    // Use her once - the once-per-turn marker goes on the INSTANCE.
    state = act(state, { kind: 'activateAbility', player: 'A', instanceId: lili.id, abilityIndex: 0 }, reg);
    state = answerEverySelection(state, reg, -1);
    state = settle(state, reg);
    state = answerEverySelection(state, reg, -1);
    state = settle(state, reg);
    expect(onBattlefield(state, lili.id).loyaltyActivatedTurn).toBeDefined();

    // Bounce her and replay her: a NEW object, so the marker must not follow.
    state = castCard(state, reg, poolCard('Capsize'), 'A', [lili.id]).state;
    state = declineEveryPayment(state, reg);
    const returned = state.players.A.hand.find((c) => c.instanceId === lili.id);
    expect(returned, 'Liliana should be in hand').toBeDefined();
    expect(returned!.loyaltyActivatedTurn).toBeUndefined();
    // ...and her loyalty counters went too, so she re-enters on her printed 3.
    expect(returned!.counters.loyalty ?? 0).toBe(0);
  });
});

// --- STEP TRIGGERS x the triggering player x the intervening "if" -----------------

describe('CELL: step triggers x the triggering player (CR 603.2c)', () => {
  it("each player's draw step fires the SAME trigger for a DIFFERENT player, and the body follows it", () => {
    const reg = buildRegistry();
    let state = boardAtMain(reg, { active: 'A' });
    const mine = resolvePermanent(state, reg, HOWLING_MINE, 'A');
    state = mine.state;

    // The trigger is one ability watching BOTH seats' draw steps.
    const trigger = onBattlefield(state, mine.id).def.triggers?.[0];
    expect(trigger?.condition.who).toBe('any');

    // Play round to B's draw step: the artifact is A's, but the extra card is B's.
    const before = { A: state.players.A.hand.length, B: state.players.B.hand.length };
    state = passUntilDrawStepOf(state, reg, 'B');
    state = settle(state, reg);
    expect(state.players.B.hand.length - before.B).toBeGreaterThanOrEqual(2);
    // A drew nothing from it in B's step - which is the whole point of the
    // triggering player riding the resolution instead of the source's controller.
    expect(state.players.A.hand.length).toBe(before.A);
  });

  it('the triggering player is read off the EVENT, so "that player" can be the non-controller', () => {
    // The pure seam behind the game above, asked directly. A step trigger's
    // referent is whose step it IS - which is the only place the other seat
    // survives, since a `who: 'any'` ability still resolves under its own
    // controller.
    const inBsStep = { type: 'stepBegin', step: 'draw', activePlayer: 'B' } as const;
    expect(triggeringPlayerFor({ on: 'drawStep', who: 'any' }, inBsStep)).toBe('B');
    const inAsStep = { type: 'stepBegin', step: 'draw', activePlayer: 'A' } as const;
    expect(triggeringPlayerFor({ on: 'drawStep', who: 'any' }, inAsStep)).toBe('A');
    // An event that is about a permanent, not a player, has no referent at all -
    // reported as undefined rather than defaulted to the controller.
    const died = { type: 'creatureDied', instanceId: 1, name: 'x' } as const;
    expect(triggeringPlayerFor({ on: 'permanentDies', who: 'any' }, died)).toBeUndefined();
  });
});

describe('CELL: step triggers x the intervening "if" (CR 603.4)', () => {
  it('ONE evaluator answers both of CR 603.4 moments, and it reads the CONTROLLER board', () => {
    const reg = buildRegistry();
    let state = boardAtMain(reg);
    const mine = resolvePermanent(state, reg, HOWLING_MINE, 'A');
    state = mine.state;

    // "if you control a creature" over a board with none, then one. The same
    // call is what the trigger collector asks and what the resolution asks -
    // which is the point: two evaluators could disagree, and the second check is
    // the half an implementation forgets.
    const ifCreature = {
      kind: 'controlCount',
      who: 'you',
      filter: { anyOfTypes: ['creature'] },
      min: 1,
    } as const;
    expect(interveningIfHolds(state, ifCreature, mine.id, 'A')).toBe(false);

    const bear = resolvePermanent(state, reg, BEAR, 'A');
    state = bear.state;
    expect(interveningIfHolds(state, ifCreature, mine.id, 'A')).toBe(true);
    // ...and it is the named player's board that is counted, not the game's.
    expect(interveningIfHolds(state, ifCreature, mine.id, 'B')).toBe(false);

    // "if this artifact is untapped" is FALSE once the source has left the
    // battlefield - vacuous truth there would keep a destroyed Howling Mine
    // drawing cards.
    const ifUntapped = { kind: 'sourceUntapped' } as const;
    expect(interveningIfHolds(state, ifUntapped, mine.id, 'A')).toBe(true);
    onBattlefield(state, mine.id).tapped = true;
    expect(interveningIfHolds(state, ifUntapped, mine.id, 'A')).toBe(false);
    expect(interveningIfHolds(state, ifUntapped, 999999, 'A')).toBe(false);

    // An absent condition holds, which is what every ordinary trigger means.
    expect(interveningIfHolds(state, undefined, mine.id, 'A')).toBe(true);
  });
});

// --- shared drivers ---------------------------------------------------------------

/** Answer a parked selectCards question, preferring `wanted` when offered. */
function answerEverySelection(state: GameState, reg: Registry, wanted: InstanceId): GameState {
  let next = state;
  for (let i = 0; i < 6 && next.pendingChoice; i++) {
    const choice = next.pendingChoice;
    if (choice.kind !== 'selectCards') break;
    const ids = choice.candidates.map((c) => c.instanceId);
    const pick = ids.includes(wanted) ? wanted : ids[0];
    if (pick === undefined) break;
    next = act(
      next,
      {
        kind: 'answerChoice',
        player: choice.chooser,
        choiceId: choice.id,
        answer: { kind: 'selectCards', instanceIds: [pick] },
      },
      reg,
    );
  }
  return next;
}

/** Answer the parked as-enters question by NAMING `value`. */
function answerChosenValue(state: GameState, reg: Registry, value: string): GameState {
  const choice = state.pendingChoice;
  if (!choice) throw new Error('no as-enters question is parked');
  if (choice.kind !== 'chooseValue') throw new Error(`as-enters asked a ${choice.kind}, not a named value`);
  return act(
    state,
    { kind: 'answerChoice', player: choice.chooser, choiceId: choice.id, answer: { kind: 'chooseValue', value } },
    reg,
  );
}

/** Decline every parked optional payment (a buyback question, a ward tax). */
function declineEveryPayment(state: GameState, reg: Registry): GameState {
  let next = state;
  for (let i = 0; i < 4 && next.pendingChoice?.kind === 'payMana'; i++) {
    const choice = next.pendingChoice;
    next = act(
      next,
      { kind: 'answerChoice', player: choice.chooser, choiceId: choice.id, answer: { kind: 'payMana', pay: false } },
      reg,
    );
  }
  return settle(next, reg);
}

/** How many priority passes a full round of the turn machine can need. */
const ROUND_TRIP_PASS_LIMIT = 200;

/** Advance until `player` is the active player in their own draw step. */
function passUntilDrawStepOf(state: GameState, reg: Registry, player: 'A' | 'B'): GameState {
  let next = state;
  for (let i = 0; i < ROUND_TRIP_PASS_LIMIT; i++) {
    if (next.gameOver) throw new Error('the game ended before the draw step arrived');
    if (next.pendingChoice) throw new Error('a choice parked while advancing to the draw step');
    if (next.activePlayer === player && next.step === 'draw') return next;
    next = act(next, { kind: 'passPriority', player: next.priorityPlayer }, reg);
  }
  throw new Error('never reached the draw step');
}
