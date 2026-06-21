/**
 * Effect-primitive library for `@jonny-boi/cards`.
 *
 * Composition over inheritance (DESIGN §1.2): a card is *data* that references
 * these small, pure primitives by id. There is NO class-per-card. Each primitive
 * is a tiny `EffectPrimitive` (from `@jonny-boi/core`) that mutates the draft
 * `GameState` through its `EffectContext`, emits typed events, and reads every
 * tunable (damage amount, P/T delta, card count, …) from `ctx.params` — never an
 * inline literal (DESIGN §1.3, no magic numbers).
 *
 * Robustness (DESIGN §1 robust): a primitive must be safe on a missing/invalid
 * target — it degrades to a no-op rather than throwing, so a malformed cast can
 * never crash the engine. (Core already guarantees an *unknown* primitive id is a
 * safe no-op + `effectUnsupported`; these implementations guarantee the same for
 * bad targets.)
 *
 * Targeting model: core resolves targets at cast time and passes them as
 * `ctx.targets` — an array of `InstanceId` (a battlefield permanent) and/or
 * `PlayerId` (`'A'`/`'B'`). Primitives that target read `ctx.targets[i]` and
 * classify it with the helpers below.
 */

import type {
  CardInstance,
  EffectContext,
  EffectPrimitive,
  EffectRegistry,
  GameState,
  InstanceId,
  PlayerId,
} from '@jonny-boi/core';
import { PLUS_ONE_COUNTER, effectivePower, isCreature } from '@jonny-boi/core';

// --- param reading (typed, defaulted — no magic numbers leak in) ---------------

/** Read a non-negative integer param by key, falling back to `fallback`. */
function intParam(ctx: EffectContext, key: string, fallback: number): number {
  const v = ctx.params[key];
  return typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : fallback;
}

/** Read a string param by key, or `undefined` if absent/ill-typed. */
function strParam(ctx: EffectContext, key: string): string | undefined {
  const v = ctx.params[key];
  return typeof v === 'string' ? v : undefined;
}

