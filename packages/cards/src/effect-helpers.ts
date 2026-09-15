/**
 * Shared internals for the effect primitives (`./primitives`, `./choice-primitives`).
 *
 * These are the small, card-agnostic building blocks every primitive reaches for:
 * typed param readers (so no tunable is ever an inline literal — DESIGN §1.1),
 * target classification, and the zone-movement funnels that keep `zoneChange`
 * eventing consistent no matter which primitive moved the card.
 *
 * They live here rather than inside one primitive module so that both halves of
 * the library (the plain primitives and the choice-driven ones) share exactly one
 * implementation of "move a card from a zone to a zone" — a second copy is how
 * two primitives quietly start disagreeing about what a zone change emits.
 */

import type {
  CardDefinition,
  CardFilter,
  CardInstance,
  EffectContext,
  GameState,
  InstanceId,
  KeywordFlags,
  ManaCost,
  PlayerId,
  DerivedCountName,
  DerivedCountScope,
  SpellStackObject,
  TargetRestriction,
} from '@jonny-boi/core';
import {
  aggregateFor,
  ceaseToExistIfToken,
  convertedManaCost,
  countPermanentsMatching,
  DEFAULT_TARGET_RESTRICTION,
  effectivePower,
  effectiveToughness,
  evaluateDerivedCount,
  entersTapped,
  isCreature,
  isPlayerTarget,
  isTargetRestriction,
  MANA_COLORS,
  markBattlefieldEntry,
  pruneCardGrantsFor,
  resetInstanceForNewZone,
  discardDestination,
  spellCanBeCountered,
  spellLeaveDestination,
  TARGET_RESTRICTION_PARAM,
} from '@jonny-boi/core';

// --- param reading (typed, defaulted — no magic numbers leak in) ---------------

/**
 * What a DERIVED numeric value counts — the "equal to the number of …" half of
 * a printed card.
 *
 * Deliberately a closed vocabulary rather than an arbitrary expression: each
 * entry is a countable set the engine can evaluate exactly, so a card either
 * names one of these or is reported unsupported. An open expression language
 * would let the compiler accept text it only approximately understands, which
 * is the one thing the whole compiler contract forbids.
 *
 * It is now core's `DerivedCountName`, re-exported under the name this package
 * has always used: characteristic-defining P/T (Tarmogoyf) counts the SAME sets
 * from the stat layer, and two vocabularies would let "cards in your graveyard"
 * mean one thing in a damage param and another in a P/T box.
 */
export type DerivedCount = DerivedCountName | typeof PERMANENTS_MATCHING;

/**
 * The one count name that carries its own SET as data instead of naming a
 * hand-written one (DESIGN §3.149) — "the number of **Mountains you control**",
 * "**artifacts they control**", "**Clerics on the battlefield**".
 *
 * Every other row of the vocabulary is a set written into core by hand, and the
 * printed cards ask for dozens of them. This row makes the next one a ROW IN
 * THE COMPILER'S PHRASE TABLE rather than a core change, evaluated by the one
 * `matchesCardFilter` every other filter consumer already uses — as closed as
 * the enum rows, because a printed noun the compiler cannot turn into a
 * `CardFilter` still reports.
 */
export const PERMANENTS_MATCHING = 'permanentsMatching';

/** A numeric param that is computed at resolution instead of printed. */
export interface DerivedValue {
  readonly countOf: DerivedCount;
  /**
   * The set counted, for {@link PERMANENTS_MATCHING} — absent (and ignored) for
   * every named row, whose set is core's.
   */
  readonly filter?: CardFilter;
  /** Whose permanents the filtered count reaches. Defaults to `'you'`. */
  readonly scope?: DerivedCountScope;
  /**
   * "+N/+N FOR EACH …" — the printed multiplier on a per-count value (rampage's
   * "+2/+2 for each creature blocking it beyond the first", DESIGN §3.107).
   * Absent means one per count, which is every derived value written before
   * this existed. A SCALING parameter on the one reader rather than a second
   * primitive, so damage, draws and pumps all learn "for each" at once.
   */
  readonly times?: number;
  /**
   * A printed CONSTANT added after the count is scaled — "where X is **3 plus**
   * the number of artifacts you control" (Welding Sparks), "the number of cards
   * in their hand **minus 4**" (Viseling), and with `times: -1` the reversed
   * "**3 minus** the number of cards in their hand" (Rackling).
   *
   * The same name and meaning as core's `CharacteristicFormula.plus`
   * ("that number plus 1" — Tarmogoyf's toughness), on purpose: one word for
   * one idea across the two places a derived value is offset.
   */
  readonly plus?: number;
  /**
   * A FLOOR applied last — `0` on every subtracting row, which is CR 107.1b:
   * a quantity that would be negative is zero. Absent means no floor, which is
   * what a PUMP needs ("gets -X/-X" is a negative modifier, not a negative
   * quantity), and that difference is why this is data rather than a rule
   * baked into the reader.
   */
  readonly min?: number;
}

/** Whether a param value is a derived-value descriptor. */
function isDerivedValue(value: unknown): value is DerivedValue {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { countOf?: unknown }).countOf === 'string'
  );
}

/**
 * A numeric param whose value is the X chosen when the spell was cast — how
 * "deals X damage" / "draw X cards" is authored. The value itself lives on the
 * resolution (`EffectContext.xValue`), charged by the engine at cast time; the
 * param only says "read it from there".
 */
