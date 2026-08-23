/**
 * REPLACEMENT AND PREVENTION EFFECTS — the engine (CR 614 / CR 615 / CR 616).
 * The card-facing declaration half is `../replacement.ts`, which is also where
 * the family is introduced.
 *
 * ## ONE seam, three call sites
 * Damage, counters and draws all ask the SAME question through the same
 * function. That is the whole point of the module: the once-per-event rule, the
 * ordering rule and the shield bookkeeping exist once, so a damage doubler and a
 * counter doubler cannot end up with two different ideas of what "instead"
 * means. The three exported façades ({@link replaceDamage},
 * {@link replaceCounters}, {@link replaceDraw}) only build the event record and
 * unpack the result; {@link runReplacements} is the single engine.
 *
 * ## CR 614.5 — an effect applies AT MOST ONCE to a given event
 * This is the rule that makes a doubling effect terminate. After a replacement
 * modifies the event, the engine re-asks which effects apply *to the modified
 * event* — Doubling Season still matches its own output, and would double
 * forever. The applicable set is therefore tracked as a BITMASK over the
 * candidate list and an effect already applied is never offered again, so the
 * loop runs at most `candidates.length` times by construction. There is no
 * recursion and no depth counter to tune: the mask is the termination proof.
 *
 * ## CR 616.1 — who chooses the ORDER, and how this engine settles it
 * When two or more replacement effects would apply, the AFFECTED player (or the
 * affected permanent's controller) chooses which applies first, and the choice
 * is real: Hardened Scales then Corpsejack Menace puts (1+1)×2 = 4 counters,
 * the other order puts 1×2+1 = 3.
 *
 * This engine settles that decision **deterministically, in one place, for every
 * seat and every call site**: it searches the orders and picks the one the
 * affected player would pick, breaking ties by a canonical order (source
 * instance id, then declaration index). Two things make that the right call
 * rather than a shortcut:
 *
 *  1. **Every order it can produce is legal.** CR 616.1 hands the decision to a
 *     player; it does not constrain the answer. This is the same class of
 *     delegated sub-decision as "which lands get tapped to pay this cost",
 *     which core's shared payment planner has always answered on the player's
 *     behalf (DESIGN §3.11) — the decision the CARD prints is modelled in full.
 *  2. **The alternative would have to be two different rules.** The hottest
 *     call site is the combat damage step, which is a synchronous batch inside
 *     the turn machine with no resolution frame to park a `pendingChoice` in —
 *     `resolveCombatDamage` applies every assignment before priority exists
 *     again. A layer that asked a question for a Lightning Bolt and decided
 *     silently for a combat hit would be exactly the drift this repo keeps
 *     having to unwind. One rule, one answer, everywhere.
 *
 * The objective is one line, named and testable: the affected player takes the
 * order that gives them the **least damage**, the **most `+1/+1` counters**, and
 * the **fewest counters of any other kind** ({@link affectedPlayerPrefersMore}).
 * The search is exhaustive up to {@link ORDER_SEARCH_MAX_CANDIDATES} effects and
 * falls back to the canonical order beyond it, so its cost is bounded by a named
 * constant rather than by how many enchantments are on the table.
 *
 * ## Prevention shields are consumed, and cannot resurrect
 * A shield ("prevent the next 3 damage") carries `remaining` on its
 * {@link FloatingReplacement} record. It is decremented by exactly what it
 * prevented, and the record is SPLICED OUT of `GameState.replacements` the
 * moment it reaches zero. Deleting it — rather than leaving a zeroed shield in
 * the list — is what makes "spent" structural: there is no record left for a
 * later effect to top up, and no zero-remaining branch for a future reader to
 * get wrong.
 *
 * ## The layer is INERT and allocation-free when nothing replaces anything
 * {@link indexReplacements} returns the SHARED FROZEN empty array unless some
 * permanent (or emblem, or floating record) actually declares a replacement, so
 * the guard at every call site is `index.length === 0` — one property read, no
 * allocation, no map, no closure. This sits on the damage and counter paths,
 * which are the hottest in the game, so the discovery loop is the same shape as
 * `indexContinuous`'s: a single indexed `for` over `state.battlefield` reading
 * one property per permanent, with no iterator and no intermediate array unless
 * something is found.
 */

