/**
 * MCTS perf bench (DESIGN §1 rule 7 — "instrument throughput; no regressions").
 *
 * Run from the repo root:
 *   node --expose-gc --max-semi-space-size=1 --min-semi-space-size=1 \
 *        packages/ai/bench/mcts-bench.mjs <mode> [n]
 *
 * Modes
 *   instrument       PHASE 1 of the superhuman-AI program brief (§2, §65): the
 *                    whole measured table — branching factors, tree depth,
 *                    simulations/sec, decision time, the per-call cost of every
 *                    engine primitive the search leans on, the rollout-depth cost
 *                    model, and the measured sources of redundant search. Every
 *                    micro-measurement is INTERLEAVED across rounds and reported
 *                    as a median, because wall clock on this box drifts ~19%
 *                    between runs of identical code and sequential comparisons
 *                    have already produced a wrong answer here once.
 *   decisions        Replay a heuristic game, snapshot real decision positions,
 *                    then run the MCTS pilot on each with the REAL config.
 *                    Reports ms/decision AND allocated bytes/decision.
 *   profile          Same workload, with the V8 sampling heap profiler on, and
 *                    prints the top allocating functions.
 *   hybrid-strength  HEURISTIC vs HYBRID over n seeded games with seat AND play
 *                    rotated — win rate, Wilson CI, mean/p95 decision time, and
 *                    ELO/ms. The brief's §47/§59-61 metric: strength per
 *                    millisecond, not simulations per second.
 *   tactical         BRIEF §11-12/§39: the tactical solver in the leaf evaluator,
 *                    A/B'd against the shipped default. Arms interleaved in ONE
 *                    process on paired seeds; the control is `DEFAULT_HYBRID_CONFIG`,
 *                    whose zeroed tactical weights make it skip the solver
 *                    entirely, so "before" pays none of the new cost.
 *                    `BENCH_TACTICAL_ARMS=control,lethal,router,facing,pressure,clock,no-router,full`
 *                    runs the per-term ablation — which terms EARNED their place.
 *   tactical-duel    The same question asked head to head (tactical vs
 *                    shipped default directly) instead of through the heuristic.
 *                    More sensitive: everything the two arms share cancels per
 *                    game rather than only in expectation.
 *   scaling          The user's stated success metric: hybrid vs heuristic at
 *                    increasing simulation budgets. More search time MUST make
 *                    measurably stronger play, or it is not a search.
 *   modes            Every selectable mode (RANDOM / VANILLA_MCTS / HYBRID) against
 *                    the same heuristic baseline on the same seeds, one command.
 *                    ⚠️ VANILLA_MCTS is ~2000x the heuristic's cost — keep n small.
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
import {
  createHeuristicPilot,
  createMctsPilot,
  DEFAULT_MCTS_CONFIG,
  createCollectingStatsSink,
  countEquivalentActions,
} from '@jonny-boi/ai';
import {
  cloneState,
  DEFAULT_RULES,
  createRng,
  generateLegalActions,
  applyActionInPlace,
  planManaPayment,
} from '@jonny-boi/core';

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
// Which two decks the bench plays. Defaults to the first two sample decks so every
// number stays comparable with the ones already on record, but a strength claim
// measured on ONE matchup is a claim about that matchup — `BENCH_DECKS=4,6` (indices
// into SAMPLE_DECKS) re-runs it somewhere else to check the result generalises.
const [DECK_A_INDEX, DECK_B_INDEX] = (process.env.BENCH_DECKS ?? '0,1').split(',').map(Number);
const deckA = loadDeck(SAMPLE_DECKS[DECK_A_INDEX], pool);
const deckB = loadDeck(SAMPLE_DECKS[DECK_B_INDEX], pool);

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

// --- Phase 1: the instrumented table ---------------------------------------
/**
 * Median of an array of numbers. Medians, not means, everywhere in `instrument`:
 * a single thermal stall inflates a mean and leaves no trace, while a median over
 * interleaved rounds simply ignores it.
 */
function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Measure a set of labelled thunks INTERLEAVED: every round runs every thunk, so
 * a machine that speeds up or slows down mid-measurement affects all of them
 * equally instead of flattering whichever ran while it was cool. Reports the
 * median round for time, and total allocation / total calls for bytes (allocation
 * is a property of the code and needs no such defence, but it is quantised to
 * ~1 MB by the scavenge counter, so it is only summed at the end).
 */
