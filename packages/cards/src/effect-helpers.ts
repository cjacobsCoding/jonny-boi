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
  CardInstance,
  EffectContext,
  GameState,
  InstanceId,
  KeywordFlags,
  ManaCost,
  PlayerId,
  DerivedCountName,
  SpellStackObject,
  TargetRestriction,
} from '@jonny-boi/core';
import {
  convertedManaCost,
  DEFAULT_TARGET_RESTRICTION,
  evaluateDerivedCount,
  entersTapped,
  isCreature,
  isPlayerTarget,
  isTargetRestriction,
  MANA_COLORS,
  pruneCardGrantsFor,
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
export type DerivedCount = DerivedCountName;

/** A numeric param that is computed at resolution instead of printed. */
export interface DerivedValue {
  readonly countOf: DerivedCount;
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
}

/** The one param value meaning "the X chosen at cast time". */
export const CHOSEN_X: ChosenXValue = Object.freeze({ chosenX: true });

/** Whether a param value is the chosen-X descriptor. */
function isChosenX(value: unknown): value is ChosenXValue {
  return typeof value === 'object' && value !== null && (value as { chosenX?: unknown }).chosenX === true;
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
  // Every count core can answer from the BOARD is answered by core, from the one
  // shared evaluator (so a spell's "equal to the number of X" and a `*` P/T box
  // count the identical set). The kick count is the single exception, and it has
  // to be: it is a fact about THIS RESOLUTION, which core's board-only evaluator
  // has no way to see.
  if (value.countOf === 'timesThisWasKicked') {
    // Two readings, and both are needed. DURING the spell's own resolution the
    // count rides the frame (`ctx.kickCount`, with a plain kicker counting as
    // one). AFTERWARDS — an enters-the-battlefield trigger on the permanent that
    // spell became — the frame is gone and the count lives on the instance
    // (`timesKicked`, written as it entered).
    return ctx.kickCount ?? (ctx.kicked === true ? 1 : (ctx.source.timesKicked ?? 0));
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
  // "X" — the value chosen (and paid for) at cast time. An unchosen X reads 0,
  // the direction that can never play better than printed.
  if (isChosenX(v)) return ctx.xValue ?? 0;
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
 * keeping only the boolean-true flags. A missing/ill-typed param yields an empty
 * grant (safe no-op).
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
  // which is exactly how a granted "except by creatures with haste" would become a
  // grant of nothing. Each is copied through by its own shape test, and only when
  // it carries something the engine can act on, so a malformed param still yields
  // an inert grant rather than a half-read restriction.
  const ward = src.ward;
  if (typeof ward === 'number' && Number.isFinite(ward) && ward > 0) out.ward = Math.trunc(ward);
  const minBlockers = src.minBlockers;
  if (typeof minBlockers === 'number' && Number.isFinite(minBlockers) && minBlockers > 0) {
    out.minBlockers = Math.trunc(minBlockers);
  }
  const protectionFrom = src.protectionFrom;
  if (Array.isArray(protectionFrom) && protectionFrom.length > 0) out.protectionFrom = protectionFrom;
  const blockRestriction = src.blockRestriction;
  if (typeof blockRestriction === 'object' && blockRestriction !== null) {
    out.blockRestriction = blockRestriction;
  }
  return out as KeywordFlags;
}

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
  } = {},
): CardInstance | undefined {
  const owner = ctx.state.players[player];
  const source = owner[from];
  const index = source.findIndex((c) => c.instanceId === id);
  if (index < 0) return undefined;
  const [card] = source.splice(index, 1);
  if (!card) return undefined;
  card.zone = 'battlefield';
  card.controller = player;
  card.tapped = options.ignoreEntersTapped === true ? options.tapped === true : options.tapped === true || entersTapped(card.def);
  card.summoningSick = isCreature(card.def) && card.def.keywords?.haste !== true;
  card.damageMarked = 0;
  card.markedByDeathtouch = false;
  card.counters = {};
  ctx.state.battlefield.push(card);
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
  perm.tapped = false;
  perm.damageMarked = 0;
  perm.markedByDeathtouch = false;
  perm.summoningSick = false;
  perm.counters = {};
  // CR 712.8a: a transformed DFC turns front-face-up the moment it leaves the
  // battlefield — a bounced Aberration is a Delver in hand. Core's
  // `resetInstanceForNewZone` does the same for the engine's own leave paths;
  // this helper is the cards-side funnel and must agree with it.
  if (perm.printedDef != null) {
    perm.def = perm.printedDef;
    perm.printedDef = null;
  }
  // A permanent always goes to its OWNER's zone, not its controller's. Its
  // `controller` field is left as it was: it is the last-known information an
  // after-the-fact effect reads (Path to Exile compensates the creature's
  // *controller* only after the creature has already been exiled).
  // Same CR 400.7 prune as `moveOwnedCard` — a permanent carries no grant
  // today, but the two funnels must not disagree about what a zone change does.
  pruneCardGrantsFor(ctx.state, perm.instanceId);
  ctx.state.players[perm.owner][to].push(perm);
  ctx.emit({ type: 'zoneChange', instanceId: perm.instanceId, from: 'battlefield', to });
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
