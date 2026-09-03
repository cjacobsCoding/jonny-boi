/**
 * UPKEEP COSTS AND TIME COUNTERS (§3.106) — echo, cumulative upkeep, suspend,
 * vanishing, fading and the printed templates, each proven twice: the REAL
 * printed card compiles (ground truth from the full corpus, names pinned), and
 * the compiled card does the printed thing to a game played through the real
 * engine.
 *
 * Every assertion is about the RULE's effect on the board — an unpaid echo
 * creature is in the graveyard after the upkeep, a suspended Rift Bolt resolves
 * free on the turn its last counter leaves — because a card that compiles and
 * then does nothing is the failure this whole package exists to refuse.
 */

import { describe, expect, it } from 'vitest';
import type {
  CardDefinition,
  CardInstance,
  ChoiceAnswer,
  GameAction,
  GameState,
  PayLifeChoice,
  PayManaChoice,
  PlayerId,
} from '@jonny-boi/core';
import {
  AGE_COUNTER,
  applyAction,
  createGame,
  DEFAULT_RULES,
  dumpState,
  FADE_COUNTER,
  generateLegalActions,
  TIME_COUNTER,
} from '@jonny-boi/core';
import { compileCard } from './compile/compile.js';
import type { CompilableCard } from './compile/types.js';
import { buildRegistry } from './pool.js';
import { CORE_PRIMITIVE_IDS } from './primitives.js';

type Registry = ReturnType<typeof buildRegistry>;

// --- the printed cards, exactly as Scryfall prints them --------------------------

type Cost = CompilableCard['manaCost'];
const cost = (parts: Partial<Cost>): Cost => ({ generic: 0, W: 0, U: 0, B: 0, R: 0, G: 0, C: 0, other: [], ...parts });

function printed(
  name: string,
  oracleText: string,
  typeLine: CompilableCard['typeLine'],
  manaCost: Cost | null,
  extra: Partial<CompilableCard> = {},
): CompilableCard {
  return {
    id: `id:${name}`,
    name,
    manaCost,
    typeLine,
    power: null,
    toughness: null,
    keywords: [],
    oracleText,
    ...extra,
  } as CompilableCard;
}

const creature = (subtypes: string[]): CompilableCard['typeLine'] => ({ supertypes: [], types: ['Creature'], subtypes });
const ECHO_REMINDER =
  ' (At the beginning of your upkeep, if this came under your control since the beginning of your last upkeep, sacrifice it unless you pay its echo cost.)';
const CU_REMINDER =
  ' (At the beginning of your upkeep, put an age counter on this permanent, then sacrifice it unless you pay its upkeep cost for each age counter on it.)';

