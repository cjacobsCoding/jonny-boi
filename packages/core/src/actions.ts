/**
 * Player ACTIONS — the seam the AI (§3.4) consumes. A legal-action generator
 * lists what the priority-holder may do; `applyAction` (engine.ts) executes one.
 * Actions are plain data and fully describe the choice (no hidden engine calls),
 * so an AI can enumerate, score, and pick one against a read-only view.
 */

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
}

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

/** The union of all player actions. */
export type GameAction =
  | PassPriorityAction
  | PlayLandAction
  | TapForManaAction
  | CastSpellAction
  | DeclareAttackersAction
  | DeclareBlockersAction;

/** A discriminator helper for exhaustiveness. */
export type ActionKind = GameAction['kind'];
