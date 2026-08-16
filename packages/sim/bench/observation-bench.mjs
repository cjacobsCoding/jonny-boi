/**
 * OBSERVATION SEAM — determinism digest + throughput (DESIGN §1 rule 7).
 *
 * Run from the repo root, after `npm run build`:
 *   node packages/sim/bench/observation-bench.mjs digest
 *   node packages/sim/bench/observation-bench.mjs throughput [rounds] [games]
 *   node packages/sim/bench/observation-bench.mjs volume [games]
 *
 * Modes
 *   digest      A sha256 over the FULL chosen-action sequence of many seeded
 *               games, for the pilots that do NOT implement the seam. It is the
 *               same technique `packages/ai/bench/mcts-bench.mjs` uses, and the
 *               only honest way to claim "byte-identical play": a win count can
 *               match while the games differ. Run it on `main` and on a branch;
 *               the strings must be equal.
 *   throughput  INTERLEAVED games/sec with the feed OFF and ON, alternating
 *               rounds inside ONE process. Interleaving is not optional on this
 *               box: wall clock drifts ~19% between runs of identical code and a
 *               sequential comparison here has already produced a confident wrong
 *               answer. Medians, never means — one thermal stall ruins a mean and
 *               leaves no trace.
 *   volume      How much there is to observe: events per game, how many are
 *               delivered, and how many of those had to be COPIED rather than
 *               passed by reference. The copy count is the seam's whole
 *               allocation story.
 */

import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { loadCardPool, buildRegistry } from '@jonny-boi/cards';
import { SAMPLE_DECKS, loadDeck, makeSeats, runMatch, gameSeedFor, onPlayFor } from '@jonny-boi/sim';
import { createDefaultAiRegistry, HEURISTIC_PILOT_ID, HYBRID_PILOT_ID, RANDOM_PILOT_ID } from '@jonny-boi/ai';

const pool = loadCardPool({ onWarn: () => {} });
const registry = buildRegistry();
const ai = createDefaultAiRegistry();

/** Base seed for every measurement here, so two runs are comparable. */
const BENCH_SEED = 0x0b5e2ed;
/** Matchups spanning a fast tactical board and a grindy one. */
const MATCHUPS = [
  ['Mono-Red Aggro', 'Boros Aggro'],
  ['UW Control', 'Golgari Midrange'],
  ['Izzet Prowess', 'Mono-Green Ramp'],
];

const deckOf = (name) => loadDeck(SAMPLE_DECKS.find((d) => d.name === name), pool);

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Play `games` of one matchup and return every decision, in order. */
function decisionsOf(pilotId, deckAName, deckBName, games) {
  const pilotA = ai.getPilot(pilotId);
  const pilotB = ai.getPilot(pilotId);
  const seats = makeSeats(deckOf(deckAName), deckOf(deckBName), { pilotA, pilotB }, registry);
  const all = [];
  for (let g = 0; g < games; g++) {
    const result = runMatch(seats, gameSeedFor(BENCH_SEED, g), {
      startingPlayer: onPlayFor(g),
      recordTrace: true,
    });
    for (const d of result.decisions) all.push(`${d.player}:${JSON.stringify(d.action)}`);
  }
  return all;
}

function digest(mode) {
  // The hybrid is ~1400x the heuristic per decision, so it gets far fewer games —
  // enough to prove the search's sequence is untouched, not enough to wait on.
  const plans = [
    [HEURISTIC_PILOT_ID, 20],
    [RANDOM_PILOT_ID, 20],
    [HYBRID_PILOT_ID, 4],
  ];
  console.log(`digest (seed ${BENCH_SEED})`);
  let totalPlies = 0;
  for (const [pilotId, games] of plans) {
    for (const [a, b] of MATCHUPS) {
      const decisions = decisionsOf(pilotId, a, b, games);
      totalPlies += decisions.length;
      const hash = createHash('sha256').update(decisions.join('|')).digest('hex').slice(0, 16);
      console.log(`  ${pilotId.padEnd(10)} ${`${a} vs ${b}`.padEnd(34)} ${games} games  ${String(decisions.length).padStart(6)} plies  ${hash}`);
    }
  }
  console.log(`  TOTAL PLIES DIGESTED: ${totalPlies}`);
  if (mode) console.log(mode);
}

/** One round of `games` games; returns games/sec. */
function timeArm(pilotA, pilotB, deckAName, deckBName, games) {
  const seats = makeSeats(deckOf(deckAName), deckOf(deckBName), { pilotA, pilotB }, registry);
  const t0 = performance.now();
  for (let g = 0; g < games; g++) {
    runMatch(seats, gameSeedFor(BENCH_SEED, g), { startingPlayer: onPlayFor(g) });
  }
  return (games / (performance.now() - t0)) * 1000;
}

