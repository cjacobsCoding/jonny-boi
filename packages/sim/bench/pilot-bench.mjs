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
 *   node packages/sim/bench/pilot-bench.mjs --old packages/ai/dist-old/index.js [--batch N] [--off feature]
 *   node --cpu-prof --cpu-prof-dir <dir> packages/sim/bench/pilot-bench.mjs --games 3000
 *
 * ⚠️ USE AT LEAST ~1000 GAMES. Below that, process startup dominates and the
 * number moves 15% between runs of identical code — a lesson this repo learned
 * by reporting a +15% speed-up that was noise (see COORDINATION.md).
 */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  createDefaultAiRegistry,
  createHeuristicPilot,
  createLookaheadPilot,
  HEURISTIC_PILOT_ID,
  LOOKAHEAD_PILOT_ID,
} from '@jonny-boi/ai';
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
// `--old <path to another build's ai dist/index.js>`: play the same pilot id from
// that build and from this one, in alternating batches within ONE process, and
// report both. See `pilot-decide-bench.mjs --old` for why interleaving is the
// only fair comparison on this machine.
const oldDist = arg('old', undefined);
const BATCH = Number(arg('batch', '200'));
// `--off <feature>` switches one `HeuristicFeatures` flag OFF in the NEW arm, so a
// build that ships a strength feature the old one lacked can still be timed on
// the SAME games (§3.83: games/sec cannot compare two pilots of different
// strength — a stronger pilot plays different games). Check "A won" matches.
const OFF = arg('off', undefined);

const pool = loadCardPool({ onWarn: () => {} });
const registry = buildRegistry();
const pilot = OFF
  ? pilotId === LOOKAHEAD_PILOT_ID
    ? createLookaheadPilot(undefined, undefined, { [OFF]: false })
    : createHeuristicPilot(undefined, { [OFF]: false })
  : createDefaultAiRegistry().getPilot(pilotId);
if (!pilot) throw new Error(`no pilot '${pilotId}'`);
const oldPilot = oldDist
  ? (await import(pathToFileURL(resolve(oldDist)).href)).createDefaultAiRegistry().getPilot(pilotId)
  : undefined;
if (oldDist && !oldPilot) throw new Error(`no pilot '${pilotId}' in ${oldDist}`);

const byName = (name) => {
  const deck = SAMPLE_DECKS.find((d) => d.name === name);
  if (!deck) throw new Error(`no deck '${name}' (have: ${SAMPLE_DECKS.map((d) => d.name).join(', ')})`);
  return loadDeck(deck, pool);
};

// The recorded matchup, so every number in the log is comparable to the last.
const a = byName('Mono-Red Aggro');
const b = byName('UW Control');

/** Play games [from, to) with one pilot in both seats; accumulate into `tally`. */
function playBatch(subject, tally, from, to) {
  const seats = makeSeats(a, b, { pilotA: subject, pilotB: subject }, registry);
  const started = process.hrtime.bigint();
  const cpuStarted = process.cpuUsage();
  for (let i = from; i < to; i++) {
    const result = runMatch(seats, baseSeed + i, {
      sim: DEFAULT_SIM_CONFIG,
      startingPlayer: i % 2 === 0 ? 'A' : 'B',
    });
    if (result.outcome.winner === 'A') tally.wins += 1;
    tally.actions += result.actions;
    tally.games += 1;
  }
  tally.seconds += Number(process.hrtime.bigint() - started) / 1e9;
  const cpu = process.cpuUsage(cpuStarted);
  tally.cpuSeconds += (cpu.user + cpu.system) / 1e6;
}

// CPU time alongside the wall clock: on a box shared with other agents the wall
// clock drifts by a third between runs of identical code (116 and 153 games/sec
// were measured minutes apart on one tree), while the CPU seconds this single
// thread actually spent move far less. Quote the CPU figure for a ratio between
// two trees measured back to back; the wall figure is what a user feels.
const report = (label, t) =>
  console.log(
    `${label}${t.games} games in ${t.seconds.toFixed(2)}s -> ${(t.games / t.seconds).toFixed(0)} games/sec ` +
      `(${(t.actions / t.seconds / 1000).toFixed(0)}k actions/sec, A won ${t.wins}/${t.games}); ` +
      `CPU ${t.cpuSeconds.toFixed(2)}s -> ${(t.games / t.cpuSeconds).toFixed(0)} games/cpu-sec`,
  );
const fresh = () => ({ wins: 0, actions: 0, games: 0, seconds: 0, cpuSeconds: 0 });

if (oldPilot) {
  const oldTally = fresh();
  const newTally = fresh();
  // Alternate batches, and alternate which arm leads each pair, so neither arm
  // inherits a warmer process or a quieter minute than the other.
  let batch = 0;
  for (let from = 0; from < games; from += BATCH, batch++) {
    const to = Math.min(games, from + BATCH);
    if (batch % 2 === 0) {
      playBatch(oldPilot, oldTally, from, to);
      playBatch(pilot, newTally, from, to);
    } else {
      playBatch(pilot, newTally, from, to);
      playBatch(oldPilot, oldTally, from, to);
    }
  }
  report(`OLD (${oldDist}): `, oldTally);
  report('NEW: ', newTally);
  console.log(
    `NEW/OLD: ${(oldTally.seconds / newTally.seconds).toFixed(2)}x wall, ` +
      `${(oldTally.cpuSeconds / newTally.cpuSeconds).toFixed(2)}x CPU`,
  );
} else {
  const tally = fresh();
  playBatch(pilot, tally, 0, games);
  report('', tally);
}
