/**
 * Host side of the WASM arm: load the module, view its arena as an `Int32Array`,
 * and expose the same kernel contract the JS arms expose.
 *
 * Two call shapes are provided on purpose, because they answer different questions:
 *
 *   - `planFlat(case)` — write one case into the arena, cross the boundary once,
 *     read the plan back. This is what an incremental adoption would actually look
 *     like: the engine keeps its object state and calls out per payment question.
 *     The per-call marshalling IS the cost being measured, not overhead to excuse.
 *
 *   - `planBatchPreloaded(...)` — every case already resident in linear memory, one
 *     crossing for thousands of plans. Nobody could ship this (the engine's state
 *     would have to live in WASM memory to feed it), but it establishes the CEILING:
 *     if WASM does not win here, it cannot win anywhere in this kernel.
 *
 * The module is instantiated synchronously from the compiled bytes so nothing in
 * the benchmark is async — an await inside a timing loop would measure the event
 * loop, not the kernel.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { COLOR_COUNT, type ChosenTap, type FlatCase, type PaymentKernel, type PlanResult } from './kernel.js';

interface PaymentExports {
  readonly memory: WebAssembly.Memory;
  readonly arenaPtr: () => number;
  readonly arenaInts: () => number;
  readonly planAt: (caseOffset: number, outOffset: number) => number;
  readonly planBatch: (indexOffset: number, outOffset: number) => number;
}

export interface WasmPaymentKernel extends PaymentKernel {
  /** i32 view over the module's arena — the only channel across the boundary. */
  readonly arena: Int32Array;
  /** Write a case at `offset`; returns the next free word. */
  writeCase(flat: FlatCase, offset: number): number;
  readonly planAt: (caseOffset: number, outOffset: number) => number;
  readonly planBatch: (indexOffset: number, outOffset: number) => number;
}

const WASM_PATH = fileURLToPath(new URL('../build/payment.wasm', import.meta.url));

export function loadWasmKernel(): WasmPaymentKernel {
  const bytes = readFileSync(WASM_PATH);
  const module = new WebAssembly.Module(bytes);
  const instance = new WebAssembly.Instance(module, {
    // `runtime: minimal` still emits an abort import; a throwing stub is correct —
    // the kernel must never abort, and a silent no-op would hide it if it did.
    env: {
      abort(): void {
        throw new Error('wasm payment kernel aborted');
      },
    },
  });
  const exports = instance.exports as unknown as PaymentExports;
  const base = exports.arenaPtr();
  const arena = new Int32Array(exports.memory.buffer, base, exports.arenaInts());

  /** Layout: pool(6) cost(7) hybridWordCount(1) hybrid(h) sources(s). */
  function writeCase(flat: FlatCase, offset: number): number {
    let w = offset;
    for (let c = 0; c < COLOR_COUNT; c++) arena[w++] = flat.pool[c] as number;
    for (let i = 0; i < 7; i++) arena[w++] = flat.cost[i] as number;
    arena[w++] = flat.hybrid.length;
    arena.set(flat.hybrid, w);
    w += flat.hybrid.length;
    arena.set(flat.sources, w);
    w += flat.sources.length;
    return w;
  }

  /** Scratch region for the single-case path: cases are small and short-lived. */
  const SINGLE_CASE_OFFSET = 0;
  const SINGLE_OUT_OFFSET = 4096;

  function planFlat(flat: FlatCase): PlanResult {
    writeCase(flat, SINGLE_CASE_OFFSET);
    const taps = exports.planAt(SINGLE_CASE_OFFSET, SINGLE_OUT_OFFSET);
    if (taps < 0) return null;
    if (taps === 0) return EMPTY_PLAN;
    const out: ChosenTap[] = [];
    for (let i = 0; i < taps; i++) {
      out.push({
        sourceIndex: arena[SINGLE_OUT_OFFSET + i * 2] as number,
        modeIndex: arena[SINGLE_OUT_OFFSET + i * 2 + 1] as number,
      });
    }
    return out;
  }

  return {
    name: 'wasm',
    planFlat,
    arena,
    writeCase,
    planAt: exports.planAt,
    planBatch: exports.planBatch,
  };
}

const EMPTY_PLAN: readonly ChosenTap[] = Object.freeze([]);
