/**
 * Triggered-ability system SEAM (DESIGN §3.9). A card declares triggered abilities
 * as DATA (`CardDefinition.triggers`): a trigger **condition** (what game event sets
 * it off) plus an ordered list of **effect refs** to run (reusing the existing
 * effect-primitive mechanism). When a matching `GameEvent` is emitted, the engine
 * puts the ability on the stack as a `TriggeredStackObject` under the source's
 * controller; players get priority and it resolves like any stack object.
 *
 * Composition over inheritance: there is no class-per-trigger. Core owns the
 * *matching machinery*; the actual effects live in registered primitives owned by
 * `cards`. The engine loop never hard-codes a specific card — it scans permanents'
 * declared triggers against the event log.
 *
 * Robustness: an unknown/malformed trigger condition simply never matches (safe
 * no-op); an unknown effect primitive degrades to an `effectUnsupported` event when
 * the ability resolves. Nothing here can crash the engine.
 */

import type { CardType, EffectRef } from './card.js';
import type { GameEvent } from './events.js';
import type { CardFilter } from './choices.js';
import { matchesCardFilter } from './choices.js';
import type { CardInstance, InstanceId, PlayerId, Step } from './state.js';
import type { TargetRestriction } from './targeting.js';

/**
 * The game occurrences a trigger can watch. Kept small and explicit (the §3.9
 * minimum set) — each maps to one or more `GameEvent`s the engine already emits.
 *   - `etb`            : this permanent enters the battlefield.
 *   - `attacks`        : this creature is declared as an attacker.
 *   - `dies`           : this creature dies (battlefield → graveyard).
 *   - `leaves`         : this permanent leaves the battlefield (any destination).
 *   - `castSpell`      : a spell is cast — optionally filtered by card type and by
 *                        whether the source's controller cast it.
 *   - `upkeep`         : the beginning of a player's upkeep (by default, the source
 *                        controller's upkeep).
 *   - `drawStep`       : the beginning of a player's draw step.
 *   - `precombatMain`  : the beginning of a player's first main phase.
 *   - `endStep`        : the beginning of a player's end step.
 *   - `beginCombat`    : the beginning of combat on a player's turn.
 *   - `gainLife`       : a player gained life ("whenever you gain life").
 *   - `combatDamageToPlayer` : this permanent dealt COMBAT damage to a player.
 *   - `permanentEnters`: ANOTHER permanent entered the battlefield — "whenever a
 *                        creature you control enters", landfall, constellation.
 *   - `permanentDies`  : a permanent died (battlefield → graveyard) — "whenever a
 *                        creature you control dies", "whenever ~ or another
 *                        creature dies". Distinct from `dies`, which is this
 *                        permanent's own death: a card that fired on every death
 *                        when it should fire on one is a very different card.
 *
 * The four step triggers are the same shape as `upkeep` — "at the beginning of
 * your X" — and are scoped by `who` the same way, so "at the beginning of EACH
 * player's draw step" is `{ on: 'drawStep', who: 'any' }`. They exist as separate
 * events rather than one event with a step field because the compiler names the
 * printed step, and a mis-typed step name should be a type error, not a trigger
 * that silently never fires.
 *
 * `permanentEnters` and `permanentDies` are the two BOARD-WATCHING events, and
 * they share one filter shape: `who` (whose permanent) + `permanentFilter` (a
 * `CardFilter` over its printed characteristics) + `excludeSelf` (the printed
 * word "another").
 */
export type TriggerEvent =
  | 'etb'
  | 'attacks'
  | 'dies'
  | 'leaves'
  | 'castSpell'
  | 'upkeep'
  | 'drawStep'
  | 'precombatMain'
  | 'endStep'
  | 'beginCombat'
  | 'gainLife'
  | 'combatDamageToPlayer'
  | 'permanentEnters'
  | 'permanentDies';

/**
 * Whose action a relational trigger (cast / a step / life gain) cares about.
 * Read against the SOURCE's controller, never against the active player.
 */
