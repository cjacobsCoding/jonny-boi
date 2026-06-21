/**
 * GameState as plain data. This is the single explicit state object the engine
 * threads through every system — no module globals, no hidden mutable singletons.
 *
 * State-update strategy (perf note): the engine mutates a *working copy* produced
 * by structurally cloning only the parts a transition touches, rather than deep-
 * cloning the whole world per event. `applyAction` clones once at the boundary
 * (see engine.ts `cloneState`) and systems mutate that draft in place; callers
 * outside never see a half-applied draft. This keeps the hot path allocation-
 * conscious (one clone per action, not per event) while preserving the "previous
 * state is untouched" guarantee the sim/replay relies on. A future optimization
 * hook: swap `cloneState` for structural sharing (persistent maps) if profiling
 * shows the per-action clone dominates.
 */

import type { CardDefinition } from './card.js';
import type { ManaPool } from './mana.js';
import { emptyPool } from './mana.js';

/** Opaque, stable identity for a player. */
export type PlayerId = 'A' | 'B';

export const PLAYER_IDS: readonly PlayerId[] = ['A', 'B'];

/** Opaque per-object id assigned to every card instance and stack object. */
export type InstanceId = number;

/** The zones a card instance can occupy. */
export type ZoneName = 'library' | 'hand' | 'battlefield' | 'graveyard' | 'exile' | 'stack' | 'command';

/**
 * A runtime card instance. Distinct from its immutable `CardDefinition`: the
 * instance carries identity and mutable per-object state. Most fields are only
 * meaningful on the battlefield (tapped/damage/etc.) but live here uniformly so a
 * card keeps identity across zone changes.
 */
export interface CardInstance {
  readonly instanceId: InstanceId;
  /** The immutable card data this instance is an instance of. */
  readonly def: CardDefinition;
  /** Controller (who plays/controls it). For MVP, owner === controller. */
  controller: PlayerId;
  owner: PlayerId;
  zone: ZoneName;
  // --- battlefield/runtime state ---
  tapped: boolean;
  /** True until the controller has controlled it since their most recent turn began. */
  summoningSick: boolean;
  /** Damage marked this turn; cleared in cleanup. */
  damageMarked: number;
  /**
   * True once this creature has been dealt any damage by a deathtouch source this
   * turn — that damage is lethal regardless of amount (SBA destroys it). Cleared
   * in cleanup alongside marked damage.
   */
  markedByDeathtouch: boolean;
  /** Generic +1/+1-style counters etc., keyed by counter kind. */
  counters: Record<string, number>;
}

/** Per-player state. */
export interface PlayerState {
  readonly id: PlayerId;
  life: number;
  manaPool: ManaPool;
  /** Lands played so far this turn (reset each turn). */
  landsPlayedThisTurn: number;
  /** Set when this player has lost (and why is in the event log). */
  hasLost: boolean;
  // Zones owned by this player. Battlefield instances are addressed globally too
  // (see GameState.battlefield) but each card's `controller` is authoritative.
  library: CardInstance[];
  hand: CardInstance[];
  graveyard: CardInstance[];
  exile: CardInstance[];
  command: CardInstance[];
}

/** The turn steps, in order, that make up a turn. */
export type Step =
  | 'untap'
  | 'upkeep'
  | 'draw'
  | 'precombatMain'
  | 'beginCombat'
  | 'declareAttackers'
  | 'declareBlockers'
  | 'combatDamage'
  | 'endCombat'
  | 'postcombatMain'
  | 'end'
  | 'cleanup';

/** Canonical step order for one turn. */
export const STEP_ORDER: readonly Step[] = [
  'untap',
  'upkeep',
  'draw',
  'precombatMain',
  'beginCombat',
  'declareAttackers',
  'declareBlockers',
  'combatDamage',
  'endCombat',
  'postcombatMain',
  'end',
  'cleanup',
];

/** The two main phases are sorcery-speed windows; identify them by step. */
export const MAIN_STEPS: readonly Step[] = ['precombatMain', 'postcombatMain'];

/**
 * An object on the stack: a spell (a card instance moving through the stack) or an
 * ability. For the MVP every stack object carries the resolving instance and the
 * effects to run. Resolution is LIFO.
 */
export interface StackObject {
  readonly instanceId: InstanceId;
  /** The card instance this stack object represents. */
  readonly card: CardInstance;
  /** Who put it on the stack. */
  readonly controller: PlayerId;
  /** Where the card goes after resolving (battlefield for permanents, graveyard for spells). */
  readonly resolvesTo: 'battlefield' | 'graveyard';
  /** Targets chosen at cast time (instance ids and/or players); empty if none. */
  readonly targets: ReadonlyArray<InstanceId | PlayerId>;
}

/** Combat bookkeeping for the current turn (null outside combat). */
export interface CombatState {
  /** Attacker instance ids declared this combat. */
  attackers: InstanceId[];
  /** Blocker assignment: blocker instanceId -> the attacker it blocks. */
  blocks: Record<InstanceId, InstanceId>;
}

/** The whole game world as one plain-data object. */
export interface GameState {
  /** Monotonic id source for new instances/stack objects. */
  nextInstanceId: InstanceId;
  turnNumber: number;
  activePlayer: PlayerId;
  /** Who currently holds priority. */
  priorityPlayer: PlayerId;
  step: Step;
  /** Players keyed by id for O(1) access; iterate via PLAYER_IDS for order. */
  players: Record<PlayerId, PlayerState>;
  /** All battlefield permanents, in stable order. */
  battlefield: CardInstance[];
  /** The stack, index 0 = bottom, last = top (resolves first). */
  stack: StackObject[];
  combat: CombatState | null;
  /** Set once the game is decided. */
  winner: PlayerId | null;
  /** True once the game is over (winner set, or a draw). */
  gameOver: boolean;
  /**
   * Tracks consecutive priority passes since the last action/stack change, used
   * to decide when a step advances or the top of the stack resolves.
   */
  consecutivePasses: number;
  /** The seed the game was created with (for replay/debug). */
  readonly seed: number;
  /** Current RNG cursor, snapshotted into state for serialization. */
  rngState: number;
}

/** Build a fresh, empty player. */
export function createPlayer(id: PlayerId, startingLife: number): PlayerState {
  return {
    id,
    life: startingLife,
    manaPool: emptyPool(),
    landsPlayedThisTurn: 0,
    hasLost: false,
    library: [],
    hand: [],
    graveyard: [],
    exile: [],
    command: [],
  };
}

/** The non-stack, non-shared zone arrays a player owns, by zone name. */
export function playerZone(player: PlayerState, zone: ZoneName): CardInstance[] | null {
  switch (zone) {
    case 'library':
      return player.library;
    case 'hand':
      return player.hand;
    case 'graveyard':
      return player.graveyard;
    case 'exile':
      return player.exile;
    case 'command':
      return player.command;
    default:
      return null;
  }
}
