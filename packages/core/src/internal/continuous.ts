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

import type { CardInstance, GameState, InstanceId, PlayerId } from '../state.js';
import type { KeywordFlags } from '../card.js';
import { unionProtection } from '../card.js';
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
}

/** A precomputed lookup from instance id to its aggregated continuous mod. */
export type ContinuousIndex = ReadonlyMap<InstanceId, AggregatedMod>;

/**
 * The BOOLEAN keyword flags, in canonical order, that a grant can set.
 *
 * This list used to stop at the ten combat keywords, which silently dropped a
 * granted hexproof/shroud/menace/unblockable/flash — the exact grants
 * `targeting.ts` documents as working. The full boolean set is here now; the
 * two non-boolean keywords (`protectionFrom`, `ward`) carry payloads and are
 * folded by their own merge rules in {@link grantInto}.
 */
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
  'flash',
  'hexproof',
  'shroud',
  'menace',
  'unblockable',
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
    // EMBLEMS radiate from the COMMAND zone, and this single-instance path has to
    // agree with `indexContinuous` about that or the same board would report two
    // different power values depending on which accessor a caller happened to
    // reach for. (It did, once: wiring only the bulk path made an emblem's anthem
    // real in combat and invisible to a one-off read — caught by a test before it
    // shipped, which is the only reason this comment is not a bug report.)
    //
    // Same direct-read guard as the bulk path: no iterator for a two-element list.
    const commandA = state.players.A.command;
    if (commandA.length > 0) any = foldCommandStatics(commandA, target, agg) || any;
    const commandB = state.players.B.command;
    if (commandB.length > 0) any = foldCommandStatics(commandB, target, agg) || any;
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
 * Fold every static a command zone's objects (emblems) radiate onto ONE target's
 * accumulator. Returns whether anything applied. The single-instance twin of
 * {@link collectStaticSources}.
 */
function foldCommandStatics(
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
      if (staticIsInert(ability) || !staticAppliesTo(ability, source, target)) continue;
      applied = true;
      agg.power += ability.power ?? 0;
      agg.toughness += ability.toughness ?? 0;
      grantInto(agg, ability.keywords);
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