export type TriggerWho = 'you' | 'opponent' | 'any';

/**
 * A trigger condition: the event to watch plus optional filters. `who` scopes
 * cast/upkeep triggers (default `'you'` — "whenever YOU cast …", "at the beginning
 * of YOUR upkeep"). `spellType` scopes a cast trigger to a card type.
 */
export interface TriggerCondition {
  readonly on: TriggerEvent;
  /** For `castSpell`/`upkeep`: whose cast/upkeep counts. Defaults to `'you'`. */
  readonly who?: TriggerWho;
  /** For `castSpell`: only fire when the cast spell has this type. */
  readonly spellType?: CardType;
  /**
   * For `castSpell`: only fire when the cast spell has **none** of these types —
   * the negative filter printed as "non<type> spell".
   *
   * Prowess is why this exists. It reads "whenever you cast a **noncreature**
   * spell", and modelling that as the positive pair `instant`/`sorcery` silently
   * dropped every artifact, enchantment and planeswalker in the pool: Monastery
   * Swiftspear failed to grow off Sol Ring, the five Diamonds, Manalith, Worn
   * Powerstone, Ur-Golem's Eye and Liliana of the Veil. That is a card playing
   * *weaker* than printed, which biases an A/B verdict exactly as badly as one
   * playing stronger.
   */
  readonly spellTypeNoneOf?: readonly CardType[];
  /**
   * For `permanentEnters`/`permanentDies`: which permanents count — "whenever a
   * **creature** you control enters", "a creature you control **with power 3 or
   * greater**", "another **green** creature".
   *
   * A `CardFilter`, the same value every other filtered thing in the engine
   * reads, so the printed restriction is expressed once and cannot mean two
   * different things in two places. Absent ⇒ any permanent, which no printed
   * card actually says — the compiler always supplies at least a type.
   */
  readonly permanentFilter?: CardFilter;
  /**
   * Set for the printed words "**of the chosen type**" on a CAST trigger —
   * "whenever you cast a creature spell of the chosen type, draw a card"
   * (Vanquisher's Banner), "whenever you cast a spell of the chosen type"
   * (Chronicle of Victory).
   *
   * The value comes from the SOURCE (`TriggerSource.chosenAsEntered`), so it is
   * this permanent's own naming — and a source that named nothing fires on
   * nothing, exactly as its anthem reaches nothing.
   */
  readonly spellSubtypeIsChosen?: boolean;
  /**
   * For `permanentEnters`/`permanentDies`: the printed word "**another**" — the
   * source's own arrival or death does not set it off. A distinct flag rather
   * than something inferred, for the same reason `StaticAffects.excludeSource`
   * is one: getting it backwards is silent and changes what the card does on the
   * turn it lands.
   */
  readonly excludeSelf?: boolean;
}

/**
 * A declared triggered ability: a condition + the effects to run when it resolves.
 * The effects reuse `EffectRef` so the same primitives that power spells/ETB scripts
 * power triggers. `optional` and `targetMode` are reserved for future expansion;
 * core currently resolves every matched trigger with no extra targeting.
 */
export interface TriggeredAbility {
  readonly condition: TriggerCondition;
  readonly effects: readonly EffectRef[];
  /** Human-readable label for debug/inspector display. */
  readonly label?: string;
  /**
   * What this ability TARGETS, chosen by its controller as it goes on the stack
   * (CR 603.3d) — "when ~ enters, **it deals 2 damage to any target**".
   *
   * Declared here rather than inferred from the effects because targeting is a
   * property of the ABILITY, not of a primitive: the same `dealDamage` ref is a
   * targeted trigger here and an untargeted "deals 2 damage to each creature"
   * elsewhere, and core must not guess which. Absent ⇒ the ability targets
   * nothing and resolves with an empty target list, exactly as every trigger did
   * before targeting existed.
   *
   * Single-target on purpose: every printed template the compiler reproduces
   * names one target, and a multi-target trigger would need its own rule rather
   * than a silently-widened one here.
   */
  readonly targets?: TargetRestriction;
}

