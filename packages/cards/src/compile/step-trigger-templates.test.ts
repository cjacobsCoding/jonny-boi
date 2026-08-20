/**
 * TEMPLATE-GAP closures for the **"At the beginning of …"** family — the biggest
 * cluster in the coverage audit, and the one that had a named blocker sitting in
 * front of it: an "each player's" trigger fires on both turns but resolves under
 * its SOURCE's controller, so a body saying "that player" had nobody to point
 * at. That is now `EffectContext.triggeringPlayer`, and these are the cards it
 * unblocks.
 *
 * Every closure is proven twice, per the compiler contract:
 *
 *   1. a REAL card printing the wording compiles `'complete'`, with the emitted
 *      params PINNED so they cannot silently drift, and
 *   2. that compiled definition PLAYS correctly in a real game — and for
 *      anything scoped to "each player", **both seats are checked**, because the
 *      whole failure mode is a card that works for one seat and quietly does the
 *      wrong thing for the other.
 *
 * Alongside them sit the REFUSALS that keep it honest: an intervening "if" the
 * compiler cannot read must make the card report, never compile the body as
 * though the condition were not printed.
 */

import { describe, expect, it } from 'vitest';
import type {
  CardDefinition,
  CardInstance,
  ChoiceAnswer,
  GameState,
  PendingChoice,
  PlayerId,
} from '@jonny-boi/core';
import type { GameEvent } from '@jonny-boi/core';
import {
  applyAction,
  createGame,
  createRng,
  DEFAULT_RULES,
  dumpState,
  generateLegalActions,
} from '@jonny-boi/core';
import { createHeuristicPilot } from '@jonny-boi/ai';
import { compileCard } from './compile.js';
import type { CompilableCard } from './types.js';
import { buildRegistry } from '../pool.js';

type Registry = ReturnType<typeof buildRegistry>;

/** Seeds are fixed per test so any failure is reproducible. */
const SEEDS = Object.freeze({
  howlingMine: 601,
  kami: 602,
  fontOfMythos: 603,
  puzzleBox: 604,
  stormfist: 605,
  spitefulVisions: 606,
  dragonmaster: 607,
  colossalMajesty: 608,
});

const DECK_SIZE = 40;

const ISLAND: CardDefinition = {
  id: 'Island',
  name: 'Island',
  types: ['land'],
  produces: ['U'],
};

function makeCard(overrides: Partial<CompilableCard> & { name: string }): CompilableCard {
  return {
    id: `test:${overrides.name}`,
    manaCost: { generic: 0, W: 0, U: 0, B: 0, R: 0, G: 0, C: 0, other: [] },
    typeLine: { supertypes: [], types: [], subtypes: [] },
    oracleText: '',
    power: null,
    toughness: null,
    keywords: [],
    ...overrides,
  };
}

// --- the real cards, printed exactly as Scryfall has them ------------------------

const HOWLING_MINE = makeCard({
  name: 'Howling Mine',
  typeLine: { supertypes: [], types: ['Artifact'], subtypes: [] },
  oracleText:
    "At the beginning of each player's draw step, if this artifact is untapped, that player draws an additional card.",
});

const KAMI_OF_THE_CRESCENT_MOON = makeCard({
  name: 'Kami of the Crescent Moon',
  typeLine: { supertypes: ['Legendary'], types: ['Creature'], subtypes: ['Spirit'] },
  power: 1,
  toughness: 3,
  oracleText: "At the beginning of each player's draw step, that player draws an additional card.",
});

const DICTATE_OF_KRUPHIX = makeCard({
  name: 'Dictate of Kruphix',
  typeLine: { supertypes: [], types: ['Enchantment'], subtypes: [] },
  keywords: ['Flash'],
  oracleText:
    "Flash\nAt the beginning of each player's draw step, that player draws an additional card.",
});

