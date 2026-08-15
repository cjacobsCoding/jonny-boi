/**
 * Read a V8 `.cpuprofile` and print SELF time per function, hottest first.
 *
 * The point is to stop guessing where the sim's time goes. `--cpu-prof` gives a
 * node tree with per-node hit counts; self time is the hits attributed to a node
 * itself, so summing by (functionName, url) tells you which code is actually
 * executing rather than which code merely appears on the stack.
 *
 *   node --cpu-prof --cpu-prof-dir=<dir> packages/sim/dist/src/cli.js match ...
 *   node packages/sim/scripts/top-self-time.mjs <dir>/<file>.cpuprofile [rows]
 *
 * A triage tool, run by hand. Not imported by anything and not part of the build.
 */

import { readFileSync } from 'node:fs';

const [, , file, rowsArg] = process.argv;
if (!file) {
  console.error('usage: node top-self-time.mjs <file.cpuprofile> [rows]');
  process.exit(1);
}
const rows = Number(rowsArg ?? 25);

const profile = JSON.parse(readFileSync(file, 'utf8'));
const byId = new Map(profile.nodes.map((n) => [n.id, n]));

// `samples` is one node id per tick; `timeDeltas` the microseconds before each.
const selfMicros = new Map();
for (let i = 0; i < profile.samples.length; i++) {
  const id = profile.samples[i];
  const delta = profile.timeDeltas[i] ?? 0;
  selfMicros.set(id, (selfMicros.get(id) ?? 0) + delta);
}

/** Group by function identity, not by node — a function appears at many callsites. */
const byFunction = new Map();
let total = 0;
for (const [id, micros] of selfMicros) {
  const node = byId.get(id);
  if (!node) continue;
  const frame = node.callFrame;
  const name = frame.functionName || '(anonymous)';
  // Keep the file, dropping the absolute prefix — the same name exists in several.
  const where = (frame.url || '')
    .replace(/^.*[/\\](packages|apps|node_modules)[/\\]/, '$1/')
    .replace(/^file:\/\/\//, '');
  const key = `${name} — ${where || '(native)'}`;
  byFunction.set(key, (byFunction.get(key) ?? 0) + micros);
  total += micros;
}

const ranked = [...byFunction.entries()].sort((a, b) => b[1] - a[1]);

console.log(`Total sampled: ${(total / 1000).toFixed(0)} ms across ${ranked.length} functions\n`);
console.log(`${'self%'.padStart(6)}  ${'ms'.padStart(7)}  function`);
console.log('-'.repeat(90));
for (const [key, micros] of ranked.slice(0, rows)) {
  const pct = ((micros / total) * 100).toFixed(2);
  console.log(`${pct.padStart(6)}  ${(micros / 1000).toFixed(1).padStart(7)}  ${key}`);
}