/**
 * A trigger that has fired and is waiting to be put on the stack. Produced by
 * `matchTriggers`; the engine orders these (APNAP) and pushes each as a
 * `TriggeredStackObject`.
 */
export interface PendingTrigger {
  /** The permanent whose ability triggered. */
  readonly sourceInstanceId: InstanceId;
  /** Who controls the source (and therefore the trigger). */
  readonly controller: PlayerId;
  readonly ability: TriggeredAbility;
  /** A stable per-source ordering key (index of the ability on the card). */
  readonly abilityIndex: number;
}

/** The card-name + source needed to describe a pending trigger for events. */
export interface TriggerSource {
  readonly instanceId: InstanceId;
  readonly controller: PlayerId;
  readonly name: string;
  readonly triggers: readonly TriggeredAbility[];
  /**
   * What this source NAMED as it entered (`CardInstance.chosenAsEntered`), for
   * the conditions narrowed by it — "whenever you cast a creature spell **of the
   * chosen type**".
   *
   * Snapshotted onto the source rather than looked up during matching because
   * `triggers.ts` is a pure matcher with no access to the game state, exactly as
   * `TriggerSubject` is. Absent means nothing was named, which matches nothing.
   */
  readonly chosenAsEntered?: string;
}

/**
 * Decide whether a single ability's condition matches `event`, given the source's
 * controller and (for self-referential triggers like etb/attacks/dies) the source's
 * own instance id. Returns true/false; never throws on a malformed condition.
 */
export function conditionMatches(
  condition: TriggerCondition,
  event: GameEvent,
  sourceInstanceId: InstanceId,
  sourceController: PlayerId,
  subject?: TriggerSubject,
  sourceChosenAsEntered?: string,
): boolean {
  switch (condition.on) {
    case 'etb':
      // A permanent's own ETB: a zoneChange into the battlefield for this instance.
      return event.type === 'zoneChange' && event.to === 'battlefield' && event.instanceId === sourceInstanceId;
    case 'attacks':
      return event.type === 'attackersDeclared' && event.attackers.includes(sourceInstanceId);
    case 'dies':
      return event.type === 'creatureDied' && event.instanceId === sourceInstanceId;
    case 'leaves':
      // Leaving the battlefield: a zoneChange out of the battlefield for this instance.
      return event.type === 'zoneChange' && event.from === 'battlefield' && event.instanceId === sourceInstanceId;
    case 'castSpell': {
      if (event.type !== 'spellCast') return false;
      if (!whoMatches(condition.who, event.player, sourceController)) return false;
      if (condition.spellType && !event.castTypes.includes(condition.spellType)) return false;
      if (condition.spellTypeNoneOf?.some((type) => event.castTypes.includes(type))) return false;
      if (condition.spellSubtypeIsChosen === true) {
        // "…of the chosen type". A source that named NOTHING matches nothing —
        // never everything — for the same reason `StaticAffects.ofChosenSubtype`
        // does: an unnamed value is the inert default, and a trigger that fired
        // on every spell would be a strictly better card than the printed one.
        if (sourceChosenAsEntered === undefined || sourceChosenAsEntered === '') return false;
        const wanted = sourceChosenAsEntered.toLowerCase();
        const castSubtypes = event.castSubtypes ?? NO_CAST_SUBTYPES;
        if (!castSubtypes.some((subtype) => subtype.toLowerCase() === wanted)) return false;
      }
      return true;
    }
    case 'permanentEnters': {
      if (event.type !== 'zoneChange' || event.to !== 'battlefield') return false;
      if (condition.excludeSelf === true && event.instanceId === sourceInstanceId) return false;
      return subjectMatches(condition, subject, sourceController);
    }
    case 'permanentDies': {
      // A DEATH, not any departure: the battlefield -> graveyard move. Exiling
      // or bouncing a creature is not a death and must not fire these.
      if (event.type !== 'zoneChange' || event.from !== 'battlefield' || event.to !== 'graveyard') {
        return false;
      }
      if (condition.excludeSelf === true && event.instanceId === sourceInstanceId) return false;
      return subjectMatches(condition, subject, sourceController);
    }
    case 'upkeep':
    case 'drawStep':
    case 'precombatMain':
    case 'endStep':
    case 'beginCombat': {
      if (event.type !== 'stepBegin') return false;
      if (event.step !== STEP_FOR_TRIGGER[condition.on]) return false;
      return whoMatches(condition.who, event.activePlayer, sourceController);
    }
    case 'gainLife': {
      // "Whenever you gain life". Keyed on the `gainLife` event rather than on
      // `lifeChanged`, because the latter also fires for life LOST and for the
      // bookkeeping of a life-set effect — a lifegain trigger that fired on
      // damage would be a different card.
      if (event.type !== 'gainLife') return false;
      return whoMatches(condition.who, event.player, sourceController);
    }
    case 'combatDamageToPlayer':
      // A player target is a PlayerId ('A'/'B'); an InstanceId is a number, so
      // the string test is what distinguishes "to a player" from "to a
      // creature or planeswalker" without a second event field.
      return (
        event.type === 'damageDealt' &&
        event.combat &&
        event.source === sourceInstanceId &&
        typeof event.target === 'string'
      );
    default:
      // Unknown condition kind → never matches (safe no-op).
      return false;
  }
}