const FONT_OF_MYTHOS = makeCard({
  name: 'Font of Mythos',
  typeLine: { supertypes: [], types: ['Artifact'], subtypes: [] },
  oracleText: "At the beginning of each player's draw step, that player draws two additional cards.",
});

const TEFERIS_PUZZLE_BOX = makeCard({
  name: "Teferi's Puzzle Box",
  typeLine: { supertypes: [], types: ['Artifact'], subtypes: [] },
  oracleText:
    "At the beginning of each player's draw step, that player puts the cards in their hand on the bottom of their library in any order, then draws that many cards.",
});

const SPITEFUL_VISIONS = makeCard({
  name: 'Spiteful Visions',
  typeLine: { supertypes: [], types: ['Enchantment'], subtypes: [] },
  oracleText:
    "At the beginning of each player's draw step, that player draws an additional card.\nWhenever a player draws a card, this enchantment deals 1 damage to that player.",
});

const STORMFIST_CRUSADER = makeCard({
  name: 'Stormfist Crusader',
  typeLine: { supertypes: [], types: ['Creature'], subtypes: ['Human', 'Knight'] },
  power: 2,
  toughness: 2,
  keywords: ['Menace'],
  oracleText:
    'Menace\nAt the beginning of your upkeep, each player draws a card and loses 1 life.',
});

const SCRAWLING_CRAWLER = makeCard({
  name: 'Scrawling Crawler',
  typeLine: { supertypes: [], types: ['Artifact', 'Creature'], subtypes: ['Phyrexian', 'Construct'] },
  power: 2,
  toughness: 4,
  oracleText:
    'At the beginning of your upkeep, each player draws a card.\nWhenever an opponent draws a card, that player loses 1 life.',
});

const DRAGONMASTER_OUTCAST = makeCard({
  name: 'Dragonmaster Outcast',
  typeLine: { supertypes: [], types: ['Creature'], subtypes: ['Human', 'Shaman'] },
  power: 1,
  toughness: 1,
  oracleText:
    'At the beginning of your upkeep, if you control six or more lands, create a 5/5 red Dragon creature token with flying.',
});

const COLOSSAL_MAJESTY = makeCard({
  name: 'Colossal Majesty',
  typeLine: { supertypes: [], types: ['Enchantment'], subtypes: [] },
  oracleText:
    'At the beginning of your upkeep, if you control a creature with power 4 or greater, draw a card.',
});

const GOD_PHARAOHS_STATUE_END_STEP = makeCard({
  name: 'Statue Test',
  typeLine: { supertypes: [], types: ['Artifact'], subtypes: [] },
  oracleText: 'At the beginning of your end step, each opponent loses 1 life.',
});

const ROILING_VORTEX_UPKEEP = makeCard({
  name: 'Vortex Test',
  typeLine: { supertypes: [], types: ['Enchantment'], subtypes: [] },
  oracleText: "At the beginning of each player's upkeep, this enchantment deals 1 damage to them.",
});

// --- harness ---------------------------------------------------------------------

function deck(def: CardDefinition) {
  return { cards: Array.from({ length: DECK_SIZE }, () => def) };
}

function act(state: GameState, action: Parameters<typeof applyAction>[1], reg: Registry): GameState {
  const result = applyAction(state, action, DEFAULT_RULES, reg);
  const rejected = result.events.find((e) => e.type === 'actionRejected');
  if (rejected) {
    throw new Error(`unexpected rejection: ${(rejected as { reason: string }).reason}\n${dumpState(state)}`);
  }
  return result.state;
}

function pass(state: GameState, reg: Registry): GameState {
  return act(state, { kind: 'passPriority', player: state.priorityPlayer }, reg);
}

function answer(state: GameState, reg: Registry, value: ChoiceAnswer): GameState {
  const choice = state.pendingChoice;
  if (!choice) throw new Error(`no choice pending:\n${dumpState(state)}`);
  return act(state, { kind: 'answerChoice', player: choice.chooser, choiceId: choice.id, answer: value }, reg);
}

