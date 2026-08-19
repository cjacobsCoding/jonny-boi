/**
 * THE PILOT'S EYES — creature stats read the way the BOARD says they are.
 *
 * Core's `effectivePower` / `effectiveToughness` / `effectiveKeywords` take an
 * `AggregatedMod` that defaults to "nothing modifies this". That default is
 * correct in core, where it means "I have already established that no
 * modification can apply" — and it was catastrophic in this package, where ~40
 * call sites simply never passed one. A pilot that reads the bare accessor is
 * reading the PRINTED card:
 *
 *   - a characteristic-defining `*` P/T (Tarmogoyf) evaluates as **0/0**, because
 *     its real numbers arrive only as `AggregatedMod.basePower`;
 *   - **every anthem is invisible** — a pilot with Glorious Anthem out attacked,
 *     blocked, traded and priced removal on numbers its own board had already
 *     changed;
 *   - **Auras and Equipment are invisible** the same way, so the whole attachment
 *     seam was unseen by evaluation;
 *   - granted keywords (flying off an Aura) were read from `def.keywords` on the
 *     AI path while the rules path read the granted set — two answers to one
 *     question.
 *
 * So this package does not import those accessors at all. It imports these, whose
 * `index` parameter is **required**, and a test (`bare-stats.test.ts`) fails the
 * build if a bare core accessor reappears anywhere in `packages/ai`. The trap is
 * unspellable rather than merely documented — the same discipline the repo already
 * applies to `planManaPayment` and the effect-primitive registry.
 *
 * ## Cost
 * `boardIndex` is `indexContinuous`: one O(battlefield) property-check pass that
 * returns a SHARED EMPTY map when nothing on the board modifies anything, so the
 * common case allocates zero. Build it ONCE per decision (or per evaluation) and
 * thread it; never build one per permanent.
 */

import type { CardInstance, ContinuousIndex, GameState } from '@jonny-boi/core';
import {
  effectiveKeywords,
  effectivePower,
  effectiveToughness,
  indexContinuous,
  NO_MOD,
  remainingToughness,
} from '@jonny-boi/core';
import type { KeywordFlags } from '@jonny-boi/core';
import type { PilotView } from './pilot.js';

export type { ContinuousIndex };

/**
 * Build the per-decision continuous index. Accepts a pilot's read-only view as
 * well as a live state, because every pilot holds the former and the cast is
 * otherwise repeated at every call site.
 */
export function boardIndex(state: GameState | PilotView): ContinuousIndex {
  return indexContinuous(state as GameState);
}

/** Effective power, seeing counters, anthems, attachments and pumps. */
export function power(inst: CardInstance, index: ContinuousIndex): number {
  return effectivePower(inst, index.get(inst.instanceId) ?? NO_MOD);
}

/** Effective toughness, seeing counters, anthems, attachments and pumps. */
export function toughness(inst: CardInstance, index: ContinuousIndex): number {
  return effectiveToughness(inst, index.get(inst.instanceId) ?? NO_MOD);
}

/**
 * `power + toughness` — the "how big is this body" ruler the pilot prices trades,
 * sweepers and card value with. One lookup instead of two.
 */
export function statTotal(inst: CardInstance, index: ContinuousIndex): number {
  const mod = index.get(inst.instanceId) ?? NO_MOD;
  return effectivePower(inst, mod) + effectiveToughness(inst, mod);
}

/** Toughness left after marked damage (≤ 0 means it is already dead). */
export function toughnessLeft(inst: CardInstance, index: ContinuousIndex): number {
  return remainingToughness(inst, index.get(inst.instanceId) ?? NO_MOD);
}

/** The effective keyword set: printed OR-ed with everything granted. */
export function keywordsOf(inst: CardInstance, index: ContinuousIndex): KeywordFlags {
  return effectiveKeywords(inst, index.get(inst.instanceId) ?? NO_MOD);
}
