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
import type { ContinuousEffect } from './internal/continuous.js';
import type { PendingChoice, ResolutionFrame } from './choices.js';

/** Opaque, stable identity for a player. */
export type PlayerId = 'A' | 'B';

export const PLAYER_IDS: readonly PlayerId[] = ['A', 'B'];

/**
 * The other seat. One accessor so "my opponent" is spelled the same everywhere —
 * card effects that put a choice to the OPPONENT (targeted discard) reach for this
 * constantly.
 */
export function opponentOf(player: PlayerId): PlayerId {
  return player === 'A' ? 'B' : 'A';
}

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
  /**
   * Generic +1/+1-style counters etc., keyed by counter kind.
   *
   * **Contract: REPLACE this object, never mutate it in place.** To add a counter,
   * assign a new record (`inst.counters = { ...inst.counters, [kind]: n }`); to
   * clear them, assign {@link NO_COUNTERS}. Every write in the codebase already
   * works this way — the field is only ever assigned wholesale.
   *
   * That is what lets the empty case be a single shared, frozen object instead of
   * a fresh `{}` per instance. It is worth spelling out because the saving is not
   * small: nearly every instance in a game carries no counters, and that one empty
   * object was **40% of everything `cloneState` allocates** — the whole library,
   * the whole hand, every vanilla creature, copied on every action. Because the
   * shared object is frozen, an in-place write fails loudly at the offending line
   * rather than silently aliasing two states together.
   */
  counters: Record<string, number>;
}

/**
 * The shared, frozen "no counters" record. See {@link CardInstance.counters} for
 * the replace-never-mutate contract that makes sharing it safe.
 */
export const NO_COUNTERS: Record<string, number> = Object.freeze({}) as Record<string, number>;

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
 * A spell (or permanent) on the stack: a card instance moving through the stack.
 * Carries the resolving instance and resolves to a zone. Resolution is LIFO.
 */
export interface SpellStackObject {
  /** Discriminator; a spell/permanent moving through the stack. */
  readonly kind: 'spell';
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

/**
 * A triggered ability on the stack (DESIGN §3.9). Unlike a spell it carries no card
 * moving zones — it runs its effects against its source then leaves the stack.
 */
export interface TriggeredStackObject {
  readonly kind: 'trigger';
  /** A unique id for this stack object (distinct from the source instance). */
  readonly instanceId: InstanceId;
  /** The permanent whose ability this is. */
  readonly sourceInstanceId: InstanceId;
  /** Who controls the ability. */
  readonly controller: PlayerId;
  /** Effect refs to run on resolution. */
  readonly effects: ReadonlyArray<import('./card.js').EffectRef>;
  /** Targets, if any (resolved when the trigger went on the stack). */
  readonly targets: ReadonlyArray<InstanceId | PlayerId>;
  /** Debug label for the inspector/event log. */
  readonly label: string;
}

/** Anything that can sit on the stack. */
export type StackObject = SpellStackObject | TriggeredStackObject;

/** Combat bookkeeping for the current turn (null outside combat). */
export interface CombatState {
  /** Attacker instance ids declared this combat. */
  attackers: InstanceId[];
  /** Blocker assignment: blocker instanceId -> the attacker it blocks. */
  blocks: Record<InstanceId, InstanceId>;
  /**
   * Whether the declare step has HAPPENED — which is not the same as whether it
   * produced anything. Declaring no attackers (or no blockers) is a legal, common
   * choice, so emptiness cannot stand in for "not yet declared": without these
   * flags an empty declaration is accepted forever, and because declaring resets
   * the consecutive-pass counter, the step can never end. A pilot that searches
   * its options (rather than passing by convention) falls straight into that loop.
   */
  attackersDeclared: boolean;
  blockersDeclared: boolean;
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
  /**
   * Active continuous effects (DESIGN §3.9): temporary P/T buffs and keyword grants,
   * mostly "until end of turn", removed in cleanup. Effective P/T and keywords are
   * computed by layering these over each permanent's base (see internal/continuous).
   */
  continuous: ContinuousEffect[];
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
  /**
   * A question a resolving spell/ability is waiting on (DESIGN §3.11 "player
   * choice during resolution"). While it is set, `pendingChoice.chooser` — who may
   * be the OPPONENT of the spell's controller — is the only seat that may act, and
   * the only action they may take is `answerChoice`.
   *
   * Optional so that every existing state literal (and every serialized state
   * written before choices existed) stays valid: absent and `null` both mean "no
   * question outstanding", and a game containing no choice-asking card never
   * touches these two fields at all.
   */
  pendingChoice?: PendingChoice | null;
  /**
   * The half-finished resolution the pending choice belongs to — the bookmark that
   * lets the spell finish resolving after the answer. Set only while suspended.
   */
  resolution?: ResolutionFrame | null;
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