import type { CardDefinition } from '../card.js';
import { colorsOfDefinition } from '../card.js';
import type { GameEvent } from '../events.js';
import type { CardInstance, GameState, InstanceId, PlayerId } from '../state.js';
import { matchesCardFilter } from '../choices.js';
import type { StaticControllerScope } from '../statics.js';
import type {
  ReplacementAbility,
  ReplacementApplies,
  ReplacementEventKind,
  ReplacementOutcome,
} from '../replacement.js';
import { affectedPlayerPrefersMore, replacementIsInert } from '../replacement.js';
import { isRemovedFromCombat } from '../combat-removal.js';
import type { ContinuousDuration } from './continuous.js';

/**
 * A replacement effect that is NOT printed on a permanent — created by a
 * resolving spell or ability and living in `GameState.replacements` until it
 * expires (a fog) or is spent (a shield).
 *
 * `remaining` is the ONLY mutable field, and it is mutable because a shield is
 * consumed: see the header for why a spent shield is removed rather than zeroed.
 */
export interface FloatingReplacement extends ReplacementAbility {
  /** Stable id (minted from the `GameState.nextInstanceId` space) for debug/expiry. */
  readonly id: number;
  /** The instance that created it — attribution, and `excludeSource`'s anchor. */
  readonly sourceInstanceId: InstanceId;
  /** Who controls it: whose "you" the filter's controller scopes mean. */
  readonly controller: PlayerId;
  /** When the engine removes it. `'endOfTurn'` for every fog and shield today. */
  readonly duration: ContinuousDuration;
  /**
   * How much damage this shield can still prevent. Present only for
   * `outcome.preventUpTo` shields; absent means "no ceiling" (a fog).
   */
  remaining?: number;
}

/**
 * One replacement effect that is live right now, from either lifetime, flattened
 * so the engine loop never has to care which it came from.
 */
export interface ActiveReplacement {
  readonly ability: ReplacementAbility;
  /** Whose it is — the anchor for every `'you'`/`'opponent'` scope in the filter. */
  readonly controller: PlayerId;
  /** The permanent (or spell) it radiates from. */
  readonly sourceInstanceId: InstanceId;
  /** Set for a floating record; the shield bookkeeping writes through it. */
  readonly floating?: FloatingReplacement;
}

/**
 * Every live replacement effect, in canonical order. An ARRAY rather than a map:
 * the loop always walks the whole (tiny) list, and the empty case must cost a
 * single `.length` read.
 */
export type ReplacementIndex = readonly ActiveReplacement[];

/**
 * The shared, frozen empty index. Returned by reference whenever nothing in the
 * game replaces anything, which is every game that contains none of these cards.
 */
export const NO_REPLACEMENTS: ReplacementIndex = Object.freeze([]) as ReplacementIndex;

/**
 * The largest candidate set the CR 616.1 ordering search enumerates exhaustively
 * (`4! = 24` orders). Beyond it the canonical order is used, which is still a
 * legal answer — the constant bounds the work, it does not change what is legal.
 * Four is well past what any real board produces: two applicable replacement
 * effects on one event is already a rare, deck-built configuration.
 */
export const ORDER_SEARCH_MAX_CANDIDATES = 4;

/**
 * The mutable working record one event is folded through. Built by a façade
 * AFTER the inert guard has already passed, so a game with no replacement effect
 * never allocates one.
 */