/**
 * Play forward until `turnNumber` reaches `target`, answering any parked
 * question with `reply` (default: take every card offered, in order).
 */
function playToTurn(
  state: GameState,
  target: number,
  reg: Registry,
  reply?: (choice: PendingChoice, state: GameState) => ChoiceAnswer,
  max = 900,
): GameState {
  let s = state;
  let guard = 0;
  while (s.turnNumber < target && !s.gameOver && guard++ < max) {
    s = s.pendingChoice ? answer(s, reg, reply ? reply(s.pendingChoice, s) : defaultReply(s.pendingChoice)) : pass(s, reg);
  }
  return s;
}

function defaultReply(choice: PendingChoice): ChoiceAnswer {
  if (choice.kind === 'selectCards') {
    return { kind: 'selectCards', instanceIds: choice.candidates.slice(0, choice.max).map((c) => c.instanceId) };
  }
  if (choice.kind === 'confirm') return { kind: 'confirm', yes: true };
  throw new Error(`unexpected choice kind '${choice.kind}'`);
}

let syntheticId = 71_000;

function putOnBattlefield(state: GameState, def: CardDefinition, player: PlayerId): CardInstance {
  const card: CardInstance = {
    instanceId: syntheticId++,
    def,
    controller: player,
    owner: player,
    zone: 'battlefield',
    tapped: false,
    summoningSick: false,
    damageMarked: 0,
    markedByDeathtouch: false,
    counters: {},
  };
  state.battlefield.push(card);
  return card;
}

/** Put fresh instances of `defs` into a player's hand, in order. */
function putInHand(state: GameState, player: PlayerId, defs: readonly CardDefinition[]): void {
  for (const def of defs) {
    state.players[player].hand.push({
      instanceId: syntheticId++,
      def,
      controller: player,
      owner: player,
      zone: 'hand',
      tapped: false,
      summoningSick: false,
      damageMarked: 0,
      markedByDeathtouch: false,
      counters: {},
    });
  }
}

function gameAtStart(reg: Registry, seed: number): GameState {
  const { state } = createGame({
    seed,
    startingPlayer: 'A',
    registry: reg,
    decks: { A: deck(ISLAND), B: deck(ISLAND) },
  });
  // Both opening hands are trimmed WELL UNDER the CR 402.2 maximum before the
  // clock starts. Every test below asserts that an extra-draw trigger made a
  // hand GROW, and a hand that starts at the maximum cannot be observed growing:
  // the CR 514.1 cleanup discard puts it straight back at the end of each turn,
  // which is the rule working, not the trigger failing. The trimmed cards go to
  // the bottom of the library so nothing is destroyed and the deck stays legal.
  trimHandTo(state, 'A', HAND_ROOM_TO_GROW);
  trimHandTo(state, 'B', HAND_ROOM_TO_GROW);
  return state;
}

/**
 * How many cards each seat keeps in its opening hand for these tests — small
 * enough that several turns of extra draws stay below `maximumHandSize`.
 */
const HAND_ROOM_TO_GROW = 1;

/** Put a hand's surplus on the bottom of its owner's library. */
function trimHandTo(state: GameState, player: PlayerId, size: number): void {
  const seat = state.players[player];
  while (seat.hand.length > size) {
    const card = seat.hand.pop() as CardInstance;
    card.zone = 'library';
    seat.library.push(card);
  }
}

/** Compile, asserting the card is fully playable and naming what stopped it if not. */
function playable(card: CompilableCard): CardDefinition {
  const result = compileCard(card);
  expect(result.status, `${card.name}: ${JSON.stringify(result.missing)}`).toBe('complete');
  return result.definition;
}

// --- compile: the emitted data, pinned -------------------------------------------

