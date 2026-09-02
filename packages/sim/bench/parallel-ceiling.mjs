/**
 * WHAT SPEED-UP CAN THIS MACHINE ACTUALLY GIVE? — the ceiling, measured.
 *
 * ⚠️ WHY THIS EXISTS. Judging a parallel run against the CORE COUNT is wrong, and
 * it made a near-optimal result look mediocre for a whole round of work. `suggest`
 * reaches 2.56x on six workers, which reads as 43% efficiency — until you measure
 * what six *completely independent* processes do on the same box:
 *
 *   one process alone:        196 games/sec
 *   six at once:  105, 107, 109, 112, 115, 117  →  665 total = 3.39x
 *
 * No shared code, no barriers, no coordination whatsoever — and still only 3.4x
 * from six cores. The workload is memory-heavy and all-core clocks are lower than
 * single-core boost, so a core is worth ~56% of itself once its neighbours are
 * busy. Against that ceiling, `suggest`'s 2.56x is **76% of achievable**, not 43%.
 *
 * So: measure the ceiling before optimising toward the core count, or you will
 * spend days chasing a speed-up the silicon will not sell you.
 *
 * Usage:
 *   node packages/sim/bench/parallel-ceiling.mjs [--games N] [--workers W]
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { cpus } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const bench = join(here, 'pilot-bench.mjs');

const arg = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? Number(process.argv[at + 1]) : fallback;
};
const GAMES = arg('games', 1200);
const WORKERS = arg('workers', Math.max(2, Math.floor(cpus().length / 2)));

/** Run one pilot-bench and return the games/sec it reports. */
function runOnce() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bench, '--games', String(GAMES)], { stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    child.stdout.on('data', (chunk) => (out += chunk));
    child.on('error', reject);
    child.on('close', () => {
      const found = /->\s*([0-9]+)\s*games\/sec/.exec(out);
      if (!found) return reject(new Error(`could not parse pilot-bench output:\n${out}`));
      resolve(Number(found[1]));
    });
  });
}

console.log(`${cpus().length} logical CPUs; ${GAMES} games per process\n`);

const solo = await runOnce();
console.log(`one process alone:      ${solo} games/sec`);

const together = await Promise.all(Array.from({ length: WORKERS }, () => runOnce()));
const total = together.reduce((sum, rate) => sum + rate, 0);
console.log(`${WORKERS} processes at once:  ${together.join(', ')}`);
console.log(`  aggregate: ${total} games/sec`);
console.log(`  per-process efficiency: ${((total / WORKERS / solo) * 100).toFixed(0)}% of solo speed`);
console.log(`\nCEILING: this machine gives ${(total / solo).toFixed(2)}x from ${WORKERS} processes.`);
console.log(
  'Judge any parallel command against THIS number, not against the core count —\n' +
    'a core is worth well under 100% of itself once its neighbours are busy.',
);
