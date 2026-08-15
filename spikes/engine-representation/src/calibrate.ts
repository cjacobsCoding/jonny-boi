/**
 * CALIBRATION — how far does the model game let us extrapolate?
 *
 * The three arms all implement the model, not the product. That is the only way to
 * hold rules constant across three implementations, but it means every ratio the
 * bench reports is a ratio measured on a SMALLER game. This script measures the
 * real `packages/core` engine and the model in the SAME PROCESS, interleaved, so
 * the distance between them is a number in the report rather than a hand-wave.
 *
 * The quantities chosen are the ones the extrapolation actually rests on:
 *   - instances per state  — the clone and the SBA scan are both linear in it;
 *   - branching factor     — how much work one `generateLegalActions` does;
 *   - ns per action        — the rules surface the model omits;
 *   - ns per clone         — the cost arm B/C's undo journal removes.
 *
 * Run with the repo's tsx (the spike has no TypeScript toolchain of its own):
 *   <repo>/node_modules/.bin/tsx spikes/engine-representation/src/calibrate.ts
 */

import { applyAction, applyActionInPlace, createGame, generateLegalActions } from '../../../packages/core/src/engine.js';
import { DEFAULT_RULES } from '../../../packages/core/src/config.js';
import { cloneState } from '../../../packages/core/src/internal/clone.js';
import { createRng } from '../../../packages/core/src/rng.js';
import { playSelfPlayGame, selfPlayDecks, SELF_PLAY_ACTION_CAP } from '../../../packages/core/src/test-fixtures.js';
import type { GameAction } from '../../../packages/core/src/actions.js';
import type { GameState } from '../../../packages/core/src/state.js';

import * as ModelA from './arm-a-objects.mjs';

const GAMES = 40;
const ROUNDS = 7;
const WARMUP = 10;
const FIRST_SEED = 0xbeef;
const MIDGAME_ACTIONS = 400;
const CLONE_ITERS = 100_000;
const GEN_ITERS = 100_000;
const MODEL_SEED = 77;

const decks = selfPlayDecks();

function best(fn: () => void, rounds = ROUNDS): number {
  let b = Infinity;
  for (let r = 0; r < rounds; r++) {
    const t = process.hrtime.bigint();
    fn();
    b = Math.min(b, Number(process.hrtime.bigint() - t) / 1e6);
  }
  return b;
}

// --- real engine: throughput and branching -------------------------------------------

for (let i = 0; i < WARMUP; i++) playSelfPlayGame(decks, FIRST_SEED + 100_000 + i);

let realActions = 0;
const realMs = best(() => {
  realActions = 0;
  for (let i = 0; i < GAMES; i++) realActions += playSelfPlayGame(decks, FIRST_SEED + i).actions;
});

/** Branching factor: total actions OFFERED divided by actions TAKEN. */
function realBranching(): { branching: number; decisions: number } {
  const rng = createRng(FIRST_SEED);
  let state = createGame({ seed: FIRST_SEED, decks, config: DEFAULT_RULES }).state;
  let offered = 0;
  let decisions = 0;
  for (let i = 0; i < SELF_PLAY_ACTION_CAP && !state.gameOver; i++) {
    const legal = generateLegalActions(state, DEFAULT_RULES);
    if (legal.length === 0) break;
    offered += legal.length;
    decisions++;
    state = applyAction(state, legal[rng.nextInt(legal.length)] as GameAction, DEFAULT_RULES).state;
  }
  return { branching: offered / decisions, decisions };
}
const realBr = realBranching();

function realMidGame(): GameState {
  const rng = createRng(FIRST_SEED);
  let state = createGame({ seed: FIRST_SEED, decks, config: DEFAULT_RULES }).state;
  for (let i = 0; i < MIDGAME_ACTIONS && !state.gameOver; i++) {
    const legal = generateLegalActions(state, DEFAULT_RULES);
    if (legal.length === 0) break;
    state = applyAction(state, legal[rng.nextInt(legal.length)] as GameAction, DEFAULT_RULES).state;
  }
  return state;
}
const realMid = realMidGame();
const realInstances =
  realMid.battlefield.length +
  realMid.players.A.library.length + realMid.players.B.library.length +
  realMid.players.A.hand.length + realMid.players.B.hand.length +
  realMid.players.A.graveyard.length + realMid.players.B.graveyard.length;

