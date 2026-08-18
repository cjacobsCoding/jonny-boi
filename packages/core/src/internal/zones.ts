/**
 * Zone-movement helpers operating on a draft GameState. A card instance lives in
 * exactly one zone; moving it removes it from its old zone array and appends to
 * the new one, updates `instance.zone`, and emits a `zoneChange` event. The
 * battlefield is a shared (non-per-player) array; per-player zones are addressed
 * through the controlling/owning player.
 */

import type { CardInstance, GameState, InstanceId, PlayerId, ZoneName } from '../state.js';
import { NO_COUNTERS, playerZone, PLAYER_IDS } from '../state.js';
import type { GameEvent } from '../events.js';

/**
 * Find a battlefield permanent by id, or undefined.
 *
 * An indexed loop rather than `Array.find`: the predicate closes over `id`, and
 * this is one of the most-called functions in the engine — every tap, every
 * activation, every attacker and blocker in every combat, several times per
 * action. That was a closure allocation per lookup, for a scan of a few items.
 * The same reasoning applies to the id searches below.
 */
export function findOnBattlefield(state: GameState, id: InstanceId): CardInstance | undefined {
  const battlefield = state.battlefield;
  for (let i = 0; i < battlefield.length; i++) {
    const perm = battlefield[i] as CardInstance;
    if (perm.instanceId === id) return perm;
  }
  return undefined;
}

/** The instance with this id in a zone array, or undefined. */
function at(zone: readonly CardInstance[], id: InstanceId): CardInstance | undefined {
  const idx = indexOfInstance(zone, id);
  return idx >= 0 ? (zone[idx] as CardInstance) : undefined;
}

/** Index of an instance in a zone array, or -1. */
function indexOfInstance(zone: readonly CardInstance[], id: InstanceId): number {
  for (let i = 0; i < zone.length; i++) {
    if ((zone[i] as CardInstance).instanceId === id) return i;
  }
  return -1;
}

/** Find an instance anywhere (battlefield, any player zone, stack), or undefined. */
export function findInstance(state: GameState, id: InstanceId): CardInstance | undefined {
  const bf = findOnBattlefield(state, id);
  if (bf) return bf;
  // Zones checked one at a time rather than through a `[lib, hand, ...]` literal:
  // that array (and the closure handed to `find`) was allocated per player on every
  // lookup, and the first zone usually answers.
  for (const pid of PLAYER_IDS) {
    const p = state.players[pid];
    const found =
      at(p.library, id) ?? at(p.hand, id) ?? at(p.graveyard, id) ?? at(p.exile, id) ?? at(p.command, id);
    if (found) return found;
  }
  for (const o of state.stack) {
    if (o.kind === 'spell' && o.card.instanceId === id) return o.card;
  }
  return undefined;
}

/** Remove an instance from whatever owner-zone it currently sits in (not stack). */
function removeFromCurrentZone(state: GameState, inst: CardInstance): void {
  if (inst.zone === 'battlefield') {
    const idx = indexOfInstance(state.battlefield, inst.instanceId);
    if (idx >= 0) state.battlefield.splice(idx, 1);
    return;
  }
  // Per-player zone: search both players' arrays for the zone (the owner holds
  // library/hand/grave/exile/command). Use the instance's owner first.
  const owner = state.players[inst.owner];
  const arr = playerZone(owner, inst.zone);
  if (arr) {
    const idx = indexOfInstance(arr, inst.instanceId);
    if (idx >= 0) {
      arr.splice(idx, 1);
      return;
    }
  }
  // Fallback: scan every player's matching zone (defensive).
  for (const pid of PLAYER_IDS) {
    const z = playerZone(state.players[pid], inst.zone);
    if (!z) continue;
    const idx = indexOfInstance(z, inst.instanceId);
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
  inst.counters = NO_COUNTERS;
  // An attachment that leaves the battlefield is attached to nothing — and so is a
  // card that re-enters later. Clearing it HERE (rather than only in the
  // state-based action) is what stops a bounced-and-recast Aura from arriving
  // still pointing at a creature it no longer enchants.
  //
  // Guarded so an instance that never carried the field does not GAIN it here: this
  // runs for every spell that resolves to a graveyard and every creature that dies,
  // and adding the property would migrate most of the game's instances onto a
  // second object shape that `cloneInstance` then has to copy (see clone.ts).
  if (inst.attachedTo != null) inst.attachedTo = null;
  // A permanent that changes zones becomes a NEW object (CR 400.7), so a walker
  // bounced and replayed in one turn may activate again — the once-per-turn
  // marker does not survive the move. Same shape-guard as `attachedTo`.
  if (inst.loyaltyActivatedTurn !== undefined) delete inst.loyaltyActivatedTurn;
}