/** Shared empty list for a cast event that carries no subtypes. */
const NO_CAST_SUBTYPES: readonly string[] = Object.freeze([]);

/**
 * The turn step each step-beginning trigger watches. One table so the trigger
 * name and the step it means cannot drift apart, and so adding a step trigger is
 * a table entry rather than another `case` in the matcher.
 */
const STEP_FOR_TRIGGER: Readonly<Record<string, Step>> = Object.freeze({
  upkeep: 'upkeep',
  drawStep: 'draw',
  precombatMain: 'precombatMain',
  endStep: 'end',
  // "At the beginning of combat on your turn" prints a different phrase from the
  // others, but it is the same shape and the same scoping, so it belongs in the
  // same table rather than in a case of its own.
  beginCombat: 'beginCombat',
});

/**
 * The permanent an event is ABOUT — who controls it and what it is — for the
 * board-watching triggers ("whenever a creature you control enters/dies").
 *
 * Passed in rather than looked up here because `triggers.ts` is a pure matcher
 * with no access to the game state; the runtime that emits the event resolves
 * the instance once per event and hands it down.
 */
export interface TriggerSubject {
  readonly controller: PlayerId;
  readonly card: CardInstance;
}

/**
 * Whether the permanent an event is about satisfies a board-watching condition:
 * the right controller relation AND the printed filter.
 *
 * With NO subject the answer is false, never true. The subject is missing only
 * when the runtime could not resolve the instance (it has already left every
 * zone the lookup covers), and a trigger that fired on an unknown permanent
 * would be a card doing more than it says.
 */
function subjectMatches(
  condition: TriggerCondition,
  subject: TriggerSubject | undefined,
  sourceController: PlayerId,
): boolean {
  if (!subject) return false;
  if (!whoMatches(condition.who, subject.controller, sourceController)) return false;
  return matchesCardFilter(subject.card, condition.permanentFilter);
}

/** Resolve a `who` filter against the acting player and the source's controller. */
function whoMatches(who: TriggerWho | undefined, actingPlayer: PlayerId, sourceController: PlayerId): boolean {
  const scope = who ?? 'you';
  switch (scope) {
    case 'you':
      return actingPlayer === sourceController;
    case 'opponent':
      return actingPlayer !== sourceController;
    case 'any':
      return true;
    default:
      return false;
  }
}