export interface ChosenXValue {
  readonly chosenX: true;
  /**
   * The printed MULTIPLIER on the chosen value — `-1` for a minus-X slot
   * ("Target creature gets **-X/+X** until end of turn" — Belbe's Armor;
   * "**-0/-X**" — Drana), `2` for "twice X". Absent means one, which is every
   * X written before this existed.
   *
   * The same field and the same meaning as {@link DerivedValue.times}, on the
   * same reader ({@link intParam}), because "how is this variable amount
   * scaled" is ONE question: an X that could be negated and a count that could
   * not would be two vocabularies for one idea.
   */
  readonly times?: number;
}

/** The one param value meaning "the X chosen at cast time". */
export const CHOSEN_X: ChosenXValue = Object.freeze({ chosenX: true });

/** Whether a param value is the chosen-X descriptor. */
function isChosenX(value: unknown): value is ChosenXValue {
  return typeof value === 'object' && value !== null && (value as { chosenX?: unknown }).chosenX === true;
}

// --- object-characteristic amounts (DESIGN §3.149) ------------------------------
//
// The THIRD way a printed card spells a variable number, beside `{X}` and
// "equal to the number of …": a characteristic read off ONE OBJECT.
//
//   "you gain life equal to THAT CREATURE'S toughness"   (Trostani)
//   "{T}: Add an amount of {G} equal to ~'S POWER"        (Marwyn, Viridian Joiner)
//   "~ deals damage equal to ITS POWER to any target"     (Spikeshot Goblin)
//
// It is NOT a `DerivedCountName`: that vocabulary counts a SET relative to a
// PLAYER and is shared with characteristic-defining P/T, which must stay a
// board count (a `*` box reading another object's power would be a loop).
// This reads ONE object, so it is its own descriptor — and it is read at the
// SAME seam every other variable amount is ({@link intParam}), which is what
// makes damage, life, draws, tokens and mana all understand it in one edit.

/** WHICH object a characteristic is read off. */
export type ObjectCharacteristicSubject =
  /**
   * "THAT CREATURE" / "IT" — the object the triggering event was about, read
   * off `EffectContext.triggeringInstances`. The SAME word `subjectCreatures`
   * uses for the same referent, deliberately: one vocabulary, so a body that
   * pumps "that creature" and a body that counts its toughness cannot end up
   * pointing at different objects.
   */
  | 'triggering'
  /** "~'s power" — the permanent running the ability (Marwyn, Spikeshot Goblin). */
  | 'source';

/** WHICH characteristic. Closed, because each row is one the engine reads exactly. */
export type ObjectCharacteristic = 'power' | 'toughness' | 'manaValue';

/**
 * A numeric param read off one object's characteristic.
 *
 * ⚠️ **THE OBJECT MUST STILL BE ON THE BATTLEFIELD when this is read**, and
 * that is a COMPILE-TIME obligation, not a runtime one. A printed line whose
 * object has left — "When ~ **dies**, you gain life equal to its power",
 * "**Destroy** target creature. You lose life equal to that creature's
 * toughness", "equal to **the sacrificed** creature's power" — means CR 608.2h
 * last-known information, and this engine keeps no LKI snapshot of P/T. Those
 * cards therefore keep REPORTING; the compiler never emits this descriptor for
 * them (see `objectCharacteristicIsLive` in `compile/rules.ts`, and the test
 * that pins each family). The zero below is only the safe degradation for a
 * hand-authored ref (rule 6) — a direction that can never play better than
 * printed — never a licence to compile an LKI card into it.
 */
export interface ObjectCharacteristicValue {
  readonly readOf: ObjectCharacteristicSubject;
  readonly characteristic: ObjectCharacteristic;
}

/** The closed set of subjects, so a malformed hand-written ref is rejected rather than guessed. */
const OBJECT_CHARACTERISTIC_SUBJECTS: readonly string[] = Object.freeze(['triggering', 'source']);
/** The closed set of characteristics, same reason. */
const OBJECT_CHARACTERISTICS: readonly string[] = Object.freeze(['power', 'toughness', 'manaValue']);

/** Whether a param value is an object-characteristic descriptor. */
function isObjectCharacteristic(value: unknown): value is ObjectCharacteristicValue {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as { readOf?: unknown; characteristic?: unknown };
  return (
    typeof v.readOf === 'string' &&
    OBJECT_CHARACTERISTIC_SUBJECTS.includes(v.readOf) &&
    typeof v.characteristic === 'string' &&
    OBJECT_CHARACTERISTICS.includes(v.characteristic)
  );
}

/**
 * Read one object's characteristic RIGHT NOW.
 *
 * Power and toughness go through the same effective-stat readers combat and the
 * state-based actions use, so a +1/+1 counter, an equipment and an until-EOT
 * pump are all seen — "equal to that creature's toughness" on a creature wearing
 * a Bonesplitter is the number on the battlefield, not the number in the box.
 * Mana value is a property of the card itself and needs no layer.
 */
function objectCharacteristicValue(ctx: EffectContext, value: ObjectCharacteristicValue): number {
  const subject =
    value.readOf === 'triggering'
      ? triggeringPermanent(ctx)
      : permanentById(ctx.state, ctx.source.instanceId);
  // Gone from the battlefield ⇒ zero. See the type's warning: the compiler is
  // what guarantees no printed card relies on this branch.
  if (subject === undefined) return 0;
  // The ONE mana-value funnel in this package — a locally re-summed cost is how
  // hybrid pips were once dropped and Kitchen Finks priced at 1 (see `manaValueOf`).
  if (value.characteristic === 'manaValue') return manaValueOf(subject.def);
  const mod = aggregateFor(ctx.state, subject.instanceId);
  return value.characteristic === 'power' ? effectivePower(subject, mod) : effectiveToughness(subject, mod);
}

