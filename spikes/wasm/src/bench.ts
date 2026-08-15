/**
 * The benchmark. Six arms over the same 50,675 recorded cases, timed identically.
 *
 * The arms exist to separate three effects that a naive "JS vs WASM" number fuses
 * together — the language, the data layout, and the boundary:
 *
 *   1. shipped (objects)          the baseline: packages/core's planner, as it runs today
 *   2. js-flat  end-to-end        flat layout, encoding from the engine's objects each call
 *   3. js-flat  kernel-only       flat layout, data already encoded
 *   4. wasm     end-to-end        encode from objects + cross the boundary each call
 *   5. wasm     per-call crossing data already encoded, still one crossing per case
 *   6. wasm     batch (ceiling)   every case resident in linear memory, ONE crossing
 *
 * Arm 6 is unshippable — it would require the engine's state to live in WASM
 * memory — and is measured precisely because it is the ceiling. If WASM cannot
 * win there, it cannot win anywhere in this kernel.
 *
 * ## Honesty measures
 * - Every arm consumes its result into a checksum, so nothing is optimised away.
 *   The checksums are printed and MUST match across arms.
 * - Warmup passes run before timing so no arm is charged for JIT tiering-up.
 * - Each arm runs `REPETITIONS` times; the MEDIAN is reported (the min flatters
 *   whichever arm happens to dodge a GC pause, the mean is dragged by scheduler
 *   noise on a laptop).
 * - GC time during each arm is reported separately, because for this codebase the
 *   allocation story is the actual story.
 */

import { performance, PerformanceObserver } from 'node:perf_hooks';
import type { PaymentCase } from './corpus.js';
import { COLOR_COUNT, encodeCost, encodeHybrid, type FlatCase, type PlanResult } from './kernel.js';
import { planFlat as planJsFlat } from './kernel-js-flat.js';
import { loadWasmKernel, type WasmPaymentKernel } from './kernel-wasm.js';
import { planShipped, toObjectCase, type ObjectCase } from './kernel-js-shipped.js';
import { loadCorpus, toFlatCase } from './corpus-io.js';
import { manaModesOf, MANA_COLORS } from '@jonny-boi/core';
import type { CardInstance, GameAction } from '@jonny-boi/core';

const WARMUP_PASSES = 2;
const REPETITIONS = 7;

/** Fold a plan into a running checksum, so no arm can be optimised away. */
function fold(sum: number, plan: PlanResult): number {
  if (plan === null) return (sum * 31 + 7) | 0;
  let s = (sum * 31 + 3) | 0;
  for (const tap of plan) s = (((s * 31 + tap.sourceIndex) | 0) * 31 + tap.modeIndex) | 0;
  return s;
}

/** Same fold, for the arms that read raw ints out of the arena. */
function foldRaw(sum: number, taps: number, arena: Int32Array, at: number): number {
  if (taps < 0) return (sum * 31 + 7) | 0;
  let s = (sum * 31 + 3) | 0;
  for (let i = 0; i < taps; i++) {
    s = (((s * 31 + (arena[at + i * 2] as number)) | 0) * 31 + (arena[at + i * 2 + 1] as number)) | 0;
  }
  return s;
}

// --- marshalling from the engine's own object shapes ------------------------------

/**
 * Encode a payment question straight from the object graph the engine holds —
 * the `tapForMana` actions plus the battlefield — into the flat arrays.
 *
 * This is the real marshalling cost, and it is deliberately the same walk the
 * shipped planner does (find the permanent for each action, read its modes). Any
 * flat-layout arm has to pay it as long as the engine's state stays object-shaped,
 * which is exactly the trap this spike exists to price.
 */
