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
 *
 * ## ATTRIBUTION LIVES IN `../provenance.ts`, NOT HERE — deliberately
 * The fold keeps the SUM and drops the story, and "which enchantment supplied that
 * +1/+1?" is answered by a second, lazy walk over these same sources
 * (`explainCharacteristics`). Nothing about attribution may move into this file: an
 * extra optional key on {@link AggregatedMod} changes the hidden class of an object
 * read from 20+ call sites several times per action, and an options parameter on
 * {@link indexContinuous} would fork `ContinuousIndex` into two kinds, one of which
 * silently lacks attribution. The two walks are held in agreement by a
 * reconciliation inside `provenance.ts` and by `provenance.test.ts`, which is rule
 * 12's sanctioned answer for an unavoidable second copy.
 */

import type { CardInstance, GameState, InstanceId, PlayerId } from '../state.js';
import type { ActivatedAbility, BooleanKeywordName, KeywordFlags } from '../card.js';
import { unionProtection } from '../card.js';
import { effectivePower, effectiveToughness, intersectBlockRestrictions } from './stats.js';
import { COMBAT_FAMILY_PAYLOAD_KEYS, mergeCombatFamilyPayload } from './stats.js';
import type { GameEvent } from '../events.js';
import type { StaticAbility } from '../statics.js';
import { modificationIsInert, staticAppliesTo, staticIsInert, staticsOf } from '../statics.js';
import { characteristicValue } from '../derived.js';
import { markControlChange } from '../upkeep-costs.js';

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
  /**
   * Set when this effect took control of its target, recording who had it
   * before so expiry can hand it back. See {@link applyControlChange}.
   */
  readonly controlChange?: ControlChange;
}

/** Who controlled a permanent before an effect took it, and who took it. */
export interface ControlChange {
  readonly instanceId: InstanceId;
  readonly from: PlayerId;
  readonly to: PlayerId;
}

/** The aggregated continuous modification for one permanent. */
export interface AggregatedMod {
  readonly power: number;
  readonly toughness: number;
  readonly keywords: KeywordFlags;
  /**
   * ACTIVATED abilities granted by continuous effects (an Aura's quoted
   * ability, "All Slivers have …"). Absent when nothing granted one, which is
   * every permanent on almost every board — read through `effectiveActivated`.
   */
  readonly activated?: readonly ActivatedAbility[];
  /**
   * CR 613.4 LAYER 7a — a characteristic-defining P/T, computed from the live
   * state for a permanent whose definition carries `characteristicPT`
   * (Tarmogoyf's star-power box). Present ONLY for such a permanent; absent means
   * "use the printed numbers".
   *
   * It is a BASE, not a delta, which is what makes the layering right: the stat
   * accessors use it in place of `def.power`, so counters (layer 7d) and pumps
   * (7c) add ON TOP of it, never the other way round. A Tarmogoyf with a +1/+1
   * counter is (types)+1 / (types)+2, and it re-derives on every read — so a
   * fetchland cracking mid-combat grows it before state-based actions run.
   */
  readonly basePower?: number;
  readonly baseToughness?: number;
}

/** A precomputed lookup from instance id to its aggregated continuous mod. */
export type ContinuousIndex = ReadonlyMap<InstanceId, AggregatedMod>;

/**
 * The BOOLEAN keyword flags, in canonical order, that a grant can set.
 *
 * This list used to stop at the ten combat keywords, which silently dropped a
 * granted hexproof/shroud/menace/unblockable/flash — the exact grants
 * `targeting.ts` documents as working. The full boolean set is here now; the
 * three non-boolean keywords (`protectionFrom`, `ward`, `minBlockers`) carry
 * payloads and are folded by their own merge rules in {@link grantInto}.
 *
 * ⚠️ ADDING A BOOLEAN FLAG TO `KeywordFlags` AND NOT TO THIS LIST used to be a
 * silent, one-directional bug: the printed keyword worked and every GRANT of it
 * did nothing. It ate a granted hexproof once and a granted indestructible once,
 * found both times only because someone happened to write the test.
 *
 * It cannot happen a third time: {@link KEYWORD_LIST_IS_EXHAUSTIVE} below is a
 * compile-time proof that this list and the boolean half of `KeywordFlags` are
 * the SAME set, in both directions. Add a boolean flag and this file stops
 * type-checking until it is listed here — the same default-deny shape the sim's
 * `OBSERVATION_POLICY` and `paired-arms-config` use, and for the same reason: a
 * new thing must not default into the safe-looking bucket.
 */
