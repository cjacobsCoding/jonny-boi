/**
 * §3.143 — THE REAL PRINTED CARDS, compiled from their Oracle text and then
 * PLAYED through the real engine with this package's primitives.
 *
 * The compiler half alone proves nothing: a rule that fills in `cost.hybrid`
 * with the right shape and an engine that charges the wrong thing would both be
 * green. So every card here is compiled `'complete'` from the text WotC printed
 * on it, and then cast — once for its mana, once for its life — with the life
 * total, the mana pool and the board read afterwards.
 *
 * Dismember and Gut Shot are two of the three cards the 2,100-card corpus says
 * this system unblocked on its own, and they are the two shapes that matter: a
 * cost with a mana part beside its Phyrexian symbols, and a cost that is nothing
 * BUT one. (The third, Phyrexian Metamorph, is a clone — its cost is covered by
 * the corpus-wide mana-value check in `compile/mana-value-parity.test.ts`, and
 * its body is the copy system's, not this one's.) Flame Javelin is the
 * monocolour-hybrid representative, here even though that half of the system
 * unblocked nothing measurable, because a family with no card playing it is a
 * family nobody can see working.
 */

import { describe, expect, it } from 'vitest';
import type { CardDefinition, GameAction, GameState } from '@jonny-boi/core';
import {
  applyAction,
  colorsOfDefinition,
  convertedManaCost,
  createGame,
  DEFAULT_RULES,
  formatManaCost,
  generateLegalActions,
} from '@jonny-boi/core';
import { compileCard, type CompilableCard } from './compile/index.js';
import { buildRegistry } from './pool.js';
import { CARD_POOL } from '../data/pool.js';

// --- the real printed records -----------------------------------------------------

function record(overrides: Partial<CompilableCard> & Pick<CompilableCard, 'name' | 'oracleText'>): CompilableCard {
  return {
    id: `printed:${overrides.name}`,
    manaCost: { generic: 0, W: 0, U: 0, B: 0, R: 0, G: 0, C: 0, other: [] },
    typeLine: { supertypes: [], types: ['Instant'], subtypes: [] },
    power: null,
    toughness: null,
    keywords: [],
    ...overrides,
  };
}

/** Dismember — `{1}{B/P}{B/P}`, New Phyrexia. Two Phyrexian symbols. */
const DISMEMBER = record({
  name: 'Dismember',
  manaCost: { generic: 1, W: 0, U: 0, B: 0, R: 0, G: 0, C: 0, other: ['B/P', 'B/P'] },
  oracleText: 'Target creature gets -5/-5 until end of turn.',
});

/** Gut Shot — `{R/P}`. One symbol, and a spell castable for no mana at all. */
const GUT_SHOT = record({
  name: 'Gut Shot',
  manaCost: { generic: 0, W: 0, U: 0, B: 0, R: 0, G: 0, C: 0, other: ['R/P'] },
  oracleText: 'Gut Shot deals 1 damage to any target.',
});

/** Flame Javelin — `{2/R}{2/R}{2/R}`, Shadowmoor. Mana value 6, paid six ways. */
const FLAME_JAVELIN = record({
  name: 'Flame Javelin',
  manaCost: { generic: 0, W: 0, U: 0, B: 0, R: 0, G: 0, C: 0, other: ['2/R', '2/R', '2/R'] },
  oracleText: 'Flame Javelin deals 4 damage to any target.',
});

