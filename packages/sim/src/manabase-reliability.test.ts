/**
 * RELIABILITY IS READ OFF REAL GAMES (DESIGN §3.175).
 *
 * Three layers, each falsifiable on its own:
 *  1. the WATCH, driven by a scripted sequence of states and events with known
 *     answers — a kept one-lander misses its second and third drops, a held land
 *     is a miss the pilot owns, colour screw is judged once per turn after the
 *     drop;
 *  2. the SEAM, on whole games: `onState` fires at every decision, a landless
 *     deck misses every judged drop, a Plains-and-Elves deck is colour-screwed;
 *  3. the COMPARISON, on a real deck rigged to 15 lands against its 24-land
 *     self over a seeded paired run: the 15-land deck is reported LESS reliable.
 * Plus the paired runner's contract: no watch ⇒ nothing changes; a watch ⇒ every
 * base record and variant slot carries a reading, a skipped game inheriting the
 * base's.
 */

import { describe, expect, it } from 'vitest';
import { buildRegistry, loadCardPool } from '@jonny-boi/cards';
import { createDefaultAiRegistry, HEURISTIC_PILOT_ID, type Pilot } from '@jonny-boi/ai';
import { createGame, type CardDefinition, type GameState, type PlayerId } from '@jonny-boi/core';
import { MONO_RED_AGGRO, SELESNYA_BLINK } from '../data/decks/index.js';
import type { Deck, LoadedDeck } from './deck.js';
import { loadDeck } from './deck.js';
import type { MatchupPilots } from './matchup.js';
import { makeSeats } from './matchup.js';
import { runMatch } from './match.js';
import { createPairedArmRunner } from './paired-arms.js';
import { applySwap } from './swap.js';
import {
  compareReliability,
  createReliabilityWatch,
  meanInterval,
  pairedMeanPValue,
  reliabilityOf,
  summarizeReliability,
} from './manabase-reliability.js';
import { RELIABILITY_METRICS, RELIABILITY_NOT_MEASURED } from './manabase-config.js';
import { runManabaseSweep } from './manabase-run.js';

const pool = loadCardPool({ onWarn: () => {} });
const registry = buildRegistry();
const ai = createDefaultAiRegistry();
const pilots = (): MatchupPilots => ({
  pilotA: ai.getPilot(HEURISTIC_PILOT_ID) as Pilot,
  pilotB: ai.getPilot(HEURISTIC_PILOT_ID) as Pilot,
});

const FOREST: CardDefinition = { id: 'Forest', name: 'Forest', types: ['land'], subtypes: ['forest'], basic: true, produces: ['G'] };
const PLAINS: CardDefinition = { id: 'Plains', name: 'Plains', types: ['land'], subtypes: ['plains'], basic: true, produces: ['W'] };
const ELF: CardDefinition = { id: 'elf', name: 'Elf', types: ['creature'], cost: { G: 1 }, power: 1, toughness: 1 };

// --- 1. the watch, scripted ----------------------------------------------------------

/** A real state to script against (its shape is what the watch reads). */
function scriptedState(): GameState {
  const { state } = createGame({ seed: 11, decks: { A: { cards: Array(30).fill(FOREST) }, B: { cards: Array(30).fill(FOREST) } } });
  state.battlefield = [];
  return state;
}

/** Put a permanent under `player`'s control (the soak's own helper shape). */
function place(state: GameState, player: PlayerId, def: CardDefinition): void {
  state.battlefield.push({
    instanceId: state.nextInstanceId++,
    def,
    controller: player,
    owner: player,
    zone: 'battlefield',
    tapped: false,
    summoningSick: false,
    damageMarked: 0,
    markedByDeathtouch: false,
    counters: {},
  } as never);
}

function handOf(state: GameState, defs: readonly CardDefinition[]): void {
  const template = state.players.A.hand[0] as GameState['players']['A']['hand'][number];
  state.players.A.hand = defs.map((def, i) => ({ ...template, instanceId: 900 + i, def }) as never);
}

/** Show the watch a main-phase priority window for the hero with this hand. */
function heroMain(state: GameState, watch: ReturnType<typeof createReliabilityWatch>, turn: number, hand: readonly CardDefinition[], landsPlayed: number): void {
  state.turnNumber = turn;
  state.activePlayer = 'A';
  state.priorityPlayer = 'A';
  state.step = 'precombatMain';
  state.stack = [];
  state.players.A.landsPlayedThisTurn = landsPlayed;
  handOf(state, hand);
  watch.onState?.(state);
}