/** The single object the triggering event was about, if it is still a permanent. */
function triggeringPermanent(ctx: EffectContext): CardInstance | undefined {
  const ids = ctx.triggeringInstances;
  if (ids === undefined || ids.length !== 1) return undefined;
  return permanentById(ctx.state, ids[0]!);
}

/**
 * A numeric param with two printed values — the unkicked one and the kicked one
 * ("deals 2 damage… if this spell was kicked, it deals 4 damage instead").
 * Which one applies is decided by the cast-time kicked flag on the resolution,
 * so ONE primitive ref reproduces the whole "instead" sentence and the target
 * restriction stays on that single ref.
 */
export interface KickedSwitchValue {
  readonly base: number;
  readonly kicked: number;
}

/** Whether a param value is a base/kicked pair. */
function isKickedSwitch(value: unknown): value is KickedSwitchValue {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { base?: unknown }).base === 'number' &&
    typeof (value as { kicked?: unknown }).kicked === 'number'
  );
}

/**
 * Evaluate a derived count against the CURRENT state.
 *
 * "Current" matters: the value is computed when the effect resolves, not when
 * the spell was cast, which is what the printed cards mean and what makes a
 * sweeper-then-pump sequence behave correctly.
 *
 * Delegates to core's `evaluateDerivedCount` — the same function the stat layer
 * uses for a characteristic-defining P/T, so a count cannot mean two things.
 */
export function evaluateDerived(ctx: EffectContext, value: DerivedValue): number {
  // "For each" (DESIGN §3.107): the printed multiplier applies to whatever the
  // count below turns out to be. One multiplication here, so no branch below
  // has to remember it.
  const times = scaleOf(value.times);
  const scaled = times === 1 ? countOfDerived(ctx, value) : countOfDerived(ctx, value) * times;
  // The printed constant, then the printed floor — in that order, because
  // "3 minus the number of cards in their hand" is floored AFTER the subtraction
  // (CR 107.1b), not before it.
  const offset = typeof value.plus === 'number' && Number.isFinite(value.plus) ? Math.trunc(value.plus) : 0;
  const total = scaled + offset;
  return typeof value.min === 'number' && Number.isFinite(value.min) ? Math.max(Math.trunc(value.min), total) : total;
}

/**
 * The printed multiplier on a variable amount, defaulted and sanitised — the
 * ONE reader for `times`, shared by the derived counts and by `{X}` so the two
 * cannot disagree about what an absent or malformed multiplier means.
 */
function scaleOf(times: unknown): number {
  return typeof times === 'number' && Number.isFinite(times) ? Math.trunc(times) : 1;
}

/** The unscaled count behind a derived value — see {@link evaluateDerived}. */
function countOfDerived(ctx: EffectContext, value: DerivedValue): number {
  // Every count core can answer from the BOARD is answered by core, from the one
  // shared evaluator (so a spell's "equal to the number of X" and a `*` P/T box
  // count the identical set). The kick count is the single exception, and it has
  // to be: it is a fact about THIS RESOLUTION, which core's board-only evaluator
  // has no way to see.
  if (value.countOf === 'creaturesBlockingThisBeyondFirst') {
    // RAMPAGE (CR 702.23a/b, DESIGN §3.107): the creatures blocking the SOURCE
    // right now, minus the first — read as the trigger resolves, off the live
    // block map, which is what "calculated only once, when the triggered
    // ability resolves" means. No combat, or an unblocked source, is zero.
    const blocks = ctx.state.combat?.blocks;
    if (blocks === undefined) return 0;
    let blocking = 0;
    for (const blocker in blocks) {
      if (blocks[Number(blocker) as InstanceId] === ctx.source.instanceId) blocking += 1;
    }
    return Math.max(0, blocking - 1);
  }
  if (value.countOf === 'timesThisWasKicked') {
    // Two readings, and both are needed. DURING the spell's own resolution the
    // count rides the frame (`ctx.kickCount`, with a plain kicker counting as
    // one). AFTERWARDS — an enters-the-battlefield trigger on the permanent that
    // spell became — the frame is gone and the count lives on the instance
    // (`timesKicked`, written as it entered).
    return ctx.kickCount ?? (ctx.kicked === true ? 1 : (ctx.source.timesKicked ?? 0));
  }
  if (value.countOf === PERMANENTS_MATCHING) {
    // The set is DATA on the descriptor (§3.149). A ref with no filter would be
    // "every permanent", which no printed card means, so it counts nothing
    // rather than everything — the direction that cannot play better than
    // printed. The compiler never emits one.
    if (value.filter === undefined) return 0;
    return countPermanentsMatching(ctx.state, value.filter, value.scope ?? 'you', ctx.controller);
  }
  if (value.countOf === 'triggeringAmount') {
    // "That much" — the size of the event that set this trigger off, carried on
    // the resolution because the event itself is long gone by now. Absent means
    // this ref is running somewhere without a triggering event, and the honest
    // answer there is ZERO rather than a guess.
    return ctx.triggeringAmount ?? 0;
  }
  return evaluateDerivedCount(ctx.state, value.countOf, ctx.controller);
}

/**
 * Read a non-negative integer param by key, falling back to `fallback`.
 *
 * Accepts either a printed number or a {@link DerivedValue} descriptor. Putting
 * that here rather than in each primitive means EVERY numeric param in the
 * library — damage, cards drawn, life gained, mill depth, a pump's +X/+X —
 * understands "equal to the number of …" without a single primitive changing.
 */
