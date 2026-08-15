/**
 * Loading the recorded corpus and encoding one case into the flat form — shared
 * by the verifier and the benchmark so both measure exactly the same encoding.
 *
 * Split out of `verify.ts` deliberately: that file runs its check on import, and
 * a benchmark that re-ran the verification just by importing a helper would have
 * charged the first timed arm for it.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { PaymentCase } from './corpus.js';
import { encodeCost, encodeHybrid, encodeSources, type FlatCase, type PlanResult } from './kernel.js';

export function loadCorpus(): PaymentCase[] {
  const path = fileURLToPath(new URL('../results/corpus.json', import.meta.url));
  return JSON.parse(readFileSync(path, 'utf8')) as PaymentCase[];
}

export function toFlatCase(c: PaymentCase): FlatCase {
  const pool = Int32Array.from(c.pool);
  const cost = new Int32Array(7);
  encodeCost(c.cost, cost);
  return { pool, cost, hybrid: encodeHybrid(c.cost), sources: encodeSources(c.sources) };
}

/**
 * A plan rendered as a comparable string. Keeps the three-way distinction the
 * caller acts on: unpayable, already covered by the floating pool, or a sequence
 * of taps in order.
 */
export function describePlan(p: PlanResult): string {
  if (p === null) return 'UNPAYABLE';
  if (p.length === 0) return 'ALREADY-PAID';
  return p.map((t) => `${t.sourceIndex}/${t.modeIndex}`).join(',');
}
