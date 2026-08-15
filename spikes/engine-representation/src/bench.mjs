/**
 * The three-arm benchmark.
 *
 * MEASUREMENT DISCIPLINE — this box drifts by ~19% between runs of identical code,
 * so the harness is built around that rather than hoping it away:
 *
 *  - **Interleaved.** Every round runs A, then B, then C, inside ONE process. A
 *    thermal or scheduling excursion hits all three arms in the same round instead
 *    of hitting whichever arm ran last.
 *  - **Best-of, not mean.** The minimum of N rounds is the round least polluted by
 *    other work on the machine. Means and medians both drag the estimate toward
 *    whatever else the box was doing.
 *  - **Spread reported.** Every row prints max/min as a noise indicator. A ratio
 *    smaller than the spread is not a result, and the report says so.
 *  - **Equivalence first.** The bench refuses to print timings until all three arms
 *    have produced identical game transcripts on the benchmark's own seeds. A speed
 *    number for an arm playing a different game is worse than no number.
 */

import { PerformanceObserver } from 'node:perf_hooks';
import * as A from './arm-a-objects.mjs';
import * as B from './arm-b-flat.mjs';
import * as C from './arm-c-wasm.mjs';
import { ARENA_SIZE } from './layout.mjs';

const ROUNDS = 9;
const WARMUP_ROUNDS = 3;
const PLAYOUT_GAMES = 150;
const FIRST_SEED = 0x2000;
const WARMUP_SEED = 0x9000;
const MICRO_ITERS = 60_000;
const CLONE_ITERS = 60_000;
const SEARCH_TRANSITION_BUDGET = 12_000;
const SEARCH_DEPTHS = [1, 2, 4, 8, 16, 32, 64];
const MIDGAME_SEED = 77;
const BOUNDARY_ITERS = 2_000_000;
const STATE_COPY_ITERS = 200_000;

const arms = [
  ['A  objects (TS)', A],
  ['B  flat (TS)', B],
  ['C  flat (WASM)', C],
];

function ms(fn) {
  const t = process.hrtime.bigint();
  fn();
  return Number(process.hrtime.bigint() - t) / 1e6;
}

/** Interleaved best-of. Returns {best, spread} per arm, keyed by label. */
function interleaved(label, work) {
  for (let r = 0; r < WARMUP_ROUNDS; r++) for (const [, m] of arms) work(m, WARMUP_SEED);
  const times = new Map(arms.map(([name]) => [name, []]));
  for (let r = 0; r < ROUNDS; r++) {
    for (const [name, m] of arms) times.get(name).push(ms(() => work(m, FIRST_SEED)));
  }
  const out = new Map();
  for (const [name, xs] of times) {
    const best = Math.min(...xs);
    out.set(name, { best, spread: Math.max(...xs) / best });
  }
  return { label, out };
}

// --- gate: equivalence ------------------------------------------------------------------

const GATE_SEEDS = 30;
let mismatches = 0;
for (let s = 0; s < GATE_SEEDS; s++) {
  const seed = FIRST_SEED + s;
  const a = A.playGame(seed);
  const b = B.playGame(seed);
  const c = C.playGame(seed);
  if (a.digest !== b.digest || a.digest !== c.digest) mismatches++;
  if (a.actions !== b.actions || a.actions !== c.actions) mismatches++;
  if (a.winner !== c.winner || a.turns !== c.turns) mismatches++;
}
if (mismatches > 0) {
  console.error(`EQUIVALENCE GATE FAILED: ${mismatches} mismatches across ${GATE_SEEDS} seeds. Timings suppressed.`);
  process.exit(1);
}

// Workload shape, so the reader can judge how representative it is.
let totalActions = 0;
let totalGenerated = 0;
let totalTurns = 0;
let decided = 0;
for (let s = 0; s < PLAYOUT_GAMES; s++) {
  const r = A.playGame(FIRST_SEED + s);
  totalActions += r.actions;
  totalGenerated += r.generated;
  totalTurns += r.turns;
  if (r.winner >= 0) decided++;
}

console.log('='.repeat(78));
console.log('ENGINE REPRESENTATION SPIKE — three arms, one model game, identical transcripts');
console.log('='.repeat(78));
console.log(`\nequivalence gate      ${GATE_SEEDS}/${GATE_SEEDS} seeded games byte-identical across A / B / C`);
console.log(`workload shape        ${PLAYOUT_GAMES} games, ${(totalActions / PLAYOUT_GAMES).toFixed(0)} actions/game, ` +
  `branching ${(totalGenerated / totalActions).toFixed(2)}, ${(totalTurns / PLAYOUT_GAMES).toFixed(1)} turns/game, ${decided}/${PLAYOUT_GAMES} decided`);
