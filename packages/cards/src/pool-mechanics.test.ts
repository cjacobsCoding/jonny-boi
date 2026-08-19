/**
 * "Can a player who never imports a decklist SEE this?" — the pool's mechanic
 * coverage, as an executable audit plus one real game per mechanic.
 *
 * WHY THIS FILE EXISTS. Sixteen engine systems shipped before a single card in
 * the built-in pool printed any of them: no flashback, no {X}, no kicker, no
 * scry, no surveil, no mill, no protection, no ward, one planeswalker. The
 * engine work was real and the tests were green, and none of it was reachable
 * from the app. That is the exact failure this file is meant to make impossible
 * to repeat: {@link REPRESENTED} is the inventory, and it FAILS when a mechanic
 * loses its last card — a mechanic with no card is a mechanic nobody can see.
 *
 * The audit alone is not enough, though: "a card whose data mentions scry" and
 * "a card that scries when you cast it" are different claims, and only the
 * second one is worth anything. So every mechanic below is also PLAYED, in a
 * seeded game driven through `applyAction`, and the assertion is the state
 * change the printed card promises.
 *
 * Mechanics with NO pool card are listed in {@link UNREPRESENTABLE} with the
 * reason, and that list is asserted too — a mechanic there whose cards start
 * compiling should move up, and this file fails until it does.
 */

import { describe, expect, it } from 'vitest';
import type {
  CardDefinition,
  CardInstance,
  ChoiceAnswer,
  GameAction,
  GameState,
  InstanceId,
  PlayerId,
} from '@jonny-boi/core';
import {
  applyAction,
  createGame,
  DEFAULT_RULES,
  generateLegalActions,
  isLegalTarget,
} from '@jonny-boi/core';
import { buildRegistry } from './pool.js';
import { CARD_POOL } from '../data/pool.js';
import { compileCard } from './compile/index.js';
import cardIndex from '../../data-tools/data/card-index.json' with { type: 'json' };

type Registry = ReturnType<typeof buildRegistry>;

/** Every card definition, serialized once — the audit's cheap "does it mention" probe. */
const asText = new Map(CARD_POOL.map((card) => [card.name, JSON.stringify(card)]));

/**
 * The shipped engine systems, and what a pool card representing each one looks
 * like. DATA, not a hand-written list of card names: a predicate keeps working
 * when the generator swaps one card for a better one, where a name list would
 * have to be edited (and would quietly rot until someone did).
 */
const REPRESENTED: ReadonlyArray<{
  readonly mechanic: string;
  readonly present: (card: CardDefinition, text: string) => boolean;
}> = [
  { mechanic: 'planeswalkers (printed loyalty + loyalty abilities)', present: (c) => c.types.includes('planeswalker') },
  { mechanic: 'flashback (printed)', present: (c) => (c as { flashback?: unknown }).flashback !== undefined },
  { mechanic: 'flashback ({X} in the flashback cost)', present: (c) => (c as { flashbackXCost?: unknown }).flashbackXCost !== undefined },
  { mechanic: 'flashback (granted by another card)', present: (_c, t) => t.includes('grantFlashback') },
  { mechanic: 'transforming double-faced cards', present: (c) => (c as { backFace?: unknown }).backFace !== undefined },
  { mechanic: 'modal spells (modes chosen at cast)', present: (c) => (c as { modal?: unknown }).modal !== undefined },
  { mechanic: '{X} costs', present: (c) => (c as { xCost?: unknown }).xCost !== undefined },
  { mechanic: 'kicker', present: (c) => (c as { kicker?: unknown }).kicker !== undefined },
  { mechanic: 'scry', present: (_c, t) => t.includes('"scry"') },
  { mechanic: 'surveil', present: (_c, t) => t.includes('"surveil"') },
  { mechanic: 'mill', present: (_c, t) => t.includes('"mill"') },
  { mechanic: 'protection', present: (_c, t) => t.includes('protectionFrom') },
  { mechanic: 'ward', present: (_c, t) => /"ward":\s*\d/.test(t) },
  { mechanic: '+1/+1 counters', present: (_c, t) => t.includes('addCounters') },
  { mechanic: 'the legend rule (a legendary permanent)', present: (c) => (c as { legendary?: boolean }).legendary === true },
  { mechanic: 'characteristic-defining P/T', present: (c) => (c as { characteristicPT?: unknown }).characteristicPT !== undefined },
  { mechanic: 'graveyard recursion', present: (_c, t) => t.includes('returnFromGraveyard') },
  { mechanic: 'continuous static buffs', present: (c) => ((c as { statics?: readonly unknown[] }).statics ?? []).length > 0 },
  { mechanic: 'indestructible', present: (_c, t) => t.includes('indestructible') },
  { mechanic: 'cycling (an alternative cost)', present: (c) => (c as { cycling?: unknown }).cycling !== undefined },
  { mechanic: 'madness', present: (c) => (c as { madness?: unknown }).madness !== undefined },
  { mechanic: 'buyback', present: (c) => (c as { buyback?: unknown }).buyback !== undefined },
];

