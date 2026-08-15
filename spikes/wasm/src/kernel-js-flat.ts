/**
 * Arm 2 — the same payment planner over a FLAT (structure-of-arrays) layout, in
 * ordinary JavaScript.
 *
 * This arm exists to separate two things the WASM question constantly conflates:
 * the *language* and the *data layout*. Almost everything a WASM port would win
 * here comes from working over packed integers instead of `{ W: 1, U: 0, … }`
 * objects — no property lookups, no per-call allocation, no garbage. That win is
 * available in plain JS at a fraction of the cost and risk, so it has to be
 * measured as its own arm rather than folded into the WASM number.
 *
 * The algorithm is a line-for-line transcription of `mana-plan.ts` +
 * `mana.ts::payFixedCost`, including the hybrid search and every tie-break, so a
 * disagreement with the shipped implementation is a BUG in this file rather than
 * a design liberty. `verify.ts` asserts agreement over the whole recorded corpus.
 *
 * Allocation: one module-level scratch buffer per role, reused across calls. The
 * kernel allocates only the result array, and only when a plan is actually found.
 */

import { COLOR_COUNT, type ChosenTap, type FlatCase, type PaymentKernel, type PlanResult } from './kernel.js';

/** Scratch pools. Module-level and reused — the kernel must not allocate per call. */
const remaining = new Int32Array(COLOR_COUNT);
const working = new Int32Array(COLOR_COUNT);
const scratch = new Int32Array(COLOR_COUNT);
const folded = new Int32Array(COLOR_COUNT + 1);
/** Colour chosen for each hybrid symbol during the exhaustive hybrid search. */
const hybridChoice = new Int32Array(32);

/**
 * Generic mana is spent colourless-first, then W U B R G — the shipped order.
 * Stored as colour indices so the loop is a straight array walk.
 */
const GENERIC_ORDER = new Int32Array([5, 0, 1, 2, 3, 4]);

/**
 * Can `pool` pay a fixed (hybrid-free) cost? `cost` is [generic, W, U, B, R, G, C].
 * Mirrors `payFixedCost`: specific symbols from their own colour first, then the
 * generic remainder in the fixed order.
 */
function canPayFixed(pool: Int32Array, poolOffset: number, cost: Int32Array, costOffset: number): boolean {
  for (let c = 0; c < COLOR_COUNT; c++) {
    const have = pool[poolOffset + c] as number;
    const need = cost[costOffset + 1 + c] as number;
    if (have < need) return false;
    remaining[c] = have - need;
  }
  let generic = cost[costOffset] as number;
  for (let i = 0; i < COLOR_COUNT && generic > 0; i++) {
    const c = GENERIC_ORDER[i] as number;
    const take = Math.min(generic, remaining[c] as number);
    remaining[c] = (remaining[c] as number) - take;
    generic -= take;
  }
  return generic <= 0;
}

/**
 * Exhaustive hybrid assignment, first success wins, symbols enumerated in printed
 * order and colours in declared order — the shipped `payWithHybrids` search.
 * Exhaustive rather than greedy for the shipped reason: a greedy pick can fail a
 * cost that is genuinely payable, which would make the AI decline a castable spell.
 */
function canPayHybrid(pool: Int32Array, cost: Int32Array, hybrid: Int32Array, symbol: number, cursor: number): boolean {
  const symbolCount = hybrid[0] as number;
  if (symbol === symbolCount) {
    folded[0] = cost[0] as number;
    for (let c = 0; c < COLOR_COUNT; c++) folded[1 + c] = cost[1 + c] as number;
    for (let s = 0; s < symbolCount; s++) {
      const colour = hybridChoice[s] as number;
      folded[1 + colour] = (folded[1 + colour] as number) + 1;
    }
    return canPayFixed(pool, 0, folded, 0);
  }
  const optionCount = hybrid[cursor] as number;
  for (let o = 0; o < optionCount; o++) {
    hybridChoice[symbol] = hybrid[cursor + 1 + o] as number;
    if (canPayHybrid(pool, cost, hybrid, symbol + 1, cursor + 1 + optionCount)) return true;
  }
  return false;
}

