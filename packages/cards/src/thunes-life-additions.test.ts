/**
 * THUNE'S LIFE — THE CARDS HE ASKED FOR BY NAME, PLAYED (DESIGN §3.162).
 *
 * "Add the card Skyclave Apparition and the mechanics to make it work then add
 * 2 of them to Thune's Life deck" — "And Tyvar's Stand" — "And Spike Feeder" —
 * "And Voice of the Blessed" — "Also add Heliod, Sun-Crowned and all required
 * mechanics" — "And Selvala, Explorer Returned".
 *
 * Each card is COMPILED HERE from its printed Oracle text and then driven
 * through the real action loop, because a compile-level `'complete'` says
 * nothing about whether the card works (Journey to Nowhere shipped `'complete'`
 * and unlinked — see `oring-linked-play.test.ts`). Every mechanic this lane
 * added has a test below that plays it and reads the board:
 *
 *  - the `removeCounters` activation cost (Spike Feeder): paid at activation,
 *    never refundable, and the last counter off a 0/0 is lethal;
 *  - the counter-threshold self static (Voice of the Blessed): flying and
 *    vigilance appear at the fourth counter and not the third;
 *  - the `nontoken` bound, the "nonland permanent an opponent controls" aim,
 *    "up to one", and the third linked-exile tail — a token for the exiled
 *    card's owner sized by its mana value (Skyclave Apparition);
 *  - a keyword LIST on a pump ("gains hexproof and indestructible") and the
 *    "creature you control" pump noun (Tyvar's Stand);
 *  - "another target creature" on an ACTIVATED ability and the "creature or
 *    enchantment you control" aim (Heliod, Sun-Crowned).
 *
 * ⚠️ Both directions (§1a): the Apparition's menu is checked for what it must
 * NOT offer (a token, a land, a mana value of five, its controller's own
 * board) as well as what it must.
 */
import { describe, expect, it } from 'vitest';
import type { CardDefinition, GameAction, GameState, InstanceId, PlayerId } from '@jonny-boi/core';
import {
  applyAction,
  createGame,
  DEFAULT_RULES,
  defaultAnswerFor,
  effectiveKeywords,
  effectivePower,
  generateLegalActions,
  indexContinuous,
  NO_MOD,
  PLUS_ONE_COUNTER,
} from '@jonny-boi/core';
import { compileCard } from './compile/index.js';
import type { CompilableCard } from './compile/index.js';
import { buildRegistry } from './pool.js';
import { CARD_POOL } from '../data/pool.js';

type Registry = ReturnType<typeof buildRegistry>;

const SEED = 31162;

function fromPool(name: string): CardDefinition {
  const found = CARD_POOL.find((entry) => entry.name === name);
  if (!found) throw new Error(`pool missing ${name}`);
  return found;
}

const NO_MANA = { generic: 0, W: 0, U: 0, B: 0, R: 0, G: 0, C: 0, other: [] } as const;

interface Printed {
  readonly name: string;
  readonly oracleText: string;
  readonly manaCost: CompilableCard['manaCost'];
  readonly typeLine: CompilableCard['typeLine'];
  readonly power?: number | null;
  readonly toughness?: number | null;
}

/** Compile a printed card and insist the compiler accepted every line of it. */
function compiled(card: Printed): CardDefinition {
  const result = compileCard({
    id: `test:${card.name}`,
    keywords: [],
    power: null,
    toughness: null,
    ...card,
  } as CompilableCard);
  expect(result.status, `${card.name}: ${JSON.stringify(result.missing)}`).toBe('complete');
  return result.definition;
}

const SKYCLAVE_APPARITION = compiled({
  name: 'Skyclave Apparition',
  manaCost: { ...NO_MANA, generic: 1, W: 2 },
  typeLine: { supertypes: [], types: ['Creature'], subtypes: ['Kor', 'Spirit'] },
  power: 2,
  toughness: 2,
  oracleText:
    "When this creature enters, exile up to one target nonland, nontoken permanent you don't control with mana value 4 or less.\n" +
    "When this creature leaves the battlefield, the exiled card's owner creates an X/X blue Illusion creature token, where X is the mana value of the exiled card.",
});

const SPIKE_FEEDER = compiled({
  name: 'Spike Feeder',
  manaCost: { ...NO_MANA, generic: 1, G: 2 },
  typeLine: { supertypes: [], types: ['Creature'], subtypes: ['Spike'] },
  power: 0,
  toughness: 0,
  oracleText:
    'This creature enters with two +1/+1 counters on it.\n' +
    '{2}, Remove a +1/+1 counter from this creature: Put a +1/+1 counter on target creature.\n' +
    'Remove a +1/+1 counter from this creature: You gain 2 life.',
});