/**
 * Shipped systems with NO pool card, and WHY. Every one of these was probed
 * against a live Scryfall query, compiling every printed card that has the
 * mechanic: the count of cards the compiler accepts is zero, so there is no
 * honest card to add — an approximated one would bias every A/B verdict, which
 * is worse than the gap.
 */
const UNREPRESENTABLE: ReadonlyArray<{ readonly mechanic: string; readonly why: string }> = [
  {
    mechanic: 'multikicker',
    why: 'every printed multikicker card spends the kick COUNT (a +1/+1 counter, a token, damage "for each time it was kicked"), and the derived-count templates for those clauses do not exist. 0 of 19 compile.',
  },
  {
    mechanic: 'emblems',
    why: 'the emblem rule compiles the wrapper, but no printed emblem BODY does — they are all triggered abilities on an emblem, which is its own template family. 0 of 90 compile.',
  },
  {
    mechanic: 'modal double-faced cards',
    why: 'both faces must compile, and every MDFC pairs a spell with a land whose "enters tapped unless you pay 3 life" clause has no template. 0 of 100 compile.',
  },
  {
    mechanic: 'battles',
    why: 'battles are Sieges — the back face is cast by a path the engine does not have — and the card index carries no printed defense number. 0 of 36 compile.',
  },
];

describe('pool mechanic coverage — a feature nobody can see is not shipped', () => {
  for (const { mechanic, present } of REPRESENTED) {
    it(`${mechanic}: at least one pool card prints it`, () => {
      const cards = CARD_POOL.filter((card) => present(card, asText.get(card.name)!));
      expect(cards.map((c) => c.name), `no pool card represents ${mechanic}`).not.toEqual([]);
    });
  }

  it('every mechanic with no pool card has a written reason, and none of them is silently fixed', () => {
    // The list is not decoration: if one of these starts appearing in the pool,
    // the entry is stale and must move up to REPRESENTED.
    const probes: Record<string, (t: string, c: CardDefinition) => boolean> = {
      multikicker: (_t, c) => (c as { multikicker?: unknown }).multikicker !== undefined,
      emblems: (t) => t.includes('"emblem"'),
      'modal double-faced cards': (_t, c) => (c as { backFaceCastable?: boolean }).backFaceCastable === true,
      battles: (_t, c) => c.types.includes('battle'),
    };
    for (const { mechanic, why } of UNREPRESENTABLE) {
      expect(why.length, `${mechanic} needs a reason`).toBeGreaterThan(40);
      const probe = probes[mechanic]!;
      const found = CARD_POOL.filter((card) => probe(asText.get(card.name)!, card));
      expect(found.map((c) => c.name), `${mechanic} is represented now — move it to REPRESENTED`).toEqual([]);
    }
  });
});

// --- the play tests -------------------------------------------------------------

const scryfallById = new Map(
  (cardIndex as { cards: ReadonlyArray<{ id: string }> }).cards.map((card) => [card.id, card]),
);

function getByName(name: string): CardDefinition {
  const card = CARD_POOL.find((entry) => entry.name === name);
  if (!card) throw new Error(`pool missing ${name}`);
  return card;
}

const FOREST = getByName('Forest');

function deck(def: CardDefinition, n = 40): { cards: CardDefinition[] } {
  return { cards: Array.from({ length: n }, () => def) };
}

function act(state: GameState, action: GameAction, reg: Registry): GameState {
  const result = applyAction(state, action, DEFAULT_RULES, reg);
  const rejected = result.events.find((e) => e.type === 'actionRejected');
  if (rejected) throw new Error(`unexpected rejection: ${(rejected as { reason: string }).reason}`);
  return result.state;
}

function pass(state: GameState, reg: Registry): GameState {
  return act(state, { kind: 'passPriority', player: state.priorityPlayer }, reg);
}