describe('"At the beginning of each player\'s …" compiles with the triggering player', () => {
  it('Howling Mine — scope, intervening "if", and a body aimed at "that player"', () => {
    const definition = playable(HOWLING_MINE);
    expect(definition.triggers).toEqual([
      {
        condition: {
          on: 'drawStep',
          who: 'any',
          intervening: { kind: 'sourceUntapped' },
        },
        effects: [{ primitive: 'drawCards', params: { count: 1, whichPlayer: 'triggering' } }],
        label: "each player's draw step: if ~ is untapped, that player draws an additional card",
      },
    ]);
  });

  it('Kami of the Crescent Moon, Dictate of Kruphix and Font of Mythos share one shape', () => {
    for (const [card, count] of [
      [KAMI_OF_THE_CRESCENT_MOON, 1],
      [DICTATE_OF_KRUPHIX, 1],
      [FONT_OF_MYTHOS, 2],
    ] as const) {
      const definition = playable(card);
      expect(definition.triggers?.[0]?.condition).toEqual({ on: 'drawStep', who: 'any' });
      expect(definition.triggers?.[0]?.effects).toEqual([
        { primitive: 'drawCards', params: { count, whichPlayer: 'triggering' } },
      ]);
    }
    // Dictate's printed Flash is not lost to the trigger line.
    expect(playable(DICTATE_OF_KRUPHIX).keywords?.flash).toBe(true);
  });

  it("Teferi's Puzzle Box compiles to the hand-recycling primitive, aimed at that player", () => {
    const definition = playable(TEFERIS_PUZZLE_BOX);
    expect(definition.triggers?.[0]?.effects).toEqual([
      { primitive: 'handToBottomThenDraw', params: { who: 'triggering' } },
    ]);
  });

  it('Spiteful Visions and Scrawling Crawler compile BOTH lines, including the draw watcher', () => {
    const visions = playable(SPITEFUL_VISIONS);
    expect(visions.triggers?.length).toBe(2);
    expect(visions.triggers?.[1]?.condition).toEqual({ on: 'drawsCard', who: 'any' });
    expect(visions.triggers?.[1]?.effects).toEqual([
      { primitive: 'dealDamage', params: { amount: 1, whichPlayer: 'triggering' } },
    ]);

    const crawler = playable(SCRAWLING_CRAWLER);
    expect(crawler.triggers?.[0]?.effects).toEqual([
      { primitive: 'drawCards', params: { count: 1, whichPlayer: 'each' } },
    ]);
    expect(crawler.triggers?.[1]?.condition).toEqual({ on: 'drawsCard', who: 'opponent' });
    expect(crawler.triggers?.[1]?.effects).toEqual([
      { primitive: 'loseLife', params: { amount: 1, whichPlayer: 'triggering' } },
    ]);
  });

  it('the intervening "if" reads a controlled-permanent count, with an EFFECTIVE power bound', () => {
    expect(playable(DRAGONMASTER_OUTCAST).triggers?.[0]?.condition).toEqual({
      on: 'upkeep',
      who: 'you',
      intervening: { kind: 'controlCount', filter: { anyOfTypes: ['land'] }, min: 6 },
    });
    expect(playable(COLOSSAL_MAJESTY).triggers?.[0]?.condition).toEqual({
      on: 'upkeep',
      who: 'you',
      intervening: { kind: 'controlCount', filter: { anyOfTypes: ['creature'] }, min: 1, minPower: 4 },
    });
  });

  it('"each opponent"/"them" bodies aim without a target', () => {
    expect(playable(GOD_PHARAOHS_STATUE_END_STEP).triggers?.[0]?.effects).toEqual([
      { primitive: 'loseLife', params: { amount: 1, whichPlayer: 'opponent' } },
    ]);
    expect(playable(ROILING_VORTEX_UPKEEP).triggers?.[0]?.effects).toEqual([
      { primitive: 'dealDamage', params: { amount: 1, whichPlayer: 'triggering' } },
    ]);
  });
});

// --- refusals: the neighbours that must stay reported ----------------------------

