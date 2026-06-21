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
  CardDefinition,
  CardInstance,
  EffectContext,
  EffectPrimitive,
  EffectRegistry,
  GameState,
  InstanceId,
  KeywordFlags,
  PlayerId,
  TriggeredAbility,
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

/**
 * Read a `keywords` param (a `KeywordFlags`-shaped object, e.g. `{ trample: true }`)
 * keeping only the boolean-true flags. Used by `grantKeywordUntilEndOfTurn`. A
 * missing/ill-typed param yields an empty grant (safe no-op).
 */
function keywordsParam(ctx: EffectContext): KeywordFlags {
  const v = ctx.params.keywords;
  if (typeof v !== 'object' || v === null) return {};
  const src = v as Record<string, unknown>;
  const out: Record<string, boolean> = {};
  for (const key in src) {
    if (src[key] === true) out[key] = true;
  }
  return out as KeywordFlags;
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
 * `drawCards` — a player draws `params.count` cards. Defaults to the controller;
 * `params.whichPlayer: 'opponent'` makes the controller's opponent draw instead
 * (e.g. Goblin Guide's attack trigger gives the defending player a card). Drawing
 * from an empty library flags a loss via SBA on the next check (we move the top
 * card or stop). Used by Brainstorm (3), Ponder (1), Cryptic Command (1).
 */
export const drawCards: EffectPrimitive = (ctx) => {
  const count = intParam(ctx, 'count', 1);
  const drawer = strParam(ctx, 'whichPlayer') === 'opponent' ? otherPlayer(ctx.controller) : ctx.controller;
  const player = ctx.state.players[drawer];
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
    ctx.emit({ type: 'drawCard', player: drawer, instanceId: top.instanceId });
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
 * `pumpUntilEndOfTurn` — give a creature +X/+Y *until end of turn* (DESIGN §3.9).
 * Reads `params.power` / `params.toughness`. With engine-v2's continuous-effects
 * layer this registers a real "until end of turn" modification via
 * `ctx.addContinuousEffect`, so the buff changes effective P/T (and combat math)
 * immediately AND genuinely wears off in the cleanup step — no more persistent
 * +1/+1-counter hack that biased combat sims (DESIGN §3.9 / §3.2 revisit).
 *
 * Target resolution: the first creature target among `ctx.targets` (a combat trick
 * like Giant Growth), or — when no target was chosen — the source itself (a
 * cast-trigger pumping its own permanent, e.g. prowess). A pump with no valid
 * creature anywhere → safe no-op. Asymmetric pumps (+X/+Y, X≠Y) are now fully
 * faithful since power and toughness are independent deltas.
 */
export const pumpUntilEndOfTurn: EffectPrimitive = (ctx) => {
  const power = intParam(ctx, 'power', 0);
  const toughness = intParam(ctx, 'toughness', 0);
  if (power === 0 && toughness === 0) return;
  const target = firstPermanentTarget(ctx) ?? selfIfCreature(ctx);
  if (!target || !isCreature(target.def)) return;
  ctx.addContinuousEffect({ target: target.instanceId, power, toughness, duration: 'endOfTurn' });
};

/**
 * `grantKeywordUntilEndOfTurn` — grant the target creature (or, with no target, the
 * source) one or more keywords *until end of turn* (DESIGN §3.9): e.g. trample,
 * flying, or haste for the turn. Reads `params.keywords` (a `{ flying: true, … }`
 * flag object). Registered through the continuous layer so combat/legality read the
 * effective keyword set and the grant expires at cleanup. No valid creature → no-op.
 */
export const grantKeywordUntilEndOfTurn: EffectPrimitive = (ctx) => {
  const keywords = keywordsParam(ctx);
  if (isEmptyKeywords(keywords)) return;
  const target = firstPermanentTarget(ctx) ?? selfIfCreature(ctx);
  if (!target || !isCreature(target.def)) return;
  ctx.addContinuousEffect({ target: target.instanceId, keywords, duration: 'endOfTurn' });
};

/**
 * `makeToken` — create `params.count` (default 1) creature tokens under the
 * controller via engine-v2's `ctx.createToken`, so the token enters the battlefield
 * properly (summoning-sick unless it has haste) and fires ETB triggers like any
 * permanent. Token P/T, name, and keywords are all DATA from params (no magic
 * numbers): `power`/`toughness`/`name`/`keywords`. Used by cast-triggers such as
 * Young Pyromancer's "make a 1/1 red Elemental".
 */
export const makeToken: EffectPrimitive = (ctx) => {
  const count = intParam(ctx, 'count', 1);
  const power = intParam(ctx, 'power', 1);
  const toughness = intParam(ctx, 'toughness', 1);
  const name = strParam(ctx, 'name') ?? 'Token';
  const keywords = keywordsParam(ctx);
  const def: CardDefinition = {
    id: `token:${name}`,
    name,
    types: ['creature'],
    power,
    toughness,
    ...(isEmptyKeywords(keywords) ? {} : { keywords }),
  };
  for (let i = 0; i < count; i++) ctx.createToken(def);
};

/**
 * `persistReturn` — the death-return half of *persist* (DESIGN §3.9). Authored as a
 * `dies` trigger's effect: when the creature dies, return it to the battlefield
 * under its owner with a -1/-1 counter (modelled as a negative `+1/+1` counter, the
 * one counter the stat layer reads — so a 3/2 returns as a 2/1). Reads
 * `params.minusCounters` (default 1) for the magnitude.
 *
 * "Dies for good the second time": the returned body comes back as a copy whose
 * definition has had *this* persist trigger stripped (identified by the
 * `persistReturn` primitive in its effects). So when it dies again it no longer has
 * a persist trigger to fire — exactly mirroring real persist's "only if it had no
 * -1/-1 counter" guard, without relying on counter state that the engine wipes when
 * a permanent leaves the battlefield. The ETB half (e.g. Kitchen Finks' lifegain)
 * is authored as a separate `etb` trigger so it re-fires on the persist return.
 *
 * At resolution the source sits in its owner's graveyard (last-known information);
 * if it isn't there (already moved/exiled) this is a safe no-op.
 */
export const persistReturn: EffectPrimitive = (ctx) => {
  const minus = intParam(ctx, 'minusCounters', 1);
  const source = ctx.source;
  const owner = ctx.state.players[source.owner];
  const idx = owner.graveyard.findIndex((c) => c.instanceId === source.instanceId);
  if (idx < 0) return; // not in the graveyard (already left) — safe no-op
  const dead = owner.graveyard[idx]!;
  owner.graveyard.splice(idx, 1);

  // Return a copy whose definition no longer carries this persist trigger, so a
  // second death cannot re-persist (it now "has a -1/-1 counter").
  const returnedDef: CardDefinition = stripPersistTriggers(dead.def);
  const returned: CardInstance = {
    instanceId: dead.instanceId,
    def: returnedDef,
    controller: source.owner,
    owner: source.owner,
    zone: 'battlefield',
    tapped: false,
    summoningSick: isCreature(returnedDef),
    damageMarked: 0,
    markedByDeathtouch: false,
    counters: { [PLUS_ONE_COUNTER]: -Math.max(minus, 0) },
  };
  ctx.state.battlefield.push(returned);
  ctx.emit({ type: 'counterAdded', instanceId: returned.instanceId, kind: PLUS_ONE_COUNTER, amount: -Math.max(minus, 0) });
  // A battlefield entry: emit the zoneChange so ETB triggers (e.g. the lifegain
  // half of persist) observe the return through the one "enters" mechanism.
  ctx.emit({ type: 'zoneChange', instanceId: returned.instanceId, from: 'graveyard', to: 'battlefield' });
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

/** The source as a creature target (for self-pumps / self-grants), or undefined. */
function selfIfCreature(ctx: EffectContext): CardInstance | undefined {
  const self = permanentById(ctx.state, ctx.source.instanceId);
  return self && isCreature(self.def) ? self : undefined;
}

/** Whether a keyword flag object has no true flags. */
function isEmptyKeywords(k: KeywordFlags): boolean {
  for (const key in k) {
    if ((k as Record<string, unknown>)[key]) return false;
  }
  return true;
}

/**
 * A copy of `def` with every triggered ability whose effects invoke `persistReturn`
 * removed — the returned persist body must not persist again. Other triggers (e.g.
 * an ETB lifegain) are preserved so they still fire on the return.
 */
function stripPersistTriggers(def: CardDefinition): CardDefinition {
  const triggers = def.triggers;
  if (!triggers || triggers.length === 0) return def;
  const kept = triggers.filter((t: TriggeredAbility) => !abilityHasPersist(t));
  if (kept.length === triggers.length) return def;
  return { ...def, triggers: kept };
}

/** Whether a triggered ability's effects include the persist-return primitive. */
function abilityHasPersist(ability: TriggeredAbility): boolean {
  return ability.effects.some((e) => e.primitive === PERSIST_RETURN_PRIMITIVE);
}

/** The stable id under which `persistReturn` registers (also referenced by data). */
const PERSIST_RETURN_PRIMITIVE = 'persistReturn';

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
  grantKeywordUntilEndOfTurn,
  makeToken,
  persistReturn,
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
