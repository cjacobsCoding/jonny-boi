/**
 * DECISION BENCH — how fast is THE PILOT, on its own?
 *
 * ⚠️ WHY THIS IS NOT `pilot-bench.mjs`. That harness measures games/sec, which is
 * the ENGINE plus the pilot: applying actions, generating menus, checking state-based
 * actions, collecting triggers. A change that makes the pilot twice as fast moves that
 * number by a few percent and looks like noise, which is exactly what happened for
 * several rounds of this work. "Make the heuristics faster" is a claim about the
 * decision function, and it needs an instrument that measures only the decision
 * function.
 *
 * Method: play real games ONCE and record every (state, legalActions) the pilot was
 * asked about — then replay only `chooseAction` over that recorded corpus, timed.
 * Recording first matters: timing decisions inside a live game measures the engine
 * advancing between them, and the states a faster pilot reaches would differ anyway.
 *
 * The corpus is the pilot's REAL workload, in its real proportions — the cheap
 * fast-passed windows included, because making the rare expensive decision faster
 * while the common cheap one dominates is how an optimisation wins a microbenchmark
 * and loses the sim.
 *
 *
 * ⚠️ PROFILING THIS FILE: use a SMALL corpus and MANY reps
 * (`--games 8 --reps 40`). `--cpu-prof` profiles the whole process, and the
 * recording phase above calls `applyAction` once per decision — profile it with a
 * big corpus and few reps and the top of the table is the ENGINE, not the pilot.
 * That mistake reads as "the pilot spends 14% of its time cloning state", which it
 * does not: the heuristic pilot never clones (only `hybrid` and `mcts` do).
 *
 * ALSO A GUARD, not just a measurement: rule 7 says a change must not regress the
 * hot path, and a new strength feature costs DECISION time. This is the number to
 * quote for one — games/sec hides it behind the engine.
 *
 * ⚠️ TWO NUMBERS, AND THEY ANSWER DIFFERENT QUESTIONS (§3.108). The default
 * figure times `chooseAction` on EVERY recorded window — the cost of a decision
 * once the pilot is asked. `--harness` times the pilot as the match loop drives
 * it: the fast-pass gate first, and `chooseAction` only where the gate refuses,
 * with a promised continuation (`Pilot.chooseActions`) skipping the windows it
 * covers. That is the pilot's real cost per window in a sim, and it is the
 * number a gate or a plan seam moves — neither can make a decision cheaper, they
 * make it not happen. Quote the plain figure for a change to the decision
 * function, the harness figure for a change to how often it is called.
 *
 * `--old <path to another build of @jonny-boi/ai's dist/index.js>` times the same
 * pilot id from THAT build against this one, interleaved in one process — the
 * only fair way to compare two trees on a box whose wall clock drifts by a third
 * between runs of identical code (§3.108). Build the old tree, copy its
 * `packages/ai/dist` aside, rebuild, then point this at the copy.
 *
 * Usage: node packages/sim/bench/pilot-decide-bench.mjs [--games N] [--reps R] [--harness] [--pilot id] [--old path]
 */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createDefaultAiRegistry, createHeuristicPilot, HEURISTIC_PILOT_ID } from '@jonny-boi/ai';
import { buildRegistry, loadCardPool } from '@jonny-boi/cards';
import { applyAction, createGame, createRng, DEFAULT_RULES, generateLegalActions } from '@jonny-boi/core';
import { SAMPLE_DECKS } from '../dist/data/decks/index.js';
import { loadDeck } from '../dist/src/deck.js';

const arg = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? Number(process.argv[at + 1]) : fallback;
};
const GAMES = arg('games', 60);
const REPS = arg('reps', 7);

const pool = loadCardPool({ onWarn: () => {} });
const registry = buildRegistry();
const FEATURE_AT = process.argv.indexOf('--feature');
const HARNESS = process.argv.includes('--harness');
const PILOT_AT = process.argv.indexOf('--pilot');
const PILOT_ID = PILOT_AT >= 0 ? process.argv[PILOT_AT + 1] : HEURISTIC_PILOT_ID;
// Recorded with the feature OFF — see the timing section for why the corpus must
// not come from the pilot under test.
const OLD_AT = process.argv.indexOf('--old');
const OLD_DIST = OLD_AT >= 0 ? process.argv[OLD_AT + 1] : undefined;
// The corpus is recorded by the OLD build when one is given, for the same reason
// `--feature` records with the feature off: the workload must not come from the
// pilot under test.
const oldAi = OLD_DIST ? await import(pathToFileURL(resolve(OLD_DIST)).href) : undefined;
const pilot =
  FEATURE_AT >= 0
    ? createHeuristicPilot(undefined, { [process.argv[FEATURE_AT + 1]]: false })
    : (oldAi ?? { createDefaultAiRegistry }).createDefaultAiRegistry().getPilot(PILOT_ID);
