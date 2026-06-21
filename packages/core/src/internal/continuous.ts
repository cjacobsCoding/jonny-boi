/**
 * Continuous-effects layer (DESIGN §3.9). Temporary modifications to a permanent's
 * characteristics — P/T buffs (+X/+Y) and keyword grants — that are layered over
 * the printed base (and any +1/+1 counters) when the engine reads "effective"
 * stats. The canonical use is an "until end of turn" pump (Giant Growth): the
 * modification lives in `GameState.continuous` and is removed in the cleanup step,
 * so it genuinely wears off rather than being baked in as a permanent counter.
 *
 * Design choices:
 *   - **Data, not classes.** A `ContinuousEffect` is a plain record. The pump
 *     primitive (owned by `cards`) registers one via `EffectContext.addContinuousEffect`.
 *   - **Composition.** P/T deltas sum; keyword grants OR together. No per-card layering
 *     logic — every active effect that targets an instance contributes additively.
 *   - **Cheap recompute.** Rather than recomputing the whole world on every stat read,
 *     callers that touch many creatures (combat, SBAs, serialization) build a single
 *     `ContinuousIndex` once per pass via `indexContinuous(state)` — an O(effects) map
 *     from instance id to its aggregated delta — then look each creature up in O(1).
 *     Single-creature reads can pass the raw list and accept an O(effects) scan; with
 *     the handful of temporary effects a real game carries, that stays negligible.
 *
 * Determinism: effects carry a stable insertion id; aggregation is order-independent
 * (sums and ORs), so the same set always yields the same effective values.
 */

import type { GameState, InstanceId } from '../state.js';
import type { KeywordFlags } from '../card.js';
import type { GameEvent } from '../events.js';

/**
 * How long a continuous effect lasts before the engine removes it.
 *   - `endOfTurn`: removed in the cleanup step of the current turn (the common case).
 *   - `permanent`: never auto-removed (reserved for future static-ability use); the
 *     engine keeps it until something explicitly clears it.
 */
export type ContinuousDuration = 'endOfTurn' | 'permanent';

/**
 * One active temporary modification applied to a single permanent. P/T deltas are
 * additive; `keywords` grants are OR-ed onto the base keyword set. All fields beyond
 * identity/target/duration are optional so an effect can be "just +2/+2", "just grant
 * trample", or both.
 */
export interface ContinuousEffect {
  /** Stable id (monotonic from GameState.nextInstanceId space) for dedupe/debug. */
  readonly id: number;
  /** The permanent this effect modifies. */
  readonly targetInstanceId: InstanceId;
  /** The instance that created this effect (for debug/event attribution). */
  readonly sourceInstanceId: InstanceId;
  readonly duration: ContinuousDuration;
  /** Power delta (added to base + counters). Omit/0 for none. */
  readonly power?: number;
  /** Toughness delta (added to base + counters). Omit/0 for none. */
  readonly toughness?: number;
  /** Keyword abilities granted while this effect is active. */
  readonly keywords?: KeywordFlags;
}

/** The aggregated continuous modification for one permanent. */
export interface AggregatedMod {
  readonly power: number;
  readonly toughness: number;
  readonly keywords: KeywordFlags;
}

/** A precomputed lookup from instance id to its aggregated continuous mod. */
export type ContinuousIndex = ReadonlyMap<InstanceId, AggregatedMod>;

/** The keyword flags, in canonical order, that a grant can set. */
const KEYWORD_KEYS: readonly (keyof KeywordFlags)[] = [
  'flying',
  'vigilance',
  'haste',
  'firstStrike',
  'doubleStrike',
  'deathtouch',
  'trample',
  'reach',
  'defender',
  'lifelink',
];

/** Fold one effect's keyword grants into a mutable accumulator. */
function mergeKeywords(into: Record<string, boolean>, grant: KeywordFlags | undefined): void {
  if (!grant) return;
  for (const key of KEYWORD_KEYS) {
    if (grant[key]) into[key] = true;
  }
}

/**
 * Build the per-instance aggregation map for all currently-active continuous
 * effects. O(number of active effects). Call once before a batch of stat reads.
 */
export function indexContinuous(state: GameState): ContinuousIndex {
  const map = new Map<InstanceId, { power: number; toughness: number; keywords: Record<string, boolean> }>();
  for (const eff of state.continuous) {
    let agg = map.get(eff.targetInstanceId);
    if (!agg) {
      agg = { power: 0, toughness: 0, keywords: {} };
      map.set(eff.targetInstanceId, agg);
    }
    agg.power += eff.power ?? 0;
    agg.toughness += eff.toughness ?? 0;
    mergeKeywords(agg.keywords, eff.keywords);
  }
  const out = new Map<InstanceId, AggregatedMod>();
  for (const [id, agg] of map) {
    out.set(id, { power: agg.power, toughness: agg.toughness, keywords: agg.keywords as KeywordFlags });
  }
  return out;
}

/** The empty aggregate returned for a permanent with no active effects. */
export const NO_MOD: AggregatedMod = Object.freeze({ power: 0, toughness: 0, keywords: Object.freeze({}) });

/**
 * Aggregate the active continuous effects targeting a single instance directly off
 * `state.continuous` (no precomputed index). Use for one-off reads; for bulk reads
 * prefer `indexContinuous` + map lookup.
 */
export function aggregateFor(state: GameState, instanceId: InstanceId): AggregatedMod {
  let power = 0;
  let toughness = 0;
  const keywords: Record<string, boolean> = {};
  let any = false;
  for (const eff of state.continuous) {
    if (eff.targetInstanceId !== instanceId) continue;
    any = true;
    power += eff.power ?? 0;
    toughness += eff.toughness ?? 0;
    mergeKeywords(keywords, eff.keywords);
  }
  if (!any) return NO_MOD;
  return { power, toughness, keywords: keywords as KeywordFlags };
}

/**
 * Remove all continuous effects of a given duration, emitting an expiry event per
 * removed effect (so the inspector/sim-log can show pumps wearing off). Returns the
 * number removed. Called from the cleanup step for `endOfTurn`.
 */
export function expireContinuousEffects(
  state: GameState,
  duration: ContinuousDuration,
  emit: (e: GameEvent) => void,
): number {
  let removed = 0;
  const kept: ContinuousEffect[] = [];
  for (const eff of state.continuous) {
    if (eff.duration === duration) {
      removed += 1;
      emit({
        type: 'continuousEffectExpired',
        targetInstanceId: eff.targetInstanceId,
        sourceInstanceId: eff.sourceInstanceId,
        duration: eff.duration,
      });
    } else {
      kept.push(eff);
    }
  }
  state.continuous = kept;
  return removed;
}

/**
 * Drop any continuous effects that target an instance no longer on the battlefield
 * (it left play, so its temporary buffs are meaningless). Keeps the list from
 * growing unbounded across a long game. Pure bookkeeping — emits nothing.
 */
export function pruneOrphanContinuousEffects(state: GameState): void {
  if (state.continuous.length === 0) return;
  const live = new Set<InstanceId>(state.battlefield.map((c) => c.instanceId));
  if (state.continuous.every((e) => live.has(e.targetInstanceId))) return;
  state.continuous = state.continuous.filter((e) => live.has(e.targetInstanceId));
}