const ALBINO_TROLL = printed(
  'Albino Troll',
  `Echo {1}{G}${ECHO_REMINDER}\n{1}{G}: Regenerate this creature.`,
  creature(['Troll']),
  cost({ generic: 1, G: 1 }),
  { power: 3, toughness: 3, keywords: ['Echo'] },
);
const DERANGED_HERMIT = printed(
  'Deranged Hermit',
  `Echo {3}{G}{G}${ECHO_REMINDER}\nWhen this creature enters, create four 1/1 green Squirrel creature tokens.\nSquirrel creatures get +1/+1.`,
  creature(['Elf']),
  cost({ generic: 3, G: 2 }),
  { power: 1, toughness: 1, keywords: ['Echo'] },
);
const DEEPCAVERN_IMP = printed(
  'Deepcavern Imp',
  `Flying, haste\nEcho—Discard a card.${ECHO_REMINDER}`,
  creature(['Imp', 'Rebel']),
  cost({ generic: 2, B: 1 }),
  { power: 2, toughness: 2, keywords: ['Flying', 'Haste', 'Echo'] },
);
const SOLDEVI_SIMULACRUM = printed(
  'Soldevi Simulacrum',
  `Cumulative upkeep {1}${CU_REMINDER}\n{1}: This creature gets +1/+0 until end of turn.`,
  { supertypes: [], types: ['Artifact', 'Creature'], subtypes: ['Soldier'] },
  cost({ generic: 4 }),
  { power: 2, toughness: 4, keywords: ['Cumulative upkeep'] },
);
const GALLOWBRAID = printed(
  'Gallowbraid',
  `Trample\nCumulative upkeep—Pay 1 life.${CU_REMINDER}`,
  { supertypes: ['Legendary'], types: ['Creature'], subtypes: ['Phyrexian', 'Horror'] },
  cost({ generic: 3, B: 2 }),
  { power: 5, toughness: 5, keywords: ['Trample', 'Cumulative upkeep'] },
);
const ABOROTH = printed(
  'Aboroth',
  `Cumulative upkeep—Put a -1/-1 counter on this creature.${CU_REMINDER}`,
  creature(['Elemental']),
  cost({ generic: 4, G: 2 }),
  { power: 9, toughness: 9, keywords: ['Cumulative upkeep'] },
);
const BLASTODERM = printed(
  'Blastoderm',
  "Shroud (This creature can't be the target of spells or abilities.)\nFading 3 (This creature enters with three fade counters on it. At the beginning of your upkeep, remove a fade counter from it. If you can't, sacrifice it.)",
  creature(['Beast']),
  cost({ generic: 2, G: 2 }),
  { power: 5, toughness: 5, keywords: ['Shroud', 'Fading'] },
);
const CALCIDERM = printed(
  'Calciderm',
  "Shroud (This creature can't be the target of spells or abilities.)\nVanishing 4 (This creature enters with four time counters on it. At the beginning of your upkeep, remove a time counter from it. When the last is removed, sacrifice it.)",
  creature(['Beast']),
  cost({ generic: 2, W: 2 }),
  { power: 5, toughness: 5, keywords: ['Shroud', 'Vanishing'] },
);
const OMENPATH_TO_NAYA = printed(
  'Omenpath to Naya',
  'Vanishing 4 (This land enters the battlefield with four time counters on it. At the beginning of your upkeep, remove a time counter from it. When the last is removed, sacrifice it.)\n{T}: Add {R}, {G}, or {W}.',
  { supertypes: [], types: ['Land'], subtypes: ['Omenpath'] },
  { ...cost({}), absent: true },
  { keywords: ['Vanishing'] },
);
const TIDEWALKER = printed(
  'Tidewalker',
  "This creature enters with a time counter on it for each Island you control.\nVanishing (At the beginning of your upkeep, remove a time counter from this creature. When the last is removed, sacrifice it.)\nTidewalker's power and toughness are each equal to the number of time counters on it.",
  creature(['Elemental']),
  cost({ generic: 2, U: 1 }),
  { power: null, toughness: null, keywords: ['Vanishing'] },
);
const RIFT_BOLT = printed(
  'Rift Bolt',
  'Rift Bolt deals 3 damage to any target.\nSuspend 1—{R} (Rather than cast this card from your hand, you may pay {R} and exile it with a time counter on it. At the beginning of your upkeep, remove a time counter. When the last is removed, you may cast it without paying its mana cost.)',
  { supertypes: [], types: ['Sorcery'], subtypes: [] },
  cost({ generic: 2, R: 1 }),
  { keywords: ['Suspend'] },
);
const DURKWOOD_BALOTH = printed(
  'Durkwood Baloth',
  'Suspend 5—{G} (Rather than cast this card from your hand, you may pay {G} and exile it with five time counters on it. At the beginning of your upkeep, remove a time counter. When the last is removed, you may cast it without paying its mana cost. It has haste.)',
  creature(['Beast']),
  cost({ generic: 4, G: 2 }),
  { power: 5, toughness: 5, keywords: ['Suspend'] },
);
const PROFANE_TUTOR = printed(
  'Profane Tutor',
  'Suspend 2—{1}{B} (Rather than cast this card from your hand, pay {1}{B} and exile it with two time counters on it. At the beginning of your upkeep, remove a time counter. When the last is removed, you may cast it without paying its mana cost.)\nSearch your library for a card, put that card into your hand, then shuffle.',
  { supertypes: [], types: ['Sorcery'], subtypes: [] },
  { ...cost({}), absent: true },
  { keywords: ['Suspend'] },
);
const BENALISH_COMMANDER = printed(
  'Benalish Commander',
  "Benalish Commander's power and toughness are each equal to the number of Soldiers you control.\nSuspend X—{X}{W}{W}. X can't be 0.\nWhenever a time counter is removed from this card while it's exiled, create a 1/1 white Soldier creature token.",
  creature(['Human', 'Soldier']),
  cost({ generic: 3, W: 1 }),
  { power: null, toughness: null, keywords: ['Suspend'] },
);
const PHANTASMAL_FORCES = printed(
  'Phantasmal Forces',
  'Flying\nAt the beginning of your upkeep, sacrifice this creature unless you pay {U}.',
  creature(['Illusion']),
  cost({ generic: 3, U: 1 }),
  { power: 4, toughness: 1, keywords: ['Flying'] },
);
/**
 * Season of the Witch's FIRST line. The real card's second line (a
 * conditional end-step wrath) is outside this family and stays reported, so
 * the life-template is pinned on the line alone — the rule id is asserted on
 * the real card below.
 */