if (!pilot) throw new Error(`no pilot '${PILOT_ID}'`);
const deckOf = (n) => loadDeck(SAMPLE_DECKS.find((d) => d.name === n), pool);

const MATCHUPS = [
  ['Mono-Red Aggro', 'UW Control'],
  ['Mono-Green Ramp', 'Golgari Midrange'],
  ['Orzhov Lifegain', 'Izzet Prowess'],
];

// --- record the pilot's real workload ------------------------------------------
const corpus = [];
for (const [aName, bName] of MATCHUPS) {
  const A = deckOf(aName);
  const B = deckOf(bName);
  for (let g = 0; g < GAMES; g++) {
    const { state } = createGame({
      seed: 101 + g,
      startingPlayer: g % 2 === 0 ? 'A' : 'B',
      decks: { A: { cards: A.library }, B: { cards: B.library } },
      registry,
    });
    let s = state;
    const rngs = { A: createRng(5 + g), B: createRng(4001 + g) };
    const game = corpus.length === 0 ? 0 : corpus[corpus.length - 1].game + 1;
    for (let i = 0; i < 4000 && !s.gameOver; i++) {
      const legalActions = generateLegalActions(s, DEFAULT_RULES);
      if (legalActions.length === 0) break;
      // `game` lets the harness mode know two consecutive entries are consecutive
      // windows of ONE game, which a continuation is only ever promised across.
      corpus.push({ view: s, legalActions, seat: s.priorityPlayer, game });
      const action = pilot.chooseAction({
        view: s,
        legalActions,
        rng: rngs[s.priorityPlayer],
        registry,
        rulesConfig: DEFAULT_RULES,
        observer: undefined,
      });
      s = applyAction(s, action, DEFAULT_RULES, registry).state;
    }
  }
}

// --- time the decision function ------------------------------------------------
//
// ⚠️ WHEN COMPARING TWO PILOTS, BOTH MUST BE TIMED ON THE SAME CORPUS. The corpus
// above is recorded by PLAYING, so a pilot that plays differently reaches
// different states and gets a different workload — and then "decisions/sec" is
// comparing two different questions, not two answers to one. The first attempt at
// measuring `setAttack`'s cost this way reported it as FASTER than the pilot it
// slowed down, because its corpus had drifted.
//
// So with `--feature`, the corpus is recorded with the feature OFF (the pilot as
// it was) and BOTH arms are then timed over those same recorded decisions.
const FEATURE = (() => {
  const at = process.argv.indexOf('--feature');
  return at >= 0 ? process.argv[at + 1] : undefined;
})();

/** One timed pass over the whole corpus. */
function onePass(subject) {
  const rng = createRng(12345);
  const started = process.hrtime.bigint();
  let sink = 0;
  for (let i = 0; i < corpus.length; i++) {
    const entry = corpus[i];
    const action = subject.chooseAction({
      view: entry.view,
      legalActions: entry.legalActions,
      rng,
      registry,
      rulesConfig: DEFAULT_RULES,
      observer: undefined,
    });
    sink += action.kind.length; // keep the call from being optimised away
  }
  if (sink < 0) console.log('unreachable');
  return Number(process.hrtime.bigint() - started) / 1e9;
}

function summarise(times) {
  // The MEDIAN is the honest summary: the best of N reps drifts downward in time
  // with N (it is a minimum of samples), and the worst catches whatever else the
  // machine happened to be doing.
  const sorted = [...times].sort((a, b) => a - b);
  return {
    median: sorted[Math.floor(sorted.length / 2)],
    fastest: sorted[0],
    slowest: sorted[sorted.length - 1],
  };
}

/**
 * Time two pilots against each other, INTERLEAVED.
 *
 * ⚠️ ORDER BIAS IS REAL AND IT IS LARGE. Timing one arm to completion and then
 * the other hands the second arm a hotter process: shared code paths are already
 * JIT-compiled and the heap is settled. Measured that way, the arm that does
 * strictly MORE work came out 9.9% FASTER — a result that is obviously impossible
 * and would have been reported as a free lunch. Alternating the reps, and
 * alternating which arm goes first WITHIN each rep, cancels it.
 */