async function interleavedMicro(entries, reps, rounds) {
  const times = new Map(entries.map(([label]) => [label, []]));
  const bytes = new Map(entries.map(([label]) => [label, 0]));
  for (const [, fn] of entries) fn(); // warm every one before timing any
  for (let r = 0; r < rounds; r++) {
    for (const [label, fn] of entries) {
      global.gc?.();
      await flush();
      const s0 = scavenges;
      const t0 = performance.now();
      for (let i = 0; i < reps; i++) fn();
      const ms = performance.now() - t0;
      await flush();
      times.get(label).push((ms / reps) * 1000); // µs/call
      bytes.set(label, bytes.get(label) + (scavenges - s0) * SEMI_SPACE_MB * MB);
    }
  }
  return entries.map(([label]) => ({
    label,
    us: median(times.get(label)),
    bytesPerCall: bytes.get(label) / (reps * rounds),
  }));
}

if (mode === 'instrument') {
  const rounds = Number(process.env.BENCH_ROUNDS ?? 5);
  const positions = collectPositions(count);
  const config = { ...DEFAULT_MCTS_CONFIG, ...JSON.parse(process.env.BENCH_CONFIG ?? '{}') };

  // 1. TREE SHAPE + THROUGHPUT — the search reporting on itself.
  const sink = createCollectingStatsSink();
  const instrumented = createMctsPilot(config, sink);
  playDecisions(instrumented, positions.slice(0, 1)); // warm
  sink.decisions.length = 0;
  global.gc?.();
  await flush();
  const s0 = scavenges;
  const per = [];
  const { ms } = playDecisions(instrumented, positions, per);
  await flush();
  const n = positions.length;
  const shape = sink.summary();
  const sorted = [...per].sort((a, b) => a - b);
  const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
  const allocPerDecision = ((scavenges - s0) * SEMI_SPACE_MB * MB) / n;

  console.log(`\n=== PHASE 1 · search shape (n=${n} real mid-game positions, ${config.simulationsPerDecision} sims × depth ${config.rolloutDepth}) ===`);
  console.log(`  root branching (mean / max)      ${shape.meanRootBranching.toFixed(1)} / ${shape.maxRootBranching}`);
  console.log(`  node branching (mean / max)      ${shape.meanBranching.toFixed(1)} / ${shape.maxBranching}`);
  console.log(`  root redundancy (equivalent)     ${(shape.rootRedundancyRate * 100).toFixed(1)}%`);
  console.log(`  tree depth (mean / max edges)    ${shape.meanTreeDepth.toFixed(1)} / ${shape.maxTreeDepth}`);
  console.log(`  tree nodes per decision (mean)   ${shape.meanNodes.toFixed(0)}`);
  console.log(`  plies per simulation (mean)      ${shape.meanPliesPerSimulation.toFixed(1)}  (tree ${(shape.totalTreePlies / shape.totalSimulations).toFixed(2)} + rollout ${(shape.totalRolloutPlies / shape.totalSimulations).toFixed(1)})`);
  console.log(`  rollouts reaching a terminal     ${(shape.terminalRate * 100).toFixed(1)}%`);
  console.log(`  decision time (mean / p95)       ${(ms / n).toFixed(0)} ms / ${p95.toFixed(0)} ms`);
  console.log(`  simulations / sec                ${(shape.totalSimulations / (ms / 1000)).toFixed(0)}`);
  console.log(`  engine plies / sec               ${((shape.totalTreePlies + shape.totalRolloutPlies) / (ms / 1000)).toFixed(0)}`);
  console.log(`  allocation / decision            ${(allocPerDecision / MB).toFixed(2)} MB`);
  console.log(`  clones / decision                ${(shape.totalClones / n).toFixed(0)}`);

  // 2. PER-CALL COST of every primitive the search leans on. Interleaved.
  const heuristic = createHeuristicPilot();
  const reps = Number(process.env.BENCH_REPS ?? 3000);
  const sample = cloneState(positions[Math.floor(positions.length / 2)].state);
  const sampleLegal = generateLegalActions(sample, DEFAULT_RULES);
  const passAction = { kind: 'passPriority', player: sample.priorityPlayer };
  const spellCost = { generic: 1, R: 1 };
  const micro = await interleavedMicro(
    [
      ['cloneState', () => cloneState(sample)],
      ['generateLegalActions', () => generateLegalActions(sample, DEFAULT_RULES)],
      ['heuristic.chooseAction (policy)', () => heuristic.chooseAction({ view: sample, legalActions: sampleLegal, rng: createRng(1) })],
      ['planManaPayment', () => planManaPayment(sample, sample.priorityPlayer, spellCost, sampleLegal)],
      ['countEquivalentActions', () => countEquivalentActions(sample, sampleLegal)],
      ['clone + applyActionInPlace', () => applyActionInPlace(cloneState(sample), passAction, DEFAULT_RULES, registry)],
    ],
    reps,
    rounds,
  );
  console.log(`\n=== PHASE 1 · per-call cost (median of ${rounds} interleaved rounds × ${reps} reps) ===`);
  for (const m of micro) {
    console.log(`  ${m.label.padEnd(34)} ${m.us.toFixed(2).padStart(8)} µs   ${(m.bytesPerCall / 1024).toFixed(2).padStart(8)} KB`);
  }
  const clone = micro.find((m) => m.label === 'cloneState');
  const cloneApply = micro.find((m) => m.label === 'clone + applyActionInPlace');
  console.log(`  ${'applyActionInPlace (derived)'.padEnd(34)} ${(cloneApply.us - clone.us).toFixed(2).padStart(8)} µs   ${((cloneApply.bytesPerCall - clone.bytesPerCall) / 1024).toFixed(2).padStart(8)} KB`);

  // 3. ROLLOUT COST MODEL — is cost linear in rollout depth, and what is the
  //    intercept (tree + clone + node allocation) versus the slope (per rollout
  //    ply)? This is the number that says whether a strong leaf evaluator is the
  //    highest-leverage change, so it is measured rather than argued.
  const depths = (process.env.BENCH_DEPTHS ?? '1,15,30,60,120').split(',').map(Number);
  const shortPositions = positions.slice(0, Math.min(positions.length, 12));
  const depthRows = [];
  for (let r = 0; r < Math.max(2, Math.min(rounds, 3)); r++) {
    for (const depth of depths) {
      const p = createMctsPilot({ ...config, rolloutDepth: depth });
      playDecisions(p, shortPositions.slice(0, 1));
      global.gc?.();
      await flush();
      const d0 = scavenges;
      const t0 = performance.now();
      playDecisions(p, shortPositions);
      const dms = performance.now() - t0;
      await flush();
      depthRows.push({
        depth,
        ms: dms / shortPositions.length,
        mb: ((scavenges - d0) * SEMI_SPACE_MB * MB) / shortPositions.length / MB,
      });
    }
  }
  console.log(`\n=== PHASE 1 · rollout-depth cost model (n=${shortPositions.length} positions) ===`);
  for (const depth of depths) {
    const rows = depthRows.filter((x) => x.depth === depth);
    console.log(`  depth ${String(depth).padStart(3)}   ${median(rows.map((x) => x.ms)).toFixed(0).padStart(6)} ms/decision   ${median(rows.map((x) => x.mb)).toFixed(2).padStart(7)} MB/decision`);
  }

  // 4. REDUNDANT / FORCED DECISIONS over a REAL GAME, not a sampled position set.
  //    Two separate wins are quantified here, and they are the two Phase-2 items:
  //    decisions that have exactly one sensible answer (Level 0, forced) and
  //    offered actions that collapse onto each other (Level 1, equivalent).
  let decisions = 0;
  let forced = 0;
  let onlyPass = 0;
  let offeredTotal = 0;
  let distinctTotal = 0;
  const base = createHeuristicPilot();
  const counting = {
    id: base.id,
    description: base.description,
    chooseAction(ctx) {
      decisions++;
      const nonPass = ctx.legalActions.filter((a) => a.kind !== 'passPriority');
      if (ctx.legalActions.length <= 1) forced++;
      else if (nonPass.length === 0) onlyPass++;
      const eq = countEquivalentActions(ctx.view, ctx.legalActions);
      offeredTotal += eq.offered;
      distinctTotal += eq.distinct;
      return base.chooseAction(ctx);
    },
  };
  const countSeats = makeSeats(deckA, deckB, { pilotA: counting, pilotB: counting }, registry);
  const GAMES = Number(process.env.BENCH_GAMES ?? 20);
  for (let g = 0; g < GAMES; g++) runMatch(countSeats, gameSeedFor(POSITION_SEED, g), { startingPlayer: onPlayFor(g) });
  console.log(`\n=== PHASE 1 · redundant search (${GAMES} full heuristic-vs-heuristic games, ${decisions} decisions) ===`);
  console.log(`  decisions with a single legal action   ${((forced / decisions) * 100).toFixed(1)}%`);
  console.log(`  decisions offering only 'pass'         ${((onlyPass / decisions) * 100).toFixed(1)}%`);
  console.log(`  => decisions a search need never see   ${(((forced + onlyPass) / decisions) * 100).toFixed(1)}%`);
  console.log(`  offered actions collapsing (mana etc.) ${(((offeredTotal - distinctTotal) / offeredTotal) * 100).toFixed(1)}%  (${offeredTotal} offered → ${distinctTotal} distinct)`);
  console.log('');
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
  // CAVEAT: this mode is COARSE. The scavenge counter resolves ~1 MB, so a
  // per-call figure is quantised to (1 MB / reps) and only means anything as an
  // order of magnitude; pushing reps up past a few thousand makes it worse, not
  // better, because the surviving objects start being promoted and collected by
  // major GCs instead. For attribution you can actually lean on, scale a knob in
  // `decisions` mode (halve `rolloutDepth`, swap `rolloutPolicy`) and read the
  // delta — that measures the real search, at the real allocation volume.
  //
  // Where does a rollout PLY's allocation go? The rollout loop is
  //   legalAt(state)  →  rolloutPilot.chooseAction(...)  →  applyActionInPlace
  // plus one `cloneState` per simulation. Each piece is measured on the same real
  // positions in isolation, so the totals are attributable rather than guessed.
  const positions = collectPositions(count);
  const heuristic = createHeuristicPilot();
  const reps = Number(process.env.BENCH_REPS ?? 2000);
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
  for (const p of positions.slice(0, 4)) {
    console.log(`position: step=${p.state.step} legal=${p.legalActions.length} bf=${p.state.battlefield.length}`);
    const s = cloneState(p.state);
    await measure('cloneState', () => cloneState(s));
    await measure('generateLegalActions', () => generateLegalActions(s, DEFAULT_RULES));
    const legal = generateLegalActions(s, DEFAULT_RULES);
    await measure('heuristic.chooseAction', () =>
      heuristic.chooseAction({ view: s, legalActions: legal, rng: createRng(1) }),
    );
    await measure('clone+applyInPlace(pass)', () => {
      const c = cloneState(s);
      applyActionInPlace(c, { kind: 'passPriority', player: c.priorityPlayer }, DEFAULT_RULES, registry);
    });
  }
}

