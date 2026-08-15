/**
 * Arm 3 — the payment planner in WebAssembly (AssemblyScript).
 *
 * A line-for-line port of `packages/core/src/mana-plan.ts` + `mana.ts`, over the
 * same flat integer layout as the JS-flat arm, so the ONLY difference between
 * arms 2 and 3 is the language. That is deliberate: it is the only way to read
 * "what does WASM buy" separately from "what does the flat layout buy".
 *
 * ## Boundary design
 * All data lives in one `i32` arena in linear memory. The host writes a case into
 * the arena and calls `planAt(caseOffset, outOffset)`; the plan comes back as
 * pairs of ints written into the arena, and the return value is the tap count.
 * Nothing rich crosses the boundary — no strings, no objects, no allocation per
 * call — which is the most favourable boundary this kernel can possibly have. If
 * WASM loses even with this, it loses.
 *
 * Return contract, matching the JS arms exactly:
 *   -1  the board cannot pay the cost
 *    0  the floating pool already covers it (tap nothing)
 *   n>0 n taps, written as (sourceIndex, modeIndex) pairs at `outOffset`
 *
 * ## Case record layout (i32 words, from `caseOffset`)
 *   [0..5]    pool, canonical colour order W U B R G C
 *   [6..12]   cost: generic, W, U, B, R, G, C
 *   [13]      hybrid word count h
 *   [14..]    hybrid words: symbolCount, then per symbol: optionCount, colours…
 *   [14+h..]  sources: sourceCount, then per source: modeCount, then 6 ints/mode
 *
 * ## Determinism
 * Every tie-break, iteration order and the colourless-first generic spend order
 * are copied from the shipped implementation. `Infinity` sentinels become
 * `i32.MAX_VALUE`, which compares identically here because flexibility and
 * producer size are small non-negative integers.
 */

const COLOR_COUNT: i32 = 6;

/**
 * The shared arena — 8M i32 words (32 MiB). Sized to hold the ENTIRE recorded
 * corpus resident at once, which the batch ceiling arm needs; the per-call arms
 * use only the first few hundred words.
 */
const ARENA_INTS: i32 = 1 << 23;
const arena = new StaticArray<i32>(ARENA_INTS);

/** Byte offset of the arena in linear memory, so the host can view it. */
export function arenaPtr(): usize {
  return changetype<usize>(arena);
}

/** Arena capacity in i32 words. */
export function arenaInts(): i32 {
  return ARENA_INTS;
}

// Scratch, allocated once at module init — the kernel allocates nothing per call.
const remaining = new StaticArray<i32>(COLOR_COUNT);
const working = new StaticArray<i32>(COLOR_COUNT);
const scratch = new StaticArray<i32>(COLOR_COUNT);
const folded = new StaticArray<i32>(COLOR_COUNT + 1);
const hybridChoice = new StaticArray<i32>(32);
const sourceOffsets = new StaticArray<i32>(256);
const sourceSpent = new StaticArray<i32>(256);

/** Generic mana is spent colourless-first, then W U B R G — the shipped order. */
const genericOrder = new StaticArray<i32>(6);

function initGenericOrder(): void {
  unchecked((genericOrder[0] = 5));
  unchecked((genericOrder[1] = 0));
  unchecked((genericOrder[2] = 1));
  unchecked((genericOrder[3] = 2));
  unchecked((genericOrder[4] = 3));
  unchecked((genericOrder[5] = 4));
}
initGenericOrder();

/**
 * Can `pool` pay a fixed (hybrid-free) cost held in `arena` at `costOffset`?
 * Specific symbols come from their own colour first, then generic from the rest.
 */
function canPayFixedArena(pool: StaticArray<i32>, costOffset: i32): boolean {
  for (let c = 0; c < COLOR_COUNT; c++) {
    const have = unchecked(pool[c]);
    const need = unchecked(arena[costOffset + 1 + c]);
    if (have < need) return false;
    unchecked((remaining[c] = have - need));
  }
  let generic = unchecked(arena[costOffset]);
  for (let i = 0; i < COLOR_COUNT && generic > 0; i++) {
    const c = unchecked(genericOrder[i]);
    const avail = unchecked(remaining[c]);
    const take = generic < avail ? generic : avail;
    unchecked((remaining[c] = avail - take));
    generic -= take;
  }
  return generic <= 0;
}

/** The same check against the `folded` scratch cost (used by the hybrid search). */
function canPayFixedFolded(pool: StaticArray<i32>): boolean {
  for (let c = 0; c < COLOR_COUNT; c++) {
    const have = unchecked(pool[c]);
    const need = unchecked(folded[1 + c]);
    if (have < need) return false;
    unchecked((remaining[c] = have - need));
  }
  let generic = unchecked(folded[0]);
  for (let i = 0; i < COLOR_COUNT && generic > 0; i++) {
    const c = unchecked(genericOrder[i]);
    const avail = unchecked(remaining[c]);
    const take = generic < avail ? generic : avail;
    unchecked((remaining[c] = avail - take));
    generic -= take;
  }
  return generic <= 0;
}

/**
 * Exhaustive hybrid assignment, first success wins, symbols in printed order and
 * colours in declared order. Exhaustive rather than greedy for the shipped reason:
 * a greedy pick can fail a cost that is genuinely payable.
 */
