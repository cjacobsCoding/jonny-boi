/**
 * Runtime glue between the event log and the triggered-ability machinery
 * (triggers.ts). The engine does NOT hard-code any card: instead, as events are
 * emitted, this collector scans the permanents currently on the battlefield for
 * declared triggers whose condition matches the event, and queues them. When the
 * engine reaches a stable point (about to grant priority), it flushes the queue —
 * ordering simultaneous triggers by APNAP — onto the stack as `TriggeredStackObject`s.
 *
 * Why an emit-interceptor seam: every meaningful mutation already emits a typed
 * event. Wrapping `emit` lets triggers observe state changes without the core loop
 * special-casing draws, casts, combat, deaths, etc. — one mechanism, no per-feature
 * branches in the turn machine.
 *
 * Determinism: the queue preserves emission order; APNAP ordering at flush time is a
 * stable sort keyed by controller (active first), then battlefield position, then
 * ability index — so the same seed always produces the same trigger order.
 */

import type { GameEvent } from '../events.js';
import type { CardInstance, GameState, InstanceId } from '../state.js';
import { recordTurnFacts } from '../turn-facts.js';
import type { PendingTrigger, TriggerSource } from '../triggers.js';
import { eventTypeWatchBit, matchTriggers, orderPendingTriggers, watchedEventMaskOf } from '../triggers.js';
import { interveningIfHolds } from '../intervening.js';
import type { DelayedTriggeredAbility } from '../delayed.js';
import { matchDelayedTriggers, pendingFromDelayed, removeDelayedTrigger } from '../delayed.js';
// The combat keyword family's counterpart filter (DESIGN §3.107) reads
// EFFECTIVE keywords, which is why it lives here and not in the pure matcher.
import { aggregateFor } from './continuous.js';
import { effectiveKeywords } from './stats.js';

/**
 * Which event types can COINCIDE with a change to the trigger-SOURCE set — the
 * battlefield's membership, a permanent's active face (`def` identity), its
 * controller, its `chosenAsEntered`, or the command zones. `rememberSources`
 * used to re-walk the battlefield on EVERY emitted event to stay current;
 * profiled on a seed-99 gauntlet under the default pilot that walk alone was
 * ~4.6% of the whole run (§3.53). Every mutation that can change the set emits
 * one of the `true` rows *before* the next event anything could match, so
 * rescanning only on those keeps the set exactly as current as the per-event
 * walk did.
 *
 * ⚠️ THE CONTRACT: a `false` row asserts "emitting this event NEVER coincides
 * with a source-set change". The safe direction for any new or doubtful type is
 * `true` — a wasted rescan costs nanoseconds; a missed one silently drops a
 * trigger, this repo's most-feared defect shape. The `Record<GameEvent['type'],
 * boolean>` shape makes the classification TOTAL: adding an event type without
 * classifying it stops the build (the `KEYWORD_KEYS` / `RULES_MANIFEST`
 * default-deny pattern). The end-to-end pins hold it too: `selfplay-lock`
 * digests, the seed-99 gauntlet rows and the soak all replay full event logs
 * that would move if a trigger fired late or not at all.
 */