function timeBoth(a, b, reps) {
  for (let warm = 0; warm < 2; warm++) {
    onePass(a);
    onePass(b);
  }
  const aTimes = [];
  const bTimes = [];
  for (let rep = 0; rep < reps; rep++) {
    if (rep % 2 === 0) {
      aTimes.push(onePass(a));
      bTimes.push(onePass(b));
    } else {
      bTimes.push(onePass(b));
      aTimes.push(onePass(a));
    }
  }
  return { a: summarise(aTimes), b: summarise(bTimes) };
}

/**
 * One pass over the corpus AS THE MATCH LOOP WOULD DRIVE THE PILOT: the gate is
 * asked first and a `true` costs nothing more; a continuation promised by
 * `chooseActions` is consumed against the following windows of the same game and
 * seat, dropped exactly where `runMatch` drops it (priority moved, a choice was
 * parked, the stack changed depth). Returns the pass time and, for the report,
 * how many windows the gate and the plan took between them.
 */
function oneHarnessPass(subject, rng) {
  let sink = 0;
  let gated = 0;
  let planned = 0;
  let queued = null;
  let queuedAt = 0;
  let queuedSeat = null;
  let queuedGame = -1;
  let stackDepth = 0;
  const cpuStarted = process.cpuUsage();
  const started = process.hrtime.bigint();
  for (let i = 0; i < corpus.length; i++) {
    const entry = corpus[i];
    const view = entry.view;
    if (
      queued !== null &&
      queuedAt < queued.length &&
      entry.game === queuedGame &&
      view.priorityPlayer === queuedSeat &&
      view.pendingChoice == null &&
      view.stack.length === stackDepth
    ) {
      sink += queued[queuedAt++].kind.length;
      planned++;
      continue;
    }
    queued = null;
    if (subject.willPassPriority?.(view, DEFAULT_RULES) === true) {
      gated++;
      continue;
    }
    const ctx = { view, legalActions: entry.legalActions, rng, registry, rulesConfig: DEFAULT_RULES, observer: undefined };
    if (subject.chooseActions) {
      const plan = subject.chooseActions(ctx);
      sink += plan[0].kind.length;
      if (plan.length > 1) {
        queued = plan;
        queuedAt = 1;
        queuedSeat = entry.seat;
        queuedGame = entry.game;
        stackDepth = view.stack.length;
      }
    } else {
      sink += subject.chooseAction(ctx).kind.length;
    }
  }
  const seconds = Number(process.hrtime.bigint() - started) / 1e9;
  const cpu = process.cpuUsage(cpuStarted);
  if (sink < 0) console.log('unreachable');
  return { seconds, cpuSeconds: (cpu.user + cpu.system) / 1e6, gated, planned };
}

function timeHarness(subject) {
  for (let warm = 0; warm < 2; warm++) oneHarnessPass(subject, createRng(999));
  const times = [];
  const cpuTimes = [];
  let last;
  for (let rep = 0; rep < REPS; rep++) {
    last = oneHarnessPass(subject, createRng(12345));
    times.push(last.seconds);
    cpuTimes.push(last.cpuSeconds);
  }
  return { ...summarise(times), cpuMedian: summarise(cpuTimes).median, gated: last.gated, planned: last.planned };
}

/** Two subjects, harness-driven, interleaved rep by rep as `timeBoth` does. */
function timeHarnessBoth(a, b, reps) {
  for (let warm = 0; warm < 2; warm++) {
    oneHarnessPass(a, createRng(999));
    oneHarnessPass(b, createRng(999));
  }
  const run = { a: { times: [], cpu: [], last: undefined }, b: { times: [], cpu: [], last: undefined } };
  const take = (side, subject) => {
    side.last = oneHarnessPass(subject, createRng(12345));
    side.times.push(side.last.seconds);
    side.cpu.push(side.last.cpuSeconds);
  };
  for (let rep = 0; rep < reps; rep++) {
    if (rep % 2 === 0) {
      take(run.a, a);
      take(run.b, b);
    } else {
      take(run.b, b);
      take(run.a, a);
    }
  }
  const finish = (side) => ({
    ...summarise(side.times),
    cpuMedian: summarise(side.cpu).median,
    gated: side.last.gated,
    planned: side.last.planned,
  });
  return { a: finish(run.a), b: finish(run.b) };
}

