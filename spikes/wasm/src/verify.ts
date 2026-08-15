/**
 * The gate: all three arms must produce BIT-IDENTICAL plans on every recorded
 * case, or no benchmark number below means anything.
 *
 * This is not a formality for this product. The lab's whole claim is that swapping
 * one card and replaying the same seeds yields a comparable result; a planner that
 * taps a different land in a tie produces a different board, a different game and
 * a different verdict. "Equally correct" is not correct here — only "identical" is.
 *
 * Comparison is on the full ordered plan (source index and mode index per tap),
 * plus the three-way distinction between `null` (unpayable), `[]` (already paid)
 * and a non-empty plan, which the real caller acts on differently.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { PaymentCase } from './corpus.js';
import { encodeCost, encodeHybrid, encodeSources, type FlatCase, type PlanResult } from './kernel.js';
import { planFlat as planJsFlat } from './kernel-js-flat.js';
import { loadWasmKernel } from './kernel-wasm.js';
import { planShipped, toObjectCase } from './kernel-js-shipped.js';

export function toFlatCase(c: PaymentCase): FlatCase {
  const pool = Int32Array.from(c.pool);
  const cost = new Int32Array(7);
  encodeCost(c.cost, cost);
  return { pool, cost, hybrid: encodeHybrid(c.cost), sources: encodeSources(c.sources) };
}

export function describePlan(p: PlanResult): string {
  if (p === null) return 'UNPAYABLE';
  if (p.length === 0) return 'ALREADY-PAID';
  return p.map((t) => `${t.sourceIndex}/${t.modeIndex}`).join(',');
}

export function loadCorpus(): PaymentCase[] {
  const path = fileURLToPath(new URL('../results/corpus.json', import.meta.url));
  return JSON.parse(readFileSync(path, 'utf8')) as PaymentCase[];
}

function main(): void {
  const corpus = loadCorpus();
  const wasm = loadWasmKernel();

  let mismatchFlat = 0;
  let mismatchWasm = 0;
  const examples: string[] = [];
  const outcomes = { unpayable: 0, alreadyPaid: 0, planned: 0 };

  for (let i = 0; i < corpus.length; i++) {
    const c = corpus[i] as PaymentCase;
    const flat = toFlatCase(c);
    const shipped = describePlan(planShipped(toObjectCase(c)));
    const jsFlat = describePlan(planJsFlat(flat));
    const asWasm = describePlan(wasm.planFlat(flat));

    if (shipped === 'UNPAYABLE') outcomes.unpayable++;
    else if (shipped === 'ALREADY-PAID') outcomes.alreadyPaid++;
    else outcomes.planned++;

    if (jsFlat !== shipped) {
      mismatchFlat++;
      if (examples.length < 5) examples.push(`case ${i}: shipped=${shipped} js-flat=${jsFlat}`);
    }
    if (asWasm !== shipped) {
      mismatchWasm++;
      if (examples.length < 5) examples.push(`case ${i}: shipped=${shipped} wasm=${asWasm}`);
    }
  }

  process.stdout.write(
    [
      `cases verified:        ${corpus.length}`,
      `  unpayable:           ${outcomes.unpayable}`,
      `  already paid:        ${outcomes.alreadyPaid}`,
      `  planned (≥1 tap):    ${outcomes.planned}`,
      `js-flat mismatches:    ${mismatchFlat}`,
      `wasm    mismatches:    ${mismatchWasm}`,
      ...examples.map((e) => `  ${e}`),
      mismatchFlat === 0 && mismatchWasm === 0
        ? 'RESULT: BIT-IDENTICAL across all three arms.'
        : 'RESULT: MISMATCH — benchmark numbers are meaningless until this is zero.',
      '',
    ].join('\n'),
  );
  if (mismatchFlat !== 0 || mismatchWasm !== 0) process.exitCode = 1;
}

main();
