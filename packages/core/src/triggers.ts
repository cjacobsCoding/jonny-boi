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

import type { BooleanKeywordName, CardType, EffectRef } from './card.js';
import type { GameEvent } from './events.js';
import type { CardFilter } from './choices.js';
import { matchesCardFilter } from './choices.js';
import { isCreature, permanentHasSubtype } from './card.js';
import type { CardInstance, InstanceId, PlayerId, Step } from './state.js';
import type { TargetRestriction } from './targeting.js';
import type { InterveningIf } from './intervening.js';

/**
 * The game occurrences a trigger can watch. Kept small and explicit (the §3.9
 * minimum set) — each maps to one or more `GameEvent`s the engine already emits.
 *   - `etb`            : the WATCHED permanent enters the battlefield.
 *   - `attacks`        : the WATCHED creature is declared as an attacker.
 *   - `dies`           : the WATCHED creature dies (battlefield → graveyard).
 *   - `leaves`         : the WATCHED permanent leaves the battlefield (any zone).
 *   - `castSpell`      : a spell is cast — optionally filtered by card type and by
 *                        whether the source's controller cast it.
 *   - `upkeep`         : the beginning of a player's upkeep (by default, the source
 *                        controller's upkeep).
 *   - `drawStep`       : the beginning of a player's draw step.
 *   - `precombatMain`  : the beginning of a player's first main phase.
 *   - `endStep`        : the beginning of a player's end step.
 *   - `beginCombat`    : the beginning of combat on a player's turn.
 *   - `gainLife`       : a player gained life ("whenever you gain life").
 *   - `combatDamageToPlayer` : the WATCHED permanent dealt COMBAT damage to a
 *                        player.
 *   - `permanentEnters`: ANOTHER permanent entered the battlefield — "whenever a
 *                        creature you control enters", landfall, constellation.
 *   - `drawsCard`      : a player DREW a card ("whenever a player draws a card",
 *                        "whenever an opponent draws a card"). Scoped by `who`
 *                        like every other relational trigger. It watches the
 *                        `drawCard` event, so it counts every draw — the draw
 *                        step's, a spell's, and another trigger's — which is
 *                        what the printed line says.
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
 *
 * The first five are the SELF-REFERENTIAL events, and "the WATCHED permanent"
 * above is the source itself unless the condition says otherwise — an
 * attachment's "whenever **equipped creature** deals combat damage to a player"
 * is the same event watched on its host. See {@link TriggerWatches}.
 */
