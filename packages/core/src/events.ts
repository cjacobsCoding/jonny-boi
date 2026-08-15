/**
 * Typed, append-only event log. Every meaningful mutation emits a `GameEvent`.
 * This is the replay/inspector/AI-observation seam (DESIGN §2): systems and the
 * AI observe the log without coupling to each other. Events are plain data and
 * are never mutated after being appended.
 */

import type { InstanceId, PlayerId, Step, ZoneName } from './state.js';
import type { ManaColor } from './mana.js';
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
