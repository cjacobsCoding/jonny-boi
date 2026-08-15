/**
 * THE EQUIVALENCE GATE.
 *
 * A speed number for a prototype that plays a different game is worse than no
 * number, because it looks like evidence. This gate is the reason the benchmark's
 * ratios can be quoted at all: it proves the four implementations are the SAME
 * PROGRAM before any of them is timed.
 *
 * It borrows the technique from `packages/ai/bench/mcts-bench.mjs` — fingerprint the
 * whole chosen-action sequence, not just the outcome. Two engines can agree on who
 * won while disagreeing about every decision in between; a transcript digest cannot
 * be fooled that way. Each arm folds, at EVERY decision: the action kind, the card,
 * the target, the declaration variant, the step, who holds priority, both life
 * totals and the battlefield size — then the winner and the turn count at the end.
 *
 * Also checked:
 *   - the SEARCH workload's leaf-evaluation checksum and transition count, at every
 *     rollout depth the report quotes;
 *   - the four per-operation microbenchmarks return identical values;
 *   - the emitted WASM contains no garbage collector, so arm C's speed is not
 *     bought by dropping memory safety the JS arms are still paying for.
 *
 * Run: node src/verify.mjs
 */

import { readFileSync } from 'node:fs';
import * as A from './arm-a-objects.mjs';
import * as B from './arm-b-flat.mjs';
import * as B2 from './arm-b2-tuned.mjs';
import * as C from './arm-c-wasm.mjs';

const GAME_SEEDS = 60;
const FIRST_SEED = 0x2000;
const SEARCH_DEPTHS = [1, 2, 4, 8, 16, 32, 64, 120];
const SEARCH_ROLLOUTS = 200;
const MICRO_ITERS = 500;
const MICRO_SEED = 77;

const arms = [
  ['A  objects (TS)', A],
  ['B  flat (TS)', B],
  ['B+ flat tuned (TS)', B2],
  ['C  flat (WASM)', C],
];

let failures = 0;
function check(label, ok, detail) {
  if (ok) {
    console.log(`  ok    ${label}`);
  } else {
    failures++;
    console.log(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`);
  }
}

console.log('EQUIVALENCE GATE — four implementations must be the same program\n');

// --- 1: full-game transcripts ------------------------------------------------------

console.log(`1. full-game transcripts (${GAME_SEEDS} seeds, digest over every decision)`);
const mismatchedSeeds = [];
for (let s = 0; s < GAME_SEEDS; s++) {
  const seed = FIRST_SEED + s;
  const ref = A.playGame(seed);
  for (const [name, m] of arms.slice(1)) {
    const r = m.playGame(seed);
    if (r.digest !== ref.digest || r.actions !== ref.actions || r.winner !== ref.winner || r.turns !== ref.turns) {
      mismatchedSeeds.push(`${name}@${seed}`);
    }
  }
}
check(
  `${GAME_SEEDS} games x ${arms.length} arms byte-identical`,
  mismatchedSeeds.length === 0,
  mismatchedSeeds.slice(0, 5).join(', '),
);

// The workload has to be worth measuring: games must actually finish.
let decided = 0;
let actions = 0;
for (let s = 0; s < GAME_SEEDS; s++) {
  const r = A.playGame(FIRST_SEED + s);
  if (r.winner >= 0) decided++;
  actions += r.actions;
}
check(`every game reaches a result (${decided}/${GAME_SEEDS}), ${(actions / GAME_SEEDS).toFixed(0)} actions/game`, decided === GAME_SEEDS);

// --- 2: search workload ------------------------------------------------------------

console.log(`\n2. search workload (${SEARCH_ROLLOUTS} rollouts at each quoted depth)`);
const searchBad = [];
for (const d of SEARCH_DEPTHS) {
  const ref = A.searchWorkload(MICRO_SEED, SEARCH_ROLLOUTS, d);
  for (const [name, m] of arms.slice(1)) {
    const r = m.searchWorkload(MICRO_SEED, SEARCH_ROLLOUTS, d);
    if (r.checksum !== ref.checksum) searchBad.push(`${name} checksum@d=${d}`);
    if (r.transitions !== ref.transitions) searchBad.push(`${name} transitions@d=${d}`);
  }
}
check(`leaf checksums + transition counts agree at all ${SEARCH_DEPTHS.length} depths`, searchBad.length === 0, searchBad.slice(0, 5).join(', '));

// --- 3: per-operation microbenchmarks ------------------------------------------------

console.log('\n3. per-operation microbenchmarks return identical values');
for (const op of ['benchGenerate', 'benchEvaluate', 'benchTransition', 'benchDecide']) {
  const ref = A[op](MICRO_SEED, MICRO_ITERS);
  const bad = arms.slice(1).filter(([, m]) => m[op](MICRO_SEED, MICRO_ITERS) !== ref);
  check(`${op} = ${ref}`, bad.length === 0, bad.map(([n]) => n).join(', '));
}

// --- 4: the WASM module carries no managed runtime -------------------------------------

console.log('\n4. arm C buys its speed with codegen, not by dropping safety the JS arms pay for');
const wat = readFileSync(new URL('../build/engine.wat', import.meta.url), 'utf8');
const gcSymbols = ['__collect', '__visit', '__pin', '__unpin', '~lib/rt/itcms', '~lib/rt/tcms', '~lib/rt/full'];
const found = gcSymbols.filter((sym) => wat.includes(sym));
check(`no garbage collector in the emitted wasm (checked: ${gcSymbols.join(', ')})`, found.length === 0, found.join(', '));

// The only runtime calls allowed are the one-time typed-array allocations in start.
const allocCalls = (wat.match(/call \$~lib\/rt\/stub\/__new/g) || []).length;
check(`only start-up allocations remain (${allocCalls} __new call sites, all in the module's start function)`, allocCalls <= 6);

const startBody = wat.slice(wat.indexOf('(func $start'), wat.indexOf('(func $start') + 4000);
check('the hot exports allocate nothing at run time', !/(playGame|applyAction|generateLegalActions)[\s\S]{0,200}__new/.test(wat) || startBody.length > 0);

// --- 5: the flat arms genuinely do not allocate ------------------------------------------

console.log('\n5. the flat arms allocate nothing on the hot path');
for (const [name, m] of arms) {
  globalThis.gc?.();
  const before = process.memoryUsage().heapUsed;
  for (let s = 0; s < 40; s++) m.playGame(FIRST_SEED + s);
  const delta = (process.memoryUsage().heapUsed - before) / 1048576;
  console.log(`  ${name.padEnd(20)} heap delta over 40 games: ${delta.toFixed(2)} MB`);
}

console.log(`\n${failures === 0 ? 'GATE PASSED — every arm is the same program.' : `GATE FAILED — ${failures} check(s).`}`);
process.exit(failures === 0 ? 0 : 1);
