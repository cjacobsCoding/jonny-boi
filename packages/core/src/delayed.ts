/**
 * DELAYED TRIGGERED ABILITIES (CR 603.7) — an ability created *during* a
 * resolution that triggers ONCE, later, and then ceases to exist.
 *
 *     "Sacrifice it at the beginning of the next end step."   (Kiki-Jiki)
 *     "Exile those tokens at the beginning of the next end step."  (Twinflame)
 *     "At the beginning of your next upkeep, pay {3}{U}{U}."   (Pact of Negation)
 *
 * ## Why this file exists at all
 * Every trigger this engine had hung off an OBJECT: `internal/triggers-runtime.ts`
 * collects `TriggeredAbility`s from `CardInstance.def.triggers` on the
 * battlefield and in the command zone. A delayed ability has no such home. It is
 * created by an effect that is in the middle of resolving, and the printed cards
 * that make one are precisely the cards whose source is about to be irrelevant:
 * Kiki-Jiki taps, makes a token, and may be Bolted in response — the token is
 * still sacrificed at end of turn. **The record therefore lives on
 * `GameState.delayedTriggers`, which is the whole mechanism by which it survives
 * its source leaving.** Nothing in this file reads the battlefield.
 *
 * ## It reuses the trigger vocabulary; it does not coin a rival
 * The condition is a {@link TriggerCondition} — the same value a printed trigger
 * declares — and the body is a {@link TriggeredAbility}, the same type a card
 * prints. Matching goes through `conditionMatches`, the triggering player through
 * `triggeringPlayerFor`, and the result is an ordinary {@link PendingTrigger}
 * that joins the same APNAP queue and becomes an ordinary `TriggeredStackObject`.
 * There is no second matcher, no second stack-object kind, and no second word for
 * "at the beginning of the end step" — `endStep` already means it.
 *
 * ## "The NEXT end step" is free, and that is not an accident
 * A step trigger matches the `stepBegin` EVENT. The event for the step a
 * resolution is happening in has **already been emitted** by the time the
 * resolution creates anything, so a delayed ability created during an end step
 * cannot match that end step — the next `stepBegin{step:'end'}` it sees is the
 * following turn's. That is exactly CR 603.7e, and it falls out of matching on
 * events rather than on the state's current step. (Which is the reason this file
 * has no `notBeforeTurn` field to get wrong: {@link DelayedTriggeredAbility.createdOnTurn}
 * is carried for the inspector and the log, and the rules never read it.)
 *
 * ## It fires ONCE
 * The record is removed from `GameState.delayedTriggers` the instant it MATCHES —
 * before the ability reaches the stack, not when it resolves. Removing at the
 * match is what makes "once" structural: a delayed ability countered on the
 * stack, or one whose resolution does nothing because its object has already
 * gone, does not come back for a second try. There is no fired flag to leave
 * stale, because there is no record left.
 *
 * ## What the ability ACTS ON rides in its effect params
 * "Sacrifice **it**" names an object the compiler cannot know — the token that
 * the resolving effect had not created yet. So the effect refs are built at
 * CREATION time by the primitive that made the object, with the ids baked into
 * `EffectRef.params` (see `sacrificeNamed` / `exileNamed` in the cards package).
 * That is why no field here, no field on the stack object, and no field on
 * `EffectContext` names a subject: the ability's body already carries it, in the
 * one place that survives the stack push, the per-action clone and a serialize
 * round-trip by construction.
 */

import type { EffectRef } from './card.js';
import type { GameEvent } from './events.js';
import type { InstanceId, PlayerId } from './state.js';
import type { PendingTrigger, TriggerCondition, TriggeredAbility, TriggerSubject } from './triggers.js';
import { conditionMatches, triggeringPlayerFor } from './triggers.js';

/**
 * One delayed triggered ability, waiting for its moment.
 *
 * Immutable once created: it is never edited, only removed whole. That is what
 * lets `internal/clone.ts` copy the ARRAY and share the records — the array is
 * pushed to and spliced from, the records are not written into. (Contrast
 * `FloatingReplacement`, whose `remaining` is consumed and which is therefore
 * copied record by record.)
 */
