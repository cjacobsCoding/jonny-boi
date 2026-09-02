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
import { createDefaultAiRegistry, HEURISTIC_PILOT_ID } from '@jonny-boi/ai';
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
const pilot = createDefaultAiRegistry().getPilot(HEURISTIC_PILOT_ID);
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

// --- time ONLY the decision function -------------------------------------------
// A fresh deterministic rng per rep so every rep is the identical workload; the
// pilot must not be able to tell one rep from another.
// ⚠️ WARM UP FIRST. The first pass over the corpus is JIT compilation, not the
// pilot: measured cold it reported a 56% spread across identical reps, which is
// wide enough to hide any real change. One discarded pass fixes it.
for (let warm = 0; warm < 2; warm++) {
  const rng = createRng(999);
  for (let i = 0; i < corpus.length; i++) {
    const entry = corpus[i];
    pilot.chooseAction({ view: entry.view, legalActions: entry.legalActions, rng, registry, rulesConfig: DEFAULT_RULES, observer: undefined });
  }
}

const times = [];
for (let rep = 0; rep < REPS; rep++) {
  const rng = createRng(12345);
  const started = process.hrtime.bigint();
  let sink = 0;
  for (let i = 0; i < corpus.length; i++) {
    const entry = corpus[i];
    const action = pilot.chooseAction({
      view: entry.view,
      legalActions: entry.legalActions,
      rng,
      registry,
      rulesConfig: DEFAULT_RULES,
      observer: undefined,
    });
    sink += action.kind.length; // keep the call from being optimised away
  }
  const seconds = Number(process.hrtime.bigint() - started) / 1e9;
  times.push(seconds);
  if (sink < 0) console.log('unreachable');
}

// The MEDIAN is the honest summary: the best of N reps drifts upward with N (it is
// a minimum of samples), and the worst catches whatever else the machine did.
const sorted = [...times].sort((a, b) => a - b);
const best = sorted[Math.floor(sorted.length / 2)];
const worst = sorted[sorted.length - 1];
const fastest = sorted[0];
console.log(`corpus: ${corpus.length} recorded decisions from ${GAMES * MATCHUPS.length} games`);
console.log(
  `decisions/sec: MEDIAN ${(corpus.length / best).toFixed(0)} ` +
    `(fastest ${(corpus.length / fastest).toFixed(0)}, slowest ${(corpus.length / worst).toFixed(0)}, ` +
    `${REPS} reps, spread ${(((worst - fastest) / fastest) * 100).toFixed(1)}%)`,
);
console.log(`microseconds per decision (median): ${((best / corpus.length) * 1e6).toFixed(2)}`);