const SEASON_OF_THE_WITCH = printed(
  'Season of the Witch',
  "At the beginning of your upkeep, sacrifice this enchantment unless you pay 2 life.\nAt the beginning of the end step, destroy all untapped creatures that didn't attack this turn, except for creatures that couldn't attack.",
  { supertypes: [], types: ['Enchantment'], subtypes: [] },
  cost({ B: 3 }),
);
const LIFE_TITHE = printed(
  'Life Tithe',
  'At the beginning of your upkeep, sacrifice this enchantment unless you pay 2 life.',
  { supertypes: [], types: ['Enchantment'], subtypes: [] },
  cost({ B: 3 }),
);
const EXTRAVAGANT_SPIRIT = printed(
  'Extravagant Spirit',
  'Flying\nAt the beginning of your upkeep, sacrifice this creature unless you pay {1} for each card in your hand.',
  creature(['Spirit']),
  cost({ generic: 3, U: 1 }),
  { power: 4, toughness: 4, keywords: ['Flying'] },
);
const RAY_OF_ERASURE = printed(
  'Ray of Erasure',
  "Target player mills a card.\nDraw a card at the beginning of the next turn's upkeep.",
  { supertypes: [], types: ['Instant'], subtypes: [] },
  cost({ U: 1 }),
);

function complete(card: CompilableCard): CardDefinition {
  const result = compileCard(card);
  expect(result.status, `${card.name}: ${JSON.stringify(result.missing)}`).toBe('complete');
  return result.definition;
}

// --- the compiler half ------------------------------------------------------------