export function intParam(ctx: EffectContext, key: string, fallback: number): number {
  const v = ctx.params[key];
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
  if (isDerivedValue(v)) return evaluateDerived(ctx, v);
  // "X" — the value chosen (and paid for) at cast time OR at activation time
  // (`ActivationCost.xCost`). An unchosen X reads 0, the direction that can
  // never play better than printed. `times` is the printed multiplier on the
  // slot, which is how a "-X" reaches a primitive that only adds.
  if (isChosenX(v)) return (ctx.xValue ?? 0) * scaleOf(v.times);
  // "…equal to that creature's toughness" / "…equal to ~'s power" — one
  // object's characteristic, read live. See {@link ObjectCharacteristicValue}.
  if (isObjectCharacteristic(v)) return objectCharacteristicValue(ctx, v);
  // "N… or M instead, if this spell was kicked" — one ref, both printed values.
  if (isKickedSwitch(v)) return ctx.kicked === true ? v.kicked : v.base;
  return fallback;
}

/** Read a string param by key, or `undefined` if absent/ill-typed. */
export function strParam(ctx: EffectContext, key: string): string | undefined {
  const v = ctx.params[key];
  return typeof v === 'string' ? v : undefined;
}

/** Read a boolean param by key, falling back to `fallback`. */
export function boolParam(ctx: EffectContext, key: string, fallback: boolean): boolean {
  const v = ctx.params[key];
  return typeof v === 'boolean' ? v : fallback;
}

/** Read a string-array param by key (e.g. token colors / produced mana / names). */
export function strArrayParam(ctx: EffectContext, key: string): readonly string[] {
  const v = ctx.params[key];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

/**
 * Read a `keywords` param (a `KeywordFlags`-shaped object, e.g. `{ trample: true }`)
 * into the flags a grant may set. A missing/ill-typed param yields an empty grant
 * (safe no-op).
 *
 * ⚠️ THE THREE PAYLOAD KEYWORDS ARE NOT BOOLEANS, and dropping them here is
 * silent. `protectionFrom` is a list of qualities, `ward` and `minBlockers` are
 * numbers — so a filter of `=== true` threw all three away and turned "target
 * creature gains protection from red until end of turn" into a spell that
 * compiled `'complete'` and did NOTHING at resolution. (The rule's test asserted
 * the compiled EFFECT REFS and never played the card, which is why it stayed
 * green.) Each is copied here with the same validity check `grantInto` in core's
 * continuous layer applies when it merges them, so the two cannot disagree about
 * what a real grant looks like.
 */
export function keywordsParam(ctx: EffectContext): KeywordFlags {
  const v = ctx.params.keywords;
  if (typeof v !== 'object' || v === null) return {};
  const src = v as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key in src) {
    if (src[key] === true) out[key] = true;
  }
  // The PAYLOAD keywords are not booleans, so the true-filter above drops them —
  // which is exactly how a granted ward, a granted "except by creatures with
  // haste", or a granted protection becomes a grant of NOTHING. Each is copied
  // through by its own shape test, and only when it carries something the engine
  // can act on, so a malformed param still yields an inert grant rather than a
  // half-read one.
  const protection = src.protectionFrom;
  if (Array.isArray(protection)) {
    const qualities = protection.filter((q): q is string => typeof q === 'string');
    if (qualities.length > 0) out.protectionFrom = qualities;
  }
  for (const numeric of NUMERIC_KEYWORD_KEYS) {
    const value = src[numeric];
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) out[numeric] = Math.trunc(value);
  }
  // The one payload that is a RECORD rather than a number or a list: a comparing
  // block restriction ("except by creatures with haste", a power bound, skulk).
  // It cannot join `NUMERIC_KEYWORD_KEYS` for the same reason `protectionFrom`
  // cannot — the shape test is what tells a real payload from a stray param.
  const blockRestriction = src.blockRestriction;
  if (typeof blockRestriction === 'object' && blockRestriction !== null) {
    out.blockRestriction = blockRestriction;
  }
  // The combat keyword family's LIST and RECORD payloads (DESIGN §3.107) —
  // landwalk, "can't attack unless …", "can block only …" — copied through by
  // shape exactly as the ones above are; `maxBlockers` is a row in
  // `NUMERIC_KEYWORD_KEYS`. Each is folded by core's `mergeCombatFamilyPayload`
  // when the grant meets the printed set.
  for (const listKey of LIST_KEYWORD_KEYS) {
    const value = src[listKey];
    if (Array.isArray(value) && value.length > 0) out[listKey] = value;
  }
  const blockOnly = src.blockOnly;
  if (typeof blockOnly === 'object' && blockOnly !== null) out.blockOnly = blockOnly;
  return out as KeywordFlags;
}

/**
 * The keyword flags whose value is a positive NUMBER rather than a boolean.
 * A table so adding one is a data edit here rather than another `if` above —
 * and so the omission that made this function drop them cannot recur silently.
 */
const NUMERIC_KEYWORD_KEYS: readonly string[] = Object.freeze(['ward', 'minBlockers', 'maxBlockers']);

/** The keyword flags whose value is a LIST of conditions (DESIGN §3.107). */
const LIST_KEYWORD_KEYS: readonly string[] = Object.freeze(['landwalk', 'cantAttackUnlessDefenderControls']);

/**
 * THE CREATURES A PRIMITIVE ACTS ON when it names no target (DESIGN §3.107).
 *
 * `params.subject: 'triggering'` means "the object(s) the triggering event was
 * about" — exalted's lone attacker, flanking's blocker — read off
 * `ctx.triggeringInstances`; anything else (the default, which is every effect
 * written before this existed) is the first chosen creature target, else the
 * source itself, exactly as `pumpUntilEndOfTurn` has always resolved it.
 *
 * Only creatures still on the battlefield are returned: a blocker that died in
 * response is not there to shrink, and a pump aimed at a graveyard is a no-op
 * by every other reading too.
 */