/** Whether the pool covers the cost, hybrids included. */
function canPay(pool: Int32Array, cost: Int32Array, hybrid: Int32Array): boolean {
  if ((hybrid[0] as number) > 0) return canPayHybrid(pool, cost, hybrid, 0, 1);
  return canPayFixed(pool, 0, cost, 0);
}

/**
 * Pips still unfunded — the ranking heuristic, NOT the authority on payability
 * (that is `canPay`). Mirrors `distanceToPayable`, hybrids deliberately invisible
 * to it exactly as in the shipped version.
 */
function distanceToPayable(pool: Int32Array, cost: Int32Array): number {
  let short = 0;
  let spare = 0;
  for (let c = 0; c < COLOR_COUNT; c++) {
    const need = cost[1 + c] as number;
    const have = pool[c] as number;
    if (have < need) short += need - have;
    else spare += have - need;
  }
  const generic = cost[0] as number;
  const uncovered = generic - spare;
  return short + (uncovered > 0 ? uncovered : 0);
}

/**
 * Plan the taps that fund the cost. Greedy: repeatedly take the tap that closes
 * the most shortfall, breaking ties toward the least flexible source and then the
 * smallest producer. A tapped source leaves the candidate set, so it terminates.
 */
export function planFlat(flat: FlatCase): PlanResult {
  const { pool, cost, hybrid, sources } = flat;
  for (let c = 0; c < COLOR_COUNT; c++) working[c] = pool[c] as number;
  if (canPay(working, cost, hybrid)) return EMPTY_PLAN;

  const sourceCount = sources[0] as number;
  // Offsets into the ragged sources array, and a live/spent flag per source.
  const offsets = new Int32Array(sourceCount);
  const spent = new Uint8Array(sourceCount);
  {
    let r = 1;
    for (let s = 0; s < sourceCount; s++) {
      offsets[s] = r;
      r += 1 + (sources[r] as number) * COLOR_COUNT;
    }
  }

  let plan: ChosenTap[] | null = null;
  for (;;) {
    if (canPay(working, cost, hybrid)) return plan ?? EMPTY_PLAN;
    // At least one pip is owed; floor at 1 so a useful tap is still accepted when
    // the heuristic cannot see the shortfall (a hybrid symbol reads as satisfied).
    const rawDistance = distanceToPayable(working, cost);
    const current = rawDistance > 1 ? rawDistance : 1;

    let bestSource = -1;
    let bestMode = -1;
    let bestDistance = current;
    let bestFlexibility = Number.POSITIVE_INFINITY;
    let bestSize = Number.POSITIVE_INFINITY;

    for (let s = 0; s < sourceCount; s++) {
      if (spent[s] === 1) continue;
      const base = offsets[s] as number;
      const modeCount = sources[base] as number;
      const flexibility = modeCount;
      for (let m = 0; m < modeCount; m++) {
        const mode = base + 1 + m * COLOR_COUNT;
        let size = 0;
        for (let c = 0; c < COLOR_COUNT; c++) {
          const add = sources[mode + c] as number;
          scratch[c] = (working[c] as number) + add;
          size += add;
        }
        const distance = distanceToPayable(scratch, cost);
        if (distance >= current) continue;
        const better =
          distance < bestDistance ||
          (distance === bestDistance && flexibility < bestFlexibility) ||
          (distance === bestDistance && flexibility === bestFlexibility && size < bestSize);
        if (better) {
          bestSource = s;
          bestMode = m;
          bestDistance = distance;
          bestFlexibility = flexibility;
          bestSize = size;
        }
      }
    }

    if (bestSource < 0) return null;
    spent[bestSource] = 1;
    const chosenBase = (offsets[bestSource] as number) + 1 + bestMode * COLOR_COUNT;
    for (let c = 0; c < COLOR_COUNT; c++) {
      working[c] = (working[c] as number) + (sources[chosenBase + c] as number);
    }
    (plan ??= []).push({ sourceIndex: bestSource, modeIndex: bestMode });
  }
}

/** Shared empty plan — "the pool already covers it", allocated once. */
const EMPTY_PLAN: readonly ChosenTap[] = Object.freeze([]);

export const jsFlatKernel: PaymentKernel = { name: 'js-flat', planFlat };