function encodeFromObjects(oc: ObjectCase, out: MarshalBuffers): FlatCase {
  const pool = oc.view.players.A.manaPool;
  for (let c = 0; c < COLOR_COUNT; c++) out.pool[c] = pool[MANA_COLORS[c] as string] ?? 0;
  encodeCost(oc.cost, out.cost);

  let w = 1;
  let sourceCount = 0;
  let lastId = -1;
  let modeCountAt = -1;
  for (const action of oc.actions as readonly GameAction[]) {
    if (action.kind !== 'tapForMana') continue;
    const perm = oc.view.battlefield.find((c: CardInstance) => c.instanceId === action.instanceId);
    if (!perm) continue;
    const production = manaModesOf(perm.def)[action.mode ?? 0];
    if (!production) continue;
    if (action.instanceId !== lastId) {
      lastId = action.instanceId;
      sourceCount++;
      modeCountAt = w++;
      out.sources[modeCountAt] = 0;
    }
    out.sources[modeCountAt] = (out.sources[modeCountAt] as number) + 1;
    for (let c = 0; c < COLOR_COUNT; c++) {
      out.sources[w++] = production[MANA_COLORS[c] as never] ?? 0;
    }
  }
  out.sources[0] = sourceCount;
  return {
    pool: out.pool,
    cost: out.cost,
    // Hybrids are 2% of cases and their encoding is cost-shaped, not board-shaped;
    // it is cached per case rather than rebuilt, exactly as a real port would.
    hybrid: out.hybrid,
    sources: out.sources.subarray(0, w),
  };
}

interface MarshalBuffers {
  readonly pool: Int32Array;
  readonly cost: Int32Array;
  hybrid: Int32Array;
  readonly sources: Int32Array;
}

function makeBuffers(): MarshalBuffers {
  return {
    pool: new Int32Array(COLOR_COUNT),
    cost: new Int32Array(7),
    hybrid: new Int32Array(1),
    sources: new Int32Array(1 + 256 * (1 + 8 * COLOR_COUNT)),
  };
}

// --- timing ----------------------------------------------------------------------

interface ArmResult {
  readonly name: string;
  readonly medianMs: number;
  readonly minMs: number;
  readonly maxMs: number;
  readonly nsPerCase: number;
  readonly gcMs: number;
  readonly gcCount: number;
  readonly checksum: number;
}

let gcMillis = 0;
let gcCount = 0;
const gcObserver = new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) {
    gcMillis += entry.duration;
    gcCount += 1;
  }
});
gcObserver.observe({ entryTypes: ['gc'] });

/**
 * Let the event loop turn so the GC observer's queued callbacks actually run.
 * Without this every arm reports 0 ms of GC — the timing loop is synchronous, so
 * the callbacks would not fire until after all measurement was finished, and the
 * allocation story (which for this codebase is THE story) would be invisible.
 */
const drain = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

async function timeArm(name: string, cases: number, run: () => number): Promise<ArmResult> {
  for (let i = 0; i < WARMUP_PASSES; i++) run();
  await drain();
  const samples: number[] = [];
  let checksum = 0;
  gcMillis = 0;
  gcCount = 0;
  for (let i = 0; i < REPETITIONS; i++) {
    const t0 = performance.now();
    checksum = run();
    samples.push(performance.now() - t0);
  }
  await drain();
  const gcMs = gcMillis / REPETITIONS;
  const perArmGcCount = gcCount / REPETITIONS;
  samples.sort((a, b) => a - b);
  const medianMs = samples[(samples.length / 2) | 0] as number;
  return {
    name,
    medianMs,
    minMs: samples[0] as number,
    maxMs: samples[samples.length - 1] as number,
    nsPerCase: (medianMs * 1e6) / cases,
    gcMs,
    gcCount: perArmGcCount,
    checksum,
  };
}

// --- main ------------------------------------------------------------------------

