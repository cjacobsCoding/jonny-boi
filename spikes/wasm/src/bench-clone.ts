/**
 * The clone benchmark — the one that prices the prize the profile actually points
 * at.
 *
 * `applyAction` clones the whole state once per action. That clone is 27.2% of the
 * heuristic sim's self time, and the garbage it makes is another 5.7% there and
 * 69.5% under the MCTS pilot. This measures the SAME clone under two layouts:
 *
 *   A. `cloneState` from packages/core — the shipped object-graph deep copy
 *   B. `cloneFlatState` — the identical information as typed-array columns
 *
 * States are captured from real games at several points in the arc (opening hand
 * through a developed board), because the cost is proportional to how many card
 * instances exist and the libraries dominate throughout.
 *
 * The round-trip check runs FIRST and gates the numbers: the flat mirror must
 * rebuild a `GameState` equal to the original under the engine's own serializer,
 * or arm B is just cloning less data.
 */

import { performance, PerformanceObserver } from 'node:perf_hooks';
import { loadCardPool, buildRegistry } from '@jonny-boi/cards';
import { createDefaultAiRegistry } from '@jonny-boi/ai';
import { SAMPLE_DECKS, loadDeck, gameSeedFor } from '@jonny-boi/sim';
import type { GameState } from '@jonny-boi/core';
import type { CardInstance, PlayerId } from '@jonny-boi/core';
import {
  applyAction,
  cloneState,
  createGame,
  createRng,
  DEFAULT_RULES,
  generateLegalActions,
  MANA_COLORS,
  PLAYER_IDS,
} from '@jonny-boi/core';
import { cloneFlatState, fromFlatState, toFlatState, type FlatState } from './flat-state.js';
import {
  arenaBytes,
  cloneArenaState,
  fromArenaState,
  toArenaState,
  type ArenaState,
} from './flat-arena-state.js';

/**
 * A canonical string covering EXACTLY what the flat mirror claims to preserve —
 * every zone's instance sequence IN ORDER (library order is the shuffle; a mirror
 * that lost it would be cloning a different game), every mutable per-instance
 * field including counters, both mana pools, and the scalars.
 *
 * The engine's own `serializeState` is deliberately not used: it is an inspector
 * summary (zone SIZES, not contents), so it would pass a mirror that shuffled the
 * libraries.
 */
function canonical(state: GameState): string {
  const inst = (c: CardInstance): string =>
    [
      c.instanceId,
      c.def.id ?? c.def.name,
      c.controller,
      c.owner,
      c.zone,
      c.tapped ? 1 : 0,
      c.summoningSick ? 1 : 0,
      c.damageMarked,
      c.markedByDeathtouch ? 1 : 0,
      Object.keys(c.counters)
        .sort()
        .map((k) => `${k}=${c.counters[k]}`)
        .join('|'),
    ].join(':');
  const parts: string[] = [];
  for (const p of PLAYER_IDS as readonly PlayerId[]) {
    const pl = state.players[p];
    parts.push(
      `${p} life=${pl.life} lands=${pl.landsPlayedThisTurn} lost=${pl.hasLost ? 1 : 0} ` +
        `pool=${MANA_COLORS.map((c) => pl.manaPool[c]).join(',')}`,
    );
    for (const [zone, list] of [
      ['library', pl.library],
      ['hand', pl.hand],
      ['graveyard', pl.graveyard],
      ['exile', pl.exile],
      ['command', pl.command],
    ] as const) {
      parts.push(`${p}.${zone}=[${list.map(inst).join(' ')}]`);
    }
  }
  parts.push(`battlefield=[${state.battlefield.map(inst).join(' ')}]`);
  parts.push(
    `turn=${state.turnNumber} active=${state.activePlayer} priority=${state.priorityPlayer} ` +
      `next=${state.nextInstanceId} rng=${state.rngState} passes=${state.consecutivePasses} ` +
      `over=${state.gameOver ? 1 : 0} winner=${state.winner ?? '-'}`,
  );
  return parts.join('\n');
}

const WARMUP = 2;
const REPETITIONS = 11;
/** Clones per timed pass — enough that one pass is milliseconds, not microseconds. */
const CLONES_PER_PASS = 20_000;

/** Capture states from a real game at a spread of action counts. */
function captureStates(sampleEvery: number, limit: number): GameState[] {
  const pool = loadCardPool();
  const registry = buildRegistry(pool);
  const pilot = createDefaultAiRegistry().getPilot('heuristic');
  if (!pilot) throw new Error('heuristic pilot missing');
  const decks = SAMPLE_DECKS.map((d) => loadDeck(d, pool));
  const out: GameState[] = [];

  for (let g = 0; out.length < limit && g < 8; g++) {
    const seed = gameSeedFor(0xc0ffee, g);
    const rng = createRng(seed);
    let state = createGame({
      seed,
      startingPlayer: 'A',
      config: DEFAULT_RULES,
      registry,
      decks: {
        A: { cards: (decks[g % decks.length] as (typeof decks)[number]).library },
        B: { cards: (decks[(g + 3) % decks.length] as (typeof decks)[number]).library },
      },
    }).state;
    let actions = 0;
    while (!state.gameOver && state.turnNumber <= 20 && actions < 1500 && out.length < limit) {
      if (actions % sampleEvery === 0) out.push(state);
      const legal = generateLegalActions(state, DEFAULT_RULES);
      if (legal.length === 0) break;
      const chosen = pilot.chooseAction({
        view: state,
        legalActions: legal,
        rng,
        registry,
        rulesConfig: DEFAULT_RULES,
      });
      state = applyAction(state, chosen, DEFAULT_RULES, registry).state;
      actions++;
    }
  }
  return out;
}