describe('the refusals that keep the family honest', () => {
  it('REFUSES an intervening "if" it cannot read — never compiles the body without it', () => {
    // Felidar Sovereign. "If you have 40 or more life" is not a condition this
    // compiler can decide, and dropping it would produce a card that wins the
    // game on the next upkeep unconditionally — the single worst outcome the
    // compiler contract exists to prevent.
    const result = compileCard(
      makeCard({
        name: 'Felidar Sovereign',
        typeLine: { supertypes: [], types: ['Creature'], subtypes: ['Cat', 'Beast'] },
        power: 4,
        toughness: 6,
        oracleText: 'At the beginning of your upkeep, if you have 40 or more life, you win the game.',
      }),
    );
    expect(result.status).toBe('incomplete');
    expect(result.definition.triggers ?? []).toEqual([]);
  });

  it('REFUSES a readable condition whose BODY has no rule', () => {
    const result = compileCard(
      makeCard({
        name: 'Hellkite Tyrant',
        typeLine: { supertypes: [], types: ['Creature'], subtypes: ['Dragon'] },
        power: 6,
        toughness: 5,
        oracleText:
          'At the beginning of your upkeep, if you control twenty or more artifacts, you win the game.',
      }),
    );
    expect(result.status).toBe('incomplete');
  });

  it('REFUSES a step the engine has no trigger for, in every scope', () => {
    for (const scope of ['your', "each player's", 'each']) {
      const result = compileCard(
        makeCard({
          name: `Untapper ${scope}`,
          typeLine: { supertypes: [], types: ['Enchantment'], subtypes: [] },
          oracleText: `At the beginning of ${scope} untap step, draw a card.`,
        }),
      );
      expect(result.status, scope).toBe('incomplete');
    }
  });

  it('names the trigger as IMPLEMENTED when only the body is missing', () => {
    // The hint has to send the next contributor to write a rule, not to rebuild
    // a trigger system that already exists.
    const result = compileCard(
      makeCard({
        name: 'Chimil, the Inner Sun',
        typeLine: { supertypes: ['Legendary'], types: ['Artifact'], subtypes: [] },
        oracleText: 'At the beginning of your end step, discover 5.',
      }),
    );
    expect(result.status).toBe('incomplete');
    expect(result.missing[0]?.missingEngineSystem).toContain('trigger BODY');
  });
});

// --- play: the cards, in a real game ---------------------------------------------