const KEYWORD_KEYS = [
  'flying',
  'horsemanship',
  'vigilance',
  'haste',
  'firstStrike',
  'doubleStrike',
  'deathtouch',
  'trample',
  'reach',
  'defender',
  'lifelink',
  'flash',
  'hexproof',
  'shroud',
  'menace',
  'unblockable',
  'cantBlock',
  'indestructible',
  'mustBeBlocked',
  'blockedByAllAble',
  // poison family (§3.105): both are plain flags; `toxic` carries a number
  // and is folded by its own additive rule in `grantInto`.
  'infect',
  'wither',
  // The combat keyword family's BOOLEAN flags (DESIGN §3.107). Its four
  // payload fields are folded by `mergeCombatFamilyPayload` in `grantInto`.
  'shadow',
  'flanking',
  'splitSecond',
  'myriad',
  'mustAttack',
] as const;

/**
 * The boolean-valued keys of `KeywordFlags`. The FOUR payload keywords
 * (`protectionFrom`, `ward`, `minBlockers`, `blockRestriction`) are excluded BY
 * TYPE rather than by memory: they are folded by their own merge rules in
 * {@link grantInto}, since "set it to true" is not what granting one of them
 * means.
 *
 * Imported from `card.ts` rather than restated here, so the interface and this
 * proof cannot be edited apart.
 */
type BooleanKeywordKey = BooleanKeywordName;

/**
 * COMPILE-TIME PROOF that {@link KEYWORD_KEYS} is exactly the boolean keyword
 * set — checked by `tsc` on every build, in BOTH directions:
 *  - a boolean flag missing from the list would make grants of it do nothing;
 *  - a listed key that is not a boolean flag would be dead weight, or a typo.
 * Either mistake makes this initialiser fail to compile.
 */
type KeywordListIsExhaustive =
  Exclude<BooleanKeywordKey, (typeof KEYWORD_KEYS)[number]> extends never
    ? Exclude<(typeof KEYWORD_KEYS)[number], BooleanKeywordKey> extends never
      ? true
      : never
    : never;

/** The witness. If the two sets ever diverge, this line stops type-checking. */
export const KEYWORD_LIST_IS_EXHAUSTIVE: KeywordListIsExhaustive = true;

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
  activated?: ActivatedAbility[];
  basePower?: number;
  baseToughness?: number;
}

/**
 * The keyword object an accumulator starts with. Shared and frozen: the vast
 * majority of modifications are P/T-only, so allocating a fresh `{}` per affected
 * creature was pure waste. {@link grantInto} replaces it with a real object the
 * first time a keyword is actually granted (copy-on-write).
 */
const NO_KEYWORDS: KeywordFlags = Object.freeze({});

/**
 * Fold granted ACTIVATED abilities into an accumulator. Allocated lazily, like
 * the keyword object: almost no permanent is ever granted one.
 */
function grantActivatedInto(agg: MutableMod, granted: readonly ActivatedAbility[] | undefined): void {
  if (!granted || granted.length === 0) return;
  (agg.activated ??= []).push(...granted);
}

