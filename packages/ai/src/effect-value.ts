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
  CardInstance,
  EffectRef,
  GameState,
  InstanceId,
  ManaCost,
  PlayerId,
  TargetRestriction,
} from '@jonny-boi/core';
import {
  canAffordManaCost,
  convertedManaCost,
  isCreature,
  MANA_COLORS,
  legalTargetsFor,
  matchesCardFilter,
  modalSpecOf,
  opponentOf,
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

/** The value of one effect ref — a registry lookup, never a chain of `if`s. */
export function valueOfEffect(ref: EffectRef, ctx: EffectValueContext): number {
  const score = EFFECT_VALUE[ref.primitive];
  return score ? score(ref.params ?? EMPTY_PARAMS, ctx) : ctx.weights.modeUnknownEffectScore;
}

const EMPTY_PARAMS: Readonly<Record<string, unknown>> = Object.freeze({});

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

/** One spell on the stack, as `state.stack` carries it. */
type SpellOnStack = Extract<GameState['stack'][number], { kind: 'spell' }>;

/** The spell with this id, if it is still on the stack. */
function spellOnStack(state: GameState, id: InstanceId | PlayerId): SpellOnStack | undefined {
  if (id === 'A' || id === 'B') return undefined;
  const obj = state.stack.find((o) => o.kind === 'spell' && o.instanceId === id);
  return obj?.kind === 'spell' ? obj : undefined;
}

/** The first targeted SPELL still on the stack, if any. */
function firstTargetSpell(ctx: EffectValueContext): SpellOnStack | undefined {
  for (const t of ctx.targets) {
    const spell = spellOnStack(ctx.state, t);
    if (spell) return spell;
  }
  return undefined;
}

/**
 * The primitive id of "copy target instant or sorcery spell" (CR 707.10).
 *
 * Exported so `choices.ts` — which has to recognise the SAME primitive to know
 * that a parked `selectTargets` is the "you may choose new targets for the copy"
 * question — names it from here instead of keeping a second copy of the string.
 */
export const COPY_SPELL_PRIMITIVE = 'copySpell';

/**
 * The spell a copy of `spell` would go on to copy, or `undefined` when `spell`
 * is not a copy effect at all (the END of a copy chain).
 *
 * `null` is the third answer and it matters: `spell` IS a copy effect but the
 * thing it was aimed at is no longer on the stack, so a copy of it will fizzle
 * and is worth nothing.
 */
function copiedSpellOf(state: GameState, spell: SpellOnStack): SpellOnStack | null | undefined {
  if (!spell.card.def.effects?.some((ref) => ref.primitive === COPY_SPELL_PRIMITIVE)) return undefined;
  for (const t of spell.targets) {
    const next = spellOnStack(state, t);
    if (next) return next;
  }
  return null;
}

/**
 * WHAT COPYING THIS SPELL IS WORTH — the one answer, followed down the copy chain
 * to the spell that will actually DO something.
 *
 * A copy of a Lightning Bolt is worth a Lightning Bolt: that much was already
 * true, and it is the whole discipline of holding a Reverberate for a Cryptic
 * Command. What was missing is what a copy of a COPY SPELL is worth. Priced as a
 * card — 8 plus 2 per mana value, the ruler every choice in this pilot uses — a
 * Twincast outscored the Dream Twist underneath it on the stack, so the pilot
 * aimed each new copy back at the Twincast, which produced another copy of the
 * Twincast, forever. Three full-pool soak games burned the 6,000-action cap on
 * exactly that (soak seeds 3434778477, 1390617766, 113343071); the board, the
 * stack and both life totals were identical across ~1,800 repetitions.
 *
 * So the chain is walked to its end and the value is the END's, shrunk by
 * {@link HeuristicWeights.copiedCopySpellValueShare} per link. That makes aiming
 * at a copy spell STRICTLY worse than aiming at what that copy spell is aimed at
 * — which is also simply true, since both eventually produce the same one copy
 * and the shorter route cannot fizzle in between.
 *
 * Two chains are worth nothing at all, and both are real:
 *  - one that runs OFF the stack (the middle spell's target has already
 *    resolved) — the copy would fizzle;
 *  - one that comes BACK to a spell already on the walk (two copy spells aimed
 *    at each other) — it produces copies forever and a game, never a card. The
 *    visited set is also what stops this function itself looping.
 */
export function copySpellValue(
  state: GameState,
  spell: SpellOnStack | undefined,
  weights: HeuristicWeights,
  cards: CardValueContext,
): number {
  let share = 1;
  const seen = new Set<InstanceId>();
  let current = spell;
  while (current) {
    if (seen.has(current.instanceId)) return 0; // a cycle produces copies, never a card
    seen.add(current.instanceId);
    const next = copiedSpellOf(state, current);
    if (next === undefined) return share * cardValue(current.card, weights, cards);
    if (next === null) return 0; // the chain runs off the stack — the copy fizzles
    share *= weights.copiedCopySpellValueShare;
    current = next;
  }
  return 0; // nothing on the stack — a dead mode
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
   * COPYING A SPELL (CR 707.10) is worth **whatever the spell it copies is
   * worth**, priced by the pilot's one card ruler — a copy of a Cryptic Command
   * is worth a Cryptic Command, and a copy of a cantrip is worth a cantrip. That
   * is what makes a pilot hold a Reverberate for something big instead of
   * spending it on the first instant it sees.
   *
   * The sign is the interesting half and it is the OPPOSITE of a counterspell's:
   * countering your OWN spell is the classic printed-first-mode blunder, while
   * copying your own spell is the play the card is FOR. Copying an OPPONENT'S
   * spell is also fine (the copy is yours — CR 707.10), so neither controller
   * earns a penalty here; what earns zero is copying nothing, which is what a
   * dead mode is worth.
   *
   * ⚠️ The ruler is {@link copySpellValue}, not `cardValue` directly: a spell
   * that is itself a copy effect is worth what it will ultimately copy, not what
   * its own card costs. Reading the card here is what made a pilot aim copy
   * after copy at the copy spell above its own target and hang three soak games.
   */
  copySpell: (params, ctx) => {
    const count = Math.max(intParam(params, 'count', 1), 0);
    return count * copySpellValue(ctx.state, firstTargetSpell(ctx), ctx.weights, ctx.cards);
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

/** "Tap all creatures" is the overwhelmingly common form, so it is the default. */
const DEFAULT_TAP_TYPES: readonly string[] = Object.freeze(['creature']);

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
