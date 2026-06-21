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
import { PLAYER_IDS } from '../state.js';

function cloneInstance(inst: CardInstance): CardInstance {
  return {
    instanceId: inst.instanceId,
    def: inst.def, // immutable — shared by reference
    controller: inst.controller,
    owner: inst.owner,
    zone: inst.zone,
    tapped: inst.tapped,
    summoningSick: inst.summoningSick,
    damageMarked: inst.damageMarked,
    markedByDeathtouch: inst.markedByDeathtouch,
    counters: { ...inst.counters },
  };
}

function cloneInstances(list: readonly CardInstance[]): CardInstance[] {
  return list.map(cloneInstance);
}

function clonePlayer(p: PlayerState): PlayerState {
  return {
    id: p.id,
    life: p.life,
    manaPool: { ...p.manaPool },
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
  return { attackers: [...c.attackers], blocks: { ...c.blocks } };
}

/** Deep-clone the mutable parts of a GameState; share immutable card defs. */
export function cloneState(state: GameState): GameState {
  const players = {} as Record<PlayerId, PlayerState>;
  for (const id of PLAYER_IDS) {
    players[id] = clonePlayer(state.players[id]);
  }
  return {
    nextInstanceId: state.nextInstanceId,
    turnNumber: state.turnNumber,
    activePlayer: state.activePlayer,
    priorityPlayer: state.priorityPlayer,
    step: state.step,
    players,
    battlefield: cloneInstances(state.battlefield),
    stack: state.stack.map(cloneStackObject),
    continuous: state.continuous.map((e) => ({ ...e, keywords: e.keywords ? { ...e.keywords } : undefined })),
    combat: cloneCombat(state.combat),
    winner: state.winner,
    gameOver: state.gameOver,
    consecutivePasses: state.consecutivePasses,
    seed: state.seed,
    rngState: state.rngState,
  };
}