/**
 * The answer for an event that set nothing off. Shared and frozen: this runs for
 * EVERY event the engine emits (a few per action, hundreds of thousands per sim),
 * and the overwhelming majority of them match nothing at all — so the result list
 * is allocated only when there is something to put in it.
 */
const NO_PENDING_TRIGGERS: readonly PendingTrigger[] = Object.freeze([]);

/**
 * Scan a set of trigger sources against one event and return every ability that
 * fired, as `PendingTrigger`s in source-declaration order. The engine then applies
 * APNAP ordering across sources (see orderPendingTriggers).
 *
 * The result is read-only: callers consume it, and the no-match case hands back a
 * shared empty list rather than a fresh one.
 */
export function matchTriggers(
  sources: readonly TriggerSource[],
  event: GameEvent,
  resolveSubject?: (instanceId: InstanceId) => TriggerSubject | undefined,
): readonly PendingTrigger[] {
  // Resolved at most ONCE per event, and only when something might read it:
  // this runs for every event the engine emits, and the lookup walks zones.
  let subject: TriggerSubject | undefined;
  let subjectResolved = false;
  const subjectOf = (): TriggerSubject | undefined => {
    if (!subjectResolved) {
      subjectResolved = true;
      subject =
        resolveSubject && event.type === 'zoneChange' ? resolveSubject(event.instanceId) : undefined;
    }
    return subject;
  };
  let pending: PendingTrigger[] | null = null;
  for (let s = 0; s < sources.length; s++) {
    const src = sources[s] as TriggerSource;
    // An indexed loop rather than `forEach`: the callback closes over `src` and
    // `event`, so it was an allocation per source per event on the hot path.
    const abilities = src.triggers;
    for (let abilityIndex = 0; abilityIndex < abilities.length; abilityIndex++) {
      const ability = abilities[abilityIndex] as TriggeredAbility;
      const watchesBoard =
        ability.condition.on === 'permanentEnters' || ability.condition.on === 'permanentDies';
      if (
        !conditionMatches(
          ability.condition,
          event,
          src.instanceId,
          src.controller,
          watchesBoard ? subjectOf() : undefined,
          src.chosenAsEntered,
        )
      ) {
        continue;
      }
      (pending ??= []).push({
        sourceInstanceId: src.instanceId,
        controller: src.controller,
        ability,
        abilityIndex,
      });
    }
  }
  return pending ?? NO_PENDING_TRIGGERS;
}

/**
 * Order simultaneous triggers by APNAP (Active Player, Non-Active Player): the
 * active player's triggers go on the stack first (and thus resolve last). Within a
 * single player, triggers keep a stable order (battlefield order, then ability
 * index) so sims are reproducible. This returns the order in which to PUSH onto the
 * stack — APNAP push order means NAP's triggers resolve before AP's.
 */
export function orderPendingTriggers(
  pending: readonly PendingTrigger[],
  activePlayer: PlayerId,
  battlefieldOrder: ReadonlyMap<InstanceId, number>,
): PendingTrigger[] {
  const keyed = pending.map((p, originalIndex) => ({ p, originalIndex }));
  keyed.sort((a, b) => {
    // Active player first (pushed first → resolves last, per APNAP).
    const aActive = a.p.controller === activePlayer ? 0 : 1;
    const bActive = b.p.controller === activePlayer ? 0 : 1;
    if (aActive !== bActive) return aActive - bActive;
    // Same controller: stable by battlefield position, then ability index.
    const aPos = battlefieldOrder.get(a.p.sourceInstanceId) ?? 0;
    const bPos = battlefieldOrder.get(b.p.sourceInstanceId) ?? 0;
    if (aPos !== bPos) return aPos - bPos;
    if (a.p.abilityIndex !== b.p.abilityIndex) return a.p.abilityIndex - b.p.abilityIndex;
    return a.originalIndex - b.originalIndex;
  });
  return keyed.map((k) => k.p);
}