describe('the reliability watch on a scripted game', () => {
  it('a kept one-lander misses its second and third drops; a held land is the pilot’s miss; colour screw is judged after the drop', () => {
    const watch = createReliabilityWatch('A');
    const state = scriptedState();

    // Hero turn 1 (game turn 1): plays its only land.
    watch.onEvent?.({ type: 'turnBegin', turn: 1, activePlayer: 'A' });
    heroMain(state, watch, 1, [FOREST, ELF, ELF], 0);
    watch.onEvent?.({ type: 'landPlayed', player: 'A', instanceId: 900 });
    place(state, 'A', FOREST);
    heroMain(state, watch, 1, [ELF, ELF], 1);
    watch.onEvent?.({ type: 'turnBegin', turn: 2, activePlayer: 'B' });

    // Hero turn 2: no land in hand, none played — a miss the DECK owns.
    watch.onEvent?.({ type: 'turnBegin', turn: 3, activePlayer: 'A' });
    heroMain(state, watch, 3, [ELF, ELF], 0);
    watch.onEvent?.({ type: 'turnBegin', turn: 4, activePlayer: 'B' });

    // Hero turn 3: a Plains in hand, never played — a miss the PILOT owns; and
    // no colour judgement, because the window before the drop is not the one.
    watch.onEvent?.({ type: 'turnBegin', turn: 5, activePlayer: 'A' });
    heroMain(state, watch, 5, [PLAINS, ELF], 0);
    watch.onEvent?.({ type: 'turnBegin', turn: 6, activePlayer: 'B' });

    // Hero turn 4: lands read at the turn's first window (1 Forest on board);
    // then the Plains is played and the hand's Elf is castable — no screw.
    watch.onEvent?.({ type: 'turnBegin', turn: 7, activePlayer: 'A' });
    state.turnNumber = 7;
    state.activePlayer = 'A';
    state.priorityPlayer = 'A';
    state.step = 'upkeep';
    watch.onState?.(state);
    heroMain(state, watch, 7, [PLAINS, ELF], 0);
    watch.onEvent?.({ type: 'landPlayed', player: 'A', instanceId: 900 });
    place(state, 'A', PLAINS);
    heroMain(state, watch, 7, [ELF], 1);
    watch.onEvent?.({ type: 'turnBegin', turn: 8, activePlayer: 'B' });

    // Hero turn 5: two Plains on the board, an Elf ({G}) in hand — total mana
    // covers it, the colours do not: screwed. Judged once although two windows.
    state.battlefield = [];
    place(state, 'A', PLAINS);
    place(state, 'A', PLAINS);
    watch.onEvent?.({ type: 'turnBegin', turn: 9, activePlayer: 'A' });
    heroMain(state, watch, 9, [ELF], 0);
    heroMain(state, watch, 9, [ELF], 0);
    watch.onEvent?.({ type: 'turnBegin', turn: 10, activePlayer: 'B' });

    // Hero turn 6, cut short by the game ending: a land held, none played — and
    // NOT judged a miss, because the turn never completed. (Colour screw is
    // judged at its window, so it would count mid-turn; a land in hand keeps
    // the window closed here.)
    watch.onEvent?.({ type: 'turnBegin', turn: 11, activePlayer: 'A' });
    heroMain(state, watch, 11, [FOREST], 0);

    const observation = reliabilityOf(watch.finish({} as never));
    expect(observation).toEqual({
      missedLandDrops: 2,
      heldLandTurns: 1,
      colourScrewTurns: 1,
      landsOnTurn4: 1,
      heroTurns: 6,
    });
  });

  it('a turn with a land played, or with no land and mana enough, is neither miss nor screw', () => {
    const watch = createReliabilityWatch('A');
    const state = scriptedState();
    place(state, 'A', FOREST);
    for (let heroTurn = 1; heroTurn <= 4; heroTurn++) {
      const gameTurn = heroTurn * 2 - 1;
      watch.onEvent?.({ type: 'turnBegin', turn: gameTurn, activePlayer: 'A' });
      heroMain(state, watch, gameTurn, [FOREST, ELF], 0);
      watch.onEvent?.({ type: 'landPlayed', player: 'A', instanceId: 900 });
      place(state, 'A', FOREST);
      heroMain(state, watch, gameTurn, [ELF], 1);
      watch.onEvent?.({ type: 'turnBegin', turn: gameTurn + 1, activePlayer: 'B' });
    }
    expect(reliabilityOf(watch.finish({} as never))).toEqual({
      missedLandDrops: 0,
      heldLandTurns: 0,
      colourScrewTurns: 0,
      landsOnTurn4: 4,
      heroTurns: 4,
    });
  });

  it('refuses a foreign observation rather than reading zeros into it', () => {
    expect(reliabilityOf(null)).toBeUndefined();
    expect(reliabilityOf({ heroWon: true })).toBeUndefined();
    expect(reliabilityOf({ missedLandDrops: 1, heldLandTurns: 0, colourScrewTurns: 0, landsOnTurn4: 'three' as never, heroTurns: 5 })).toBeUndefined();
  });
});

