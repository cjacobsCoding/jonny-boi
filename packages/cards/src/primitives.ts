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
 * classify it with the helpers in `./effect-helpers`.
 *
 * This module holds the primitives that decide everything themselves. The ones
 * that must ASK a player something mid-resolution (discard *which* card, put these
 * back in *what* order, do you *want* to search) live in `./choice-primitives`
 * and are merged into the same {@link CORE_PRIMITIVES} registry below.
 */

import type {
  CardDefinition,
  CardInstance,
  EffectContext,
  EffectPrimitive,
  EffectRegistry,
  PlayerId,
  TriggeredAbility,
} from '@jonny-boi/core';
import { PLUS_ONE_COUNTER, effectivePower, isCreature, isLegalTarget } from '@jonny-boi/core';
import {
  boolParam,
  changeLife,
  moveOwnedCard,
  restrictionParam,
  firstPermanentTarget,
  firstPlayerTarget,
  intParam,
  isEmptyKeywords,
  isPlayerTarget,
  keywordsParam,
  manaValueOf,
  movePermanentTo,
  otherPlayer,
  permanentById,
  selfIfCreature,
  strArrayParam,
  strParam,
} from './effect-helpers.js';
import { CHOICE_PRIMITIVES } from './choice-primitives.js';

// --- the primitives ------------------------------------------------------------

/**
 * `dealDamage` — deal `amount` damage to the chosen target. Reads `params.amount`
 * and `params.targets`, the {@link TargetRestriction} naming what the printed card
 * may point at:
 *
 *   - `'any'` (the default) — "any target": a creature or a player. Lightning Bolt.
 *   - `'creature'` — "target creature" only. Flame Slash, which must NEVER be able
 *     to point four damage at a face for one mana.
 *   - `'player'` — "target player or planeswalker" only. Lava Spike, which must
 *     never kill a creature.
 *
 * A creature target gets marked damage (SBAs destroy it if lethal); a player target
 * loses life. The restriction is already enforced when the cast is offered and when
 * it is applied (core's targeting.ts); it is re-checked HERE because a target can
 * stop being legal between cast and resolution — and because a primitive that
 * quietly ignores its own restriction would make the whole guarantee depend on
 * every caller remembering it. No valid target → safe no-op.
 */
export const dealDamage: EffectPrimitive = (ctx) => {
  const amount = intParam(ctx, 'amount', 0);
  if (amount <= 0) return;
  const target = ctx.targets[0];
  if (target === undefined) return;
  // `ctx.controller` is passed so an "opponent-only" restriction can be judged —
  // without it the check cannot tell the caster apart from their opponent.
  if (!isLegalTarget(ctx.state, restrictionParam(ctx), target, ctx.controller)) return; // illegal → fizzle

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
  if (!target) return;
  // Which permanents this may destroy comes from the DECLARED restriction, not a
  // hard-coded creature check — otherwise "destroy target artifact" would find a
  // legal artifact target and then silently do nothing to it.
  if (!isLegalTarget(ctx.state, restrictionParam(ctx), target.instanceId, ctx.controller)) return;
  if (!passesDestroyFilter(ctx, target)) return;
  destroyPermanent(ctx, target);
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
  movePermanentTo(ctx, target, 'exile');
};

/**
 * `destroyAll` — destroy every creature on the battlefield (a board wipe). Used
 * by Wrath of God. No params required. Iterates a snapshot so mutation while
 * looping is safe.
 */
export const destroyAll: EffectPrimitive = (ctx) => {
  const creatures = ctx.state.battlefield.filter((c) => isCreature(c.def));
  for (const creature of creatures) destroyPermanent(ctx, creature);
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

// --- shared internals ----------------------------------------------------------

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
    if (manaValueOf(target.def) > maxMv) return false;
  }
  return true;
}

/**
 * "Target player mills N cards" — move the top N of a library to its graveyard.
 *
 * Milling is a real clock (a decked player loses), so this moves cards through
 * the same owned-zone path a draw does rather than deleting them: a milled card
 * is in the graveyard, where graveyard effects can still see it.
 *
 * Params: `amount` (cards to mill), `self` (mill the controller instead of a
 * target — the self-mill template).
 */
export const mill: EffectPrimitive = (ctx) => {
  const amount = intParam(ctx, 'amount', 0);
  if (amount <= 0) return;
  const who = boolParam(ctx, 'self', false)
    ? ctx.controller
    : (firstPlayerTarget(ctx) ?? otherPlayer(ctx.controller));
  const player = ctx.state.players[who];
  // A library with fewer cards than the mill amount empties; the loss is the
  // engine's decking rule on the next draw, not something this primitive forces.
  const count = Math.min(amount, player.library.length);
  for (let i = 0; i < count; i++) {
    const card = player.library[0];
    if (!card) break;
    moveOwnedCard(ctx, who, card.instanceId, 'library', 'graveyard');
  }
  if (count > 0) ctx.emit({ type: 'cardsMilled', player: who, amount: count });
};

