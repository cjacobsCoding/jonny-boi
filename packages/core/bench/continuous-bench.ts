/**
 * Hot-path microbenchmark for the continuous/static layering pass.
 *
 * Wall-clock gauntlet timings on a shared dev machine swing by 3x from CPU
 * contention alone, which makes a naive before/after pair worthless. This measures
 * the ONE function the static work changed — `indexContinuous`, which combat, SBAs,
 * legality checks and serialization all call — by running the previous
 * implementation and the current one ALTERNATELY inside a single process, so
 * whatever else the machine is doing hits both arms equally. Reported as a ratio of
 * medians, which is scale-free.
 *
 * Run: npx tsx packages/core/bench/continuous-bench.ts
 */

import { indexContinuous } from '../src/internal/continuous.js';
import type { AggregatedMod } from '../src/internal/continuous.js';
import type { CardDefinition, KeywordFlags } from '../src/card.js';
import type { CardInstance, GameState, InstanceId } from '../src/state.js';
import { createPlayer } from '../src/state.js';
import { emptyPool } from '../src/mana.js';

// --- the PREVIOUS implementation, verbatim, for an in-process A/B ------------------

const KEYWORD_KEYS: readonly (keyof KeywordFlags)[] = [
  'flying', 'vigilance', 'haste', 'firstStrike', 'doubleStrike',
  'deathtouch', 'trample', 'reach', 'defender', 'lifelink',
];

function mergeKeywords(into: Record<string, boolean>, grant: KeywordFlags | undefined): void {
  if (!grant) return;
  for (const key of KEYWORD_KEYS) {
    if (grant[key]) into[key] = true;
  }
}

/** `indexContinuous` as it was before statics existed (until-EOT effects only). */
function indexContinuousBefore(state: GameState): ReadonlyMap<InstanceId, AggregatedMod> {
  const map = new Map<InstanceId, { power: number; toughness: number; keywords: Record<string, boolean> }>();
  for (const eff of state.continuous) {
    let agg = map.get(eff.targetInstanceId);
    if (!agg) {
      agg = { power: 0, toughness: 0, keywords: {} };
      map.set(eff.targetInstanceId, agg);
    }
    agg.power += eff.power ?? 0;
    agg.toughness += eff.toughness ?? 0;
    mergeKeywords(agg.keywords, eff.keywords);
  }
  const out = new Map<InstanceId, AggregatedMod>();
  for (const [id, agg] of map) {
    out.set(id, { power: agg.power, toughness: agg.toughness, keywords: agg.keywords as KeywordFlags });
  }
  return out;
}

// --- boards ------------------------------------------------------------------------

const BENCH_SEED = 1;
const CREATURES_PER_SIDE = 5;
const LANDS_PER_SIDE = 5;

function creature(id: string): CardDefinition {
  return { id, name: id, types: ['creature'], subtypes: ['Goblin'], power: 2, toughness: 2, cost: { generic: 2 } };
}
const LAND: CardDefinition = { id: 'Mountain', name: 'Mountain', types: ['land'], produces: ['R'] };
const ANTHEM: CardDefinition = {
  id: 'Anthem', name: 'Anthem', types: ['enchantment'], cost: { generic: 2 },
  statics: [{ affects: { controller: 'you', anyOfTypes: ['creature'] }, power: 1, toughness: 1 }],
};

function permanent(state: GameState, def: CardDefinition, controller: 'A' | 'B'): CardInstance {
  return {
    instanceId: state.nextInstanceId++, def, controller, owner: controller, zone: 'battlefield',
    tapped: false, summoningSick: false, damageMarked: 0, markedByDeathtouch: false, counters: {},
  };
}

/** A realistic mid-game board: two developed sides, optionally carrying anthems. */
function board(anthemsPerSide: number, temporaryEffects: number): GameState {
  const state: GameState = {
    nextInstanceId: 1, turnNumber: 8, activePlayer: 'A', priorityPlayer: 'A', step: 'declareAttackers',
    players: { A: createPlayer('A', 20), B: createPlayer('B', 20) },
    battlefield: [], stack: [], continuous: [], combat: null, winner: null, gameOver: false,
    consecutivePasses: 0, seed: BENCH_SEED, rngState: BENCH_SEED,
  };
  state.players.A.manaPool = emptyPool();
  state.players.B.manaPool = emptyPool();
  for (const side of ['A', 'B'] as const) {
    for (let i = 0; i < LANDS_PER_SIDE; i++) state.battlefield.push(permanent(state, LAND, side));
    for (let i = 0; i < CREATURES_PER_SIDE; i++) state.battlefield.push(permanent(state, creature(`C${i}`), side));
    for (let i = 0; i < anthemsPerSide; i++) state.battlefield.push(permanent(state, ANTHEM, side));
  }
  for (let i = 0; i < temporaryEffects; i++) {
    const target = state.battlefield[i % state.battlefield.length]!;
    state.continuous.push({
      id: state.nextInstanceId++, targetInstanceId: target.instanceId,
      sourceInstanceId: target.instanceId, duration: 'endOfTurn', power: 1, toughness: 1,
    });
  }
  return state;
}

// --- timing ------------------------------------------------------------------------

const ITERATIONS = 200_000;
const ROUNDS = 9;

function timeOne(fn: (s: GameState) => unknown, state: GameState): number {
  const start = process.hrtime.bigint();
  let sink = 0;
  for (let i = 0; i < ITERATIONS; i++) sink += (fn(state) as ReadonlyMap<number, unknown>).size;
  const end = process.hrtime.bigint();
  if (sink === -1) throw new Error('unreachable');
  return Number(end - start) / 1e6;
}

function median(xs: number[]): number {
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

function compare(label: string, state: GameState): void {
  const before: number[] = [];
  const after: number[] = [];
  // Warm both arms so JIT state is comparable, then alternate.
  timeOne(indexContinuousBefore, state);
  timeOne(indexContinuous, state);
  for (let r = 0; r < ROUNDS; r++) {
    before.push(timeOne(indexContinuousBefore, state));
    after.push(timeOne(indexContinuous, state));
  }
  const b = median(before);
  const a = median(after);
  const perCallNs = (ms: number): string => ((ms * 1e6) / ITERATIONS).toFixed(1);
  console.log(
    `${label.padEnd(34)} before ${perCallNs(b).padStart(7)} ns/call   after ${perCallNs(a).padStart(7)} ns/call   ` +
      `ratio ${(a / b).toFixed(2)}x`,
  );
}

console.log(`indexContinuous — ${ITERATIONS.toLocaleString()} calls x ${ROUNDS} interleaved rounds, median\n`);
compare('empty board, no effects', board(0, 0));
compare('20 permanents, no statics/effects', board(0, 0));
compare('20 permanents, 3 until-EOT effects', board(0, 3));
compare('20 permanents + 1 anthem per side', board(1, 0));
compare('20 permanents + 2 anthems/side + 3 EOT', board(2, 3));