// --- 2. the seam, on whole games -----------------------------------------------------

function library(name: string, cards: readonly CardDefinition[]): LoadedDeck {
  return { name, archetype: 'test', library: [...cards], size: cards.length };
}
const forests = (n: number): CardDefinition[] => Array(n).fill(FOREST) as CardDefinition[];
const elves = (n: number): CardDefinition[] => Array(n).fill(pool.getByName('Llanowar Elves') as CardDefinition) as CardDefinition[];

describe('the settled-state seam and the watch on whole games', () => {
  it('`onState` fires once per decision — as many times as actions were applied', () => {
    const seats = makeSeats(loadDeck(SELESNYA_BLINK, pool), loadDeck(MONO_RED_AGGRO, pool), pilots(), registry);
    let states = 0;
    const result = runMatch(seats, 424242, { onState: () => states++ });
    expect(result.actions).toBeGreaterThan(50);
    expect(states).toBe(result.actions);
  });

  it('a deck with NO lands misses every judged drop and has no lands on turn four — and is mana-screwed, not colour-screwed', () => {
    const watch = createReliabilityWatch();
    // The opponent is sixty Forests: it never attacks, so the game runs its turns out.
    const seats = makeSeats(library('No Lands', elves(60)), library('All Forests', forests(60)), pilots(), registry);
    const result = runMatch(seats, 99, { onEvent: watch.onEvent, onState: watch.onState });
    expect(result.outcome.kind).toBe('timeout');
    expect(reliabilityOf(watch.finish(result))).toMatchObject({
      missedLandDrops: 3,
      heldLandTurns: 0,
      colourScrewTurns: 0,
      landsOnTurn4: 0,
    });
  });

  it('a Plains-and-Elves deck is colour-screwed on real turns', () => {
    const watch = createReliabilityWatch();
    const seats = makeSeats(library('Plains + Elves', [...Array(30).fill(PLAINS), ...elves(30)]), library('All Forests', forests(60)), pilots(), registry);
    const result = runMatch(seats, 5, { onEvent: watch.onEvent, onState: watch.onState });
    const observation = reliabilityOf(watch.finish(result));
    expect(observation).toBeDefined();
    expect(observation!.heroTurns).toBeGreaterThan(4);
    expect(observation!.colourScrewTurns).toBeGreaterThan(0);
    expect(observation!.landsOnTurn4).toBeGreaterThan(0);
  });
});

// --- the paired runner's contract -------------------------------------------------

