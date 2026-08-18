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
      readonly fromZone?: 'graveyard';
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
  | { readonly type: 'attackersDeclared'; readonly attackers: readonly InstanceId[] }
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
  | { readonly type: 'lifeChanged'; readonly player: PlayerId; readonly delta: number; readonly to: number }
  | { readonly type: 'gainLife'; readonly player: PlayerId; readonly amount: number }
  | { readonly type: 'creatureDied'; readonly instanceId: InstanceId; readonly name: string }
  | { readonly type: 'playerLost'; readonly player: PlayerId; readonly reason: string }
  | { readonly type: 'gameOver'; readonly winner: PlayerId | null }
  | { readonly type: 'actionRejected'; readonly reason: string }
  | { readonly type: 'counterAdded'; readonly instanceId: InstanceId; readonly kind: string; readonly amount: number }
  | {
      // A triggered ability matched an event and was placed on the stack.
      readonly type: 'triggerPutOnStack';
      readonly sourceInstanceId: InstanceId;
      readonly controller: PlayerId;
      readonly label: string;
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
