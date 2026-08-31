/**
 * What an EFFECT would be worth **right now** — "do I want this to happen, on this
 * board, from where I am sitting?" as a single number.
 *
 * ## Why this exists
 * A modal spell hands the pilot a menu whose entries are opaque labels
 * (`ChoiceMode` is `{ id, label }` and nothing more, because a choice must be
 * renderable by a UI that knows no rules). Taking the first K in printed order —
 * what the pilot used to do — is the same mistake as casting a removal spell with
 * no target: Cryptic Command would counter-and-bounce a Forest rather than draw a
 * card, every time, because "counter" and "bounce" are printed first.
 *
 * So the pilot reads the modal card's OWN DATA (the `modes` param on the effect ref
 * being resolved) and prices each mode's effects against the live board. That keeps
 * the rule general: a mode is scored by the primitives it runs, so the next modal
 * card ever authored is evaluated correctly with no change here (DESIGN §1
 * data-driven, §2 primitives-by-id).
 *
 * ## The vocabulary is the pilot's existing one
 * Every score is expressed in `HeuristicWeights` — the SAME scale the main-phase
 * spell scoring uses (removal ≈ 60, develop ≈ 40, generic ≈ 25, pass = 0), and
 * cards are priced with the same `cardValue` ruler that answers "which card do I
 * discard". There is no parallel scoring system here, only new *named* weights for
 * the categories the pilot had never had to price before (drawing a card, bouncing
 * a permanent, tapping a board).
 *
 * ## Robustness + determinism
 * A primitive id this build does not recognise scores `modeUnknownEffectScore`
 * rather than throwing or scoring zero — an unrecognised mode is probably still
 * *doing something*, and a pilot must never crash on new data. Nothing here reads
 * a clock or an RNG: the same state always yields the same numbers, which is what
 * keeps a seeded sim reproducible.
 */

import type {
  CardDefinition,
  CardInstance,
  EffectRef,
  GameState,
  InstanceId,
  InterveningIf,
  ManaCost,
  PlayerId,
  TargetRestriction,
} from '@jonny-boi/core';
import {
  canAffordManaCost,
  interveningIfHolds,
  convertedManaCost,
  isCreature,
  MANA_COLORS,
  legalTargetsFor,
  matchesCardFilter,
  modalSpecOf,
  opponentOf,
  PLAYER_IDS,
} from '@jonny-boi/core';
import type { CardFilter } from '@jonny-boi/core';
import { cardValue, findInstance, type CardValueContext } from './card-value.js';
import type { ContinuousIndex } from './board-stats.js';
import { boardIndex, keywordsOf, power as effPower, statTotal, toughnessLeft } from './board-stats.js';
import type { HeuristicWeights } from './weights.js';

/**
 * Everything a scorer needs: the board, whose side we are scoring for, and the
 * targets the spell locked in when it went on the stack (a mode's effects act on
 * the resolution's targets — that is why "return target permanent" can be a bad
 * mode even though bouncing is generally good).
 */
export interface EffectValueContext {
  readonly state: GameState;
  /** The player the value is measured FOR — positive means "good for them". */
  readonly player: PlayerId;
  /** Targets chosen at cast time (instance ids and/or player ids). */
  readonly targets: readonly (InstanceId | PlayerId)[];
  readonly weights: HeuristicWeights;
  /** Board context for `cardValue`, precomputed once per decision. */
  readonly cards: CardValueContext;
  /**
   * The board's continuous aggregate, precomputed once per decision alongside
   * `cards`. Every P/T this module prices is read through it, so an anthem, an
   * Equipment or a `*` P/T box is worth what it actually is — a removal spell
   * pointed at an anthem-boosted creature is priced at the creature's real size.
   */
  readonly index: ContinuousIndex;
}

/** The total value of running a list of effect refs, in order. */
export function valueOfEffects(refs: readonly EffectRef[], ctx: EffectValueContext): number {
  let total = 0;
  for (const ref of refs) total += valueOfEffect(ref, ctx);
  return total;
}

/**
 * The value of one effect ref — a registry lookup, never a chain of `if`s.
 *
 * TWO tables, one lookup order: `EFFECT_VALUE` always applies;
 * `LEDGERED_EFFECT_VALUE` (the §3.52 prices for what the §3.49 ledger carried)
 * applies only while `weights.priceLedgeredEffects` is on. The gate costs
 * nothing on the ids the first table already prices — the boolean is read only
 * on a first-table miss — and turning it off reproduces the pre-§3.52 model
 * exactly, which is what keeps the §3.52 A/B re-runnable in one process.
 */
export function valueOfEffect(ref: EffectRef, ctx: EffectValueContext): number {
  const score =
    EFFECT_VALUE[ref.primitive] ??
    (ctx.weights.priceLedgeredEffects ? LEDGERED_EFFECT_VALUE[ref.primitive] : undefined);
  return score ? score(ref.params ?? EMPTY_PARAMS, ctx) : ctx.weights.modeUnknownEffectScore;
}

const EMPTY_PARAMS: Readonly<Record<string, unknown>> = Object.freeze({});

/**
 * The instance id `substituteIf`'s ruler hands `interveningIfHolds` when no
 * source is known: no battlefield object ever carries it, so a source-reading
 * condition resolves false and the base branch is priced.
 */
const NO_SOURCE_INSTANCE: InstanceId = -1;

/** Food's printed "You gain 3 life", mirrored from the cards package's def. */
const FOOD_TOKEN_LIFE_GAIN = 3;

/** One entry in the value registry: price this effect's params on this board. */
type EffectValuer = (params: Readonly<Record<string, unknown>>, ctx: EffectValueContext) => number;

// --- param readers (mirroring `cards`' effect-helpers, without depending on it) ---

