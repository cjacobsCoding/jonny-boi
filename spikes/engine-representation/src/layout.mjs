/**
 * THE FLAT LAYOUT — one contiguous Int32Array holding the entire game state.
 *
 * Arms B (TypeScript) and C (AssemblyScript→WASM) both address the state through
 * these offsets, so a difference between them can only come from the RUNTIME. To
 * make that guarantee mechanical rather than a promise, `codegen-layout.mjs` emits
 * `assembly/layout.ts` from this file — the two can never drift, because there is
 * only one source.
 *
 * Design notes that are load-bearing:
 *
 *  - **Struct-of-arrays, not array-of-structs.** Every per-instance field is its
 *    own column of `MAX_INSTANCES` entries. The hot loops (`generateLegalActions`,
 *    the SBA scan, the continuous-effect layering) each read one or two fields
 *    across many instances, so a column layout touches a handful of cache lines
 *    where an interleaved layout would touch one per instance.
 *  - **Fixed capacities, no growth.** The model creates every instance up front
 *    (no tokens), so instance ids are stable for a whole game and every zone is a
 *    fixed-capacity list plus a count. Nothing in the hot path allocates.
 *  - **Zones are ordered lists of ids.** Library order is the shuffle and must be
 *    preserved exactly, so zones cannot be sets or bitmasks. A `zone` column on the
 *    instance is kept alongside as the O(1) "where is this card" answer, exactly as
 *    `CardInstance.zone` is in the real engine.
 */

import {
  CAP_BATTLEFIELD,
  CAP_COMBAT,
  CAP_CONTINUOUS,
  CAP_GRAVEYARD,
  CAP_HAND,
  CAP_LIBRARY,
  CAP_STACK,
  MAX_INSTANCES,
  NUM_PLAYERS,
  POOL_SLOTS,
} from './spec.mjs';

let cursor = 0;
/** Reserve `n` i32 slots and return the base offset. */
function reserve(n) {
  const base = cursor;
  cursor += n;
  return base;
}

// --- game scalars -------------------------------------------------------------------
export const S_TURN = reserve(1);
export const S_ACTIVE = reserve(1);
export const S_PRIORITY = reserve(1);
export const S_STEP = reserve(1);
export const S_WINNER = reserve(1);
export const S_GAME_OVER = reserve(1);
export const S_PASSES = reserve(1);
export const S_RNG = reserve(1);
export const S_COMBAT_ACTIVE = reserve(1);
export const S_ATTACKERS_DECLARED = reserve(1);
export const S_BLOCKERS_DECLARED = reserve(1);
export const S_STACK_COUNT = reserve(1);
export const S_BF_COUNT = reserve(1);
export const S_CONT_COUNT = reserve(1);
export const S_ATTACKER_COUNT = reserve(1);
export const S_BLOCK_COUNT = reserve(1);

// --- per-player block ----------------------------------------------------------------
export const PLAYER_STRIDE = 3 + POOL_SLOTS + 3;
export const P_LIFE = 0;
export const P_LANDS_PLAYED = 1;
export const P_HAS_LOST = 2;
export const P_POOL = 3;
export const P_LIB_COUNT = P_POOL + POOL_SLOTS;
export const P_HAND_COUNT = P_LIB_COUNT + 1;
export const P_GY_COUNT = P_HAND_COUNT + 1;
export const PLAYERS_BASE = reserve(PLAYER_STRIDE * NUM_PLAYERS);

// --- per-instance columns (struct of arrays) -------------------------------------------
export const I_DEF = reserve(MAX_INSTANCES);
export const I_OWNER = reserve(MAX_INSTANCES);
export const I_CONTROLLER = reserve(MAX_INSTANCES);
export const I_ZONE = reserve(MAX_INSTANCES);
export const I_TAPPED = reserve(MAX_INSTANCES);
export const I_SICK = reserve(MAX_INSTANCES);
export const I_DAMAGE = reserve(MAX_INSTANCES);
export const I_DEATHTOUCHED = reserve(MAX_INSTANCES);

// --- ordered zone lists ------------------------------------------------------------------
export const LIB_BASE = reserve(CAP_LIBRARY * NUM_PLAYERS);
export const LIB_STRIDE = CAP_LIBRARY;
export const HAND_BASE = reserve(CAP_HAND * NUM_PLAYERS);
export const HAND_STRIDE = CAP_HAND;
export const GY_BASE = reserve(CAP_GRAVEYARD * NUM_PLAYERS);
export const GY_STRIDE = CAP_GRAVEYARD;
export const BF_BASE = reserve(CAP_BATTLEFIELD);

// --- the stack (columns) -------------------------------------------------------------------
export const STK_CARD = reserve(CAP_STACK);
export const STK_CONTROLLER = reserve(CAP_STACK);
export const STK_TARGET = reserve(CAP_STACK);

// --- until-end-of-turn continuous effects (columns) --------------------------------------------
export const CONT_TARGET = reserve(CAP_CONTINUOUS);
export const CONT_DPOWER = reserve(CAP_CONTINUOUS);
export const CONT_DTOUGH = reserve(CAP_CONTINUOUS);

// --- combat --------------------------------------------------------------------------------
export const ATK_LIST = reserve(CAP_COMBAT);
export const BLK_LIST = reserve(CAP_COMBAT);
export const BLK_OF = reserve(CAP_COMBAT);

/** Total arena size in i32 slots. */
export const ARENA_SIZE = cursor;

/** Zone tags stored in the {@link I_ZONE} column. */
export const ZONE_LIBRARY = 0;
export const ZONE_HAND = 1;
export const ZONE_BATTLEFIELD = 2;
export const ZONE_GRAVEYARD = 3;
export const ZONE_STACK = 4;

/** Undo-journal capacity — deep enough for the deepest rollout the bench runs. */
export const CAP_JOURNAL = 1 << 18;

/** The names emitted into the AssemblyScript mirror. Order is irrelevant; presence is not. */
export const EXPORTED_CONSTANTS = {
  S_TURN,
  S_ACTIVE,
  S_PRIORITY,
  S_STEP,
  S_WINNER,
  S_GAME_OVER,
  S_PASSES,
  S_RNG,
  S_COMBAT_ACTIVE,
  S_ATTACKERS_DECLARED,
  S_BLOCKERS_DECLARED,
  S_STACK_COUNT,
  S_BF_COUNT,
  S_CONT_COUNT,
  S_ATTACKER_COUNT,
  S_BLOCK_COUNT,
  PLAYER_STRIDE,
  P_LIFE,
  P_LANDS_PLAYED,
  P_HAS_LOST,
  P_POOL,
  P_LIB_COUNT,
  P_HAND_COUNT,
  P_GY_COUNT,
  PLAYERS_BASE,
  I_DEF,
  I_OWNER,
  I_CONTROLLER,
  I_ZONE,
  I_TAPPED,
  I_SICK,
  I_DAMAGE,
  I_DEATHTOUCHED,
  LIB_BASE,
  LIB_STRIDE,
  HAND_BASE,
  HAND_STRIDE,
  GY_BASE,
  GY_STRIDE,
  BF_BASE,
  STK_CARD,
  STK_CONTROLLER,
  STK_TARGET,
  CONT_TARGET,
  CONT_DPOWER,
  CONT_DTOUGH,
  ATK_LIST,
  BLK_LIST,
  BLK_OF,
  ARENA_SIZE,
  ZONE_LIBRARY,
  ZONE_HAND,
  ZONE_BATTLEFIELD,
  ZONE_GRAVEYARD,
  ZONE_STACK,
  CAP_JOURNAL,
};