/**
 * Games/sec for a pilot that does NOT implement the seam — the arm that answers
 * "did adding this seam cost the pilots that ignore it anything?".
 *
 * It uses nothing this branch introduced, deliberately: run it alternately against
 * a pre-seam build and a post-seam build of `packages/sim/dist` to get a genuinely
 * INTERLEAVED comparison. Sequential comparisons on this box have already produced
 * a confident wrong answer.
 */
function plain(rounds, games) {
  const [a, b] = MATCHUPS[0];
  const rates = [];
  for (let r = 0; r < rounds; r++) {
    rates.push(timeArm(ai.getPilot(HEURISTIC_PILOT_ID), ai.getPilot(HEURISTIC_PILOT_ID), a, b, games));
  }
  console.log(`plain ${median(rates).toFixed(1)} games/sec (median of ${rounds} x ${games} games)`);
}

async function throughput(rounds, games) {
  // Lazy, for the same reason `volume` is: the control arm of the interleaved
  // A/B is a build that predates this seam and exports neither symbol.
  const { createRevealTrackingPilot } = await import('@jonny-boi/ai');
  const [a, b] = MATCHUPS[0];
  const off = [];
  const on = [];
  const ratios = [];
  const timeOff = () =>
    timeArm(ai.getPilot(HEURISTIC_PILOT_ID), ai.getPilot(HEURISTIC_PILOT_ID), a, b, games);
  const timeOn = () =>
    timeArm(
      createRevealTrackingPilot(ai.getPilot(HEURISTIC_PILOT_ID)),
      createRevealTrackingPilot(ai.getPilot(HEURISTIC_PILOT_ID)),
      a,
      b,
      games,
    );
  timeOff();
  timeOn();
  for (let r = 0; r < rounds; r++) {
    // Alternate which arm runs first: this box warms up over a run, so a fixed
    // order inside a round systematically favours whichever arm goes second.
    if (r % 2 === 0) {
      off.push(timeOff());
      on.push(timeOn());
    } else {
      on.push(timeOn());
      off.push(timeOff());
    }
    ratios.push(on[on.length - 1] / off[off.length - 1]);
  }
  console.log(`throughput — ${a} vs ${b}, ${games} games x ${rounds} interleaved rounds`);
  console.log(`  feed OFF (no observer): median ${median(off).toFixed(1)} games/sec  [${Math.min(...off).toFixed(0)}..${Math.max(...off).toFixed(0)}]`);
  console.log(`  feed ON  (both seats):  median ${median(on).toFixed(1)} games/sec  [${Math.min(...on).toFixed(0)}..${Math.max(...on).toFixed(0)}]`);
  console.log(`  paired ratio per round: ${ratios.map((x) => x.toFixed(3)).join(' ')}`);
  // The PAIRED median is the quotable figure: it cancels the drift both arms share
  // in a round, which a ratio of two separately-taken medians does not.
  console.log(`  PAIRED MEDIAN RATIO on/off: ${median(ratios).toFixed(3)}x`);
}

async function volume(games) {
  /*
   * Imported lazily, and that is load-bearing rather than fussy: `digest` and
   * `throughput` are meant to be run against a build that PREDATES this seam, as
   * the control arm of an A/B. A top-level import of `observationOf` would make
   * the whole file fail to load there.
   */
  const { observationOf } = await import('@jonny-boi/sim');
  let events = 0;
  let delivered = 0;
  let copied = 0;
  const [a, b] = MATCHUPS[0];
  const pilotA = ai.getPilot(HEURISTIC_PILOT_ID);
  const seats = makeSeats(deckOf(a), deckOf(b), { pilotA, pilotB: pilotA }, registry);
  for (let g = 0; g < games; g++) {
    runMatch(seats, gameSeedFor(BENCH_SEED, g), {
      startingPlayer: onPlayFor(g),
      onEvent: (e) => {
        events++;
        const observation = observationOf(e);
        if (observation === null) return;
        delivered++;
        // Not the same object ⇒ the projection had to allocate.
        if (observation !== e) copied++;
      },
    });
  }
  console.log(`volume — ${a} vs ${b}, ${games} games`);
  console.log(`  events            ${events} (${(events / games).toFixed(1)} per game)`);
  console.log(`  delivered         ${delivered} (${((delivered / events) * 100).toFixed(1)}%)`);
  console.log(`  copied (allocated)${String(copied).padStart(7)} (${((copied / delivered) * 100).toFixed(1)}% of delivered, ${(copied / games).toFixed(1)} per game)`);
  console.log(`  passed by ref     ${delivered - copied} (${(((delivered - copied) / delivered) * 100).toFixed(1)}% of delivered)`);
}

const [, , mode = 'digest', ...rest] = process.argv;
if (mode === 'digest') digest();
else if (mode === 'throughput') await throughput(Number(rest[0] ?? 7), Number(rest[1] ?? 200));
else if (mode === 'plain') plain(Number(rest[0] ?? 3), Number(rest[1] ?? 200));
else if (mode === 'volume') await volume(Number(rest[0] ?? 20));
else {
  console.error(`unknown mode '${mode}' — use digest | throughput | plain | volume`);
  process.exit(1);
}