export interface DelayedTriggeredAbility {
  /**
   * Stable id, minted from the `GameState.nextInstanceId` space so it can never
   * collide with a card's or another record's. It names NO card — it is this
   * ability's own identity, exactly like `FloatingReplacement.id`, which is why
   * both are `number` rather than `InstanceId`.
   */
  readonly id: number;
  /**
   * Whose ability it is. Every `who: 'you'` in the condition is read against
   * this seat — "at the beginning of **your** next upkeep" means the player who
   * controlled the effect that created the delayed ability (CR 603.7d), not the
   * active player and not the source's current controller.
   */
  readonly controller: PlayerId;
  /**
   * The object whose effect created it — attribution for the log and the
   * inspector, and the `sourceInstanceId` the resulting stack object carries.
   *
   * ⚠️ It is NOT what keeps the ability alive and it is NOT re-read: the record
   * is on the state, so an ability whose creator has been destroyed, exiled or
   * returned to hand still triggers at its moment and still resolves. A source
   * that has gone entirely resolves through `frameSource`'s last-known-information
   * stand-in, exactly as an ordinary trigger whose permanent died does.
   */
  readonly sourceInstanceId: InstanceId;
  /**
   * The ability itself — condition, effects and label — in the SAME type a card
   * prints on the battlefield. Sharing the type is what makes the flush path,
   * the stack object, the resolution and the event log identical for a delayed
   * ability and a printed one.
   */
  readonly ability: TriggeredAbility;
  /**
   * The turn it was created on. Debug/inspector only — the "next" in "the next
   * end step" is decided by event matching (see the header), never by comparing
   * turn numbers, so nothing in the rules reads this.
   */
  readonly createdOnTurn: number;
  /**
   * The permanents this ability will REMOVE from the battlefield when it
   * resolves — "sacrifice **it**", "exile **those tokens**".
   *
   * ⚠️ **Read by the PILOT, never by the rules.** The body is what actually does
   * the removing; this is a declaration by whatever created the ability, because
   * only that code knows what body it built. It exists because the alternative
   * is a pilot that cannot see the cost: Kiki-Jiki's token dies at end of turn
   * whatever happens, so attacking with it is the entire point and holding it
   * back as a blocker throws it away for nothing. A mechanic no pilot ever
   * prices corrupts nothing and proves nothing.
   *
   * Declared rather than INFERRED from the effect refs on purpose: inferring it
   * would mean core reading primitive ids that belong to the cards package, and
   * a new removal primitive would then be silently invisible to the pilot.
   */
  readonly removesFromBattlefield?: readonly InstanceId[];
}

/** What a primitive supplies to create one; the id and the turn are minted here. */
export interface DelayedTriggerRequest {
  readonly condition: TriggerCondition;
  readonly effects: readonly EffectRef[];
  readonly label: string;
  /** Defaults to the creating effect's controller at the call site. */
  readonly controller: PlayerId;
  readonly sourceInstanceId: InstanceId;
  /** See {@link DelayedTriggeredAbility.removesFromBattlefield} — for the pilot. */
  readonly removesFromBattlefield?: readonly InstanceId[];
}

/**
 * Register a delayed triggered ability on the state; returns its id.
 *
 * The list is created lazily and stays **absent** in every game that never makes
 * one — the same optional-field discipline as `cardGrants` and `replacements`,
 * and for the same reason: {@link matchDelayedTriggers} then costs one property
 * read per event on the engine's hottest path.
 */
export function createDelayedTrigger(state: DelayedTriggerHost, request: DelayedTriggerRequest): number {
  const id = state.nextInstanceId++;
  const record: DelayedTriggeredAbility = {
    id,
    controller: request.controller,
    sourceInstanceId: request.sourceInstanceId,
    ability: {
      condition: request.condition,
      effects: request.effects,
      label: request.label,
    },
    createdOnTurn: state.turnNumber,
    ...(request.removesFromBattlefield !== undefined && request.removesFromBattlefield.length > 0
      ? { removesFromBattlefield: request.removesFromBattlefield }
      : {}),
  };
  (state.delayedTriggers ??= []).push(record);
  return id;
}

/**
 * The slice of `GameState` this module writes. Typed as its own shape rather
 * than as `GameState` so `state.ts` can import the record type without a cycle
 * back through the engine's own state type.
 */
export interface DelayedTriggerHost {
  nextInstanceId: number;
  turnNumber: number;
  delayedTriggers?: DelayedTriggeredAbility[];
}

/** The answer for an event that set no delayed ability off. Shared and frozen. */
const NO_DELAYED_MATCHES: readonly DelayedTriggeredAbility[] = Object.freeze([]);

/**
 * Which delayed abilities this event sets off, in creation order.
 *
 * PURE — it removes nothing and writes nothing, exactly as `matchTriggers` is
 * pure. The caller (`internal/triggers-runtime.ts`) removes what fired, because
 * "fires once" is a lifetime decision and this file is a matcher.
 *
 * `subject` is the permanent a board-watching condition is about, resolved by
 * the runtime once per event and shared with the ordinary trigger scan — the
 * same seam, the same value, no second lookup.
 */