if (mode === 'strength') {
  // The question perf alone cannot answer: does the look-ahead pilot actually
  // PLAY BETTER? Head-to-head, alternating who is on the play, fixed seeds.
  const { wilsonInterval, DEFAULT_STATS_CONFIG } = await import('@jonny-boi/sim');
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
  const ci = wilsonInterval(mctsWins, count, DEFAULT_STATS_CONFIG.z);
  console.log(
    `[strength] mcts vs heuristic, deck "${deckA.name}" vs "${deckB.name}", n=${count}: ` +
      `mctsWins=${mctsWins} draws=${draws} winRate=${(ci.p * 100).toFixed(1)}% ` +
      `95%CI=[${(ci.low * 100).toFixed(1)}%, ${(ci.high * 100).toFixed(1)}%] ` +
      `totalMin=${((performance.now() - t0) / 60000).toFixed(1)}`,
  );
}

// --- HEURISTIC vs HYBRID, the metric that actually matters -------------------
/**
 * The brief's §47/§59–61 measurement: not "is the search faster" but "is the
 * play stronger, per millisecond of decision time".
 *
 * Both seats are timed, so the report can state what each pilot actually spent
 * rather than what its budget nominally allowed. Seat AND play are rotated on a
 * four-way cycle so neither which deck nor who goes first is confounded with the
 * pilot — the same rotation the existing `strength` mode uses, kept identical so
 * the numbers are comparable with the 40.8% already on record for vanilla MCTS.
 *
 * Determinism note: every arm here runs a `simulations` budget, never a `millis`
 * one. A wall-clock budget would make the two arms' searches machine-dependent
 * and the comparison unreproducible — see `SearchBudget`.
 */