export type TriggerEvent =
  | 'etb'
  | 'attacks'
  /**
   * "Whenever this creature BLOCKS OR BECOMES BLOCKED" — the combat-declaration
   * trigger that bushido, flanking and rampage are each printed as (CR 702.45a,
   * 702.24a, 702.23a). ONE event covers both halves because no printed card
   * separates them: an object either took part in a block or it did not.
   *
   * It fires ONCE per declaration however many creatures blocked, which falls
   * out of the matcher answering a boolean per (source, ability) rather than a
   * count — CR 509.1h makes "becomes blocked" a single event, not one per
   * blocker. A card that wants the count reads `event.blocks` itself.
   */
  | 'blocksOrBecomesBlocked'
  /*
   * THE COMBAT KEYWORD FAMILY'S EVENTS (DESIGN §3.107). Each is a distinct
   * printed shape with its own firing count, which is why they are rows rather
   * than a widening of `blocksOrBecomesBlocked`:
   */
  /**
   * "Whenever A CREATURE YOU CONTROL attacks alone" — exalted (CR 702.90a).
   * NOT self-referential: the source is any permanent (Cathedral of War is a
   * land), and the object the event is about is the lone attacker, which
   * rides to the body as `triggeringInstances` so "that creature gets +1/+1"
   * pumps the attacker rather than the source. "Alone" is CR 506.5: exactly
   * one creature was declared. Scoped by `who` (default `'you'`) against the
   * attacker's controller, resolved by the runtime as the event's subject.
   */
  | 'creatureAttacksAlone'
  /**
   * "Whenever ~ BLOCKS" — the blocker's half alone (Shu Defender, Netcaster
   * Spider's "blocks a creature with flying"). Fires once per declaration; the
   * creature it blocked is its `triggeringInstances`, which is what a
   * `counterpartHasKeyword` filter reads.
   */
  | 'blocks'
  /**
   * "Whenever ~ BECOMES BLOCKED" — the attacker's half alone (rampage, CR
   * 702.23a; Deeproot Warrior). ONE fire per declaration however many blockers
   * (CR 509.1h), exactly as `blocksOrBecomesBlocked`; every blocker is in its
   * `triggeringInstances`.
   */
  | 'becomesBlocked'
  /**
   * "Whenever A CREATURE [without flanking] BLOCKS THIS CREATURE" — flanking
   * (CR 702.25a). The one combat trigger that fires ONCE PER BLOCKER (CR
   * 702.25b: each blocking creature sets it off separately), so the matcher
   * emits one pending ability per qualifying blocker, each carrying that
   * blocker alone as its `triggeringInstances` — "the blocking creature gets
   * −1/−1" then shrinks exactly that one. The "[without flanking]" is the
   * `counterpartLacksKeyword` filter, applied by the runtime.
   */
  | 'becomesBlockedByCreature'
  | 'dies'
  | 'leaves'
  /**
   * §3.111 — "When ~ is put into a graveyard from the battlefield" (Rancor,
   * the Aura that comes back). NOT `dies`, which is `creatureDied` and never
   * fires for an Aura or an artifact; NOT `leaves`, which also fires on an
   * exile or a bounce and would return a Rancor that had been exiled. Exactly
   * the battlefield → graveyard move, for any permanent.
   */
  | 'putIntoGraveyardFromBattlefield'
  | 'castSpell'
  | 'upkeep'
  | 'drawStep'
  | 'precombatMain'
  | 'endStep'
  | 'beginCombat'
  | 'gainLife'
  /**
   * A player LOST life — "whenever an opponent loses life" (Exquisite Blood,
   * Bloodthirsty Conqueror). Its own event rather than a signed `gainLife`,
   * for the same reason `gainLife` is not `lifeChanged`: a card that fired on
   * both directions is a different card.
   */
  | 'lifeLoss'
  | 'combatDamageToPlayer'
  /**
   * "Whenever ONE OR MORE creatures you control deal combat damage to a
   * player" (Professional Face-Breaker, Spiteful Banditry). A GROUP event: the
   * printed ability fires ONCE per damage batch however many creatures
   * connected, which the runtime enforces by deduplicating the pending queue
   * per (source, ability) — see `matchTriggers`' caller. The matcher here
   * answers only "did THIS damage event qualify": combat, to a player, dealt
   * by a creature whose controller satisfies `who` (default `'you'`).
   */
  | 'groupCombatDamageToPlayer'
  /**
   * "Whenever A CREATURE YOU CONTROL deals combat damage to a player" (Bident
   * of Thassa, Reconnaissance Mission). The PER-CREATURE sibling of the group
   * kind above: three connecting creatures fire it three times, which is why
   * it shares the matcher but never the runtime's per-batch dedup.
   */
  | 'creatureCombatDamageToPlayer'
  | 'permanentEnters'
  | 'permanentDies'
  | 'drawsCard';

/**
 * Whose action a relational trigger (cast / a step / life gain) cares about.
 * Read against the SOURCE's controller, never against the active player.
 */
export type TriggerWho = 'you' | 'opponent' | 'any';

/**
 * WHICH OBJECT a self-referential trigger (`etb`/`attacks`/`dies`/`leaves`/
 * `combatDamageToPlayer`) is watching.
 *
 *   - `self`         — the permanent the ability is printed on. Every trigger
 *                      means this unless it says otherwise, so it is the default
 *                      and absent from every condition that does not say
 *                      otherwise.
 *   - `attachedHost` — the permanent this one is ATTACHED TO: an Equipment's
 *                      "Whenever **equipped creature** deals combat damage to a
 *                      player, …" and "Whenever **equipped creature** attacks, …".
 *
 * A SCOPE on the existing events rather than a parallel family of
 * `equippedDealsCombatDamage` events, because the game occurrence is identical —
 * a creature dealt combat damage to a player — and only the object being watched
 * differs. Two event names for one occurrence is how a matcher ends up with two
 * answers to the same question.
 *
 * ⚠️ The SOURCE of the ability is still the attachment. A Sword's trigger is
 * controlled by the Sword's controller, is ordered by the Sword's battlefield
 * position, and its "~ deals 2 damage" means the Sword. Only the *watched*
 * object moves — which is exactly why this is a field on the condition and not
 * a different `sourceInstanceId`.
 */