describe('the printed lines compile to the family’s triggers, and every body is a registered primitive', () => {
  it('registers the six primitives the rules emit', () => {
    for (const id of ['sacrificeSelf', 'payLifeOrElse', 'cumulativeUpkeep', 'tickDownCounter', 'suspendTick', 'scheduleDelayedEffects']) {
      expect(CORE_PRIMITIVE_IDS, id).toContain(id);
    }
  });

  it('Echo {1}{G} (Albino Troll) — an upkeep trigger gated by the came-under-your-control "if", paying or sacrificing', () => {
    const def = complete(ALBINO_TROLL);
    expect(def.triggers).toEqual([
      expect.objectContaining({
        condition: { on: 'upkeep', who: 'you', intervening: { kind: 'sourceControlledSinceLastUpkeep' } },
        effects: [
          { primitive: 'payManaOrElse', params: { cost: { generic: 1, G: 1 }, effects: [{ primitive: 'sacrificeSelf' }], stake: 'source' } },
        ],
        label: 'Echo {1}{G}',
      }),
    ]);
    // A five-mana echo on a 1/1 whose value is its ETB — the bill the pilot
    // declines (see the pilot suite) — compiles to the same shape.
    expect(complete(DERANGED_HERMIT).triggers?.find((t) => t.label === 'Echo {3}{G}{G}')).toBeDefined();
  });

  it('Cumulative upkeep {1} (Soldevi Simulacrum) and —Pay 1 life (Gallowbraid) — the two cost kinds of the closed table', () => {
    expect(complete(SOLDEVI_SIMULACRUM).triggers?.[0]).toMatchObject({
      condition: { on: 'upkeep', who: 'you' },
      effects: [{ primitive: 'cumulativeUpkeep', params: { mana: { generic: 1 } } }],
      label: 'Cumulative upkeep {1}',
    });
    expect(complete(GALLOWBRAID).triggers?.[0]).toMatchObject({
      effects: [{ primitive: 'cumulativeUpkeep', params: { life: 1 } }],
      label: 'Cumulative upkeep—Pay 1 life',
    });
  });

  it('Vanishing 4 (Calciderm, Omenpath to Naya) and Fading 3 (Blastoderm) — enters counted, ticks down each upkeep', () => {
    const calciderm = complete(CALCIDERM);
    expect(calciderm.entersWithCounters).toEqual([{ kind: TIME_COUNTER, count: 4 }]);
    expect(calciderm.triggers?.[0]).toMatchObject({
      condition: { on: 'upkeep', who: 'you', intervening: { kind: 'sourceHasCounter', counter: TIME_COUNTER } },
      effects: [{ primitive: 'tickDownCounter', params: { counter: TIME_COUNTER, sacrificeWhen: 'lastRemoved' } }],
      label: 'Vanishing 4',
    });
    expect(complete(OMENPATH_TO_NAYA).entersWithCounters).toEqual([{ kind: TIME_COUNTER, count: 4 }]);
    const blastoderm = complete(BLASTODERM);
    expect(blastoderm.entersWithCounters).toEqual([{ kind: FADE_COUNTER, count: 3 }]);
    expect(blastoderm.triggers?.[0]).toMatchObject({
      condition: { on: 'upkeep', who: 'you' },
      effects: [{ primitive: 'tickDownCounter', params: { counter: FADE_COUNTER, sacrificeWhen: 'noneToRemove' } }],
      label: 'Fading 3',
    });
  });

  it('Suspend 1—{R} (Rift Bolt) and a card with NO mana cost (Profane Tutor) — the record the special action reads', () => {
    expect(complete(RIFT_BOLT).suspend).toEqual({ count: 1, cost: { R: 1 }, upkeep: [{ primitive: 'suspendTick' }] });
    const tutor = complete(PROFANE_TUTOR);
    expect(tutor.cost).toBeUndefined();
    // CR 202.1b — no mana cost, as distinct from a printed {0}.
    expect(tutor.noManaCost).toBe(true);
    expect(complete(OMENPATH_TO_NAYA).noManaCost).toBeUndefined();
    expect(tutor.suspend).toEqual({ count: 2, cost: { generic: 1, B: 1 }, upkeep: [{ primitive: 'suspendTick' }] });
  });

  it('the printed templates: "sacrifice ~ unless you pay {U}" / "… 2 life" and "draw a card at the beginning of the next turn’s upkeep"', () => {
    expect(complete(PHANTASMAL_FORCES).triggers?.[0]?.effects).toEqual([
      { primitive: 'payManaOrElse', params: { cost: { U: 1 }, effects: [{ primitive: 'sacrificeSelf' }], stake: 'source' } },
    ]);
    const season = compileCard(SEASON_OF_THE_WITCH);
    expect(season.matchedRules).toContain('sacrifice-self-unless-life-paid');
    expect(season.definition.triggers?.[0]?.effects).toEqual([
      { primitive: 'payLifeOrElse', params: { amount: 2, effects: [{ primitive: 'sacrificeSelf' }] } },
    ]);
    expect(complete(LIFE_TITHE).triggers?.[0]?.effects).toEqual(season.definition.triggers?.[0]?.effects);
    expect(complete(RAY_OF_ERASURE).effects?.[1]).toEqual({
      primitive: 'scheduleDelayedEffects',
      params: {
        on: 'upkeep',
        who: 'any',
        effects: [{ primitive: 'drawCards', params: { count: 1 } }],
        label: "Draw a card at the beginning of the next turn's upkeep",
      },
    });
  });

  it('REPORTS, never approximates, the forms outside the closed tables', () => {
    for (const [card, clause] of [
      [DEEPCAVERN_IMP, /echo—discard a card/i],
      [ABOROTH, /cumulative upkeep—put a -1\/-1 counter/i],
      [TIDEWALKER, /^vanishing$/i],
      [BENALISH_COMMANDER, /suspend x/i],
      [EXTRAVAGANT_SPIRIT, /for each card in your hand/i],
    ] as const) {
      const result = compileCard(card);
      expect(result.status, card.name).toBe('incomplete');
      expect(result.missing.some((gap) => clause.test(gap.text)), `${card.name}: ${JSON.stringify(result.missing)}`).toBe(true);
    }
  });
});

// --- the engine half --------------------------------------------------------------

const SEED = 61;
const DECK_SIZE = 40;
let syntheticId = 90_000;

function land(id: string, color: 'W' | 'U' | 'B' | 'R' | 'G'): CardDefinition {
  return { id, name: id, types: ['land'], produces: [color] };
}
const FOREST = land('Forest', 'G');

function instance(def: CardDefinition, player: PlayerId, zone: CardInstance['zone']): CardInstance {
  return {
    instanceId: syntheticId++,
    def,
    controller: player,
    owner: player,
    zone,
    tapped: false,
    summoningSick: false,
    damageMarked: 0,
    markedByDeathtouch: false,
    counters: {},
  };
}

function act(state: GameState, action: GameAction, reg: Registry): GameState {
  const result = applyAction(state, action, DEFAULT_RULES, reg);
  const rejected = result.events.find((e) => e.type === 'actionRejected');
  if (rejected) throw new Error(`unexpected rejection: ${(rejected as { reason: string }).reason}\n${dumpState(state)}`);
  return result.state;
}

