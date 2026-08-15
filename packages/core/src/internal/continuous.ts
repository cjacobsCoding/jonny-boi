/**
 * Continuous-effects layer (DESIGN §3.9). ONE layering path for every modification
 * to a permanent's characteristics — P/T deltas and keyword grants — layered over
 * the printed base and +1/+1 counters whenever the engine reads "effective" stats.
 *
 * Three lifetimes feed the same aggregation, deliberately not three code paths:
 *
 *   1. **Until end of turn** — a `ContinuousEffect` record in `GameState.continuous`,
 *      registered by a pump primitive via `EffectContext.addContinuousEffect` and
 *      removed in the cleanup step, so a Giant Growth genuinely wears off.
 *   2. **Static / "anthem"** — a {@link StaticAbility} declared as data on a
 *      permanent's `CardDefinition` (see `../statics.ts`), applying to a *set* of
 *      permanents matched by a filter for exactly as long as the SOURCE is on the
 *      battlefield.
 *   3. **Attached** — an Aura's or an Equipment's grant to the single permanent it
 *      is attached to (`../attachments.ts`), for exactly as long as the attachment
 *      is on the battlefield attached to it. Structurally this is case 2 with a
 *      filter of "the one permanent named by `attachedTo`", which is why it folds
 *      into the same pass instead of getting a layer of its own.
 *
 * The static and attached lifetimes need no bookkeeping at all because they are
 * **derived, not stored**: each aggregation pass re-reads `state.battlefield`. The
 * moment a source is destroyed/exiled/bounced it is gone from that array, so the
 * next read — the state-based-action pass that runs immediately after combat damage,
 * for one — no longer sees its modification, and a creature that only an anthem (or
 * only an Aura) was keeping alive dies right then. Nothing can go stale because
 * nothing is cached across a mutation.
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
 *   3. modifications radiating from permanents currently on the battlefield —
 *      attachments (3a) then static abilities (3b)
 *   4. until-end-of-turn continuous effects
 * Layers 3 and 4 are all purely additive (sums) and idempotent (keyword ORs), so
 * the aggregate is order-independent — 3a before 3b is an ordering of convenience,
 * not of precedence. The order is stated so it stays well-defined if a future
 * *setting* effect ("becomes a 1/1", "loses all abilities") is ever added, which
 * would have to be inserted with explicit precedence rather than folded in here.
 * That is also the honest limit of this model: MTG's real layer system (CR 613)
 * orders copy → control → text-changing → type → ability → P/T, and this collapses
 * it to "everything is an additive P/T delta and a keyword OR" — which is EXACT for
 * every modification the engine can currently express, and would need genuine
 * sublayers the day a card sets a value rather than adding to one.
 *
 * Determinism: aggregation is sums and ORs over `state.battlefield` (stable order)
 * and `state.continuous` (insertion order), so the same state always yields the same
 * effective values — no map-iteration order or floating point is involved.
 */

import type { CardInstance, GameState, InstanceId } from '../state.js';
import type { KeywordFlags } from '../card.js';
import type { GameEvent } from '../events.js';
import { modificationIsInert, staticAppliesTo, staticIsInert, staticsOf } from '../statics.js';

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

/**
 * The accumulator an aggregation pass folds into. Structurally an `AggregatedMod`
 * with the readonly-ness dropped, so the SAME object can be built up in place and
 * then handed out as the final immutable value — the index is built once, not
 * built-then-copied. That halved the allocations on a board carrying an anthem,
 * where every affected creature needs an entry.
 */
interface MutableMod {
  power: number;
  toughness: number;
  keywords: KeywordFlags;
}

/**
 * The keyword object an accumulator starts with. Shared and frozen: the vast
 * majority of modifications are P/T-only, so allocating a fresh `{}` per affected
 * creature was pure waste. {@link grantInto} replaces it with a real object the
 * first time a keyword is actually granted (copy-on-write).
 */
const NO_KEYWORDS: KeywordFlags = Object.freeze({});

/** Fold one keyword grant into an accumulator, allocating only if something is set. */
function grantInto(agg: MutableMod, grant: KeywordFlags | undefined): void {
  if (!grant) return;
  for (const key of KEYWORD_KEYS) {
    if (!grant[key]) continue;
    if (agg.keywords === NO_KEYWORDS) agg.keywords = {};
    (agg.keywords as Record<string, boolean>)[key] = true;
  }
}

/** The empty aggregate returned for a permanent with no active modifications. */
export const NO_MOD: AggregatedMod = Object.freeze({ power: 0, toughness: 0, keywords: NO_KEYWORDS });

/**
 * The index handed back when nothing on the board modifies anything. Shared and
 * empty so the overwhelmingly common case allocates zero — `ContinuousIndex` is a
 * ReadonlyMap precisely so this can be safely shared.
 */
const EMPTY_INDEX: ContinuousIndex = new Map<InstanceId, AggregatedMod>();

/**
 * Fold one attachment's grant onto its host's accumulator (layer 3).
 *
 * The host is addressed by id and NOT verified to still be on the battlefield: an
 * accumulator keyed on a dead id is simply never looked up, so the check would cost
 * a battlefield scan per attachment to prevent nothing. The state-based actions
 * (`internal/sba.ts`) are what clear a stale attachment, and they run at every point
 * a permanent can have just left play.
 */
function applyAttachment(map: Map<InstanceId, MutableMod>, attachment: CardInstance): void {
  const spec = attachment.def.attachment;
  if (spec === undefined) return;
  const mod = spec.modifies;
  if (mod === undefined || modificationIsInert(mod)) return;
  const agg = accumulatorFor(map, attachment.attachedTo as InstanceId);
  agg.power += mod.power ?? 0;
  agg.toughness += mod.toughness ?? 0;
  grantInto(agg, mod.keywords);
}

