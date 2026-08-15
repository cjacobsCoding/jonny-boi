/**
 * Continuous-effects layer (DESIGN §3.9). ONE layering path for every modification
 * to a permanent's characteristics — P/T deltas and keyword grants — layered over
 * the printed base and +1/+1 counters whenever the engine reads "effective" stats.
 *
 * Two lifetimes feed the same aggregation, deliberately not two code paths:
 *
 *   1. **Until end of turn** — a `ContinuousEffect` record in `GameState.continuous`,
 *      registered by a pump primitive via `EffectContext.addContinuousEffect` and
 *      removed in the cleanup step, so a Giant Growth genuinely wears off.
 *   2. **Static / "anthem"** — a {@link StaticAbility} declared as data on a
 *      permanent's `CardDefinition` (see `../statics.ts`), applying to a *set* of
 *      permanents matched by a filter for exactly as long as the SOURCE is on the
 *      battlefield.
 *
 * The static lifetime needs no bookkeeping at all because it is **derived, not
 * stored**: each aggregation pass re-reads `state.battlefield`. The moment a source
 * is destroyed/exiled/bounced it is gone from that array, so the next read — the
 * state-based-action pass that runs immediately after combat damage, for one — no
 * longer sees its modification, and a creature that only an anthem was keeping alive
 * dies right then. Nothing can go stale because nothing is cached across a mutation.
 *
 * Design choices:
 *   - **Data, not classes.** Both kinds are plain records; core never names a card.
 *   - **Composition.** P/T deltas sum; keyword grants OR together. No per-card
 *     layering logic — every active modification that matches contributes additively.
 *   - **Cheap recompute.** Callers that touch many creatures (combat, SBAs, legality,
 *     serialization) build a single `ContinuousIndex` once per pass via
 *     `indexContinuous(state)`, then look each creature up in O(1).
 *   - **A board with no modifications pays ~nothing.** `indexContinuous` returns a
 *     shared frozen empty index without allocating when `state.continuous` is empty
 *     and no permanent on the battlefield declares a static — which is the common
 *     case on the sim's hottest path.
 *
 * ## Layering order (documented; see also internal/stats.ts)
 *   1. printed base P/T and keywords
 *   2. +1/+1 counters
 *   3. static abilities from permanents currently on the battlefield
 *   4. until-end-of-turn continuous effects
 * Layers 3 and 4 are both purely additive (sums) and idempotent (keyword ORs), so
 * the aggregate is order-independent; the order is stated so it stays well-defined
 * if a future *setting* effect ("becomes a 1/1") is ever added, which would have to
 * be inserted with explicit precedence rather than folded in here.
 *
 * Determinism: aggregation is sums and ORs over `state.battlefield` (stable order)
 * and `state.continuous` (insertion order), so the same state always yields the same
 * effective values — no map-iteration order or floating point is involved.
 */

import type { CardInstance, GameState, InstanceId } from '../state.js';
import type { KeywordFlags } from '../card.js';
import type { GameEvent } from '../events.js';
import type { StaticAbility } from '../statics.js';
import { staticAppliesTo, staticIsInert, staticsOf } from '../statics.js';

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

/** The mutable accumulator an aggregation pass folds into before freezing. */
interface MutableMod {
  power: number;
  toughness: number;
  keywords: Record<string, boolean>;
}

/** Fold one effect's keyword grants into a mutable accumulator. */
function mergeKeywords(into: Record<string, boolean>, grant: KeywordFlags | undefined): void {
  if (!grant) return;
  for (const key of KEYWORD_KEYS) {
    if (grant[key]) into[key] = true;
  }
}

/** The empty aggregate returned for a permanent with no active modifications. */
export const NO_MOD: AggregatedMod = Object.freeze({ power: 0, toughness: 0, keywords: Object.freeze({}) });

/**
 * The index handed back when nothing on the board modifies anything. Shared and
 * empty so the overwhelmingly common case allocates zero — `ContinuousIndex` is a
 * ReadonlyMap precisely so this can be safely shared.
 */
const EMPTY_INDEX: ContinuousIndex = new Map<InstanceId, AggregatedMod>();

/**
 * One static ability that is live right now, paired with the permanent radiating it.
 * Collected per aggregation pass so the source's controller and identity (for the
 * "other" exclusion) are available while matching.
 */
interface ActiveStatic {
  readonly source: CardInstance;
  readonly ability: StaticAbility;
}

/**
 * The static abilities currently on the battlefield, or `null` when there are none.
 *
 * Returning `null` rather than an empty array is the whole point: a board with no
 * anthem — the normal case, and the one the sim spends nearly all its time in —
 * walks the battlefield checking one property per permanent and allocates nothing.
 * Inert declarations are dropped here so the matching loop below never runs for a
 * static that could not change a number anyway.
 */