export interface ReplaceableEvent {
  readonly kind: ReplacementEventKind;
  /** The permanent/spell dealing the damage or putting the counters. */
  readonly source?: CardInstance;
  /** Its controller — read separately because a resolving spell may have left play. */
  readonly sourceController?: PlayerId;
  /** The affected permanent, when the event happens to one. */
  readonly recipient?: CardInstance;
  /**
   * The affected PLAYER: the damaged/drawing player, or the controller of the
   * affected permanent. Always known, and it is CR 616.1's chooser.
   */
  readonly affectedPlayer: PlayerId;
  /** Combat damage? Meaningless for the other kinds, and never read by them. */
  readonly combat: boolean;
  /** Which counter kind is being put on (counters only). */
  readonly counterKind?: string;
  /** Whether this draw is the drawing player's first draw-step draw this turn. */
  readonly firstDrawStepDraw?: boolean;
  /** Whether the drawing player's library is empty (Laboratory Maniac). */
  readonly libraryEmpty?: boolean;
  /** IN: what would happen. OUT: what happens instead. */
  amount: number;
  /** OUT: how much of the original quantity was PREVENTED, for the log. */
  prevented: number;
  /** OUT: the affected player wins the game instead of drawing. */
  winsGame: boolean;
}

// --- indexing -------------------------------------------------------------------

/**
 * Collect every live replacement effect. Returns {@link NO_REPLACEMENTS} by
 * reference when there are none — the allocation-free common case.
 *
 * Cost when nothing replaces anything: one property read per battlefield
 * permanent plus two length checks, and no allocation at all. The shape is
 * lifted straight from `indexContinuous` (indexed `for`, no iterator, lazily
 * created output array) for the same reason: this runs on the damage path.
 */
export function indexReplacements(state: GameState): ReplacementIndex {
  let found: ActiveReplacement[] | null = null;

  const permanents = state.battlefield;
  for (let i = 0; i < permanents.length; i++) {
    const perm = permanents[i] as CardInstance;
    const declared = perm.def.replacements;
    if (declared === undefined || declared.length === 0) continue;
    found = pushAbilities(found, perm, declared);
  }
  // Emblems replace from the COMMAND zone (CR 114) for the same reason they
  // radiate statics from there — nothing can ever remove one, and the layer that
  // reads the battlefield would never see it. Read directly rather than through
  // PLAYER_IDS, which allocates an iterator for a two-element list.
  const commandA = state.players.A.command;
  for (let i = 0; i < commandA.length; i++) {
    const card = commandA[i] as CardInstance;
    const declared = card.def.replacements;
    if (declared !== undefined && declared.length > 0) found = pushAbilities(found, card, declared);
  }
  const commandB = state.players.B.command;
  for (let i = 0; i < commandB.length; i++) {
    const card = commandB[i] as CardInstance;
    const declared = card.def.replacements;
    if (declared !== undefined && declared.length > 0) found = pushAbilities(found, card, declared);
  }

  const floating = state.replacements;
  if (floating !== undefined) {
    for (let i = 0; i < floating.length; i++) {
      const record = floating[i] as FloatingReplacement;
      if (replacementIsInert(record)) continue;
      (found ??= []).push({
        ability: record,
        controller: record.controller,
        sourceInstanceId: record.sourceInstanceId,
        floating: record,
      });
    }
  }

  return found ?? NO_REPLACEMENTS;
}

/** Append one permanent's declared replacement abilities, skipping inert ones. */
function pushAbilities(
  found: ActiveReplacement[] | null,
  source: CardInstance,
  declared: readonly ReplacementAbility[],
): ActiveReplacement[] | null {
  for (let i = 0; i < declared.length; i++) {
    const ability = declared[i] as ReplacementAbility;
    if (replacementIsInert(ability)) continue;
    (found ??= []).push({
      ability,
      controller: source.controller,
      sourceInstanceId: source.instanceId,
    });
  }
  return found;
}

/**
 * Whether anything in this game could replace anything. The cheap gate for a
 * caller that has no index in hand and only wants to know whether to build one.
 */
export function hasAnyReplacement(state: GameState): boolean {
  return indexReplacements(state).length > 0;
}

// --- applicability --------------------------------------------------------------

/** Whether `candidate`'s controller satisfies a scope read from `owner`'s point of view. */
function scopeAdmits(scope: StaticControllerScope | undefined, owner: PlayerId, candidate: PlayerId): boolean {
  const resolved = scope ?? 'any';
  if (resolved === 'you') return candidate === owner;
  if (resolved === 'opponent') return candidate !== owner;
  return true;
}

