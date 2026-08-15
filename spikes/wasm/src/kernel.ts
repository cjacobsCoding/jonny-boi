/**
 * The kernel contract every arm implements, and the flat (structure-of-arrays)
 * encoding two of the three arms share.
 *
 * ## What the kernel is
 * `planPayment(pool, cost, sources) → the ordered taps that fund the cost`, i.e.
 * the pure numeric heart of `packages/core/src/mana-plan.ts` + `mana.ts`:
 * feasibility (`canPay`/`payCost`), the shortfall heuristic (`distanceToPayable`)
 * and the greedy tap search. It was chosen because it is the largest slice of the
 * measured profile that has a NARROW, purely numeric interface — everything hotter
 * (state cloning, legal-action generation, pilot scoring) walks the object graph
 * and has no boundary you could pass numbers across.
 *
 * ## The flat encoding
 * One `Int32Array` per input, no objects, no per-call allocation:
 *
 *   pool     — 6 ints, canonical `MANA_COLORS` order (W U B R G C)
 *   cost     — 7 ints: [generic, W, U, B, R, G, C]
 *   hybrid   — a ragged list flattened to [symbolCount, len0, colours…, len1, …],
 *              colours as canonical indices. Hybrids are 2% of real cases but they
 *              are not droppable: a kernel that mis-costs `{G/W}` would silently
 *              change which spells the AI believes it can cast, which changes the
 *              GAMES, which changes the verdicts.
 *   sources  — [sourceCount, then per source: modeCount, then 6 ints per mode]
 *
 * ## Determinism
 * The tie-break order is copied exactly, not re-derived: best-by-shortfall, then
 * LEAST flexible source, then smallest producer, first-seen wins; sources in the
 * engine's offer order, modes in declaration order. The generic portion is paid
 * colourless-first then W U B R G. Any deviation is a different function even
 * where it is "equally correct", and the product's A/B verdicts are only
 * meaningful because the same seed replays the same game.
 */

import type { ManaCost } from '@jonny-boi/core';

/** Canonical colour order. Index positions are part of the wire format. */
export const COLOR_COUNT = 6;

/** Index into the flat cost array. */
export const COST_GENERIC = 0;

/** One chosen tap: which source (by index into `sources`) and which of its modes. */
export interface ChosenTap {
  readonly sourceIndex: number;
  readonly modeIndex: number;
}

/**
 * The kernel result. `null` means "this board cannot pay the cost"; an EMPTY array
 * means "the floating pool already covers it — stop tapping". Collapsing those two
 * would make the caller tap past what it needs (pools empty at end of step), which
 * is the distinction the real planner is careful about.
 */
export type PlanResult = readonly ChosenTap[] | null;

/** A payment question in flat form, ready to hand to a flat kernel. */
export interface FlatCase {
  readonly pool: Int32Array;
  readonly cost: Int32Array;
  readonly hybrid: Int32Array;
  readonly sources: Int32Array;
}

/** Encode a cost record into the flat 7-int form. */
export function encodeCost(cost: ManaCost, out: Int32Array): void {
  out[COST_GENERIC] = cost.generic ?? 0;
  out[1] = cost.W ?? 0;
  out[2] = cost.U ?? 0;
  out[3] = cost.B ?? 0;
  out[4] = cost.R ?? 0;
  out[5] = cost.G ?? 0;
  out[6] = cost.C ?? 0;
}

const COLOR_INDEX: Readonly<Record<string, number>> = { W: 0, U: 1, B: 2, R: 3, G: 4, C: 5 };

/** Encode the hybrid symbols of a cost into the ragged flat form. */
export function encodeHybrid(cost: ManaCost): Int32Array {
  const symbols = cost.hybrid ?? [];
  const size = 1 + symbols.reduce((n, s) => n + 1 + s.length, 0);
  const out = new Int32Array(size);
  out[0] = symbols.length;
  let w = 1;
  for (const symbol of symbols) {
    out[w++] = symbol.length;
    for (const colour of symbol) out[w++] = COLOR_INDEX[colour] ?? 5;
  }
  return out;
}

/** Encode the per-source production modes into the ragged flat form. */
export function encodeSources(sources: readonly (readonly (readonly number[])[])[]): Int32Array {
  const size = 1 + sources.reduce((n, modes) => n + 1 + modes.length * COLOR_COUNT, 0);
  const out = new Int32Array(size);
  out[0] = sources.length;
  let w = 1;
  for (const modes of sources) {
    out[w++] = modes.length;
    for (const mode of modes) {
      for (let c = 0; c < COLOR_COUNT; c++) out[w++] = mode[c] ?? 0;
    }
  }
  return out;
}

/** The shape every arm exposes, so the benchmark can drive them identically. */
export interface PaymentKernel {
  readonly name: string;
  /** Plan from the flat encoding. Arms that are not flat encode internally. */
  planFlat(flat: FlatCase): PlanResult;
}