describe('the paired runner with and without a watch', () => {
  const gauntlet = [loadDeck(MONO_RED_AGGRO, pool)];
  const SEED = 20260919;
  /** A legal swap on Selesnya Blink (Llanowar Elves is not in the list, so a playset fits). */
  const CANDIDATE = { out: 'Wall of Blossoms', in: 'Llanowar Elves' } as const;

  it('without a watch nothing about a record or a slice changes', () => {
    const runner = createPairedArmRunner(SELESNYA_BLINK, { gauntletDecks: gauntlet, pilots: pilots(), pool, registry, seed: SEED });
    expect(runner.baseRecordAt(0)).not.toHaveProperty('observed');
    const slice = runner.playSlice(CANDIDATE, CANDIDATE.out, CANDIDATE.in, 0, 2);
    expect(slice).not.toHaveProperty('observedBySlot');
    const arm = runner.advance(runner.openArm(CANDIDATE, CANDIDATE.out, CANDIDATE.in), 2);
    expect(arm).not.toHaveProperty('observedBySlot');
  });

  it('with a watch every base record and variant slot carries a reading, a skipped game inheriting the base’s', () => {
    const runner = createPairedArmRunner(SELESNYA_BLINK, {
      gauntletDecks: gauntlet,
      pilots: pilots(),
      pool,
      registry,
      seed: SEED,
      // One copy, so most games never draw the one slot and most variant games
      // are answered from the base record — observation included.
      runOptions: { swapScope: 'one' },
      watchGames: () => createReliabilityWatch(),
    });
    const games = 8;
    const arm = runner.advance(runner.openArm(CANDIDATE, CANDIDATE.out, CANDIDATE.in), games);
    expect(arm.variantGamesSkipped).toBeGreaterThan(0);
    expect(arm.observedBySlot).toHaveLength(games);
    for (let slot = 0; slot < games; slot++) {
      const base = runner.baseRecordAt(slot);
      expect(reliabilityOf(base.observed)).toBeDefined();
      expect(reliabilityOf(arm.observedBySlot?.[slot])).toBeDefined();
    }
    // The same slots through the pooled path come back with the same readings.
    const slice = runner.playSlice(CANDIDATE, CANDIDATE.out, CANDIDATE.in, 0, games);
    expect(slice.observedBySlot).toEqual(arm.observedBySlot);
  });

  it('a variant arm refuses a deck of another size, and reports the slots it changed', () => {
    const runner = createPairedArmRunner(SELESNYA_BLINK, { gauntletDecks: gauntlet, pilots: pilots(), pool, registry, seed: SEED });
    const shorter: Deck = { ...SELESNYA_BLINK, cards: SELESNYA_BLINK.cards.map((e) => (e.cardId === 'Forest' ? { ...e, count: 7 } : e)) };
    expect(() => runner.openVariantArm({ key: 'short', label: 'short', variantDeck: shorter, slotsChanged: 1 })).toThrow(
      /has 59 cards but the base deck has 60/,
    );
    const rewritten = applySwap(SELESNYA_BLINK, { out: 'Forest', in: 'Plains' }, pool, { copies: 2 });
    const handle = runner.openVariantArm({ key: 'mix:Forest>Plains:2', label: 'Forest/Plains 8/8 → 6/10', variantDeck: rewritten, slotsChanged: 2 });
    runner.advance(handle, 2);
    const evaluation = runner.summarize(handle);
    expect(evaluation.swap).toEqual({ out: 'base', in: 'mix:Forest>Plains:2' });
    expect(evaluation.inName).toBe('Forest/Plains 8/8 → 6/10');
    expect(evaluation.copiesSwapped).toBe(2);
    expect(evaluation.nGames).toBe(2);
  });
});

// --- 3. the comparison: 15 lands against 24 -----------------------------------------

/** Selesnya Blink rewritten in place down to 15 lands (nine basics became spells with room). */
function fifteenLandRig(): Deck {
  let deck: Deck = SELESNYA_BLINK;
  for (const [out, inn, copies] of [
    ['Forest', 'Elvish Visionary', 2],
    ['Forest', 'Lone Missionary', 2],
    ['Forest', 'Skyclave Cleric', 2],
    ['Plains', 'Restoration Angel', 2],
    ['Plains', "Conjurer's Closet", 1],
  ] as const) {
    deck = applySwap(deck, { out, in: inn }, pool, { copies });
  }
  return { ...deck, name: 'Selesnya Blink (15 lands)' };
}

describe('a deck rigged to 15 lands is reported less reliable than its 24-land self', () => {
  it('over a seeded paired run: more missed drops, fewer lands by turn four, verdicts the right way round', () => {
    const rig = fifteenLandRig();
    expect(loadDeck(rig, pool).library.filter((d) => d.types.includes('land'))).toHaveLength(15);
    const runner = createPairedArmRunner(rig, {
      gauntletDecks: [loadDeck(MONO_RED_AGGRO, pool)],
      pilots: pilots(),
      pool,
      registry,
      seed: 0xc0ffee,
      watchGames: () => createReliabilityWatch(),
    });
    const games = 40;
    const arm = runner.advance(
      runner.openVariantArm({ key: 'back-to-24', label: '24 lands (as built)', variantDeck: SELESNYA_BLINK, slotsChanged: 9 }),
      games,
    );
    const baseObserved = Array.from({ length: games }, (_, slot) => runner.baseRecordAt(slot).observed ?? null);
    const comparison = compareReliability(baseObserved, arm.observedBySlot ?? []);

    // The reading itself.
    expect(comparison.base.games).toBe(games);
    expect(comparison.variant.games).toBe(games);
    expect(comparison.base.missedLandDrop.p).toBeGreaterThan(comparison.variant.missedLandDrop.p);
    expect(comparison.base.landsOnTurn4.mean).toBeLessThan(comparison.variant.landsOnTurn4.mean);
    // And the paired verdicts: the 24-land deck is BETTER on drops and on lands.
    const byId = new Map(comparison.metrics.map((m) => [m.id, m] as const));
    expect(byId.get('missedLandDrop')?.verdict).toBe('better');
    expect(byId.get('landsOnTurn4')?.verdict).toBe('better');
    expect(comparison.notWorse).toBe(true);
    // The reverse comparison says the opposite — the rule is not one-sided.
    const reversed = compareReliability(arm.observedBySlot ?? [], baseObserved);
    expect(new Map(reversed.metrics.map((m) => [m.id, m.verdict])).get('missedLandDrop')).toBe('worse');
    expect(reversed.notWorse).toBe(false);
  }, 120_000);
});