let gcMillis = 0;
const gcObserver = new PerformanceObserver((list) => {
  for (const e of list.getEntries()) gcMillis += e.duration;
});
gcObserver.observe({ entryTypes: ['gc'] });
const drain = (): Promise<void> => new Promise((r) => setImmediate(r));

interface Arm {
  readonly name: string;
  readonly medianMs: number;
  readonly nsPerClone: number;
  readonly gcMs: number;
}

async function timeArm(name: string, run: () => void): Promise<Arm> {
  for (let i = 0; i < WARMUP; i++) run();
  await drain();
  gcMillis = 0;
  const samples: number[] = [];
  for (let i = 0; i < REPETITIONS; i++) {
    const t0 = performance.now();
    run();
    samples.push(performance.now() - t0);
  }
  await drain();
  const gcMs = gcMillis / REPETITIONS;
  samples.sort((a, b) => a - b);
  const medianMs = samples[(samples.length / 2) | 0] as number;
  return { name, medianMs, nsPerClone: (medianMs * 1e6) / CLONES_PER_PASS, gcMs };
}

async function main(): Promise<void> {
  const states = captureStates(37, 24);

  // --- the gate: the flat mirror must be lossless ---------------------------------
  let roundTripFailures = 0;
  let arenaFailures = 0;
  let firstDiff = '';
  for (const state of states) {
    if (canonical(fromArenaState(toArenaState(state), state)) !== canonical(state)) arenaFailures++;
    const rebuilt = fromFlatState(toFlatState(state), state);
    const a = canonical(state);
    const b = canonical(rebuilt);
    if (a !== b) {
      roundTripFailures++;
      if (firstDiff === '') {
        const al = a.split('\n');
        const bl = b.split('\n');
        for (let i = 0; i < Math.max(al.length, bl.length); i++) {
          if (al[i] !== bl[i]) {
            firstDiff = `\n  line ${i}\n  orig: ${(al[i] ?? '').slice(0, 200)}\n  flat: ${(bl[i] ?? '').slice(0, 200)}\n`;
            break;
          }
        }
      }
    }
  }
  if (firstDiff !== '') process.stdout.write(firstDiff);
  process.stdout.write(
    `states captured: ${states.length}   round-trip failures: columns ${roundTripFailures}, arena ${arenaFailures}` +
      (roundTripFailures === 0 && arenaFailures === 0
        ? '  → both flat mirrors are lossless\n\n'
        : '  → A MIRROR IS LOSSY, numbers below are meaningless\n\n'),
  );
  if (roundTripFailures !== 0 || arenaFailures !== 0) {
    process.exitCode = 1;
    return;
  }

  const instanceCounts = states.map((s) => toFlatState(s).count);
  const meanInstances = instanceCounts.reduce((a, b) => a + b, 0) / instanceCounts.length;

  const flats: FlatState[] = states.map(toFlatState);
  const arenas: ArenaState[] = states.map(toArenaState);
  const meanArenaBytes = arenas.reduce((n, a) => n + arenaBytes(a), 0) / arenas.length;
  // Sinks: keep a reference to the newest clone so nothing is optimised away.
  let objectSink: GameState | null = null;
  let flatSink: FlatState | null = null;
  let arenaSink: ArenaState | null = null;
  // One reusable destination big enough for the largest captured state.
  const pooled = new Int32Array(arenas.reduce((m, a) => Math.max(m, a.layout.used), 0));

  const arms: Arm[] = [
    await timeArm('A. cloneState  (shipped object graph)', () => {
      for (let i = 0; i < CLONES_PER_PASS; i++) {
        objectSink = cloneState(states[i % states.length] as GameState);
      }
    }),
    await timeArm('B. flat, 23 separate typed arrays', () => {
      for (let i = 0; i < CLONES_PER_PASS; i++) {
        flatSink = cloneFlatState(flats[i % flats.length] as FlatState);
      }
    }),
    await timeArm('C. flat, ONE arena (1 alloc + 1 memcpy)', () => {
      for (let i = 0; i < CLONES_PER_PASS; i++) {
        arenaSink = cloneArenaState(arenas[i % arenas.length] as ArenaState);
      }
    }),
    // D is how a flat engine would ACTUALLY be driven on the hot path: a search
    // (or the action loop) keeps a pool of state buffers and copies into one it
    // already owns, so the steady state allocates nothing at all and the GC has
    // no work to do. This is the arm that speaks to the MCTS profile's 69.5% GC.
    await timeArm('D. flat arena → pooled buffer (0 alloc, memcpy only)', () => {
      for (let i = 0; i < CLONES_PER_PASS; i++) {
        const src = arenas[i % arenas.length] as ArenaState;
        pooled.set(src.buf.subarray(0, src.layout.used));
      }
    }),
  ];

  const baseline = arms[0] as Arm;
  const rows = arms.map(
    (a) =>
      `  ${a.name.padEnd(44)}${a.medianMs.toFixed(2).padStart(9)} ms` +
      `${a.nsPerClone.toFixed(0).padStart(9)} ns/clone` +
      `${(baseline.medianMs / a.medianMs).toFixed(2).padStart(8)}×` +
      `   gc ${a.gcMs.toFixed(1).padStart(7)} ms`,
  );

  process.stdout.write(
    [
      `clones per pass: ${CLONES_PER_PASS}   states: ${states.length}   mean card instances/state: ${meanInstances.toFixed(1)}`,
      '',
      ...rows,
      '',
      `mean arena size: ${(meanArenaBytes / 1024).toFixed(1)} KiB per state clone`,
      `(sinks retained: ${objectSink === null ? 'none' : 'object'}/${flatSink === null ? 'none' : 'flat'}/${arenaSink === null ? 'none' : 'arena'})`,
      '',
    ].join('\n'),
  );
}

await main();
