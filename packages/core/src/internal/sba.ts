/**
 * State-based actions (SBAs). Checked at the right times (after each resolution,
 * after combat damage, on priority). They are not actions players take — the game
 * performs them automatically. MVP set:
 *   - A creature with lethal marked damage or ≤0 toughness is destroyed.
 *   - A player at ≤0 life loses.
 *   - A player who attempted to draw from an empty library loses (flagged at draw).
 *
 * SBAs loop until none apply (one death can't currently cascade, but the loop
 * keeps the contract correct as effects grow).
 */

import type { GameState, PlayerId } from '../state.js';
import { PLAYER_IDS } from '../state.js';
import type { GameEvent } from '../events.js';
import { isCreature } from '../card.js';
import { effectiveToughness, remainingToughness } from './stats.js';
import { moveToZone, resetInstanceForNewZone } from './zones.js';
import { indexContinuous, NO_MOD, pruneOrphanContinuousEffects } from './continuous.js';

/** Run all pending SBAs until a fixpoint. Mutates the draft; emits events. */
export function checkStateBasedActions(state: GameState, emit: (e: GameEvent) => void): void {
  let changed = true;
  while (changed && !state.gameOver) {
    changed = false;

    // Effective toughness/damage are read through the continuous layer so an
    // until-EOT pump that raises toughness keeps a creature alive, and a negative
    // buff can be lethal. Rebuilt each fixpoint pass (effects can change between).
    const index = indexContinuous(state);

    // Creature death: lethal damage or non-positive toughness.
    for (const inst of [...state.battlefield]) {
      if (!isCreature(inst.def)) continue;
      const mod = index.get(inst.instanceId) ?? NO_MOD;
      const dead =
        effectiveToughness(inst, mod) <= 0 ||
        remainingToughness(inst, mod) <= 0 ||
        (inst.markedByDeathtouch && inst.damageMarked > 0);
      if (dead) {
        emit({ type: 'creatureDied', instanceId: inst.instanceId, name: inst.def.name });
        moveToZone(state, inst, 'graveyard', emit, inst.owner);
        resetInstanceForNewZone(inst);
        changed = true;
      }
    }

    // Player loss by life total.
    for (const pid of PLAYER_IDS) {
      const p = state.players[pid];
      if (!p.hasLost && p.life <= 0) {
        loseGame(state, pid, 'life total 0 or less', emit);
        changed = true;
      }
    }

    // If exactly one player remains, the other wins.
    if (resolveWinner(state, emit)) changed = true;
  }

  // A temporary modification only exists while its permanent is on the battlefield.
  // Dropping orphans only at cleanup left a window in which a permanent could leave
  // (die, be bounced) and COME BACK inside the same turn still carrying its old
  // "until end of turn" pump — a re-cast 2/2 read as a 5/5. SBAs run at every point
  // a permanent can have just changed zones, so this is the right place to let go.
  pruneOrphanContinuousEffects(state);
}

/** Mark a player as having lost, emitting the event. */
export function loseGame(state: GameState, player: PlayerId, reason: string, emit: (e: GameEvent) => void): void {
  const p = state.players[player];
  if (p.hasLost) return;
  p.hasLost = true;
  emit({ type: 'playerLost', player, reason });
}

/** If the game is decided, set winner/gameOver. Returns true if it changed. */
export function resolveWinner(state: GameState, emit: (e: GameEvent) => void): boolean {
  if (state.gameOver) return false;
  const alive = PLAYER_IDS.filter((pid) => !state.players[pid].hasLost);
  if (alive.length <= 1) {
    const winner = alive.length === 1 ? (alive[0] as PlayerId) : null;
    state.winner = winner;
    state.gameOver = true;
    emit({ type: 'gameOver', winner });
    return true;
  }
  return false;
}