function timedPilot(pilot, sink) {
  return {
    id: pilot.id,
    description: pilot.description,
    chooseAction(ctx) {
      const t0 = performance.now();
      const action = pilot.chooseAction(ctx);
      sink.push(performance.now() - t0);
      return action;
    },
  };
}

function eloFromWinRate(p) {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  return -400 * Math.log10(1 / p - 1);
}

async function headToHead(makeChallenger, label, games, seedBase) {
  // `wilsonInterval` REQUIRES the z multiplier — omitting it yields NaN bounds,
  // which is what the older `strength` mode below was silently doing. The 95%
  // two-sided value is named data in the sim's own config, so it is read from
  // there rather than restated as a literal.
  const { wilsonInterval, DEFAULT_STATS_CONFIG } = await import('@jonny-boi/sim');
  const challengerTimes = [];
  const baselineTimes = [];
  let wins = 0;
  let draws = 0;
  const t0 = performance.now();
  for (let g = 0; g < games; g++) {
    const challenger = timedPilot(makeChallenger(), challengerTimes);
    const baseline = timedPilot(createHeuristicPilot(), baselineTimes);
    const isA = g % 2 === 0;
    const seats = makeSeats(
      deckA,
      deckB,
      { pilotA: isA ? challenger : baseline, pilotB: isA ? baseline : challenger },
      registry,
    );
    const r = runMatch(seats, gameSeedFor(seedBase, g), { startingPlayer: g % 4 < 2 ? 'A' : 'B' });
    if (r.outcome.kind === 'timeout') draws++;
    else if ((r.outcome.winner === 'A') === isA) wins++;
  }
  const wall = performance.now() - t0;
  const ci = wilsonInterval(wins, games, DEFAULT_STATS_CONFIG.z);
  const sortedC = [...challengerTimes].sort((a, b) => a - b);
  const meanC = challengerTimes.reduce((a, b) => a + b, 0) / challengerTimes.length;
  const p95C = sortedC[Math.min(sortedC.length - 1, Math.floor(sortedC.length * 0.95))];
  const meanB = baselineTimes.reduce((a, b) => a + b, 0) / baselineTimes.length;
  const elo = eloFromWinRate(ci.p);
  return {
    label,
    games,
    wins,
    draws,
    p: ci.p,
    low: ci.low,
    high: ci.high,
    meanMs: meanC,
    p95Ms: p95C,
    baselineMeanMs: meanB,
    elo,
    eloPerMs: elo / meanC,
    wallSec: wall / 1000,
    decisions: challengerTimes.length,
  };
}