describe('§3.143 the printed cards compile COMPLETE', () => {
  it('Dismember — {1}{B/P}{B/P}, mana value 3, black', () => {
    const result = compileCard(DISMEMBER);
    expect(result.missing).toEqual([]);
    expect(result.status).toBe('complete');
    expect(formatManaCost(result.definition.cost ?? {})).toBe('{1}{B/P}{B/P}');
    expect(convertedManaCost(result.definition.cost ?? {})).toBe(3);
    expect(colorsOfDefinition(result.definition)).toEqual(['B']);
  });

  it('Gut Shot — {R/P}, mana value 1, red', () => {
    const result = compileCard(GUT_SHOT);
    expect(result.missing).toEqual([]);
    expect(result.status).toBe('complete');
    expect(formatManaCost(result.definition.cost ?? {})).toBe('{R/P}');
    expect(convertedManaCost(result.definition.cost ?? {})).toBe(1);
    expect(colorsOfDefinition(result.definition)).toEqual(['R']);
  });

  it('Flame Javelin — {2/R}{2/R}{2/R}, mana value SIX, red', () => {
    const result = compileCard(FLAME_JAVELIN);
    expect(result.missing).toEqual([]);
    expect(result.status).toBe('complete');
    expect(formatManaCost(result.definition.cost ?? {})).toBe('{2/R}{2/R}{2/R}');
    // The greatest component per symbol, not one each — the number the card
    // index reconciles against and every "mana value N or less" filter reads.
    expect(convertedManaCost(result.definition.cost ?? {})).toBe(6);
    expect(colorsOfDefinition(result.definition)).toEqual(['R']);
  });
});

// --- played through the real engine ------------------------------------------------

type Registry = ReturnType<typeof buildRegistry>;

function poolCard(name: string): CardDefinition {
  const found = CARD_POOL.find((card) => card.name === name);
  if (!found) throw new Error(`pool missing ${name}`);
  return found;
}

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

/** A's precombat main with empty hands, decked with `land`. */
function gameAtMain(reg: Registry, land: CardDefinition): GameState {
  const created = createGame({
    seed: 0x9d15,
    startingPlayer: 'A',
    registry: reg,
    decks: { A: deck(land), B: deck(land) },
  });
  let state = created.state;
  let guard = 0;
  while (state.step !== 'precombatMain' && !state.gameOver && guard++ < 50) state = pass(state, reg);
  state.players.A.hand = [];
  state.players.B.hand = [];
  return state;
}

function place(state: GameState, player: 'A' | 'B', zone: 'hand' | 'battlefield', def: CardDefinition): number {
  const instanceId = state.nextInstanceId++;
  const instance = {
    instanceId,
    def,
    controller: player,
    owner: player,
    zone,
    tapped: false,
    summoningSick: false,
    damageMarked: 0,
    markedByDeathtouch: false,
    attachedTo: null,
    counters: {},
  };
  if (zone === 'battlefield') state.battlefield.push(instance as never);
  else state.players[player].hand.push(instance as never);
  return instanceId;
}

/** Tap every untapped source A controls into its pool. */
function tapAll(state: GameState, reg: Registry): GameState {
  let next = state;
  for (;;) {
    const tap = generateLegalActions(next, DEFAULT_RULES).find(
      (a) => a.kind === 'tapForMana' && a.player === 'A',
    );
    if (!tap) return next;
    next = act(next, tap, reg);
  }
}

function castOffers(state: GameState, instanceId: number): Extract<GameAction, { kind: 'castSpell' }>[] {
  return generateLegalActions(state, DEFAULT_RULES).filter(
    (a): a is Extract<GameAction, { kind: 'castSpell' }> => a.kind === 'castSpell' && a.instanceId === instanceId,
  );
}

const SWAMP = poolCard('Swamp');
const MOUNTAIN = poolCard('Mountain');
const PLAINS = poolCard('Plains');
/** A vanilla body big enough that Dismember's -5/-5 killing it is unambiguous. */
const VICTIM = poolCard('Serra Angel');