/**
 * Whether one live replacement effect applies to the event AS IT STANDS. Re-asked
 * after every application (CR 614.5's re-check), which is why it reads the
 * event's CURRENT amount rather than the original.
 */
function appliesTo(state: GameState, entry: ActiveReplacement, event: ReplaceableEvent): boolean {
  const ability = entry.ability;
  if (ability.event !== event.kind) return false;
  const applies = ability.applies;
  const owner = entry.controller;

  // An event with nothing left to modify is not replaced again: a fully
  // prevented hit has no damage to double, which is also CR 615.6's ordering
  // consequence read from the other end.
  if (event.amount <= 0 && !event.winsGame) return false;

  // A SPENT SHIELD IS NOT A CANDIDATE. `applyOne` writes `remaining: 0` and
  // splices the record out of the state, but an index built earlier in the same
  // damage step still holds a reference to it — this is the check that stops a
  // shield from resurrecting for the second attacker in one combat. It is here,
  // in the applicability test, rather than left to `fold` returning zero,
  // because a candidate that changes nothing must not occupy an ordering slot
  // or log a no-op replacement.
  const ceiling = shieldOf(entry);
  if (ceiling !== undefined && ceiling <= 0) return false;
  // A SHIELD needs somewhere to keep its remaining count, and only a floating
  // record has one. A `preventUpTo` declared as a PRINTED ability would prevent
  // N every time, forever — a strictly different (and much better) card — so it
  // is refused here rather than silently mis-played. No compiler rule emits one;
  // this is the guard that makes that a rule of the engine rather than a habit.
  if (entry.floating === undefined && entry.ability.outcome.preventUpTo !== undefined) return false;

  if (event.kind === 'damage') {
    if (applies.combat !== undefined && applies.combat !== event.combat) return false;
    const source = event.source;
    if (applies.sourceController !== undefined) {
      const sourceController = event.sourceController;
      if (sourceController === undefined) return false; // unknown source: never admitted
      if (!scopeAdmits(applies.sourceController, owner, sourceController)) return false;
    }
    if (applies.sourceFilter !== undefined) {
      if (source === undefined || !matchesCardFilter(source, applies.sourceFilter)) return false;
    }
  }

  if (event.kind === 'draw') {
    if (applies.requiresEmptyLibrary === true && event.libraryEmpty !== true) return false;
    if (applies.exceptFirstDrawEachDrawStep === true && event.firstDrawStepDraw === true) return false;
  }

  if (event.kind === 'counters' && applies.counterKind !== undefined) {
    if (applies.counterKind !== event.counterKind) return false;
  }

  // --- the recipient, which every kind shares -------------------------------
  const recipient = event.recipient;
  if (applies.recipientKind === 'player' && recipient !== undefined) return false;
  if (applies.recipientKind === 'permanent' && recipient === undefined) return false;
  if (applies.recipientIs !== undefined) {
    const actual = recipient === undefined ? event.affectedPlayer : recipient.instanceId;
    if (applies.recipientIs !== actual) return false;
  }
  if (!scopeAdmits(applies.recipientController, owner, event.affectedPlayer)) return false;
  if (recipient !== undefined) {
    if (applies.excludeSource === true && recipient.instanceId === entry.sourceInstanceId) return false;
    if (applies.recipientFilter !== undefined && !matchesCardFilter(recipient, applies.recipientFilter)) {
      return false;
    }
    if (applies.recipientAttacking === true && !isAttacking(state, recipient.instanceId)) return false;
  } else if (applies.recipientFilter !== undefined || applies.recipientAttacking === true) {
    // A filter that describes a permanent cannot admit a player.
    return false;
  }
  return true;
}

/**
 * Whether this permanent is currently declared as an attacker — and has not been
 * removed from combat since (CR 506.4; see `combat-removal.ts`).
 */
function isAttacking(state: GameState, instanceId: InstanceId): boolean {
  const combat = state.combat;
  if (!combat) return false;
  const attackers = combat.attackers;
  for (let i = 0; i < attackers.length; i++) {
    if (attackers[i] === instanceId) return !isRemovedFromCombat(combat, instanceId);
  }
  return false;
}