function printHeadToHead(r) {
  console.log(
    `  ${r.label.padEnd(26)} ${String(r.wins).padStart(4)}/${r.games}  ` +
      `winRate=${(r.p * 100).toFixed(1)}% CI=[${(r.low * 100).toFixed(1)}%, ${(r.high * 100).toFixed(1)}%]  ` +
      `elo=${r.elo.toFixed(0).padStart(5)}  ` +
      `decision mean=${r.meanMs.toFixed(2)}ms p95=${r.p95Ms.toFixed(2)}ms  ` +
      `(heuristic ${r.baselineMeanMs.toFixed(3)}ms)  elo/ms=${r.eloPerMs.toFixed(1)}  ${r.wallSec.toFixed(0)}s`,
  );
}

if (mode === 'hybrid-strength') {
  const { createHybridPilot, DEFAULT_HYBRID_CONFIG } = await import('@jonny-boi/ai');
  const overrides = JSON.parse(process.env.BENCH_CONFIG ?? '{}');
  const config = { ...DEFAULT_HYBRID_CONFIG, ...overrides };
  console.log(`\n=== HEURISTIC vs HYBRID (${deckA.name} vs ${deckB.name}, seat+play rotated) ===`);
  console.log(`  budget: ${JSON.stringify(config.budget)}  leafRolloutDepth=${config.leafRolloutDepth}`);
  printHeadToHead(await headToHead(() => createHybridPilot(config), 'hybrid', count, GAMES_SEED));
  console.log('');
}

/**
 * INTERLEAVED paired A/B over the SAME seeded games (brief §21–22's measurement).
 *
 * Two defences against this box, which drifts ~19% between runs of identical
 * code, and they are different defences:
 *   - INTERLEAVING (arm A game 0, arm B game 0, arm A game 1, …) is what makes
 *     the TIMING comparable. A sequential run has already "proved" a change free
 *     on this machine that a proper interleaved run showed cost 4%.
 *   - PAIRING on the seed is what makes the STRENGTH comparable: both arms play
 *     the identical games, so the difference is the arm and not the shuffle.
 *
 * Worth stating plainly: the win rates here do NOT need interleaving, because the
 * sim is deterministic in the seed — arm A's wins are the same number whenever it
 * runs. Interleaving is purely for the milliseconds. That is also why these
 * numbers are directly comparable with the `hybrid-strength` figures already on
 * record: same seeds, same seat/play rotation, same opponent.
 */
async function interleavedArms(arms, games, seedBase) {
  const { wilsonInterval, DEFAULT_STATS_CONFIG } = await import('@jonny-boi/sim');
  const state = arms.map((arm) => ({
    arm,
    wins: 0,
    draws: 0,
    times: [],
    baselineTimes: [],
    wall: 0,
  }));
  for (let g = 0; g < games; g++) {
    for (const s of state) {
      const challenger = timedPilot(s.arm.make(), s.times);
      const baseline = timedPilot(createHeuristicPilot(), s.baselineTimes);
      const isA = g % 2 === 0;
      const seats = makeSeats(
        deckA,
        deckB,
        { pilotA: isA ? challenger : baseline, pilotB: isA ? baseline : challenger },
        registry,
      );
      const t0 = performance.now();
      const r = runMatch(seats, gameSeedFor(seedBase, g), { startingPlayer: g % 4 < 2 ? 'A' : 'B' });
      s.wall += performance.now() - t0;
      if (r.outcome.kind === 'timeout') s.draws++;
      else if ((r.outcome.winner === 'A') === isA) s.wins++;
    }
    if ((g + 1) % 20 === 0) {
      console.log(`  ${g + 1}/${games}: ${state.map((s) => `${s.arm.label}=${s.wins}`).join('  ')}`);
    }
  }
  return state.map((s) => {
    const ci = wilsonInterval(s.wins, games, DEFAULT_STATS_CONFIG.z);
    const sorted = [...s.times].sort((a, b) => a - b);
    return {
      label: s.arm.label,
      games,
      wins: s.wins,
      draws: s.draws,
      p: ci.p,
      low: ci.low,
      high: ci.high,
      meanMs: s.times.reduce((a, b) => a + b, 0) / s.times.length,
      p95Ms: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))],
      baselineMeanMs: s.baselineTimes.reduce((a, b) => a + b, 0) / s.baselineTimes.length,
      elo: eloFromWinRate(ci.p),
      eloPerMs: eloFromWinRate(ci.p) / (s.times.reduce((a, b) => a + b, 0) / s.times.length),
      wallSec: s.wall / 1000,
      decisions: s.times.length,
      sink: s.arm.sink,
    };
  });
}