/** Read a string-array param by key (e.g. token colors / produced mana). */
function strArrayParam(ctx: EffectContext, key: string): readonly string[] {
  const v = ctx.params[key];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

// --- target helpers ------------------------------------------------------------

/** A target is a player when it is one of the two player ids. */
function isPlayerTarget(t: InstanceId | PlayerId): t is PlayerId {
  return t === 'A' || t === 'B';
}

/** Find a battlefield permanent by instance id, or undefined. */
function permanentById(state: GameState, id: InstanceId): CardInstance | undefined {
  return state.battlefield.find((c) => c.instanceId === id);
}

/** The first player target among `ctx.targets`, if any. */
function firstPlayerTarget(ctx: EffectContext): PlayerId | undefined {
  for (const t of ctx.targets) if (isPlayerTarget(t)) return t;
  return undefined;
}

/** The first creature/permanent target among `ctx.targets`, if any. */
function firstPermanentTarget(ctx: EffectContext): CardInstance | undefined {
  for (const t of ctx.targets) {
    if (!isPlayerTarget(t)) {
      const perm = permanentById(ctx.state, t);
      if (perm) return perm;
    }
  }
  return undefined;
}

// --- life-total mutation (single funnel so events stay consistent) -------------

/** Apply a life delta to a player and emit `lifeChanged`. Pure on the draft. */
function changeLife(ctx: EffectContext, player: PlayerId, delta: number): void {
  if (delta === 0) return;
  const p = ctx.state.players[player];
  p.life += delta;
  ctx.emit({ type: 'lifeChanged', player, delta, to: p.life });
}

// --- the primitives ------------------------------------------------------------

/**
 * `dealDamage` — deal `amount` damage to the chosen target (a creature or a
 * player; "any target" in MTG terms). Reads `params.amount`. A creature target
 * gets marked damage (SBAs destroy it if lethal); a player target loses life.
 * No valid target → safe no-op. Used by Lightning Bolt (amount 3).
 */
export const dealDamage: EffectPrimitive = (ctx) => {
  const amount = intParam(ctx, 'amount', 0);
  if (amount <= 0) return;
  const target = ctx.targets[0];
  if (target === undefined) return;

  if (isPlayerTarget(target)) {
    changeLife(ctx, target, -amount);
    ctx.emit({ type: 'damageDealt', source: ctx.source.instanceId, target, amount, combat: false });
    return;
  }
  const perm = permanentById(ctx.state, target);
  if (!perm) return; // target fizzled (already gone) — safe no-op
  perm.damageMarked += amount;
  ctx.emit({ type: 'damageDealt', source: ctx.source.instanceId, target: perm.instanceId, amount, combat: false });
};

/**
 * `drawCards` — the controller draws `params.count` cards. Drawing from an empty
 * library flags a loss via SBA on the next check (we move the top card or stop).
 * Used by Brainstorm (3), Ponder (1), Cryptic Command (1).
 */
export const drawCards: EffectPrimitive = (ctx) => {
  const count = intParam(ctx, 'count', 1);
  const player = ctx.state.players[ctx.controller];
  for (let i = 0; i < count; i++) {
    const top = player.library.shift();
    if (!top) {
      // Decking: leave the empty library; core's SBA will register the loss when
      // a *draw step* draw fails. A spell-driven empty draw is rare in the pool;
      // emit nothing rather than fabricate a loss event here.
      return;
    }
    top.zone = 'hand';
    player.hand.push(top);
    ctx.emit({ type: 'drawCard', player: ctx.controller, instanceId: top.instanceId });
  }
};

/**
 * `gainLife` — the controller (or a target player) gains `params.amount` life.
 * Used by Kitchen Finks ETB (2). If `params.targetPlayer` is true, the first
 * player target gains the life instead of the controller.
 */
export const gainLife: EffectPrimitive = (ctx) => {
  const amount = intParam(ctx, 'amount', 0);
  if (amount <= 0) return;
  const useTarget = ctx.params.targetPlayer === true;
  const player = useTarget ? firstPlayerTarget(ctx) ?? ctx.controller : ctx.controller;
  changeLife(ctx, player, amount);
  ctx.emit({ type: 'gainLife', player, amount });
};

/**
 * `loseLife` — a player loses `params.amount` life. Defaults to the controller;
 * with `params.targetPlayer` true the first player target loses it instead.
 * Used by Thoughtseize (controller loses 2).
 */
export const loseLife: EffectPrimitive = (ctx) => {
  const amount = intParam(ctx, 'amount', 0);
  if (amount <= 0) return;
  const useTarget = ctx.params.targetPlayer === true;
  const player = useTarget ? firstPlayerTarget(ctx) ?? ctx.controller : ctx.controller;
  changeLife(ctx, player, -amount);
};

/**
 * `pumpUntilEndOfTurn` — give the target creature +X/+Y for the turn. The MVP
 * engine has no "until end of turn" expiry layer yet, so we model the buff with
 * persistent +1/+1 counters when the bonus is symmetric (the common case:
 * Giant Growth +3/+3). Reads `params.power` / `params.toughness`. This changes
 * combat math immediately (effectivePower/Toughness read counters). A creature
 * with no target → safe no-op.
 *
 * NOTE: counters persist past end of turn (engine limitation, documented), so a
 * symmetric pump is faithful for the resolution it happens on. Asymmetric pumps
 * fall back to the larger magnitude as a +1/+1 count so combat is never wrong in
 * the caster's favor by less than intended.
 */
export const pumpUntilEndOfTurn: EffectPrimitive = (ctx) => {
  const power = intParam(ctx, 'power', 0);
  const toughness = intParam(ctx, 'toughness', 0);
  const target = firstPermanentTarget(ctx);
  if (!target || !isCreature(target.def)) return;
  // Model the buff as +1/+1 counters using the dominant magnitude so both power
  // and toughness move; Giant Growth (+3/+3) → 3 counters.
  const stacks = Math.max(power, toughness);
  if (stacks <= 0) return;
  target.counters[PLUS_ONE_COUNTER] = (target.counters[PLUS_ONE_COUNTER] ?? 0) + stacks;
  ctx.emit({ type: 'counterAdded', instanceId: target.instanceId, kind: PLUS_ONE_COUNTER, amount: stacks });
};

/**
 * `destroyTarget` — destroy the target creature (move it to its owner's
 * graveyard), optionally restricted by `params.notColor` (e.g. Doom Blade:
 * nonblack) or `params.maxManaValue` (e.g. Fatal Push: mana value ≤ N). A
 * target failing the restriction → safe no-op (the spell "fizzles" on it).
 */
export const destroyTarget: EffectPrimitive = (ctx) => {
  const target = firstPermanentTarget(ctx);
  if (!target || !isCreature(target.def)) return;
  if (!passesDestroyFilter(ctx, target)) return;
  destroyCreature(ctx, target);
};

/**
 * `exileTarget` — exile the target creature. Used by removal that exiles rather
 * than destroys (Path to Exile, Swords to Plowshares). `params.gainLifeEqualPower`
 * true → the creature's controller gains life equal to its power first (Swords).
 */
export const exileTarget: EffectPrimitive = (ctx) => {
  const target = firstPermanentTarget(ctx);
  if (!target || !isCreature(target.def)) return;
  if (ctx.params.gainLifeEqualPower === true) {
    const power = effectivePower(target);
    if (power > 0) {
      changeLife(ctx, target.controller, power);
      ctx.emit({ type: 'gainLife', player: target.controller, amount: power });
    }
  }
  removePermanentTo(ctx, target, 'exile');
};

/**
 * `destroyAll` — destroy every creature on the battlefield (a board wipe). Used
 * by Wrath of God. No params required. Iterates a snapshot so mutation while
 * looping is safe.
 */
export const destroyAll: EffectPrimitive = (ctx) => {
  const creatures = ctx.state.battlefield.filter((c) => isCreature(c.def));
  for (const creature of creatures) destroyCreature(ctx, creature);
};

/**
 * `addMana` — add mana to the controller's pool. `params.mana` is an array of
 * color symbols, e.g. `['B','B','B']` for Dark Ritual. Each symbol emits a
 * `manaAdded` event. Colors not in the engine's palette are ignored.
 */
export const addMana: EffectPrimitive = (ctx) => {
  const symbols = strArrayParam(ctx, 'mana');
  const pool = ctx.state.players[ctx.controller].manaPool;
  for (const sym of symbols) {
    if (sym in pool) {
      const color = sym as keyof typeof pool;
      pool[color] += 1;
      ctx.emit({ type: 'manaAdded', player: ctx.controller, color, amount: 1 });
    }
  }
};

/**
 * `counterSpell` — counter the target spell on the stack (remove it; it goes to
 * its owner's graveyard without resolving). Used by Counterspell and (one mode
 * of) Cryptic Command. The target instance id must currently be on the stack;
 * otherwise safe no-op (the spell already left the stack). Since the engine
 * resolves the stack LIFO and this primitive runs during *this* spell's
 * resolution, a real counter would need stack targeting at cast time; we counter
 * by instance id if present.
 */
export const counterSpell: EffectPrimitive = (ctx) => {
  const target = ctx.targets[0];
  if (target === undefined || isPlayerTarget(target)) return;
  const idx = ctx.state.stack.findIndex((o) => o.instanceId === target);
  if (idx < 0) return; // not on the stack — safe no-op
  const targeted = ctx.state.stack[idx];
  // "Counter target spell" only affects spells, not triggered abilities on the
  // stack (the engine-v2 StackObject union includes 'trigger' objects with no card).
  if (!targeted || targeted.kind !== 'spell') return; // safe no-op
  ctx.state.stack.splice(idx, 1);
  const card = targeted.card;
  card.zone = 'graveyard';
  ctx.state.players[card.owner].graveyard.push(card);
  ctx.emit({ type: 'zoneChange', instanceId: card.instanceId, from: 'stack', to: 'graveyard' });
};

/**
 * `discardCard` — a player discards `params.count` cards (default 1). Defaults to
 * the first player target (Thoughtseize: opponent), else the controller. With no
 * AI choice yet, discards the last card in hand deterministically. Empty hand →
 * no-op.
 */
export const discardCard: EffectPrimitive = (ctx) => {
  const count = intParam(ctx, 'count', 1);
  const who = firstPlayerTarget(ctx) ?? otherPlayer(ctx.controller);
  const hand = ctx.state.players[who].hand;
  for (let i = 0; i < count; i++) {
    const card = hand.pop();
    if (!card) return;
    card.zone = 'graveyard';
    ctx.state.players[card.owner].graveyard.push(card);
    ctx.emit({ type: 'zoneChange', instanceId: card.instanceId, from: 'hand', to: 'graveyard' });
  }
};

/**
 * `createToken` — put `params.count` (default 1) creature tokens onto the
 * battlefield under the controller. Token P/T/name/keywords come from params so
 * there are no magic numbers. Used by token-makers (when a trigger system lands;
 * also usable as an ETB token script). Each token is a fresh instance with a
 * minimal generated `CardDefinition`.
 */
export const createToken: EffectPrimitive = (ctx) => {
  const count = intParam(ctx, 'count', 1);
  const power = intParam(ctx, 'power', 1);
  const toughness = intParam(ctx, 'toughness', 1);
  const name = strParam(ctx, 'name') ?? 'Token';
  for (let i = 0; i < count; i++) {
    const instanceId = ctx.state.nextInstanceId++;
    const token: CardInstance = {
      instanceId,
      def: { id: `token:${name}`, name, types: ['creature'], power, toughness },
      controller: ctx.controller,
      owner: ctx.controller,
      zone: 'battlefield',
      tapped: false,
      summoningSick: true,
      damageMarked: 0,
      markedByDeathtouch: false,
      counters: {},
    };
    ctx.state.battlefield.push(token);
    ctx.emit({ type: 'zoneChange', instanceId, from: 'stack', to: 'battlefield' });
  }
};

/**
 * `tapTarget` — tap the target permanent (used by tap-down effects; one mode of
 * Cryptic Command in spirit). No valid target → safe no-op.
 */
export const tapTarget: EffectPrimitive = (ctx) => {
  const target = firstPermanentTarget(ctx);
  if (!target || target.tapped) return;
  target.tapped = true;
  ctx.emit({ type: 'tapped', instanceId: target.instanceId });
};

/**
 * `returnFromGraveyard` — return `params.count` (default 1) card(s) from the
 * controller's graveyard to hand. Used by Eternal Witness ETB. With no chooser
 * yet, returns the most-recently-added card(s). Empty graveyard → no-op. Skips
 * the source card itself so an ETB can't grab the creature that just entered.
 */
export const returnFromGraveyard: EffectPrimitive = (ctx) => {
  const count = intParam(ctx, 'count', 1);
  const player = ctx.state.players[ctx.controller];
  let returned = 0;
  for (let i = player.graveyard.length - 1; i >= 0 && returned < count; i--) {
    const card = player.graveyard[i];
    if (!card || card.instanceId === ctx.source.instanceId) continue;
    player.graveyard.splice(i, 1);
    card.zone = 'hand';
    player.hand.push(card);
    ctx.emit({ type: 'zoneChange', instanceId: card.instanceId, from: 'graveyard', to: 'hand' });
    returned++;
  }
};

// --- shared internals ----------------------------------------------------------

function otherPlayer(p: PlayerId): PlayerId {
  return p === 'A' ? 'B' : 'A';
}

/** Whether `target` passes this destroy/removal's optional filter params. */
function passesDestroyFilter(ctx: EffectContext, target: CardInstance): boolean {
  const notColor = strParam(ctx, 'notColor');
  if (notColor) {
    // The engine's CardDefinition has no color field; derive color from the
    // card's colored mana pips. A card is "of color X" if its cost requires X.
    const cost = target.def.cost;
    const requires = cost ? ((cost as Record<string, number | undefined>)[notColor] ?? 0) > 0 : false;
    if (requires) return false; // e.g. nonblack filter rejects a card with {B} pips
  }
  const maxMv = ctx.params.maxManaValue;
  if (typeof maxMv === 'number') {
    if (manaValue(target) > maxMv) return false;
  }
  return true;
}

/** Converted mana value of a permanent's definition (0 if free/land). */
function manaValue(inst: CardInstance): number {
  const c = inst.def.cost;
  if (!c) return 0;
  const rec = c as Record<string, number | undefined>;
  return (
    (rec.generic ?? 0) +
    (rec.W ?? 0) +
    (rec.U ?? 0) +
    (rec.B ?? 0) +
    (rec.R ?? 0) +
    (rec.G ?? 0) +
    (rec.C ?? 0)
  );
}

/** Destroy a creature: move it to its owner's graveyard and emit `creatureDied`. */
function destroyCreature(ctx: EffectContext, creature: CardInstance): void {
  removePermanentTo(ctx, creature, 'graveyard');
  ctx.emit({ type: 'creatureDied', instanceId: creature.instanceId, name: creature.def.name });
}

/** Move a battlefield permanent to a destination owner-zone, emitting zoneChange. */
function removePermanentTo(ctx: EffectContext, perm: CardInstance, to: 'graveyard' | 'exile'): void {
  const idx = ctx.state.battlefield.findIndex((c) => c.instanceId === perm.instanceId);
  if (idx < 0) return;
  ctx.state.battlefield.splice(idx, 1);
  perm.zone = to;
  // Reset transient per-object state so it re-enters clean if it ever returns.
  perm.tapped = false;
  perm.damageMarked = 0;
  perm.markedByDeathtouch = false;
  perm.summoningSick = false;
  perm.counters = {};
  const dest = to === 'graveyard' ? ctx.state.players[perm.owner].graveyard : ctx.state.players[perm.owner].exile;
  dest.push(perm);
  ctx.emit({ type: 'zoneChange', instanceId: perm.instanceId, from: 'battlefield', to });
}

// --- the canonical primitive id registry ---------------------------------------

/**
 * Every primitive keyed by its stable id (the `EffectRef.primitive` value cards
 * reference). Adding a primitive = adding one entry here + the data that uses it.
 */
export const CORE_PRIMITIVES: Readonly<Record<string, EffectPrimitive>> = Object.freeze({
  dealDamage,
  drawCards,
  gainLife,
  loseLife,
  pumpUntilEndOfTurn,
  destroyTarget,
  exileTarget,
  destroyAll,
  addMana,
  counterSpell,
  discardCard,
  createToken,
  tapTarget,
  returnFromGraveyard,
});

/** The set of primitive ids this package provides (for validation). */
export const CORE_PRIMITIVE_IDS: readonly string[] = Object.keys(CORE_PRIMITIVES);

/**
 * Register every core primitive on `registry` (self-registration into the §2
 * effect seam). Idempotent — re-registering overwrites with the same function.
 */
export function registerCoreEffects(registry: EffectRegistry): void {
  for (const [id, primitive] of Object.entries(CORE_PRIMITIVES)) {
    registry.register(id, primitive);
  }
}