// --- application ----------------------------------------------------------------

/** The result of folding one outcome over a quantity, with no state written. */
interface Folded {
  readonly amount: number;
  /** How much of the incoming amount this outcome prevented. */
  readonly prevented: number;
  /** How much of a shield's `remaining` this consumed. */
  readonly shieldUsed: number;
  readonly winsGame: boolean;
}

/**
 * Fold one outcome over one quantity, PURELY. Called both to apply an effect for
 * real and to score a candidate order in the CR 616.1 search, which is exactly
 * why it writes nothing: the search must be able to try an order without
 * spending a shield.
 */
function fold(outcome: ReplacementOutcome, amount: number, shieldRemaining: number | undefined): Folded {
  if (outcome.winGame === true) {
    return { amount: 0, prevented: 0, shieldUsed: 0, winsGame: true };
  }
  if (outcome.preventAll === true) {
    return { amount: 0, prevented: amount, shieldUsed: 0, winsGame: false };
  }
  if (outcome.preventHalfRoundedUp === true) {
    const prevented = Math.ceil(amount / 2);
    return { amount: amount - prevented, prevented, shieldUsed: 0, winsGame: false };
  }
  if (shieldRemaining !== undefined) {
    const prevented = Math.min(shieldRemaining, amount);
    return { amount: amount - prevented, prevented, shieldUsed: prevented, winsGame: false };
  }
  // Scale before adding: "twice that many" then "plus one" is the fixed order
  // inside ONE outcome (see ReplacementOutcome). No printed card sets both.
  let next = amount;
  if (outcome.times !== undefined) next *= outcome.times;
  if (outcome.plus !== undefined) next += outcome.plus;
  // A replacement never turns a quantity negative — "that much minus 3" bottoms
  // out at nothing happening, exactly as CR 615.9's prevention floor does.
  if (next < 0) next = 0;
  return { amount: next, prevented: 0, shieldUsed: 0, winsGame: false };
}

/** The shield ceiling an entry brings to a fold, or `undefined` when it is not a shield. */
function shieldOf(entry: ActiveReplacement): number | undefined {
  const floating = entry.floating;
  if (floating === undefined) return undefined;
  if (entry.ability.outcome.preventUpTo === undefined) return undefined;
  return floating.remaining ?? entry.ability.outcome.preventUpTo;
}

// --- the CR 616.1 ordering decision ---------------------------------------------

/**
 * Score the outcome of applying `order` (indices into `candidates`) to `amount`,
 * without writing anything. Effects whose filter stops matching part-way through
 * an order are skipped exactly as the real loop skips them, so the score is the
 * amount the order genuinely produces.
 */
function scoreOrder(
  candidates: readonly ActiveReplacement[],
  order: readonly number[],
  amount: number,
): number {
  let running = amount;
  // A local copy of each shield's ceiling, so trying an order never spends one.
  let shields: number[] | null = null;
  for (let i = 0; i < order.length; i++) {
    const index = order[i] as number;
    const entry = candidates[index] as ActiveReplacement;
    if (running <= 0) break;
    let ceiling = shieldOf(entry);
    if (ceiling !== undefined) {
      shields ??= candidates.map((c) => shieldOf(c) ?? 0);
      ceiling = shields[index] as number;
    }
    const folded = fold(entry.ability.outcome, running, ceiling);
    if (ceiling !== undefined && shields !== null) shields[index] = ceiling - folded.shieldUsed;
    running = folded.amount;
  }
  return running;
}

/** Every permutation of `0..n-1`, built once per call. `n` is capped by the caller. */
function permutations(n: number): number[][] {
  if (n <= 1) return [[0].slice(0, n)];
  const smaller = permutations(n - 1);
  const out: number[][] = [];
  for (const perm of smaller) {
    for (let position = 0; position <= perm.length; position++) {
      const next = perm.slice();
      next.splice(position, 0, n - 1);
      out.push(next);
    }
  }
  return out;
}