describe('§3.143 the printed cards PLAYED', () => {
  it('Dismember kills a creature off one land and four life', () => {
    const reg = buildRegistry();
    const dismember = compileCard(DISMEMBER).definition;
    let state = gameAtMain(reg, PLAINS);
    const victim = place(state, 'B', 'battlefield', VICTIM);
    const spell = place(state, 'A', 'hand', dismember);
    place(state, 'A', 'battlefield', PLAINS);
    state = tapAll(state, reg);
    const lifeBefore = state.players.A.life;

    // No black anywhere on this board, so the only reading is {1} and 4 life —
    // which is the entire reason the card prints the symbol.
    const offers = castOffers(state, spell);
    expect(offers.map((a) => a.phyrexianLife ?? 0)).toEqual([4]);

    state = act(state, offers[0]!, reg);
    state = pass(pass(state, reg), reg);

    expect(state.players.A.life).toBe(lifeBefore - 4);
    expect(state.battlefield.find((c) => c.instanceId === victim)).toBeUndefined();
    expect(state.players.B.graveyard.map((c) => c.def.name)).toContain(VICTIM.name);
  });

  it('Dismember off three Swamps offers all three readings, and the mana one costs no life', () => {
    const reg = buildRegistry();
    const dismember = compileCard(DISMEMBER).definition;
    let state = gameAtMain(reg, SWAMP);
    const victim = place(state, 'B', 'battlefield', VICTIM);
    const spell = place(state, 'A', 'hand', dismember);
    for (let i = 0; i < 3; i++) place(state, 'A', 'battlefield', SWAMP);
    state = tapAll(state, reg);
    const lifeBefore = state.players.A.life;

    expect(castOffers(state, spell).map((a) => a.phyrexianLife ?? 0)).toEqual([0, 2, 4]);

    const allMana = castOffers(state, spell).find((a) => (a.phyrexianLife ?? 0) === 0);
    state = act(state, allMana!, reg);
    expect(state.players.A.life).toBe(lifeBefore);
    expect(state.players.A.manaPool.B).toBe(0); // all three Swamps spent
    state = pass(pass(state, reg), reg);
    expect(state.battlefield.find((c) => c.instanceId === victim)).toBeUndefined();
  });

  it('Dismember paid with LIFE off three Swamps leaves the black mana in the pool', () => {
    // The same board, the other answer. This is what makes the decision real: a
    // payment free to spend the mana anyway would have taken the life AND the
    // Swamps, which is strictly worse than the card the player announced.
    const reg = buildRegistry();
    const dismember = compileCard(DISMEMBER).definition;
    let state = gameAtMain(reg, SWAMP);
    place(state, 'B', 'battlefield', VICTIM);
    const spell = place(state, 'A', 'hand', dismember);
    for (let i = 0; i < 3; i++) place(state, 'A', 'battlefield', SWAMP);
    state = tapAll(state, reg);
    const lifeBefore = state.players.A.life;

    const maxLife = castOffers(state, spell).find((a) => a.phyrexianLife === 4);
    expect(maxLife, 'the 4-life reading should be on the menu').toBeDefined();
    state = act(state, maxLife!, reg);

    expect(state.players.A.life).toBe(lifeBefore - 4);
    // One Swamp paid the {1}; the other two are still floating, which is the
    // whole point of choosing this reading.
    expect(state.players.A.manaPool.B).toBe(2);
  });

  it('Gut Shot is cast for NO MANA AT ALL, and costs exactly 2 life', () => {
    const reg = buildRegistry();
    const gutShot = compileCard(GUT_SHOT).definition;
    let state = gameAtMain(reg, PLAINS);
    const spell = place(state, 'A', 'hand', gutShot);
    const lifeBefore = state.players.A.life;
    const oppBefore = state.players.B.life;

    // An empty board and an empty pool: the whole cost is the life.
    const offers = castOffers(state, spell);
    expect(offers.map((a) => a.phyrexianLife ?? 0)).toEqual([2]);

    state = act(state, { ...offers[0]!, targets: ['B'] }, reg);
    state = pass(pass(state, reg), reg);

    expect(state.players.A.life).toBe(lifeBefore - 2);
    expect(state.players.B.life).toBe(oppBefore - 1);
  });

  it('Flame Javelin is cast off six PLAINS — the generic half of every symbol', () => {
    const reg = buildRegistry();
    const javelin = compileCard(FLAME_JAVELIN).definition;
    let state = gameAtMain(reg, PLAINS);
    const spell = place(state, 'A', 'hand', javelin);
    for (let i = 0; i < 6; i++) place(state, 'A', 'battlefield', PLAINS);
    state = tapAll(state, reg);
    const lifeBefore = state.players.A.life;
    const oppBefore = state.players.B.life;

    const offers = castOffers(state, spell);
    expect(offers).toHaveLength(1);
    expect(offers[0]!.phyrexianLife).toBeUndefined(); // no life in this family

    state = act(state, { ...offers[0]!, targets: ['B'] }, reg);

    // SIX white paid three {2} symbols and nothing is left over. Asserting the
    // pool, not just the cast, is what catches a payment that charged one mana
    // per symbol while the OFFER gate still demanded two — the offer and the
    // charge are two searches, and two searches can disagree.
    expect(state.players.A.manaPool.W).toBe(0);

    state = pass(pass(state, reg), reg);
    expect(state.players.A.life).toBe(lifeBefore); // a mana cost, not a life one
    expect(state.players.B.life).toBe(oppBefore - 4);
  });

  it('Flame Javelin is cast off three MOUNTAINS — the colour half of every symbol', () => {
    const reg = buildRegistry();
    const javelin = compileCard(FLAME_JAVELIN).definition;
    let state = gameAtMain(reg, MOUNTAIN);
    const spell = place(state, 'A', 'hand', javelin);
    for (let i = 0; i < 3; i++) place(state, 'A', 'battlefield', MOUNTAIN);
    state = tapAll(state, reg);
    const oppBefore = state.players.B.life;

    const offers = castOffers(state, spell);
    expect(offers).toHaveLength(1);
    state = act(state, { ...offers[0]!, targets: ['B'] }, reg);
    state = pass(pass(state, reg), reg);
    expect(state.players.B.life).toBe(oppBefore - 4);
  });

  it('Flame Javelin is cast off ONE Mountain and four Plains — a MIXED assignment', () => {
    // {R} pays one symbol, {2}{2} pays the other two. Neither the all-colour nor
    // the all-generic reading fits this board, so a greedy payment fails it and
    // an exhaustive one does not.
    const reg = buildRegistry();
    const javelin = compileCard(FLAME_JAVELIN).definition;
    let state = gameAtMain(reg, PLAINS);
    const spell = place(state, 'A', 'hand', javelin);
    place(state, 'A', 'battlefield', MOUNTAIN);
    for (let i = 0; i < 4; i++) place(state, 'A', 'battlefield', PLAINS);
    state = tapAll(state, reg);
    const oppBefore = state.players.B.life;

    const offers = castOffers(state, spell);
    expect(offers).toHaveLength(1);
    state = act(state, { ...offers[0]!, targets: ['B'] }, reg);
    state = pass(pass(state, reg), reg);
    expect(state.players.B.life).toBe(oppBefore - 4);
  });

  it('Flame Javelin is NOT castable one pip short of every reading', () => {
    const reg = buildRegistry();
    const javelin = compileCard(FLAME_JAVELIN).definition;
    let state = gameAtMain(reg, PLAINS);
    const spell = place(state, 'A', 'hand', javelin);
    // Two Mountains and one Plains. The cheapest reading of this cost is three
    // {R} (three mana); with only two red the third symbol must be a {2}, and
    // one Plains is one short of it. Three sources, four mana of demand.
    for (let i = 0; i < 2; i++) place(state, 'A', 'battlefield', MOUNTAIN);
    place(state, 'A', 'battlefield', PLAINS);
    state = tapAll(state, reg);
    expect(castOffers(state, spell)).toEqual([]);
  });
});