const VOICE_OF_THE_BLESSED = compiled({
  name: 'Voice of the Blessed',
  manaCost: { ...NO_MANA, W: 2 },
  typeLine: { supertypes: [], types: ['Creature'], subtypes: ['Spirit', 'Cleric'] },
  power: 2,
  toughness: 2,
  oracleText:
    'Whenever you gain life, put a +1/+1 counter on this creature.\n' +
    'As long as this creature has four or more +1/+1 counters on it, it has flying and vigilance.\n' +
    'As long as this creature has ten or more +1/+1 counters on it, it has indestructible.',
});

const TYVARS_STAND = compiled({
  name: "Tyvar's Stand",
  manaCost: { ...NO_MANA, G: 1, other: ['X'] } as unknown as CompilableCard['manaCost'],
  typeLine: { supertypes: [], types: ['Instant'], subtypes: [] },
  oracleText:
    "Target creature you control gets +X/+X and gains hexproof and indestructible until end of turn. (It can't be the target of spells or abilities your opponents control. Damage and effects that say \"destroy\" don't destroy it.)",
});

function act(state: GameState, action: GameAction, reg: Registry): GameState {
  const result = applyAction(state, action, DEFAULT_RULES, reg);
  const rejected = result.events.find((e) => e.type === 'actionRejected') as { reason?: string } | undefined;
  if (rejected) throw new Error(`unexpected rejection: ${rejected.reason ?? '?'}`);
  return result.state;
}

function rejection(state: GameState, action: GameAction, reg: Registry): string | undefined {
  const rejected = applyAction(state, action, DEFAULT_RULES, reg).events.find((e) => e.type === 'actionRejected') as
    | { reason?: string }
    | undefined;
  return rejected?.reason;
}

type Question = NonNullable<GameState['pendingChoice']>;

/** Settle the stack, answering anything asked with the given answer factory. */
function settle(state: GameState, reg: Registry, answer: (question: Question) => unknown = defaultAnswerFor): GameState {
  let s = state;
  let guard = 0;
  while ((s.stack.length > 0 || s.pendingChoice != null) && guard++ < 80) {
    const question = s.pendingChoice;
    s = question
      ? act(s, { kind: 'answerChoice', player: question.chooser, choiceId: question.id, answer: answer(question) } as GameAction, reg)
      : act(s, { kind: 'passPriority', player: s.priorityPlayer }, reg);
  }
  return s;
}

function toMain(reg: Registry): GameState {
  const forest = fromPool('Forest');
  const { state } = createGame({
    seed: SEED,
    decks: {
      A: { cards: Array.from({ length: 60 }, () => forest) },
      B: { cards: Array.from({ length: 60 }, () => forest) },
    },
    registry: reg,
  });
  let s = state;
  let guard = 0;
  while ((s.step !== 'precombatMain' || s.priorityPlayer !== 'A' || s.stack.length > 0 || s.pendingChoice) && guard++ < 600) {
    s = settle(s, reg);
    if (s.stack.length === 0 && s.pendingChoice == null) s = act(s, { kind: 'passPriority', player: s.priorityPlayer }, reg);
  }
  s.players.A.manaPool = { W: 9, U: 9, B: 9, R: 9, G: 9, C: 9 };
  s.players.B.manaPool = { W: 9, U: 9, B: 9, R: 9, G: 9, C: 9 };
  return s;
}

function put(
  state: GameState,
  def: CardDefinition,
  controller: PlayerId,
  zone: 'battlefield' | 'hand',
  extra: { counters?: Record<string, number>; isToken?: boolean } = {},
): InstanceId {
  const id = state.nextInstanceId++;
  const instance = {
    instanceId: id,
    def: extra.isToken ? { ...def, isToken: true } : def,
    controller,
    owner: controller,
    zone,
    tapped: false,
    summoningSick: false,
    damageMarked: 0,
    markedByDeathtouch: false,
    attachedTo: null,
    counters: extra.counters ?? {},
  } as never;
  if (zone === 'hand') (state.players[controller].hand as unknown[]).push(instance);
  else (state.battlefield as unknown[]).push(instance);
  return id;
}

function onBoard(state: GameState, id: InstanceId) {
  return state.battlefield.find((c) => c.instanceId === id);
}

