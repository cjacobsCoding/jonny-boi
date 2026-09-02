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
 * Usage: node packages/sim/bench/pilot-decide-bench.mjs [--games N] [--reps R]
 */
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
// Recorded with the feature OFF — see the timing section for why the corpus must
// not come from the pilot under test.
const pilot =
  FEATURE_AT >= 0
    ? createHeuristicPilot(undefined, { [process.argv[FEATURE_AT + 1]]: false })
    : createDefaultAiRegistry().getPilot(HEURISTIC_PILOT_ID);
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
    for (let i = 0; i < 4000 && !s.gameOver; i++) {
      const legalActions = generateLegalActions(s, DEFAULT_RULES);
      if (legalActions.length === 0) break;
      corpus.push({ view: s, legalActions, seat: s.priorityPlayer });
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
  for (let rep = 0; rep < REPS; rep++) {
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
    times.push(Number(process.hrtime.bigint() - started) / 1e9);
    if (sink < 0) console.log('unreachable');
  }
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

const show = (label, t) =>
  console.log(
    `  ${label}: MEDIAN ${(corpus.length / t.median).toFixed(0)} decisions/sec ` +
      `(${((t.median / corpus.length) * 1e6).toFixed(2)} us each; fastest ${(corpus.length / t.fastest).toFixed(0)}, ` +
      `slowest ${(corpus.length / t.slowest).toFixed(0)})`,
  );

console.log(`corpus: ${corpus.length} recorded decisions from ${GAMES * MATCHUPS.length} games`);
if (FEATURE) {
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