function pass(state: GameState, reg: Registry): GameState {
  return act(state, { kind: 'passPriority', player: state.priorityPlayer }, reg);
}

/** Pass until `done` holds; a parked question or a finished game fails loudly. */
function until(state: GameState, reg: Registry, done: (s: GameState) => boolean): GameState {
  let s = state;
  for (let guard = 0; guard < 800; guard++) {
    if (done(s)) return s;
    if (s.gameOver) throw new Error('game ended first');
    if (s.pendingChoice) throw new Error(`a question parked the game first:\n${dumpState(s)}`);
    s = pass(s, reg);
  }
  throw new Error(`never reached the condition (turn ${s.turnNumber} ${s.step})`);
}

/** A's main phase on turn 1, empty hands, `lands` untapped Forests for A. */
function gameAtMain(reg: Registry, lands = 6): GameState {
  const { state: created } = createGame({
    seed: SEED,
    startingPlayer: 'A',
    registry: reg,
    decks: {
      A: { cards: Array.from({ length: DECK_SIZE }, () => FOREST) },
      B: { cards: Array.from({ length: DECK_SIZE }, () => FOREST) },
    },
  });
  const state = until(created, reg, (s) => s.step === 'precombatMain');
  state.players.A.hand = [];
  state.players.B.hand = [];
  for (let i = 0; i < lands; i++) state.battlefield.push(instance(FOREST, 'A', 'battlefield'));
  return state;
}

function fund(state: GameState, player: PlayerId, pool: Partial<Record<'W' | 'U' | 'B' | 'R' | 'G' | 'C', number>>): void {
  state.players[player].manaPool = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0, ...pool };
}

/** Cast `def` from A's hand at A's main and let it resolve. */
function castAndResolve(state: GameState, reg: Registry, def: CardDefinition, targets?: (number | PlayerId)[]): GameState {
  const card = instance(def, 'A', 'hand');
  state.players.A.hand.push(card);
  fund(state, 'A', { W: 6, U: 6, B: 6, R: 6, G: 6, C: 6 });
  let s = act(state, { kind: 'castSpell', player: 'A', instanceId: card.instanceId, ...(targets ? { targets } : {}) }, reg);
  s = pass(s, reg);
  s = pass(s, reg);
  return s;
}

function answer(state: GameState, reg: Registry, value: ChoiceAnswer): GameState {
  const choice = state.pendingChoice;
  if (!choice) throw new Error(`no choice pending:\n${dumpState(state)}`);
  return act(state, { kind: 'answerChoice', player: choice.chooser, choiceId: choice.id, answer: value }, reg);
}

/** Run to A's upkeep on `turn` and let the upkeep trigger resolve to its question. */
function toUpkeepQuestion(state: GameState, reg: Registry, turn: number): GameState {
  let s = until(state, reg, (x) => x.turnNumber === turn && x.step === 'upkeep');
  s = until(s, reg, (x) => x.pendingChoice !== null && x.pendingChoice !== undefined);
  return s;
}

const named = (state: GameState, name: string) => state.battlefield.find((c) => c.def.name === name);
const inGraveyard = (state: GameState, player: PlayerId, name: string) =>
  state.players[player].graveyard.some((c) => c.def.name === name);

describe('ECHO, played (CR 702.30a)', () => {
  it('asks for the echo cost on the first upkeep after the creature entered, naming the creature as the stake', () => {
    const reg = buildRegistry();
    let state = gameAtMain(reg);
    state = castAndResolve(state, reg, complete(ALBINO_TROLL));
    state = toUpkeepQuestion(state, reg, 3);
    const choice = state.pendingChoice as PayManaChoice;
    expect(choice.kind).toBe('payMana');
    expect(choice.chooser).toBe('A');
    expect(choice.cost).toEqual({ generic: 1, G: 1 });
    expect(choice.affordable).toBe(true);
    expect(choice.stakeInstanceId).toBe(named(state, 'Albino Troll')!.instanceId);
  });

  it('an UNPAID echo puts the creature in the graveyard; a PAID one keeps it, and it is never asked again', () => {
    const reg = buildRegistry();
    let state = gameAtMain(reg);
    state = castAndResolve(state, reg, complete(ALBINO_TROLL));
    const declined = answer(toUpkeepQuestion(state, reg, 3), reg, { kind: 'payMana', pay: false });
    expect(named(declined, 'Albino Troll')).toBeUndefined();
    expect(inGraveyard(declined, 'A', 'Albino Troll')).toBe(true);

    let paid = answer(toUpkeepQuestion(state, reg, 3), reg, { kind: 'payMana', pay: true });
    expect(named(paid, 'Albino Troll')).toBeDefined();
    // The bill was paid from the board: two of the six Forests are tapped.
    expect(paid.battlefield.filter((c) => c.controller === 'A' && c.def.name === 'Forest' && c.tapped)).toHaveLength(2);
    // Turn 5: the troll did NOT come under A's control since turn 3's upkeep — no
    // trigger, no question, straight through to the draw step.
    paid = until(paid, reg, (s) => s.turnNumber === 5 && s.step === 'draw');
    expect(named(paid, 'Albino Troll')).toBeDefined();
  });
});