export function subjectCreatures(ctx: EffectContext): readonly CardInstance[] {
  if (strParam(ctx, 'subject') === 'triggering') {
    const ids = ctx.triggeringInstances;
    if (ids === undefined || ids.length === 0) return NO_CREATURES;
    const found: CardInstance[] = [];
    for (const id of ids) {
      const permanent = permanentById(ctx.state, id);
      if (permanent !== undefined && isCreature(permanent.def)) found.push(permanent);
    }
    return found;
  }
  const single = firstPermanentTarget(ctx) ?? selfIfCreature(ctx);
  return single !== undefined && isCreature(single.def) ? [single] : NO_CREATURES;
}

/** Shared empty answer, so the no-subject path allocates nothing. */
const NO_CREATURES: readonly CardInstance[] = Object.freeze([]);

/**
 * Read a `ManaCost`-shaped param (`{ generic: 3 }`, `{ generic: 1, U: 1 }`) — the
 * cost half of an "unless its controller pays {3}" rider.
 *
 * Only the numeric fields core can actually charge for are kept, and an ill-typed
 * or empty param yields `undefined` so the caller degrades to "no payment offered"
 * rather than charging a cost of nothing (which every player could "pay",
 * silently turning a counterspell into a blank).
 */
export function manaCostParam(ctx: EffectContext, key: string): ManaCost | undefined {
  const v = ctx.params[key];
  if (typeof v !== 'object' || v === null) return undefined;
  const src = v as Record<string, unknown>;
  const cost: Record<string, number> = {};
  for (const field of MANA_COST_FIELDS) {
    const amount = src[field];
    if (typeof amount === 'number' && Number.isFinite(amount) && amount > 0) cost[field] = Math.trunc(amount);
  }
  return Object.keys(cost).length > 0 ? (cost as ManaCost) : undefined;
}

/**
 * The `ManaCost` fields a param may carry. `hybrid` is deliberately absent: a
 * hybrid symbol in an *optional* payment would need the payer to choose colours,
 * and no rule emits one, so a cost carrying it is not silently half-read.
 */
const MANA_COST_FIELDS: readonly string[] = Object.freeze(['generic', ...MANA_COLORS]);

/** Whether a keyword flag object has no true flags. */
export function isEmptyKeywords(k: KeywordFlags): boolean {
  for (const key in k) {
    if ((k as Record<string, unknown>)[key]) return false;
  }
  return true;
}

// --- players / targets ---------------------------------------------------------

/** The other seat. */
export function otherPlayer(p: PlayerId): PlayerId {
  return p === 'A' ? 'B' : 'A';
}

/**
 * A target is a player when it is one of the two player ids. Re-exported from core
 * rather than re-implemented: core's targeting layer decides target legality, and
 * two copies of "is this a player?" is how the two halves start disagreeing.
 */
export { isPlayerTarget } from '@jonny-boi/core';

/**
 * Read an effect's declared {@link TargetRestriction} (`params.targets`), falling
 * back to the unrestricted default so an effect that declares nothing behaves
 * exactly as it always has. One reader, shared by every targeting primitive.
 */
export function restrictionParam(ctx: EffectContext): TargetRestriction {
  const declared = ctx.params[TARGET_RESTRICTION_PARAM];
  return isTargetRestriction(declared) ? declared : DEFAULT_TARGET_RESTRICTION;
}

/** Find a battlefield permanent by instance id, or undefined. */
export function permanentById(state: GameState, id: InstanceId): CardInstance | undefined {
  return state.battlefield.find((c) => c.instanceId === id);
}

/**
 * Find a card instance ANYWHERE — battlefield first, then every owned zone. Used
 * by effects that must look up an object that has already changed zones during
 * this same resolution (Path to Exile asking "whose creature was that?" *after*
 * exiling it).
 */
export function instanceAnywhere(state: GameState, id: InstanceId): CardInstance | undefined {
  const onBattlefield = permanentById(state, id);
  if (onBattlefield) return onBattlefield;
  for (const pid of ['A', 'B'] as const) {
    const player = state.players[pid];
    for (const zone of OWNED_ZONES) {
      const found = player[zone].find((c) => c.instanceId === id);
      if (found) return found;
    }
  }
  return undefined;
}

/**
 * The ONE vocabulary for "which player does this happen to", shared by every
 * primitive that can happen to somebody other than its controller.
 *
 * One table rather than a `whichPlayer` string parsed separately in each
 * primitive, because the words have to mean the same thing everywhere: Stormfist
 * Crusader's single printed sentence ("each player draws a card and loses 1
 * life") compiles to a draw and a life loss that MUST agree on who "each player"
 * is, and Howling Mine's "that player" must mean the same in a draw as it would
 * in a damage clause.
 *
 *   `'controller'`  (the default, and what an absent param means) — you.
 *   `'opponent'`    — the other seat. In a two-seat game this is also what the
 *                     printed plural "each opponent" names; there is no other
 *                     referent.
 *   `'targetPlayer'`— the chosen player target, falling back to the controller
 *                     the way every other target-reading param does.
 *   `'triggering'`  — the player the TRIGGER's event was about (`that player`,
 *                     `them`). This is the field that does not otherwise survive
 *                     into a resolution: an "each player's draw step" ability
 *                     resolves under its source's controller on both turns, so
 *                     reading `ctx.controller` here is the Howling-Mine bug.
 *                     Falls back to the controller when the resolution carries
 *                     no triggering player (a spell, a self-ETB trigger).
 *   `'each'`        — BOTH seats, ACTIVE PLAYER FIRST. APNAP is the order the
 *                     rules sequence anything that happens to each player in
 *                     turn, and fixing it here is what makes "each player draws
 *                     a card" reproducible from a seed rather than dependent on
 *                     which seat the source happens to sit in.
 *
 * An unrecognised word resolves to the controller alone — the same safe
 * degradation every other param has. The compiler never emits one.
 */
