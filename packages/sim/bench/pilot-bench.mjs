/**
 * PILOT BENCH — games per second, IN PROCESS.
 *
 * ⚠️ WHY THIS EXISTS RATHER THAN `npm run sim -- match`. The CLI plays its games
 * in a worker, so `node --cpu-prof` on it profiles a parent process that is 99%
 * idle waiting for a child — a profile that says nothing at all, which is how an
 * hour gets spent reading the module loader's call tree. This harness runs the
 * games on the main thread, so the profiler sees the engine and the pilot.
 *
 * It is also the throughput number to quote: one thread, no worker scheduling,
 * no IPC — the thing an optimisation actually changes.
 *
 * Usage:
 *   node packages/sim/bench/pilot-bench.mjs [--games N] [--pilot id] [--seed S]
 *   node --cpu-prof --cpu-prof-dir <dir> packages/sim/bench/pilot-bench.mjs --games 3000
 *
 * ⚠️ USE AT LEAST ~1000 GAMES. Below that, process startup dominates and the
 * number moves 15% between runs of identical code — a lesson this repo learned
 * by reporting a +15% speed-up that was noise (see COORDINATION.md).
 */
import { createDefaultAiRegistry, HEURISTIC_PILOT_ID } from '@jonny-boi/ai';
import { buildRegistry, loadCardPool } from '@jonny-boi/cards';
import { SAMPLE_DECKS } from '../dist/data/decks/index.js';
import { loadDeck } from '../dist/src/deck.js';
import { runMatch } from '../dist/src/match.js';
import { makeSeats } from '../dist/src/matchup.js';
import { DEFAULT_SIM_CONFIG } from '../dist/src/config.js';

function arg(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? process.argv[at + 1] : fallback;
}

const games = Number(arg('games', '2000'));
const baseSeed = Number(arg('seed', '7'));
const pilotId = arg('pilot', HEURISTIC_PILOT_ID);

const pool = loadCardPool({ onWarn: () => {} });
const registry = buildRegistry();
const pilot = createDefaultAiRegistry().getPilot(pilotId);
if (!pilot) throw new Error(`no pilot '${pilotId}'`);

const byName = (name) => {
  const deck = SAMPLE_DECKS.find((d) => d.name === name);
  if (!deck) throw new Error(`no deck '${name}' (have: ${SAMPLE_DECKS.map((d) => d.name).join(', ')})`);
  return loadDeck(deck, pool);
};

// The recorded matchup, so every number in the log is comparable to the last.
const a = byName('Mono-Red Aggro');
const b = byName('UW Control');
const seats = makeSeats(a, b, { pilotA: pilot, pilotB: pilot }, registry);

let wins = 0;
let actions = 0;
const started = process.hrtime.bigint();
for (let i = 0; i < games; i++) {
  const result = runMatch(seats, baseSeed + i, {
    sim: DEFAULT_SIM_CONFIG,
    startingPlayer: i % 2 === 0 ? 'A' : 'B',
  });
  if (result.outcome.winner === 'A') wins += 1;
  actions += result.actions;
}
const seconds = Number(process.hrtime.bigint() - started) / 1e9;
console.log(
  `${games} games in ${seconds.toFixed(2)}s -> ${(games / seconds).toFixed(0)} games/sec ` +
    `(${(actions / seconds / 1000).toFixed(0)}k actions/sec, A won ${wins}/${games})`,
);
