/**
 * Transforming double-faced cards (CR 701.28, 712) — the "which face is up"
 * seam.
 *
 * A transforming DFC is ONE definition whose front face nests its back face
 * (`CardDefinition.backFace`); which face is up is per-permanent state, held as
 * the instance's `def` (the active face) plus `printedDef` (the front to revert
 * to). Transforming swaps `def`, and because every consumer in the codebase
 * already reads characteristics through `inst.def`, the swap IS the routing:
 * combat sees the new P/T, targeting the new types, the trigger collector the
 * new face's triggers, the AI the new evaluation, the renderer the new art id.
 *
 * What transforming is NOT (CR 712.8): a zone change. The permanent keeps its
 * instance identity — counters, marked damage, attachments, tapped state,
 * summoning sickness and every continuous effect pointing at it all persist,
 * and no `zoneChange` event is emitted, so ETB/leaves triggers cannot fire off
 * a transform. A transformed permanent that LEAVES the battlefield turns
 * front-face-up again (CR 712.8a) — that reset lives in
 * `resetInstanceForNewZone`, the one chokepoint every leave path already runs.
 */

import type { CardDefinition } from './card.js';
import type { CardInstance, GameState, InstanceId } from './state.js';
import type { GameEvent } from './events.js';
import { findOnBattlefield } from './internal/zones.js';

/** The face of a double-faced permanent that is currently up. */
export type FaceUp = 'front' | 'back';

/** Which face of its printed card this instance currently shows. */
export function faceUpOf(inst: CardInstance): FaceUp {
  return inst.def.isBackFace === true ? 'back' : 'front';
}

/**
 * The face this instance would transform INTO, or `undefined` when it is not a
 * transforming DFC (CR 701.28.2: such a permanent simply doesn't transform).
 */
export function transformTargetOf(inst: CardInstance): CardDefinition | undefined {
  if (inst.def.backFace) return inst.def.backFace;
  if (inst.def.isBackFace === true && inst.printedDef != null) return inst.printedDef;
  return undefined;
}

/**
 * Transform a battlefield permanent: swap its active face and say so in the
 * log. Returns `true` when the permanent actually transformed.
 *
 * Safe by construction rather than by caller discipline:
 *  - not on the battlefield, or not a transforming DFC → `false`, no event, no
 *    mutation (CR 701.28.2 — "nothing happens", never a crash);
 *  - everything per-object (counters, damage, attachments, tapped, sickness,
 *    continuous effects) is deliberately untouched — transforming is not a
 *    zone change, so nothing resets and no `zoneChange` is emitted.
 */
export function transformPermanent(
  state: GameState,
  instanceId: InstanceId,
  emit: (e: GameEvent) => void,
): boolean {
  const inst = findOnBattlefield(state, instanceId);
  if (!inst) return false;
  const fromName = inst.def.name;
  if (inst.def.backFace) {
    // Front → back. Remember the printed front so the card can turn back —
    // both for a future "transform again" and for the leave-the-battlefield
    // reset that CR 712.8a requires.
    inst.printedDef = inst.def;
    inst.def = inst.def.backFace;
  } else if (inst.def.isBackFace === true && inst.printedDef != null) {
    // Back → front (a werewolf turning back). `printedDef` is cleared (not
    // deleted — the property keeps its slot, mirroring `attachedTo`'s shape
    // discipline) because the card is now exactly its printed self again.
    inst.def = inst.printedDef;
    inst.printedDef = null;
  } else {
    return false; // not a transforming DFC — nothing happens (CR 701.28.2)
  }
  emit({
    type: 'transformed',
    instanceId,
    fromName,
    toName: inst.def.name,
    faceUp: faceUpOf(inst),
  });
  return true;
}