export function playersForParam(ctx: EffectContext, whichPlayer: string | undefined): readonly PlayerId[] {
  switch (whichPlayer) {
    case 'opponent':
      return [otherPlayer(ctx.controller)];
    case 'targetPlayer':
      return [firstPlayerTarget(ctx) ?? ctx.controller];
    case 'triggering':
      return [ctx.triggeringPlayer ?? ctx.controller];
    case 'each': {
      const active = ctx.state.activePlayer;
      return [active, otherPlayer(active)];
    }
    default:
      return [ctx.controller];
  }
}

/** The first player target among `ctx.targets`, if any. */
export function firstPlayerTarget(ctx: EffectContext): PlayerId | undefined {
  for (const t of ctx.targets) if (isPlayerTarget(t)) return t;
  return undefined;
}

/** The first battlefield permanent among `ctx.targets`, if any. */
export function firstPermanentTarget(ctx: EffectContext): CardInstance | undefined {
  for (const t of ctx.targets) {
    if (!isPlayerTarget(t)) {
      const perm = permanentById(ctx.state, t);
      if (perm) return perm;
    }
  }
  return undefined;
}

/**
 * The first non-player target, looked up wherever it now is (battlefield, exile,
 * graveyard, …). The "last known information" lookup: an effect that runs after
 * its target left the battlefield still needs to know who controlled it.
 */
export function firstTargetInstance(ctx: EffectContext): CardInstance | undefined {
  for (const t of ctx.targets) {
    if (!isPlayerTarget(t)) {
      const found = instanceAnywhere(ctx.state, t);
      if (found) return found;
    }
  }
  return undefined;
}

/** The source as a creature target (for self-pumps / self-grants), or undefined. */
export function selfIfCreature(ctx: EffectContext): CardInstance | undefined {
  const self = permanentById(ctx.state, ctx.source.instanceId);
  return self && isCreature(self.def) ? self : undefined;
}

// --- life -----------------------------------------------------------------------

/** Apply a life delta to a player and emit `lifeChanged`. Pure on the draft. */
export function changeLife(ctx: EffectContext, player: PlayerId, delta: number): void {
  if (delta === 0) return;
  const p = ctx.state.players[player];
  p.life += delta;
  ctx.emit({ type: 'lifeChanged', player, delta, to: p.life });
}

// --- zone movement (one funnel, so every move emits the same event) --------------

/** The zones a single player owns as an ordered card list. */
export type OwnedZone = 'library' | 'hand' | 'graveyard' | 'exile';

/** All owned zones, in the order `instanceAnywhere` scans them. */
export const OWNED_ZONES: readonly OwnedZone[] = Object.freeze(['hand', 'graveyard', 'library', 'exile'] as const);

/** Where a card lands in the destination list — a library has a meaningful top. */
export type ZonePosition = 'top' | 'bottom';

/**
 * Move a card between two zones the same player owns, emitting the `zoneChange`
 * every other path emits. Returns the moved instance, or `undefined` when it was
 * not in `from` any more — a choice can outlive its candidates, and a primitive
 * must degrade to a no-op rather than throw (DESIGN §1 robust).
 */
export function moveOwnedCard(
  ctx: EffectContext,
  player: PlayerId,
  id: InstanceId,
  from: OwnedZone,
  to: OwnedZone,
  position: ZonePosition = 'bottom',
): CardInstance | undefined {
  const owner = ctx.state.players[player];
  const source = owner[from];
  const index = source.findIndex((c) => c.instanceId === id);
  if (index < 0) return undefined;
  const [card] = source.splice(index, 1);
  if (!card) return undefined;
  // A hand → graveyard move IS a discard (CR 701.8a), and madness replaces
  // where a discarded card goes. Asked through core's shared
  // `discardDestination` — the same one core's own `moveToZone` funnel asks — so
  // a discard made by an effect and a discard made as a cost cannot disagree
  // about whether a madness card is exiled.
  const destination: OwnedZone =
    from === 'hand' && to === 'graveyard'
      ? (discardDestination(ctx.state, card, ctx.emit) as OwnedZone)
      : to;
  card.zone = destination;
  // CR 400.7: the card is a NEW object in its new zone, so a grant made on the
  // old one (a granted flashback on a graveyard card) does not follow it. Core's
  // own `moveToZone` prunes for the same reason; this helper is the cards-side
  // funnel and must agree with it — see `card-grants.ts`.
  pruneCardGrantsFor(ctx.state, card.instanceId);
  if (position === 'top') owner[destination].unshift(card);
  else owner[destination].push(card);
  ctx.emit({ type: 'zoneChange', instanceId: card.instanceId, from, to: destination });
  return card;
}

/**
 * Put a card that is currently in one of `controller`'s zones onto the battlefield
 * under their control (a land fetched from the library, a creature reanimated).
 * `tapped` forces it to arrive tapped regardless of its printed "enters tapped".
 *
 * Emits the same `zoneChange` into the battlefield that every other entry path
 * emits, so enters-the-battlefield triggers observe it through the one mechanism.
 */
