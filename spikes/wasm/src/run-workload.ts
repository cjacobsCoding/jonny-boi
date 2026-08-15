/**
 * CLI entry for the representative workload. Run it plain to time the sim, or
 * under `node --cpu-prof` to capture a V8 CPU profile of exactly this run.
 *
 *   node --import tsx spikes/wasm/src/run-workload.ts --pilot heuristic --games 12
 *   node --cpu-prof --cpu-prof-dir spikes/wasm/results --import tsx \
 *        spikes/wasm/src/run-workload.ts --pilot heuristic --games 12
 */

import { runWorkload } from './workload.js';

function argValue(flag: string, fallback: string): string {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? (process.argv[i + 1] as string) : fallback;
}

const pilotId = argValue('--pilot', 'heuristic');
const games = Number(argValue('--games', '12'));

const summary = runWorkload({ pilotId, games });
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
