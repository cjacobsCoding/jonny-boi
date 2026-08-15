/**
 * MCTS perf bench (DESIGN §1 rule 7 — "instrument throughput; no regressions").
 *
 * Run from the repo root:
 *   node --expose-gc --max-semi-space-size=1 --min-semi-space-size=1 \
 *        packages/ai/bench/mcts-bench.mjs <mode> [n]
 *
 * Modes
 *   decisions        Replay a heuristic game, snapshot real decision positions,
 *                    then run the MCTS pilot on each with the REAL config.
 *                    Reports ms/decision AND allocated bytes/decision.
 *   profile          Same workload, with the V8 sampling heap profiler on, and
 *                    prints the top allocating functions.
 *   games            End-to-end games/sec (mcts vs heuristic).
 *   heuristic-games  End-to-end games/sec for the heuristic (the contrast).
 *
 * Why bytes/decision is the headline metric: this box has 6 physical cores and
 * thermally throttles under sustained all-core load, and other agents share it,
 * so wall-clock swings up to ~2x between runs of the SAME build. Allocated bytes
 * is a property of the code, not of the machine's mood.
 *
 * Two independent allocation counters are reported because neither is perfect:
 *   - scavengeBytes: the young-generation semi-space is pinned to 1 MB on the
 *     command line, so each scavenge means ~1 semi-space of young allocation.
 *     Coarse, but a direct consequence of real allocation and reproducible for a
 *     deterministic workload.
 *   - sampledBytes:  V8's sampling heap profiler, which also attributes the
 *     allocation to the functions that made it (`profile` mode).
 *
 * This file is deliberately plain `.mjs` outside `src/`: it is a measurement
 * tool, not shipped code, so it stays out of the package's `tsc` build and out
 * of the published surface. It resolves `@jonny-boi/*` through the workspace
 * links, so run `npm run build` first (it imports built `dist`).
 */

import { performance, PerformanceObserver } from 'node:perf_hooks';
import { Session } from 'node:inspector';
import { createHash } from 'node:crypto';
import { loadCardPool, buildRegistry } from '@jonny-boi/cards';
import { SAMPLE_DECKS, loadDeck, makeSeats, runMatch, gameSeedFor, onPlayFor } from '@jonny-boi/sim';
import { createHeuristicPilot, createMctsPilot, DEFAULT_MCTS_CONFIG } from '@jonny-boi/ai';
import { cloneState, DEFAULT_RULES, createRng } from '@jonny-boi/core';

const MB = 1024 * 1024;
/** Must match `--max-semi-space-size` on the command line above. */
const SEMI_SPACE_MB = 1;
/** Seeds are fixed so every run of the bench measures the identical workload. */
const POSITION_SEED = 12345;
const DECISION_RNG_SALT = 0xabcdef;
const GAMES_SEED = 777;
/** Sample every Nth non-trivial decision so positions span the whole game arc. */
const POSITION_STRIDE = 7;

const mode = process.argv[2] ?? 'decisions';
const count = Number(process.argv[3] ?? 24);

const pool = loadCardPool({ onWarn: () => {} });
const registry = buildRegistry();
const deckA = loadDeck(SAMPLE_DECKS[0], pool);
const deckB = loadDeck(SAMPLE_DECKS[1], pool);

// --- GC accounting ---------------------------------------------------------
// PerformanceObserver delivers entries on a later tick, so every read is behind
// an `await flush()` — a synchronous read would always see zero.
let scavenges = 0;
let majors = 0;
new PerformanceObserver((list) => {
  for (const e of list.getEntries()) {
    if (e.detail?.kind === 1) scavenges++;
    else majors++;
  }
}).observe({ entryTypes: ['gc'] });

const flush = () => new Promise((r) => setTimeout(r, 60));

// --- decision positions ----------------------------------------------------
/**
 * Play heuristic-vs-heuristic games, capturing the state + offered actions at
 * every `POSITION_STRIDE`-th non-trivial decision. Those snapshots are the MCTS
 * bench workload: real mid-game positions rather than a synthetic fixture.
 */