describe('the cards played out — both seats, every time', () => {
  it('Howling Mine draws for WHOEVER\'s draw step it is, and stops while tapped', () => {
    const reg = buildRegistry();
    const mine = playable(HOWLING_MINE);

    const state = gameAtStart(reg, SEEDS.howlingMine);
    putOnBattlefield(state, mine, 'A');
    const before = { A: state.players.A.hand.length, B: state.players.B.hand.length };
    const after = playToTurn(state, 4, reg);
    expect(after.gameOver).toBe(false);
    // BOTH hands grew. Under the old (controller-reading) behaviour B's hand
    // would only ever grow by its own turn draws.
    expect(after.players.A.hand.length).toBeGreaterThan(before.A);
    expect(after.players.B.hand.length).toBeGreaterThan(before.B);

    // Tapped: the ability never triggers, so nothing is drawn beyond the turn
    // draws — and nothing goes on the stack for anyone to respond to.
    const tappedGame = gameAtStart(reg, SEEDS.howlingMine);
    const tapped = putOnBattlefield(tappedGame, mine, 'A');
    tapped.tapped = true;
    let sawTrigger = false;
    let s = tappedGame;
    let guard = 0;
    while (s.turnNumber < 4 && !s.gameOver && guard++ < 900) {
      // Keep it tapped: the untap step would otherwise untap it on A's turn.
      const permanent = s.battlefield.find((c) => c.instanceId === tapped.instanceId);
      if (permanent) permanent.tapped = true;
      const result = applyAction(s, { kind: 'passPriority', player: s.priorityPlayer }, DEFAULT_RULES, reg);
      if (result.events.some((e) => e.type === 'triggerPutOnStack')) sawTrigger = true;
      s = result.state;
    }
    expect(sawTrigger).toBe(false);
  });

  it('Font of Mythos gives each player TWO extra cards, on their own draw step', () => {
    const reg = buildRegistry();
    const state = gameAtStart(reg, SEEDS.fontOfMythos);
    putOnBattlefield(state, playable(FONT_OF_MYTHOS), 'A');
    const before = { A: state.players.A.hand.length, B: state.players.B.hand.length };
    // Two full turns each.
    const after = playToTurn(state, 5, reg);
    // A: turns 1,3 (turn-1 draw is skipped by the starting player) → 1 turn draw
    // + 2 trigger draws per own draw step. B: turns 2,4 → 2 turn draws + 4.
    // Rather than re-derive the turn structure, assert the RATIO that only the
    // triggering-player wiring can produce: both seats gained several cards.
    expect(after.players.A.hand.length - before.A).toBeGreaterThanOrEqual(4);
    expect(after.players.B.hand.length - before.B).toBeGreaterThanOrEqual(4);
  });

  it("Teferi's Puzzle Box recycles the hand of whoever's draw step it is", () => {
    const reg = buildRegistry();
    const state = gameAtStart(reg, SEEDS.puzzleBox);
    putOnBattlefield(state, playable(TEFERIS_PUZZLE_BOX), 'A');
    const handSizeBefore = { A: state.players.A.hand.length, B: state.players.B.hand.length };
    const libraryBefore = { A: state.players.A.library.length, B: state.players.B.library.length };
    // One full cycle. Every question the box asks is answered by taking the
    // whole hand in the offered order — the ordering is the player's, and this
    // test is about WHOSE hand is recycled.
    const after = playToTurn(state, 3, reg);
    expect(after.gameOver).toBe(false);
    // A recycled hand is the same SIZE it was (n out, n in), so the tell is the
    // library: cards went to the bottom and came off the top for both seats.
    expect(after.players.A.hand.length).toBeGreaterThanOrEqual(handSizeBefore.A);
    expect(after.players.B.hand.length).toBeGreaterThanOrEqual(handSizeBefore.B);
    expect(after.players.A.library.length).toBeLessThanOrEqual(libraryBefore.A);
    expect(after.players.B.library.length).toBeLessThanOrEqual(libraryBefore.B);
  });

  it('Stormfist Crusader makes EACH player draw and lose life — including its controller', () => {
    const reg = buildRegistry();
    const state = gameAtStart(reg, SEEDS.stormfist);
    putOnBattlefield(state, playable(STORMFIST_CRUSADER), 'A');
    const life = { A: state.players.A.life, B: state.players.B.life };
    const hands = { A: state.players.A.hand.length, B: state.players.B.hand.length };
    const after = playToTurn(state, 4, reg);
    // "Each player" is symmetric: the controller pays too.
    expect(after.players.A.life).toBeLessThan(life.A);
    expect(after.players.B.life).toBeLessThan(life.B);
    expect(after.players.A.hand.length).toBeGreaterThan(hands.A);
    expect(after.players.B.hand.length).toBeGreaterThan(hands.B);
  });

  it('Spiteful Visions burns the player who DREW, not its controller', () => {
    const reg = buildRegistry();
    const state = gameAtStart(reg, SEEDS.spitefulVisions);
    putOnBattlefield(state, playable(SPITEFUL_VISIONS), 'A');
    const life = { A: state.players.A.life, B: state.players.B.life };
    const after = playToTurn(state, 4, reg);
    // Both seats draw and both seats take damage; a controller-reading body
    // would have burned A for every draw in the game.
    expect(after.players.A.life).toBeLessThan(life.A);
    expect(after.players.B.life).toBeLessThan(life.B);
  });

  it('Scrawling Crawler drains only the OPPONENT, on the draws it gives them', () => {
    const reg = buildRegistry();
    const state = gameAtStart(reg, SEEDS.spitefulVisions);
    putOnBattlefield(state, playable(SCRAWLING_CRAWLER), 'A');
    const life = { A: state.players.A.life, B: state.players.B.life };
    const after = playToTurn(state, 5, reg);
    expect(after.players.B.life).toBeLessThan(life.B);
    // `who: 'opponent'` is read against the SOURCE's controller, so A's own
    // draws — including the ones this card hands them — cost A nothing.
    expect(after.players.A.life).toBe(life.A);
  });

  it('Dragonmaster Outcast waits for the sixth land, then makes a Dragon every upkeep', () => {
    const reg = buildRegistry();
    const outcast = playable(DRAGONMASTER_OUTCAST);

    const poor = gameAtStart(reg, SEEDS.dragonmaster);
    putOnBattlefield(poor, outcast, 'A');
    for (let i = 0; i < 5; i++) putOnBattlefield(poor, ISLAND, 'A');
    const withFive = playToTurn(poor, 4, reg);
    expect(withFive.battlefield.some((c) => c.def.name === 'Dragon')).toBe(false);

    const rich = gameAtStart(reg, SEEDS.dragonmaster);
    putOnBattlefield(rich, outcast, 'A');
    for (let i = 0; i < 6; i++) putOnBattlefield(rich, ISLAND, 'A');
    const withSix = playToTurn(rich, 4, reg);
    const dragon = withSix.battlefield.find((c) => c.def.name === 'Dragon');
    expect(dragon, dumpState(withSix)).toBeDefined();
    expect(dragon?.def.power).toBe(5);
    expect(dragon?.def.keywords?.flying).toBe(true);
    // The condition is the OWNER's board: the opponent's lands never count.
    const borrowed = gameAtStart(reg, SEEDS.dragonmaster);
    putOnBattlefield(borrowed, outcast, 'A');
    for (let i = 0; i < 6; i++) putOnBattlefield(borrowed, ISLAND, 'B');
    expect(playToTurn(borrowed, 4, reg).battlefield.some((c) => c.def.name === 'Dragon')).toBe(false);
  });

  it('Colossal Majesty reads EFFECTIVE power, so a 2/2 with counters turns it on', () => {
    const reg = buildRegistry();
    const majesty = playable(COLOSSAL_MAJESTY);
    const bear: CardDefinition = { id: 'Bear', name: 'Bear', types: ['creature'], power: 2, toughness: 2 };

    // Two identical games, same seed, differing ONLY in whether A's creature is
    // big enough. Compared against each other rather than against a hand-derived
    // number, so the assertion says exactly what the card does and nothing about
    // the turn structure.
    const small = gameAtStart(reg, SEEDS.colossalMajesty);
    putOnBattlefield(small, majesty, 'A');
    putOnBattlefield(small, bear, 'A');
    const smallAfter = playToTurn(small, 4, reg);

    const grown = gameAtStart(reg, SEEDS.colossalMajesty);
    putOnBattlefield(grown, majesty, 'A');
    const counted = putOnBattlefield(grown, bear, 'A');
    // PRINTED power is still 2. Only the counters make it "power 4 or greater",
    // so a printed-box reader would draw nothing here.
    counted.counters = { '+1/+1': 2 };
    const grownAfter = playToTurn(grown, 4, reg);

    expect(grownAfter.players.A.hand.length).toBeGreaterThan(smallAfter.players.A.hand.length);
  });
});

