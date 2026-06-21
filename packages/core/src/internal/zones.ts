/**
 * Zone-movement helpers operating on a draft GameState. A card instance lives in
 * exactly one zone; moving it removes it from its old zone array and appends to
 * the new one, updates `instance.zone`, and emits a `zoneChange` event. The
 * battlefield is a shared (non-per-player) array; per-player zones are addressed
 * through the controlling/owning player.
 */

import type { CardInstance, GameState, InstanceId, PlayerId, ZoneName } from '../state.js';
import { playerZone, PLAYER_IDS } from '../state.js';
import type { GameEvent } from '../events.js';

/** Find a battlefield permanent by id, or undefined. */
export function findOnBattlefield(state: GameState, id: InstanceId): CardInstance | undefined {
  return state.battlefield.find((c) => c.instanceId === id);
}

/** Find an instance anywhere (battlefield, any player zone, stack), or undefined. */
export function findInstance(state: GameState, id: InstanceId): CardInstance | undefined {
  const bf = findOnBattlefield(state, id);
  if (bf) return bf;
  for (const pid of PLAYER_IDS) {
    const p = state.players[pid];
    for (const zone of [p.library, p.hand, p.graveyard, p.exile, p.command]) {
      const found = zone.find((c) => c.instanceId === id);
      if (found) return found;
    }
  }
  const onStack = state.stack.find((o) => o.instanceId === id);
  return onStack?.card;
}

/** Remove an instance from whatever owner-zone it currently sits in (not stack). */
function removeFromCurrentZone(state: GameState, inst: CardInstance): void {
  if (inst.zone === 'battlefield') {
    const idx = state.battlefield.findIndex((c) => c.instanceId === inst.instanceId);
    if (idx >= 0) state.battlefield.splice(idx, 1);
    return;
  }
  // Per-player zone: search both players' arrays for the zone (the owner holds
  // library/hand/grave/exile/command). Use the instance's owner first.
  const owner = state.players[inst.owner];
  const arr = playerZone(owner, inst.zone);
  if (arr) {
    const idx = arr.findIndex((c) => c.instanceId === inst.instanceId);
    if (idx >= 0) {
      arr.splice(idx, 1);
      return;
    }
  }
  // Fallback: scan every player's matching zone (defensive).
  for (const pid of PLAYER_IDS) {
    const z = playerZone(state.players[pid], inst.zone);
    if (!z) continue;
    const idx = z.findIndex((c) => c.instanceId === inst.instanceId);
    if (idx >= 0) {
      z.splice(idx, 1);
      return;
    }
  }
}

/**
 * Move an instance to a destination zone, emitting `zoneChange`. For per-player
 * destinations the card lands in the given `toPlayer` (defaults to its owner).
 * The stack is handled by the engine separately (stack objects, not raw zones).
 */
export function moveToZone(
  state: GameState,
  inst: CardInstance,
  to: ZoneName,
  emit: (e: GameEvent) => void,
  toPlayer?: PlayerId,
): void {
  const from = inst.zone;
  removeFromCurrentZone(state, inst);
  inst.zone = to;
  if (to === 'battlefield') {
    state.battlefield.push(inst);
  } else {
    const holder = state.players[toPlayer ?? inst.owner];
    const arr = playerZone(holder, to);
    if (arr) arr.push(inst);
  }
  emit({ type: 'zoneChange', instanceId: inst.instanceId, from, to });
}

/**
 * Reset a permanent's per-object combat/temporary state when it leaves the
 * battlefield (so it re-enters clean). Counters persist only while on field.
 */
export function resetInstanceForNewZone(inst: CardInstance): void {
  inst.tapped = false;
  inst.damageMarked = 0;
  inst.markedByDeathtouch = false;
  inst.summoningSick = false;
  inst.counters = {};
}