export const SOURCE_SET_EVENTS: Readonly<Record<GameEvent['type'], boolean>> = Object.freeze({
  // --- battlefield membership changes (or may accompany one) ------------------
  zoneChange: true,
  tokenCreated: true,
  tokenCopyCreated: true,
  tokenCeasedToExist: true,
  creatureDied: true,
  planeswalkerDied: true,
  battleDefeated: true,
  attachmentPutIntoGraveyard: true,
  legendRuleApplied: true,
  landPlayed: true,
  // --- identity/controller/naming changes on a stable board -------------------
  becameCopy: true,
  transformed: true,
  controlChanged: true,
  chosenAsEnters: true,
  // --- command-zone growth (emblems trigger from there, CR 114) ---------------
  emblemCreated: true,
  // --- everything below never moves/reshapes a source. The set may change on
  // the SAME ACTION (a resolution killing a creature), but that mutation emits
  // its own `true` row above before the next matchable event. ------------------
  abilityActivated: false,
  actionRejected: false,
  attachmentFailed: false,
  attackersDeclared: false,
  blockersDeclared: false,
  cardCycled: false,
  cardGrantAdded: false,
  cardGrantExpired: false,
  cardsLookedAt: false,
  cardsMilled: false,
  choiceAbandoned: false,
  choiceAnswered: false,
  choiceAsked: false,
  choiceAutoAnswered: false,
  continuousEffectAdded: false,
  continuousEffectExpired: false,
  counterAdded: false,
  counterPrevented: false,
  damageDealt: false,
  damagePrevented: false,
  defenseChanged: false,
  drawCard: false,
  effectApplied: false,
  effectUnsupported: false,
  gainLife: false,
  gameOver: false,
  gameStart: false,
  lifeChanged: false,
  loyaltyChanged: false,
  madnessDeclined: false,
  // poison family (§3.105): no printed trigger watches poison arriving yet.
  poisonChanged: false,
  madnessWindowOpened: false,
  // §3.106 — suspend moves a card hand → exile and back to the stack; the
  // battlefield source set changes only when it later RESOLVES (`zoneChange`).
  cardSuspended: false,
  suspendWindowOpened: false,
  suspendDeclined: false,
  // §3.113 — cascade / ripple: the library-to-exile-to-library shuffle of a
  // pile never touches the battlefield; the cast that follows is a `spellCast`.
  cascadeWindowOpened: false,
  rippleWindowOpened: false,
  pileBottomed: false,
  manaAdded: false,
  manaCostPaid: false,
  manaPoolEmptied: false,
  modeTargetChosen: false,
  modesChosen: false,
  permanentAttached: false,
  permanentUnattached: false,
  playerLost: false,
  priorityPassed: false,
  replacementApplied: false,
  replacementExpired: false,
  spellCast: false,
  spellCopied: false,
  spellCopyCeasedToExist: false,
  stackResolved: false,
  stepBegin: false,
  tapped: false,
  triggerCopied: false,
  triggerFizzled: false,
  triggerPutOnStack: false,
  triggerRemovedFromStack: false,
  triggerTargetsChosen: false,
  triggeredAbilityResolved: false,
  turnBegin: false,
  untapped: false,
  // Post-§3.53 additions, classified as the map demands (that is its job):
  // choosing a modal trigger's mode and delayed-ability lifecycle events say
  // nothing about which PERMANENTS carry triggers.
  triggerModesChosen: false,
  // Regeneration TAPS a permanent and clears its damage; it never moves one,
  // so the trigger-source set is untouched.
  regenerated: false,
  delayedTriggerCreated: false,
  delayedTriggerFired: false,
});

/**
 * Whether a matched combat trigger's COUNTERPART filter holds (DESIGN §3.107):
 * every object the event was about must have (`counterpartHasKeyword`) or lack
 * (`counterpartLacksKeyword`) the named keyword, read EFFECTIVE — a flying
 * granted by an anthem is flying, and a flanking lost to nothing is still
 * flanking. An object no longer on the battlefield fails the filter: a trigger
 * firing on an unknown creature would do more than printed.
 *
 * The per-creature kind (`becomesBlockedByCreature`) arrives here with exactly
 * one instance per pending ability, so this is genuinely a per-blocker test —
 * which is what CR 702.25b's "each creature … triggers separately" needs.
 */
function counterpartFilterHolds(state: GameState, pending: PendingTrigger): boolean {
  const instances = pending.triggeringInstances;
  if (instances === undefined || instances.length === 0) return false;
  const must = pending.ability.condition.counterpartHasKeyword;
  const mustNot = pending.ability.condition.counterpartLacksKeyword;
  for (let i = 0; i < instances.length; i++) {
    const id = instances[i] as InstanceId;
    let counterpart: CardInstance | undefined;
    for (let b = 0; b < state.battlefield.length; b++) {
      const permanent = state.battlefield[b] as CardInstance;
      if (permanent.instanceId === id) {
        counterpart = permanent;
        break;
      }
    }
    if (counterpart === undefined) return false;
    const keywords = effectiveKeywords(counterpart, aggregateFor(state, id));
    if (must !== undefined && keywords[must] !== true) return false;
    if (mustNot !== undefined && keywords[mustNot] === true) return false;
  }
  return true;
}

/**
 * A trigger collector bound to a draft state and a base emit. Call `emit` exactly
 * as before; matched triggers accumulate in an internal queue. Call `flush` to move
 * the queue onto the stack (APNAP-ordered) — it reports how many it moved, which is
 * all the engine needs to decide whether priority resets.
 *
 * One collector is built per action, so its own footprint is on the hot path: it
 * holds exactly two closures and allocates its queue, its known-source map and the
 * scan list only if something actually needs them.
 */