function collectPositions(n) {
  const positions = [];
  const base = createHeuristicPilot();
  let seen = 0;
  const capturing = {
    id: base.id,
    description: base.description,
    chooseAction(ctx) {
      const interesting = ctx.legalActions.length > 1 && ctx.legalActions.some((a) => a.kind !== 'passPriority');
      if (interesting && positions.length < n) {
        if (seen % POSITION_STRIDE === 0) {
          positions.push({ state: cloneState(ctx.view), legalActions: ctx.legalActions.map((a) => ({ ...a })) });
        }
        seen++;
      }
      return base.chooseAction(ctx);
    },
  };
  const seats = makeSeats(deckA, deckB, { pilotA: capturing, pilotB: base }, registry);
  for (let g = 0; positions.length < n && g < 60; g++) {
    runMatch(seats, gameSeedFor(POSITION_SEED, g), { startingPlayer: onPlayFor(g) });
  }
  return positions;
}

/** Run the MCTS pilot once per position; returns the chosen actions + wall time. */
function playDecisions(pilot, positions, perPosition) {
  const picks = [];
  const t0 = performance.now();
  for (let i = 0; i < positions.length; i++) {
    const p = positions[i];
    const t = performance.now();
    picks.push(
      pilot.chooseAction({
        view: cloneState(p.state),
        legalActions: p.legalActions,
        rng: createRng(DECISION_RNG_SALT ^ i),
        registry,
        rulesConfig: DEFAULT_RULES,
      }),
    );
    perPosition?.push(performance.now() - t);
  }
  return { picks, ms: performance.now() - t0 };
}

/** A stable hash of the chosen action sequence — the bit-identity check. */
function fingerprint(picks) {
  return createHash('sha256').update(picks.map((a) => JSON.stringify(a)).join('|')).digest('hex').slice(0, 16);
}

if (mode === 'decisions') {
  const positions = collectPositions(count);
  // BENCH_CONFIG overrides knobs for attribution runs (e.g. a cheaper rollout
  // policy, or half the depth) — the delta against the default isolates what a
  // given piece of the search costs. Never used for the headline numbers.
  const config = { ...DEFAULT_MCTS_CONFIG, ...JSON.parse(process.env.BENCH_CONFIG ?? '{}') };
  const pilot = createMctsPilot(config);
  playDecisions(pilot, positions.slice(0, 1)); // warm the JIT
  global.gc?.();
  await flush();
  const s0 = scavenges;
  const m0 = majors;
  const per = [];
  const { picks, ms } = playDecisions(pilot, positions, per);
  await flush();
  const n = positions.length;
  if (process.env.BENCH_VERBOSE) {
    per.forEach((t, i) =>
      console.log(`   #${i} ${positions[i].state.step} legal=${positions[i].legalActions.length} bf=${positions[i].state.battlefield.length} ${t.toFixed(1)}ms`),
    );
  }
  const bytes = (scavenges - s0) * SEMI_SPACE_MB * MB;
  console.log(
    `[decisions] n=${n} totalMs=${ms.toFixed(0)} msPerDecision=${(ms / n).toFixed(1)} ` +
      `scavenges=${scavenges - s0} majorGC=${majors - m0} ` +
      `scavengeBytesPerDecision=${(bytes / n / MB).toFixed(2)}MB`,
  );
  console.log(`fingerprint ${fingerprint(picks)}`);
}

if (mode === 'profile') {
  const positions = collectPositions(count);
  const pilot = createMctsPilot(DEFAULT_MCTS_CONFIG);
  playDecisions(pilot, positions.slice(0, 1));
  const session = new Session();
  session.connect();
  const post = (method, params) =>
    new Promise((res, rej) => session.post(method, params, (err, r) => (err ? rej(err) : res(r))));
  await post('HeapProfiler.enable');
  await post('HeapProfiler.startSampling', { samplingInterval: 8192 });
  const { ms } = playDecisions(pilot, positions);
  const { profile } = await post('HeapProfiler.getSamplingProfile');
  await post('HeapProfiler.stopSampling');
  session.disconnect();

  const byFn = new Map();
  let total = 0;
  const walk = (node) => {
    const size = node.selfSize ?? 0;
    total += size;
    if (size > 0) {
      const f = node.callFrame;
      const key = `${f.functionName || '(anon)'} @ ${String(f.url).split('/').slice(-2).join('/')}:${f.lineNumber + 1}`;
      byFn.set(key, (byFn.get(key) ?? 0) + size);
    }
    for (const c of node.children ?? []) walk(c);
  };
  walk(profile.head);
  const n = positions.length;
  console.log(`[profile] n=${n} totalMs=${ms.toFixed(0)} sampledTotal=${(total / MB).toFixed(1)}MB ` +
    `sampledBytesPerDecision=${(total / n / MB).toFixed(2)}MB`);
  for (const [k, v] of [...byFn.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)) {
    console.log(`  ${((v / total) * 100).toFixed(1).padStart(5)}%  ${(v / MB).toFixed(1).padStart(7)}MB  ${k}`);
  }
}