export type TriggerWatches = 'self' | 'attachedHost';

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
  /**
   * For the SELF-REFERENTIAL events: which object this trigger is watching.
   * Defaults to {@link DEFAULT_TRIGGER_WATCHES} (`'self'`), which is what every
   * printed trigger means unless it names the equipped/enchanted creature.
   *
   * `'attachedHost'` on a source attached to NOTHING matches nothing at all —
   * it never falls back to the source itself. A Sword lying loose on the
   * battlefield has an ability that can never trigger, and a fallback would be
   * the Sword swinging on its own: a card doing something it does not say.
   */
  readonly watches?: TriggerWatches;
  /**
   * The printed **intervening "if"** clause — "at the beginning of your upkeep,
   * **if you control three or more artifacts**, you gain 1 life".
   *
   * It is part of the CONDITION, not of the body, because CR 603.4 checks it
   * TWICE: once when the trigger would fire (a false condition means the ability
   * never goes on the stack at all) and again as it resolves (a condition that
   * has since become false removes the ability from the stack, doing nothing).
   * Compiling it as an `if` inside the effects would implement only the second
   * check — the ability would still go on the stack, still be counted by
   * anything watching the stack, and still be responded to.
   *
   * Evaluated by `interveningIfHolds` (intervening.ts), which needs the game
   * state; `triggers.ts` stays a pure matcher, so the runtime applies it after
   * this file has said the event matched.
   */
  readonly intervening?: InterveningIf;
  /**
   * For the pair-shaped combat events (`blocks`, `becomesBlocked`,
   * `becomesBlockedByCreature` — DESIGN §3.107): the OTHER creature in the
   * pair must HAVE this keyword — "whenever ~ blocks a creature WITH FLYING".
   *
   * Part of the CONDITION, not the body, for the same reason an intervening
   * "if" is: a trigger that reached the stack and then did nothing would still
   * be counted, responded to, and logged. Applied by the RUNTIME
   * (`triggers-runtime.ts`), which has the state, against the counterpart's
   * EFFECTIVE keywords — a flying granted by an anthem is flying; this file
   * stays a pure matcher. Named by {@link BooleanKeywordName}, so a keyword
   * that does not exist cannot be written here.
   */
  readonly counterpartHasKeyword?: BooleanKeywordName;
  /**
   * The negative form: the other creature must LACK this keyword — flanking's
   * "whenever a creature WITHOUT flanking blocks this creature". Same runtime,
   * same reasoning as {@link counterpartHasKeyword}.
   */
  readonly counterpartLacksKeyword?: BooleanKeywordName;
}

/** What a condition watches when it does not say: the permanent it is printed on. */
export const DEFAULT_TRIGGER_WATCHES: TriggerWatches = 'self';

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
  /**
   * "ANOTHER target creature" — the ability's own source is not a legal target.
   *
   * Orthogonal to {@link targets} on purpose. "Another" modifies any restriction
   * ("another target creature", "another target artifact you control"), so it is
   * a flag rather than a fourth `nonSomethingSomething` member of the
   * restriction union — that union is a flat string read at dozens of sites, and
   * one member per printed adjective does not scale.
   *
   * It is load-bearing wherever it is printed. Fiend Hunter exiles a creature
   * until it leaves the battlefield; let it name ITSELF and it exiles itself,
   * which makes it leave, which returns it, which re-triggers it — the same
   * unbounded loop shape as DESIGN §3.33's copy mirror.
   */
  readonly targetsExcludeSelf?: boolean;
  /**
   * How MANY targets, when the printed line is not "target X" but "up to three
   * other target X" (Angel of Serenity).
   *
   * Absent ⇒ exactly one, which is every trigger written before this existed —
   * so no card changes behaviour by this field appearing. `min: 0` is what makes
   * "UP TO three" different from "three": the ability stays on the stack and
   * resolves doing nothing rather than being removed for want of a target, which
   * is CR 603.3d's own distinction.
   *
   * Targets are still chosen as the ability goes on the stack, not on
   * resolution — the engine simply asks for a range instead of exactly one.
   */
  readonly targetCount?: { readonly min: number; readonly max: number };
  /**
   * "Choose one —" printed as a TRIGGER body (Felidar Retreat, Rankle). Modes
   * are chosen as the ability goes on the stack (CR 603.3c), the same moment
   * targets are; the runtime carries the spec onto the stack object as
   * `awaitingModes` and the engine asks before priority resumes. When set,
   * `effects` is empty and the chosen modes' effects replace it.
   */
  readonly modal?: import('./card.js').ModalSpec;
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
  /**
   * The player the EVENT was about — whose step began, who gained the life, who
   * drew the card, who controlled the permanent that entered or died. This is
   * the referent of the printed words "**that player**" / "**them**".
   *
   * It exists because the triggering player does NOT otherwise survive into the
   * resolution: a `who: 'any'` trigger fires under the SOURCE's controller, so a
   * body that read `ctx.controller` would make Howling Mine draw its own
   * controller a card on every player's draw step — a different card. The value
   * rides the stack object and then the resolution frame into `EffectContext`,
   * exactly the way `xValue` and `kicked` ride a cast-time choice down to
   * "deals X damage".
   *
   * Absent for a trigger whose event is about no particular player (a self ETB,
   * an attack, this permanent's own death), where a body has nothing to point at.
   */
  readonly triggeringPlayer?: PlayerId;
  /**
   * HOW MUCH the triggering event was for — the printed "**that much**" in
   * "whenever you gain life, target opponent loses that much life" (Vito) and
   * "whenever an opponent loses life, you gain that much life" (Exquisite
   * Blood).
   *
   * Carried like {@link triggeringPlayer} and for the same reason: the body is
   * read while the ability RESOLVES, long after the event that set it off, so
   * the number has to travel with the ability. Absent for every trigger whose
   * event has no amount, which is almost all of them.
   */
  readonly triggeringAmount?: number;
  /**
   * WHICH OBJECTS the event was about, relative to this source — the referent
   * of a body's "**that creature**" / "**the blocking creature**" (DESIGN
   * §3.107): the lone attacker for `creatureAttacksAlone`, the creature this one
   * blocked for `blocks`, the blockers for `becomesBlocked`, and exactly ONE
   * blocker for each `becomesBlockedByCreature` firing.
   *
   * Carried like {@link triggeringPlayer} and for the same reason: the body is
   * read as the ability RESOLVES, after the declaration event is gone. A
   * primitive reads it through `params.subject: 'triggering'`. Absent for every
   * trigger whose event names no such object — which is every trigger written
   * before this field existed, so none of them changes.
   */
  readonly triggeringInstances?: readonly InstanceId[];
}