describe('CUMULATIVE UPKEEP, played (CR 702.24a)', () => {
  it('puts an age counter on each upkeep and bills the cost once per counter — {1}, then {2}', () => {
    const reg = buildRegistry();
    let state = gameAtMain(reg);
    state = castAndResolve(state, reg, complete(SOLDEVI_SIMULACRUM));
    state = toUpkeepQuestion(state, reg, 3);
    expect((state.pendingChoice as PayManaChoice).cost).toEqual({ generic: 1 });
    state = answer(state, reg, { kind: 'payMana', pay: true });
    expect(named(state, 'Soldevi Simulacrum')!.counters[AGE_COUNTER]).toBe(1);
    state = toUpkeepQuestion(state, reg, 5);
    expect((state.pendingChoice as PayManaChoice).cost).toEqual({ generic: 2 });
    expect((state.pendingChoice as PayManaChoice).stakeInstanceId).toBe(named(state, 'Soldevi Simulacrum')!.instanceId);
    state = answer(state, reg, { kind: 'payMana', pay: false });
    expect(named(state, 'Soldevi Simulacrum')).toBeUndefined();
    expect(inGraveyard(state, 'A', 'Soldevi Simulacrum')).toBe(true);
  });

  it('the LIFE form bills 1 life, then 2 (Gallowbraid), and the counter goes on either way', () => {
    const reg = buildRegistry();
    let state = gameAtMain(reg);
    state = castAndResolve(state, reg, complete(GALLOWBRAID));
    state = toUpkeepQuestion(state, reg, 3);
    expect((state.pendingChoice as PayLifeChoice).kind).toBe('payLife');
    expect((state.pendingChoice as PayLifeChoice).amount).toBe(1);
    state = answer(state, reg, { kind: 'payLife', pay: true });
    expect(state.players.A.life).toBe(19);
    state = toUpkeepQuestion(state, reg, 5);
    expect((state.pendingChoice as PayLifeChoice).amount).toBe(2);
    expect(named(state, 'Gallowbraid')!.counters[AGE_COUNTER]).toBe(1);
    state = answer(state, reg, { kind: 'payLife', pay: false });
    expect(state.players.A.life).toBe(19);
    expect(inGraveyard(state, 'A', 'Gallowbraid')).toBe(true);
  });
});

describe('VANISHING and FADING, played (CR 702.63a / 702.32a)', () => {
  it('Calciderm (vanishing 4) loses a time counter each upkeep and is sacrificed as the last one leaves', () => {
    const reg = buildRegistry();
    let state = gameAtMain(reg);
    state = castAndResolve(state, reg, complete(CALCIDERM));
    expect(named(state, 'Calciderm')!.counters[TIME_COUNTER]).toBe(4);
    for (const [turn, left] of [
      [3, 3],
      [5, 2],
      [7, 1],
    ] as const) {
      state = until(state, reg, (s) => s.turnNumber === turn && s.step === 'draw');
      expect(named(state, 'Calciderm')!.counters[TIME_COUNTER], `after turn ${turn}'s upkeep`).toBe(left);
    }
    state = until(state, reg, (s) => s.turnNumber === 9 && s.step === 'draw');
    expect(named(state, 'Calciderm')).toBeUndefined();
    expect(inGraveyard(state, 'A', 'Calciderm')).toBe(true);
  });

  it('Blastoderm (fading 3) survives one upkeep MORE than a vanishing 3 would: it dies when there is no counter to remove', () => {
    const reg = buildRegistry();
    let state = gameAtMain(reg);
    state = castAndResolve(state, reg, complete(BLASTODERM));
    expect(named(state, 'Blastoderm')!.counters[FADE_COUNTER]).toBe(3);
    state = until(state, reg, (s) => s.turnNumber === 7 && s.step === 'draw');
    // Three upkeeps (3, 5, 7) removed the three counters; it is still here.
    expect(named(state, 'Blastoderm')!.counters[FADE_COUNTER]).toBe(0);
    state = until(state, reg, (s) => s.turnNumber === 9 && s.step === 'draw');
    expect(named(state, 'Blastoderm')).toBeUndefined();
    expect(inGraveyard(state, 'A', 'Blastoderm')).toBe(true);
  });

  it('a LAND with vanishing (Omenpath to Naya) enters with its time counters when PLAYED', () => {
    const reg = buildRegistry();
    const state = gameAtMain(reg);
    const omenpath = instance(complete(OMENPATH_TO_NAYA), 'A', 'hand');
    state.players.A.hand.push(omenpath);
    const after = act(state, { kind: 'playLand', player: 'A', instanceId: omenpath.instanceId }, reg);
    expect(named(after, 'Omenpath to Naya')!.counters[TIME_COUNTER]).toBe(4);
  });
});