/** Fold one keyword grant into an accumulator, allocating only if something is set. */
function grantInto(agg: MutableMod, grant: KeywordFlags | undefined): void {
  if (!grant) return;
  for (const key of KEYWORD_KEYS) {
    if (grant[key] !== true) continue;
    if (agg.keywords === NO_KEYWORDS) agg.keywords = {};
    (agg.keywords as Record<string, boolean>)[key] = true;
  }
  // The two payload keywords, merged by the same rules `effectiveKeywords`
  // applies when the aggregate meets the printed set: protections UNION, wards ADD.
  if (grant.protectionFrom !== undefined && grant.protectionFrom.length > 0) {
    if (agg.keywords === NO_KEYWORDS) agg.keywords = {};
    (agg.keywords as { protectionFrom?: KeywordFlags['protectionFrom'] }).protectionFrom =
      unionProtection(agg.keywords.protectionFrom, grant.protectionFrom);
  }
  if (typeof grant.ward === 'number' && grant.ward > 0) {
    if (agg.keywords === NO_KEYWORDS) agg.keywords = {};
    (agg.keywords as { ward?: number }).ward = (agg.keywords.ward ?? 0) + grant.ward;
  }
  // poison family (§3.105): toxic values ADD — "total toxic value" is the sum of
  // every instance (CR 702.164b), the same fold `mergeKeywordGrant` applies.
  if (typeof grant.toxic === 'number' && grant.toxic > 0) {
    if (agg.keywords === NO_KEYWORDS) agg.keywords = {};
    (agg.keywords as { toxic?: number }).toxic = (agg.keywords.toxic ?? 0) + grant.toxic;
  }
  // `minBlockers` takes the MAXIMUM, matching `mergeKeywordGrant`: two blocking
  // requirements are both in force, so the stricter one decides. Summing them
  // would invent a restriction neither source printed.
  if (typeof grant.minBlockers === 'number' && grant.minBlockers > 0) {
    if (agg.keywords === NO_KEYWORDS) agg.keywords = {};
    (agg.keywords as { minBlockers?: number }).minBlockers = Math.max(
      agg.keywords.minBlockers ?? 0,
      grant.minBlockers,
    );
  }
  // The fourth payload: a comparing block restriction. Merged field by field to
  // the STRICTEST of each, through the same function `mergeKeywordGrant` uses, so
  // a granted "except by creatures with haste" and a printed "power 2 or less"
  // are both in force rather than one replacing the other.
  if (grant.blockRestriction !== undefined) {
    if (agg.keywords === NO_KEYWORDS) agg.keywords = {};
    const merged = intersectBlockRestrictions(agg.keywords.blockRestriction, grant.blockRestriction);
    if (merged !== undefined) {
      (agg.keywords as { blockRestriction?: KeywordFlags['blockRestriction'] }).blockRestriction = merged;
    }
  }
  // The combat keyword family's payloads (DESIGN §3.107) — landwalk lists,
  // attack restrictions, a blocker cap, a "can block only" list — each by the
  // ONE rule `mergeKeywordGrant` also applies, so a granted landwalk and a
  // printed one fold the same way on both paths.
  for (const key of COMBAT_FAMILY_PAYLOAD_KEYS) {
    const value = grant[key];
    if (value === undefined) continue;
    const merged = mergeCombatFamilyPayload(key, agg.keywords, value);
    if (merged === undefined) continue;
    if (agg.keywords === NO_KEYWORDS) agg.keywords = {};
    (agg.keywords as Record<string, unknown>)[key] = merged;
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
  grantActivatedInto(agg, mod.activated);
}

/**
 * Append the objects in one zone that declare static abilities to `sources`,
 * allocating the list only if there is something to put in it. Hoisted to module
 * scope rather than written inline so the hot path does not re-create a closure
 * per call.
 */
function collectStaticSources(
  zone: readonly CardInstance[],
  sources: CardInstance[] | null,
): CardInstance[] | null {
  let out = sources;
  for (let i = 0; i < zone.length; i++) {
    const object = zone[i] as CardInstance;
    const declared = object.def.statics;
    if (declared !== undefined && declared.length > 0) (out ??= []).push(object);
  }
  return out;
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
  // Permanents whose P/T is a FORMULA (layer 7a). Collected in the same single
  // pass as statics and attachments, so a board with none pays one extra
  // property read per permanent and allocates nothing.
  let characteristic: CardInstance[] | null = null;
  const permanents = state.battlefield;
  // EMBLEMS radiate statics from the COMMAND zone (CR 114): "creatures you
  // control get +1/+1 as long as this emblem exists" is the SAME continuous
  // modification an anthem applies from the battlefield, differing only in where
  // its source sits and in the fact that nothing can ever remove it. So it folds
  // into this one pass instead of getting a layer of its own — which is also
  // what makes an emblem's buff survive a board wipe with no special case.
  //
  // PERFORMANCE: read directly rather than through `for (const pid of
  // PLAYER_IDS)`, which allocates an array iterator per call for a two-element
  // list — and this function runs several times per action across combat, SBAs,
  // legality and serialization. The `.length === 0` guard means a game that
  // never made an emblem (all of them, today) pays two integer comparisons.
  const commandA = state.players.A.command;
  if (commandA.length > 0) sources = collectStaticSources(commandA, sources);
  const commandB = state.players.B.command;
  if (commandB.length > 0) sources = collectStaticSources(commandB, sources);
  for (let i = 0; i < permanents.length; i++) {
    const perm = permanents[i] as CardInstance;
    const declared = perm.def.statics;
    if (declared !== undefined && declared.length > 0) (sources ??= []).push(perm);
    if (perm.def.characteristicPT !== undefined) (characteristic ??= []).push(perm);
    // `!= null` rather than `!== null` on purpose: an instance built by code that
    // predates this field (an older serialized state, an untyped test literal)
    // then reads as UNATTACHED instead of as an attachment with an undefined
    // host, which would corrupt the whole layering pass. One comparison either way.
    if (perm.attachedTo != null) (attachments ??= []).push(perm);
  }
  if (sources === null && attachments === null && characteristic === null && state.continuous.length === 0) {
    return EMPTY_INDEX;
  }

  const map = new Map<InstanceId, MutableMod>();
  // Statics whose FILTER reads effective P/T, held back until every P/T layer
  // has been folded (see the layer-3b loop below).
  let deferred: { ability: StaticAbility; source: CardInstance }[] | null = null;
  // Layer 7a FIRST — a characteristic-defining base is what the other layers
  // then modify. (Arithmetically the folds commute, so the order is about the
  // model being honest rather than about the number, and it is the order that
  // stays correct if a value-SETTING effect is ever added.)
  if (characteristic !== null) {
    for (const perm of characteristic) {
      const formula = perm.def.characteristicPT as NonNullable<CardInstance['def']['characteristicPT']>;
      const agg = accumulatorFor(map, perm.instanceId);
      agg.basePower = characteristicValue(state, formula.power, perm.controller);
      agg.baseToughness = characteristicValue(state, formula.toughness, perm.controller);
    }
  }
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
        // A selector that reads EFFECTIVE P/T cannot be answered yet — the
        // numbers it reads are what this very pass is computing. Deferred to
        // the settled-P/T pass below, which is exact because such a static may
        // grant keywords only (see `StaticAffects.maxEffectivePower`).
        if (readsEffectiveStats(ability.affects)) {
          (deferred ??= []).push({ ability, source });
          continue;
        }
        const power = ability.power ?? 0;
        const toughness = ability.toughness ?? 0;
        const keywords = ability.keywords;
        for (const candidate of battlefield) {
          if (!staticAppliesTo(ability, source, candidate)) continue;
          const agg = accumulatorFor(map, candidate.instanceId);
          agg.power += power;
          agg.toughness += toughness;
          if (keywords !== undefined) grantInto(agg, keywords);
          grantActivatedInto(agg, ability.activated);
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
  // The SETTLED-P/T pass: statics whose selector reads a creature's effective
  // power or toughness ("creatures you control with power 2 or less can't be
  // blocked"). Every P/T layer above has finished, so the numbers these read
  // are final — and because such a static may grant KEYWORDS ONLY, nothing it
  // writes can feed back into a number anything else read. A P/T delta on one
  // of these is dropped rather than applied out of layer order: the compiler
  // never emits it, and applying it would silently reorder the layers.
  if (deferred !== null) {
    const battlefield = state.battlefield;
    for (const { ability, source } of deferred) {
      const keywords = ability.keywords;
      if (keywords === undefined) continue;
      for (const candidate of battlefield) {
        if (!staticAppliesTo(ability, source, candidate)) continue;
        if (!withinEffectiveBounds(ability.affects, candidate, map.get(candidate.instanceId))) continue;
        grantInto(accumulatorFor(map, candidate.instanceId), keywords);
      }
    }
  }
  return map;
}

/**
 * Whether ANY continuous modification could be in force on this board right now
 * — the cheap gate a caller uses before deciding whether it has to build the
 * index at all.
 *
 * ⚠️ **`state.continuous.length === 0` is NOT that gate, and using it as one is a
 * shipped-bug shape.** That list holds only layer-4 "until end of turn" effects.
 * Layer 3 — an Aura or Equipment's grant to its host, an anthem-style static, an
 * emblem radiating from the command zone — is DERIVED from the battlefield and the
 * command zones on every read and puts nothing in that list at all (see the
 * `statics.ts` "lifetime is derived" note). So a fast path keyed on it silently
 * answers "printed keywords only" on exactly the boards where an equipped,
 * enchanted or anthem'd creature is standing there wearing a granted keyword. That
 * is how a real pool card (Mask of Avacyn — "equipped creature … has hexproof")
 * stayed targetable by an opponent's burn.
 *
 * Cost: short-circuits on the first modifying source, and on a board with none it
 * is one or two property reads per permanent with NO allocation — the same shape,
 * and the same reason, as `internal/sba.ts`'s `collectAttachments`.
 */
/**
 * Whether ANY source on this board could grant an ACTIVATED ability — the cheap
 * gate the ability-offer loop asks before building a continuous index at all.
 *
 * Almost no board has one, and the loop runs for every action of every game, so
 * the ordinary case must cost a few property reads and allocate nothing. Same
 * shape, and the same reason, as {@link anyContinuousModification}.
 */
export function anyGrantedAbilities(state: GameState): boolean {
  const battlefield = state.battlefield;
  for (let i = 0; i < battlefield.length; i++) {
    const perm = battlefield[i] as CardInstance;
    const statics = perm.def.statics;
    if (statics !== undefined) {
      for (let s2 = 0; s2 < statics.length; s2++) {
        if ((statics[s2] as { activated?: unknown }).activated !== undefined) return true;
      }
    }
    if (perm.attachedTo != null && perm.def.attachment?.modifies?.activated !== undefined) return true;
  }
  return false;
}

export function anyContinuousModification(state: GameState): boolean {
  if (state.continuous.length > 0) return true;
  if (state.players.A.command.length > 0 || state.players.B.command.length > 0) return true;
  const battlefield = state.battlefield;
  for (let i = 0; i < battlefield.length; i++) {
    const perm = battlefield[i] as CardInstance;
    const declared = perm.def.statics;
    if (declared !== undefined && declared.length > 0) return true;
    // `!= null` for the same reason `indexContinuous` uses it: an instance built
    // before this field existed must read as unattached, not as an attachment
    // with an undefined host.
    if (perm.attachedTo != null) return true;
  }
  return false;
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
  // What the static folds reported, as {@link FOLD_APPLIED} / {@link FOLD_DEFERRED}.
  let folded = 0;

  // Layer 3 — statics and attachments. Find the permanent once, then test each live
  // modifier against it in the SAME battlefield walk.
  const target = findPermanent(state, instanceId);
  if (target !== undefined) {
    // Layer 7a — the formula base, before anything modifies it.
    const formula = target.def.characteristicPT;
    if (formula !== undefined) {
      any = true;
      agg.basePower = characteristicValue(state, formula.power, target.controller);
      agg.baseToughness = characteristicValue(state, formula.toughness, target.controller);
    }
    for (const source of state.battlefield) {
      if (source.attachedTo === instanceId) {
        const spec = source.def.attachment;
        const mod = spec?.modifies;
        if (mod !== undefined && !modificationIsInert(mod)) {
          any = true;
          agg.power += mod.power ?? 0;
          agg.toughness += mod.toughness ?? 0;
          grantInto(agg, mod.keywords);
          // An Aura's QUOTED ability ("Enchanted creature has '{T}: Add {C}'") is
          // part of the same modification, and omitting it here made this path
          // disagree with `indexContinuous` about how many abilities a permanent
          // has — which is a wrong ANSWER, not a missing feature: the engine
          // OFFERS abilities through the bulk index and APPLIES the chosen one
          // through this function by the same integer index, so a granted ability
          // was offered and then resolved to `undefined`.
          grantActivatedInto(agg, mod.activated);
        }
      }
      const declared = source.def.statics;
      if (declared !== undefined && declared.length > 0) {
        folded |= foldStaticsOf(declared, source, target, agg);
      }
    }
    // EMBLEMS radiate from the COMMAND zone, and this single-instance path has to
    // agree with `indexContinuous` about that or the same board would report two
    // different power values depending on which accessor a caller happened to
    // reach for. (It did, once: wiring only the bulk path made an emblem's anthem
    // real in combat and invisible to a one-off read — caught by a test before it
    // shipped, which is the only reason this comment is not a bug report.)
    //
    // Same direct-read guard as the bulk path: no iterator for a two-element list.
    const commandA = state.players.A.command;
    if (commandA.length > 0) folded |= foldCommandStatics(commandA, target, agg);
    const commandB = state.players.B.command;
    if (commandB.length > 0) folded |= foldCommandStatics(commandB, target, agg);
    if ((folded & FOLD_APPLIED) !== 0) any = true;
  }
  // Layer 4 — until-end-of-turn effects aimed at this instance.
  for (const eff of state.continuous) {
    if (eff.targetInstanceId !== instanceId) continue;
    any = true;
    agg.power += eff.power ?? 0;
    agg.toughness += eff.toughness ?? 0;
    grantInto(agg, eff.keywords);
  }
  // The SETTLED-P/T pass, the single-instance twin of the one in `indexContinuous`
  // and for the same reason: a selector reading effective power/toughness cannot be
  // answered until every P/T layer above has finished. Without it this path granted
  // Tetsuko Umezawa's evasion to a creature an anthem had already lifted OUT of
  // "power or toughness 1 or less" — true in a one-off read, false in combat.
  //
  // Gated on a FLAG rather than a collected list: the deferred statics are re-found
  // by re-walking, which costs a second scan only on the boards that actually carry
  // such a card (one in the whole pool today) and allocates nothing on the ones that
  // do not. Measured ~2x FASTER than the old code on such a board, because the old
  // code granted the keyword unconditionally and paid for the copy-on-write keyword
  // object every call.
  if (target !== undefined && (folded & FOLD_DEFERRED) !== 0) {
    if (foldDeferredStatics(state.battlefield, target, agg)) any = true;
    const commandA = state.players.A.command;
    if (commandA.length > 0 && foldDeferredStatics(commandA, target, agg)) any = true;
    const commandB = state.players.B.command;
    if (commandB.length > 0 && foldDeferredStatics(commandB, target, agg)) any = true;
  }

  return any ? agg : NO_MOD;
}

/** {@link foldStaticsOf} folded at least one modification onto the accumulator. */
const FOLD_APPLIED = 1;
/** {@link foldStaticsOf} met a static whose selector reads effective P/T. */
const FOLD_DEFERRED = 2;

/**
 * Fold every static ONE source radiates onto ONE target's accumulator, holding back
 * the ones whose selector reads effective P/T for the settled pass.
 *
 * The ONE funnel for "what does this source do to this permanent" on the
 * single-instance path — the battlefield walk and the command zones both go through
 * it. They used to be two copies of the same loop, and the copies are why BOTH of
 * them were missing the granted-activated fold and the effective-P/T deferral: a
 * second copy answers the same question differently the moment one of them is
 * edited (rule 12).
 *
 * Returns a BITFIELD of {@link FOLD_APPLIED} / {@link FOLD_DEFERRED} rather than an
 * object or two out-parameters, because it runs inside a per-source loop and an
 * allocation there is paid on every call of every stat read.
 *
 * PERFORMANCE: the caller passes `declared` and is responsible for the "this object
 * declares no statics" early-out, which is the overwhelmingly common case. Making
 * this function do that check itself cost 12% on an emblem board, measured — the
 * permanent with nothing to say was paying for a call.
 */
function foldStaticsOf(
  declared: readonly StaticAbility[],
  source: CardInstance,
  target: CardInstance,
  agg: MutableMod,
): number {
  let result = 0;
  for (const ability of declared) {
    if (staticIsInert(ability) || !staticAppliesTo(ability, source, target)) continue;
    if (readsEffectiveStats(ability.affects)) {
      result |= FOLD_DEFERRED;
      continue;
    }
    agg.power += ability.power ?? 0;
    agg.toughness += ability.toughness ?? 0;
    grantInto(agg, ability.keywords);
    grantActivatedInto(agg, ability.activated);
    result |= FOLD_APPLIED;
  }
  return result;
}

/**
 * Fold every static a command zone's objects (emblems) radiate onto ONE target's
 * accumulator. The single-instance twin of {@link collectStaticSources}.
 */
function foldCommandStatics(
  zone: readonly CardInstance[],
  target: CardInstance,
  agg: MutableMod,
): number {
  let result = 0;
  for (let i = 0; i < zone.length; i++) {
    const source = zone[i] as CardInstance;
    const declared = source.def.statics;
    if (declared === undefined || declared.length === 0) continue;
    result |= foldStaticsOf(declared, source, target, agg);
  }
  return result;
}

/**
 * The settled-P/T pass for the single-instance path: statics whose selector reads a
 * creature's effective power or toughness, folded once every P/T layer has finished.
 * KEYWORDS ONLY — such a static may not carry a P/T delta (the compiler never emits
 * one), and applying one here would silently reorder the layers. Returns whether
 * anything applied.
 */
function foldDeferredStatics(
  zone: readonly CardInstance[],
  target: CardInstance,
  agg: MutableMod,
): boolean {
  let applied = false;
  for (let i = 0; i < zone.length; i++) {
    const source = zone[i] as CardInstance;
    const declared = source.def.statics;
    if (declared === undefined || declared.length === 0) continue;
    for (const ability of declared) {
      if (!readsEffectiveStats(ability.affects)) continue;
      const keywords = ability.keywords;
      if (keywords === undefined) continue;
      if (staticIsInert(ability) || !staticAppliesTo(ability, source, target)) continue;
      if (!withinEffectiveBounds(ability.affects, target, agg)) continue;
      grantInto(agg, keywords);
      applied = true;
    }
  }
  return applied;
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
 * Move a permanent to the effect source's controller, returning the record that
 * lets expiry hand it back. Returns `undefined` when there is nothing to do.
 *
 * WHY THIS MUTATES `CardInstance.controller` INSTEAD OF BEING A LAYERED READ.
 * Every other continuous modification (P/T, keywords) is applied by *reading*
 * through `indexContinuous`, and control could have worked the same way — an
 * `effectiveController()` that callers consult. It does not, deliberately:
 * `.controller` is read in ~55 places across combat, priority, targeting,
 * triggers, statics and attachments, and an accessor is only correct once EVERY
 * one of them is converted. A partial conversion is the worst outcome — a
 * creature that changes sides for targeting but still attacks for its old
 * controller — and it fails silently. Writing the base field makes all 55 reads
 * correct at once, with the revert being the only new thing that can go wrong,
 * and it is covered by tests here.
 *
 * The limitation this accepts: control is not layered, so it cannot interact
 * with dependency ordering the way MTG's layer 2 formally does. With two
 * players and no card in the pool changing control of a control-change, that
 * distinction has no observable effect.
 *
 * Rule 302.6 is honoured on the way in: a creature that just changed hands is
 * summoning-sick for its new controller, so a stolen creature cannot attack
 * unless the effect also grants haste (which is exactly what the printed
 * "gain control … untap it, it gains haste" cards do).
 */
export function applyControlChange(
  state: GameState,
  targetInstanceId: InstanceId,
  sourceInstanceId: InstanceId,
  emit: (e: GameEvent) => void,
  stealer?: PlayerId,
): ControlChange | undefined {
  const permanent = state.battlefield.find((c) => c.instanceId === targetInstanceId);
  if (!permanent) return undefined;
  const source = state.battlefield.find((c) => c.instanceId === sourceInstanceId);
  // The stealing player is the source's controller when the source is a
  // permanent — but the printed cards are overwhelmingly SPELLS (Act of
  // Treason), whose source is never on the battlefield while they resolve, so
  // the resolution passes the caster explicitly as `stealer`. With neither (a
  // ghost id and no stealer named) there is nobody to give the permanent to.
  const to = source?.controller ?? stealer;
  if (to === undefined || to === permanent.controller) return undefined;

  const from = permanent.controller;
  permanent.controller = to;
  permanent.summoningSick = true;
  // §3.106 — echo counts a control change as "came under your control" (CR 702.30a).
  markControlChange(state, permanent);
  emit({ type: 'controlChanged', instanceId: permanent.instanceId, from, to });
  return { instanceId: permanent.instanceId, from, to };
}

/**
 * Hand a permanent back when its control-change effect ends.
 *
 * Only reverts when the permanent is still on the battlefield AND still under
 * the controller this effect gave it to. If something else took control after
 * us, that later effect owns the revert and we must not stomp it; if the
 * permanent died or was exiled, there is nothing to hand back.
 */
function revertControlChange(
  state: GameState,
  change: ControlChange,
  emit: (e: GameEvent) => void,
): void {
  const permanent = state.battlefield.find((c) => c.instanceId === change.instanceId);
  if (!permanent || permanent.controller !== change.to) return;
  permanent.controller = change.from;
  permanent.summoningSick = true;
  // §3.106 — handed back is coming under the owner's control again, so echo is owed again.
  markControlChange(state, permanent);
  emit({ type: 'controlChanged', instanceId: permanent.instanceId, from: change.to, to: change.from });
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
  // Control changes unwind LIFO — see below.
  const expiringControlChanges: ControlChange[] = [];
  for (const eff of state.continuous) {
    if (eff.duration === duration) {
      removed += 1;
      if (eff.controlChange) expiringControlChanges.push(eff.controlChange);
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

  // Control changes unwind in REVERSE order of application — last stolen, first
  // returned. Reverting in insertion order strands the permanent with whoever
  // held it in the middle of a chain: if A steals from B and then B steals it
  // back, unwinding A first is a no-op (A no longer has it) and unwinding B then
  // hands it to A — leaving it with the wrong player, permanently. Unwinding
  // LIFO returns it through each hop and lands it back with its original
  // controller, which is what ending both effects at once should do.
  for (let i = expiringControlChanges.length - 1; i >= 0; i--) {
    revertControlChange(state, expiringControlChanges[i]!, emit);
  }
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

/**
 * Drop every floating continuous effect aimed at ONE instance, because the object
 * those effects were applying to has stopped existing (CR 400.7).
 *
 * The same job {@link pruneOrphanContinuousEffects} does by scanning, asked about
 * a single id instead — and it exists because that scan asks "is the id still on
 * the battlefield?", which a BLINK answers "yes" about a genuinely new object.
 * Without this a Giant Growth survives being blinked, and — the other direction —
 * a stolen creature's control-change effect survives too, so blinking it hands
 * the creature BACK at end of turn instead of keeping it.
 *
 * A dropped `controlChange` is deliberately never reverted: the effect ended
 * because its object is gone, and the returning permanent's controller is set by
 * whatever put it back (for a blink, the blinker — CR 400.7 again). That is
 * exactly what makes a blinked theft permanent.
 */
export function dropContinuousEffectsFor(state: GameState, instanceId: InstanceId): void {
  if (state.continuous.length === 0) return;
  if (!state.continuous.some((e) => e.targetInstanceId === instanceId)) return;
  state.continuous = state.continuous.filter((e) => e.targetInstanceId !== instanceId);
}

/**
 * Whether this filter reads a value the layer system itself produces.
 *
 * EXPORTED for `../provenance.ts`, which walks these same sources a second time to
 * attribute them. Restating the test there would give the "may grant keywords only,
 * and only within the settled bound" rule two answers, and the tooltip would then
 * show an anthem'd creature keeping an evasion the board had already taken away.
 */
export function readsEffectiveStats(affects: StaticAbility['affects']): boolean {
  return affects.maxEffectivePower !== undefined || affects.maxEffectivePowerOrToughness !== undefined;
}

/**
 * Whether `candidate` is within the filter's effective-P/T bounds, read off
 * the SETTLED accumulator (`mod`) rather than the printed box — an anthem
 * lifts a creature out of "power 2 or less", exactly as it does in paper.
 *
 * Takes an `AggregatedMod` rather than the internal `MutableMod`: a `MutableMod`
 * still satisfies it (mutable is assignable to readonly), and widening lets
 * `../provenance.ts` pass the finished aggregate instead of copying this rule.
 */
export function withinEffectiveBounds(
  affects: StaticAbility['affects'],
  candidate: CardInstance,
  mod: AggregatedMod | undefined,
): boolean {
  const settled = mod ?? NO_MOD;
  const max = affects.maxEffectivePower;
  if (max !== undefined && effectivePower(candidate, settled) > max) return false;
  const either = affects.maxEffectivePowerOrToughness;
  if (
    either !== undefined &&
    effectivePower(candidate, settled) > either &&
    effectiveToughness(candidate, settled) > either
  ) {
    return false;
  }
  return true;
}