/** The card-name + source needed to describe a pending trigger for events. */
export interface TriggerSource {
  readonly instanceId: InstanceId;
  readonly controller: PlayerId;
  readonly name: string;
  readonly triggers: readonly TriggeredAbility[];
  /**
   * The LIVE permanent this source is, read only to answer "what is it attached
   * to right now" for a `watches: 'attachedHost'` condition.
   *
   * A live reference and NOT a copied `attachedTo` id, and that is the whole
   * point of the field. The runtime caches a `TriggerSource` per permanent and
   * refreshes it only when the controller or the ability list changes, so a
   * copied id would go stale exactly where it matters most: an Equipment whose
   * host died to first-strike damage is unattached by the time regular damage
   * is dealt, and an Equipment that has LEFT the battlefield had its
   * `attachedTo` cleared by `resetInstanceForNewZone`. Both read correctly
   * through the reference and wrongly through a copy.
   *
   * Typed as the one field rather than as a whole `CardInstance` so nothing
   * else can start reading (possibly stale) state through this door.
   */
  readonly permanent?: { readonly attachedTo?: InstanceId | null };
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
 *
 * `attachedTo` is the object the source is attached to RIGHT NOW, needed only by
 * a `watches: 'attachedHost'` condition. Passed in (rather than read off a
 * cached copy) so the answer is the current attachment at the instant the event
 * is matched — see {@link TriggerSource.permanent}.
 */
export function conditionMatches(
  condition: TriggerCondition,
  event: GameEvent,
  sourceInstanceId: InstanceId,
  sourceController: PlayerId,
  subject?: TriggerSubject,
  sourceChosenAsEntered?: string,
  attachedTo?: InstanceId | null,
): boolean {
  switch (condition.on) {
    case 'etb': {
      // A permanent's own ETB: a zoneChange into the battlefield for this instance.
      const watched = watchedInstanceId(condition, sourceInstanceId, attachedTo);
      return (
        watched !== null &&
        event.type === 'zoneChange' &&
        event.to === 'battlefield' &&
        event.instanceId === watched
      );
    }
    case 'attacks': {
      const watched = watchedInstanceId(condition, sourceInstanceId, attachedTo);
      return watched !== null && event.type === 'attackersDeclared' && event.attackers.includes(watched);
    }
    case 'blocksOrBecomesBlocked': {
      const watched = watchedInstanceId(condition, sourceInstanceId, attachedTo);
      if (watched === null || event.type !== 'blockersDeclared') return false;
      // EITHER side of the pair: the creature that blocked, or the one that
      // became blocked. A boolean and not a count, deliberately — see the
      // event's doc comment for why one declaration is one fire.
      return event.blocks.some((b) => b.blocker === watched || b.attacker === watched);
    }
    // --- the combat keyword family (DESIGN §3.107) ------------------------------
    case 'creatureAttacksAlone': {
      // CR 506.5: "alone" is exactly one declared attacker. Whose creature it is
      // comes from the SUBJECT the runtime resolved (the attacker), judged by
      // `who` against the source's controller — the same relational shape as
      // every board-watching trigger, and a missing subject matches nothing.
      if (event.type !== 'attackersDeclared' || event.attackers.length !== 1) return false;
      if (subject === undefined) return false;
      return whoMatches(condition.who, subject.controller, sourceController);
    }
    case 'blocks': {
      const watched = watchedInstanceId(condition, sourceInstanceId, attachedTo);
      if (watched === null || event.type !== 'blockersDeclared') return false;
      return event.blocks.some((b) => b.blocker === watched);
    }
    case 'becomesBlocked':
    case 'becomesBlockedByCreature': {
      // Both answer "did the watched creature become blocked?" here; how MANY
      // times the per-creature kind fires is decided by `matchTriggers`, which
      // fans one pending ability out per blocker for it.
      const watched = watchedInstanceId(condition, sourceInstanceId, attachedTo);
      if (watched === null || event.type !== 'blockersDeclared') return false;
      return event.blocks.some((b) => b.attacker === watched);
    }
    case 'dies': {
      const watched = watchedInstanceId(condition, sourceInstanceId, attachedTo);
      return watched !== null && event.type === 'creatureDied' && event.instanceId === watched;
    }
    case 'leaves': {
      // Leaving the battlefield: a zoneChange out of the battlefield for this instance.
      const watched = watchedInstanceId(condition, sourceInstanceId, attachedTo);
      return (
        watched !== null &&
        event.type === 'zoneChange' &&
        event.from === 'battlefield' &&
        event.instanceId === watched
      );
    }
    case 'putIntoGraveyardFromBattlefield': {
      // §3.111 — the one move, for any permanent type (see the event's doc).
      const watched = watchedInstanceId(condition, sourceInstanceId, attachedTo);
      return (
        watched !== null &&
        event.type === 'zoneChange' &&
        event.from === 'battlefield' &&
        event.to === 'graveyard' &&
        event.instanceId === watched
      );
    }
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
        const wanted = sourceChosenAsEntered;
        // The SPELL itself is the subject here — resolved from the stack by the
        // runtime, exactly as a board-watching trigger's permanent is resolved
        // from the battlefield. Read off the object rather than off the event
        // because the event is the LOG, and widening a logged event's payload
        // for one trigger's benefit would change every replay's bytes for a
        // fact the object already carries.
        if (!subject || !permanentHasSubtype(subject.card, wanted)) return false;
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
    case 'lifeLoss': {
      // The engine emits no `loseLife` event — `lifeChanged` carries a SIGNED
      // delta — so a loss is that event with a negative delta. Keyed this way
      // on purpose: CR 118.3 counts damage as life loss, and damage emits
      // `lifeChanged` too, which is exactly what Exquisite Blood means.
      if (event.type !== 'lifeChanged' || event.delta >= 0) return false;
      return whoMatches(condition.who, event.player, sourceController);
    }
    case 'gainLife': {
      // "Whenever you gain life". Keyed on the `gainLife` event rather than on
      // `lifeChanged`, because the latter also fires for life LOST and for the
      // bookkeeping of a life-set effect — a lifegain trigger that fired on
      // damage would be a different card.
      if (event.type !== 'gainLife') return false;
      return whoMatches(condition.who, event.player, sourceController);
    }
    case 'drawsCard': {
      // "Whenever a player draws a card" / "whenever an opponent draws a card".
      // Keyed on `drawCard`, the one event every draw path emits, so the turn's
      // own draw counts exactly as a spell's does.
      if (event.type !== 'drawCard') return false;
      return whoMatches(condition.who, event.player, sourceController);
    }
    // The per-creature kind answers the same per-event question as the group
    // kind — the difference (once per batch vs once per creature) lives in the
    // runtime's dedup, which keys on the GROUP kind alone.
    case 'creatureCombatDamageToPlayer':
    case 'groupCombatDamageToPlayer': {
      // One qualifying damage event is enough to FIRE; firing once per batch
      // is the caller's dedup, not this matcher's concern. The damaging
      // creature is the event's SUBJECT (resolved by the runtime exactly as a
      // board-watching trigger's is); an unresolvable source fails the match —
      // a trigger firing on an unknown permanent would do more than printed.
      if (event.type !== 'damageDealt' || !event.combat || typeof event.target !== 'string') return false;
      if (subject === undefined) return false;
      if (!isCreature(subject.card.def)) return false;
      return whoMatches(condition.who ?? 'you', subject.controller, sourceController);
    }
    case 'combatDamageToPlayer': {
      // A player target is a PlayerId ('A'/'B'); an InstanceId is a number, so
      // the string test is what distinguishes "to a player" from "to a
      // creature or planeswalker" without a second event field.
      //
      // `watched` is the source itself for "Whenever ~ deals combat damage to a
      // player" and the EQUIPPED CREATURE for a Sword's copy of the same line.
      const watched = watchedInstanceId(condition, sourceInstanceId, attachedTo);
      return (
        watched !== null &&
        event.type === 'damageDealt' &&
        event.combat &&
        event.source === watched &&
        typeof event.target === 'string'
      );
    }
    default:
      // Unknown condition kind → never matches (safe no-op).
      return false;
  }
}

/**
 * Who the event was ABOUT — the referent of a body's "that player" / "them".
 *
 * Answered from the EVENT rather than from the source, which is the whole point:
 * a `who: 'any'` trigger resolves under the source's controller, so this is the
 * only place the other player survives. Returns `undefined` for the events that
 * are about a permanent or about nobody, where no printed body says "that
 * player".
 *
 * Called only for triggers that actually matched (a handful per turn), never on
 * the per-event scan.
 */
export function triggeringPlayerFor(
  condition: TriggerCondition,
  event: GameEvent,
  subject?: TriggerSubject,
): PlayerId | undefined {
  switch (condition.on) {
    case 'upkeep':
    case 'drawStep':
    case 'precombatMain':
    case 'endStep':
    case 'beginCombat':
      return event.type === 'stepBegin' ? event.activePlayer : undefined;
    case 'gainLife':
      return event.type === 'gainLife' ? event.player : undefined;
    case 'lifeLoss':
      return event.type === 'lifeChanged' && event.delta < 0 ? event.player : undefined;
    case 'drawsCard':
      return event.type === 'drawCard' ? event.player : undefined;
    case 'castSpell':
      return event.type === 'spellCast' ? event.player : undefined;
    case 'permanentEnters':
    case 'permanentDies':
      // The permanent's CONTROLLER — "whenever a creature an opponent controls
      // dies, that player loses 1 life".
      return subject?.controller;
    default:
      return undefined;
  }
}

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
 *
 * It also carries the SPELL for a cast trigger narrowed by a creature type
 * ("whenever you cast a creature spell of the chosen type") — same shape, same
 * seam, and the reason the `spellCast` EVENT did not have to grow a subtype
 * list that every replay would then carry.
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

/**
 * The instance a self-referential condition is actually about, or `null` when
 * there is no such object right now.
 *
 * One function so every self-referential case answers "which object?" the same
 * way. The `null` for an unattached `attachedHost` watcher is the load-bearing
 * half: a Sword nobody has equipped must match NOTHING, never fall back to
 * itself. (It also cannot silently match instance id 0 — which is why this
 * returns `null` rather than `undefined`-as-a-number.)
 */
function watchedInstanceId(
  condition: TriggerCondition,
  sourceInstanceId: InstanceId,
  attachedTo: InstanceId | null | undefined,
): InstanceId | null {
  if ((condition.watches ?? DEFAULT_TRIGGER_WATCHES) === 'self') return sourceInstanceId;
  return attachedTo ?? null;
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
 * Which `GameEvent` types each `TriggerEvent` can EVER match — read straight off
 * `conditionMatches`, where every case tests `event.type` against exactly one
 * type. The collector uses it as a prefilter: an event whose type no live
 * trigger watches cannot match anything, so the per-source scan is skipped
 * entirely (§3.53 — this scan was measured at ~5% of a whole gauntlet).
 *
 * ⚠️ CORRECTNESS CONTRACT: for every condition kind, this list must be a
 * SUPERSET of the event types its `conditionMatches` case can return true for.
 * Two guards hold it:
 *   - the `Record<TriggerEvent, …>` shape — adding a `TriggerEvent` without
 *     classifying it here stops the build (the manifest pattern:
 *     `KEYWORD_KEYS`, `RULES_MANIFEST`);
 *   - `trigger-event-prefilter.test.ts` fires every condition kind's canonical
 *     event through `conditionMatches` and asserts the matched type is listed,
 *     so a case rewritten onto a new event type goes red, not silent.
 */
export const TRIGGER_EVENT_SOURCES: Readonly<Record<TriggerEvent, readonly GameEvent['type'][]>> =
  Object.freeze({
    etb: ['zoneChange'],
    attacks: ['attackersDeclared'],
    blocksOrBecomesBlocked: ['blockersDeclared'],
    // The combat keyword family's events (DESIGN §3.107): one attack-side, three
    // block-side, all read straight off the two declaration events.
    creatureAttacksAlone: ['attackersDeclared'],
    blocks: ['blockersDeclared'],
    becomesBlocked: ['blockersDeclared'],
    becomesBlockedByCreature: ['blockersDeclared'],
    dies: ['creatureDied'],
    leaves: ['zoneChange'],
    putIntoGraveyardFromBattlefield: ['zoneChange'],
    castSpell: ['spellCast'],
    upkeep: ['stepBegin'],
    drawStep: ['stepBegin'],
    precombatMain: ['stepBegin'],
    endStep: ['stepBegin'],
    beginCombat: ['stepBegin'],
    gainLife: ['gainLife'],
    // A LOSS is `lifeChanged` with a negative delta — there is no `loseLife`
    // event — so this is the type the matcher must be woken for.
    lifeLoss: ['lifeChanged'],
    combatDamageToPlayer: ['damageDealt'],
  // The §-per-creature and group variants observe the same damage events as
  // their parent condition — classified here because the prefilter map is
  // compile-total on purpose.
  groupCombatDamageToPlayer: ['damageDealt'],
  creatureCombatDamageToPlayer: ['damageDealt'],
    permanentEnters: ['zoneChange'],
    permanentDies: ['zoneChange'],
    drawsCard: ['drawCard'],
  });

/**
 * One BIT per distinct watchable event type, assigned at module init from
 * `TRIGGER_EVENT_SOURCES` itself so the two can never drift. Eight types today
 * — comfortably inside a small integer — and the collector's per-event
 * prefilter becomes one AND instead of a Set lookup.
 */
const EVENT_TYPE_BITS: Partial<Record<GameEvent['type'], number>> = {};
{
  let nextBit = 0;
  for (const types of Object.values(TRIGGER_EVENT_SOURCES)) {
    for (const type of types) {
      if (EVENT_TYPE_BITS[type] === undefined) EVENT_TYPE_BITS[type] = 1 << nextBit++;
    }
  }
}

/** The prefilter bit for an event type — 0 for a type no trigger can ever watch. */
export function eventTypeWatchBit(type: GameEvent['type']): number {
  return EVENT_TYPE_BITS[type] ?? 0;
}

/**
 * The mask of event types ONE trigger list can match, memoised on the list —
 * ability lists live on immutable `CardDefinition`s, so each definition answers
 * once per process (the `RESTRICTION_MEMO` pattern).
 */
const TRIGGER_LIST_MASK_MEMO = new WeakMap<readonly TriggeredAbility[], number>();

function watchMaskOfTriggerList(triggers: readonly TriggeredAbility[]): number {
  const cached = TRIGGER_LIST_MASK_MEMO.get(triggers);
  if (cached !== undefined) return cached;
  let mask = 0;
  for (let t = 0; t < triggers.length; t++) {
    for (const type of TRIGGER_EVENT_SOURCES[(triggers[t] as TriggeredAbility).condition.on]) {
      mask |= EVENT_TYPE_BITS[type] as number;
    }
  }
  TRIGGER_LIST_MASK_MEMO.set(triggers, mask);
  return mask;
}

/**
 * The union mask over a whole source set — the collector's prefilter key,
 * rebuilt only when the source set changes (the same cadence as its snapshot
 * list), never per event. An event whose `eventTypeWatchBit` is not in the
 * mask cannot match any of these sources' triggers.
 */
export function watchedEventMaskOf(sources: readonly TriggerSource[]): number {
  let mask = 0;
  for (let s = 0; s < sources.length; s++) {
    mask |= watchMaskOfTriggerList((sources[s] as TriggerSource).triggers);
  }
  return mask;
}

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
      subject = resolveSubject
        ? event.type === 'zoneChange' || event.type === 'spellCast'
          ? resolveSubject(event.instanceId)
          : // A damage event's subject is the DAMAGING object (the group
            // combat-damage trigger reads its controller and creatureness).
            event.type === 'damageDealt' && typeof event.source === 'number'
            ? resolveSubject(event.source)
            : // A LONE attack's subject is the attacker — what exalted's "a
              // creature you control attacks alone" reads the controller of
              // (DESIGN §3.107). Two or more attackers have no subject: nothing
              // attacked alone.
              event.type === 'attackersDeclared' && event.attackers.length === 1
              ? resolveSubject(event.attackers[0] as InstanceId)
              : undefined
        : undefined;
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
        ability.condition.on === 'permanentEnters' ||
        ability.condition.on === 'permanentDies' ||
        // The group and per-creature combat-damage triggers read the DAMAGING
        // creature.
        ability.condition.on === 'groupCombatDamageToPlayer' ||
        ability.condition.on === 'creatureCombatDamageToPlayer' ||
        // Exalted reads the lone ATTACKER's controller (DESIGN §3.107).
        ability.condition.on === 'creatureAttacksAlone' ||
        // A cast trigger narrowed by the chosen creature type needs the SPELL
        // object, for the same reason and through the same seam.
        ability.condition.spellSubtypeIsChosen === true;
      // Read LIVE, per event, and only for the conditions that ask: an
      // Equipment's host can change (or vanish) between two events of the same
      // action, and the cached `TriggerSource` is deliberately not rebuilt for
      // that. Every other trigger pays one comparison and reads nothing.
      const attachedTo =
        ability.condition.watches === 'attachedHost' ? (src.permanent?.attachedTo ?? null) : undefined;
      if (
        !conditionMatches(
          ability.condition,
          event,
          src.instanceId,
          src.controller,
          watchesBoard ? subjectOf() : undefined,
          src.chosenAsEntered,
          attachedTo,
        )
      ) {
        continue;
      }
      // Resolved only for the triggers that FIRED, and only when the event
      // names a player at all — so the per-event scan above pays nothing.
      const triggeringAmount = triggeringAmountFor(event);
      const triggeringPlayer = triggeringPlayerFor(
        ability.condition,
        event,
        watchesBoard ? subjectOf() : undefined,
      );
      // The combat keyword family (DESIGN §3.107): which objects the event was
      // about, and — for the one per-creature kind — one pending ability PER
      // object, each carrying that object alone. Every other trigger kind
      // yields `undefined` here and is pushed byte-for-byte as it always was.
      const triggering = triggeringInstancesFor(ability.condition, event, src.instanceId, attachedTo);
      const fanOut = triggering !== undefined && FIRES_PER_TRIGGERING_INSTANCE.has(ability.condition.on);
      const firings = fanOut ? triggering.length : 1;
      for (let f = 0; f < firings; f++) {
        const instances = fanOut ? [triggering[f] as InstanceId] : triggering;
        (pending ??= []).push({
          sourceInstanceId: src.instanceId,
          controller: src.controller,
          ability,
          abilityIndex,
          ...(triggeringPlayer !== undefined ? { triggeringPlayer } : {}),
          ...(triggeringAmount !== undefined ? { triggeringAmount } : {}),
          ...(instances !== undefined ? { triggeringInstances: instances } : {}),
        });
      }
    }
  }
  return pending ?? NO_PENDING_TRIGGERS;
}

