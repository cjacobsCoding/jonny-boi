/**
 * State cloning at the action boundary. `applyAction` clones the incoming state
 * once, then systems mutate the draft in place — so the caller's previous state
 * is never altered (the sim/replay relies on that). We clone the mutable shells
 * (players, zone arrays, instances, stack, combat) but SHARE the immutable
 * `CardDefinition` records by reference (they never change), keeping the clone
 * cheap. One clone per action, not per event.
 */

import type {
  CardInstance,
  GameState,
  PlayerId,
  PlayerState,
  StackObject,
  CombatState,
} from '../state.js';
import type { ManaPool } from '../mana.js';
import type { ContinuousEffect } from './continuous.js';
import { NO_COUNTERS, PLAYER_IDS } from '../state.js';
import type { PendingChoice, ResolutionFrame } from '../choices.js';
import { cloneChoiceAnswer } from '../choices.js';

/**
 * Copy an instance's counters — or, when there are none, hand back the shared
 * frozen empty record.
 *
 * Nearly every instance in a game carries no counters (a whole library, a whole
 * hand, every vanilla creature), and that empty `{}` was measured at 40% of
 * everything a clone allocates: ~66 bytes each, ~120 of them per action. Sharing
 * one is safe because `CardInstance.counters` is contractually REPLACED and never
 * mutated in place — see the field's own documentation in state.ts — and the
 * shared record is frozen, so a violation throws at the offending line instead of
 * quietly aliasing two states together.
 */
function cloneCounters(counters: Record<string, number>): Record<string, number> {
  for (const kind in counters) {
    // Something is actually in there — pay for the real copy.
    void kind;
    return { ...counters };
  }
  return NO_COUNTERS;
}

function cloneInstance(inst: CardInstance): CardInstance {
  const copy: CardInstance = {
    instanceId: inst.instanceId,
    def: inst.def, // immutable — shared by reference
    controller: inst.controller,
    owner: inst.owner,
    zone: inst.zone,
    tapped: inst.tapped,
    summoningSick: inst.summoningSick,
    damageMarked: inst.damageMarked,
    markedByDeathtouch: inst.markedByDeathtouch,
    counters: cloneCounters(inst.counters),
  };
  // Written only when the instance is actually attached to something, which is a
  // handful of permanents in a game that has any attachments at all and NONE in a
  // game that has none. Cloning is the engine's single hottest allocation — a whole
  // library and a whole hand copied on every action — so an unconditional tenth
  // property measured as a real (~4%) throughput regression across the gauntlet for
  // a field that is almost always null. Copying it conditionally keeps the ordinary
  // instance byte-for-byte the object it has always been.
  if (inst.attachedTo != null) copy.attachedTo = inst.attachedTo;
  return copy;
}

function cloneInstances(list: readonly CardInstance[]): CardInstance[] {
  return list.map(cloneInstance);
}

/**
 * A fresh pool with the same contents. Spelled out rather than spread: the six
 * colours are a fixed, known shape, so the literal compiles to a straight
 * allocate-and-store instead of a generic property copy.
 */
function clonePool(pool: ManaPool): ManaPool {
  return { W: pool.W, U: pool.U, B: pool.B, R: pool.R, G: pool.G, C: pool.C };
}

function clonePlayer(p: PlayerState): PlayerState {
  return {
    id: p.id,
    life: p.life,
    manaPool: clonePool(p.manaPool),
    landsPlayedThisTurn: p.landsPlayedThisTurn,
    hasLost: p.hasLost,
    library: cloneInstances(p.library),
    hand: cloneInstances(p.hand),
    graveyard: cloneInstances(p.graveyard),
    exile: cloneInstances(p.exile),
    command: cloneInstances(p.command),
  };
}

function cloneStackObject(o: StackObject): StackObject {
  if (o.kind === 'trigger') {
    return {
      kind: 'trigger',
      instanceId: o.instanceId,
      sourceInstanceId: o.sourceInstanceId,
      controller: o.controller,
      effects: o.effects.map((e) => ({ ...e })),
      targets: [...o.targets],
      label: o.label,
    };
  }
  return {
    kind: 'spell',
    instanceId: o.instanceId,
    card: cloneInstance(o.card),
    controller: o.controller,
    resolvesTo: o.resolvesTo,
    targets: [...o.targets],
  };
}

function cloneCombat(c: CombatState | null): CombatState | null {
  if (!c) return null;
  return {
    attackers: [...c.attackers],
    blocks: { ...c.blocks },
    attackersDeclared: c.attackersDeclared,
    blockersDeclared: c.blockersDeclared,
  };
}

/**
 * Deep-copy a parked choice. Choices are treated as immutable once raised, so this
 * is only about breaking ALIASING: after a clone, nothing the caller still holds
 * can observe (or be observed through) the copy's arrays.
 */
function clonePendingChoice(choice: PendingChoice): PendingChoice {
  switch (choice.kind) {
    case 'selectCards':
      return { ...choice, candidates: choice.candidates.map((c) => ({ ...c })) };
    case 'selectPlayers':
      return { ...choice, candidates: [...choice.candidates] };
    case 'chooseModes':
      return { ...choice, modes: choice.modes.map((m) => ({ ...m })) };
    case 'payMana':
      return { ...choice, cost: { ...choice.cost } };
    default:
      return { ...choice };
  }
}

/** Deep-copy a suspended resolution, including the card caught mid-resolution. */
function cloneResolution(frame: ResolutionFrame): ResolutionFrame {
  return {
    ...frame,
    effects: frame.effects.map((e) => ({ ...e })),
    answers: frame.answers.map(cloneChoiceAnswer),
    ...(frame.card ? { card: cloneInstance(frame.card) } : {}),
  };
}

/**
 * Copy one continuous effect. Hoisted to module scope rather than written inline
 * as an arrow inside `cloneState`: an arrow in the hot function is re-created on
 * every call, and this one runs on every clone whether or not any effect exists.
 */
function cloneContinuousEffect(effect: ContinuousEffect): ContinuousEffect {
  return { ...effect, keywords: effect.keywords ? { ...effect.keywords } : undefined };
}

/** Deep-clone the mutable parts of a GameState; share immutable card defs. */
export function cloneState(state: GameState): GameState {
  const players = {} as Record<PlayerId, PlayerState>;
  for (const id of PLAYER_IDS) {
    players[id] = clonePlayer(state.players[id]);
  }
  const next: GameState = {
    nextInstanceId: state.nextInstanceId,
    turnNumber: state.turnNumber,
    activePlayer: state.activePlayer,
    priorityPlayer: state.priorityPlayer,
    step: state.step,
    players,
    battlefield: cloneInstances(state.battlefield),
    stack: state.stack.map(cloneStackObject),
    continuous: state.continuous.map(cloneContinuousEffect),
    combat: cloneCombat(state.combat),
    winner: state.winner,
    gameOver: state.gameOver,
    consecutivePasses: state.consecutivePasses,
    seed: state.seed,
    rngState: state.rngState,
  };
  // Only pay for the choice machinery when a choice is actually in flight — the
  // overwhelming majority of clones (every action of every sim game) see two null
  // checks and nothing else. Assigned rather than conditionally spread: spreading
  // `cond ? {...} : {}` allocated the empty object BOTH times, on every clone,
  // purely to add no properties. Key order is unchanged (these still land last),
  // which matters because a serialized state is compared field-for-field.
  if (state.pendingChoice) next.pendingChoice = clonePendingChoice(state.pendingChoice);
  if (state.resolution) next.resolution = cloneResolution(state.resolution);
  return next;
}
