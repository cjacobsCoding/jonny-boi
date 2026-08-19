/**
 * TEMPLATE-GAP closures for the **"you may" and trigger-timing** families —
 * printed Oracle wordings the engine could already play (or can play with a
 * small, named addition) but the rule table did not recognize.
 *
 * Every closure here is proven twice, per the compiler contract:
 *
 *   1. a REAL card printing the wording compiles `'complete'`, with the emitted
 *      params PINNED so they cannot silently drift, and
 *   2. that compiled definition PLAYS correctly through `createGame` +
 *      `applyAction` — and for a "you may", **both answers are played**, because
 *      declining is the half that silently breaks. A "you may" that only works
 *      when you say yes is a different card from the printed one.
 *
 * Alongside each closure sit the REFUSALS that keep it honest: the neighbouring
 * wordings the engine still cannot play must stay `'incomplete'`.
 */

import { describe, expect, it } from 'vitest';
import type {
  CardDefinition,
  CardInstance,
  ChoiceAnswer,
  GameAction,
  GameState,
  PendingChoice,
  PlayerId,
} from '@jonny-boi/core';
import { applyAction, createGame, DEFAULT_RULES, dumpState } from '@jonny-boi/core';
import { compileCard } from './compile.js';
import type { CompilableCard } from './types.js';
import { buildRegistry } from '../pool.js';
import { CARD_POOL } from '../../data/pool.js';

type Registry = ReturnType<typeof buildRegistry>;

/** Seeds are fixed per test so any failure is reproducible. */
const SEEDS = Object.freeze({
  slowland: 401,
  battleland: 402,
  reclamationSage: 403,
  goblinMatron: 404,
  farhaven: 405,
  endStep: 406,
  eachUpkeep: 407,
  combatDamage: 408,
  creatureEtb: 409,
  drawStep: 410,
});

/** How many cards fill a test deck — enough that nobody decks out mid-test. */
const DECK_SIZE = 40;

/** A Scryfall-shaped record for the compiler. */
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

// --- the real cards, as printed --------------------------------------------------

/** A slowland (Deserted Beach), printed exactly as Scryfall has it. */
const DESERTED_BEACH = makeCard({
  name: 'Deserted Beach',
  typeLine: { supertypes: [], types: ['Land'], subtypes: [] },
  oracleText: 'This land enters tapped unless you control two or more other lands.\n{T}: Add {W} or {U}.',
});

/** A battleland (Prairie Stream) — the reminder line is its mana ability. */
const PRAIRIE_STREAM = makeCard({
  name: 'Prairie Stream',
  typeLine: { supertypes: [], types: ['Land'], subtypes: ['Plains', 'Island'] },
  oracleText: '({T}: Add {W} or {U}.)\nThis land enters tapped unless you control two or more basic lands.',
});

/** A basic land, to prove the compiler carries the Basic supertype through. */
const BASIC_PLAINS = makeCard({
  name: 'Plains',
  typeLine: { supertypes: ['Basic'], types: ['Land'], subtypes: ['Plains'] },
  oracleText: '({T}: Add {W}.)',
});

// --- compile: the enters-tapped wordings ------------------------------------------

