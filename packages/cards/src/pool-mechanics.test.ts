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
  defenseOf,
  effectivePower,
  generateLegalActions,
  indexContinuous,
  isLegalTarget,
  manaModesOf,
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
  // --- the second castable face: four printed layouts, one model (DESIGN §3.21) ---
  // Each predicate has to EXCLUDE its siblings, because all four hang a second
  // half off `backFace` and only the surrounding fields say which layout it is.
  {
    mechanic: 'split cards (the CR 709.4 combined object)',
    present: (c) => (c as { frontFace?: unknown }).frontFace !== undefined,
  },
  {
    mechanic: 'aftermath (the back half cast only from the graveyard)',
    present: (c) => (castZonesOf(c) ?? []).includes('graveyard'),
  },
  {
    mechanic: 'adventure (the creature earned back out of exile)',
    present: (c) => (c as { backFace?: { adventure?: boolean } }).backFace?.adventure === true,
  },
  { mechanic: 'modal double-faced cards', present: isModalDfcDefinition },
  // --- the rest of the eleven this pool run was dispatched to light up ---------
  {
    mechanic: '"as ~ enters, choose a…" (a value named on entry)',
    present: (c) => (c as { asEntersChoice?: unknown }).asEntersChoice !== undefined,
  },
  {
    mechanic: 'a mandatory additional cost (CR 601.2h)',
    present: (c) => (c as { additionalCost?: unknown }).additionalCost !== undefined,
  },
  {
    mechanic: 'a search with two DESTINATIONS',
    present: (_c, t) => /"route":\s*\[[^\]]*\},\s*\{/.test(t),
  },
  {
    mechanic: 'the mana-ability model (a printed cost, rider or restriction)',
    present: (c) => (c as { manaAbilities?: unknown }).manaAbilities !== undefined,
  },
  { mechanic: 'a mana ability with a RIDER (the pain lands)', present: (_c, t) => t.includes('"rider"') },
  { mechanic: 'battles (a Siege, with its printed defense)', present: (c) => c.types.includes('battle') },
  {
    mechanic: 'the printed intervening "if" (CR 603.4)',
    present: (_c, t) => t.includes('"intervening"'),
  },
  {
    mechanic: '"at the beginning of…" step triggers',
    present: (_c, t) => /"on":"(upkeep|drawStep|endStep|beginCombat|precombatMain|postcombatMain)"/.test(t),
  },
  {
    mechanic: 'equipment (an Equip cost that attaches)',
    present: (c) => ((c as { subtypes?: readonly string[] }).subtypes ?? []).includes('equipment'),
  },
  { mechanic: 'equipment with a TRIGGERED ability', present: isTriggeringEquipment },
  {
    mechanic: 'damage prevention (the Fog family)',
    present: (_c, t) => t.includes('"preventDamage"'),
  },
  {
    mechanic: 'replacement effects (CR 614/615 — counter and damage multipliers)',
    present: (c) => (c as { replacements?: readonly unknown[] }).replacements !== undefined,
  },
];

/** Equipment that does more than modify: it watches its host and triggers. */
function isTriggeringEquipment(card: CardDefinition): boolean {
  const c = card as { subtypes?: readonly string[]; triggers?: readonly unknown[] };
  return (c.subtypes ?? []).includes('equipment') && (c.triggers ?? []).length > 0;
}

/** The zones a card's back half may be cast from, when it names any. */
function castZonesOf(card: CardDefinition): readonly string[] | undefined {
  return (card as { backFaceCastZones?: readonly string[] }).backFaceCastZones;
}

/**
 * A modal DFC, told apart from its three sibling layouts by what it does NOT
 * carry: no `frontFace` (that is a split card's combined object), no adventure
 * flag on the back half, and no cast-zone list (an aftermath half is graveyard
 * only and a Siege's reward is cast from exile). What is left is CR 712 — two
 * faces of one card, either one played from hand for its own cost.
 */