/**
 * Which candidate the AFFECTED PLAYER applies first (CR 616.1). Returns an index
 * into `candidates`.
 *
 * With one candidate there is no decision and none is made. With more, the
 * orders are enumerated and scored, and the first index of the best order wins;
 * ties fall back to the canonical order, which is the array's own — built from
 * `state.battlefield` (stable), then the command zones, then
 * `state.replacements` (insertion order), so the answer is reproducible from the
 * state alone and a paired A/B run cannot diverge on it.
 */
function chooseFirst(candidates: readonly ActiveReplacement[], event: ReplaceableEvent): number {
  if (candidates.length === 1) return 0;
  if (candidates.length > ORDER_SEARCH_MAX_CANDIDATES) return 0;
  const preferMore = affectedPlayerPrefersMore(event.kind, event.counterKind);
  let best = 0;
  let bestScore = scoreOrder(candidates, permutationStartingWith(candidates.length, 0), event.amount);
  for (const order of permutations(candidates.length)) {
    const score = scoreOrder(candidates, order, event.amount);
    const better = preferMore ? score > bestScore : score < bestScore;
    if (better) {
      bestScore = score;
      best = order[0] as number;
    }
  }
  return best;
}

/** The canonical order rotated so `first` leads — the tie-break baseline. */
function permutationStartingWith(n: number, first: number): number[] {
  const order: number[] = [first];
  for (let i = 0; i < n; i++) if (i !== first) order.push(i);
  return order;
}

// --- the engine -----------------------------------------------------------------

/**
 * Fold every applicable replacement effect over one event, once each
 * (CR 614.5), in the affected player's order (CR 616.1). Mutates `event` in
 * place and returns it.
 *
 * The loop is the textbook one and its termination is structural: `applied` is a
 * bitmask over the candidate list, so an effect that matches its own output —
 * every doubling effect does — is not offered a second time and the loop runs at
 * most `candidates.length` times.
 */
export function runReplacements(
  state: GameState,
  index: ReplacementIndex,
  event: ReplaceableEvent,
  emit: (e: GameEvent) => void,
  dryRun = false,
): ReplaceableEvent {
  if (index.length === 0) return event;
  let applied = 0;
  // Bounded by the candidate list itself: 31 distinct replacement effects on one
  // event is far past any real board, and the mask is a 32-bit integer.
  const limit = Math.min(index.length, 31);
  for (let round = 0; round < limit; round++) {
    let candidates: ActiveReplacement[] | null = null;
    let candidateBits: number[] | null = null;
    for (let i = 0; i < limit; i++) {
      if ((applied & (1 << i)) !== 0) continue;
      const entry = index[i] as ActiveReplacement;
      if (!appliesTo(state, entry, event)) continue;
      (candidates ??= []).push(entry);
      (candidateBits ??= []).push(i);
    }
    if (candidates === null || candidateBits === null) break;
    const pick = chooseFirst(candidates, event);
    const entry = candidates[pick] as ActiveReplacement;
    applied |= 1 << (candidateBits[pick] as number);
    applyOne(state, entry, event, emit, dryRun);
    if (event.winsGame) break;
  }
  return event;
}

/** Apply one chosen replacement for real: fold it, spend any shield, log it. */
function applyOne(
  state: GameState,
  entry: ActiveReplacement,
  event: ReplaceableEvent,
  emit: (e: GameEvent) => void,
  dryRun: boolean,
): void {
  const before = event.amount;
  const ceiling = shieldOf(entry);
  const folded = fold(entry.ability.outcome, before, ceiling);
  event.amount = folded.amount;
  event.prevented += folded.prevented;
  if (folded.winsGame) event.winsGame = true;

  const floating = entry.floating;
  if (!dryRun && floating !== undefined && ceiling !== undefined) {
    const left = ceiling - folded.shieldUsed;
    // Both writes, deliberately. `remaining` is written so an index built
    // earlier in this same damage step reads the shield as spent (see
    // `appliesTo`); the record is spliced OUT of the state so no later index
    // can ever see it again. Removal — rather than a zeroed record left in the
    // list — is what makes "a spent shield cannot resurrect" structural.
    floating.remaining = left > 0 ? left : 0;
    if (left <= 0) removeFloating(state, floating.id);
  }

  if (dryRun) return;
  emit({
    type: 'replacementApplied',
    source: entry.sourceInstanceId,
    event: event.kind,
    from: before,
    to: event.amount,
    prevented: folded.prevented,
    ...(entry.ability.label !== undefined ? { label: entry.ability.label } : {}),
  });
}