describe('enters-tapped templates — the slowland and battleland cycles', () => {
  it('compiles Deserted Beach completely ("two or more other lands")', () => {
    const result = compileCard(DESERTED_BEACH);
    expect(result.status, JSON.stringify(result.missing)).toBe('complete');
    expect(result.definition.entersTappedUnless).toEqual({ minOtherLands: 2 });
    // It is NOT the unconditional tapland — that flag would make it always tapped.
    expect(result.definition.entersTapped).toBeUndefined();
  });

  it('compiles Prairie Stream completely ("two or more basic lands")', () => {
    const result = compileCard(PRAIRIE_STREAM);
    expect(result.status, JSON.stringify(result.missing)).toBe('complete');
    expect(result.definition.entersTappedUnless).toEqual({ minBasicLands: 2 });
  });

  it('carries the printed Basic supertype onto the definition', () => {
    // The battleland condition counts THIS flag. Without it a basic Plains and
    // a nonbasic dual printing "Plains" would be indistinguishable.
    const result = compileCard(BASIC_PLAINS);
    expect(result.definition.basic).toBe(true);
    expect(compileCard(PRAIRIE_STREAM).definition.basic).toBeUndefined();
  });

  it('REFUSES a count outside the closed number table rather than guessing', () => {
    const result = compileCard(
      makeCard({
        name: 'Test Slowland',
        typeLine: { supertypes: [], types: ['Land'], subtypes: [] },
        oracleText: 'This land enters tapped unless you control seventeen or more other lands.',
      }),
    );
    expect(result.status).toBe('incomplete');
  });

  it('REFUSES "unless you control two or more creatures" — a condition it does not implement', () => {
    const result = compileCard(
      makeCard({
        name: 'Test Creatureland',
        typeLine: { supertypes: [], types: ['Land'], subtypes: [] },
        oracleText: 'This land enters tapped unless you control two or more creatures.',
      }),
    );
    expect(result.status).toBe('incomplete');
  });
});

// --- play helpers ----------------------------------------------------------------

function getByName(name: string): CardDefinition {
  const card = CARD_POOL.find((c) => c.name === name);
  if (!card) throw new Error(`pool missing ${name}`);
  return card;
}

const ISLAND = getByName('Island');
const PLAINS = getByName('Plains');
const FOREST = getByName('Forest');

function deck(def: CardDefinition, n = DECK_SIZE): { cards: CardDefinition[] } {
  return { cards: Array.from({ length: n }, () => def) };
}

function act(state: GameState, action: GameAction, reg: Registry): GameState {
  const result = applyAction(state, action, DEFAULT_RULES, reg);
  const rejected = result.events.find((e) => e.type === 'actionRejected');
  if (rejected) {
    throw new Error(
      `unexpected rejection: ${(rejected as { reason: string }).reason}\n${dumpState(state)}`,
    );
  }
  return result.state;
}

function pass(state: GameState, reg: Registry): GameState {
  return act(state, { kind: 'passPriority', player: state.priorityPlayer }, reg);
}

/** Advance (by passing) until the named step, or until a question is parked. */
function advanceToStep(
  state: GameState,
  step: GameState['step'],
  reg: Registry,
  max = 400,
): GameState {
  let s = state;
  let guard = 0;
  while (s.step !== step && !s.gameOver && !s.pendingChoice && guard++ < max) s = pass(s, reg);
  return s;
}

/** Fill a player's pool so cost payment is never what a test is measuring. */
function floodMana(state: GameState, player: PlayerId): void {
  const plenty = DECK_SIZE;
  state.players[player].manaPool = {
    W: plenty,
    U: plenty,
    B: plenty,
    R: plenty,
    G: plenty,
    C: plenty,
  };
}

let syntheticId = 93_000;

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

/** A game sitting in the starting player's first main phase, hands cleared. */
function gameAtMain(reg: Registry, seed: number): GameState {
  const { state } = createGame({
    seed,
    startingPlayer: 'A',
    registry: reg,
    decks: { A: deck(ISLAND), B: deck(ISLAND) },
  });
  const s = advanceToStep(state, 'precombatMain', reg);
  s.players.A.hand = [];
  s.players.B.hand = [];
  return s;
}

function answer(state: GameState, reg: Registry, value: ChoiceAnswer): GameState {
  const choice = state.pendingChoice;
  if (!choice) throw new Error(`no choice pending:\n${dumpState(state)}`);
  return act(
    state,
    { kind: 'answerChoice', player: choice.chooser, choiceId: choice.id, answer: value },
    reg,
  );
}

/** Resolve the stack, answering each parked question with `reply`. */
function settle(
  state: GameState,
  reg: Registry,
  reply: (choice: PendingChoice, state: GameState) => ChoiceAnswer,
  max = 60,
): GameState {
  let s = state;
  let guard = 0;
  while ((s.stack.length > 0 || s.pendingChoice) && !s.gameOver && guard++ < max) {
    s = s.pendingChoice ? answer(s, reg, reply(s.pendingChoice, s)) : pass(s, reg);
  }
  if (guard >= max) throw new Error(`resolution did not settle:\n${dumpState(s)}`);
  return s;
}