describe('SUSPEND, played (CR 702.62a)', () => {
  it('Rift Bolt: suspended for {R}, ticks at the next upkeep, and is cast FREE from the window for 3 damage', () => {
    const reg = buildRegistry();
    let state = gameAtMain(reg);
    const bolt = instance(complete(RIFT_BOLT), 'A', 'hand');
    state.players.A.hand.push(bolt);
    // Its own cost, {2}{R}, is out of reach; the suspend cost is not.
    fund(state, 'A', { R: 1 });
    expect(generateLegalActions(state).some((a) => a.kind === 'castSpell' && a.instanceId === bolt.instanceId)).toBe(false);
    expect(generateLegalActions(state).some((a) => a.kind === 'suspendCard' && a.instanceId === bolt.instanceId)).toBe(true);
    state = act(state, { kind: 'suspendCard', player: 'A', instanceId: bolt.instanceId }, reg);
    expect(state.players.A.exile[0]!.counters[TIME_COUNTER]).toBe(1);
    expect(state.delayedTriggers?.map((d) => d.ability.label)).toEqual(['Suspend: Rift Bolt']);

    // Turn 3's upkeep: the tick removes the last counter and opens the window.
    state = until(state, reg, (s) => s.madnessWindow?.kind === 'suspend');
    expect(state.turnNumber).toBe(3);
    expect(state.step).toBe('upkeep');
    expect(state.players.A.exile[0]!.counters[TIME_COUNTER]).toBe(0);
    // A has nothing in the pool and every Forest untapped — the cast is free
    // and, being a sorcery cast in the upkeep, ignores its own timing.
    fund(state, 'A', {});
    const casts = generateLegalActions(state).filter((a): a is Extract<GameAction, { kind: 'castSpell' }> => a.kind === 'castSpell');
    // "Any target" is offered bare (the pilot supplies the aim, as for every
    // unrestricted spell); aim it at B's face.
    expect(casts).toEqual([{ kind: 'castSpell', player: 'A', instanceId: bolt.instanceId, fromZone: 'exile' }]);
    state = act(state, { ...casts[0]!, targets: ['B'] }, reg);
    expect(state.madnessWindow ?? null).toBeNull();
    state = pass(state, reg);
    state = pass(state, reg);
    expect(state.players.B.life).toBe(17);
    expect(inGraveyard(state, 'A', 'Rift Bolt')).toBe(true);
    expect(state.battlefield.filter((c) => c.def.name === 'Forest' && c.tapped)).toHaveLength(0);
  });

  it('a suspended creature (Durkwood Baloth) arrives with haste — able to attack the turn it enters', () => {
    const reg = buildRegistry();
    let state = gameAtMain(reg);
    const baloth = instance(complete(DURKWOOD_BALOTH), 'A', 'hand');
    state.players.A.hand.push(baloth);
    fund(state, 'A', { G: 1 });
    state = act(state, { kind: 'suspendCard', player: 'A', instanceId: baloth.instanceId }, reg);
    expect(state.players.A.exile[0]!.counters[TIME_COUNTER]).toBe(5);
    state = until(state, reg, (s) => s.madnessWindow?.kind === 'suspend');
    // Five of A's upkeeps: turns 3, 5, 7, 9, 11.
    expect(state.turnNumber).toBe(11);
    state = act(state, { kind: 'castSpell', player: 'A', instanceId: baloth.instanceId, fromZone: 'exile' }, reg);
    state = pass(state, reg);
    state = pass(state, reg);
    const onBoard = named(state, 'Durkwood Baloth')!;
    expect(onBoard.summoningSick).toBe(false);
    state = until(state, reg, (s) => s.turnNumber === 11 && s.step === 'declareAttackers');
    const attack = generateLegalActions(state).find(
      (a): a is Extract<GameAction, { kind: 'declareAttackers' }> => a.kind === 'declareAttackers',
    );
    expect(attack?.attackers).toContain(onBoard.instanceId);
  });

  it('a card with no mana cost (Profane Tutor) can be suspended but never cast from hand — and declining the window leaves it exiled', () => {
    const reg = buildRegistry();
    let state = gameAtMain(reg);
    const tutor = instance(complete(PROFANE_TUTOR), 'A', 'hand');
    state.players.A.hand.push(tutor);
    fund(state, 'A', { B: 1, C: 1 });
    expect(generateLegalActions(state).some((a) => a.kind === 'castSpell' && a.instanceId === tutor.instanceId)).toBe(false);
    state = act(state, { kind: 'suspendCard', player: 'A', instanceId: tutor.instanceId }, reg);
    state = until(state, reg, (s) => s.madnessWindow?.kind === 'suspend');
    expect(state.turnNumber).toBe(5);
    state = act(state, { kind: 'passPriority', player: 'A' }, reg);
    expect(state.madnessWindow ?? null).toBeNull();
    expect(state.players.A.exile.map((c) => c.def.name)).toEqual(['Profane Tutor']);
    expect(state.players.A.graveyard.some((c) => c.def.name === 'Profane Tutor')).toBe(false);
  });
});