function intParam(params: Readonly<Record<string, unknown>>, key: string, fallback: number): number {
  const v = params[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function strParam(params: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const v = params[key];
  return typeof v === 'string' ? v : undefined;
}

function boolParam(params: Readonly<Record<string, unknown>>, key: string): boolean {
  return params[key] === true;
}

function strArrayParam(params: Readonly<Record<string, unknown>>, key: string): readonly string[] {
  const v = params[key];
  return Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [];
}

/**
 * Read a `ManaCost`-shaped param (the "unless its controller pays {3}" rider).
 * Mirrors `cards`' own reader: only the fields core charges for, and an empty or
 * ill-typed cost reads as absent rather than as a free payment.
 */
function manaCostParam(params: Readonly<Record<string, unknown>>, key: string): ManaCost | undefined {
  const v = params[key];
  if (typeof v !== 'object' || v === null) return undefined;
  const src = v as Record<string, unknown>;
  const cost: Record<string, number> = {};
  for (const field of ['generic', ...MANA_COLORS]) {
    const amount = src[field];
    if (typeof amount === 'number' && Number.isFinite(amount) && amount > 0) cost[field] = amount;
  }
  return Object.keys(cost).length > 0 ? (cost as ManaCost) : undefined;
}

/** Read a `CardFilter`-shaped param (what a sacrifice/discard may pick from). */
function filterParamOf(params: Readonly<Record<string, unknown>>): CardFilter | undefined {
  const v = params.filter;
  return typeof v === 'object' && v !== null ? (v as CardFilter) : undefined;
}

/**
 * Resolve the player an effect acts on from its `who`-style param, mirroring the
 * `cards` primitives' own convention. `'all'` is not a single seat and is handled
 * by its caller.
 */
function subjectPlayer(
  params: Readonly<Record<string, unknown>>,
  key: string,
  fallback: 'controller' | 'opponent' | 'targetPlayer',
  ctx: EffectValueContext,
): PlayerId | undefined {
  switch (strParam(params, key) ?? fallback) {
    case 'opponent':
      return opponentOf(ctx.player);
    case 'targetPlayer':
      return firstPlayerTarget(ctx) ?? opponentOf(ctx.player);
    case 'targetController':
      return firstTargetPermanent(ctx)?.controller;
    default:
      return ctx.player;
  }
}

// --- target readers ---------------------------------------------------------------

function firstPlayerTarget(ctx: EffectValueContext): PlayerId | undefined {
  for (const t of ctx.targets) if (t === 'A' || t === 'B') return t;
  return undefined;
}

/** The first targeted permanent still on the battlefield, if any. */
function firstTargetPermanent(ctx: EffectValueContext): CardInstance | undefined {
  for (const t of ctx.targets) {
    if (t === 'A' || t === 'B') continue;
    const perm = ctx.state.battlefield.find((c) => c.instanceId === t);
    if (perm) return perm;
  }
  return undefined;
}

/** The first targeted SPELL still on the stack, if any. */
function firstTargetSpell(ctx: EffectValueContext) {
  return spellOnStackAmong(ctx, ctx.targets);
}

/** The first of `targets` that is a spell still on the stack, if any. */
function spellOnStackAmong(ctx: EffectValueContext, targets: readonly (InstanceId | PlayerId)[]) {
  for (const t of targets) {
    if (t === 'A' || t === 'B') continue;
    const obj = ctx.state.stack.find((o) => o.kind === 'spell' && o.instanceId === t);
    if (obj && obj.kind === 'spell') return obj;
  }
  return undefined;
}

/** A spell sitting on the stack — what the copy-chain walk below moves between. */
type SpellOnStack = NonNullable<ReturnType<typeof firstTargetSpell>>;

/**
 * The primitive a copy spell runs. Named once so this file and the pilot's
 * copy-aiming code cannot drift apart on a bare string.
 */
const COPY_SPELL_PRIMITIVE = 'copySpell';

/**
 * How many copy-of-a-copy links to follow before calling the chain worthless.
 * Its job is to stop two copy spells aimed at each other from recursing, not to
 * model play — no real board stacks this many.
 */
const MAX_COPY_CHAIN_LINKS = 4;

/**
 * What a COPY of `spell` actually delivers — which is NOT `cardValue(spell)`.
 *
 * A copy of a COPY SPELL does nothing on its own: it resolves, copies whatever
 * its own target is, and hands the real work one step further down. So the chain
 * is walked to the non-copy spell it bottoms out at, and each extra link costs
 * {@link HeuristicWeights.modeCopyChainPenalty} — one more resolution that puts
 * nothing on the board, and one more chance to fizzle on the way.
 *
 * Pricing a copy spell at its face value instead is what let two copy spells
 * aimed at each other look like the best target available, forever: every copy
 * made another copy, neither original ever reached the top of the stack, and
 * three full-pool soak games burned the 6,000-action cap ~1,850 copies deep.
 */
function copyPayloadValue(ctx: EffectValueContext, spell: SpellOnStack, links: number): number {
  if (willFizzleOnResolution(ctx, spell.targets)) return 0;
  // `effects` is optional on a CardDefinition — a spell with none copies nothing,
  // so it is priced as the plain card it is rather than throwing here.
  const copiesSomething = (spell.card.def.effects ?? []).some(
    (e) => e.primitive === COPY_SPELL_PRIMITIVE,
  );
  if (!copiesSomething) return cardValue(spell.card, ctx.weights, ctx.cards);
  if (links >= MAX_COPY_CHAIN_LINKS) return 0;
  const next = spellOnStackAmong(ctx, spell.targets ?? []);
  if (!next) return 0; // it copies nothing that is still there — a dead copy
  return Math.max(0, copyPayloadValue(ctx, next, links + 1) - ctx.weights.modeCopyChainPenalty);
}

/**
 * Will a spell with these targets be countered on resolution for having none of
 * them left (CR 608.2b)?
 *
 * "None", not "any": a spell with several targets still resolves for the ones
 * that remain, so only a spell that has lost EVERY target is dead. A spell that
 * never targeted anything is not targeting-dependent and always resolves.
 *
 * A player target is always still there — players do not leave the game here —
 * so only object targets are looked up, in the two zones a spell's target can
 * still be sitting in when the question is asked.
 */
function willFizzleOnResolution(
  ctx: EffectValueContext,
  targets: readonly (InstanceId | PlayerId)[] | undefined,
): boolean {
  if (!targets || targets.length === 0) return false;
  return !targets.some((target) => {
    if (target === 'A' || target === 'B') return true;
    if (ctx.state.battlefield.some((permanent) => permanent.instanceId === target)) return true;
    return ctx.state.stack.some((object) => object.instanceId === target);
  });
}

// --- shared pricing --------------------------------------------------------------

/**
 * What removing an opposing permanent from the board is worth — the same formula
 * the main-phase pilot uses to pick a removal target, so "kill the biggest threat"
 * means one thing across the whole pilot.
 */
function removalValue(perm: CardInstance, weights: HeuristicWeights, index: ContinuousIndex): number {
  return weights.removalBaseScore + weights.removalPerPowerOfTarget * effPower(perm, index);
}

/**
 * Whether this permanent shrugs off an effect that says "destroy".
 *
 * Read through the continuous layer rather than off `def.keywords`, so a granted
 * indestructible — the whole point of Heroic Intervention — is seen. A mode
 * chooser that reads the printed set picks "destroy their board" into a board it
 * cannot touch. The decision's index is reused rather than `aggregateFor` being
 * called per permanent: that helper is a whole battlefield pass, and this runs
 * once per creature on the board for a sweeper mode.
 */
function isIndestructible(ctx: EffectValueContext, perm: CardInstance): boolean {
  return Boolean(keywordsOf(perm, ctx.index).indestructible);
}

/** The mana value of a permanent's printed card (a token has none). */
function permanentManaValue(perm: CardInstance): number {
  return perm.def.cost ? convertedManaCost(perm.def.cost) : 0;
}

/**
 * Every effect that hits a chosen permanent shares one shape: it is worth
 * something when it hits THEIRS and is a mistake when it hits OURS. Pointing a
 * mode at your own board is not merely worthless, it is a real cost, so it scores
 * negative and loses to every other mode on the menu.
 */
function againstTarget(
  ctx: EffectValueContext,
  value: (perm: CardInstance) => number,
): number {
  const perm = firstTargetPermanent(ctx);
  if (!perm) return 0; // nothing to hit — this mode does nothing at all
  if (perm.controller === ctx.player) return -ctx.weights.modeSelfHarmPenalty;
  return value(perm);
}

// --- the value registry -----------------------------------------------------------

/**
 * Prices for the effect primitives the card pool actually registers, keyed by the
 * SAME ids the primitives register under (DESIGN §2 — a typo'd id here silently
 * degrades a mode to "unknown", exactly the failure mode `heuristic.ts` documents
 * for `destroyTarget`).
 */
const EFFECT_VALUE: Readonly<Record<string, EffectValuer>> = Object.freeze({
  /**
   * Countering costs the opponent the whole card, so it is priced as removal plus
   * what that specific card was worth. Countering your own spell is the classic
   * "took the printed-first mode" blunder, and is scored as the mistake it is.
   */
  counterSpell: (_params, ctx) => {
    const spell = firstTargetSpell(ctx);
    if (!spell) return 0; // already resolved / never on the stack — a dead mode
    if (spell.controller === ctx.player) return -ctx.weights.modeSelfHarmPenalty;
    return ctx.weights.removalBaseScore + cardValue(spell.card, ctx.weights, ctx.cards);
  },

  /**
   * COPYING A SPELL (CR 707.10) is worth **whatever the copy will actually
   * deliver**, priced by the pilot's one card ruler — a copy of a Cryptic
   * Command is worth a Cryptic Command, and a copy of a cantrip is worth a
   * cantrip. That is what makes a pilot hold a Reverberate for something big
   * instead of spending it on the first instant it sees.
   *
   * "Deliver", not "the copied card's face value", because those differ for the
   * one card type that matters here: copying a COPY SPELL delivers only whatever
   * sits at the end of its chain. See {@link copyPayloadValue}.
   *
   * The sign is the interesting half and it is the OPPOSITE of a counterspell's:
   * countering your OWN spell is the classic printed-first-mode blunder, while
   * copying your own spell is the play the card is FOR. Copying an OPPONENT'S
   * spell is also fine (the copy is yours — CR 707.10), so neither controller
   * earns a penalty here; what earns zero is copying nothing, which is what a
   * dead mode is worth.
   */
  copySpell: (params, ctx) => {
    const spell = firstTargetSpell(ctx);
    if (!spell) return 0; // nothing on the stack — a dead mode
    const count = Math.max(intParam(params, 'count', 1), 0);
    return count * copyPayloadValue(ctx, spell, 0);
  },

  /**
   * COPYING A TRIGGERED ABILITY is worth what the ability itself delivers — the
   * same principle §3.33 established for spell copies, which is that a copy is
   * worth its PAYLOAD and never a flat "copies are good" bonus.
   *
   * Priced by recursing into the trigger's own effects with the targets it is
   * actually aimed at, so copying "draw a card" is worth a card and copying a
   * trigger whose target has gone is worth nothing.
   *
   * ⚠️ The recursion is bounded by construction, unlike the spell case: a
   * trigger's effects are read from the ability, and `copyTriggeredAbility` is
   * an ACTIVATED ability that no trigger prints, so a copied trigger can never
   * itself be another trigger-copy. There is no mirror to guard against here —
   * but if a card ever prints one, this is the line that has to grow the same
   * chain-depth guard `copyPayloadValue` carries.
   */
  copyTriggeredAbility: (params, ctx) => {
    const target = ctx.targets?.[0];
    if (target === undefined || target === 'A' || target === 'B') return 0;
    const trigger = ctx.state.stack.find(
      (o) => o.kind === 'trigger' && o.instanceId === target,
    );
    if (!trigger || trigger.kind !== 'trigger') return 0; // gone — a dead activation
    const count = Math.max(intParam(params, 'count', 1), 0);
    return count * valueOfEffects(trigger.effects, { ...ctx, targets: [...trigger.targets] });
  },

  /**
   * A TOKEN COPY is worth a creature of the copied body's size, priced through
   * the SAME formula `makeToken` uses so "a 4/4 token" means one thing to this
   * pilot however it was made.
   *
   * ⚠️ It reads the copied permanent's PRINTED power and toughness, not its
   * effective ones — the same trap `copyTargetValue` exists for on the as-enters
   * path. Reading effective stats would have a pilot copy the 1/1 wearing three
   * +1/+1 counters over the printed 4/4 beside it and end up with a 1/1, because
   * CR 707.2 copies the printed card and counters are not copiable.
   */
  createTokenCopy: (params, ctx) => {
    const source = tokenCopySource(ctx);
    if (!source) return 0;
    // The BASE count, deliberately: this is asked while the pilot is deciding
    // whether to CAST, and the kicker has not been paid (or even offered) yet.
    // Pricing Rite of Replication's kicked five here would have the pilot value
    // a spell it has not agreed to pay for — the kicker is its own question,
    // answered by the pilot's kicker policy on its own terms.
    const count = Math.max(intParam(params, 'count', 1), 0);
    const stats = (source.def.power ?? 0) + (source.def.toughness ?? 0);
    /*
     * ⚠️ A TOKEN THE CARD SACRIFICES AT END OF TURN IS NOT A CREATURE, AND
     * PRICING IT AS ONE IS THE WHOLE TRAP (CR 603.7 — Kiki-Jiki, Molten
     * Duplication, The Fire Crystal). What that activation buys is ONE ATTACK,
     * and the printed cards say so out loud by granting the token haste in the
     * same breath. A pilot that valued it as a permanent body would tap
     * Kiki-Jiki in its main phase with nothing to attack into and hand the
     * opponent a free turn.
     *
     * So the temporary token is priced as the face damage it can actually
     * deliver — and a temporary token that CANNOT attack (no haste from the
     * copy's "except" tail, from a follow-up grant, or from the copied card
     * itself) is worth nothing at all, which is the honest answer: it arrives
     * summoning-sick and is sacrificed before it could ever be untapped.
     */
    if (params.delayedRemoval !== undefined) {
      return temporaryTokenCanAttack(params, source.def)
        ? count * ctx.weights.faceDamageValue * Math.max(source.def.power ?? 0, 0)
        : 0;
    }
    return count * (ctx.weights.castCreatureBaseScore + ctx.weights.castCreaturePerStat * stats);
  },

  /**
   * Returning the targeted SPELL to its owner's hand (Narset's Reversal) is
   * tempo against an opponent and a straight loss against yourself: they get the
   * card back either way, so it is priced as the bounce it is, and aiming it at
   * your own spell is the same blunder countering your own spell is.
   */
  returnSpellToHand: (_params, ctx) => {
    const spell = firstTargetSpell(ctx);
    if (!spell) return 0;
    if (spell.controller === ctx.player) return -ctx.weights.modeSelfHarmPenalty;
    return cardValue(spell.card, ctx.weights, ctx.cards);
  },

  /**
   * The SOFT counter is the hard counter's price, **scaled by whether it will
   * actually counter anything**: "unless its controller pays {3}" against an
   * opponent with three untapped lands mostly taxes them, and against a tapped-out
   * opponent it is a Counterspell.
   *
   * Affordability is asked of `canAffordManaCost` — the very function the engine
   * will use to decide whether that player is even offered the payment — rather
   * than re-derived here, so the pilot cannot price a payment the engine would not
   * offer (or miss one it would).
   */
  counterUnlessPaid: (params, ctx) => {
    const spell = firstTargetSpell(ctx);
    if (!spell) return 0;
    if (spell.controller === ctx.player) return -ctx.weights.modeSelfHarmPenalty;
    const full = ctx.weights.removalBaseScore + cardValue(spell.card, ctx.weights, ctx.cards);
    const cost = manaCostParam(params, 'unlessPaid');
    if (!cost) return full; // no rider — it is simply a counter
    return canAffordManaCost(ctx.state, spell.controller, cost)
      ? full * ctx.weights.softCounterPayableFactor
      : full;
  },

  /**
   * Bouncing is tempo, not removal: they get the card back, so it is priced by what
   * it costs them to REDEPLOY (mana value) plus the pressure it takes off the board
   * (power). That is what makes bouncing a land or a mana dork worth less than
   * drawing a card, and bouncing a five-drop worth more.
   */
  returnToHand: (_params, ctx) =>
    againstTarget(ctx, (perm) => {
      const weights = ctx.weights;
      const redeploy = weights.modeBouncePerManaValue * permanentManaValue(perm);
      const pressure = isCreature(perm.def) ? weights.removalPerPowerOfTarget * effPower(perm, ctx.index) : 0;
      return weights.modeBounceBaseScore + redeploy + pressure;
    }),

  /**
   * Same shape as a bounce, but the card is gone for good — UNLESS the thing it
   * points at is indestructible, in which case the mode does literally nothing
   * (CR 702.12b) and must score as the blank it is. Exile has no such exemption,
   * which is exactly why the two are not one entry.
   */
  destroyTarget: (_params, ctx) =>
    againstTarget(ctx, (perm) =>
      isIndestructible(ctx, perm) ? 0 : removalValue(perm, ctx.weights, ctx.index),
    ),
  exileTarget: (_params, ctx) => againstTarget(ctx, (perm) => removalValue(perm, ctx.weights, ctx.index)),

  /**
   * BLINK — "exile it, then return it". Priced by what re-entering is WORTH,
   * which is the enters trigger it fires again (and the leaves trigger it fires
   * on the way out — blinking Thragtusk collects both halves).
   *
   * Deliberately NOT routed through `againstTarget`: that prices hitting an
   * OPPONENT'S permanent and penalises aiming at your own, which is backwards
   * here. A blink is something you do TO YOUR OWN board, and the self-harm
   * penalty would have made every legal aim negative.
   *
   * ⚠️ A TOKEN is the trap. Blinking one destroys it outright (CR 111.7 — it
   * ceases to exist in exile and nothing returns), so it is priced as the loss
   * of a creature rather than as zero. Without this the whole table answered 0
   * for every candidate, the pilot fell through to the FIRST offered one, and
   * Conjurer's Closet spent its trigger eating its own Soldier tokens — measured
   * at ~10 destroyed tokens per 40 games before this entry existed.
   */
  /**
   * "YOU MAY <body>" — worth exactly what the body is worth.
   *
   * ⚠️ Its absence made every optional card invisible to the pilot. An unknown
   * primitive scores `modeUnknownEffectScore`, so `mayEffects` answered a flat
   * constant and the nested body was never looked at — which meant a pilot
   * AIMING an optional trigger scored every candidate identically and fell
   * through to the FIRST one offered. Conjurer's Closet ate its own Soldier
   * tokens that way (9 of them per 40 games) while a Thragtusk stood next to it.
   *
   * Recursing is the whole fix, and it is safe in both directions: the option to
   * DECLINE is answered elsewhere (`answerConfirm` reads the same value and says
   * no to a negative one), so pricing the body here cannot force a bad "yes" —
   * it only lets the pilot tell two candidates apart.
   */
  mayEffects: (params, ctx) => {
    const inner = params['effects'];
    return Array.isArray(inner) ? valueOfEffects(inner as readonly EffectRef[], ctx) : 0;
  },

  /**
   * "YOU MAY <cost>. IF YOU DO, <payoff>" — both halves priced and SUMMED,
   * exactly the trade the confirm decides: the cost's own entry carries its
   * negative sign, so a payoff that does not cover it prices below zero and
   * `answerConfirm` declines. Same recursion contract as `mayEffects`.
   */
  mayCostEffects: (params, ctx) => {
    const cost = params['cost'];
    const payoff = params['effects'];
    return (
      (Array.isArray(cost) ? valueOfEffects(cost as readonly EffectRef[], ctx) : 0) +
      (Array.isArray(payoff) ? valueOfEffects(payoff as readonly EffectRef[], ctx) : 0)
    );
  },

  blinkTarget: (_params, ctx) => {
    const perm = firstTargetPermanent(ctx);
    if (!perm) return 0;
    if (perm.def.isToken === true) {
      return -removalValue(perm, ctx.weights, ctx.index);
    }
    const triggers = perm.def.triggers ?? [];
    let worth = 0;
    for (const trigger of triggers) {
      if (trigger.condition.on !== 'etb' && trigger.condition.on !== 'leaves') continue;
      worth += valueOfEffects(trigger.effects, { ...ctx, targets: [] });
    }
    // A body with nothing to re-trigger comes back summoning sick and shorn of
    // its counters, so blinking it is a small loss rather than a neutral move.
    return worth > 0 ? worth : -ctx.weights.modeSelfHarmPenalty;
  },

  /** Tapping one permanent is a fraction of tapping a board; price it per power. */
  tapTarget: (_params, ctx) =>
    againstTarget(ctx, (perm) =>
      perm.tapped ? 0 : ctx.weights.modeTapPerPowerValue * Math.max(effPower(perm, ctx.index), 1),
    ),

  /**
   * A sweeper is worth the enemy board it clears, less our own board it takes with
   * it — the same "kill theirs / lose ours" trade the combat code weighs, scaled
   * onto the spell-score scale by the per-power removal weight.
   */
  destroyAll: (_params, ctx) => {
    const weights = ctx.weights;
    let net = 0;
    for (const perm of ctx.state.battlefield) {
      if (!isCreature(perm.def)) continue;
      // A wipe neither clears their indestructible creatures nor costs us ours,
      // so neither side of the trade includes them.
      if (isIndestructible(ctx, perm)) continue;
      const stats = statTotal(perm, ctx.index);
      net += perm.controller === ctx.player ? -stats * weights.ownCreatureLossPerStat : stats * weights.killEnemyPerStat;
    }
    return net * weights.removalPerPowerOfTarget;
  },

  /**
   * Tap all creatures a scope controls — Cryptic's Falter/fog mode. Only UNTAPPED
   * creatures are affected, so an empty or already-tapped board makes the mode
   * worth nothing, which is exactly when drawing a card should beat it.
   */
  tapPermanents: (params, ctx) => {
    const weights = ctx.weights;
    const everyone = strParam(params, 'who') === 'all';
    const scope = everyone ? undefined : subjectPlayer(params, 'who', 'opponent', ctx);
    if (!everyone && scope === undefined) return 0;
    const types = strArrayParam(params, 'types');
    const wanted = types.length > 0 ? types : DEFAULT_TAP_TYPES;
    let value = 0;
    for (const perm of ctx.state.battlefield) {
      if (scope !== undefined && perm.controller !== scope) continue;
      if (perm.tapped) continue;
      const types: readonly string[] = perm.def.types;
      if (!wanted.some((t) => types.includes(t))) continue;
      const weight = weights.modeTapPerPowerValue * Math.max(effPower(perm, ctx.index), 1);
      value += perm.controller === ctx.player ? -weight : weight;
    }
    return value;
  },

  /**
   * Cards are the currency the control decks are playing for, so a draw has real,
   * board-independent value — EXCEPT when the library cannot pay for it, where the
   * same mode loses the game on the next draw step.
   */
  drawCards: (params, ctx) => {
    const weights = ctx.weights;
    const count = intParam(params, 'count', 1);
    if (count <= 0) return 0;
    if (ctx.state.players[ctx.player].library.length < count) return -weights.modeSelfDeckPenalty;
    return weights.modeDrawCardValue * count;
  },

  /** Life is cheap at a healthy total and priceless when the clock is on us. */
  /**
   * PREVENTION — a fog, or a mode of one (Dawn Charm's first bullet). Its value
   * is not a property of the card: it is exactly the damage it stops, which is
   * ZERO unless an attack has already been declared against us. So this asks the
   * same three questions the main-phase scorer does, in one place, and answers
   * zero cheaply the rest of the time — a modal spell whose prevention mode
   * scored a flat number would pick that mode in an empty main phase and throw
   * the card away.
   */
  preventDamage: (_params, ctx) => {
    const combat = ctx.state.combat;
    if (!combat || !combat.attackersDeclared || combat.attackers.length === 0) return 0;
    if (ctx.state.activePlayer === ctx.player) return 0; // we are the attacker
    const index = boardIndex(ctx.state);
    let incoming = 0;
    for (const id of combat.attackers) {
      const attacker = ctx.state.battlefield.find((c) => c.instanceId === id);
      if (attacker && attacker.controller !== ctx.player) incoming += effPower(attacker, index);
    }
    if (incoming <= 0) return 0;
    const life = ctx.state.players[ctx.player].life;
    if (incoming >= life) return ctx.weights.lethalBurnScore;
    if (incoming < ctx.weights.fogMinimumDamagePrevented && life > ctx.weights.desperateLifeThreshold) {
      return 0;
    }
    return incoming * ctx.weights.fogValuePerDamagePrevented;
  },

  gainLife: (params, ctx) => lifeSwing(intParam(params, 'amount', 0), ctx, params),
  loseLife: (params, ctx) => -lifeSwing(intParam(params, 'amount', 0), ctx, params),

  /**
   * Damage is the pilot's best-understood effect, so it is priced exactly as the
   * main phase prices a burn spell: lethal wins the game, a kill is removal, and
   * anything else is a chip.
   */
  dealDamage: (params, ctx) => {
    const weights = ctx.weights;
    const amount = intParam(params, 'amount', 0);
    if (amount <= 0) return 0;
    const playerTarget = firstPlayerTarget(ctx);
    if (playerTarget !== undefined) {
      if (playerTarget === ctx.player) return -weights.modeSelfHarmPenalty;
      return amount >= ctx.state.players[playerTarget].life ? weights.lethalBurnScore : weights.burnFaceBaseScore;
    }
    return againstTarget(ctx, (perm) =>
      toughnessLeft(perm, ctx.index) <= amount
        ? removalValue(perm, weights, ctx.index)
        : weights.removalPerPowerOfTarget * amount,
    );
  },

  /** A body on the board, priced like casting one. */
  makeToken: (params, ctx) => tokenValue(params, ctx),

  /**
   * PROLIFERATE — worth what the board offers it: one more counter on each of
   * my countered permanents (the pilot never has to pick the opponent's), plus
   * deepening any -1/-1s already on theirs. Priced per permanent at the same
   * per-stat counter weight a placed +1/+1 uses; a board with no counters at
   * all prices zero, which is exactly what the primitive does there.
   */
  proliferate: (_params, ctx) => {
    let worth = 0;
    for (const permanent of ctx.state.battlefield) {
      const counterKinds = Object.entries(permanent.counters).filter(([, count]) => count > 0);
      if (counterKinds.length === 0) continue;
      if (permanent.controller === ctx.player) {
        worth += ctx.weights.modeCounterPerStatValue * counterKinds.length;
      } else if (permanent.counters['-1/-1'] !== undefined && permanent.counters['-1/-1'] > 0) {
        worth += ctx.weights.modeCounterPerStatValue;
      }
    }
    return worth;
  },

  // "You win the game" IS the lethal outcome, priced at lethal's own weight —
  // and its mirror is the one price that must always be refused.
  winTheGame: (_params, ctx) => ctx.weights.lethalBurnScore,
  loseTheGame: (_params, ctx) => -ctx.weights.lethalBurnScore,

  /**
   * The rules-defined artifact tokens (CR 111.10). Each is a BANKED effect the
   * pilot cracks later, so each is priced as a share of the effect it banks:
   * a Clue is a draw the deck has to still afford, a Food is its printed life
   * gain, a Treasure is a mana the next spell spends — all discounted by the
   * bank's own weight because a token on the board is not the effect in hand.
   */
  createPredefinedToken: (params, ctx) => {
    const weights = ctx.weights;
    const count = Math.max(intParam(params, 'count', 1), 0);
    const kind = params['token'];
    const banked =
      kind === 'clue'
        ? weights.modeDrawCardValue
        : kind === 'food'
          ? lifeSwing(FOOD_TOKEN_LIFE_GAIN, ctx, EMPTY_PARAMS)
          : kind === 'treasure'
            ? weights.modeDrawCardValue // a floating mana ≈ the tempo of a draw
            : 0;
    return count * banked * weights.bankedEffectValueShare;
  },
  createToken: (params, ctx) => tokenValue(params, ctx),

  /**
   * Taking a card off somebody costs them exactly what that card was worth — and is
   * worth nothing at all against an empty hand.
   */
  discardCard: (params, ctx) => {
    // "Each player discards" (Liliana's +1): symmetric on paper, ours in
    // practice when we planned for it — we chose to fire it, so half-price the
    // self half. An empty opposing hand makes the whole thing worthless.
    if (strParam(params, 'who') === 'eachPlayer') {
      const base = ctx.weights.modeDiscardBaseScore;
      const theirs = ctx.state.players[opponentOf(ctx.player)].hand.length;
      const mine = ctx.state.players[ctx.player].hand.length;
      return (theirs > 0 ? base : 0) - (mine > 0 ? base / 2 : 0);
    }
    const victim = subjectPlayer(params, 'who', 'targetPlayer', ctx);
    if (victim === undefined) return 0;
    const hand = ctx.state.players[victim].hand;
    if (hand.length === 0) return 0;
    const count = Math.min(intParam(params, 'count', 1), hand.length);
    if (count <= 0) return 0;
    const worst = bestCardIn(hand, ctx);
    const value = ctx.weights.modeDiscardBaseScore + worst * count;
    return victim === ctx.player ? -value : value;
  },

  /**
   * An edict ("target player sacrifices a creature") is removal whose victim
   * picks — so it is worth their WORST qualifying body, not their best, and it
   * is worth nothing at all against an empty board.
   */
  sacrificeChosen: (params, ctx) => {
    const victim = subjectPlayer(params, 'who', 'targetPlayer', ctx);
    if (victim === undefined) return 0;
    let worst: number | undefined;
    for (const perm of ctx.state.battlefield) {
      if (perm.controller !== victim) continue;
      if (!matchesCardFilter(perm, filterParamOf(params))) continue;
      const value = removalValue(perm, ctx.weights, ctx.index);
      if (worst === undefined || value < worst) worst = value;
    }
    if (worst === undefined) return 0;
    return victim === ctx.player ? -worst : worst;
  },

  /**
   * The pile split (Liliana's −6) costs its victim about HALF their board by
   * value: a fair split loses the lesser pile, an unfair one lets the victim
   * keep the good half. Worth nothing against an empty board.
   */
  pileSplitSacrifice: (params, ctx) => {
    const victim = subjectPlayer(params, 'who', 'targetPlayer', ctx);
    if (victim === undefined) return 0;
    let total = 0;
    let any = false;
    for (const perm of ctx.state.battlefield) {
      if (perm.controller !== victim) continue;
      any = true;
      total += removalValue(perm, ctx.weights, ctx.index);
    }
    if (!any) return 0;
    const half = total / 2;
    return victim === ctx.player ? -half : half;
  },

  /** Regrowth is worth the best card actually sitting in the yard. */
  /**
   * The TARGETED graveyard move (Mortuary Mire's top-of-library, Unearth's
   * to-hand). Priced by the aimed card itself — the aim IS the decision — with
   * the library-top form worth a share of the hand form: the card still costs
   * the next draw to actually take.
   */
  moveTargetFromGraveyard: (params, ctx) => {
    let worth = 0;
    for (const target of ctx.targets) {
      if (target === 'A' || target === 'B') continue;
      const card = ctx.state.players[ctx.player].graveyard.find((c) => c.instanceId === target);
      if (card) worth += cardValue(card, ctx.weights, ctx.cards);
    }
    // Only the library-top form is discounted — the card still costs the next
    // draw to actually take; hand and battlefield deliver it now.
    return params['to'] === 'libraryTop' ? worth * ctx.weights.bankedEffectValueShare : worth;
  },

  returnFromGraveyard: (params, ctx) => {
    const who = subjectPlayer(params, 'who', 'controller', ctx);
    if (who === undefined) return 0;
    const yard = ctx.state.players[who].graveyard;
    if (yard.length === 0) return 0;
    const value = bestCardIn(yard, ctx) * Math.max(intParam(params, 'count', 1), 1);
    return who === ctx.player ? value : -value;
  },

  /**
   * A GRANTED FLASHBACK (Snapcaster's ETB) is card advantage, priced off the
   * very card it names — which is what makes the ability's aiming work: the
   * trigger's target chooser (`answerSelectTargets`) scores each graveyard
   * candidate through this entry, so the pilot points Snapcaster at its best
   * instant or sorcery rather than the first one offered.
   *
   * Discounted by `grantedFlashbackValueShare` against simply returning the
   * card (`returnFromGraveyard` above scores the full value): the grant wears
   * off at end of turn and the card still costs its mana. A grant aimed at
   * nothing — the target already gone — is worth nothing, which is also what
   * it does.
   */
  grantFlashback: (_params, ctx) => {
    const target = ctx.targets[0];
    if (target === undefined || typeof target !== 'number') return 0;
    const card = ctx.state.players[ctx.player].graveyard.find((c) => c.instanceId === target);
    if (!card) return 0;
    return cardValue(card, ctx.weights, ctx.cards) * ctx.weights.grantedFlashbackValueShare;
  },

  /** A tutor is worth roughly the best thing it could find; the library is deep. */
  searchLibrary: (params, ctx) => {
    const who = subjectPlayer(params, 'who', 'controller', ctx);
    if (who === undefined) return 0;
    if (ctx.state.players[who].library.length === 0) return 0;
    const value = ctx.weights.modeDrawCardValue * Math.max(intParam(params, 'count', 1), 1);
    return who === ctx.player ? value : -value;
  },

  /**
   * Selection without card advantage. Real, but strictly smaller than drawing —
   * priced off the same weight so the two can never invert.
   */
  reorderTopOfLibrary: (_params, ctx) => ctx.weights.modeSelectionValue,
  revealTopCard: (_params, ctx) => ctx.weights.modeSelectionValue,
  mayShuffleLibrary: () => 0, // optional and free: the pilot declines it if it is bad
  addMana: (params, ctx) => ctx.weights.modeManaPerSymbolValue * strArrayParam(params, 'mana').length,

  /** Putting your own cards back is the price half of a Brainstorm, not a payoff. */
  putFromHandOnTop: (params, ctx) => {
    const who = subjectPlayer(params, 'who', 'controller', ctx);
    if (who === undefined || who !== ctx.player) return 0;
    return -ctx.weights.modeSelectionValue * Math.max(intParam(params, 'count', 1), 1);
  },

  /**
   * A pump is a combat trick, and combat context is the main pilot's job (see
   * `bestPumpPlay`). Off the battlefield it is worth about a generic effect, and
   * pricing it higher would have modal spells choosing tricks at sorcery speed.
   */
  /**
   * A pump is the one effect on this table whose RIGHT target is your own
   * creature — which is precisely why it could not stay a flat constant once
   * abilities started being aimed: every candidate scored the same, so the first
   * one offered won, and "target creature gets +2/+2" cheerfully buffed the
   * opponent's blocker.
   *
   * A NEGATIVE pump is not a buff at all: the pool writes shrink-removal
   * (Disfigure, Last Gasp) as `pumpUntilEndOfTurn` with negative deltas, and the
   * heuristic's own spell classifier already reads it that way. So the sign of
   * the printed numbers decides which side of the table the effect wants.
   */
  pumpUntilEndOfTurn: (params, ctx) => {
    const power = intParam(params, 'power', 0);
    const toughness = intParam(params, 'toughness', 0);
    const perm = firstTargetPermanent(ctx);
    if (!perm) return 0;
    if (power < 0 || toughness < 0) {
      // Shrink-removal: worth a kill when it is lethal, a fraction when it only
      // trims, and a mistake pointed at our own board.
      if (perm.controller === ctx.player) return -ctx.weights.modeSelfHarmPenalty;
      return -toughness >= toughnessLeft(perm, ctx.index)
        ? removalValue(perm, ctx.weights, ctx.index)
        : ctx.weights.modePumpPerStatValue * -toughness;
    }
    if (perm.controller !== ctx.player) return -ctx.weights.modeSelfHarmPenalty;
    return ctx.weights.modePumpPerStatValue * (power + toughness);
  },
  /** Granting a keyword follows the pump: good on ours, a mistake on theirs. */
  grantKeywordUntilEndOfTurn: (_params, ctx) => {
    const perm = firstTargetPermanent(ctx);
    if (!perm) return 0;
    return perm.controller === ctx.player
      ? ctx.weights.modeUnknownEffectScore
      : -ctx.weights.modeSelfHarmPenalty;
  },
});

/**
 * §3.52 — prices for the primitives the §3.49 ledger carried as acknowledged
 * blind spots. A second frozen table rather than more entries in the first for
 * ONE reason: `weights.priceLedgeredEffects` can turn exactly this table off,
 * which reproduces the pre-§3.52 value model (every id below scoring the flat
 * `modeUnknownEffectScore`, wrapper bodies unread) so the strength and
 * throughput comparisons behind §3.52 stay re-runnable in one process — the
 * same discipline `LAND_SEQUENCING_OFF_WEIGHTS` established for §3.4e.
 *
 * Every entry prices by PARAMS SHAPE through the rulers the first table
 * already uses (`valueOfEffects`, `cardValue`, `removalValue`, the board
 * index); none of them knows a card name (DESIGN §1 — cards-package knowledge
 * stays out of this package).
 */
const LEDGERED_EFFECT_VALUE: Readonly<Record<string, EffectValuer>> = Object.freeze({
  /**
   * SCRY N — selection without card advantage, so it is priced off the same
   * `modeSelectionValue` ruler as `reorderTopOfLibrary`, deepened per extra
   * look and CAPPED at a draw's value: scry can converge on a draw's worth,
   * never beat it (the invariant the selection weight's doc states). An empty
   * library scries nothing and prices zero — which is also when this must
   * lose to literally any other mode.
   *
   * ⚠️ Its absence was the ledger's most common blindness (29 pool refs): a
   * scry-2 activation scored the same flat constant as anything unknown, so
   * `bestFundedActivation` could never tell Castle Vantress from a blank.
   */
  scry: (params, ctx) => {
    const who = subjectPlayer(params, 'who', 'controller', ctx);
    if (who === undefined) return 0;
    if (ctx.state.players[who].library.length === 0) return 0;
    const value = selectionDepthValue(intParam(params, 'count', 1), ctx.weights);
    return who === ctx.player ? value : -value;
  },

  /**
   * SURVEIL N — same selection shape as scry, same price. The one printed
   * difference (rejects go to the GRAVEYARD, not the bottom) is worth more
   * only to a deck with graveyard synergies, and this vocabulary deliberately
   * carries no synergy model — that omission is stated here rather than
   * half-guessed with a bonus no measurement backs.
   */
  surveil: (params, ctx) => {
    const who = subjectPlayer(params, 'who', 'controller', ctx);
    if (who === undefined) return 0;
    if (ctx.state.players[who].library.length === 0) return 0;
    const value = selectionDepthValue(intParam(params, 'count', 1), ctx.weights);
    return who === ctx.player ? value : -value;
  },

  /**
   * +1/+1 / -1/-1 COUNTERS — a PERMANENT stat change, priced per stat point at
   * `modeCounterPerStatValue` (between a pump that wears off and an Equipment
   * grant). The sign logic mirrors `pumpUntilEndOfTurn` exactly, because the
   * aiming mistake is the same one: a buff belongs on OUR creature and a
   * shrink on THEIRS, and a flat price had the pilot unable to tell the two
   * candidates apart ("put two +1/+1 counters on target creature" aimed at the
   * first thing offered — the §3.42 failure, 19 pool refs wide).
   *
   * Three printed forms, all priced:
   *  - the GROUP form (`each` + `scope` + `filter`) sums the stat swing over
   *    every matching creature, ours positive, theirs negative;
   *  - `self` (or a fallback with no target) is the source's own body —
   *    priced as our side, which is whose trigger/cast is being scored;
   *  - the aimed form reads the target: a lethal shrink prices as removal
   *    (`toughnessLeft` — marked damage counts, CR 704.5g), a trim per stat.
   */
  addCounters: (params, ctx) => {
    const amount = intParam(params, 'amount', 0);
    if (amount === 0) return 0;
    const weights = ctx.weights;
    const statSwing = 2 * amount; // ±N/±N is 2N stat points, signed
    if (boolParam(params, 'each')) {
      const scope = strParam(params, 'scope') ?? 'you';
      const filter = filterParamOf(params);
      let net = 0;
      for (const perm of ctx.state.battlefield) {
        if (!isCreature(perm.def)) continue;
        if (scope === 'you' && perm.controller !== ctx.player) continue;
        if (scope === 'opponent' && perm.controller === ctx.player) continue;
        if (filter && !matchesCardFilter(perm, filter)) continue;
        net += perm.controller === ctx.player ? statSwing : -statSwing;
      }
      return net * weights.modeCounterPerStatValue;
    }
    const target = boolParam(params, 'self') ? undefined : firstTargetPermanent(ctx);
    if (!target) {
      // The source's own body ("~ enters with N +1/+1 counters"): our side.
      return statSwing * weights.modeCounterPerStatValue;
    }
    if (amount > 0) {
      return target.controller === ctx.player
        ? statSwing * weights.modeCounterPerStatValue
        : -weights.modeSelfHarmPenalty;
    }
    // -1/-1 counters: shrink-removal, the pump entry's negative branch.
    if (target.controller === ctx.player) return -weights.modeSelfHarmPenalty;
    return -amount >= toughnessLeft(target, ctx.index)
      ? removalValue(target, weights, ctx.index)
      : -statSwing * weights.modeCounterPerStatValue;
  },

  /**
   * "IF THIS SPELL WAS KICKED, [body]" — a WRAPPER, and §3.42's exact shape:
   * unpriced, its body was never read, so a kicker payoff was invisible. It
   * recurses through the same `valueOfEffects` ruler as `mayEffects`, scaled
   * by what is actually known about the kicker:
   *
   *  - a RESOLUTION that recorded the answer (`state.resolution.kicked`) uses
   *    the truth — full body value kicked, zero unkicked;
   *  - before that (a card being weighed, a mode being compared) the body is
   *    worth `kickedClauseValueShare` of itself: the pilot has not agreed to
   *    pay the kicker yet, the same "not yet paid for" caution
   *    `createTokenCopy` documents for Rite of Replication's kicked five.
   */
  /**
   * "<base>. IF you control …, <other> INSTEAD" (Scute Swarm) — a WRAPPER with
   * two branches, of which exactly one runs. Priced as the branch the CURRENT
   * board would pick: the primitive decides with `interveningIfHolds`, and
   * `EffectValueContext` carries the same state, so the ruler and the engine
   * cannot disagree. A malformed condition prices the base branch, exactly as
   * the primitive runs it.
   */
  substituteIf: (params, ctx) => {
    const condition = params['condition'];
    // The ruler knows no source instance, so a source-reading condition
    // (`sourceUntapped`, `sourceKicked`) prices the BASE branch — the same
    // weaker-half fallback the primitive uses for a condition it cannot read.
    // The one condition the compiler emits (`controlCount`) never reads it.
    const holds =
      condition !== null &&
      typeof condition === 'object' &&
      !Array.isArray(condition) &&
      interveningIfHolds(ctx.state, condition as InterveningIf, NO_SOURCE_INSTANCE, ctx.player);
    const branch = holds ? params['effects'] : params['otherwise'];
    return Array.isArray(branch) ? valueOfEffects(branch as readonly EffectRef[], ctx) : 0;
  },

  ifKicked: (params, ctx) => {
    const inner = params['effects'];
    if (!Array.isArray(inner)) return 0;
    const kicked = ctx.state.resolution?.kicked;
    if (kicked === false) return 0;
    const body = valueOfEffects(inner as readonly EffectRef[], ctx);
    return kicked === true ? body : body * ctx.weights.kickedClauseValueShare;
  },

  /**
   * JAIL — "exile target … until this leaves" (O-Ring, Banisher Priest, Angel
   * of Serenity). Priced by WHERE the aim lands, which is the whole decision
   * (the engine parks a real `selectTargets` for these triggers, and a flat
   * price meant the first candidate offered always won):
   *
   *  - an opponent's PERMANENT — removal, at removal's own price. The release
   *    rider (it comes back if the jailer leaves) is real and unpriced here:
   *    pricing it would need the opponent's removal held to our jailer's face,
   *    which no other entry models either;
   *  - our own graveyard CARD — a banked return (Angel of Serenity brings it
   *    to HAND when she leaves), worth a share of the card;
   *  - an opponent's graveyard card — denial that hands the card back to
   *    their hand on release: a wash, priced zero;
   *  - our own PERMANENT — the mistake the §3.42 class keeps making, priced
   *    as one.
   */
  exileUntilLeaves: (_params, ctx) => {
    let id: InstanceId | undefined;
    for (const t of ctx.targets) {
      if (t !== 'A' && t !== 'B') {
        id = t;
        break;
      }
    }
    if (id === undefined) return 0;
    const perm = ctx.state.battlefield.find((c) => c.instanceId === id);
    if (perm) {
      if (perm.controller === ctx.player) return -ctx.weights.modeSelfHarmPenalty;
      return removalValue(perm, ctx.weights, ctx.index);
    }
    for (const owner of PLAYER_IDS) {
      const yard = ctx.state.players[owner].graveyard;
      for (let i = 0; i < yard.length; i++) {
        if (yard[i]!.instanceId !== id) continue;
        if (owner !== ctx.player) return 0;
        return cardValue(yard[i], ctx.weights, ctx.cards) * ctx.weights.modeJailOwnYardShare;
      }
    }
    return 0; // already gone — the usual dead-aim answer
  },

  /**
   * The RELEASE half of the jail — "return the exiled cards". It runs off the
   * jailer's own leave trigger, never as a play the pilot chooses, and WHAT it
   * would release is written in a cards-package-private stamp on the exiled
   * instances that this package deliberately does not read (DESIGN §1 — no
   * cross-package state knowledge). Priced ZERO: honest about not knowing,
   * and strictly better than the flat unknown constant it replaces, which
   * counted freeing the opponent's jailed creature as UPSIDE every time a
   * blink of the jailer was scored.
   */
  returnExiledByThis: () => 0,

  /**
   * THEFT-FOR-THE-TURN (Act of Treason): worth the stolen body's power at
   * `modeTheftPerPowerValue` — it cannot block us this turn AND it swings for
   * us, which is why the rate sits above tapping the same body and far below
   * killing it (they get it back at cleanup). `Math.max(power, 1)` for the
   * same reason `tapTarget` has it: stealing a 0-power wall still denies the
   * block. Stealing our own creature does nothing and prices as the mistake.
   */
  gainControl: (_params, ctx) => {
    const perm = firstTargetPermanent(ctx);
    if (!perm || !isCreature(perm.def)) return 0;
    if (perm.controller === ctx.player) return -ctx.weights.modeSelfHarmPenalty;
    return ctx.weights.modeTheftPerPowerValue * Math.max(effPower(perm, ctx.index), 1);
  },

  /**
   * The MASS keyword grant ("creatures you control gain indestructible until
   * end of turn" — Boros Charm's third mode). Worth a pump-sized amount per
   * body per keyword: real, scales with the board it actually reaches, and
   * ZERO on an empty board — where the flat unknown constant used to make
   * this mode beat drawing a card on a board with nothing to protect.
   * What it deliberately does not price: the sweeper it might blank (that
   * needs the opponent's hand) — so it stays a floor, never a headline.
   */
  grantKeywordToYoursUntilEndOfTurn: (params, ctx) => {
    const kw = params['keywords'];
    if (typeof kw !== 'object' || kw === null) return 0;
    let kwCount = 0;
    for (const key in kw as Record<string, unknown>) {
      if ((kw as Record<string, unknown>)[key] === true) kwCount++;
    }
    if (kwCount === 0) return 0;
    const types = strArrayParam(params, 'anyOfTypes');
    const toOpponent = strParam(params, 'scope') === 'opponent';
    const beneficiary = toOpponent ? opponentOf(ctx.player) : ctx.player;
    let bodies = 0;
    for (const perm of ctx.state.battlefield) {
      if (perm.controller !== beneficiary) continue;
      if (types.length > 0) {
        const permTypes: readonly string[] = perm.def.types;
        if (!types.some((t) => permTypes.includes(t))) continue;
      }
      bodies++;
    }
    const value = bodies * kwCount * ctx.weights.modePumpPerStatValue;
    return toOpponent ? -value : value;
  },

  /**
   * MILL — a real clock only in bulk, so each card is worth the small
   * `modeMillPerCardValue` against an opponent… until the mill would EMPTY
   * the library, which is the near-win the decking rule makes it (they lose
   * on their next draw) and prices as one. Self-mill is the same rate as a
   * LOSS — the graveyard value it might feed (flashback, Snapcaster) is a
   * synergy this vocabulary does not model, stated rather than guessed — and
   * self-mill that would empty our own library prices as the catastrophe the
   * draw entry already knows (`modeSelfDeckPenalty`).
   */
  mill: (params, ctx) => {
    const amount = intParam(params, 'amount', 0);
    if (amount <= 0) return 0;
    const victim = boolParam(params, 'self')
      ? ctx.player
      : (firstPlayerTarget(ctx) ?? opponentOf(ctx.player));
    const library = ctx.state.players[victim].library.length;
    if (library === 0) return 0;
    if (victim === ctx.player) {
      return amount >= library ? -ctx.weights.modeSelfDeckPenalty : -ctx.weights.modeMillPerCardValue * amount;
    }
    return amount >= library ? ctx.weights.lethalBurnScore : ctx.weights.modeMillPerCardValue * amount;
  },

  /**
   * DAMAGE TO EACH — the Pyroclasm/Guttersnipe family. The creature half is
   * `destroyAll`'s trade (kill theirs, lose ours, same per-stat weights and
   * the same scaling) gated by whether `amount` actually kills each body
   * (`toughnessLeft`, so marked damage counts) and skipping indestructible
   * exactly as the sweeper entry does; survivors are not priced, also exactly
   * like the sweeper (chip on a survivor buys nothing here). The player half
   * prices like `dealDamage`'s face: lethal wins, otherwise a chip — and the
   * self half of "each player" is a life LOSS at the same rate `loseLife`
   * charges, or the game if it would finish us.
   */
  dealDamageToEach: (params, ctx) => {
    const amount = intParam(params, 'amount', 0);
    if (amount <= 0) return 0;
    const weights = ctx.weights;
    let net = 0;
    if (boolParam(params, 'creatures')) {
      let stats = 0;
      for (const perm of ctx.state.battlefield) {
        if (!isCreature(perm.def)) continue;
        if (isIndestructible(ctx, perm)) continue;
        if (toughnessLeft(perm, ctx.index) > amount) continue;
        const total = statTotal(perm, ctx.index);
        stats += perm.controller === ctx.player ? -total * weights.ownCreatureLossPerStat : total * weights.killEnemyPerStat;
      }
      net += stats * weights.removalPerPowerOfTarget;
    }
    const hitsEveryPlayer = boolParam(params, 'players');
    if (hitsEveryPlayer || boolParam(params, 'opponents')) {
      const opponent = opponentOf(ctx.player);
      net += amount >= ctx.state.players[opponent].life ? weights.lethalBurnScore : weights.burnFaceBaseScore;
    }
    if (hitsEveryPlayer) {
      net -=
        amount >= ctx.state.players[ctx.player].life
          ? weights.lethalBurnScore
          : lifeSwing(amount, ctx, EMPTY_PARAMS);
    }
    return net;
  },

  /**
   * "As ~ enters, choose a …" — the naming itself moves nothing on the board;
   * the payoff is the STATIC that reads the named value, and statics are
   * priced where statics live. Zero is the honest price of the ref, and it
   * fixes a real distortion: the flat unknown constant made every
   * name-a-value card's cast score carry twenty points of phantom value.
   */
  chooseAsEnters: () => 0,

  /**
   * The Puzzle-Box wheel half — a hand swapped for the same number of fresh
   * cards. No card advantage either way, so it prices as SELECTION for
   * whoever's hand it churns (ours positive, theirs negative), and zero on an
   * empty hand, where the printed card also does nothing.
   */
  handToBottomThenDraw: (params, ctx) => {
    const who = subjectPlayer(params, 'who', 'controller', ctx);
    if (who === undefined) return 0;
    if (ctx.state.players[who].hand.length === 0) return 0;
    return who === ctx.player ? ctx.weights.modeSelectionValue : -ctx.weights.modeSelectionValue;
  },

  /**
   * The PERSIST return — the dead creature comes back, smaller. Worth a
   * creature cast's base minus the -1/-1 counters' permanent stat cost, floored
   * at zero. The body's own size is deliberately not read: this ref is priced
   * without its source (the value context carries targets, not the dying
   * card), and a base-plus-shrink floor is the honest number that remains.
   */
  persistReturn: (params, ctx) => {
    const minus = Math.max(intParam(params, 'minusCounters', 1), 0);
    return Math.max(
      ctx.weights.castCreatureBaseScore - minus * 2 * ctx.weights.modeCounterPerStatValue,
      0,
    );
  },

  /**
   * The Delver flip check — look at the top card, maybe transform. The LOOK
   * is real selection-adjacent value every upkeep; the flip's odds depend on
   * what the library holds, which this vocabulary cannot see and does not
   * guess at. Selection value, flat.
   */
  transformRevealTop: (_params, ctx) => ctx.weights.modeSelectionValue,
});

/**
 * The §3.46 build-comparison preset: merge over any weight set to run the
 * PRE-§3.52 value model in the same process as the shipped one — the exact
 * pattern `LAND_SEQUENCING_OFF_WEIGHTS` committed for §3.4e, and the way
 * §3.52's pilot-ab verdict and throughput cost were measured (old model and
 * new model as two registered pilot ids, one process, matched seeds).
 */
export const LEDGER_PRICING_OFF_WEIGHTS: Readonly<Partial<HeuristicWeights>> = Object.freeze({
  priceLedgeredEffects: false,
});

/**
 * The primitive ids the value tables price, as a RUNTIME list — the keys of
 * {@link EFFECT_VALUE} and {@link LEDGERED_EFFECT_VALUE}, frozen at module
 * load. (The ledgered table's ids belong here unconditionally: the ablation
 * switch exists for measurement, and the DEFAULT weights price them.)
 *
 * EXPORT-ONLY: nothing in this package reads it. It exists for the §3.49
 * parity invariant, which compares "registered in the cards package" against
 * "priced here" — the exact seam §3.42's two defects fell through (`mayEffects`
 * and `blinkTarget` were registered, unpriced, and scored the flat
 * `modeUnknownEffectScore` with their bodies never read). A test that parsed
 * this file's source instead would drift with formatting; the keys cannot.
 */
export const PRICED_PRIMITIVE_IDS: readonly string[] = Object.freeze([
  ...Object.keys(EFFECT_VALUE),
  ...Object.keys(LEDGERED_EFFECT_VALUE),
]);

/** "Tap all creatures" is the overwhelmingly common form, so it is the default. */
const DEFAULT_TAP_TYPES: readonly string[] = Object.freeze(['creature']);

/**
 * What looking `count` cards deep (scry/surveil) is worth: the selection value
 * of the first look plus a diminishing share per extra card, capped at a
 * draw — deep selection converges on a card, it never becomes more than one.
 */
function selectionDepthValue(count: number, weights: HeuristicWeights): number {
  if (count <= 0) return 0;
  const value = weights.modeSelectionValue * (1 + (count - 1) * weights.modeSelectionExtraCardShare);
  return Math.min(value, weights.modeDrawCardValue);
}

/** Life gained/lost by whoever the effect names, valued from `ctx.player`'s seat. */
function lifeSwing(
  amount: number,
  ctx: EffectValueContext,
  params: Readonly<Record<string, unknown>>,
): number {
  if (amount <= 0) return 0;
  const weights = ctx.weights;
  const who = boolParam(params, 'targetPlayer') ? firstPlayerTarget(ctx) ?? ctx.player : ctx.player;
  const desperate = ctx.state.players[who].life <= weights.desperateLifeThreshold;
  const perPoint = desperate ? weights.modeLifePerPointValue * weights.modeDesperateLifeMultiplier : weights.modeLifePerPointValue;
  const value = perPoint * amount;
  return who === ctx.player ? value : -value;
}

/** A token's worth, priced exactly like casting a creature of the same size. */
function tokenValue(params: Readonly<Record<string, unknown>>, ctx: EffectValueContext): number {
  const weights = ctx.weights;
  const count = Math.max(intParam(params, 'count', 1), 0);
  const stats = intParam(params, 'power', 1) + intParam(params, 'toughness', 1);
  return count * (weights.castCreatureBaseScore + weights.castCreaturePerStat * stats);
}

/**
 * Whether a token this ref creates could ATTACK on the turn it arrives — the
 * only value a token that is sacrificed at the beginning of the next end step
 * can ever deliver.
 *
 * Three printed sources of haste, and all three are read because all three are
 * real: the copy's own "except it has haste" tail (Kiki-Jiki, Twinflame), a
 * follow-up "It gains haste" sentence (Orthion, Molten Duplication), and the
 * copied card simply having it (a token copy of a Goblin Guide). Reading only
 * one would price two of the three cards at zero.
 */
function temporaryTokenCanAttack(params: Readonly<Record<string, unknown>>, copied: CardDefinition): boolean {
  if (copied.keywords?.haste === true) return true;
  const except = params.except;
  if (except !== null && typeof except === 'object') {
    const added = (except as { readonly addKeywords?: { readonly haste?: boolean } }).addKeywords;
    if (added?.haste === true) return true;
  }
  const granted = params.grantKeywords;
  if (granted !== null && typeof granted === 'object') {
    if ((granted as { readonly haste?: boolean }).haste === true) return true;
  }
  return false;
}

/**
 * The permanent a `createTokenCopy` ref would copy — its TARGET.
 *
 * The primitive reads three selectors (`self`, `equipped`, the target) and this
 * prices only the third, because the other two are never a DECISION: a card that
 * copies itself or its equipped host does so from a TRIGGER, which the pilot does
 * not choose to run. What the pilot chooses is whether to cast a Rite of
 * Replication and where to point it, and that is always a target.
 *
 * `undefined` means "nothing legal to copy", which prices the ref at zero — the
 * same dead-mode answer `counterSpell` gives with an empty stack.
 */
function tokenCopySource(ctx: EffectValueContext): CardInstance | undefined {
  for (const t of ctx.targets) {
    if (t === 'A' || t === 'B') continue;
    const found = ctx.state.battlefield.find((c) => c.instanceId === t);
    if (found) return found;
  }
  return undefined;
}

/** The value of the best card in a zone, by the pilot's one card ruler. */
function bestCardIn(cards: readonly CardInstance[], ctx: EffectValueContext): number {
  let best = 0;
  for (const card of cards) {
    const value = cardValue(card, ctx.weights, ctx.cards);
    if (value > best) best = value;
  }
  return best;
}

// --- modal-spell mode lookup --------------------------------------------------------

/** A mode as the card AUTHORED it: its id, its effects, and what it may aim at. */
export interface ModeEffects {
  readonly id: string;
  readonly effects: readonly EffectRef[];
  /** What choosing this mode will then be asked to target, when it targets. */
  readonly targets?: TargetRestriction;
}

/**
 * Recover the effects behind each offered mode id.
 *
 * The pending choice carries only `{ id, label }` — deliberately, since a choice
 * must be renderable by a UI that knows no rules — so the meaning comes from the
 * card's own data: `CardDefinition.modal`, read off the card that asked.
 *
 * The question is raised while the spell is being CAST, so the card is on the
 * STACK, not the battlefield; `findInstance` searches every zone, and a card
 * this build cannot read yields an empty list rather than a throw, which simply
 * degrades mode choice to printed order.
 */
export function modeEffectsFor(state: GameState, sourceInstanceId: InstanceId): readonly ModeEffects[] {
  // The STACK first, and that is not an optimisation: a modal spell's modes are
  // chosen while it is being cast, so the card is on the stack and NOWHERE else
  // — and `findInstance` (built for board/hand/graveyard questions) does not
  // look there. Searching only through it returned an empty mode list, which
  // silently degraded every mode choice to printed order.
  const onStack = state.stack.find((o) => o.kind === 'spell' && o.instanceId === sourceInstanceId);
  const source = (onStack?.kind === 'spell' ? onStack.card : undefined) ?? findInstance(state, sourceInstanceId);
  const spec = source ? modalSpecOf(source.def) : undefined;
  if (!spec) return [];
  return spec.modes.map((mode) => ({
    id: mode.id,
    effects: mode.effects,
    ...(mode.targets !== undefined ? { targets: mode.targets } : {}),
  }));
}

/**
 * What one mode is worth on this board, aimed as well as it could be.
 *
 * A targeting mode is priced by its BEST legal target rather than by an
 * unaimed guess, because the aim is the mode: "counter target spell" is a
 * blank with nothing worth countering and premium removal with something. This
 * is also what stops the pilot countering ITS OWN spell — a Cryptic Command is
 * on the stack while its modes are chosen, so it is a legal counter target, and
 * `counterSpell`'s scorer prices aiming there as the mistake it is.
 */
export function valueOfMode(mode: ModeEffects, ctx: EffectValueContext): number {
  if (mode.targets === undefined) return valueOfEffects(mode.effects, ctx);
  const candidates = legalTargetsFor(ctx.state, mode.targets, ctx.player);
  let best: number | undefined;
  for (const ref of candidates) {
    const value = valueOfEffects(mode.effects, { ...ctx, targets: [ref] });
    if (best === undefined || value > best) best = value;
  }
  // No legal target at all: the mode would not have been offered, but a caller
  // scoring a card in hand can ask about one, and a mode that cannot happen is
  // worth nothing.
  return best ?? 0;
}

/** Build the value context for a resolution that is currently asking a question. */
export function resolutionValueContext(
  state: GameState,
  player: PlayerId,
  weights: HeuristicWeights,
  cards: CardValueContext,
): EffectValueContext {
  return { state, player, targets: state.resolution?.targets ?? [], weights, cards, index: cards.index };
}