if (mode === 'reuse') {
  // The §21–22 verdict: does keeping the tree between decisions make the pilot
  // STRONGER PER MILLISECOND? Arms are supplied as `label:decay` pairs so the
  // stale-statistics question ("age the inherited counts, or trust them?") is
  // measured on the same games rather than argued.
  const { createHybridPilot, DEFAULT_HYBRID_CONFIG, TREE_REUSE_ON, TREE_REUSE_OFF, createCollectingStatsSink } =
    await import('@jonny-boi/ai');
  const base = { ...DEFAULT_HYBRID_CONFIG, ...JSON.parse(process.env.BENCH_CONFIG ?? '{}') };
  const decays = (process.env.BENCH_DECAYS ?? '1').split(',').map(Number);
  const arms = [
    {
      label: 'reuse OFF (control)',
      sink: createCollectingStatsSink(),
      config: { ...base, reuse: TREE_REUSE_OFF },
    },
    ...decays.map((decay) => ({
      label: `reuse ON decay=${decay}`,
      sink: createCollectingStatsSink(),
      config: { ...base, reuse: { ...TREE_REUSE_ON, decay } },
    })),
  ].map((arm) => ({ ...arm, make: () => createHybridPilot(arm.config, undefined, arm.sink) }));

  console.log(`\n=== TREE REUSE (${deckA.name} vs ${deckB.name}, interleaved, paired seeds) ===`);
  console.log(`  budget: ${JSON.stringify(base.budget)}  maxDepth=${TREE_REUSE_ON.maxDepth}`);
  for (const r of await interleavedArms(arms, count, GAMES_SEED)) {
    printHeadToHead(r);
    const s = r.sink.summary();
    console.log(
      `      reuse: hitRate=${(s.reuseHitRate * 100).toFixed(1)}%  ` +
        `meanInheritedVisits=${s.meanReusedVisits.toFixed(1)}  ` +
        `maxRetainedNodes=${s.maxReusedNodes}  ` +
        `nodes/decision=${s.meanNodes.toFixed(0)}  treePlies/sim=${(s.totalTreePlies / s.totalSimulations).toFixed(2)}`,
    );
  }
  console.log('');
}

if (mode === 'tactical') {
  // BRIEF §11-12/§39: does an exact combat solver in the leaf evaluator make the
  // pilot STRONGER PER MILLISECOND? Arms are interleaved in one process on paired
  // seeds — the control arm is the SHIPPED DEFAULT (`DEFAULT_HYBRID_CONFIG`),
  // whose tactical weights are all zero and which therefore never calls the solver
  // at all, so "before" pays none of the new cost and the millisecond comparison is
  // honest as well as the win rate.
  //
  // `BENCH_TACTICAL_ARMS` selects which of the ablation arms to run. Running them
  // one term at a time is the only way to say which terms EARNED their place
  // rather than which ones happened to be built together — and here it is what
  // established that NONE of them move the aggro matchup, individually or together.
  const { createHybridPilot, DEFAULT_HYBRID_CONFIG, TACTICAL_HYBRID_CONFIG, TACTICAL_EVALUATION_WEIGHTS } =
    await import('@jonny-boi/ai');

  const base = { ...DEFAULT_HYBRID_CONFIG, ...JSON.parse(process.env.BENCH_CONFIG ?? '{}') };
  /** One arm = the shipped default with exactly the named terms switched on. */
  const withTerms = (terms, takeProvenLethal = false) => ({
    ...base,
    takeProvenLethal,
    evaluation: { ...base.evaluation, ...terms },
  });
  const ALL_ARMS = {
    control: { label: 'control (default, no solver)', config: base },
    lethal: { label: '+ solver lethal read', config: withTerms({ useTacticalLethal: true }) },
    router: { label: '+ take proven lethal', config: withTerms({ useTacticalLethal: true }, true) },
    facing: {
      label: '+ facing lethal',
      config: withTerms({ facingLethalWeight: TACTICAL_EVALUATION_WEIGHTS.facingLethalWeight }),
    },
    pressure: {
      label: '+ pressure',
      config: withTerms({ pressureWeight: TACTICAL_EVALUATION_WEIGHTS.pressureWeight }),
    },
    clock: { label: '+ clock', config: withTerms({ clockWeight: TACTICAL_EVALUATION_WEIGHTS.clockWeight }) },
    'no-router': {
      label: 'full eval, no router',
      config: { ...base, evaluation: TACTICAL_EVALUATION_WEIGHTS, takeProvenLethal: false },
    },
    full: { label: 'full tactical', config: { ...base, ...TACTICAL_HYBRID_CONFIG, budget: base.budget } },
  };
  const names = (process.env.BENCH_TACTICAL_ARMS ?? 'control,full').split(',');
  const arms = names.map((name) => {
    const arm = ALL_ARMS[name];
    if (!arm) throw new Error(`unknown arm "${name}". Known: ${Object.keys(ALL_ARMS).join(', ')}`);
    return { label: arm.label, make: () => createHybridPilot(arm.config) };
  });

  console.log(`\n=== TACTICAL EVALUATOR (${deckA.name} vs ${deckB.name}, interleaved, paired seeds) ===`);
  console.log(`  budget: ${JSON.stringify(base.budget)}  arms: ${names.join(', ')}`);
  for (const r of await interleavedArms(arms, count, GAMES_SEED)) printHeadToHead(r);
  console.log('');
}