if (mode === 'breakdown') {
  // Where does a rollout PLY's allocation go? The rollout loop is
  //   legalAt(state)  →  rolloutPilot.chooseAction(...)  →  applyActionInPlace
  // plus one `cloneState` per simulation. Each piece is measured on the same real
  // positions in isolation, so the totals are attributable rather than guessed.
  const positions = collectPositions(count);
  const heuristic = createHeuristicPilot();
  const reps = 2000;
  const measure = async (label, fn) => {
    fn(); // warm
    global.gc?.();
    await flush();
    const s0 = scavenges;
    const t0 = performance.now();
    for (let r = 0; r < reps; r++) fn();
    const ms = performance.now() - t0;
    await flush();
    const perCall = ((scavenges - s0) * SEMI_SPACE_MB * MB) / reps;
    console.log(`  ${label.padEnd(34)} ${(perCall / 1024).toFixed(2).padStart(9)} KB/call  ${((ms / reps) * 1000).toFixed(1).padStart(8)} us/call`);
  };
  const { generateLegalActions, applyActionInPlace } = await import('@jonny-boi/core');
  for (const p of positions.slice(0, 4)) {
    console.log(`position: step=${p.state.step} legal=${p.legalActions.length} bf=${p.state.battlefield.length}`);
    const s = cloneState(p.state);
    await measure('cloneState', () => cloneState(s));
    await measure('generateLegalActions', () => generateLegalActions(s, DEFAULT_RULES));
    const legal = generateLegalActions(s, DEFAULT_RULES);
    await measure('heuristic.chooseAction', () =>
      heuristic.chooseAction({ view: s, legalActions: legal, rng: createRng(1) }),
    );
    await measure('applyActionInPlace(pass)', () => {
      const c = cloneState(s);
      applyActionInPlace(c, { kind: 'passPriority', player: c.priorityPlayer }, DEFAULT_RULES, registry);
    });
  }
}

if (mode === 'strength') {
  // The question perf alone cannot answer: does the look-ahead pilot actually
  // PLAY BETTER? Head-to-head, alternating who is on the play, fixed seeds.
  const { wilsonInterval } = await import('@jonny-boi/sim');
  const config = { ...DEFAULT_MCTS_CONFIG, ...JSON.parse(process.env.BENCH_CONFIG ?? '{}') };
  const mcts = createMctsPilot(config);
  const heuristic = createHeuristicPilot();
  let mctsWins = 0;
  let draws = 0;
  const t0 = performance.now();
  for (let g = 0; g < count; g++) {
    // Alternate which SEAT the MCTS pilot occupies as well as who is on the
    // play, so neither the seat nor the play advantage can flatter either pilot.
    // Four-way rotation so neither the SEAT (which deck) nor the PLAY (who goes
    // first) is confounded with the pilot: MCTS takes each deck on the play and
    // on the draw an equal number of times.
    const mctsIsA = g % 2 === 0;
    const seats = makeSeats(
      deckA,
      deckB,
      { pilotA: mctsIsA ? mcts : heuristic, pilotB: mctsIsA ? heuristic : mcts },
      registry,
    );
    const r = runMatch(seats, gameSeedFor(GAMES_SEED, g), { startingPlayer: g % 4 < 2 ? 'A' : 'B' });
    if (r.outcome.kind === 'timeout') draws++;
    else if ((r.outcome.winner === 'A') === mctsIsA) mctsWins++;
    if ((g + 1) % 10 === 0) {
      console.log(`  ${g + 1}/${count}: mcts ${mctsWins} wins, ${draws} draws @${((performance.now() - t0) / 60000).toFixed(1)}min`);
    }
  }
  const ci = wilsonInterval(mctsWins, count);
  console.log(
    `[strength] mcts vs heuristic, deck "${SAMPLE_DECKS[0].name}" vs "${SAMPLE_DECKS[1].name}", n=${count}: ` +
      `mctsWins=${mctsWins} draws=${draws} winRate=${(ci.p * 100).toFixed(1)}% ` +
      `95%CI=[${(ci.low * 100).toFixed(1)}%, ${(ci.high * 100).toFixed(1)}%] ` +
      `totalMin=${((performance.now() - t0) / 60000).toFixed(1)}`,
  );
}

