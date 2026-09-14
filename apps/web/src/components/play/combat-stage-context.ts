/**
 * WHICH PERMANENTS ARE OUT ON THE COMBAT STAGE (UX-12 / UX-13).
 *
 * A context rather than a prop, for one hard reason: the tile is rendered by
 * `SeatPanel`, which is owned by no lane in this run and whose `PermInteraction`
 * seam has no field for it. Threading a prop through would mean editing another
 * lane's file to carry a fact that is not an interaction — so the board
 * PROVIDES the set and `BoardPermanentTile` CONSUMES it, which is the
 * "registry entry + context seam" shape CLAUDE.md rule 3 already names.
 *
 * The default is the shared empty set, so every other surface that mounts a tile
 * (the replay board, the effects bench, a test) behaves exactly as before with
 * no provider at all.
 *
 * Its own module, not `CombatStage.tsx`, because that file imports the tile and
 * the tile would then import it back.
 */
import { createContext, useContext } from 'react';
import type { InstanceId } from '@jonny-boi/core';

/** Shared, so a board with no combat allocates nothing to say so. */
export const NO_STAGED_PERMANENTS: ReadonlySet<InstanceId> = Object.freeze(new Set<InstanceId>());

export const StagedPermanentsContext =
  createContext<ReadonlySet<InstanceId>>(NO_STAGED_PERMANENTS);

/** True when this permanent's card is currently painted on the combat stage. */
export function useIsStaged(instanceId: InstanceId): boolean {
  return useContext(StagedPermanentsContext).has(instanceId);
}