if (mode === 'tactical-duel') {
  // The SENSITIVE form: the two evaluators playing EACH OTHER rather than each
  // playing the heuristic and being subtracted. Everything the arms share — the
  // shuffles, the matchup, the decks — then cancels PER GAME instead of only in
  // expectation, which matters because the effect being looked for is small: the
  // whole 256->1024 simulation budget step was worth +1.7 points.
  const { createHybridPilot, DEFAULT_HYBRID_CONFIG, TACTICAL_EVALUATION_WEIGHTS } = await import('@jonny-boi/ai');
  const { wilsonInterval, DEFAULT_STATS_CONFIG } = await import('@jonny-boi/sim');
  const overrides = JSON.parse(process.env.BENCH_CONFIG ?? '{}');
  // The two arms are the SAME config with only the tactical fields differing, so a
  // `BENCH_CONFIG` budget override applies to both rather than to one.
  const offConfig = { ...DEFAULT_HYBRID_CONFIG, ...overrides };
  const onConfig = { ...offConfig, evaluation: TACTICAL_EVALUATION_WEIGHTS, takeProvenLethal: true };
  const onTimes = [];
  const offTimes = [];
  let onWins = 0;
  let draws = 0;
  const t0 = performance.now();
  for (let g = 0; g < count; g++) {
    const on = timedPilot(createHybridPilot(onConfig), onTimes);
    const off = timedPilot(createHybridPilot(offConfig), offTimes);
    const onIsA = g % 2 === 0;
    const seats = makeSeats(deckA, deckB, { pilotA: onIsA ? on : off, pilotB: onIsA ? off : on }, registry);
    const r = runMatch(seats, gameSeedFor(GAMES_SEED, g), { startingPlayer: g % 4 < 2 ? 'A' : 'B' });
    if (r.outcome.kind === 'timeout') draws++;
    else if ((r.outcome.winner === 'A') === onIsA) onWins++;
    if ((g + 1) % 20 === 0) console.log(`  ${g + 1}/${count}: tactical ${onWins} wins, ${draws} draws`);
  }
  const ci = wilsonInterval(onWins, count, DEFAULT_STATS_CONFIG.z);
  const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  console.log(
    `\n=== TACTICAL vs DEFAULT (no solver), head to head (${deckA.name} vs ${deckB.name}, seat+play rotated) ===\n` +
      `  n=${count} tacticalWins=${onWins} draws=${draws} winRate=${(ci.p * 100).toFixed(1)}% ` +
      `95%CI=[${(ci.low * 100).toFixed(1)}%, ${(ci.high * 100).toFixed(1)}%]\n` +
      `  decision mean: tactical ${mean(onTimes).toFixed(2)}ms  default ${mean(offTimes).toFixed(2)}ms  ` +
      `(${((mean(onTimes) / mean(offTimes) - 1) * 100).toFixed(0)}%)  ${((performance.now() - t0) / 60000).toFixed(1)}min`,
  );
}

