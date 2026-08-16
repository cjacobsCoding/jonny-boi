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
  SpellStackObject,
  TargetRestriction,
} from '@jonny-boi/core';
import {
  convertedManaCost,
  DEFAULT_TARGET_RESTRICTION,
  entersTapped,
  isCreature,
  isPlayerTarget,
  isTargetRestriction,
  MANA_COLORS,
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
 */
export type DerivedCount =
  | 'creaturesYouControl'
  | 'creaturesOpponentControls'
  | 'creaturesOnBattlefield'
  | 'landsYouControl'
  | 'cardsInYourHand'
  | 'cardsInYourGraveyard';

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
 * Evaluate a derived count against the CURRENT state.
 *
 * "Current" matters: the value is computed when the effect resolves, not when
 * the spell was cast, which is what the printed cards mean and what makes a
 * sweeper-then-pump sequence behave correctly.
 */
export function evaluateDerived(ctx: EffectContext, value: DerivedValue): number {
  const you = ctx.controller;
  const them = otherPlayer(you);
  const battlefield = ctx.state.battlefield;
  switch (value.countOf) {
    case 'creaturesYouControl':
      return battlefield.filter((c) => c.controller === you && isCreature(c.def)).length;
    case 'creaturesOpponentControls':
      return battlefield.filter((c) => c.controller === them && isCreature(c.def)).length;
    case 'creaturesOnBattlefield':
      return battlefield.filter((c) => isCreature(c.def)).length;
    case 'landsYouControl':
      return battlefield.filter((c) => c.controller === you && c.def.types.includes('land')).length;
    case 'cardsInYourHand':
      return ctx.state.players[you].hand.length;
    case 'cardsInYourGraveyard':
      return ctx.state.players[you].graveyard.length;
    default:
      return 0;
  }
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
  const out: Record<string, boolean> = {};
  for (const key in src) {
    if (src[key] === true) out[key] = true;
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
  card.zone = to;
  if (position === 'top') owner[to].unshift(card);
  else owner[to].push(card);
  ctx.emit({ type: 'zoneChange', instanceId: card.instanceId, from, to });
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
  options: { readonly tapped?: boolean } = {},
): CardInstance | undefined {
  const owner = ctx.state.players[player];
  const source = owner[from];
  const index = source.findIndex((c) => c.instanceId === id);
  if (index < 0) return undefined;
  const [card] = source.splice(index, 1);
  if (!card) return undefined;
  card.zone = 'battlefield';
  card.controller = player;
  card.tapped = options.tapped === true || entersTapped(card.def);
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
  // A permanent always goes to its OWNER's zone, not its controller's. Its
  // `controller` field is left as it was: it is the last-known information an
  // after-the-fact effect reads (Path to Exile compensates the creature's
  // *controller* only after the creature has already been exiled).
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
 * Counter `spell`: take it off the stack and put its card into its owner's
 * graveyard without resolving.
 *
 * One implementation, shared by the plain counterspell and the "unless its
 * controller pays" one. They differ ONLY in whether the payment happens first, and
 * a second copy of the zone move is exactly how two primitives start disagreeing
 * about what countering emits.
 */
export function counterSpellOnStack(ctx: EffectContext, spell: SpellStackObject): void {
  const idx = ctx.state.stack.indexOf(spell);
  if (idx < 0) return;
  ctx.state.stack.splice(idx, 1);
  const card = spell.card;
  card.zone = 'graveyard';
  ctx.state.players[card.owner].graveyard.push(card);
  ctx.emit({ type: 'zoneChange', instanceId: card.instanceId, from: 'stack', to: 'graveyard' });
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
