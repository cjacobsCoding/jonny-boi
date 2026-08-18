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

import type { CardInstance, EffectRef, GameState, InstanceId, ManaCost, PlayerId } from '@jonny-boi/core';
import {
  canAffordManaCost,
  convertedManaCost,
  effectivePower,
  effectiveToughness,
  isCreature,
  MANA_COLORS,
  matchesCardFilter,
  opponentOf,
  remainingToughness,
} from '@jonny-boi/core';
import type { CardFilter } from '@jonny-boi/core';
import { cardValue, findInstance, type CardValueContext } from './card-value.js';
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

/** The first targeted SPELL still on the stack, if any. */
function firstTargetSpell(ctx: EffectValueContext) {
  for (const t of ctx.targets) {
    if (t === 'A' || t === 'B') continue;
    const obj = ctx.state.stack.find((o) => o.kind === 'spell' && o.instanceId === t);
    if (obj && obj.kind === 'spell') return obj;
  }
  return undefined;
}

// --- shared pricing --------------------------------------------------------------

/**
 * What removing an opposing permanent from the board is worth — the same formula
 * the main-phase pilot uses to pick a removal target, so "kill the biggest threat"
 * means one thing across the whole pilot.
 */
function removalValue(perm: CardInstance, weights: HeuristicWeights): number {
  return weights.removalBaseScore + weights.removalPerPowerOfTarget * effectivePower(perm);
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
      const pressure = isCreature(perm.def) ? weights.removalPerPowerOfTarget * effectivePower(perm) : 0;
      return weights.modeBounceBaseScore + redeploy + pressure;
    }),

  /** Same shape as a bounce, but the card is gone for good. */
  destroyTarget: (_params, ctx) => againstTarget(ctx, (perm) => removalValue(perm, ctx.weights)),
  exileTarget: (_params, ctx) => againstTarget(ctx, (perm) => removalValue(perm, ctx.weights)),

  /** Tapping one permanent is a fraction of tapping a board; price it per power. */
  tapTarget: (_params, ctx) =>
    againstTarget(ctx, (perm) =>
      perm.tapped ? 0 : ctx.weights.modeTapPerPowerValue * Math.max(effectivePower(perm), 1),
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
      const stats = effectivePower(perm) + effectiveToughness(perm);
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
      const weight = weights.modeTapPerPowerValue * Math.max(effectivePower(perm), 1);
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
      remainingToughness(perm) <= amount
        ? removalValue(perm, weights)
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
      const value = removalValue(perm, ctx.weights);
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
      total += removalValue(perm, ctx.weights);
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
      return -toughness >= remainingToughness(perm)
        ? removalValue(perm, ctx.weights)
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

/** A mode as the card AUTHORED it: an id and the effects choosing it runs. */
export interface ModeEffects {
  readonly id: string;
  readonly effects: readonly EffectRef[];
}

/**
 * Recover the effects behind each offered mode id.
 *
 * The pending choice carries only `{ id, label }`, so the meaning has to come from
 * the card's own data. The authoritative source is the SUSPENDED RESOLUTION: the
 * effect ref it stopped on is the `modal` ref itself, complete with its `modes`
 * param, and its `targets` are the ones this cast locked in. Falling back to the
 * source card's printed effects covers a state that arrived without a frame (a
 * hand-built test position, a replay), and returning an empty map — never a throw —
 * covers a card this build cannot read, which simply degrades mode choice to
 * printed order.
 */
export function modeEffectsFor(state: GameState, sourceInstanceId: InstanceId): readonly ModeEffects[] {
  const frame = state.resolution;
  const running = frame ? frame.effects[frame.next] : undefined;
  const fromFrame = running ? readModes(running) : undefined;
  if (fromFrame && fromFrame.length > 0) return fromFrame;

  const source = findInstance(state, sourceInstanceId);
  for (const ref of source?.def.effects ?? []) {
    const modes = readModes(ref);
    if (modes && modes.length > 0) return modes;
  }
  return [];
}

/** Read a `modal` ref's `modes` param, keeping only well-formed entries. */
function readModes(ref: EffectRef): readonly ModeEffects[] | undefined {
  const raw = ref.params?.modes;
  if (!Array.isArray(raw)) return undefined;
  const out: ModeEffects[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const mode = entry as { id?: unknown; effects?: unknown };
    if (typeof mode.id !== 'string') continue;
    out.push({ id: mode.id, effects: Array.isArray(mode.effects) ? (mode.effects as EffectRef[]) : [] });
  }
  return out;
}

/** Build the value context for a resolution that is currently asking a question. */
export function resolutionValueContext(
  state: GameState,
  player: PlayerId,
  weights: HeuristicWeights,
  cards: CardValueContext,
): EffectValueContext {
  return { state, player, targets: state.resolution?.targets ?? [], weights, cards };
}