if (mode === 'waste') {
  // The play-quality metric that got MCTS reverted last time: `manaPoolEmptied`
  // fires only when a step ends with mana still floating, i.e. mana tapped and
  // never spent. Mirrors packages/sim/src/pilot-quality.test.ts, same seeds,
  // same both-seats-one-pilot setup, so the numbers are comparable to the ones
  // on record (1.76/turn for mcts, 0.01/turn for the heuristic).
  const seeds = (process.env.WASTE_SEEDS ?? '1,2,3').split(',').map(Number);
  for (const [label, pilot] of [
    ['heuristic', createHeuristicPilot()],
    ['mcts', createMctsPilot({ ...DEFAULT_MCTS_CONFIG, ...JSON.parse(process.env.BENCH_CONFIG ?? '{}') })],
  ]) {
    let wasted = 0;
    let turns = 0;
    for (const seed of seeds) {
      let n = 0;
      const r = runMatch({ deckA, deckB, pilotA: pilot, pilotB: pilot, registry }, seed, {
        onEvent: (e) => {
          if (e.type === 'manaPoolEmptied') n++;
        },
      });
      wasted += n;
      turns += r.turns;
    }
    console.log(`[waste] ${label}: ${wasted} wasted-mana events over ${turns} turns = ${(wasted / turns).toFixed(3)}/turn`);
  }
}

if (mode === 'waste-trace') {
  // Diagnostic: print the decisions immediately before each wasted-mana event so
  // the CAUSE is visible rather than inferred (did the pilot tap and then pass?
  // tap toward a cast it then abandoned? tap in a window with nothing castable?).
  const pilot = createMctsPilot({ ...DEFAULT_MCTS_CONFIG, ...JSON.parse(process.env.BENCH_CONFIG ?? '{}') });
  const seed = Number(process.argv[3] ?? 1);
  const log = [];
  const r = runMatch({ deckA, deckB, pilotA: pilot, pilotB: pilot, registry }, seed, {
    recordTrace: true,
    onEvent: (e) => log.push(e),
  });
  let shown = 0;
  for (let i = 0; i < log.length && shown < 8; i++) {
    if (log[i].type !== 'manaPoolEmptied') continue;
    shown++;
    console.log(`--- wasted mana @event ${i}: ${JSON.stringify(log[i])}`);
    for (let j = Math.max(0, i - 8); j <= i; j++) console.log(`    ${JSON.stringify(log[j])}`);
  }
  console.log(`turns=${r.turns} wasted=${log.filter((e) => e.type === 'manaPoolEmptied').length}`);
}

if (mode === 'games' || mode === 'heuristic-games') {
  const isMcts = mode === 'games';
  const pilotA = isMcts ? createMctsPilot() : createHeuristicPilot();
  const seats = makeSeats(deckA, deckB, { pilotA, pilotB: createHeuristicPilot() }, registry);
  global.gc?.();
  await flush();
  const s0 = scavenges;
  const t0 = performance.now();
  let actions = 0;
  for (let g = 0; g < count; g++) {
    const r = runMatch(seats, gameSeedFor(GAMES_SEED, g), { startingPlayer: onPlayFor(g) });
    actions += r.actions;
    if (isMcts) console.log(`  game ${g}: ${r.outcome.kind} ${r.outcome.winner ?? ''} turns=${r.turns} actions=${r.actions} @${((performance.now() - t0) / 1000).toFixed(1)}s`);
  }
  const ms = performance.now() - t0;
  await flush();
  console.log(
    `[${mode}] n=${count} totalS=${(ms / 1000).toFixed(1)} gamesPerSec=${(count / (ms / 1000)).toFixed(4)} ` +
      `actionsPerGame=${(actions / count).toFixed(0)} scavenges=${scavenges - s0}`,
  );
}