export function putOntoBattlefield(
  ctx: EffectContext,
  player: PlayerId,
  id: InstanceId,
  from: OwnedZone,
  options: {
    readonly tapped?: boolean;
    /**
     * Skip the definition's own `entersTapped` and use `tapped` verbatim. The
     * one caller is a fetched shockland whose controller PAID: the definition's
     * answer is the unpaid default (tapped), and the payment has already been
     * charged by the engine, so the entry must honour it.
     */
    readonly ignoreEntersTapped?: boolean;
    /**
     * Who ends up CONTROLLING it, when that is not whose zone it came from.
     * A blink says "exile target creature you control, then return that card to
     * the battlefield **under your control**" — and a card always goes to its
     * OWNER's exile on the way out (CR 400.3), so for a creature you control but
     * do not own the two players genuinely differ. Defaults to `player`, which
     * is every other caller's case.
     */
    readonly controller?: PlayerId;
  } = {},
): CardInstance | undefined {
  const owner = ctx.state.players[player];
  const source = owner[from];
  const index = source.findIndex((c) => c.instanceId === id);
  if (index < 0) return undefined;
  const [card] = source.splice(index, 1);
  if (!card) return undefined;
  card.zone = 'battlefield';
  card.controller = options.controller ?? player;
  card.tapped = options.ignoreEntersTapped === true ? options.tapped === true : options.tapped === true || entersTapped(card.def);
  card.summoningSick = isCreature(card.def) && card.def.keywords?.haste !== true;
  card.damageMarked = 0;
  card.markedByDeathtouch = false;
  card.counters = {};
  ctx.state.battlefield.push(card);
  // §3.110 — the entry-time facts (echo's control stamp, "enters with N
  // counters"), through the ONE helper every core entry path calls. This was
  // the fourth entry funnel and the one §3.106 missed: a reanimated Arcbound
  // Worker (modular — a 0/0 that enters with a counter) arrived with none and
  // died to a state-based action on arrival, exactly the shape §3.106 fixed
  // for Blastoderm on the other three paths.
  markBattlefieldEntry(ctx.state, card, ctx.emit);
  ctx.emit({ type: 'zoneChange', instanceId: card.instanceId, from, to: 'battlefield' });
  if (card.tapped) ctx.emit({ type: 'tapped', instanceId: card.instanceId });
  return card;
}

/**
 * Move a battlefield permanent to one of its OWNER's zones, resetting the
 * transient per-object state so it re-enters clean if it ever comes back.
 */
export function movePermanentTo(ctx: EffectContext, perm: CardInstance, to: OwnedZone): void {
  const idx = ctx.state.battlefield.findIndex((c) => c.instanceId === perm.instanceId);
  if (idx < 0) return;
  ctx.state.battlefield.splice(idx, 1);
  perm.zone = to;
  // CR 400.7 — the permanent is a NEW object in its new zone, so every scrap of
  // battlefield-only state goes with the move: tapped, marked damage, summoning
  // sickness, counters, what it was attached to, its once-per-turn loyalty
  // marker, its kick count, the value it named as it entered, and which face is
  // up (CR 712.8a — a bounced Aberration is a Delver in hand).
  //
  // ⚠️ Called, not re-implemented. This USED to be a hand-copied list and it had
  // already drifted from core's by three fields, each of which is a card playing
  // differently depending on WHICH funnel bounced it: an Aura came back still
  // pointing at its old host, a planeswalker could not activate again after being
  // replayed, and an "as ~ enters, choose a type" lord still lorded over the type
  // it named last time. Two funnels, one answer.
  resetInstanceForNewZone(perm);
  // A permanent always goes to its OWNER's zone, not its controller's. Its
  // `controller` field is left as it was: it is the last-known information an
  // after-the-fact effect reads (Path to Exile compensates the creature's
  // *controller* only after the creature has already been exiled).
  // Same CR 400.7 prune as `moveOwnedCard` — a permanent carries no grant
  // today, but the two funnels must not disagree about what a zone change does.
  pruneCardGrantsFor(ctx.state, perm.instanceId);
  ctx.state.players[perm.owner][to].push(perm);
  ctx.emit({ type: 'zoneChange', instanceId: perm.instanceId, from: 'battlefield', to });
  // CR 704.5d — a token that has left the battlefield ceases to exist. Core's
  // shared implementation, called AFTER the zoneChange so every "dies" trigger
  // still sees the move: this helper is the cards-side leave funnel and must
  // agree with core's `moveToZone`, or whether a dead token lingers in the
  // graveyard would depend on which primitive destroyed it.
  ceaseToExistIfToken(ctx.state, perm, ctx.emit);
}

/**
 * The SPELL this effect's first target names, if it is still on the stack.
 *
 * "Counter target spell" only ever affects spells: the stack also holds trigger
 * objects (a triggered ability, an activated ability), which have no card and
 * cannot be countered by these cards. A target that has already left the stack —
 * countered by something else, or resolved — yields `undefined`, and every caller
 * degrades to a safe no-op.
 */
export function targetedSpellOnStack(ctx: EffectContext): SpellStackObject | undefined {
  const target = ctx.targets[0];
  if (target === undefined || isPlayerTarget(target)) return undefined;
  const object = ctx.state.stack.find((o) => o.instanceId === target);
  return object && object.kind === 'spell' ? object : undefined;
}

