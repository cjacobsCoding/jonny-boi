/**
 * THE ALGORITHMIC LEVER, measured against the language/representation levers on the
 * same workload — so the recommendation can rank them instead of arguing about them.
 *
 * The engineering choice actually on the table is not only "which language". It is:
 *
 *   (a) ALGORITHM  — stop playing rollouts to a terminal state and evaluate a
 *       bounded-depth leaf instead (Brief B §9). Cost per rollout falls because the
 *       rollout is shorter. Pure `packages/ai` work; the rules engine is untouched.
 *   (b) REPRESENTATION — flat arena + undo instead of an object graph + clone.
 *   (c) LANGUAGE — the same flat design compiled to WASM.
 *
 * These compose, so the useful measurement is a GRID, not a single number. This
 * script holds the ROLLOUT COUNT fixed (a search budget is "how many rollouts", not
 * "how many transitions") and sweeps depth from terminal-ish down to 1, for each arm.
 *
 * Read the output as: how much does one MCTS decision of a fixed rollout budget cost?
 */

import * as A from './arm-a-objects.mjs';
import * as B from './arm-b-flat.mjs';
import * as C from './arm-c-wasm.mjs';

const ROLLOUTS = 400;
const DEPTHS = [1, 2, 4, 8, 16, 32, 64, 120];
const ROUNDS = 9;
const WARMUP = 3;
const SEED = 77;

const arms = [
  ['A objects', A],
  ['B flat TS', B],
  ['C flat WASM', C],
];

function bestMs(fn) {
  let best = Infinity;
  for (let r = 0; r < ROUNDS; r++) {
    const t = process.hrtime.bigint();
    fn();
    best = Math.min(best, Number(process.hrtime.bigint() - t) / 1e6);
  }
  return best;
}

for (let w = 0; w < WARMUP; w++) for (const [, m] of arms) m.searchWorkload(SEED, 50, 8);

// Equivalence at every depth before any timing is printed.
let bad = 0;
for (const d of DEPTHS) {
  const a = A.searchWorkload(SEED, ROLLOUTS, d);
  const b = B.searchWorkload(SEED, ROLLOUTS, d);
  const c = C.searchWorkload(SEED, ROLLOUTS, d);
  if (a.checksum !== b.checksum || a.checksum !== c.checksum) bad++;
  if (a.transitions !== c.transitions) bad++;
}
if (bad > 0) {
  console.error(`EQUIVALENCE FAILED at ${bad} depth(s) — timings suppressed.`);
  process.exit(1);
}

console.log('='.repeat(84));
console.log(`ALGORITHM vs REPRESENTATION vs LANGUAGE — ${ROLLOUTS} rollouts per decision, depth swept`);
console.log('='.repeat(84));
console.log('Cost of ONE decision (us). Rollout count is FIXED, so moving down a column is the');
console.log('ALGORITHMIC change (bounded-depth leaf eval); moving across a row is the');
console.log('representation/language change.\n');

const results = new Map();
console.log('depth |   A objects   B flat TS  C flat WASM |  B vs A   C vs A   C vs B');
for (const d of DEPTHS) {
  const row = {};
  for (const [name, m] of arms) row[name] = bestMs(() => m.searchWorkload(SEED, ROLLOUTS, d)) * 1000;
  results.set(d, row);
  console.log(
    `${String(d).padStart(5)} | ${row['A objects'].toFixed(0).padStart(11)} ${row['B flat TS'].toFixed(0).padStart(11)} ${row['C flat WASM'].toFixed(0).padStart(12)} | ` +
      `${(row['A objects'] / row['B flat TS']).toFixed(2).padStart(6)}x ${(row['A objects'] / row['C flat WASM']).toFixed(2).padStart(7)}x ` +
      `${(row['B flat TS'] / row['C flat WASM']).toFixed(2).padStart(7)}x`,
  );
}

const deep = results.get(120);
const shallow = results.get(1);
console.log('\n--- ranking the three levers, all measured on the same workload ---');
for (const [name] of arms) {
  console.log(`${name.padEnd(13)} depth 120 -> depth 1 (ALGORITHM alone): ${(deep[name] / shallow[name]).toFixed(1)}x`);
}
console.log(
  `\nREPRESENTATION alone (A -> B, TypeScript both, at depth 1): ${(shallow['A objects'] / shallow['B flat TS']).toFixed(2)}x` +
    `   at depth 120: ${(deep['A objects'] / deep['B flat TS']).toFixed(2)}x`,
);
console.log(
  `LANGUAGE alone (B -> C, identical flat algorithm, at depth 1): ${(shallow['B flat TS'] / shallow['C flat WASM']).toFixed(2)}x` +
    `   at depth 120: ${(deep['B flat TS'] / deep['C flat WASM']).toFixed(2)}x`,
);
console.log(
  `\nALGORITHM alone, no port at all (A@120 -> A@1):            ${(deep['A objects'] / shallow['A objects']).toFixed(1)}x`,
);
console.log(
  `EVERYTHING (A@120 -> C@1):                                 ${(deep['A objects'] / shallow['C flat WASM']).toFixed(1)}x`,
);
console.log(
  `PORT ON TOP OF THE ALGORITHM (A@1 -> C@1):                 ${(shallow['A objects'] / shallow['C flat WASM']).toFixed(1)}x` +
    `  <- the marginal value of the port once the algorithm lands`,
);
console.log('='.repeat(84));