// --- floating-record lifetime ---------------------------------------------------

/**
 * Register a floating replacement/prevention effect. Returns its id.
 *
 * The list is created lazily and stays ABSENT in every game that never makes
 * one, which is what keeps `indexReplacements` free for the sim's hot path — the
 * same optional-field discipline as `cardGrants` and `pendingChoice`.
 */
export function addFloatingReplacement(
  state: GameState,
  record: Omit<FloatingReplacement, 'id' | 'remaining'> & { readonly remaining?: number },
): number {
  const id = state.nextInstanceId++;
  const stored: FloatingReplacement = {
    ...record,
    id,
    ...(record.outcome.preventUpTo !== undefined
      ? { remaining: record.remaining ?? record.outcome.preventUpTo }
      : {}),
  };
  (state.replacements ??= []).push(stored);
  return id;
}

/** Drop one floating record by id. Used when a shield is spent. */
function removeFloating(state: GameState, id: number): void {
  const list = state.replacements;
  if (list === undefined) return;
  for (let i = 0; i < list.length; i++) {
    if ((list[i] as FloatingReplacement).id === id) {
      list.splice(i, 1);
      return;
    }
  }
}

/**
 * Remove every floating replacement of `duration`, emitting one expiry event
 * each — the cleanup-step hook, the same shape as `expireContinuousEffects`.
 */
export function expireFloatingReplacements(
  state: GameState,
  duration: ContinuousDuration,
  emit: (e: GameEvent) => void,
): void {
  const list = state.replacements;
  if (list === undefined || list.length === 0) return;
  const kept: FloatingReplacement[] = [];
  for (const record of list) {
    if (record.duration !== duration) {
      kept.push(record);
      continue;
    }
    emit({ type: 'replacementExpired', id: record.id, source: record.sourceInstanceId });
  }
  if (kept.length !== list.length) state.replacements = kept;
}

/*
 * There is deliberately NO orphan-pruning pass here, and the asymmetry with
 * `pruneOrphanContinuousEffects` is the point: every floating record this engine
 * creates is a one-shot from a RESOLVING spell or ability and is meant to
 * outlive its source (a fog cast by an instant is still a fog once the instant
 * is in the graveyard). A replacement that must die with its source is a PRINTED
 * ability instead, where the lifetime is derived from `state.battlefield` and
 * needs no bookkeeping at all.
 */

// --- the three façades ----------------------------------------------------------

/**
 * The ONE question every damage site asks: how much damage is actually dealt?
 * Returns the final amount, and reports what was prevented through
 * `outPrevented` so a caller can log it (`damagePrevented`) without a second
 * return value.
 *
 * The inert guard is the caller's `index.length === 0`; passing
 * {@link NO_REPLACEMENTS} short-circuits with no allocation whatsoever.
 */
export function replaceDamage(
  state: GameState,
  index: ReplacementIndex,
  source: CardInstance | undefined,
  sourceController: PlayerId | undefined,
  recipient: CardInstance | undefined,
  affectedPlayer: PlayerId,
  amount: number,
  combat: boolean,
  emit: (e: GameEvent) => void,
): DamageReplacementResult {
  if (index.length === 0 || amount <= 0) return { amount, prevented: 0 };
  const event: ReplaceableEvent = {
    kind: 'damage',
    source,
    sourceController,
    recipient,
    affectedPlayer,
    combat,
    amount,
    prevented: 0,
    winsGame: false,
  };
  runReplacements(state, index, event, emit);
  return { amount: event.amount, prevented: event.prevented };
}