function canPayHybrid(
  pool: StaticArray<i32>,
  costOffset: i32,
  hybridOffset: i32,
  symbol: i32,
  cursor: i32,
): boolean {
  const symbolCount = unchecked(arena[hybridOffset]);
  if (symbol === symbolCount) {
    unchecked((folded[0] = arena[costOffset]));
    for (let c = 0; c < COLOR_COUNT; c++) unchecked((folded[1 + c] = arena[costOffset + 1 + c]));
    for (let s = 0; s < symbolCount; s++) {
      const colour = unchecked(hybridChoice[s]);
      unchecked((folded[1 + colour] = folded[1 + colour] + 1));
    }
    return canPayFixedFolded(pool);
  }
  const optionCount = unchecked(arena[cursor]);
  for (let o = 0; o < optionCount; o++) {
    unchecked((hybridChoice[symbol] = arena[cursor + 1 + o]));
    if (canPayHybrid(pool, costOffset, hybridOffset, symbol + 1, cursor + 1 + optionCount)) return true;
  }
  return false;
}

function canPay(pool: StaticArray<i32>, costOffset: i32, hybridOffset: i32): boolean {
  if (unchecked(arena[hybridOffset]) > 0) return canPayHybrid(pool, costOffset, hybridOffset, 0, hybridOffset + 1);
  return canPayFixedArena(pool, costOffset);
}

/** Pips still unfunded — the ranking heuristic, not the payability authority. */
function distanceToPayable(pool: StaticArray<i32>, costOffset: i32): i32 {
  let short: i32 = 0;
  let spare: i32 = 0;
  for (let c = 0; c < COLOR_COUNT; c++) {
    const need = unchecked(arena[costOffset + 1 + c]);
    const have = unchecked(pool[c]);
    if (have < need) short += need - have;
    else spare += have - need;
  }
  const uncovered = unchecked(arena[costOffset]) - spare;
  return short + (uncovered > 0 ? uncovered : 0);
}

/**
 * Plan the taps that fund the cost at `caseOffset`, writing (sourceIndex,
 * modeIndex) pairs at `outOffset`. Returns the tap count, or -1 if unpayable.
 */
export function planAt(caseOffset: i32, outOffset: i32): i32 {
  const poolOffset = caseOffset;
  const costOffset = caseOffset + COLOR_COUNT;
  const hybridWords = unchecked(arena[caseOffset + COLOR_COUNT + 7]);
  const hybridOffset = caseOffset + COLOR_COUNT + 8;
  const sourcesOffset = hybridOffset + hybridWords;

  for (let c = 0; c < COLOR_COUNT; c++) unchecked((working[c] = arena[poolOffset + c]));
  if (canPay(working, costOffset, hybridOffset)) return 0;

  const sourceCount = unchecked(arena[sourcesOffset]);
  let r = sourcesOffset + 1;
  for (let s = 0; s < sourceCount; s++) {
    unchecked((sourceOffsets[s] = r));
    unchecked((sourceSpent[s] = 0));
    r += 1 + unchecked(arena[r]) * COLOR_COUNT;
  }

  let taps: i32 = 0;
  const SENTINEL: i32 = i32.MAX_VALUE;
  while (true) {
    if (canPay(working, costOffset, hybridOffset)) return taps;
    const raw = distanceToPayable(working, costOffset);
    // Floor at 1 so a useful tap is still accepted when the heuristic cannot see
    // the shortfall (a hybrid symbol reads as already satisfied).
    const current = raw > 1 ? raw : 1;

    let bestSource: i32 = -1;
    let bestMode: i32 = -1;
    let bestDistance = current;
    let bestFlexibility = SENTINEL;
    let bestSize = SENTINEL;

    for (let s = 0; s < sourceCount; s++) {
      if (unchecked(sourceSpent[s]) === 1) continue;
      const base = unchecked(sourceOffsets[s]);
      const modeCount = unchecked(arena[base]);
      const flexibility = modeCount;
      for (let m = 0; m < modeCount; m++) {
        const mode = base + 1 + m * COLOR_COUNT;
        let size: i32 = 0;
        for (let c = 0; c < COLOR_COUNT; c++) {
          const add = unchecked(arena[mode + c]);
          unchecked((scratch[c] = working[c] + add));
          size += add;
        }
        const distance = distanceToPayable(scratch, costOffset);
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

    if (bestSource < 0) return -1;
    unchecked((sourceSpent[bestSource] = 1));
    const chosenBase = unchecked(sourceOffsets[bestSource]) + 1 + bestMode * COLOR_COUNT;
    for (let c = 0; c < COLOR_COUNT; c++) {
      unchecked((working[c] = working[c] + arena[chosenBase + c]));
    }
    unchecked((arena[outOffset + taps * 2] = bestSource));
    unchecked((arena[outOffset + taps * 2 + 1] = bestMode));
    taps += 1;
  }
}

/**
 * Plan a whole batch of pre-loaded cases in ONE boundary crossing.
 *
 * `indexOffset` holds [count, caseOffset0, caseOffset1, …]. Results are written as
 * [tapCount, then the pairs] consecutively from `outOffset`; the return value is
 * the number of i32 words written.
 *
 * This exists to measure the ceiling: if amortising the call overhead across
 * thousands of cases still does not beat JS, per-call crossing certainly will not.
 */
export function planBatch(indexOffset: i32, outOffset: i32): i32 {
  const count = unchecked(arena[indexOffset]);
  let w = outOffset;
  for (let i = 0; i < count; i++) {
    const caseOffset = unchecked(arena[indexOffset + 1 + i]);
    const taps = planAt(caseOffset, w + 1);
    unchecked((arena[w] = taps));
    w += 1 + (taps > 0 ? taps * 2 : 0);
  }
  return w - outOffset;
}