function isModalDfcDefinition(card: CardDefinition): boolean {
  const c = card as {
    backFace?: { adventure?: boolean };
    backFaceCastable?: boolean;
    frontFace?: unknown;
  };
  return (
    c.backFaceCastable === true &&
    c.frontFace === undefined &&
    c.backFace?.adventure !== true &&
    castZonesOf(card) === undefined
  );
}

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
    why: 'every printed multikicker card spends the kick COUNT (a +1/+1 counter, a token, damage "for each time it was kicked"), and the derived-count templates for those clauses do not exist. Re-measured 2026-08-20 against every printed multikicker card: 0 of 19 compile, 12 of them blocked on the counters template alone.',
  },
  {
    mechanic: 'emblems',
    why: 'the emblem rule compiles the wrapper, but no printed emblem BODY does, and the loyalty ULTIMATE that would make the emblem is the bigger blocker. Re-measured 2026-08-20 against every printed card that makes an emblem: 0 of 90 compile, with 108 unreadable loyalty clauses across them and 77 unreadable emblem bodies.',
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
  split: 212,
  aftermath: 213,
  adventure: 214,
  modalDfc: 215,
  asEnters: 216,
  additionalCost: 217,
  multiDestination: 218,
  painLand: 219,
  battle: 220,
  interveningIf: 221,
  equipment: 222,
  equipmentTrigger: 223,
  prevention: 224,
  replacement: 225,
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

  // --- the eleven mechanics this pool run put in front of a player -------------

  it('split cards — the card in hand is BOTH halves, and each is cast for its own cost', () => {
    const { s: opened, reg } = openGame(SEEDS.split);
    let s = opened;
    const card = getByName('Assault // Battery');
    // CR 709.4: the object in every zone but the stack is the COMBINED card —
    // both names and the SUM of the two costs. Neither half's cost is the card's,
    // which is exactly why modelling a split card as its left half would have
    // silently mis-answered every "mana value 3 or less" clause in the game.
    expect(card.name).toBe('Assault // Battery');
    expect(card.cost).toEqual({ generic: 3, R: 1, G: 1 });

    const leftId = giveHand(s, 'A', card);
    s = act(s, { kind: 'castSpell', player: 'A', instanceId: leftId, targets: ['B'] }, reg);
    s = settle(s, reg);
    expect(s.players.B.life).toBe(18); // Assault, {R}: 2 damage to any target

    floodMana(s);
    const creaturesBefore = s.battlefield.filter(
      (c) => c.controller === 'A' && c.def.types.includes('creature'),
    ).length;
    const rightId = giveHand(s, 'A', card);
    s = act(s, { kind: 'castSpell', player: 'A', instanceId: rightId, face: 'back' }, reg);
    s = settle(s, reg);
    const creatures = s.battlefield.filter(
      (c) => c.controller === 'A' && c.def.types.includes('creature'),
    );
    expect(creatures).toHaveLength(creaturesBefore + 1); // Battery, {3}{G}: a 3/3
    expect(creatures.at(-1)?.def.power).toBe(3);
  });

  it('aftermath — Mind is castable ONLY from the graveyard, and exiles itself after', () => {
    const { s: opened, reg } = openGame(SEEDS.aftermath);
    let s = opened;
    const id = giveHand(s, 'A', getByName('Spring // Mind'));

    s = act(s, { kind: 'castSpell', player: 'A', instanceId: id }, reg);
    s = settle(s, reg);
    expect(s.players.A.graveyard.some((c) => c.instanceId === id)).toBe(true);

    floodMana(s);
    const offers = generateLegalActions(s, DEFAULT_RULES).filter(
      (a): a is Extract<GameAction, { kind: 'castSpell' }> =>
        a.kind === 'castSpell' && a.instanceId === id,
    );
    // The whole of aftermath: one offer, from the graveyard, of the BACK half.
    expect(offers).toHaveLength(1);
    expect(offers[0]!.fromZone).toBe('graveyard');
    expect(offers[0]!.face).toBe('back');

    const handBefore = s.players.A.hand.length;
    s = act(s, offers[0]!, reg);
    s = settle(s, reg);
    expect(s.players.A.hand.length).toBe(handBefore + 2); // Mind: draw two cards
    // "Then exile it" — an aftermath half is used once and never again.
    expect(s.players.A.exile.some((c) => c.instanceId === id)).toBe(true);
    expect(s.players.A.graveyard.some((c) => c.instanceId === id)).toBe(false);
  });

  it('adventure — the spell is cast from hand and the CREATURE comes back out of exile', () => {
    const { s: opened, reg } = openGame(SEEDS.adventure);
    let s = opened;
    const id = giveHand(s, 'A', getByName('Foulmire Knight'));

    // Profane Insight, {2}{B}: "Draw a card. You lose 1 life."
    s = act(s, { kind: 'castSpell', player: 'A', instanceId: id, face: 'back' }, reg);
    s = settle(s, reg);
    expect(s.players.A.life).toBe(19);
    // The card is EXILED rather than binned — that is what buys the second cast.
    expect(s.players.A.exile.some((c) => c.instanceId === id)).toBe(true);
    expect(s.players.A.graveyard.some((c) => c.instanceId === id)).toBe(false);

    floodMana(s);
    const offer = generateLegalActions(s, DEFAULT_RULES).find(
      (a) => a.kind === 'castSpell' && a.instanceId === id,
    );
    expect(offer, 'the creature half is not offered from exile').toBeDefined();
    s = act(s, offer!, reg);
    s = settle(s, reg);
    expect(s.battlefield.find((c) => c.instanceId === id)?.def.name).toBe('Foulmire Knight');
  });

  it('modal DFCs — a Pathway offers both faces, and the face you played is the one that taps', () => {
    const { s: opened, reg } = openGame(SEEDS.modalDfc);
    let s = opened;
    const id = giveHand(s, 'A', getByName('Barkchannel Pathway'));

    const plays = generateLegalActions(s, DEFAULT_RULES).filter(
      (a): a is Extract<GameAction, { kind: 'playLand' }> =>
        a.kind === 'playLand' && a.instanceId === id,
    );
    expect(plays.some((p) => p.face === undefined), 'front face not offered').toBe(true);
    expect(plays.some((p) => p.face === 'back'), 'back face not offered').toBe(true);

    s = act(s, { kind: 'playLand', player: 'A', instanceId: id, face: 'back' }, reg);
    s.players.A.manaPool = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
    s = act(s, { kind: 'tapForMana', player: 'A', instanceId: id }, reg);

    // Tidechannel Pathway adds {U}. The {G} the FRONT face would have made is
    // gone for good — that is the whole cost of the choice.
    expect(s.players.A.manaPool.U).toBe(1);
    expect(s.players.A.manaPool.G).toBe(0);
  });

  it('as-enters — Adaptive Automaton names a creature type, and the anthem reaches only it', () => {
    const { s: opened, reg } = openGame(SEEDS.asEnters);
    let s = opened;
    const goblinId = place(
      s,
      { id: 'gob', name: 'Goblin', types: ['creature'], subtypes: ['goblin'], power: 2, toughness: 1 },
      'A',
    );
    const bearId = place(
      s,
      { id: 'bear', name: 'Bear', types: ['creature'], subtypes: ['bear'], power: 2, toughness: 2 },
      'A',
    );
    const id = giveHand(s, 'A', getByName('Adaptive Automaton'));

    s = act(s, { kind: 'castSpell', player: 'A', instanceId: id }, reg);
    // The naming is asked DURING the resolution, before the permanent lands.
    s = settle(s, reg, [{ kind: 'chooseValue', value: 'goblin' }]);

    expect(s.battlefield.find((c) => c.instanceId === id)?.chosenAsEntered).toBe('goblin');
    const mods = indexContinuous(s);
    const powerOf = (instanceId: number): number => {
      const perm = s.battlefield.find((c) => c.instanceId === instanceId)!;
      return effectivePower(perm, mods.get(perm.instanceId));
    };
    expect(powerOf(goblinId)).toBe(3); // named
    expect(powerOf(bearId)).toBe(2); // not named — a naming nothing reads is a half-card
  });

  it('a mandatory additional cost — Village Rites is not OFFERED with an empty board', () => {
    const { s: opened, reg } = openGame(SEEDS.additionalCost);
    let s = opened;
    const id = giveHand(s, 'A', getByName('Village Rites'));
    const offered = (state: GameState): boolean =>
      generateLegalActions(state, DEFAULT_RULES).some(
        (a) => a.kind === 'castSpell' && a.instanceId === id,
      );

    // CR 601.2h: an unpayable additional cost makes the cast ILLEGAL, not
    // declinable. A spell that is offerable and un-castable is the bug this
    // shape exists to prevent.
    expect(offered(s)).toBe(false);

    const bearId = place(
      s,
      { id: 'bear', name: 'Bear', types: ['creature'], power: 2, toughness: 2 },
      'A',
    );
    expect(offered(s)).toBe(true);

    const handBefore = s.players.A.hand.length;
    s = act(s, { kind: 'castSpell', player: 'A', instanceId: id }, reg);
    s = settle(s, reg, [{ kind: 'selectCards', instanceIds: [bearId] }]);

    expect(s.battlefield.some((c) => c.instanceId === bearId)).toBe(false); // sacrificed
    expect(s.players.A.hand.length).toBe(handBefore - 1 + 2); // Rites left, two drawn
  });

  it('a search with two destinations — Cultivate puts one basic in play TAPPED and one in hand', () => {
    const { s: opened, reg } = openGame(SEEDS.multiDestination);
    let s = opened;
    const id = giveHand(s, 'A', getByName('Cultivate'));
    const landsOf = (state: GameState): number =>
      state.battlefield.filter((c) => c.controller === 'A' && c.def.types.includes('land')).length;
    const landsBefore = landsOf(s);
    const handBefore = s.players.A.hand.length;
    const picks = s.players.A.library.slice(0, 2).map((c) => c.instanceId);

    s = act(s, { kind: 'castSpell', player: 'A', instanceId: id }, reg);
    s = settle(s, reg, [{ kind: 'selectCards', instanceIds: picks }]);

    // ONE search, TWO destinations — the thing a single-destination search
    // cannot express, and the reason `route` is a list.
    expect(landsOf(s)).toBe(landsBefore + 1);
    expect(s.players.A.hand.length).toBe(handBefore - 1 + 1); // Cultivate out, a basic in
    const fetched = s.battlefield.find((c) => picks.includes(c.instanceId));
    expect(fetched?.tapped, 'the battlefield half of the search enters TAPPED').toBe(true);
    expect(s.players.A.hand.some((c) => picks.includes(c.instanceId))).toBe(true);
  });

  it('the mana-ability model — Adarkar Wastes taps free for {C}, or for a colour and 1 damage', () => {
    const wastes = getByName('Adarkar Wastes');
    const modes = manaModesOf(wastes);
    const colourless = modes.findIndex((m) => m.C === 1);
    const white = modes.findIndex((m) => m.W === 1);
    expect(colourless).toBeGreaterThanOrEqual(0);
    expect(white).toBeGreaterThanOrEqual(0);

    /** Tap the land for one mode in a fresh game, and report what it cost. */
    const tap = (mode: number): { pool: number; life: number } => {
      const { s: fresh, reg } = openGame(SEEDS.painLand);
      let s = fresh;
      const id = place(s, wastes, 'A');
      s.players.A.manaPool = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
      s = act(s, { kind: 'tapForMana', player: 'A', instanceId: id, mode }, reg);
      const pool = s.players.A.manaPool;
      return {
        pool: pool.W + pool.U + pool.B + pool.R + pool.G + pool.C,
        life: s.players.A.life,
      };
    };

    // The damage is a RIDER, not a cost: the mana still arrives, and the land is
    // usable at 1 life. Modelling it as a cost would make a pain land unusable
    // exactly when a player most wants to use it.
    expect(tap(colourless)).toEqual({ pool: 1, life: 20 });
    expect(tap(white)).toEqual({ pool: 1, life: 19 });
  });

  it('battles — a Siege enters on its PRINTED defense, and its own trigger fires', () => {
    const { s: opened, reg } = openGame(SEEDS.battle);
    let s = opened;
    const moag = getByName('Invasion of Moag');
    // The printed number comes from the card RECORD, and Scryfall keeps a
    // Siege's defense on the battle FACE — reading only the top level gave every
    // battle in the game a null defense and kept them all out of the pool.
    expect((scryfallById.get(moag.id) as { defense?: number }).defense).toBe(5);

    const bearId = place(
      s,
      { id: 'bear', name: 'Bear', types: ['creature'], power: 2, toughness: 2 },
      'A',
    );
    const id = giveHand(s, 'A', moag);
    s = act(s, { kind: 'castSpell', player: 'A', instanceId: id }, reg);
    s = settle(s, reg);

    const battle = s.battlefield.find((c) => c.instanceId === id);
    expect(battle?.def.types).toContain('battle');
    expect(defenseOf(battle!)).toBe(5);
    expect(s.battlefield.find((c) => c.instanceId === bearId)?.counters['+1/+1']).toBe(1);
  });

  it('the intervening "if" — Howling Mine gives the extra card untapped, and nothing tapped', () => {
    /** B's hand size after B's one and only draw step, with the Mine as given. */
    const handAfterOpponentsDrawStep = (tapped: boolean): number => {
      const { s: fresh, reg } = openGame(SEEDS.interveningIf);
      let s = fresh;
      const mineId = place(s, getByName('Howling Mine'), 'A');
      s.battlefield.find((c) => c.instanceId === mineId)!.tapped = tapped;
      let guard = 0;
      while (!(s.activePlayer === 'B' && s.step === 'precombatMain') && !s.gameOver && guard++ < 400) {
        s = s.pendingChoice
          ? act(s, generateLegalActions(s).find((a) => a.kind === 'answerChoice')!, reg)
          : pass(s, reg);
      }
      return s.players.B.hand.length;
    };

    // CR 603.4 checks the printed "if" as the trigger would go on the stack. A
    // tapped Mine does not trigger AT ALL — it is not a trigger that resolves
    // into nothing, and the difference is exactly one card.
    expect(handAfterOpponentsDrawStep(false)).toBe(handAfterOpponentsDrawStep(true) + 1);
  });

  it('equipment — Bonesplitter attaches for its Equip cost and the creature swings bigger', () => {
    const { s: opened, reg } = openGame(SEEDS.equipment);
    let s = opened;
    const bearId = place(
      s,
      { id: 'bear', name: 'Bear', types: ['creature'], power: 2, toughness: 2 },
      'A',
    );
    const axeId = place(s, getByName('Bonesplitter'), 'A');
    expect(effectivePower(s.battlefield.find((c) => c.instanceId === bearId)!)).toBe(2);

    s = act(
      s,
      { kind: 'activateAbility', player: 'A', instanceId: axeId, abilityIndex: 0, targets: [bearId] },
      reg,
    );
    s = settle(s, reg);

    const bear = s.battlefield.find((c) => c.instanceId === bearId)!;
    expect(effectivePower(bear, indexContinuous(s).get(bear.instanceId))).toBe(4);
    expect(s.battlefield.find((c) => c.instanceId === axeId)?.attachedTo).toBe(bearId);
  });

  // --- and the three that main's compiler unblocked while this branch was out ---

  it('equipment that TRIGGERS — Skullclamp draws two when the creature it is on dies', () => {
    const { s: opened, reg } = openGame(SEEDS.equipmentTrigger);
    let s = opened;
    // A 1/1: Skullclamp's own +1/-1 is what kills it, which is the card.
    const runtId = place(
      s,
      { id: 'runt', name: 'Runt', types: ['creature'], power: 1, toughness: 1 },
      'A',
    );
    const clampId = place(s, getByName('Skullclamp'), 'A');
    const handBefore = s.players.A.hand.length;

    s = act(
      s,
      { kind: 'activateAbility', player: 'A', instanceId: clampId, abilityIndex: 0, targets: [runtId] },
      reg,
    );
    s = settle(s, reg);

    // The equipped creature is a 2/0, dies to a state-based action, and the
    // Equipment's own trigger — watching its HOST, not itself — pays out.
    expect(s.battlefield.some((c) => c.instanceId === runtId)).toBe(false);
    expect(s.players.A.hand.length).toBe(handBefore + 2);
    // The Equipment survives its host and is unattached.
    expect(s.battlefield.find((c) => c.instanceId === clampId)?.attachedTo).toBeUndefined();
  });

  it('damage prevention — Fog makes the whole attack deal nothing, and the creatures live', () => {
    const { s: opened, reg } = openGame(SEEDS.prevention);
    let s = opened;
    const attackerId = place(
      s,
      { id: 'ogre', name: 'Ogre', types: ['creature'], power: 4, toughness: 4 },
      'A',
    );
    s.battlefield.find((c) => c.instanceId === attackerId)!.summoningSick = false;
    const fogId = giveHand(s, 'B', getByName('Fog'));

    // B casts Fog in A's main phase, before the attack — "this turn" is the
    // whole point: prevention is a shield that outlives the spell.
    s = act(s, { kind: 'passPriority', player: 'A' }, reg);
    s.players.B.manaPool = { W: 0, U: 0, B: 0, R: 0, G: 9, C: 0 };
    s = act(s, { kind: 'castSpell', player: 'B', instanceId: fogId }, reg);
    s = settle(s, reg);

    let guard = 0;
    while (s.step !== 'declareAttackers' && !s.gameOver && guard++ < 40) s = pass(s, reg);
    s = act(s, { kind: 'declareAttackers', player: 'A', attackers: [attackerId] }, reg);
    guard = 0;
    while (s.step !== 'endStep' && !s.gameOver && guard++ < 60) s = pass(s, reg);

    // 4 power got through unblocked and dealt exactly nothing.
    expect(s.players.B.life).toBe(20);
  });

  it('a replacement effect — Hardened Scales makes every +1/+1 counter land as two', () => {
    const { s: opened, reg } = openGame(SEEDS.replacement);
    let s = opened;
    const dragonDef = getByName('Sprite Dragon');
    const dragonId = giveHand(s, 'A', dragonDef);
    s = act(s, { kind: 'castSpell', player: 'A', instanceId: dragonId }, reg);
    s = settle(s, reg);

    floodMana(s);
    const scalesId = giveHand(s, 'A', getByName('Hardened Scales'));
    s = act(s, { kind: 'castSpell', player: 'A', instanceId: scalesId }, reg);
    s = settle(s, reg);
    // Casting Hardened Scales is itself a noncreature spell, so the Dragon grows
    // — but Scales was still ON THE STACK when that counter was put on, so the
    // replacement did not exist yet and exactly one counter landed.
    expect(s.battlefield.find((c) => c.instanceId === dragonId)?.counters['+1/+1']).toBe(1);

    floodMana(s);
    const boltId = giveHand(s, 'A', getByName('Lightning Bolt'));
    s = act(s, { kind: 'castSpell', player: 'A', instanceId: boltId, targets: ['B'] }, reg);
    s = settle(s, reg);

    // Now Scales IS on the battlefield: the same one-counter trigger lands as
    // two. CR 614 — the event is modified before it happens, not corrected after.
    expect(s.battlefield.find((c) => c.instanceId === dragonId)?.counters['+1/+1']).toBe(3);
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
    expect(CARD_POOL.length).toBeGreaterThanOrEqual(530);
  });
});