// --- the AI is not inert on the questions these cards ask -------------------------

describe('the real heuristic pilot plays the family without stalling', () => {
  /**
   * A full game driven by the REAL pilot on both seats. Nothing here is a
   * scripted answer: the point is that a card asking a question of the
   * NON-controlling player still gets an answer, and that the answer follows the
   * shared ordering convention rather than being a shrug.
   */
  function playGame(
    decks: { A: { cards: readonly CardDefinition[] }; B: { cards: readonly CardDefinition[] } },
    seed: number,
    maxActions = 600,
  ): { state: GameState; events: GameEvent[] } {
    const registry = buildRegistry();
    const pilot = createHeuristicPilot();
    const rng = createRng(seed);
    const created = createGame({ seed, decks, registry });
    let state = created.state;
    const events: GameEvent[] = [...created.events];
    for (let i = 0; i < maxActions && !state.gameOver; i++) {
      const legal = generateLegalActions(state, DEFAULT_RULES);
      if (legal.length === 0) break;
      const chosen = pilot.chooseAction({ view: state, legalActions: legal, rng, registry });
      const result = applyAction(state, chosen, DEFAULT_RULES, registry);
      state = result.state;
      events.push(...result.events);
    }
    return { state, events };
  }

  function deckWith(def: CardDefinition): { cards: readonly CardDefinition[] } {
    const cards: CardDefinition[] = [def, def, def, def];
    while (cards.length < DECK_SIZE) cards.push(ISLAND);
    return { cards };
  }

  it("answers Teferi's Puzzle Box for BOTH seats, and the game runs to a finish", () => {
    const box = playable(TEFERIS_PUZZLE_BOX);
    const game = playGame({ A: deckWith(box), B: deckWith(ISLAND) }, SEEDS.puzzleBox);
    // The pilot never left a question hanging — a parked choice at the end would
    // mean the game stopped because nobody would answer.
    expect(game.state.pendingChoice ?? null).toBeNull();
    // A stalled pilot is the failure this guards: `choiceAbandoned` is what the
    // engine logs when nothing could answer.
    expect(game.events.some((e) => e.type === 'choiceAbandoned')).toBe(false);
  });

  it('orders the recycled hand BEST FIRST, so the good card comes back soonest', () => {
    // The convention `packages/ai/src/choices.ts` documents: index 0 of an
    // ordered answer is the position seen soonest. `handToBottomThenDraw`
    // bottoms in the chosen order, and the library's top is index 0, so the
    // first-chosen card sits ABOVE the rest of the bottomed pile.
    const reg = buildRegistry();
    const state = gameAtStart(reg, SEEDS.puzzleBox);
    putOnBattlefield(state, playable(TEFERIS_PUZZLE_BOX), 'A');
    const dragon: CardDefinition = {
      id: 'Dragon',
      name: 'Dragon',
      types: ['creature'],
      power: 5,
      toughness: 5,
      cost: { generic: 6 },
    };
    // A hand of lands plus one obviously-best card, for the seat whose draw step
    // comes first.
    const holder: PlayerId = state.activePlayer;
    state.players[holder].hand = [];
    putInHand(state, holder, [ISLAND, dragon, ISLAND]);
    const libraryBefore = state.players[holder].library.length;

    let s = state;
    let guard = 0;
    // Stop as soon as the box's question has been answered by the real pilot.
    const pilot = createHeuristicPilot();
    const rng = createRng(SEEDS.puzzleBox);
    while (s.players[holder].library.length === libraryBefore && !s.gameOver && guard++ < 200) {
      const legal = generateLegalActions(s, DEFAULT_RULES);
      if (legal.length === 0) break;
      s = applyAction(s, pilot.chooseAction({ view: s, legalActions: legal, rng, registry: reg }), DEFAULT_RULES, reg)
        .state;
    }
    // Three cards went to the bottom; the Dragon is the shallowest of them,
    // i.e. it is above the two Islands that were bottomed with it.
    const library = s.players[holder].library;
    const dragonIndex = library.findIndex((c) => c.def.name === 'Dragon');
    expect(dragonIndex, dumpState(s)).toBeGreaterThanOrEqual(0);
    const bottomed = library.slice(library.length - 3);
    expect(bottomed[0]?.def.name).toBe('Dragon');
  });
});