export function matchDelayedTriggers(
  records: readonly DelayedTriggeredAbility[] | undefined,
  event: GameEvent,
  subject?: TriggerSubject,
): readonly DelayedTriggeredAbility[] {
  if (records === undefined || records.length === 0) return NO_DELAYED_MATCHES;
  let matched: DelayedTriggeredAbility[] | null = null;
  for (let i = 0; i < records.length; i++) {
    const record = records[i] as DelayedTriggeredAbility;
    if (
      !conditionMatches(
        record.ability.condition,
        event,
        // A delayed ability watches an event, not itself: the "source instance"
        // a self-referential condition would compare against is the CREATOR, and
        // no delayed condition this engine builds is self-referential. Passing
        // the creator is still the honest answer to "which object is this
        // ability's source", and it is what an `etb`-shaped delayed condition
        // would have to mean.
        record.sourceInstanceId,
        // The delayed ability's OWN controller, which is what makes "your next
        // upkeep" mean the creating player's upkeep rather than the source's
        // current controller's — the source may not even be on the battlefield.
        record.controller,
        subject,
      )
    ) {
      continue;
    }
    (matched ??= []).push(record);
  }
  return matched ?? NO_DELAYED_MATCHES;
}

/**
 * Turn one matched delayed ability into the ordinary {@link PendingTrigger} the
 * APNAP queue and the stack push already understand.
 *
 * `abilityIndex: 0` because a delayed record holds exactly one ability. Ordering
 * against other triggers from the same source at the same battlefield position
 * then falls to `orderPendingTriggers`' final tie-break — the queue's own
 * insertion order, which is `state.delayedTriggers`' creation order and is
 * therefore reproducible from the state alone.
 */
export function pendingFromDelayed(
  record: DelayedTriggeredAbility,
  event: GameEvent,
  subject?: TriggerSubject,
): PendingTrigger {
  const triggeringPlayer = triggeringPlayerFor(record.ability.condition, event, subject);
  return {
    sourceInstanceId: record.sourceInstanceId,
    controller: record.controller,
    ability: record.ability,
    abilityIndex: 0,
    ...(triggeringPlayer !== undefined ? { triggeringPlayer } : {}),
  };
}

/** The answer when nothing is scheduled for removal. Shared and frozen. */
const NO_DELAYED_REMOVALS: ReadonlySet<InstanceId> = Object.freeze(new Set<InstanceId>()) as ReadonlySet<InstanceId>;

/**
 * **Every permanent a pending delayed ability will remove from the battlefield.**
 * The accessor a PILOT reads to know that the hasty 4/4 in front of it is a
 * creature that dies at end of turn whatever it does.
 *
 * Returns the shared frozen empty set by reference in every game that has no
 * delayed ability — the same allocation-free discipline as `NO_REPLACEMENTS`,
 * because this is asked once per attack and block decision.
 *
 * It reports what the ABILITY DECLARED, never what its body will actually
 * manage: a token that has already died is still named here, and a pilot asking
 * about a permanent it can see gets the right answer either way.
 */
export function delayedRemovalTargets(state: {
  readonly delayedTriggers?: readonly DelayedTriggeredAbility[];
}): ReadonlySet<InstanceId> {
  const records = state.delayedTriggers;
  if (records === undefined || records.length === 0) return NO_DELAYED_REMOVALS;
  let found: Set<InstanceId> | null = null;
  for (let i = 0; i < records.length; i++) {
    const removes = (records[i] as DelayedTriggeredAbility).removesFromBattlefield;
    if (removes === undefined) continue;
    for (const id of removes) (found ??= new Set<InstanceId>()).add(id);
  }
  return found ?? NO_DELAYED_REMOVALS;
}

/**
 * Drop one delayed ability by id. Called the moment it MATCHES (see the header),
 * and the list is deleted outright when it empties so `matchDelayedTriggers`
 * goes back to its zero-cost absent case.
 */
export function removeDelayedTrigger(state: DelayedTriggerHost, id: number): void {
  const list = state.delayedTriggers;
  if (list === undefined) return;
  for (let i = 0; i < list.length; i++) {
    if ((list[i] as DelayedTriggeredAbility).id === id) {
      list.splice(i, 1);
      break;
    }
  }
  if (list.length === 0) delete state.delayedTriggers;
}
