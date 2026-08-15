/**
 * ARM C host — instantiates the WASM module and presents the same surface the JS
 * arms do, so the benchmark harness can treat all three identically.
 *
 * Two deliberate choices about the BOUNDARY, because it is the thing a WASM
 * recommendation lives or dies on:
 *
 *  1. Workloads run ENTIRELY inside the module and return a scalar. A run of 150
 *     games crosses the boundary once, not 54,000 times. That is the most flattering
 *     honest arrangement for WASM, and it is also the one a real integration would
 *     aim for — so if WASM cannot win here, it cannot win at all.
 *  2. The boundary is then priced SEPARATELY (`benchBoundary`, `benchStateCopy`),
 *     because the real product cannot always keep the state inside the module: the
 *     Lab's match viewer, the replay log, the event stream and the online server all
 *     read game state from JavaScript.
 */

import { readFileSync } from 'node:fs';

const wasmPath = new URL('../build/engine.wasm', import.meta.url);

const module = new WebAssembly.Module(readFileSync(wasmPath));
const instance = new WebAssembly.Instance(module, {
  env: {
    abort(_msg, _file, line, column) {
      throw new Error(`wasm abort at ${line}:${column}`);
    },
  },
});

const x = instance.exports;

export const wasmByteLength = readFileSync(wasmPath).byteLength;
export const memory = x.memory;

export function playGame(seed) {
  const digest = x.playGame(seed);
  return {
    digest,
    actions: x.getActions(),
    generated: x.getGenerated(),
    turns: x.getTurns(),
    winner: x.getWinner(),
  };
}

/** One boundary crossing for a whole batch — the shape a real integration wants. */
export function playGames(firstSeed, count) {
  const digest = x.playGames(firstSeed, count);
  return { digest, actions: x.getActions() };
}

export function searchWorkload(seed, rollouts, depth) {
  const checksum = x.searchWorkload(seed, rollouts, depth);
  return { checksum, transitions: x.getTransitions() };
}

export function setJournalEnabled(on) {
  x.setJournalEnabled(on ? 1 : 0);
}

export const benchGenerate = (seed, iters) => x.benchGenerate(seed, iters);
export const benchEvaluate = (seed, iters) => x.benchEvaluate(seed, iters);
export const benchTransition = (seed, iters) => x.benchTransition(seed, iters);
export const benchDecide = (seed, iters) => x.benchDecide(seed, iters);
export const arenaSize = () => x.arenaSize();
export const arenaPtr = () => x.arenaPtr();
export const noop = (v) => x.noop(v);

/**
 * Price of ONE trivial JS→WASM call. Measured against an identical JS function so
 * the loop, the call site and the timer are subtracted out — what is left is the
 * crossing itself.
 */
export function benchBoundary(iters) {
  let sink = 0;
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < iters; i++) sink += x.noop(i);
  const wasmNs = Number(process.hrtime.bigint() - t0);
  const jsNoop = (v) => v;
  const t1 = process.hrtime.bigint();
  for (let i = 0; i < iters; i++) sink += jsNoop(i);
  const jsNs = Number(process.hrtime.bigint() - t1);
  if (sink === -1) throw new Error('unreachable');
  return { wasmNsPerCall: wasmNs / iters, jsNsPerCall: jsNs / iters };
}

/**
 * Price of copying the whole game state OUT of linear memory into a JS-side view —
 * what any consumer that must read the state from JavaScript pays per read.
 */
export function benchStateCopy(iters) {
  const size = x.arenaSize();
  const ptr = x.arenaPtr();
  const dst = new Int32Array(size);
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < iters; i++) {
    dst.set(new Int32Array(x.memory.buffer, ptr, size));
  }
  const ns = Number(process.hrtime.bigint() - t0);
  return { nsPerCopy: ns / iters, bytes: size * 4, checksum: dst[0] };
}