// --- the combat keyword family (DESIGN §3.107): what a declaration is ABOUT --------

/**
 * The trigger kinds that fire ONCE PER TRIGGERING OBJECT rather than once per
 * event. Flanking is the printed case (CR 702.25b: "each creature blocking it
 * that doesn't have flanking triggers flanking separately"). A closed set, read
 * by `matchTriggers` to fan a match out — so a kind added here is a row, and a
 * kind not here keeps the one-declaration-one-fire rule of CR 509.1h.
 */
const FIRES_PER_TRIGGERING_INSTANCE: ReadonlySet<TriggerEvent> = new Set<TriggerEvent>([
  'becomesBlockedByCreature',
]);

/**
 * The objects a combat-declaration event is about, relative to the watched
 * creature — the referent of "that creature" / "the blocking creature":
 *   - `creatureAttacksAlone`: the lone attacker;
 *   - `blocks`: the creature(s) the watched creature blocked;
 *   - `becomesBlocked` / `becomesBlockedByCreature`: the creatures blocking it.
 *
 * `undefined` for every other kind, which is what keeps those pushed exactly as
 * before. Pure and allocation-free on the no-match path: only called for a
 * trigger that already matched.
 */
export function triggeringInstancesFor(
  condition: TriggerCondition,
  event: GameEvent,
  sourceInstanceId: InstanceId,
  attachedTo?: InstanceId | null,
): readonly InstanceId[] | undefined {
  switch (condition.on) {
    case 'creatureAttacksAlone':
      return event.type === 'attackersDeclared' ? event.attackers : undefined;
    case 'blocks': {
      if (event.type !== 'blockersDeclared') return undefined;
      const watched = watchedInstanceId(condition, sourceInstanceId, attachedTo);
      const blocked: InstanceId[] = [];
      for (const pair of event.blocks) if (pair.blocker === watched) blocked.push(pair.attacker);
      return blocked;
    }
    case 'becomesBlocked':
    case 'becomesBlockedByCreature': {
      if (event.type !== 'blockersDeclared') return undefined;
      const watched = watchedInstanceId(condition, sourceInstanceId, attachedTo);
      const blockers: InstanceId[] = [];
      for (const pair of event.blocks) if (pair.attacker === watched) blockers.push(pair.blocker);
      return blockers;
    }
    default:
      return undefined;
  }
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

/**
 * The AMOUNT an event was for, when it has one — the life gained or lost.
 *
 * Read from the event rather than from the state, because "that much" means the
 * size of THIS event: a player who gained 3 and then lost 1 has a life total
 * that answers neither question.
 */
export function triggeringAmountFor(event: GameEvent): number | undefined {
  if (event.type === 'gainLife') return event.amount;
  // A LOSS is `lifeChanged` with a negative delta; "that much" is its
  // MAGNITUDE ("you gain that much life" gains 3, it does not gain −3).
  if (event.type === 'lifeChanged' && event.delta < 0) return -event.delta;
  return undefined;
}
