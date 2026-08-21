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
import { pruneCardGrantsFor } from '../card-grants.js';
import { discardDestination } from '../madness.js';

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
  // A hand → graveyard move IS a discard (CR 701.8a), and madness replaces the
  // destination of a discard. Asked through the shared `discardDestination` so
  // this funnel and the cards package's `moveOwnedCard` cannot disagree about
  // where a discarded madness card ends up.
  const destination = from === 'hand' && to === 'graveyard' ? discardDestination(state, inst, emit) : to;
  removeFromCurrentZone(state, inst);
  inst.zone = destination;
  // CR 400.7: a card that changes zones is a new object, and a grant made on
  // the old object (a granted flashback on a graveyard card) does not follow
  // it. One property read when no grant exists — see card-grants.ts.
  pruneCardGrantsFor(state, inst.instanceId);
  if (destination === 'battlefield') {
    state.battlefield.push(inst);
  } else {
    // A madness-diverted card goes to its OWNER's exile, never to a `toPlayer`
    // the caller named for the graveyard it no longer reaches.
    const holder = state.players[destination === to ? (toPlayer ?? inst.owner) : inst.owner];
    const arr = playerZone(holder, destination);
    if (arr) arr.push(inst);
  }
  emit({ type: 'zoneChange', instanceId: inst.instanceId, from, to: destination });
  ceaseToExistIfToken(state, inst, emit);
}

/**
 * CR 704.5d — a TOKEN that has left the battlefield **ceases to exist**. Returns
 * whether the object was removed from the game.
 *
 * Call it immediately AFTER emitting the `zoneChange` that moved the object, and
 * that order is the whole contract: every "dies" / "leaves the battlefield"
 * trigger in this engine is matched against that event, so a token's death fires
 * exactly what a card's death fires. Only then does the object stop existing.
 *
 * Done at the MOVE rather than as a pass inside `checkStateBasedActions`, which
 * is where the rule formally lives: the SBA form would have to walk both
 * players' graveyards, exiles, hands and libraries on every SBA check — after
 * every resolution, every draw and every combat-damage step — hunting for
 * something that is nearly never there. Here it is ONE property read on a path
 * that already knows exactly which object moved. The only observable difference
 * would be a reader looking into a graveyard between the move and the next SBA
 * pass, and nothing in this engine reads a graveyard in that window.
 *
 * Shared by BOTH leave-the-battlefield funnels — core's {@link moveToZone} and
 * the cards package's `movePermanentTo` — for the reason those two funnels exist
 * at all: a rule implemented in one of them and not the other is a rule that
 * depends on which primitive killed the creature.
 *
 * Without it a dead token sat in its owner's graveyard for the rest of the game,
 * inflating every graveyard count the engine derives (a Tarmogoyf's card-type
 * box, "for each creature card in your graveyard") and standing there as a legal
 * target for anything that returns a creature CARD.
 */
export function ceaseToExistIfToken(
  state: GameState,
  inst: CardInstance,
  emit: (e: GameEvent) => void,
): boolean {
  if (inst.zone === 'battlefield' || inst.def.isToken !== true) return false;
  removeFromCurrentZone(state, inst);
  emit({
    type: 'tokenCeasedToExist',
    instanceId: inst.instanceId,
    name: inst.def.name,
    zone: inst.zone,
  });
  return true;
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
  // How the SPELL was kicked is a fact about that announcement, and CR 400.7
  // makes a permanent leaving the battlefield a new object — so a bounced-and-
  // recast creature is kicked (or not) by its own new cast, never by its last
  // one. Same shape-guard as `attachedTo`.
  if (inst.timesKicked !== undefined) delete inst.timesKicked;
  // The value named AS this permanent entered (CR 614.1c) is a fact about THAT
  // entry, and CR 400.7 makes the card a new object the moment it leaves — so a
  // bounced-and-recast Adaptive Automaton names a type again rather than still
  // lording over the one it named last time. Same shape-guard as `attachedTo`.
  if (inst.chosenAsEntered !== undefined) delete inst.chosenAsEntered;
  // CR 712.8a: a double-faced card is front-face-up everywhere except the
  // battlefield, so a TRANSFORMED permanent that leaves (dies, bounces, exiles)
  // reverts to its printed front face here — the same single chokepoint that
  // clears the rest of its battlefield-only state. A bounced Delver is a 1/1
  // Delver of Secrets in hand, never a 3/2 Aberration.
  if (inst.printedDef != null) {
    inst.def = inst.printedDef;
    inst.printedDef = null;
  }
  // CR 707 + CR 400.7: a copy effect applies to the PERMANENT, and a permanent
  // that changes zones is a new object — so a Clone that dies, bounces or is
  // exiled stops being what it copied. Restored AFTER the face revert above and
  // not instead of it: the two answer different questions ("which face" vs
  // "which card"), and a copy of a DFC that had transformed carries both.
  if (inst.uncopiedDef != null) {
    inst.def = inst.uncopiedDef;
    inst.uncopiedDef = null;
  }
}