// --- the aggregate shapes ----------------------------------------------------------------

describe('aggregation', () => {
  it('a summary over readings has the closed metric set, with the foreign ones dropped', () => {
    const summary = summarizeReliability([
      { missedLandDrops: 1, heldLandTurns: 0, colourScrewTurns: 0, landsOnTurn4: 2, heroTurns: 6 },
      { missedLandDrops: 0, heldLandTurns: 0, colourScrewTurns: 2, landsOnTurn4: 4, heroTurns: 6 },
      null,
      { heroWon: true },
    ]);
    expect(summary.games).toBe(2);
    expect(summary.missedLandDrop.successes).toBe(1);
    expect(summary.colourScrew.successes).toBe(1);
    expect(summary.landsOnTurn4).toMatchObject({ mean: 3, n: 2 });
    expect(RELIABILITY_METRICS.map((m) => m.id)).toEqual(['missedLandDrop', 'colourScrew', 'landsOnTurn4']);
    expect(RELIABILITY_NOT_MEASURED.map((m) => m.id)).toEqual(['mulligan']);
  });

  it('mean intervals and the paired z-test behave at the edges', () => {
    expect(meanInterval([], 1.96)).toEqual({ mean: 0, low: 0, high: 0, n: 0 });
    expect(meanInterval([3], 1.96)).toEqual({ mean: 3, low: 3, high: 3, n: 1 });
    const ci = meanInterval([2, 4], 1.96);
    expect(ci.mean).toBe(3);
    expect(ci.low).toBeLessThan(3);
    expect(ci.high).toBeGreaterThan(3);
    expect(pairedMeanPValue([])).toBe(1);
    expect(pairedMeanPValue([0, 0, 0])).toBe(1);
    expect(pairedMeanPValue([1, 1, 1])).toBe(0);
    // A zero mean with spread: the two-sided tail of z = 0, within the erf
    // approximation's 1e-7 (it is 0.999999999, not a literal 1).
    expect(pairedMeanPValue([1, -1, 1, -1])).toBeCloseTo(1, 6);
    expect(pairedMeanPValue(Array(50).fill(1).map((v: number, i) => v + (i % 2 === 0 ? 0.1 : -0.1)))).toBeLessThan(0.001);
  });
});

// --- the whole sweep, inline -------------------------------------------------------------

describe('runManabaseSweep', () => {
  it('plays a small count sweep end to end and reports both axes per variant', () => {
    const report = runManabaseSweep(SELESNYA_BLINK, {
      gauntletDecks: [loadDeck(MONO_RED_AGGRO, pool)],
      pilots: pilots(),
      pool,
      registry,
      baseSeed: 0xc0ffee,
      gamesPerVariant: 4,
      sweep: { sweeps: { count: true, mix: false, type: false } },
    });
    expect(report.baseDeck).toBe('Selesnya Blink');
    expect(report.base.landCount).toBe(24);
    expect(report.results.map((r) => r.variant.key).sort()).toEqual(['count:+1', 'count:+2', 'count:-1', 'count:-2']);
    for (const row of report.results) {
      expect(row.gamesPlayed).toBe(4);
      expect(row.evaluation.nGames).toBe(4);
      expect(row.evaluation.inName).toBe(row.variant.label);
      expect(row.reliability.metrics.map((m) => m.id)).toEqual(['missedLandDrop', 'colourScrew', 'landsOnTurn4']);
      expect(row.reliability.base.games).toBe(4);
      expect(row.reliability.variant.games).toBe(4);
      // Four games cannot clear the verdict floor on either axis.
      expect(row.evaluation.verdict).toBe('inconclusive');
      expect(row.reliability.metrics.every((m) => m.verdict === 'inconclusive')).toBe(true);
    }
    expect(report.recommended).toBeNull();
    expect(report.recommendationRule).toMatch(/never blended/);
    expect(report.notMeasured[0]?.id).toBe('mulligan');
    expect(report.baseReliability.games).toBe(4);
    expect(report.notes.baseGamesPlayed).toBe(4);
    expect(report.notes.totalGamesRun).toBeGreaterThan(4);
    expect(report.multipleComparisons.familySize).toBe(4);
  }, 120_000);
});