/** Put `def` on the battlefield under `player`, already resolved. */
function putOnBattlefield(state: GameState, def: CardDefinition, player: PlayerId): CardInstance {
  const card = instance(def, player, 'battlefield');
  state.battlefield.push(card);
  return card;
}

/** Play `def` as a land from `player`'s hand and hand back the new permanent. */
function playLand(
  state: GameState,
  def: CardDefinition,
  player: PlayerId,
  reg: Registry,
): { state: GameState; land: CardInstance } {
  const card = instance(def, player, 'hand');
  state.players[player].hand.push(card);
  state.players[player].landsPlayedThisTurn = 0;
  const next = act(state, { kind: 'playLand', player, instanceId: card.instanceId }, reg);
  const land = next.battlefield.find((c) => c.instanceId === card.instanceId);
  if (!land) throw new Error(`land never reached the battlefield:\n${dumpState(next)}`);
  return { state: next, land };
}

// --- play: the enters-tapped cycles behave as printed -----------------------------

describe('enters-tapped templates — played in a real game', () => {
  it('a slowland enters TAPPED with one other land and UNTAPPED with two', () => {
    const reg = buildRegistry();
    const beach = compileCard(DESERTED_BEACH).definition;

    const early = gameAtMain(reg, SEEDS.slowland);
    putOnBattlefield(early, ISLAND, 'A');
    expect(playLand(early, beach, 'A', reg).land.tapped).toBe(true);

    const late = gameAtMain(reg, SEEDS.slowland);
    putOnBattlefield(late, ISLAND, 'A');
    putOnBattlefield(late, ISLAND, 'A');
    expect(playLand(late, beach, 'A', reg).land.tapped).toBe(false);
  });

  it("a slowland does not count the OPPONENT's lands", () => {
    const reg = buildRegistry();
    const beach = compileCard(DESERTED_BEACH).definition;
    const state = gameAtMain(reg, SEEDS.slowland);
    putOnBattlefield(state, ISLAND, 'B');
    putOnBattlefield(state, ISLAND, 'B');
    expect(playLand(state, beach, 'A', reg).land.tapped).toBe(true);
  });

  it('a battleland counts BASIC lands only — two nonbasic duals leave it tapped', () => {
    const reg = buildRegistry();
    const stream = compileCard(PRAIRIE_STREAM).definition;

    const withBasics = gameAtMain(reg, SEEDS.battleland);
    putOnBattlefield(withBasics, PLAINS, 'A');
    putOnBattlefield(withBasics, ISLAND, 'A');
    expect(playLand(withBasics, stream, 'A', reg).land.tapped).toBe(false);

    // Two more battlelands are lands with the same printed SUBTYPES and no
    // Basic supertype. The printed card does not count them, and neither do we.
    const withDuals = gameAtMain(reg, SEEDS.battleland);
    putOnBattlefield(withDuals, stream, 'A');
    putOnBattlefield(withDuals, stream, 'A');
    expect(playLand(withDuals, stream, 'A', reg).land.tapped).toBe(true);
  });

  it('a slowland that entered untapped taps for the mana it prints', () => {
    const reg = buildRegistry();
    const beach = compileCard(DESERTED_BEACH).definition;
    const state = gameAtMain(reg, SEEDS.slowland);
    putOnBattlefield(state, ISLAND, 'A');
    putOnBattlefield(state, ISLAND, 'A');
    const played = playLand(state, beach, 'A', reg);
    const after = act(
      played.state,
      { kind: 'tapForMana', player: 'A', instanceId: played.land.instanceId, mode: 0 },
      reg,
    );
    expect(after.players.A.manaPool.W).toBe(1);
    expect(after.players.A.manaPool.U).toBe(0);
  });
});