function timePilot(subject) {
  // Warm up first: measured cold, identical reps spread >50%, which is wide
  // enough to hide any real change.
  for (let warm = 0; warm < 2; warm++) {
    const rng = createRng(999);
    for (let i = 0; i < corpus.length; i++) {
      const entry = corpus[i];
      subject.chooseAction({ view: entry.view, legalActions: entry.legalActions, rng, registry, rulesConfig: DEFAULT_RULES, observer: undefined });
    }
  }
  const times = [];
  const cpuTimes = [];
  for (let rep = 0; rep < REPS; rep++) {
    const rng = createRng(12345);
    const cpuStarted = process.cpuUsage();
    const started = process.hrtime.bigint();
    let sink = 0;
    for (let i = 0; i < corpus.length; i++) {
      const entry = corpus[i];
      const action = subject.chooseAction({
        view: entry.view,
        legalActions: entry.legalActions,
        rng,
        registry,
        rulesConfig: DEFAULT_RULES,
        observer: undefined,
      });
      sink += action.kind.length; // keep the call from being optimised away
    }
    times.push(Number(process.hrtime.bigint() - started) / 1e9);
    const cpu = process.cpuUsage(cpuStarted);
    cpuTimes.push((cpu.user + cpu.system) / 1e6);
    if (sink < 0) console.log('unreachable');
  }
  // The MEDIAN is the honest summary: the best of N reps drifts downward in time
  // with N (it is a minimum of samples), and the worst catches whatever else the
  // machine happened to be doing. The CPU-time median is reported beside it for
  // the same reason `pilot-bench.mjs` reports one: two trees can only be timed
  // one after the other, and on a shared box the wall clock between them drifts
  // more than most changes are worth.
  const sorted = [...times].sort((a, b) => a - b);
  return {
    median: sorted[Math.floor(sorted.length / 2)],
    fastest: sorted[0],
    slowest: sorted[sorted.length - 1],
    cpuMedian: summarise(cpuTimes).median,
  };
}

const show = (label, t) =>
  console.log(
    `  ${label}: MEDIAN ${(corpus.length / t.median).toFixed(0)} decisions/sec ` +
      `(${((t.median / corpus.length) * 1e6).toFixed(2)} us each; fastest ${(corpus.length / t.fastest).toFixed(0)}, ` +
      `slowest ${(corpus.length / t.slowest).toFixed(0)})` +
      (t.cpuMedian !== undefined ? `; CPU ${(corpus.length / t.cpuMedian).toFixed(0)} decisions/cpu-sec` : ''),
  );

console.log(`corpus: ${corpus.length} recorded decisions from ${GAMES * MATCHUPS.length} games`);
const pct = (n) => `${((n / corpus.length) * 100).toFixed(1)}%`;
const showHarness = (label, t) => {
  console.log(
    `  ${label} as the harness drives it: MEDIAN ${(corpus.length / t.median).toFixed(0)} windows/sec ` +
      `(${((t.median / corpus.length) * 1e6).toFixed(2)} us per window; fastest ${(corpus.length / t.fastest).toFixed(0)}, ` +
      `slowest ${(corpus.length / t.slowest).toFixed(0)}); CPU ${(corpus.length / t.cpuMedian).toFixed(0)} windows/cpu-sec`,
  );
  console.log(
    `    gate took ${t.gated} windows (${pct(t.gated)}), the plan seam ${t.planned} (${pct(t.planned)}), ` +
      `decided ${corpus.length - t.gated - t.planned} (${pct(corpus.length - t.gated - t.planned)})`,
  );
};
if (OLD_DIST) {
  // OLD is the recorded pilot; NEW is the same id from this build. Interleaved.
  const fresh = createDefaultAiRegistry().getPilot(PILOT_ID);
  if (HARNESS) {
    const { a: old, b: now } = timeHarnessBoth(pilot, fresh, REPS);
    showHarness(`${PILOT_ID} OLD (${OLD_DIST})`, old);
    showHarness(`${PILOT_ID} NEW`, now);
    console.log(`  NEW/OLD: ${(old.median / now.median).toFixed(2)}x wall, ${(old.cpuMedian / now.cpuMedian).toFixed(2)}x CPU`);
  } else {
    const { a: old, b: now } = timeBoth(pilot, fresh, REPS);
    show(`${PILOT_ID} OLD`, old);
    show(`${PILOT_ID} NEW`, now);
    console.log(`  NEW/OLD: ${(old.median / now.median).toFixed(2)}x wall`);
  }
} else if (HARNESS) {
  showHarness(pilot.id, timeHarness(pilot));
} else if (FEATURE) {
  const { a: off, b: on } = timeBoth(
    createHeuristicPilot(undefined, { [FEATURE]: false }),
    createHeuristicPilot(undefined, { [FEATURE]: true }),
    REPS,
  );
  show(`${FEATURE} OFF`, off);
  show(`${FEATURE} ON `, on);
  const delta = ((off.median - on.median) / off.median) * 100;
  console.log(
    `  ${FEATURE} costs ${(-delta).toFixed(1)}% of decision time ` +
      `(negative means it is cheaper; rule 7 wants this at or below zero).`,
  );
} else {
  show('pilot', timePilot(pilot));
}