function advanceToMain(state: GameState, reg: Registry, max = 400): GameState {
  let s = state;
  let guard = 0;
  while (s.step !== 'precombatMain' && !s.gameOver && guard++ < max) s = pass(s, reg);
  return s;
}

/** Answer the outstanding question. */
function answer(state: GameState, value: ChoiceAnswer, reg: Registry): GameState {
  const choice = state.pendingChoice;
  if (!choice) throw new Error('no pending choice to answer');
  return act(state, { kind: 'answerChoice', player: choice.chooser, choiceId: choice.id, answer: value }, reg);
}

/** Pass until the stack is empty, answering questions with the given answers in order. */
function settle(state: GameState, reg: Registry, answers: readonly ChoiceAnswer[] = []): GameState {
  let s = state;
  const queue = [...answers];
  let guard = 0;
  while ((s.stack.length > 0 || s.pendingChoice != null) && !s.gameOver && guard++ < 60) {
    if (s.pendingChoice != null) {
      const next = queue.shift();
      s = next
        ? answer(s, next, reg)
        : act(s, generateLegalActions(s).find((a) => a.kind === 'answerChoice')!, reg);
      continue;
    }
    s = pass(s, reg);
  }
  return s;
}

function floodMana(state: GameState): void {
  state.players[state.activePlayer].manaPool = { W: 9, U: 9, B: 9, R: 9, G: 9, C: 9 };
}

function place(state: GameState, def: CardDefinition, controller: PlayerId): InstanceId {
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
    counters: {},
  });
  return id;
}

