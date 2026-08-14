/**
 * Player ACTIONS — the seam the AI (§3.4) consumes. A legal-action generator
 * lists what the priority-holder may do; `applyAction` (engine.ts) executes one.
 * Actions are plain data and fully describe the choice (no hidden engine calls),
 * so an AI can enumerate, score, and pick one against a read-only view.
 */

import type { ChoiceAnswer } from './choices.js';
import type { InstanceId, PlayerId } from './state.js';

/** Pass priority. The single always-legal action when you hold priority. */
export interface PassPriorityAction {
  readonly kind: 'passPriority';
  readonly player: PlayerId;
}

/** Play a land from hand (sorcery-speed, one per turn, empty stack). */
export interface PlayLandAction {
  readonly kind: 'playLand';
  readonly player: PlayerId;
  readonly instanceId: InstanceId;
}

/** Tap a mana source for mana (adds to the controller's pool). */
export interface TapForManaAction {
  readonly kind: 'tapForMana';
  readonly player: PlayerId;
  readonly instanceId: InstanceId;
  /**
   * Which mana mode to activate, indexing the source's normalised mode list
   * (`manaModesOf`). A modal source — Birds of Paradise, a dual land — offers one
   * action per mode, so the *choice of color is part of the action* and an AI can
   * enumerate and score it. Omitted means {@link DEFAULT_MANA_MODE}, which is the
   * only mode a single-mode source has.
   */
  readonly mode?: number;
}

/**
 * The mode a `tapForMana` action activates when it doesn't say. Single-mode
 * sources (every basic land) have only this one, so omitting `mode` stays the
 * natural way to tap a Forest.
 */
export const DEFAULT_MANA_MODE = 0;

/**
 * Cast a spell from hand onto the stack. `targets` carries any chosen targets
 * (instance ids and/or players); empty when the spell needs none.
 */
export interface CastSpellAction {
  readonly kind: 'castSpell';
  readonly player: PlayerId;
  readonly instanceId: InstanceId;
  readonly targets?: ReadonlyArray<InstanceId | PlayerId>;
}

/** Declare attackers (active player, declareAttackers step). */
export interface DeclareAttackersAction {
  readonly kind: 'declareAttackers';
  readonly player: PlayerId;
  readonly attackers: readonly InstanceId[];
}

/**
 * Declare blockers (defending player, declareBlockers step). Each entry assigns a
 * blocker to an attacker it legally blocks.
 */
export interface DeclareBlockersAction {
  readonly kind: 'declareBlockers';
  readonly player: PlayerId;
  readonly blocks: ReadonlyArray<{ readonly blocker: InstanceId; readonly attacker: InstanceId }>;
}

/**
 * Answer the question a resolving spell/ability parked in `GameState.pendingChoice`
 * (see choices.ts). It is an ordinary action deliberately: the sim's pilots, the
 * hotseat UI, and the online server all already know how to enumerate, choose, and
 * submit actions, so a question needs no separate transport, no callback, and no
 * change to any consumer's loop.
 *
 * `choiceId` must name the choice actually outstanding — a stale answer (a slow
 * client replying to a question that has already been resolved) is rejected rather
 * than misapplied to whatever is open now.
 */
export interface AnswerChoiceAction {
  readonly kind: 'answerChoice';
  /** Must equal `pendingChoice.chooser` — the engine enforces WHO answers. */
  readonly player: PlayerId;
  readonly choiceId: number;
  readonly answer: ChoiceAnswer;
}

/** The union of all player actions. */
export type GameAction =
  | PassPriorityAction
  | PlayLandAction
  | TapForManaAction
  | CastSpellAction
  | DeclareAttackersAction
  | DeclareBlockersAction
  | AnswerChoiceAction;

/** A discriminator helper for exhaustiveness. */
export type ActionKind = GameAction['kind'];