/** Get (creating if needed) the accumulator for one instance. */
function accumulatorFor(map: Map<InstanceId, MutableMod>, id: InstanceId): MutableMod {
  let agg = map.get(id);
  if (agg === undefined) {
    agg = { power: 0, toughness: 0, keywords: NO_KEYWORDS };
    map.set(id, agg);
  }
  return agg;
}

/**
 * Build the per-instance aggregation map covering BOTH lifetimes — the statics
 * radiating from permanents on the battlefield and the active until-end-of-turn
 * effects. Call once before a batch of stat reads (combat, SBAs, legality,
 * serialization) and look each permanent up in O(1).
 *
 * Cost: O(battlefield) to discover statics — one property check per permanent — then
 * an immediate shared-empty return when there are none and no temporary effects
 * either, so a board without anthems allocates nothing at all. When statics ARE
 * present it is O(sources × abilities × battlefield) filter checks, with the source
 * and ability hoisted out of the inner loop and inert abilities skipped once rather
 * than per candidate.
 */
export function indexContinuous(state: GameState): ContinuousIndex {
  // Discovery is INLINE rather than in a helper returning `{ statics, attachments }`.
  // That helper read beautifully and allocated one object on every call — and this
  // function runs several times per action across combat, SBAs, legality and
  // serialization, so it was a measurable step backwards on the sim's hot path for
  // a board that has neither an anthem nor an attachment.
  let sources: CardInstance[] | null = null;
  let attachments: CardInstance[] | null = null;
  const permanents = state.battlefield;
  for (let i = 0; i < permanents.length; i++) {
    const perm = permanents[i] as CardInstance;
    const declared = perm.def.statics;
    if (declared !== undefined && declared.length > 0) (sources ??= []).push(perm);
    // `!= null` rather than `!== null` on purpose: an instance built by code that
    // predates this field (an older serialized state, an untyped test literal)
    // then reads as UNATTACHED instead of as an attachment with an undefined
    // host, which would corrupt the whole layering pass. One comparison either way.
    if (perm.attachedTo != null) (attachments ??= []).push(perm);
  }
  if (sources === null && attachments === null && state.continuous.length === 0) return EMPTY_INDEX;

  const map = new Map<InstanceId, MutableMod>();
  // Layer 3a — attachments. An attachment is a static whose "filter" is a single
  // named permanent, so it needs no battlefield scan at all: O(attachments), not
  // O(attachments x battlefield).
  if (attachments !== null) {
    for (const attachment of attachments) applyAttachment(map, attachment);
  }
  // Layer 3b — statics. The SOURCE ability is the outer loop, deliberately: it hoists
  // the inert check, the ability lookup and the deltas out of the per-candidate loop,
  // so the inner body is one filter test plus (only on a match) the accumulator. The
  // candidate-outer arrangement reads more naturally but re-runs those lookups once
  // per permanent per ability and measured ~2x slower on a full board.
  if (sources !== null) {
    const battlefield = state.battlefield;
    for (const source of sources) {
      for (const ability of staticsOf(source.def)) {
        if (staticIsInert(ability)) continue;
        const power = ability.power ?? 0;
        const toughness = ability.toughness ?? 0;
        const keywords = ability.keywords;
        for (const candidate of battlefield) {
          if (!staticAppliesTo(ability, source, candidate)) continue;
          const agg = accumulatorFor(map, candidate.instanceId);
          agg.power += power;
          agg.toughness += toughness;
          if (keywords !== undefined) grantInto(agg, keywords);
        }
      }
    }
  }
  // Layer 4 — until-end-of-turn effects, folded onto the same accumulators.
  for (const eff of state.continuous) {
    const agg = accumulatorFor(map, eff.targetInstanceId);
    agg.power += eff.power ?? 0;
    agg.toughness += eff.toughness ?? 0;
    grantInto(agg, eff.keywords);
  }
  return map;
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
  const agg: MutableMod = { power: 0, toughness: 0, keywords: NO_KEYWORDS };
  let any = false;

  // Layer 3 — statics and attachments. Find the permanent once, then test each live
  // modifier against it in the SAME battlefield walk.
  const target = findPermanent(state, instanceId);
  if (target !== undefined) {
    for (const source of state.battlefield) {
      if (source.attachedTo === instanceId) {
        const spec = source.def.attachment;
        const mod = spec?.modifies;
        if (mod !== undefined && !modificationIsInert(mod)) {
          any = true;
          agg.power += mod.power ?? 0;
          agg.toughness += mod.toughness ?? 0;
          grantInto(agg, mod.keywords);
        }
      }
      const declared = source.def.statics;
      if (declared === undefined || declared.length === 0) continue;
      for (const ability of declared) {
        if (staticIsInert(ability) || !staticAppliesTo(ability, source, target)) continue;
        any = true;
        agg.power += ability.power ?? 0;
        agg.toughness += ability.toughness ?? 0;
        grantInto(agg, ability.keywords);
      }
    }
  }
  // Layer 4 — until-end-of-turn effects aimed at this instance.
  for (const eff of state.continuous) {
    if (eff.targetInstanceId !== instanceId) continue;
    any = true;
    agg.power += eff.power ?? 0;
    agg.toughness += eff.toughness ?? 0;
    grantInto(agg, eff.keywords);
  }

  return any ? agg : NO_MOD;
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
