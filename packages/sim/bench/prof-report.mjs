/**
 * PROFILE REPORT — turn a `.cpuprofile` into a self-time table.
 *
 * ⚠️ WHY THIS IS COMMITTED TOOLING AND NOT A ONE-OFF. "Where does the time go?"
 * is the question every performance decision in this repo turns on, and it has
 * been answered by hand more than once. A hand count is not reproducible, is not
 * comparable between two runs, and cannot be pointed at by the next person who
 * wants to argue that some function is the bottleneck.
 *
 * Pair it with `pilot-bench.mjs`, which is the only harness that profiles
 * anything real — the CLI plays its games in a worker, so `--cpu-prof` on it
 * profiles a parent process that is 99% idle:
 *
 *   node --cpu-prof --cpu-prof-dir prof packages/sim/bench/pilot-bench.mjs --games 1500
 *   node packages/sim/bench/prof-report.mjs prof
 *
 * SELF time, not total: a flat self-time table is what tells you whether there is
 * a hotspot to attack or whether the cost is spread across the whole engine. The
 * distinction matters — a total-time table always makes the outermost frame look
 * like the problem, which is how an afternoon gets spent "optimising" a loop that
 * is only expensive because of everything it calls.
 *
 *   --top N   how many rows to print (default 30)
 *   --min P   hide rows below P percent (default 0)
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

function arg(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? process.argv[at + 1] : fallback;
}

const target = process.argv[2];
if (!target || target.startsWith('--')) {
  console.error('usage: node packages/sim/bench/prof-report.mjs <dir-or-file.cpuprofile> [--top N] [--min P]');
  process.exit(2);
}
const top = Number(arg('top', '30'));
const min = Number(arg('min', '0'));

const file = statSync(target).isDirectory()
  ? join(target, readdirSync(target).find((f) => f.endsWith('.cpuprofile')) ?? '')
  : target;
if (!file.endsWith('.cpuprofile')) {
  console.error(`no .cpuprofile found at ${target}`);
  process.exit(2);
}

const prof = JSON.parse(readFileSync(file, 'utf8'));
const byId = new Map(prof.nodes.map((n) => [n.id, n]));

// A sample names the node that was EXECUTING, so counting samples per node is
// self time directly — no tree walk, and no double-counting of recursive frames.
const perNode = new Map();
for (const id of prof.samples) perNode.set(id, (perNode.get(id) ?? 0) + 1);

const perFunction = new Map();
for (const [id, count] of perNode) {
  const node = byId.get(id);
  if (!node) continue;
  const { functionName, url, lineNumber } = node.callFrame;
  // Frames are folded by function, not by call site: the same function reached
  // from three callers is one cost to pay down, not three small ones to dismiss.
  const key = `${functionName || '(anonymous)'}  ${url.replace(/.*[\\/]/, '') || '(native)'}:${lineNumber + 1}`;
  perFunction.set(key, (perFunction.get(key) ?? 0) + count);
}

const total = prof.samples.length;
const rows = [...perFunction.entries()]
  .sort((a, b) => b[1] - a[1])
  .map(([name, count]) => ({ name, pct: (count / total) * 100 }))
  .filter((row) => row.pct >= min)
  .slice(0, top);

console.log(`${file}\n${total} samples\n`);
for (const row of rows) console.log(`${row.pct.toFixed(2).padStart(6)}%  ${row.name}`);

// The headline a reader actually needs: is there something to attack, or is the
// cost spread out? A flat profile means no single fix is worth much, and saying
// so here is cheaper than someone re-discovering it.
const head = rows[0];
const top10 = rows.slice(0, 10).reduce((sum, row) => sum + row.pct, 0);
console.log(
  `\nheaviest single function: ${head ? head.pct.toFixed(1) : 0}% self time; top 10 together: ${top10.toFixed(1)}%.`,
);
console.log(
  head && head.pct < 10
    ? 'FLAT — no hotspot. Expect a fix here to buy single-digit percent, and size the work accordingly.'
    : 'PEAKED — one function dominates; that is where an optimisation pays.',
);