if (mode === 'reuse-duel') {
  // The SENSITIVE version of the §21–22 question: play reuse-ON directly against
  // reuse-OFF instead of measuring each against the heuristic and subtracting.
  //
  // Why bother: the two arms differ only in whether the tree survives a decision,
  // so almost all the variance in "hybrid vs heuristic" — the shuffles, the
  // matchup, the heuristic's own play — is COMMON to them and cancels when they
  // are subtracted through a third pilot only in expectation, not per game. Head
  // to head it cancels exactly, per game. The plateau already on record (256 →
  // 1024 simulations is worth +1.7 points) says the effect being looked for here
  // is small, and a small effect measured by subtracting two wide intervals is
  // not measured at all.
  const { createHybridPilot, DEFAULT_HYBRID_CONFIG, TREE_REUSE_ON, TREE_REUSE_OFF } = await import('@jonny-boi/ai');
  const { wilsonInterval, DEFAULT_STATS_CONFIG } = await import('@jonny-boi/sim');
  const base = { ...DEFAULT_HYBRID_CONFIG, ...JSON.parse(process.env.BENCH_CONFIG ?? '{}') };
  // The ON arm may be given a SMALLER budget than the OFF arm, which is the
  // strength-per-millisecond question stated as an experiment: if reuse lets a
  // cheaper search hold its own, the reuse is paying for itself.
  const onSims = Number(process.env.BENCH_ON_SIMS ?? base.budget.simulations);
  const onConfig = { ...base, budget: { kind: 'simulations', simulations: onSims }, reuse: TREE_REUSE_ON };
  const offConfig = { ...base, reuse: TREE_REUSE_OFF };
  const onTimes = [];
  const offTimes = [];
  let onWins = 0;
  let draws = 0;
  const t0 = performance.now();
  for (let g = 0; g < count; g++) {
    const on = timedPilot(createHybridPilot(onConfig), onTimes);
    const off = timedPilot(createHybridPilot(offConfig), offTimes);
    const onIsA = g % 2 === 0;
    const seats = makeSeats(deckA, deckB, { pilotA: onIsA ? on : off, pilotB: onIsA ? off : on }, registry);
    const r = runMatch(seats, gameSeedFor(GAMES_SEED, g), { startingPlayer: g % 4 < 2 ? 'A' : 'B' });
    if (r.outcome.kind === 'timeout') draws++;
    else if ((r.outcome.winner === 'A') === onIsA) onWins++;
    if ((g + 1) % 20 === 0) console.log(`  ${g + 1}/${count}: reuse-ON ${onWins} wins, ${draws} draws`);
  }
  const ci = wilsonInterval(onWins, count, DEFAULT_STATS_CONFIG.z);
  const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  console.log(
    `\n=== REUSE ON (${onSims} sims) vs REUSE OFF (${base.budget.simulations} sims), ` +
      `${deckA.name} vs ${deckB.name}, seat+play rotated ===\n` +
      `  n=${count} onWins=${onWins} draws=${draws} winRate=${(ci.p * 100).toFixed(1)}% ` +
      `95%CI=[${(ci.low * 100).toFixed(1)}%, ${(ci.high * 100).toFixed(1)}%]\n` +
      `  decision mean: ON ${mean(onTimes).toFixed(2)}ms  OFF ${mean(offTimes).toFixed(2)}ms  ` +
      `(${((mean(onTimes) / mean(offTimes) - 1) * 100).toFixed(0)}%)  ${((performance.now() - t0) / 60000).toFixed(1)}min`,
  );
}

if (mode === 'scaling') {
  // The user's stated success metric: does MORE SEARCH TIME make it measurably
  // STRONGER? A hybrid that does not scale is not a search, it is a constant.
  const { createHybridPilot, DEFAULT_HYBRID_CONFIG } = await import('@jonny-boi/ai');
  const budgets = (process.env.BENCH_BUDGETS ?? '16,64,256,1024').split(',').map(Number);
  console.log(`\n=== SCALING: hybrid vs heuristic at increasing search budgets (n=${count} each) ===`);
  for (const simulations of budgets) {
    const config = { ...DEFAULT_HYBRID_CONFIG, budget: { kind: 'simulations', simulations } };
    printHeadToHead(await headToHead(() => createHybridPilot(config), `sims=${simulations}`, count, GAMES_SEED));
  }
  console.log('');
}

if (mode === 'modes') {
  // Every selectable mode against the same baseline, on the same seeds, so the
  // comparison the brief asks for (§59) is one command.
  const { createHybridPilot, createMctsPilot: mkMcts, DEFAULT_MCTS_CONFIG: MC, createRandomPilot } =
    await import('@jonny-boi/ai');
  console.log(`\n=== MODES vs HEURISTIC (n=${count} each, identical seeds) ===`);
  printHeadToHead(await headToHead(() => createRandomPilot(), 'RANDOM', count, GAMES_SEED));
  printHeadToHead(await headToHead(() => mkMcts(MC), 'VANILLA_MCTS', count, GAMES_SEED));
  printHeadToHead(await headToHead(() => createHybridPilot(), 'HYBRID', count, GAMES_SEED));
  console.log('');
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