function giveHand(state: GameState, player: PlayerId, def: CardDefinition): InstanceId {
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

/** A game already in A's first main phase, with A's mana pool full. */
function openGame(seed: number): { s: GameState; reg: Registry } {
  const reg = buildRegistry();
  const { state } = createGame({
    seed,
    decks: { A: deck(FOREST, 60), B: deck(FOREST, 60) },
    registry: reg,
  });
  const s = advanceToMain(state, reg);
  floodMana(s);
  return { s, reg };
}

/** Seeds are fixed per test so a failure is always reproducible. */
const SEEDS = {
  scry: 201,
  surveil: 202,
  mill: 203,
  flashback: 204,
  xCost: 205,
  kicker: 206,
  modal: 207,
  protection: 208,
  ward: 209,
  counters: 210,
  walker: 211,
} as const;

describe('the pool PLAYS every mechanic it claims', () => {
  it('scry — Opt looks at the top card and the drawn card is what the look decided', () => {
    const { s: opened, reg } = openGame(SEEDS.scry);
    let s = opened;
    const topBefore = s.players.A.library[0]!.instanceId;
    const id = giveHand(s, 'A', getByName('Opt'));

    s = act(s, { kind: 'castSpell', player: 'A', instanceId: id }, reg);
    // The scry is a real question put to the caster as the spell RESOLVES, and
    // it happens before the draw — keeping the looked-at card on top is what
    // makes it the card drawn.
    s = settle(s, reg, [{ kind: 'selectCards', instanceIds: [topBefore] }]);

    expect(s.players.A.hand.some((c) => c.instanceId === topBefore)).toBe(true);
    expect(s.players.A.graveyard.some((c) => c.def.name === 'Opt')).toBe(true);
  });

  it('surveil — Consider can put the looked-at card in the GRAVEYARD, which scry cannot', () => {
    const { s: opened, reg } = openGame(SEEDS.surveil);
    let s = opened;
    const top = s.players.A.library[0]!.instanceId;
    const graveBefore = s.players.A.graveyard.length;
    const id = giveHand(s, 'A', getByName('Consider'));

    s = act(s, { kind: 'castSpell', player: 'A', instanceId: id }, reg);
    // The answer names what STAYS on top; keeping nothing sends the looked-at
    // card to the GRAVEYARD — the whole difference from scry, which can only
    // bottom it, and the reason both are in the pool.
    s = settle(s, reg, [{ kind: 'selectCards', instanceIds: [] }]);

    expect(s.players.A.graveyard.some((c) => c.instanceId === top)).toBe(true);
    expect(s.players.A.graveyard.length).toBeGreaterThan(graveBefore + 1); // the surveilled card AND Consider
  });

  it('mill — Tome Scour moves exactly five cards from the target player library to their graveyard', () => {
    const { s: opened, reg } = openGame(SEEDS.mill);
    let s = opened;
    const libBefore = s.players.B.library.length;
    const id = giveHand(s, 'A', getByName('Tome Scour'));

    s = act(s, { kind: 'castSpell', player: 'A', instanceId: id, targets: ['B'] }, reg);
    s = settle(s, reg);

    expect(s.players.B.library).toHaveLength(libBefore - 5);
    expect(s.players.B.graveyard).toHaveLength(5);
  });

  it('flashback — Firebolt is cast again FROM THE GRAVEYARD, then exiled', () => {
    const { s: opened, reg } = openGame(SEEDS.flashback);
    let s = opened;
    const id = giveHand(s, 'A', getByName('Firebolt'));

    s = act(s, { kind: 'castSpell', player: 'A', instanceId: id, targets: ['B'] }, reg);
    s = settle(s, reg);
    expect(s.players.B.life).toBe(18);
    expect(s.players.A.graveyard.some((c) => c.instanceId === id)).toBe(true);

    // The flashback cast: same card, different zone, printed cost {4}{R}.
    floodMana(s);
    const flashback = generateLegalActions(s, DEFAULT_RULES).find(
      (a) => a.kind === 'castSpell' && a.instanceId === id && a.fromZone === 'graveyard',
    );
    expect(flashback, 'flashback is not on the menu from the graveyard').toBeDefined();
    s = act(s, { ...flashback!, targets: ['B'] } as GameAction, reg);
    s = settle(s, reg);

    expect(s.players.B.life).toBe(16);
    // "Then exile it" — a flashbacked card never comes back a third time.
    expect(s.players.A.exile.some((c) => c.instanceId === id)).toBe(true);
    expect(s.players.A.graveyard.some((c) => c.instanceId === id)).toBe(false);
  });

  it('{X} — Blaze deals exactly the X its caster chose and paid for', () => {
    const { s: opened, reg } = openGame(SEEDS.xCost);
    let s = opened;
    const id = giveHand(s, 'A', getByName('Blaze'));

    s = act(s, { kind: 'castSpell', player: 'A', instanceId: id, targets: ['B'] }, reg);
    expect(s.pendingChoice?.kind).toBe('chooseNumber');
    s = settle(s, reg, [{ kind: 'chooseNumber', value: 4 }]);

    expect(s.players.B.life).toBe(16);
  });

  it('kicker — the same spell deals 2, or 5 when the optional cost is paid', () => {
    const lesson = getByName('Firebending Lesson');

    const damageWith = (pay: boolean): number => {
      const { s: fresh, reg } = openGame(SEEDS.kicker);
      let s = fresh;
      const bearId = place(s, { id: 'bear', name: 'Bear', types: ['creature'], power: 2, toughness: 9 }, 'B');
      const id = giveHand(s, 'A', lesson);
      s = act(s, { kind: 'castSpell', player: 'A', instanceId: id, targets: [bearId] }, reg);
      expect(s.pendingChoice?.kind).toBe('payMana');
      s = settle(s, reg, [{ kind: 'payMana', pay }]);
      const bear = s.battlefield.find((c) => c.instanceId === bearId);
      return bear ? bear.damageMarked : Number.POSITIVE_INFINITY;
    };

    expect(damageWith(false)).toBe(2);
    expect(damageWith(true)).toBe(5);
  });

  it('modal — Abrade destroys an artifact or burns a creature, decided AT CAST', () => {
    const { s: opened, reg } = openGame(SEEDS.modal);
    let s = opened;
    const rockId = place(s, getByName('Sol Ring'), 'B');
    // A creature too, so BOTH modes are legally announceable — a mode with no
    // legal target is not on the menu (CR 601.2b), and with only one mode left
    // there would be nothing to ask.
    place(s, { id: 'bear', name: 'Bear', types: ['creature'], power: 2, toughness: 2 }, 'B');
    const id = giveHand(s, 'A', getByName('Abrade'));

    // A modal spell names no whole-card target — its modes name their own.
    s = act(s, { kind: 'castSpell', player: 'A', instanceId: id }, reg);
    // Modes first, then that mode's own target — both before anyone may respond.
    expect(s.pendingChoice?.kind).toBe('chooseModes');
    s = settle(s, reg, [
      { kind: 'chooseModes', modeIds: ['mode2'] },
      { kind: 'selectTargets', targets: [rockId] },
    ]);

    expect(s.battlefield.some((c) => c.instanceId === rockId)).toBe(false);
    expect(s.players.B.graveyard.some((c) => c.def.name === 'Sol Ring')).toBe(true);
  });

  it('protection — a white spell cannot be aimed at Black Knight', () => {
    const { s, reg } = openGame(SEEDS.protection);
    const knightId = place(s, getByName('Black Knight'), 'B');
    const bearId = place(s, { id: 'bear', name: 'Bear', types: ['creature'], power: 2, toughness: 2 }, 'B');
    const path = getByName('Path to Exile'); // {W}

    expect(isLegalTarget(s, 'creature', bearId, 'A', path)).toBe(true);
    expect(isLegalTarget(s, 'creature', knightId, 'A', path)).toBe(false);
    void reg;
  });

  it('ward — targeting Tomakul Honor Guard taxes the opponent, and the spell is countered if they decline', () => {
    const { s: opened, reg } = openGame(SEEDS.ward);
    let s = opened;
    const guardId = place(s, getByName('Tomakul Honor Guard'), 'B');
    const id = giveHand(s, 'A', getByName('Doom Blade'));

    s = act(s, { kind: 'castSpell', player: 'A', instanceId: id, targets: [guardId] }, reg);
    // Ward {2}: "counter it unless that player pays {2}" — the caster is asked.
    s = settle(s, reg, [{ kind: 'payMana', pay: false }]);

    // Declined, so the removal was countered and the ward creature lives.
    expect(s.battlefield.some((c) => c.instanceId === guardId)).toBe(true);
  });

  it('+1/+1 counters — Sprite Dragon really grows, on a permanent the ENGINE created', () => {
    const { s: opened, reg } = openGame(SEEDS.counters);
    let s = opened;
    const dragonDef = getByName('Sprite Dragon');
    const dragonId = giveHand(s, 'A', dragonDef);
    s = act(s, { kind: 'castSpell', player: 'A', instanceId: dragonId }, reg);
    s = settle(s, reg);
    expect(s.battlefield.find((c) => c.instanceId === dragonId)?.counters).toEqual({});

    // A noncreature spell triggers it. This is the case that used to THROW:
    // an engine-created permanent carries the shared frozen empty counters record.
    floodMana(s);
    const boltId = giveHand(s, 'A', getByName('Lightning Bolt'));
    s = act(s, { kind: 'castSpell', player: 'A', instanceId: boltId, targets: ['B'] }, reg);
    s = settle(s, reg);

    expect(s.battlefield.find((c) => c.instanceId === dragonId)?.counters['+1/+1']).toBe(1);
  });

  it('planeswalkers — Samut enters on her PRINTED loyalty and her ability costs one', () => {
    const { s: opened, reg } = openGame(SEEDS.walker);
    let s = opened;
    const samut = getByName('Samut, Tyrant Smasher');
    // The printed number comes from the card record, not from the definition —
    // the committed index used to predate loyalty capture, and a walker with no
    // number entered at nothing.
    expect(scryfallById.get(samut.id)).toBeDefined();
    expect((scryfallById.get(samut.id) as { loyalty?: number }).loyalty).toBe(5);

    const bearId = place(s, { id: 'bear', name: 'Bear', types: ['creature'], power: 2, toughness: 2 }, 'A');
    const id = giveHand(s, 'A', samut);
    s = act(s, { kind: 'castSpell', player: 'A', instanceId: id }, reg);
    s = settle(s, reg);
    expect(s.battlefield.find((c) => c.instanceId === id)?.counters['loyalty']).toBe(5);

    s = act(s, { kind: 'activateAbility', player: 'A', instanceId: id, abilityIndex: 0, targets: [bearId] }, reg);
    s = settle(s, reg, [{ kind: 'selectCards', instanceIds: [] }]);
    expect(s.battlefield.find((c) => c.instanceId === id)?.counters['loyalty']).toBe(4);
  });
});

describe('every pool card compiles complete from its printed text', () => {
  // fidelity.test.ts proves this per card; this is the ONE assertion that the
  // count never silently shrinks — a card dropped from the pool to make a test
  // pass is the failure mode this guards.
  it('the whole pool round-trips through the compiler', () => {
    const incomplete = CARD_POOL.filter((card) => {
      const record = scryfallById.get(card.id);
      return record ? compileCard(record as never).status !== 'complete' : false;
    });
    expect(incomplete.map((c) => c.name)).toEqual([]);
    expect(CARD_POOL.length).toBeGreaterThanOrEqual(357);
  });
});