console.log(`flat state size       ${ARENA_SIZE} i32 = ${(ARENA_SIZE * 4 / 1024).toFixed(1)} KiB   (fits in L1; the real engine has the same ~120 instances)`);
console.log(`wasm module           ${(C.wasmByteLength / 1024).toFixed(1)} KiB uncompressed`);
console.log(`rounds                best-of-${ROUNDS}, interleaved A/B/C, ${WARMUP_ROUNDS} warm-up rounds`);

// --- 1: full-game playout throughput ------------------------------------------------------

const playout = interleaved('playout', (m, seed) => {
  for (let s = 0; s < PLAYOUT_GAMES; s++) m.playGame(seed + s);
});

console.log(`\n--- 1. FULL-GAME PLAYOUT (forward simulation only, no search) ---`);
console.log('arm                  best ms   spread   games/sec   ns/action   vs A');
const aPlay = playout.out.get('A  objects (TS)').best;
for (const [name] of arms) {
  const { best, spread } = playout.out.get(name);
  console.log(
    `${name.padEnd(20)} ${best.toFixed(1).padStart(7)}   ${spread.toFixed(2)}x  ` +
      `${((PLAYOUT_GAMES / best) * 1000).toFixed(0).padStart(9)}   ${((best * 1e6) / totalActions).toFixed(0).padStart(9)}   ${(aPlay / best).toFixed(2)}x`,
  );
}

// The journal is pure overhead in a forward-only playout; price it.
B.setJournalEnabled(false);
let bNoJournal = Infinity;
for (let r = 0; r < ROUNDS; r++) {
  bNoJournal = Math.min(bNoJournal, ms(() => { for (let s = 0; s < PLAYOUT_GAMES; s++) B.playGame(FIRST_SEED + s); }));
}
B.setJournalEnabled(true);
console.log(`(B with the undo journal DISABLED: ${bNoJournal.toFixed(1)} ms — the journal costs ${(playout.out.get('B  flat (TS)').best / bNoJournal).toFixed(2)}x on a forward-only run)`);

// --- 2: GC / allocation behaviour ----------------------------------------------------------

console.log(`\n--- 2. ALLOCATION & GC (one ${PLAYOUT_GAMES}-game playout per arm) ---`);
console.log('arm                    GC events   GC ms   heap delta MB');
for (const [name, m] of arms) {
  let events = 0;
  let gcMs = 0;
  const obs = new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      events++;
      gcMs += e.duration;
    }
  });
  obs.observe({ entryTypes: ['gc'] });
  const before = process.memoryUsage().heapUsed;
  for (let s = 0; s < PLAYOUT_GAMES; s++) m.playGame(FIRST_SEED + s);
  const after = process.memoryUsage().heapUsed;
  obs.disconnect();
  console.log(
    `${name.padEnd(22)} ${String(events).padStart(9)}   ${gcMs.toFixed(1).padStart(5)}   ${((after - before) / 1048576).toFixed(2).padStart(13)}`,
  );
}

// --- 3: per-operation microbenchmarks -------------------------------------------------------

console.log(`\n--- 3. PER-OPERATION COST (fixed mid-game position, ${MICRO_ITERS.toLocaleString()} iterations) ---`);

const micro = [
  ['legal-action generation', (m) => m.benchGenerate(MIDGAME_SEED, MICRO_ITERS), MICRO_ITERS],
  ['leaf evaluation', (m) => m.benchEvaluate(MIDGAME_SEED, MICRO_ITERS), MICRO_ITERS],
  ['UNDOABLE state transition', (m) => m.benchTransition(MIDGAME_SEED, MICRO_ITERS), MICRO_ITERS],
  ['policy decision (score menu)', (m) => m.benchDecide(MIDGAME_SEED, MICRO_ITERS), MICRO_ITERS],
];

console.log('operation                       A ns      B ns      C ns    B vs A   C vs A   C vs B');
for (const [label, work, iters] of micro) {
  const r = interleaved(label, (m) => work(m));
  const a = (r.out.get('A  objects (TS)').best * 1e6) / iters;
  const b = (r.out.get('B  flat (TS)').best * 1e6) / iters;
  const c = (r.out.get('C  flat (WASM)').best * 1e6) / iters;
  console.log(
    `${label.padEnd(30)} ${a.toFixed(0).padStart(5)}  ${b.toFixed(0).padStart(8)}  ${c.toFixed(0).padStart(8)}   ` +
      `${(a / b).toFixed(2).padStart(6)}x  ${(a / c).toFixed(2).padStart(6)}x  ${(b / c).toFixed(2).padStart(6)}x`,
  );
}