let sink = 0;
const realCloneMs = best(() => {
  for (let i = 0; i < CLONE_ITERS; i++) sink += cloneState(realMid).turnNumber;
});
const realGenMs = best(() => {
  for (let i = 0; i < GEN_ITERS; i++) sink += generateLegalActions(realMid, DEFAULT_RULES).length;
});
/** Apply on an owned draft — the entry point MCTS uses, isolated from the clone. */
const realApplyMs = best(() => {
  for (let i = 0; i < GEN_ITERS; i++) {
    const draft = cloneState(realMid);
    const legal = generateLegalActions(draft, DEFAULT_RULES);
    applyActionInPlace(draft, legal[legal.length > 1 ? 1 : 0] as GameAction, DEFAULT_RULES);
    sink += draft.turnNumber;
  }
});
if (sink === -1) throw new Error('unreachable');

// --- the model, measured in the same process -----------------------------------------

for (let i = 0; i < WARMUP; i++) ModelA.playGame(0x9000 + i);
let modelActions = 0;
let modelOffered = 0;
const modelMs = best(() => {
  modelActions = 0;
  modelOffered = 0;
  for (let i = 0; i < GAMES; i++) {
    const r = ModelA.playGame(FIRST_SEED + i);
    modelActions += r.actions;
    modelOffered += r.generated;
  }
});
const modelCloneMs = best(() => ModelA.benchClone(MODEL_SEED, CLONE_ITERS));
const modelGenMs = best(() => ModelA.benchGenerate(MODEL_SEED, GEN_ITERS));
const modelInstances = ModelA.midGameInstanceCount(MODEL_SEED);

// --- report ---------------------------------------------------------------------------

const realNsPerAction = (realMs * 1e6) / realActions;
const modelNsPerAction = (modelMs * 1e6) / modelActions;
const realCloneNs = (realCloneMs * 1e6) / CLONE_ITERS;
const modelCloneNs = (modelCloneMs * 1e6) / CLONE_ITERS;
const realGenNs = (realGenMs * 1e6) / GEN_ITERS;
const modelGenNs = (modelGenMs * 1e6) / GEN_ITERS;

const row = (label: string, real: string, model: string, ratio: string) =>
  console.log(`${label.padEnd(30)} ${real.padStart(12)} ${model.padStart(12)}   ${ratio.padStart(10)}`);

console.log('='.repeat(76));
console.log('CALIBRATION — real packages/core engine vs the spike model, same process');
console.log('='.repeat(76));
console.log(`${''.padEnd(30)} ${'REAL core'.padStart(12)} ${'model'.padStart(12)}   ${'real/model'.padStart(10)}`);
row('instances in a mid-game state', String(realInstances), String(modelInstances), (realInstances / modelInstances).toFixed(2) + 'x');
row('actions per game', ((realActions / GAMES) | 0).toFixed(0), ((modelActions / GAMES) | 0).toFixed(0), (realActions / modelActions).toFixed(2) + 'x');
row('branching factor', realBr.branching.toFixed(2), (modelOffered / modelActions).toFixed(2), (realBr.branching / (modelOffered / modelActions)).toFixed(2) + 'x');
row('ns per action (whole game)', realNsPerAction.toFixed(0), modelNsPerAction.toFixed(0), (realNsPerAction / modelNsPerAction).toFixed(2) + 'x');
row('ns per generateLegalActions', realGenNs.toFixed(0), modelGenNs.toFixed(0), (realGenNs / modelGenNs).toFixed(2) + 'x');
row('ns per cloneState', realCloneNs.toFixed(0), modelCloneNs.toFixed(0), (realCloneNs / modelCloneNs).toFixed(2) + 'x');
row('ns per cloned instance', (realCloneNs / realInstances).toFixed(1), (modelCloneNs / modelInstances).toFixed(1), (realCloneNs / realInstances / (modelCloneNs / modelInstances)).toFixed(2) + 'x');
row('games/sec', ((GAMES / realMs) * 1000).toFixed(1), ((GAMES / modelMs) * 1000).toFixed(1), '');

console.log(`\nclone as a multiple of one action's cost:`);
console.log(`   real core  ${(realCloneNs / realNsPerAction).toFixed(2)}x     model  ${(modelCloneNs / modelNsPerAction).toFixed(2)}x`);
console.log(`\nreal core, clone+generate+apply in isolation: ${((realApplyMs * 1e6) / GEN_ITERS).toFixed(0)} ns per undoable transition`);
console.log('='.repeat(76));