/**
 * Counter `spell`: take it off the stack and put its card where a countered copy
 * of it goes — the owner's graveyard normally, EXILE when it was cast via
 * flashback (CR 702.34a exiles the card any time it would leave the stack, and
 * being countered is leaving the stack), and the graveyard even when its buyback
 * cost was paid (CR 702.27a returns it to hand only as it resolves). The destination is core's
 * `spellLeaveDestination`, the same answer resolution uses, so countering and
 * resolving cannot disagree about where a flashback card ends up.
 *
 * …AND NO ZONE AT ALL when the thing being countered is a COPY of a spell
 * (CR 704.5e). A copy is not a card: there is nothing to put in a graveyard, and
 * putting one there would hand the game a phantom card that delirium, flashback
 * and Tarmogoyf all count. This is the second of the two exits from the stack,
 * living in a different package from the first, which is exactly why the answer
 * is a value in `spellLeaveDestination`'s return type rather than an `if` at
 * each call site: a caller cannot type-check without handling it.
 *
 * One implementation, shared by the plain counterspell and the "unless its
 * controller pays" one. They differ ONLY in whether the payment happens first, and
 * a second copy of the zone move is exactly how two primitives start disagreeing
 * about what countering emits.
 */
export function counterSpellOnStack(ctx: EffectContext, spell: SpellStackObject): void {
  const idx = ctx.state.stack.indexOf(spell);
  if (idx < 0) return;
  // "THIS SPELL CAN'T BE COUNTERED" (CR 701.5a) is enforced HERE and nowhere else,
  // because this is the one function every counter path funnels through. It is
  // deliberately not a TARGETING restriction: an uncounterable spell is a legal
  // target, and the counterspell resolves, does nothing, and is still spent —
  // refusing the target instead would hand the caster their card back.
  if (!spellCanBeCountered(ctx.state, spell.card.def, spell.controller)) {
    ctx.emit({
      type: 'counterPrevented',
      instanceId: spell.instanceId,
      name: spell.card.def.name,
      controller: spell.controller,
    });
    return;
  }
  ctx.state.stack.splice(idx, 1);
  const card = spell.card;
  // COUNTERED, not resolved — the distinction the reason argument exists for: a
  // flashback card is exiled either way, but a bought-back spell returns to hand
  // only as it RESOLVES, so a countered one belongs in the graveyard.
  const to = spellLeaveDestination(spell, 'counter');
  if (to === 'ceaseToExist') {
    // Emitted INSTEAD of a `zoneChange`, which is the point: a log, a replay or
    // an inspector folding zone changes must not put this object in a graveyard,
    // because the game never did.
    ctx.emit({ type: 'spellCopyCeasedToExist', instanceId: card.instanceId, name: card.def.name });
    return;
  }
  card.zone = to;
  ctx.state.players[card.owner][to].push(card);
  ctx.emit({ type: 'zoneChange', instanceId: card.instanceId, from: 'stack', to });
}

// --- misc -----------------------------------------------------------------------

/**
 * Converted mana value of a definition (0 for a free card or a land). Delegates to
 * core's `convertedManaCost`, which counts a hybrid symbol as one — a locally
 * re-implemented sum used to miss `hybrid` entirely and price Kitchen Finks
 * ({1}{G/W}{G/W}) at 1, which quietly made it a legal Fatal Push target.
 */
export function manaValueOf(def: CardDefinition): number {
  return def.cost ? convertedManaCost(def.cost) : 0;
}

// --- the spell-count family (§3.113) -------------------------------------------
/**
 * MILL (CR 701.17a): put the top `amount` cards of `who`'s library into their
 * graveyard, returning the ids in the order they were milled. The ONE mill
 * funnel — the `mill` primitive and the "from among the milled cards" shapes
 * (`millThenReturn`) both go through it, so a card milled by either lands in
 * the same graveyard order and emits the same `cardsMilled`.
 *
 * A library shorter than `amount` empties (CR 701.17b — as many as possible);
 * the loss is the engine's decking rule on the next draw, not this helper's.
 */
export function millTopCards(ctx: EffectContext, who: PlayerId, amount: number): InstanceId[] {
  const player = ctx.state.players[who];
  const count = Math.min(Math.max(0, amount), player.library.length);
  const milled: InstanceId[] = [];
  for (let i = 0; i < count; i++) {
    const card = player.library[0];
    if (!card) break;
    /*
     * §3.147 — SAY THAT THIS CARD BECAME PUBLIC, at the one mill funnel.
     *
     * A milled card lands face up in a graveyard, so it is public from that
     * instant — but it need not still be there when anyone next looks. Sudden
     * Reclamation mills three and returns one to HAND inside a single
     * resolution, so that card is public and then hidden again with no decision
     * boundary in between, and the observation audit — which can only compare
     * settled states — saw its own `zoneChange` naming a card it still held as
     * never-seen and called it a leak.
     *
     * Exactly the cascade/ripple shape, and it takes the same remedy for the
     * same reason (§3.119): a reveal is how the engine says "this became
     * public" when no observable zone change survives to prove it.
     * `cardRevealed` fires no triggers, so this adds a fact to the log and
     * changes no game outcome. Emitted BEFORE the move, because the scanner
     * reads a flush in emission order.
     *
     * It lives HERE rather than in the two mill primitives because this is the
     * one funnel both go through — a second copy would eventually disagree.
     */
    ctx.emit({
      type: 'cardRevealed',
      player: who,
      instanceId: card.instanceId,
      name: card.def.name,
      fromZone: 'library',
    });
    moveOwnedCard(ctx, who, card.instanceId, 'library', 'graveyard');
    milled.push(card.instanceId);
  }
  if (milled.length > 0) ctx.emit({ type: 'cardsMilled', player: who, amount: milled.length });
  return milled;
}