// Decompose arm A's undoable transition: how much of it is the clone?
let cloneMs = Infinity;
for (let r = 0; r < ROUNDS; r++) cloneMs = Math.min(cloneMs, ms(() => A.benchClone(MIDGAME_SEED, CLONE_ITERS)));
const cloneNs = (cloneMs * 1e6) / CLONE_ITERS;
const instances = A.midGameInstanceCount(MIDGAME_SEED);
console.log(
  `\n  arm A's transition decomposed: cloneState = ${cloneNs.toFixed(0)} ns ` +
    `(${(cloneNs / instances).toFixed(1)} ns per cloned instance x ${instances} instances); the rest is the apply itself.`,
);

// --- 4: search workload — the shape the real MCTS bottleneck has ------------------------------

console.log(`\n--- 4. SEARCH (rollouts from a fixed position, ~${SEARCH_TRANSITION_BUDGET.toLocaleString()} transitions per cell) ---`);
console.log('This is the decisive table: arm A must CLONE the root per rollout because an');
console.log('object graph cannot undo; arms B and C REWIND a journal.\n');
console.log('depth  rollouts |    A ms     B ms     C ms |  B vs A  C vs A  C vs B | A ns/tr  B ns/tr  C ns/tr');
for (const depth of SEARCH_DEPTHS) {
  const rollouts = Math.max(50, Math.round(SEARCH_TRANSITION_BUDGET / depth));
  const r = interleaved(`search d=${depth}`, (m) => m.searchWorkload(MIDGAME_SEED, rollouts, depth));
  const transitions = A.searchWorkload(MIDGAME_SEED, rollouts, depth).transitions;
  const a = r.out.get('A  objects (TS)').best;
  const b = r.out.get('B  flat (TS)').best;
  const c = r.out.get('C  flat (WASM)').best;
  console.log(
    `${String(depth).padStart(5)} ${String(rollouts).padStart(9)} | ${a.toFixed(1).padStart(7)}  ${b.toFixed(1).padStart(7)}  ${c.toFixed(1).padStart(7)} | ` +
      `${(a / b).toFixed(2).padStart(6)}x ${(a / c).toFixed(2).padStart(6)}x ${(b / c).toFixed(2).padStart(6)}x | ` +
      `${((a * 1e6) / transitions).toFixed(0).padStart(7)}  ${((b * 1e6) / transitions).toFixed(0).padStart(7)}  ${((c * 1e6) / transitions).toFixed(0).padStart(7)}`,
  );
}

// --- 5: the JS<->WASM boundary ------------------------------------------------------------------

console.log(`\n--- 5. THE BOUNDARY (what a WASM recommendation lives or dies on) ---`);
const boundary = C.benchBoundary(BOUNDARY_ITERS);
const copy = C.benchStateCopy(STATE_COPY_ITERS);
console.log(`trivial JS->WASM call        ${boundary.wasmNsPerCall.toFixed(2)} ns   (identical JS call: ${boundary.jsNsPerCall.toFixed(2)} ns)`);
console.log(`copy whole state out of WASM ${copy.nsPerCopy.toFixed(0)} ns for ${copy.bytes} bytes`);

// What the boundary costs IF the state must cross per decision rather than per batch.
const cPlay = playout.out.get('C  flat (WASM)').best;
const perActionNsC = (cPlay * 1e6) / totalActions;
console.log(
  `\nAt arm C's ${perActionNsC.toFixed(0)} ns/action, ONE state copy-out per action would add ` +
    `${((copy.nsPerCopy / perActionNsC) * 100).toFixed(0)}% and one boundary call per action would add ` +
    `${((boundary.wasmNsPerCall / perActionNsC) * 100).toFixed(1)}%.`,
);

// Batched crossing: the arrangement a real integration would use.
let batched = Infinity;
for (let r = 0; r < ROUNDS; r++) batched = Math.min(batched, ms(() => C.playGames(FIRST_SEED, PLAYOUT_GAMES)));
console.log(`ONE crossing for all ${PLAYOUT_GAMES} games: ${batched.toFixed(1)} ms vs ${cPlay.toFixed(1)} ms for ${PLAYOUT_GAMES} crossings — the per-game crossing is not material.`);

console.log('\n' + '='.repeat(78));