export interface TriggerCollector {
  /** Emit an event AND scan it for triggers (the wrapped emit the engine uses). */
  emit(event: GameEvent): void;
  /** Move queued triggers onto the stack in APNAP order. Returns count flushed. */
  flush(): number;
}

/**
 * Create a collector wrapping `baseEmit`. The collector emits each event to the log
 * first, then matches it against the battlefield's triggers and queues any that fire.
 *
 * Note on `dies`/`leaves`: those triggers reference a creature that has just left the
 * battlefield, so it is no longer in `state.battlefield` when the event is scanned.
 * We therefore also retain a snapshot of triggerful permanents seen this action, so a
 * leaves/dies trigger on the departing permanent itself still fires ("last known
 * information"). This matches MTG's leave-the-battlefield trigger handling.
 */
export function createTriggerCollector(state: GameState, baseEmit: (e: GameEvent) => void): TriggerCollector {
  // Allocated on the first trigger that actually fires — most actions set nothing
  // off, and this is built once per action for every action of every game.
  let queue: PendingTrigger[] | null = null;
  // Remember triggerful permanents that have been on the battlefield this action,
  // so leave/dies triggers on the departing permanent still resolve. Created lazily:
  // a board with no triggerful permanent — an opening hand, a land-only turn, and
  // most of the sim's hot path — never allocates the map or the snapshot at all.
  let seenSources: Map<InstanceId, TriggerSource> | null = null;
  // A reusable array view of `seenSources`, rebuilt only when the set changes.
  // `matchTriggers` wants a list, and spreading the map's values on EVERY emitted
  // event was one array plus one `TriggerSource` per triggerful permanent, several
  // times per action, for a scan that almost never matches anything.
  let snapshot: TriggerSource[] | null = null;
  // The mask of event types the snapshot's triggers can match at all — rebuilt
  // with the snapshot, consulted per event (one AND) so a mana tap never pays
  // for a trigger scan.
  let watchedMask = 0;
  /**
   * How many objects were in the two command zones the last time they were
   * walked. `-1` forces the first pass. See `rememberSources` for why a size
   * comparison is a sufficient staleness check for emblems specifically.
   */
  let lastCommandCount = -1;

  /** Fold one command zone's triggerful objects into the known-source set. */
  const rememberCommandZone = (command: readonly CardInstance[]): void => {
    for (let i = 0; i < command.length; i++) {
      const object = command[i] as CardInstance;
      const triggers = object.def.triggers;
      if (triggers === undefined || triggers.length === 0) continue;
      const known = seenSources?.get(object.instanceId);
      if (known !== undefined && known.controller === object.controller && known.triggers === triggers) continue;
      (seenSources ??= new Map()).set(object.instanceId, {
        instanceId: object.instanceId,
        controller: object.controller,
        name: object.def.name,
        triggers,
      });
      snapshot = null;
    }
  };

  /**
   * Fold the currently-on-battlefield triggerful permanents into the known set.
   *
   * Runs per event, so it must not allocate when nothing has changed — which is
   * the normal case. A permanent already known under the same controller is left
   * exactly as it is: its name and abilities come from the immutable definition,
   * so `controller` is the only field that can go stale. First-seen order (which
   * is what `matchTriggers` scans in) is preserved, because re-`set`ting an
   * existing key would not move it and we no longer re-set at all.
   */
  const rememberSources = (): void => {
    // EMBLEMS trigger from the COMMAND zone (CR 114) — "at the beginning of your
    // upkeep…" printed on an emblem fires exactly as it would on a permanent,
    // and keeps firing for the rest of the game because nothing can remove the
    // emblem. They fold into the SAME known-source set rather than being scanned
    // separately, so the APNAP ordering, the label, the stack push and the
    // resolution are all one path with no emblem special case.
    //
    // ⚠️ PERFORMANCE, and it is not a micro-detail: this function runs on EVERY
    // emitted event — hundreds of thousands per sim — so anything done here is
    // done on the engine's hottest path. Two things keep it free:
    //
    //  1. the command zones are read DIRECTLY rather than through
    //     `for (const pid of PLAYER_IDS)`, because that loop allocates an array
    //     iterator per event for a two-element list;
    //  2. the contents are only walked when the zone's SIZE has changed. An
    //     emblem can never leave (that is the whole point of the object) and its
    //     abilities come from an immutable definition, so an unchanged count
    //     means an unchanged set — unlike the battlefield below, where a
    //     permanent's controller can change or its face can swap under a stable
    //     count.
    const commandA = state.players.A.command;
    const commandB = state.players.B.command;
    const commandCount = commandA.length + commandB.length;
    if (commandCount !== lastCommandCount) {
      lastCommandCount = commandCount;
      rememberCommandZone(commandA);
      rememberCommandZone(commandB);
    }
    const battlefield = state.battlefield;
    for (let i = 0; i < battlefield.length; i++) {
      const inst = battlefield[i] as (typeof battlefield)[number];
      const triggers = inst.def.triggers;
      if (triggers === undefined || triggers.length === 0) {
        // A permanent that TRANSFORMED to a triggerless face mid-action must be
        // FORGOTTEN, not kept as last-known-information: it is still on the
        // battlefield, so its current face — not the one it used to show —
        // governs what can trigger. (Last-known-info is only for permanents
        // that have LEFT, which the map otherwise exists to serve.) The `?.`
        // keeps the triggerless-board fast path allocation-free.
        if (seenSources?.delete(inst.instanceId)) snapshot = null;
        continue;
      }
      const known = seenSources?.get(inst.instanceId);
      // `known.triggers === triggers` is the transform check: abilities come
      // from the immutable DEFINITION, but `inst.def` is the ACTIVE face and a
      // transform swaps it — so identity of the trigger list, not presence of
      // the entry, is what proves the cached source is still current.
      //
      // `chosenAsEntered` joins the staleness check because it is WRITTEN AFTER
      // the permanent is already on the battlefield (the naming is answered a
      // moment later, by the choice the entry raised) — so a cached source
      // captured at the instant of arrival would carry no named value, and the
      // trigger narrowed by it would silently never fire. One string comparison,
      // and only for permanents that have triggers at all.
      //
      // NOTE what is deliberately NOT in this check: the permanent's ATTACHMENT.
      // An Equipment moving from one creature to another does not invalidate the
      // entry, because the entry carries the live instance (`permanent`) rather
      // than a copy of `attachedTo` — `matchTriggers` reads the current value at
      // match time. Adding `attachedTo` here would rebuild the source on every
      // equip for no benefit, and would still be a COPY at the moment of the
      // rebuild.
      if (
        known !== undefined &&
        known.controller === inst.controller &&
        known.triggers === triggers &&
        known.chosenAsEntered === inst.chosenAsEntered
      ) {
        continue;
      }
      (seenSources ??= new Map()).set(inst.instanceId, {
        instanceId: inst.instanceId,
        controller: inst.controller,
        name: inst.def.name,
        triggers,
        // The live permanent, read only by a `watches: 'attachedHost'` condition
        // ("Whenever equipped creature deals combat damage to a player"). A
        // reference costs nothing to store and is the ONLY way the answer stays
        // current for an Equipment whose host dies to first-strike damage
        // between the two combat-damage steps of one action.
        permanent: inst,
        ...(inst.chosenAsEntered !== undefined ? { chosenAsEntered: inst.chosenAsEntered } : {}),
      });
      snapshot = null;
    }
  };
  rememberSources();

  /**
   * Find the permanent a zone change is ABOUT — what the board-watching triggers
   * ("whenever a creature you control enters/dies") read.
   *
   * Searched battlefield-first and then every player's graveyard, because the
   * two events those triggers watch leave the card in exactly those places by
   * the time the event is emitted: an entry has already landed on the
   * battlefield, and a death has already landed in a graveyard. A card found in
   * neither yields `undefined`, and `subjectMatches` treats that as no match —
   * a trigger never fires on a permanent nobody can identify.
   */
  const resolveSubject = (instanceId: InstanceId) => {
    for (const perm of state.battlefield) {
      if (perm.instanceId === instanceId) return { controller: perm.controller, card: perm };
    }
    // A SPELL BEING CAST is on the stack, not in a zone — this is what a cast
    // trigger narrowed by a creature type reads ("whenever you cast a creature
    // spell of the chosen type"). Searched after the battlefield because that is
    // where the overwhelming majority of lookups find their answer, and searched
    // at all only because the alternative was widening the `spellCast` EVENT
    // with a subtype list every replay would then carry.
    for (const object of state.stack) {
      if (object.kind === 'spell' && object.card.instanceId === instanceId) {
        return { controller: object.controller, card: object.card };
      }
    }
    for (const player of Object.values(state.players)) {
      for (const card of player.graveyard) {
        if (card.instanceId === instanceId) return { controller: card.controller, card };
      }
    }
    return undefined;
  };

  /**
   * The DELAYED half (CR 603.7): abilities that live on `state.delayedTriggers`
   * rather than on any object, because the effect that created them is long gone
   * — see `delayed.ts`.
   *
   * Scanned SEPARATELY from the battlefield sources, and deliberately not folded
   * into `seenSources`: that map is keyed by instance id and holds one entry per
   * permanent, so two delayed abilities created by the same Kiki-Jiki would
   * collide, and a delayed record is not last-known-information about anything.
   * The matching itself is `triggers.ts`'s (`conditionMatches`,
   * `triggeringPlayerFor`) — one vocabulary, one matcher.
   *
   * A matched record is REMOVED HERE, before its ability reaches the stack:
   * CR 603.7a's "it triggers only once" is then structural rather than a flag,
   * and an ability countered on the stack cannot come back for another try.
   *
   * Costs one property read per event in every game that never makes one.
   */
  const collectDelayed = (event: GameEvent): void => {
    const records = state.delayedTriggers;
    if (records === undefined || records.length === 0) return;
    // Resolved at most once per event, and only for the two event kinds a
    // board-watching condition reads — the same rule (and the same resolver) the
    // ordinary scan uses. A step trigger, which is every delayed ability this
    // engine's compiler builds, never asks for it at all.
    const subject =
      event.type === 'zoneChange' || event.type === 'spellCast' ? resolveSubject(event.instanceId) : undefined;
    const matched = matchDelayedTriggers(records, event, subject);
    for (let i = 0; i < matched.length; i++) {
      const record = matched[i] as DelayedTriggeredAbility;
      removeDelayedTrigger(state, record.id);
      baseEmit({
        type: 'delayedTriggerFired',
        id: record.id,
        sourceInstanceId: record.sourceInstanceId,
        controller: record.controller,
        label: record.ability.label ?? '',
      });
      (queue ??= []).push(pendingFromDelayed(record, event, subject));
    }
  };

  const emit = (event: GameEvent): void => {
    baseEmit(event);
    // Fold the event into the turn's fact memory (revolt / morbid / lifegain).
    // Done HERE, before any early-out below, because this wrapper is the one
    // chokepoint every emitted event passes through — the same argument that
    // put trigger matching here rather than in the turn machine.
    recordTurnFacts(state, event);
    // Refresh the known-source set so a permanent that entered earlier in this
    // same action can trigger on a later event — but only on an event that can
    // coincide with the set actually changing. `SOURCE_SET_EVENTS` (above) is
    // the total, compile-checked classification; running the walk on every
    // event was ~4.6% of a profiled gauntlet, almost all of it re-proving that
    // a mana tap changed nothing.
    if (SOURCE_SET_EVENTS[event.type]) rememberSources();
    // The delayed scan runs BEFORE the battlefield early-out below, and that
    // ordering is load-bearing: a delayed ability belongs to no permanent, so a
    // board with no triggerful permanent at all (Kiki-Jiki destroyed in response
    // to its own activation) must still sacrifice the token at end of turn.
    // (The classified refresh above and this scan are independent: the prefilter
    // gates only the SOURCE-SET walk, never delayed collection.)
    collectDelayed(event);
    // Perf early-exit: with no triggerful permanent ever seen this action, no event
    // can match — skip the scan entirely. Behavior is unchanged: matchTriggers over
    // an empty source list always returns nothing.
    if (seenSources === null) return;
    if (snapshot === null) {
      snapshot = [...seenSources.values()];
      watchedMask = watchedEventMaskOf(snapshot);
    }
    // Second early-exit: an event no live trigger's condition can EVER match —
    // `TRIGGER_EVENT_SOURCES` is the per-condition contract — skips the
    // per-source scan the same way an empty source set does.
    if ((watchedMask & eventTypeWatchBit(event.type)) === 0) return;
    const matched = matchTriggers(snapshot, event, resolveSubject);
    if (matched.length === 0) return;
    for (const m of matched) {
      // CR 603.4's FIRST check: an ability whose intervening "if" is false does
      // not trigger at all — it never reaches the stack, so nobody may respond
      // to it. Done here rather than inside `matchTriggers` because the answer
      // needs the game state and `triggers.ts` is a pure matcher.
      if (
        !interveningIfHolds(state, m.ability.condition.intervening, m.sourceInstanceId, m.controller, m.triggeringPlayer)
      ) {
        continue;
      }
      // The combat keyword family's COUNTERPART filter (DESIGN §3.107): "a
      // creature WITHOUT flanking blocks this creature", "blocks a creature
      // WITH flying". Part of the condition, so a failing filter means the
      // ability never triggers — and judged here rather than in the matcher
      // because it reads the counterpart's EFFECTIVE keywords off the state.
      if (
        (m.ability.condition.counterpartHasKeyword !== undefined ||
          m.ability.condition.counterpartLacksKeyword !== undefined) &&
        !counterpartFilterHolds(state, m)
      ) {
        continue;
      }
      // "Whenever ONE OR MORE creatures … deal combat damage" fires ONCE per
      // batch (CR 603.2 — the printed word "one or more" is a single event
      // however many objects qualify). Combat damage lands as one run of
      // events inside one action, and the queue is flushed per action — so
      // "already queued this flush window" IS "already fired for this batch".
      if (
        m.ability.condition.on === 'groupCombatDamageToPlayer' &&
        queue !== null &&
        queue.some(
          (q) => q.sourceInstanceId === m.sourceInstanceId && q.abilityIndex === m.abilityIndex,
        )
      ) {
        continue;
      }
      (queue ??= []).push(m);
    }
  };

  const flush = (): number => {
    if (queue === null || queue.length === 0) return 0;
    const batch = queue.splice(0, queue.length);
    const order = new Map<InstanceId, number>();
    for (let i = 0; i < state.battlefield.length; i++) {
      order.set((state.battlefield[i] as { instanceId: InstanceId }).instanceId, i);
    }
    const ordered = orderPendingTriggers(batch, state.activePlayer, order);
    for (const pending of ordered) {
      const label = pending.ability.label ?? `${pending.ability.condition.on} trigger`;
      state.stack.push({
        kind: 'trigger',
        instanceId: state.nextInstanceId++,
        sourceInstanceId: pending.sourceInstanceId,
        controller: pending.controller,
        effects: pending.ability.effects,
        targets: [],
        label,
        // Carried onto the stack object so the body can say "that player" — see
        // `PendingTrigger.triggeringPlayer`. Conditional so every trigger that
        // names no player is pushed byte-for-byte as it always was.
        ...(pending.triggeringPlayer !== undefined ? { triggeringPlayer: pending.triggeringPlayer } : {}),
        ...(pending.triggeringAmount !== undefined ? { triggeringAmount: pending.triggeringAmount } : {}),
        // "That creature" / "the blocking creature" (DESIGN §3.107), same reason.
        ...(pending.triggeringInstances !== undefined ? { triggeringInstances: pending.triggeringInstances } : {}),
        // Carried for CR 603.4's second check, made as the ability resolves.
        ...(pending.ability.condition.intervening !== undefined
          ? { intervening: pending.ability.condition.intervening }
          : {}),
        // An ability that declares what it targets goes on the stack UNAIMED; the
        // engine asks its controller immediately afterwards (`aimPendingTriggers`),
        // which is when the rules say targets are chosen. Absent for every other
        // trigger, so those are pushed byte-for-byte as they always were.
        ...(pending.ability.targets ? { awaitingTargets: pending.ability.targets } : {}),
        ...(pending.ability.targetsExcludeSelf === true ? { awaitingTargetsExcludeSelf: true } : {}),
        ...(pending.ability.targetCount ? { awaitingTargetCount: pending.ability.targetCount } : {}),
        // A modal trigger goes on the stack UNCHOSEN; the engine asks its
        // controller immediately afterwards (`aimPendingTriggers`), which is
        // when CR 603.3c says modes are chosen.
        ...(pending.ability.modal ? { awaitingModes: pending.ability.modal } : {}),
      });
      baseEmit({
        type: 'triggerPutOnStack',
        sourceInstanceId: pending.sourceInstanceId,
        controller: pending.controller,
        label,
      });
    }
    return ordered.length;
  };

  return { emit, flush };
}
