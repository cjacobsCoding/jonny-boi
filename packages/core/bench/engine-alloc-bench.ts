/**
 * Allocation/throughput benchmark for the engine's action hot path.
 *
 * Answers three questions a wall-clock gauntlet timing cannot:
 *   1. How fast is a full game, end to end (`applyAction` per action)?
 *   2. How much GARBAGE does that produce (GC count + GC time + bytes/action)?
 *   3. Where does it come from — the per-action clone, or the rest?
 *
 * It runs entirely on `core` fixtures (no cards/ai/sim), so it is reproducible on
 * any machine and unaffected by pilot changes happening in other packages. The
 * self-play picker is seeded, so the SAME games are replayed every run: a change
 * that alters play is a behaviour change, not a speedup, and `bench-digest` will
 * say so.
 *
 * Run: npx tsx packages/core/bench/engine-alloc-bench.ts
 *
 * ## Measuring ALLOCATION rather than time
 *
 * Wall clock on a shared machine is close to worthless here — repeated runs of
 * the SAME build swing by more than 2x, which is larger than most wins. Garbage
 * is the thing this work actually removes, and it can be counted exactly:
 *
 *   node --min-semi-space-size=1 --max-semi-space-size=1 --trace-gc \
 *        --import tsx <a script that plays N self-play games> | grep -c Scavenge
 *
 * Pinning the nursery to 1 MB (BOTH bounds — with only the max set, V8 resizes it
 * adaptively and the count wanders by 30% run to run) makes the scavenge count a
 * direct, reproducible proxy for bytes allocated: ±2 across runs, and completely
 * immune to what else the box is doing.
 */

import { applyAction, createGame, generateLegalActions } from '../src/engine.js';
import { DEFAULT_RULES } from '../src/config.js';
import { cloneState } from '../src/internal/clone.js';
import { createRng } from '../src/rng.js';
import type { GameAction } from '../src/actions.js';
import type { GameState } from '../src/state.js';
import { playSelfPlayGame, selfPlayDecks, SELF_PLAY_ACTION_CAP } from '../src/test-fixtures.js';

/** Benchmark shape — named, so no run-size literals are buried in the code. */
const GAMES = 40;
const GAME_ROUNDS = 7;
const WARMUP_GAMES = 20;
const FIRST_SEED = 0xbeef;
/** Actions to play before snapshotting a "mid-game" state for the clone microbench. */
const MIDGAME_ACTIONS = 400;
const CLONE_ITERATIONS = 200_000;
const CLONE_ROUNDS = 7;

const decks = selfPlayDecks();

function median(xs: number[]): number {
  return [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] as number;
}

// --- 1: full-game throughput ------------------------------------------------------
//
// Reported as the MEDIAN of several identical rounds. A single wall-clock timing on
// a shared dev box swings by well over 1.5x from CPU contention alone, which is
// larger than most of the wins being measured — the median of repeated rounds is
// the cheapest thing that survives that.

for (let i = 0; i < WARMUP_GAMES; i++) playSelfPlayGame(decks, FIRST_SEED + 100_000 + i);

let totalActions = 0;
let totalEvents = 0;
let decided = 0;
const roundMs: number[] = [];
for (let round = 0; round < GAME_ROUNDS; round++) {
  totalActions = 0;
  totalEvents = 0;
  decided = 0;
  const started = process.hrtime.bigint();
  for (let i = 0; i < GAMES; i++) {
    const result = playSelfPlayGame(decks, FIRST_SEED + i);
    totalActions += result.actions;
    totalEvents += result.events;
    if (result.gameOver) decided += 1;
  }
  roundMs.push(Number(process.hrtime.bigint() - started) / 1e6);
}
const elapsedMs = median(roundMs);

console.log(`self-play: ${GAMES} seeded games x ${GAME_ROUNDS} rounds (median), action cap ${SELF_PLAY_ACTION_CAP}`);
console.log(`  decided (not cut off)   ${decided}/${GAMES}`);
console.log(`  actions                 ${totalActions.toLocaleString()} (${(totalActions / GAMES).toFixed(0)}/game)`);
console.log(`  events                  ${totalEvents.toLocaleString()}`);
console.log(`  round wall clock        ${elapsedMs.toFixed(0)} ms  (all rounds: ${roundMs.map((m) => m.toFixed(0)).join(', ')})`);
console.log(`  throughput              ${((GAMES / elapsedMs) * 1000).toFixed(1)} games/sec`);
console.log(`  action rate             ${((totalActions / elapsedMs) * 1000).toFixed(0)} actions/sec`);
console.log(`  microseconds per action ${((elapsedMs * 1000) / totalActions).toFixed(2)} us`);

// --- 2: the per-action clone, in isolation ----------------------------------------

/** Play a fixed number of seeded actions to reach a developed mid-game board. */
function midGameState(): GameState {
  const rng = createRng(FIRST_SEED);
  let state = createGame({ seed: FIRST_SEED, decks, config: DEFAULT_RULES }).state;
  for (let i = 0; i < MIDGAME_ACTIONS && !state.gameOver; i++) {
    const legal = generateLegalActions(state, DEFAULT_RULES);
    if (legal.length === 0) break;
    state = applyAction(state, legal[rng.nextInt(legal.length)] as GameAction, DEFAULT_RULES).state;
  }
  return state;
}

function timeClone(state: GameState): number {
  const start = process.hrtime.bigint();
  let sink = 0;
  for (let i = 0; i < CLONE_ITERATIONS; i++) sink += cloneState(state).turnNumber;
  const end = process.hrtime.bigint();
  if (sink === -1) throw new Error('unreachable');
  return Number(end - start) / 1e6;
}

const mid = midGameState();
const zoneSizes =
  `battlefield ${mid.battlefield.length}, ` +
  `libraries ${mid.players.A.library.length}+${mid.players.B.library.length}, ` +
  `hands ${mid.players.A.hand.length}+${mid.players.B.hand.length}, ` +
  `graveyards ${mid.players.A.graveyard.length}+${mid.players.B.graveyard.length}`;

timeClone(mid); // warm
const cloneRounds: number[] = [];
for (let r = 0; r < CLONE_ROUNDS; r++) cloneRounds.push(timeClone(mid));
const cloneMs = median(cloneRounds);
const clonedInstances =
  mid.battlefield.length +
  mid.players.A.library.length + mid.players.B.library.length +
  mid.players.A.hand.length + mid.players.B.hand.length +
  mid.players.A.graveyard.length + mid.players.B.graveyard.length;

console.log(`\ncloneState — mid-game board (${zoneSizes})`);
console.log(`  ${((cloneMs * 1e6) / CLONE_ITERATIONS).toFixed(0)} ns/clone (median of ${CLONE_ROUNDS} x ${CLONE_ITERATIONS.toLocaleString()})`);
console.log(`  ${(((cloneMs * 1e6) / CLONE_ITERATIONS) / clonedInstances).toFixed(1)} ns per cloned instance (${clonedInstances} instances)`);