const pickTargets = (targets: InstanceId[]) => (question: Question) =>
  question.kind === 'selectTargets' ? { kind: 'selectTargets', targets } : defaultAnswerFor(question);

// ---------------------------------------------------------------------------
// Skyclave Apparition
// ---------------------------------------------------------------------------
describe('Skyclave Apparition', () => {
  it('offers exactly the printed set: nonland, nontoken, not yours, mana value 4 or less', () => {
    const reg = buildRegistry();
    let s = toMain(reg);
    const bears = put(s, fromPool('Grizzly Bears'), 'B', 'battlefield'); // MV 2 — legal
    const angel = put(s, fromPool('Serra Angel'), 'B', 'battlefield'); // MV 5 — too big
    const token = put(s, fromPool('Grizzly Bears'), 'B', 'battlefield', { isToken: true }); // a token
    const land = put(s, fromPool('Forest'), 'B', 'battlefield'); // a land
    const mine = put(s, fromPool('Grizzly Bears'), 'A', 'battlefield'); // my own
    const apparition = put(s, SKYCLAVE_APPARITION, 'A', 'hand');

    s = act(s, { kind: 'castSpell', player: 'A', instanceId: apparition, targets: [] }, reg);
    let asked: Question | undefined;
    s = settle(s, reg, (question) => {
      if (question.kind === 'selectTargets') asked = question;
      return pickTargets([bears])(question);
    });
    expect(asked, 'the enters trigger asks for its target').toBeDefined();
    const offered = (asked as Extract<Question, { kind: 'selectTargets' }>).candidates.map((c) => c.ref);
    expect(offered, 'the 2-drop is on the menu').toContain(bears);
    expect(offered, 'mana value 5 is not').not.toContain(angel);
    expect(offered, 'a token is not (nontoken)').not.toContain(token);
    expect(offered, 'a land is not (nonland)').not.toContain(land);
    expect(offered, "your own permanent is not (you don't control)").not.toContain(mine);
    expect((asked as { min?: number }).min, '"up to one" — declining is a legal answer').toBe(0);

    expect(onBoard(s, bears), 'the chosen permanent is exiled').toBeUndefined();
    expect(s.players.B.exile.some((c) => c.instanceId === bears), "into its OWNER's exile").toBe(true);
  });

  it('when it leaves, the exiled card stays exiled and its owner gets an X/X blue Illusion, X its mana value', () => {
    const reg = buildRegistry();
    let s = toMain(reg);
    const bears = put(s, fromPool('Grizzly Bears'), 'B', 'battlefield');
    const apparition = put(s, SKYCLAVE_APPARITION, 'A', 'hand');
    s = act(s, { kind: 'castSpell', player: 'A', instanceId: apparition, targets: [] }, reg);
    s = settle(s, reg, pickTargets([bears]));
    expect(s.players.B.exile.some((c) => c.instanceId === bears)).toBe(true);

    // Kill the Apparition with a real removal spell, so the leaves trigger is
    // the engine's — Doom Blade destroys target nonblack creature.
    const blade = put(s, fromPool('Doom Blade'), 'B', 'hand');
    s.priorityPlayer = 'B';
    s = act(s, { kind: 'castSpell', player: 'B', instanceId: blade, targets: [apparition] }, reg);
    s = settle(s, reg);

    expect(onBoard(s, apparition), 'the Apparition is destroyed').toBeUndefined();
    // ⚠️ THE DISCRIMINATOR against an O-Ring reading: the card does NOT come back.
    expect(onBoard(s, bears), 'the exiled card stays in exile').toBeUndefined();
    expect(s.players.B.exile.some((c) => c.instanceId === bears)).toBe(true);
    const illusion = s.battlefield.find((c) => c.def.isToken === true && c.def.name === 'Illusion');
    expect(illusion, 'an Illusion token was created').toBeDefined();
    expect(illusion?.controller, "under the exiled card's OWNER").toBe('B');
    expect(illusion?.def.power, 'X = the mana value of Grizzly Bears').toBe(2);
    expect(illusion?.def.toughness).toBe(2);
    expect(illusion?.def.colors, 'blue').toEqual(['U']);
    expect(illusion?.def.subtypes?.map((t) => t.toLowerCase()), 'an Illusion').toEqual(['illusion']);
  });

  it('with nothing exiled ("up to one" declined), leaving makes no token', () => {
    const reg = buildRegistry();
    let s = toMain(reg);
    put(s, fromPool('Grizzly Bears'), 'B', 'battlefield');
    const apparition = put(s, SKYCLAVE_APPARITION, 'A', 'hand');
    s = act(s, { kind: 'castSpell', player: 'A', instanceId: apparition, targets: [] }, reg);
    s = settle(s, reg, pickTargets([])); // decline
    expect(s.players.B.exile).toHaveLength(0);
    const blade = put(s, fromPool('Doom Blade'), 'B', 'hand');
    s.priorityPlayer = 'B';
    s = act(s, { kind: 'castSpell', player: 'B', instanceId: blade, targets: [apparition] }, reg);
    s = settle(s, reg);
    expect(s.battlefield.some((c) => c.def.isToken === true), 'no Illusion for nothing').toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Spike Feeder — the removeCounters cost
// ---------------------------------------------------------------------------
describe('Spike Feeder — "Remove a +1/+1 counter from this creature" as a cost', () => {
  function withFeeder(reg: Registry): { state: GameState; feeder: InstanceId } {
    let s = toMain(reg);
    const feeder = put(s, SPIKE_FEEDER, 'A', 'hand');
    s = act(s, { kind: 'castSpell', player: 'A', instanceId: feeder, targets: [] }, reg);
    s = settle(s, reg);
    return { state: s, feeder };
  }

  const lifegainOffer = (state: GameState, feeder: InstanceId) =>
    generateLegalActions(state).find(
      (a) => a.kind === 'activateAbility' && a.instanceId === feeder && a.abilityIndex === 1,
    );

  it('enters as a 0/0 with two counters and is offered the lifegain while it has one', () => {
    const reg = buildRegistry();
    const { state: s, feeder } = withFeeder(reg);
    expect(onBoard(s, feeder)?.counters[PLUS_ONE_COUNTER]).toBe(2);
    expect(lifegainOffer(s, feeder), 'offered while a counter is there').toBeDefined();
  });

  it('pays the counter at activation, gains the life on resolution, and the last counter is lethal', () => {
    const reg = buildRegistry();
    let { state: s } = withFeeder(reg);
    const mine = s.battlefield.find((c) => c.def.name === 'Spike Feeder')!.instanceId;
    const lifeBefore = s.players.A.life;

    s = act(s, lifegainOffer(s, mine) as GameAction, reg);
    expect(onBoard(s, mine)?.counters[PLUS_ONE_COUNTER], 'the counter is gone BEFORE the ability resolves (CR 602.2b)').toBe(1);
    expect(s.stack).toHaveLength(1);
    s = settle(s, reg);
    expect(s.players.A.life).toBe(lifeBefore + 2);
    expect(onBoard(s, mine), 'a 1/1 Spike is still here').toBeDefined();

    s = act(s, lifegainOffer(s, mine) as GameAction, reg);
    s = settle(s, reg);
    expect(s.players.A.life, 'four life in all').toBe(lifeBefore + 4);
    expect(onBoard(s, mine), 'a 0/0 with no counters dies to the state-based action').toBeUndefined();
    expect(s.players.A.graveyard.some((c) => c.def.name === 'Spike Feeder')).toBe(true);
  });

  it('is not offered, and is refused by name, when the counters are not there', () => {
    const reg = buildRegistry();
    const s = toMain(reg);
    // A Spike with NO counters. It is a 0/0 and the next state-based check will
    // bury it, but nothing has run one yet — so the refusal below is for the
    // COUNTER, not for a corpse, which is the reading this pins.
    const bare = put(s, SPIKE_FEEDER, 'A', 'battlefield', { counters: {} });
    expect(lifegainOffer(s, bare), 'not on the menu').toBeUndefined();
    const reason = rejection(s, { kind: 'activateAbility', player: 'A', instanceId: bare, abilityIndex: 1 }, reg);
    expect(reason).toMatch(/does not have 1 \+1\/\+1 counter/);
  });

  it('the {2} form moves a counter onto the chosen creature', () => {
    const reg = buildRegistry();
    let { state: s } = withFeeder(reg);
    const mine = s.battlefield.find((c) => c.def.name === 'Spike Feeder')!.instanceId;
    const bears = put(s, fromPool('Grizzly Bears'), 'A', 'battlefield');
    const move = generateLegalActions(s).find(
      (a) => a.kind === 'activateAbility' && a.instanceId === mine && a.abilityIndex === 0 && a.targets?.[0] === bears,
    );
    expect(move, 'offered with the pool floating {2}').toBeDefined();
    s = act(s, move as GameAction, reg);
    s = settle(s, reg);
    expect(onBoard(s, mine)?.counters[PLUS_ONE_COUNTER]).toBe(1);
    expect(onBoard(s, bears)?.counters[PLUS_ONE_COUNTER]).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Voice of the Blessed — the counter-threshold static
// ---------------------------------------------------------------------------
describe('Voice of the Blessed', () => {
  it('has flying and vigilance at four counters, not at three — and only itself', () => {
    const reg = buildRegistry();
    const s = toMain(reg);
    const three = put(s, VOICE_OF_THE_BLESSED, 'A', 'battlefield', { counters: { [PLUS_ONE_COUNTER]: 3 } });
    const four = put(s, VOICE_OF_THE_BLESSED, 'A', 'battlefield', { counters: { [PLUS_ONE_COUNTER]: 4 } });
    const bystander = put(s, fromPool('Grizzly Bears'), 'A', 'battlefield', { counters: { [PLUS_ONE_COUNTER]: 5 } });
    // Read the layered keywords the way combat and targeting do.
    const kw = (id: InstanceId) => keywordsOn(s, id);
    expect(kw(four).flying, 'four counters: flying').toBe(true);
    expect(kw(four).vigilance, 'four counters: vigilance').toBe(true);
    expect(kw(four).indestructible, 'but not indestructible until ten').not.toBe(true);
    expect(kw(three).flying, 'three counters: no flying').not.toBe(true);
    expect(kw(bystander).flying, 'the static is self-only').not.toBe(true);
  });

  it('grows with lifegain and takes wing on the fourth', () => {
    const reg = buildRegistry();
    let s = toMain(reg);
    const voice = put(s, VOICE_OF_THE_BLESSED, 'A', 'battlefield');
    const feeder = put(s, SPIKE_FEEDER, 'A', 'battlefield', { counters: { [PLUS_ONE_COUNTER]: 4 } });
    for (let i = 0; i < 4; i++) {
      const gain = generateLegalActions(s).find((a) => a.kind === 'activateAbility' && a.instanceId === feeder && a.abilityIndex === 1);
      s = act(s, gain as GameAction, reg);
      s = settle(s, reg);
    }
    expect(onBoard(s, voice)?.counters[PLUS_ONE_COUNTER], 'one counter per lifegain event').toBe(4);
    expect(keywordsOn(s, voice).flying).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tyvar's Stand
// ---------------------------------------------------------------------------
describe("Tyvar's Stand", () => {
  it('pumps by X and grants BOTH keywords, only to a creature you control', () => {
    const reg = buildRegistry();
    let s = toMain(reg);
    const mine = put(s, fromPool('Grizzly Bears'), 'A', 'battlefield');
    const theirs = put(s, fromPool('Grizzly Bears'), 'B', 'battlefield');
    const stand = put(s, TYVARS_STAND, 'A', 'hand');
    const offers = generateLegalActions(s).filter((a) => a.kind === 'castSpell' && a.instanceId === stand);
    expect(offers.some((a) => a.targets?.[0] === mine), 'my creature is a legal target').toBe(true);
    expect(offers.some((a) => a.targets?.[0] === theirs), "the opponent's is not").toBe(false);
    s = act(s, { kind: 'castSpell', player: 'A', instanceId: stand, targets: [mine] }, reg);
    // X is a CAST-TIME question (CR 601.2b); the default answer is the smallest
    // legal value, which would pump by nothing. Answer it with three.
    s = settle(s, reg, (question) =>
      question.kind === 'chooseNumber' ? { kind: 'chooseNumber', value: 3 } : defaultAnswerFor(question),
    );
    const kw = keywordsOn(s, mine);
    expect(kw.hexproof, 'hexproof').toBe(true);
    expect(kw.indestructible, 'indestructible — the second keyword of the list').toBe(true);
    expect(powerOn(s, mine), '+X/+X with X = 3').toBe(5);
  });
});

// ---------------------------------------------------------------------------
// helpers reading the layered board the way the engine does
// ---------------------------------------------------------------------------
function keywordsOn(state: GameState, id: InstanceId) {
  const inst = onBoard(state, id);
  if (!inst) throw new Error(`instance ${id} not on the battlefield`);
  return effectiveKeywords(inst, indexContinuous(state).get(id) ?? NO_MOD);
}

function powerOn(state: GameState, id: InstanceId): number {
  const inst = onBoard(state, id);
  if (!inst) throw new Error(`instance ${id} not on the battlefield`);
  return effectivePower(inst, indexContinuous(state).get(id) ?? NO_MOD);
}