function collectActiveStatics(state: GameState): ActiveStatic[] | null {
  let active: ActiveStatic[] | null = null;
  for (const perm of state.battlefield) {
    const declared = perm.def.statics;
    if (!declared || declared.length === 0) continue;
    for (const ability of staticsOf(perm.def)) {
      if (staticIsInert(ability)) continue;
      (active ??= []).push({ source: perm, ability });
    }
  }
  return active;
}

/** Get (creating if needed) the accumulator for one instance. */
function accumulatorFor(map: Map<InstanceId, MutableMod>, id: InstanceId): MutableMod {
  let agg = map.get(id);
  if (!agg) {
    agg = { power: 0, toughness: 0, keywords: {} };
    map.set(id, agg);
  }
  return agg;
}

/** Fold a P/T delta + keyword grant into an accumulator (layers 3 and 4 alike). */
function foldInto(agg: MutableMod, power: number | undefined, toughness: number | undefined, keywords: KeywordFlags | undefined): void {
  agg.power += power ?? 0;
  agg.toughness += toughness ?? 0;
  mergeKeywords(agg.keywords, keywords);
}

/**
 * Build the per-instance aggregation map covering BOTH lifetimes — the statics
 * radiating from permanents on the battlefield and the active until-end-of-turn
 * effects. Call once before a batch of stat reads (combat, SBAs, legality,
 * serialization) and look each permanent up in O(1).
 *
 * Cost: O(battlefield) to discover statics — one property check per permanent, and
 * an immediate shared-empty return when there are none and no temporary effects
 * either. When statics ARE present it is O(battlefield × active statics), which for
 * a real board is a couple of dozen filter checks.
 */
export function indexContinuous(state: GameState): ContinuousIndex {
  const statics = collectActiveStatics(state);
  if (statics === null && state.continuous.length === 0) return EMPTY_INDEX;

  const map = new Map<InstanceId, MutableMod>();
  // Layer 3 — statics, matched against every permanent currently in play.
  if (statics !== null) {
    for (const perm of state.battlefield) {
      for (const { source, ability } of statics) {
        if (!staticAppliesTo(ability, source, perm)) continue;
        foldInto(accumulatorFor(map, perm.instanceId), ability.power, ability.toughness, ability.keywords);
      }
    }
  }
  // Layer 4 — until-end-of-turn effects, folded onto the same accumulators.
  for (const eff of state.continuous) {
    foldInto(accumulatorFor(map, eff.targetInstanceId), eff.power, eff.toughness, eff.keywords);
  }

  const out = new Map<InstanceId, AggregatedMod>();
  for (const [id, agg] of map) {
    out.set(id, { power: agg.power, toughness: agg.toughness, keywords: agg.keywords as KeywordFlags });
  }
  return out;
}

/**
 * Aggregate every active modification for a SINGLE instance without building the
 * whole index. Use for one-off reads; for bulk reads prefer `indexContinuous` + map
 * lookup, which shares the battlefield scan across every permanent.
 *
 * Returns {@link NO_MOD} for an instance that is not on the battlefield and carries
 * no temporary effect — statics only reach permanents in play.
 */
export function aggregateFor(state: GameState, instanceId: InstanceId): AggregatedMod {
  const agg: MutableMod = { power: 0, toughness: 0, keywords: {} };
  let any = false;

  // Layer 3 — statics. Find the permanent once, then test each live static against it.
  const target = findPermanent(state, instanceId);
  if (target) {
    for (const perm of state.battlefield) {
      const declared = perm.def.statics;
      if (!declared || declared.length === 0) continue;
      for (const ability of declared) {
        if (staticIsInert(ability) || !staticAppliesTo(ability, perm, target)) continue;
        any = true;
        foldInto(agg, ability.power, ability.toughness, ability.keywords);
      }
    }
  }
  // Layer 4 — until-end-of-turn effects aimed at this instance.
  for (const eff of state.continuous) {
    if (eff.targetInstanceId !== instanceId) continue;
    any = true;
    foldInto(agg, eff.power, eff.toughness, eff.keywords);
  }

  if (!any) return NO_MOD;
  return { power: agg.power, toughness: agg.toughness, keywords: agg.keywords as KeywordFlags };
}

/**
 * Locate a battlefield permanent by id. Local to this module (rather than reusing
 * `internal/zones.ts`) to keep the layering pass free of an import cycle with the
 * zone-movement code, which itself reads effective stats.
 */
function findPermanent(state: GameState, instanceId: InstanceId): CardInstance | undefined {
  for (const perm of state.battlefield) {
    if (perm.instanceId === instanceId) return perm;
  }
  return undefined;
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