/**
 * "~ fights target creature" — each deals damage equal to its power to the other,
 * simultaneously.
 *
 * Simultaneity matters: a fight where the first death cancelled the second
 * creature's damage would let a 3/3 kill a 4/4 and survive. Both damage amounts
 * are read BEFORE either is applied, so a mutual kill kills both — which is what
 * the printed card does.
 */
export const fight: EffectPrimitive = (ctx) => {
  const self = selfIfCreature(ctx);
  const other = firstPermanentTarget(ctx);
  if (!self || !other || !isCreature(other.def)) return;
  if (self.instanceId === other.instanceId) return; // a creature cannot fight itself

  const selfPower = effectivePower(self);
  const otherPower = effectivePower(other);

  if (otherPower > 0) {
    self.damageMarked += otherPower;
    ctx.emit({
      type: 'damageDealt',
      source: other.instanceId,
      target: self.instanceId,
      amount: otherPower,
      combat: false,
    });
  }
  if (selfPower > 0) {
    other.damageMarked += selfPower;
    ctx.emit({
      type: 'damageDealt',
      source: self.instanceId,
      target: other.instanceId,
      amount: selfPower,
      combat: false,
    });
  }
  // Death is the engine's state-based check, exactly as with combat damage.
};

/**
 * Damage split across a whole group at once — "deals N damage to each creature",
 * "to each opponent", "to each creature and each player".
 *
 * One primitive rather than three because the printed templates differ only in
 * WHO is hit, and that is data: `creatures` and `opponents`/`players` flags.
 */
export const dealDamageToEach: EffectPrimitive = (ctx) => {
  const amount = intParam(ctx, 'amount', 0);
  if (amount <= 0) return;

  if (boolParam(ctx, 'creatures', false)) {
    // Snapshot first: damage is dealt simultaneously, so a creature dying to it
    // must not change who else gets hit.
    for (const creature of [...ctx.state.battlefield].filter((c) => isCreature(c.def))) {
      creature.damageMarked += amount;
      ctx.emit({
        type: 'damageDealt',
        source: ctx.source.instanceId,
        target: creature.instanceId,
        amount,
        combat: false,
      });
    }
  }

  const hitOpponents = boolParam(ctx, 'opponents', false);
  const hitEveryPlayer = boolParam(ctx, 'players', false);
  if (hitOpponents || hitEveryPlayer) {
    const victims: PlayerId[] = hitEveryPlayer
      ? [ctx.controller, otherPlayer(ctx.controller)]
      : [otherPlayer(ctx.controller)];
    for (const victim of victims) changeLife(ctx, victim, -amount);
  }
};

/**
 * "Put N +1/+1 counters on target creature" — a PERMANENT stat change, unlike
 * `pumpUntilEndOfTurn`, which wears off at cleanup.
 *
 * Restricted to +1/+1 (and its negative, -1/-1) on purpose. Those are the two
 * the stat layer genuinely reads, so they really change power and toughness. A
 * charge or loyalty counter would be *stored* and read by nothing, producing a
 * card that looks implemented and does nothing — so those keep reporting as
 * unsupported instead.
 *
 * Params: `amount` (may be negative for -1/-1), `self` (counter the source
 * rather than a target — the "enters with counters on it" template).
 */
export const addCounters: EffectPrimitive = (ctx) => {
  const amount = intParam(ctx, 'amount', 0);
  if (amount === 0) return;
  const target = boolParam(ctx, 'self', false)
    ? selfIfCreature(ctx)
    : (firstPermanentTarget(ctx) ?? selfIfCreature(ctx));
  if (!target || !isCreature(target.def)) return;

  const current = target.counters[PLUS_ONE_COUNTER] ?? 0;
  target.counters[PLUS_ONE_COUNTER] = current + amount;
  ctx.emit({
    type: 'counterAdded',
    instanceId: target.instanceId,
    kind: PLUS_ONE_COUNTER,
    amount,
  });
};

/**
 * Destroy a permanent: move it to its owner's graveyard.
 *
 * `creatureDied` is emitted only for an actual creature — it is what death
 * triggers key off, and firing it for a destroyed artifact would make a "when a
 * creature dies" ability trigger on something that never was one.
 */
function destroyPermanent(ctx: EffectContext, permanent: CardInstance): void {
  movePermanentTo(ctx, permanent, 'graveyard');
  if (isCreature(permanent.def)) {
    ctx.emit({ type: 'creatureDied', instanceId: permanent.instanceId, name: permanent.def.name });
  }
}

// --- the canonical primitive id registry ---------------------------------------

/**
 * Every primitive keyed by its stable id (the `EffectRef.primitive` value cards
 * reference) — the primitives above plus the choice-driven half from
 * `./choice-primitives`. Adding a primitive = adding one entry to one of those two
 * maps + the data that uses it; there is still exactly ONE registry to register.
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
  createToken,
  tapTarget,
  mill,
  fight,
  dealDamageToEach,
  addCounters,
  ...CHOICE_PRIMITIVES,
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
