/**
 * Typed, append-only event log. Every meaningful mutation emits a `GameEvent`.
 * This is the replay/inspector/AI-observation seam (DESIGN §2): systems and the
 * AI observe the log without coupling to each other. Events are plain data and
 * are never mutated after being appended.
 */

import type { InstanceId, PlayerId, Step, ZoneName } from './state.js';
import type { ManaColor, ManaCost } from './mana.js';
import type { CardType } from './card.js';
import type { ContinuousDuration } from './internal/continuous.js';
import type { ChoiceAnswer, ChoiceKind } from './choices.js';

/** Discriminated union of everything the engine reports. */
export type GameEvent =
  | { readonly type: 'gameStart'; readonly seed: number; readonly startingPlayer: PlayerId }
  | { readonly type: 'turnBegin'; readonly turn: number; readonly activePlayer: PlayerId }
  | { readonly type: 'stepBegin'; readonly step: Step; readonly activePlayer: PlayerId }
  | { readonly type: 'priorityPassed'; readonly player: PlayerId }
  | { readonly type: 'untapped'; readonly instanceId: InstanceId; readonly player: PlayerId }
  | { readonly type: 'drawCard'; readonly player: PlayerId; readonly instanceId: InstanceId }
  | {
      readonly type: 'zoneChange';
      readonly instanceId: InstanceId;
      readonly from: ZoneName;
      readonly to: ZoneName;
    }
  | { readonly type: 'landPlayed'; readonly player: PlayerId; readonly instanceId: InstanceId }
  | {
      readonly type: 'spellCast';
      readonly player: PlayerId;
      readonly instanceId: InstanceId;
      readonly name: string;
      /** The card types of the spell cast (so cast-triggers can filter by type). */
      readonly castTypes: readonly CardType[];
      /**
       * Present (as `'graveyard'`) when this was a flashback cast, so the log,
       * the replay and the inspector can say WHICH way the spell was cast —
       * absent for the ordinary from-hand cast every existing consumer knows.
       */
      readonly fromZone?: 'graveyard' | 'exile';
    }
  | {
      /**
       * A card was CYCLED from hand (CR 702.29): its cost was paid, the card was
       * discarded, and the cycling ability went on the stack. Distinct from the
       * `zoneChange` the discard emits, because "you cycled a card" is what the
       * printed triggers ask about ("When you cycle this card…", "Whenever you
       * cycle or discard another card…") and a bare hand→graveyard move cannot
       * tell cycling apart from any other discard.
       */
      readonly type: 'cardCycled';
      readonly player: PlayerId;
      readonly instanceId: InstanceId;
      readonly name: string;
    }
  | {
      /**
       * The active player discarded down to their maximum hand size as their own
       * cleanup step began (CR 514.1, enforcing the CR 402.2 maximum).
       *
       * It carries a COUNT and no instance ids, on purpose. That somebody was
       * over the limit, and by how much, is a fact the whole table watches — the
       * cards are counted in the open. WHICH cards went is not carried here
       * because it does not need to be: every discarded card lands in a
       * graveyard through its own `zoneChange`, and a graveyard is a public zone,
       * so the identities arrive by exactly the route every other discard's do.
       * Splitting it this way is what lets this event travel to a pilot as
       * printed instead of needing a redaction shape of its own.
       */
      readonly type: 'cleanupDiscard';
      readonly player: PlayerId;
      /** How many cards were discarded — hand size minus the maximum. */
      readonly count: number;
      /** The maximum that was enforced (`RulesConfig.maximumHandSize`). */
      readonly maximumHandSize: number;
    }
  | {
      /**
       * A discarded card with madness was exiled instead, and its owner now has
       * the window to cast it for its madness cost (CR 702.35a).
       */
      readonly type: 'madnessWindowOpened';
      readonly player: PlayerId;
      readonly instanceId: InstanceId;
      readonly name: string;
    }
  | {
      /**
       * The madness window closed without a cast: the card went to the graveyard
       * the ordinary discard would have put it in. Said explicitly so a replay
       * can distinguish "declined" from "the window is still open".
       */
      readonly type: 'madnessDeclined';
      readonly player: PlayerId;
      readonly instanceId: InstanceId;
      readonly name: string;
    }
  | {
      readonly type: 'stackResolved';
      readonly instanceId: InstanceId;
      readonly name: string;
    }
  | {
      readonly type: 'manaAdded';
      readonly player: PlayerId;
      readonly color: ManaColor;
      readonly amount: number;
      /**
       * The printed SPEND RESTRICTION this mana carries, if any — "only to cast a
       * creature spell". Absent for ordinary mana, which is nearly all of it.
       *
       * The LABEL rather than the predicate: the event log and the observation
       * feed want words, and the machine-readable restriction already lives on
       * the pool, which is where every payment reads it. Two copies of a
       * predicate is two things that can disagree.
       */
      readonly spendRestriction?: string;
    }
  | { readonly type: 'manaPoolEmptied'; readonly player: PlayerId }
  | {
      /**
       * A mana cost was paid OUTSIDE of casting — the "unless its controller pays
       * {3}" branch of a resolving spell. Casting needs no such event (the spell
       * itself is the record); a payment that keeps a spell alive would otherwise
       * leave nothing in the log but a pool that quietly shrank.
       */
      readonly type: 'manaCostPaid';
      readonly player: PlayerId;
      readonly cost: ManaCost;
    }
  | {
      /** A permanent changed controller (gained control, or handed back). */
      readonly type: 'controlChanged';
      readonly instanceId: InstanceId;
      readonly from: PlayerId;
      readonly to: PlayerId;
    }
  | {
      /** Cards moved from the top of a library to its graveyard (milling). */
      readonly type: 'cardsMilled';
      readonly player: PlayerId;
      readonly amount: number;
    }
  | {
      /**
       * A player LOOKED AT the top `amount` cards of their library — the scry /
       * surveil half that moves nothing (CR 701.18a, 701.42a).
       *
       * It carries a COUNT and nothing else, on purpose: at a real table
       * everybody sees how many cards you picked up, and nobody sees what they
       * are. That makes the event public as printed, and it is the only honest
       * way to log a look — the identities never leave the choice, which travels
       * to its chooser alone and whose public `choiceAsked` is likewise a count.
       *
       * Emitted only once the look's question has been ANSWERED (a primitive
       * re-run to collect a later answer must not log the look twice).
       */
      readonly type: 'cardsLookedAt';
      readonly player: PlayerId;
      readonly amount: number;
    }
  | {
      /** A non-mana activated ability was activated and put on the stack. */
      readonly type: 'abilityActivated';
      readonly player: PlayerId;
      /** The permanent whose ability this is. */
      readonly instanceId: InstanceId;
      /** The ability's printed label, for the log and the replay viewer. */
      readonly label: string;
    }
  | { readonly type: 'tapped'; readonly instanceId: InstanceId }
  | {
      readonly type: 'effectApplied';
      readonly primitive: string;
      readonly sourceInstanceId: InstanceId;
    }
  | {
      readonly type: 'effectUnsupported';
      readonly primitive: string;
      readonly sourceInstanceId: InstanceId;
    }
  | {
      readonly type: 'attackersDeclared';
      readonly attackers: readonly InstanceId[];
      /**
       * Per-attacker attacked OBJECT, present only for attackers not attacking
       * the defending player (a planeswalker). Optional so every fold of the
       * log written before walkers existed still reads the event unchanged.
       */
      readonly attackTargets?: Readonly<Record<InstanceId, InstanceId | PlayerId>>;
    }
  | {
      readonly type: 'blockersDeclared';
      readonly blocks: ReadonlyArray<{ readonly blocker: InstanceId; readonly attacker: InstanceId }>;
    }
  | {
      readonly type: 'damageDealt';
      readonly source: InstanceId;
      readonly target: InstanceId | PlayerId;
      readonly amount: number;
      readonly combat: boolean;
    }
  | {
      /**
       * Damage a source WOULD have dealt was prevented — today only by
       * protection's "can't be dealt damage by sources with that quality" half.
       * Its own event rather than silence: a replay or the inspector must be
       * able to show WHY a swing did nothing, and a prevented hit that leaves
       * no trace is indistinguishable from a bug.
       */
      readonly type: 'damagePrevented';
      readonly source: InstanceId;
      readonly target: InstanceId | PlayerId;
      readonly amount: number;
      readonly combat: boolean;
    }
  | {
      /**
       * A REPLACEMENT effect changed an event before it happened (CR 614) — a
       * damage doubler, a counter multiplier, a prevention shield eating part of
       * a hit. Its own event for exactly the reason `damagePrevented` has one: a
       * replay or the inspector must be able to show WHY four counters went onto
       * a creature the card said to put one on, and "it just happened" is
       * indistinguishable from a bug.
       *
       * `from`/`to` are the quantity before and after THIS one effect, so a
       * chain of two doublers reads as two events with matching seams rather
       * than one lossy summary — which is also what makes the CR 616.1 ordering
       * decision auditable from the log alone.
       */
      readonly type: 'replacementApplied';
      /** The permanent (or resolving spell) the replacement effect comes from. */
      readonly source: InstanceId;
      /** Which event family was replaced. */
      readonly event: 'damage' | 'counters' | 'draw';
      readonly from: number;
      readonly to: number;
      /** How much of `from` this effect PREVENTED (0 for a pure multiplier). */
      readonly prevented: number;
      /** The printed line, when the card carried one. Never read by the rules. */
      readonly label?: string;
    }
  | {
      /**
       * A floating replacement/prevention effect wore off in cleanup — the fog
       * that guarded this turn's combat, or an unspent shield. Mirrors
       * `continuousEffectExpired`, so the two lifetimes read the same way in a
       * log.
       */
      readonly type: 'replacementExpired';
      readonly id: number;
      readonly source: InstanceId;
    }
  | { readonly type: 'lifeChanged'; readonly player: PlayerId; readonly delta: number; readonly to: number }
  | { readonly type: 'gainLife'; readonly player: PlayerId; readonly amount: number }
  | { readonly type: 'creatureDied'; readonly instanceId: InstanceId; readonly name: string }
  | {
      /**
       * A planeswalker's loyalty changed — damage removed counters, a loyalty
       * ability's cost added or removed them. Its own event (not `counterAdded`)
       * because loyalty is the walker's life total: a replay, the inspector and
       * the UI all need "at what loyalty is it NOW", which `to` answers directly.
       */
      readonly type: 'loyaltyChanged';
      readonly instanceId: InstanceId;
      readonly delta: number;
      readonly to: number;
    }
  | {
      // CR 704.5i: a planeswalker with no loyalty is put into its owner's
      // graveyard by a state-based action. Named apart from `creatureDied` so a
      // log reader can tell a dead walker from a dead creature.
      readonly type: 'planeswalkerDied';
      readonly instanceId: InstanceId;
      readonly name: string;
    }
  | {
      /**
       * A battle's defense changed — it entered with its printed counters, or
       * damage removed some (CR 120.3d). Its own event (not `counterAdded`) for
       * the same reason loyalty has one: defense is the battle's life total, and
       * a replay, the inspector and the UI all need "at what defense is it NOW",
       * which `to` answers directly.
       */
      readonly type: 'defenseChanged';
      readonly instanceId: InstanceId;
      readonly delta: number;
      readonly to: number;
    }
  | {
      /**
       * A battle with no defense counters was put into its owner's graveyard by
       * a state-based action (CR 704.5x's generic outcome). Named apart from
       * `creatureDied`/`planeswalkerDied` so a log reader can tell a defeated
       * battle from either. The Siege reward — exile it and cast the back face —
       * needs the castable-second-face system and is NOT modelled yet; cards
       * printing it stay reported by the compiler, so this event never
       * under-delivers a printed reward in a real game.
       */
      readonly type: 'battleDefeated';
      readonly instanceId: InstanceId;
      readonly name: string;
    }
  | {
      /**
       * The legend rule was applied (CR 704.5j): `player` controlled two or more
       * legendary permanents named `name`, chose to keep `keptInstanceId`, and
       * the rest went to their owners' graveyards (each departure emitting its
       * own died/zoneChange events). The choice itself arrives as the ordinary
       * choiceAsked/choiceAnswered pair; this event is the rule's verdict.
       */
      readonly type: 'legendRuleApplied';
      readonly player: PlayerId;
      readonly name: string;
      readonly keptInstanceId: InstanceId;
    }
  | {
      /**
       * An EMBLEM was created in `controller`'s command zone — a game object
       * with no physical presence: not a permanent, not targetable, and nothing
       * in the game can remove it (CR 114). Its statics and triggers work from
       * the command zone exactly as a permanent's would from the battlefield.
       */
      readonly type: 'emblemCreated';
      readonly instanceId: InstanceId;
      readonly controller: PlayerId;
      readonly name: string;
    }
  | { readonly type: 'playerLost'; readonly player: PlayerId; readonly reason: string }
  | { readonly type: 'gameOver'; readonly winner: PlayerId | null }
  | { readonly type: 'actionRejected'; readonly reason: string }
  | { readonly type: 'counterAdded'; readonly instanceId: InstanceId; readonly kind: string; readonly amount: number }
  | {
      /**
       * A permanent NAMED a value as it entered — "As ~ enters, choose a creature
       * type" (CR 614.1c). Its own event rather than a `choiceAnswered`, because
       * the two are not the same fact: the ANSWER to a question is private to its
       * chooser (and redacted as such), while the value a permanent named is
       * ANNOUNCED AT THE TABLE and is a permanent, public characteristic of the
       * board for as long as the card is on it.
       *
       * `value` is the raw stored form (a colour letter, a subtype, a seat) and
       * `described` is it written out for a log line — carried so a reader needs
       * neither the subject nor a lookup table to render it.
       */
      readonly type: 'chosenAsEnters';
      readonly instanceId: InstanceId;
      readonly name: string;
      readonly subject: import('./choices.js').ChosenValueSubject;
      readonly value: string;
      readonly described: string;
    }
  | {
      // A triggered ability matched an event and was placed on the stack.
      readonly type: 'triggerPutOnStack';
      readonly sourceInstanceId: InstanceId;
      readonly controller: PlayerId;
      readonly label: string;
    }
  | {
      /**
       * A triggered ability was removed from the stack WITHOUT resolving,
       * because its printed intervening "if" had stopped being true by the time
       * it would have resolved (CR 603.4's second check).
       *
       * A distinct event rather than silence: the ability really did go on the
       * stack and really was responded to, so a log that showed the push and
       * then nothing would read as an engine bug. Public — every player watched
       * it happen.
       */
      readonly type: 'triggerFizzled';
      readonly sourceInstanceId: InstanceId;
      readonly controller: PlayerId;
      readonly label: string;
      readonly reason: string;
    }
  | {
      /**
       * A triggered ability chose what it points at, as it went on the stack
       * (CR 603.3d). Separate from `triggerPutOnStack` because they are separate
       * moments — the ability is on the stack first, then aimed — and a replay
       * folding them together could not show a trigger being aimed at a creature
       * that is about to die in response.
       */
      readonly type: 'triggerTargetsChosen';
      readonly sourceInstanceId: InstanceId;
      readonly controller: PlayerId;
      readonly label: string;
      readonly targets: ReadonlyArray<InstanceId | PlayerId>;
    }
  | {
      /**
       * A modal spell's modes were ANNOUNCED as it was cast (CR 601.2b). Public
       * information — in paper the caster says the modes out loud before anyone
       * may respond — so the labels are carried plainly and a replay can show
       * what the opponent knew when they decided whether to counter.
       *
       * Separate from `spellCast` because they are separate moments: the spell
       * is on the stack first, then its modes are announced, and a Cryptic
       * Command whose modes are chosen while a response is already on the stack
       * would be a different card.
       */
      readonly type: 'modesChosen';
      readonly player: PlayerId;
      readonly instanceId: InstanceId;
      readonly name: string;
      /** The chosen modes' printed labels, in printed order, one per pick. */
      readonly modes: readonly string[];
    }
  | {
      /**
       * One announced mode was aimed (CR 601.2c). Its own event, rather than a
       * list on `modesChosen`, because each mode is aimed as its own question --
       * and because a two-mode Command aims at two different objects, which a
       * single targets list on the cast could never express.
       */
      readonly type: 'modeTargetChosen';
      readonly player: PlayerId;
      readonly instanceId: InstanceId;
      /** The aimed mode's printed label. */
      readonly mode: string;
      readonly targets: ReadonlyArray<InstanceId | PlayerId>;
    }
  | {
      /**
       * A triggered ability left the stack WITHOUT resolving — today only because
       * it had no legal target when it needed one (CR 603.3d). Its own event
       * rather than a silent removal: a trigger that vanishes with no trace in the
       * log is indistinguishable from one that never fired.
       */
      readonly type: 'triggerRemovedFromStack';
      readonly sourceInstanceId: InstanceId;
      readonly controller: PlayerId;
      readonly label: string;
      readonly reason: string;
    }
  | {
      // A triggered ability finished resolving (its effects ran).
      readonly type: 'triggeredAbilityResolved';
      readonly sourceInstanceId: InstanceId;
      readonly label: string;
    }
  | {
      // An "until end of turn" (or other-duration) continuous effect was removed.
      readonly type: 'continuousEffectExpired';
      readonly targetInstanceId: InstanceId;
      readonly sourceInstanceId: InstanceId;
      readonly duration: ContinuousDuration;
    }
  | {
      // A continuous effect (e.g. a pump) was registered onto a permanent.
      readonly type: 'continuousEffectAdded';
      readonly targetInstanceId: InstanceId;
      readonly sourceInstanceId: InstanceId;
      readonly duration: ContinuousDuration;
    }
  | {
      // A card in a NON-battlefield zone gained an ability (Snapcaster's "gains
      // flashback until end of turn" on a graveyard card) — see card-grants.ts.
      // Public by nature: the zones a grant can touch (graveyard, exile) are
      // open information, and the granting ability resolved in front of everyone.
      readonly type: 'cardGrantAdded';
      readonly targetInstanceId: InstanceId;
      readonly sourceInstanceId: InstanceId;
      readonly duration: ContinuousDuration;
    }
  | {
      // A card grant was removed (cleanup's "until end of turn" expiry). A grant
      // dropped because its card CHANGED ZONES emits nothing extra — the
      // zoneChange already tells that story (CR 400.7: the grant simply stops
      // being true of the new object).
      readonly type: 'cardGrantExpired';
      readonly targetInstanceId: InstanceId;
      readonly sourceInstanceId: InstanceId;
    }
  | {
      // A permanent became attached to another (an Aura enchanting a creature, an
      // Equipment being equipped). Emitted for the MOVE too — attaching an already
      // attached Equipment is one `permanentAttached`, since the log's consumer
      // only ever needs the new host.
      readonly type: 'permanentAttached';
      readonly instanceId: InstanceId;
      readonly hostInstanceId: InstanceId;
    }
  | {
      // A permanent stopped being attached — CR 704.5n, or its host left play.
      readonly type: 'permanentUnattached';
      readonly instanceId: InstanceId;
      /** The host it was attached to, so a replay can undo the visual link. */
      readonly hostInstanceId: InstanceId;
    }
  | {
      // An attach was REFUSED because the host was not legal for it. The rule-6
      // signal: the board is unchanged and the reason is in the log, rather than a
      // silently mis-attached permanent (or a throw).
      readonly type: 'attachmentFailed';
      readonly instanceId: InstanceId;
      readonly reason: string;
    }
  | {
      // CR 704.5m: an Aura that is not legally attached was put into its owner's
      // graveyard by a state-based action. Named separately from `creatureDied` so
      // a log reader can tell "the aura fell off" from "the creature died".
      readonly type: 'attachmentPutIntoGraveyard';
      readonly instanceId: InstanceId;
      readonly name: string;
    }
  | {
      /**
       * A double-faced permanent TRANSFORMED (CR 701.28): its active face
       * swapped. Deliberately NOT a `zoneChange` — transforming is not a zone
       * change (CR 712.8), so counters/damage/attachments persist and no
       * ETB/leaves trigger may fire off it. `toName` is the face now showing,
       * which is what a replay/board needs to re-render the permanent.
       */
      readonly type: 'transformed';
      readonly instanceId: InstanceId;
      readonly fromName: string;
      readonly toName: string;
      readonly faceUp: 'front' | 'back';
    }
  | {
      /**
       * A permanent ENTERED AS A COPY of another object (CR 706, layer 1) —
       * the printed "you may have ~ enter as a copy of …" replacement. Like
       * `transformed` this is deliberately NOT a `zoneChange`: the copy is
       * applied as the permanent enters, and the entry itself is announced by
       * its own `zoneChange`.
       *
       * Fully public. Every field names something a spectator watching the
       * table sees: which permanent became a copy, the card it printed as, the
       * card it now is, and which visible object it was copied from.
       */
      readonly type: 'becameCopy';
      readonly instanceId: InstanceId;
      /** The name printed on the copying card itself ("Clone"). */
      readonly ownName: string;
      /** The name it now has — the copied card, after any "except …" tail. */
      readonly copiedName: string;
      /** The object it was copied from. */
      readonly copiedInstanceId: InstanceId;
    }
  | {
      // A token permanent was created on the battlefield.
      readonly type: 'tokenCreated';
      readonly instanceId: InstanceId;
      readonly controller: PlayerId;
      readonly name: string;
    }
  | {
      // A resolving spell/ability asked a player a question; resolution is parked
      // until it is answered. The replay/inspector needs both halves of every
      // choice, which is why asking and answering are BOTH events.
      readonly type: 'choiceAsked';
      readonly choiceId: number;
      readonly chooser: PlayerId;
      readonly choiceKind: ChoiceKind;
      readonly prompt: string;
      readonly sourceInstanceId: InstanceId;
      /** How many options were offered (cards / players / modes / yes-no). */
      readonly optionCount: number;
    }
  | {
      // A choice was answered and its resolution resumed.
      readonly type: 'choiceAnswered';
      readonly choiceId: number;
      readonly chooser: PlayerId;
      readonly choiceKind: ChoiceKind;
      /** The answer itself — plain data, so a replay reproduces the game exactly. */
      readonly answer: ChoiceAnswer;
      /** A compact rendering for logs/inspectors. */
      readonly summary: string;
    }
  | {
      // The engine answered on the chooser's behalf, because the question had
      // exactly one legal answer or could not be put to them (see `reason`).
      readonly type: 'choiceAutoAnswered';
      readonly choiceId: number;
      readonly chooser: PlayerId;
      readonly choiceKind: ChoiceKind;
      readonly answer: ChoiceAnswer;
      readonly reason: string;
    }
  | {
      // A resolution was abandoned because its question could not be represented
      // (an unknown choice kind) or it asked too many. Safe degradation, said out
      // loud rather than a crash or a hang.
      readonly type: 'choiceAbandoned';
      readonly sourceInstanceId: InstanceId;
      readonly reason: string;
    };

/** The append-only log. Construct via `createEventLog`; never reorder/mutate. */
export interface EventLog {
  readonly events: readonly GameEvent[];
}

/** A fresh, empty log. */
export function createEventLog(): GameEvent[] {
  return [];
}

/** Filter helper for inspectors/AI: events of a given type. */
export function eventsOfType<T extends GameEvent['type']>(
  events: readonly GameEvent[],
  type: T,
): ReadonlyArray<Extract<GameEvent, { type: T }>> {
  return events.filter((e): e is Extract<GameEvent, { type: T }> => e.type === type);
}