describe('the printed templates, played', () => {
  it('"sacrifice ~ unless you pay {U}" (Phantasmal Forces) asks EVERY upkeep, and declining sacrifices', () => {
    const reg = buildRegistry();
    let state = gameAtMain(reg);
    state.battlefield.push(instance(land('Island', 'U'), 'A', 'battlefield'));
    state = castAndResolve(state, reg, complete(PHANTASMAL_FORCES));
    state = toUpkeepQuestion(state, reg, 3);
    expect((state.pendingChoice as PayManaChoice).cost).toEqual({ U: 1 });
    expect((state.pendingChoice as PayManaChoice).stakeInstanceId).toBe(named(state, 'Phantasmal Forces')!.instanceId);
    state = answer(state, reg, { kind: 'payMana', pay: true });
    expect(named(state, 'Phantasmal Forces')).toBeDefined();
    // Not an echo: the bill comes EVERY upkeep.
    state = toUpkeepQuestion(state, reg, 5);
    state = answer(state, reg, { kind: 'payMana', pay: false });
    expect(inGraveyard(state, 'A', 'Phantasmal Forces')).toBe(true);
  });

  it('an UNAFFORDABLE bill is not even asked: the permanent is simply sacrificed', () => {
    const reg = buildRegistry();
    let state = gameAtMain(reg); // Forests only — no {U} anywhere
    state = castAndResolve(state, reg, complete(PHANTASMAL_FORCES));
    state = until(state, reg, (s) => s.turnNumber === 3 && s.step === 'draw');
    expect(inGraveyard(state, 'A', 'Phantasmal Forces')).toBe(true);
  });

  it('"sacrifice ~ unless you pay 2 life" bills life', () => {
    const reg = buildRegistry();
    let state = gameAtMain(reg);
    state = castAndResolve(state, reg, complete(LIFE_TITHE));
    state = toUpkeepQuestion(state, reg, 3);
    expect((state.pendingChoice as PayLifeChoice).amount).toBe(2);
    state = answer(state, reg, { kind: 'payLife', pay: true });
    expect(state.players.A.life).toBe(18);
    expect(named(state, 'Life Tithe')).toBeDefined();
  });

  it('"draw a card at the beginning of the next turn’s upkeep" (Ray of Erasure) draws the CASTER on the opponent’s upkeep', () => {
    const reg = buildRegistry();
    let state = gameAtMain(reg);
    state = castAndResolve(state, reg, complete(RAY_OF_ERASURE), ['B']);
    expect(state.players.B.graveyard).toHaveLength(1); // the mill
    expect(state.delayedTriggers).toHaveLength(1);
    const handBefore = state.players.A.hand.length;
    state = until(state, reg, (s) => s.turnNumber === 2 && s.step === 'draw');
    expect(state.players.A.hand).toHaveLength(handBefore + 1);
    expect(state.delayedTriggers ?? []).toHaveLength(0);
  });
});