async function main(): Promise<void> {
  const corpus: PaymentCase[] = loadCorpus();
  const n = corpus.length;
  const objectCases: ObjectCase[] = corpus.map(toObjectCase);
  const flatCases: FlatCase[] = corpus.map(toFlatCase);
  const wasm: WasmPaymentKernel = loadWasmKernel();
  const buffers = makeBuffers();
  const hybrids = corpus.map((c) => encodeHybrid(c.cost));

  // Arena layout. The single-case arms reuse a fixed scratch region at the front;
  // the batch arm's index and preloaded cases start beyond it. They MUST NOT
  // overlap — the first version of this benchmark let a 14-source case written at
  // word 0 run over the batch index, which silently shortened the batch and
  // reported a fictional 1069× before the checksum caught it.
  const SINGLE_CASE_OFFSET = 0;
  const SINGLE_OUT_OFFSET = 4096;
  const SCRATCH_WORDS = 8192;

  const INDEX_OFFSET = SCRATCH_WORDS;
  let cursor = INDEX_OFFSET + 1 + n;
  const caseOffsets: number[] = [];
  for (let i = 0; i < n; i++) {
    caseOffsets.push(cursor);
    cursor = wasm.writeCase(flatCases[i] as FlatCase, cursor);
  }
  wasm.arena[INDEX_OFFSET] = n;
  for (let i = 0; i < n; i++) wasm.arena[INDEX_OFFSET + 1 + i] = caseOffsets[i] as number;
  const BATCH_OUT_OFFSET = cursor + 16;
  if (BATCH_OUT_OFFSET + n * 8 > wasm.arena.length) throw new Error('arena too small for the corpus');

  const arms: ArmResult[] = [
    await timeArm('1. shipped JS (objects, as it runs today)', n, () => {
      let sum = 0;
      for (let i = 0; i < n; i++) sum = fold(sum, planShipped(objectCases[i] as ObjectCase));
      return sum;
    }),

    await timeArm('2. js-flat, end-to-end (marshal from objects each call)', n, () => {
      let sum = 0;
      for (let i = 0; i < n; i++) {
        buffers.hybrid = hybrids[i] as Int32Array;
        sum = fold(sum, planJsFlat(encodeFromObjects(objectCases[i] as ObjectCase, buffers)));
      }
      return sum;
    }),

    await timeArm('3. js-flat, kernel only (data already flat)', n, () => {
      let sum = 0;
      for (let i = 0; i < n; i++) sum = fold(sum, planJsFlat(flatCases[i] as FlatCase));
      return sum;
    }),

    await timeArm('4. wasm, end-to-end (marshal from objects + cross each call)', n, () => {
      let sum = 0;
      for (let i = 0; i < n; i++) {
        buffers.hybrid = hybrids[i] as Int32Array;
        const flat = encodeFromObjects(objectCases[i] as ObjectCase, buffers);
        wasm.writeCase(flat, SINGLE_CASE_OFFSET);
        const taps = wasm.planAt(SINGLE_CASE_OFFSET, SINGLE_OUT_OFFSET);
        sum = foldRaw(sum, taps, wasm.arena, SINGLE_OUT_OFFSET);
      }
      return sum;
    }),

    await timeArm('5. wasm, per-call crossing (data already flat)', n, () => {
      let sum = 0;
      for (let i = 0; i < n; i++) {
        wasm.writeCase(flatCases[i] as FlatCase, SINGLE_CASE_OFFSET);
        const taps = wasm.planAt(SINGLE_CASE_OFFSET, SINGLE_OUT_OFFSET);
        sum = foldRaw(sum, taps, wasm.arena, SINGLE_OUT_OFFSET);
      }
      return sum;
    }),

    await timeArm('6. wasm, batch ceiling (all resident, ONE crossing)', n, () => {
      wasm.planBatch(INDEX_OFFSET, BATCH_OUT_OFFSET);
      let sum = 0;
      let r = BATCH_OUT_OFFSET;
      for (let i = 0; i < n; i++) {
        const taps = wasm.arena[r] as number;
        sum = foldRaw(sum, taps, wasm.arena, r + 1);
        r += 1 + (taps > 0 ? taps * 2 : 0);
      }
      return sum;
    }),
  ];

  const baseline = arms[0] as ArmResult;
  const rows = arms.map((a) => {
    const speedup = baseline.medianMs / a.medianMs;
    return [
      `  ${a.name.padEnd(58)}`,
      `${a.medianMs.toFixed(2).padStart(9)} ms`,
      ` [${a.minMs.toFixed(1)}–${a.maxMs.toFixed(1)}]`.padEnd(18),
      `${a.nsPerCase.toFixed(1).padStart(8)} ns/case`,
      `${speedup.toFixed(2).padStart(6)}×`,
      `  gc ${a.gcMs.toFixed(1).padStart(6)} ms /${a.gcCount.toFixed(1).padStart(6)} cycles`,
      a.checksum === baseline.checksum ? '  ✓' : `  ✗ CHECKSUM ${a.checksum}`,
    ].join('');
  });

  process.stdout.write(
    [
      `cases: ${n}   repetitions: ${REPETITIONS} (median reported)   node ${process.version}`,
      '',
      ...rows,
      '',
      arms.every((a) => a.checksum === baseline.checksum)
        ? 'All arms produced identical plans (checksums match).'
        : 'CHECKSUM MISMATCH — the arms are not computing the same thing.',
      '',
    ].join('\n'),
  );
  if (!arms.every((a) => a.checksum === baseline.checksum)) process.exitCode = 1;
}

await main();