/** What a damage site gets back: what to deal, and what to report as prevented. */
export interface DamageReplacementResult {
  readonly amount: number;
  readonly prevented: number;
}

/**
 * The ONE question every counter site asks: how many counters actually go on?
 * `amount` is the MAGNITUDE (the kind carries the sign), matching how
 * `CardInstance.counters` stores them.
 */
export function replaceCounters(
  state: GameState,
  index: ReplacementIndex,
  source: CardInstance | undefined,
  recipient: CardInstance,
  counterKind: string,
  amount: number,
  emit: (e: GameEvent) => void,
): number {
  if (index.length === 0 || amount <= 0) return amount;
  const event: ReplaceableEvent = {
    kind: 'counters',
    source,
    sourceController: source?.controller,
    recipient,
    affectedPlayer: recipient.controller,
    combat: false,
    counterKind,
    amount,
    prevented: 0,
    winsGame: false,
  };
  runReplacements(state, index, event, emit);
  return event.amount;
}

/** What a draw site gets back. */
export interface DrawReplacementResult {
  /** How many cards are actually drawn. Zero means the draw was replaced away. */
  readonly count: number;
  /** The drawing player wins the game instead (Laboratory Maniac). */
  readonly winsGame: boolean;
}

/**
 * The ONE question every draw site asks: does this draw still happen, and how
 * many cards is it?
 *
 * `firstDrawStepDraw` is what makes "except the first one you draw in each of
 * your draw steps" exact rather than approximate — the engine records the turn
 * fact as the draw-step draw happens, so the caller can answer it truthfully.
 */
export function replaceDraw(
  state: GameState,
  index: ReplacementIndex,
  player: PlayerId,
  firstDrawStepDraw: boolean,
  emit: (e: GameEvent) => void,
): DrawReplacementResult {
  if (index.length === 0) return { count: 1, winsGame: false };
  const event: ReplaceableEvent = {
    kind: 'draw',
    affectedPlayer: player,
    combat: false,
    firstDrawStepDraw,
    libraryEmpty: state.players[player].library.length === 0,
    amount: 1,
    prevented: 0,
    winsGame: false,
  };
  runReplacements(state, index, event, emit);
  return { count: event.amount, winsGame: event.winsGame };
}

/**
 * Whether `def` counts as a source of the colour(s) a filter names — exported so
 * the AI can price a Torbran without re-deriving colour. Thin, but it keeps the
 * "a red source" reading in one place, the same one protection uses.
 */
export function sourceHasColorFor(def: CardDefinition, applies: ReplacementApplies): boolean {
  const colors = applies.sourceFilter?.anyOfColors;
  if (colors === undefined) return true;
  const own = colorsOfDefinition(def);
  for (const color of colors) if (own.includes(color)) return true;
  return false;
}

/**
 * What a damage event WOULD become, computed without writing anything — the
 * accessor the AI reads.
 *
 * A pilot evaluating a position must be able to ask "how much does this attacker
 * really deal?" without spending the prevention shield it is asking about. So
 * this runs the identical loop, with the identical ordering rule, and skips
 * exactly two things: the shield bookkeeping and the event log. There is no
 * second copy of the arithmetic — a projection that disagreed with the engine
 * would be worse than no projection at all, because the pilot would then be
 * confidently wrong.
 */
export function projectDamage(
  state: GameState,
  index: ReplacementIndex,
  source: CardInstance | undefined,
  sourceController: PlayerId | undefined,
  recipient: CardInstance | undefined,
  affectedPlayer: PlayerId,
  amount: number,
  combat: boolean,
): DamageReplacementResult {
  if (index.length === 0 || amount <= 0) return { amount, prevented: 0 };
  const event: ReplaceableEvent = {
    kind: 'damage',
    source,
    sourceController,
    recipient,
    affectedPlayer,
    combat,
    amount,
    prevented: 0,
    winsGame: false,
  };
  runReplacements(state, index, event, NO_EMIT, true);
  return { amount: event.amount, prevented: event.prevented };
}

/** The sink a dry run emits into. Hoisted so a projection allocates no closure. */
const NO_EMIT = (): void => {};
