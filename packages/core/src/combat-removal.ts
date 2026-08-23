/**
 * CR 506.4 — REMOVAL FROM COMBAT, for the one case the engine cannot see.
 *
 * A combat participant is identified by its instance id: `combat.attackers` is a
 * list of ids and `combat.blocks` maps a blocker id to the attacker it blocks.
 * Nearly every way a creature leaves combat also takes its id off the
 * battlefield — it died, it was bounced, it was exiled — and every read in
 * `internal/combat.ts` resolves an id through `findOnBattlefield`, so those cases
 * are handled for free by the id simply not being there any more.
 *
 * A BLINK is the exception, and it is the reason this module exists. "Exile
 * target creature you control, then return that card to the battlefield" puts
 * the SAME instance id straight back (a card keeps its identity across the
 * blink, so every id-keyed reference in the state stays sound). CR 400.7 makes
 * what returns a NEW OBJECT that is not attacking and not blocking — but the
 * id-based reads cannot tell it from the object that left, so without this the
 * blinked attacker still connects for its full damage AND comes back untapped:
 * strictly better than the printed card.
 *
 * ⚠️ The declared lists are deliberately NOT rewritten. `attackers` and `blocks`
 * are the DECLARATION — a historical fact the damage step reads other rules off.
 * "Was this attacker blocked?" is answered from `blocks` alone (CR 509.1h: an
 * attacker whose blocker leaves stays blocked and still deals no damage to the
 * player), so deleting a removed blocker's entry would silently promote its
 * attacker to unblocked. `removedFromCombat` is a live OVERLAY on that
 * declaration instead, and {@link attackingCreatureIds} is the one accessor every
 * attacker-side read goes through.
 */

import type { CombatState, InstanceId } from './state.js';

/**
 * Remove `id` from combat: it stops being an attacking, blocking, blocked and
 * unblocked creature (CR 506.4b). Idempotent, and a no-op for a permanent that
 * was never in this combat — both are ordinary, since the caller is a zone
 * change that has no idea whether the object was fighting.
 *
 * Allocates the overlay only when something is actually removed, so the field
 * stays absent for the overwhelming majority of combats (the same shape as
 * `attackTargets`).
 */
export function removeFromCombat(combat: CombatState | null, id: InstanceId): void {
  if (!combat) return;
  const wasAttacking = combat.attackers.includes(id);
  const wasBlocking = combat.blocks[id] !== undefined;
  if (!wasAttacking && !wasBlocking) return;
  const removed = (combat.removedFromCombat ??= []);
  if (!removed.includes(id)) removed.push(id);
}

/** Has `id` been removed from this combat? */
export function isRemovedFromCombat(combat: CombatState | null, id: InstanceId): boolean {
  const removed = combat?.removedFromCombat;
  if (removed === undefined || removed.length === 0) return false;
  return removed.includes(id);
}

/**
 * The ids still attacking — the declaration minus anything removed from combat.
 *
 * Returns the declared array ITSELF when nothing has been removed, which is
 * every combat in nearly every game: this is read on the combat-damage hot path
 * and must not allocate to say "nothing changed".
 */
export function attackingCreatureIds(combat: CombatState): readonly InstanceId[] {
  const removed = combat.removedFromCombat;
  if (removed === undefined || removed.length === 0) return combat.attackers;
  return combat.attackers.filter((id) => !removed.includes(id));
}
