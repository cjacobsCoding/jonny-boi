/**
 * The flat state layout done PROPERLY: one contiguous `Int32Array` arena for the
 * whole mutable world, so a clone is one allocation and one memcpy.
 *
 * ## Why this file exists on top of `flat-state.ts`
 * The first flat mirror kept each column in its own typed array — eight columns
 * plus twelve zone lists plus the battlefield, twenty-three arrays in total — and
 * measured *slower* than the shipped object clone (0.53×). That is a real result
 * and it is kept in the repo, because it is the trap: "typed arrays" is not the
 * optimisation, ONE ALLOCATION is. Twenty-three small `slice()` calls pay the
 * allocator twenty-three times for 122 cards' worth of data, and lose to a deep
 * copy that at least allocates in one nursery burst.
 *
 * Here every column and every zone list lives at a fixed offset inside a single
 * buffer, packed to a high-water mark, so `clone()` is `buf.slice(0, used)`:
 * one allocation, one `memcpy` of ~4.6 KB, nothing for the GC to trace inside it.
 *
 * ## Layout (i32 words)
 *   [0..11]    scalars: turn, active, priority, nextInstanceId, rngState, passes,
 *              lifeA, lifeB, landsA, landsB, gameOver, winner
 *   [12..23]   mana pools: A's six colours then B's
 *   [24..35]   zone lengths, indexed player*6 + zone
 *   [36]       battlefield length
 *   [37..]     eight per-instance columns, each `capacity` words long
 *   then       each player's zone lists (slot indices, in engine order), packed
 *   then       the shared battlefield order
 *
 * Definitions are referenced through an index into an immutable table and never
 * copied — exactly what `cloneState` already does with `def`.
 *
 * ## What this is NOT
 * Not a working flat engine — no rules run against it. It is a faithful mirror
 * plus the clone, which is the operation the profile says costs 27.2%.
 * `fromArenaState` proves it lossless so the comparison cannot be flattered.
 */

import type { CardDefinition, CardInstance, GameState, PlayerId, ZoneName } from '@jonny-boi/core';
import { MANA_COLORS, PLAYER_IDS } from '@jonny-boi/core';

/** Zone codes. Order is the layout; battlefield is a shared list, not a player zone. */
export const PLAYER_ZONES: readonly ZoneName[] = ['library', 'hand', 'graveyard', 'exile', 'command'];
const ZONE_SLOTS = 6;

const SCALARS_AT = 0;
const POOLS_AT = 12;
const ZONE_LENS_AT = 24;
const BF_LEN_AT = 36;
const COLUMNS_AT = 37;

/** The eight per-instance columns, in layout order. */
const COL_INSTANCE_ID = 0;
const COL_DEF = 1;
const COL_CONTROLLER = 2;
const COL_OWNER = 3;
const COL_ZONE = 4;
const COL_FLAGS = 5;
const COL_DAMAGE = 6;
const COL_PLUS = 7;
const COLUMN_COUNT = 8;

const FLAG_TAPPED = 1;
const FLAG_SUMMONING_SICK = 2;
const FLAG_DEATHTOUCHED = 4;

/** The only counter kind the engine reads (`internal/stats.ts`), so it is a column. */
const PLUS_ONE = '+1/+1';

/** Offsets computed once per state shape; shared by every clone of it. */
export interface ArenaLayout {
  readonly capacity: number;
  /** Start of each player's zone-list block, indexed player*6 + zone. */
  readonly zoneAt: Int32Array;
  readonly battlefieldAt: number;
  readonly used: number;
}

export interface ArenaState {
  readonly buf: Int32Array;
  readonly layout: ArenaLayout;
  readonly defs: readonly CardDefinition[];
}

function colAt(layout: ArenaLayout, col: number): number {
  return COLUMNS_AT + col * layout.capacity;
}

function flagsOf(inst: CardInstance): number {
  return (
    (inst.tapped ? FLAG_TAPPED : 0) |
    (inst.summoningSick ? FLAG_SUMMONING_SICK : 0) |
    (inst.markedByDeathtouch ? FLAG_DEATHTOUCHED : 0)
  );
}

/** Build the arena mirror of a live `GameState`. */
export function toArenaState(state: GameState): ArenaState {
  const defs: CardDefinition[] = [];
  const defIndexOf = new Map<CardDefinition, number>();
  const slotOf = new Map<number, number>();
  const all: CardInstance[] = [];

  const collect = (list: readonly CardInstance[]): void => {
    for (const inst of list) {
      if (slotOf.has(inst.instanceId)) continue;
      slotOf.set(inst.instanceId, all.length);
      all.push(inst);
    }
  };
  for (const p of PLAYER_IDS) {
    const pl = state.players[p];
    for (const zone of PLAYER_ZONES) collect(zoneListOf(pl, zone));
  }
  collect(state.battlefield);

  const capacity = all.length;
  const zoneAt = new Int32Array(PLAYER_IDS.length * ZONE_SLOTS);
  let cursor = COLUMNS_AT + COLUMN_COUNT * capacity;
  for (let pi = 0; pi < PLAYER_IDS.length; pi++) {
    const pl = state.players[PLAYER_IDS[pi] as PlayerId];
    for (let zi = 0; zi < PLAYER_ZONES.length; zi++) {
      zoneAt[pi * ZONE_SLOTS + zi] = cursor;
      cursor += zoneListOf(pl, PLAYER_ZONES[zi] as ZoneName).length;
    }
  }
  const battlefieldAt = cursor;
  cursor += state.battlefield.length;

  const layout: ArenaLayout = { capacity, zoneAt, battlefieldAt, used: cursor };
  const buf = new Int32Array(cursor);

  for (let i = 0; i < capacity; i++) {
    const inst = all[i] as CardInstance;
    let di = defIndexOf.get(inst.def);
    if (di === undefined) {
      di = defs.length;
      defs.push(inst.def);
      defIndexOf.set(inst.def, di);
    }
    buf[colAt(layout, COL_INSTANCE_ID) + i] = inst.instanceId;
    buf[colAt(layout, COL_DEF) + i] = di;
    buf[colAt(layout, COL_CONTROLLER) + i] = inst.controller === 'A' ? 0 : 1;
    buf[colAt(layout, COL_OWNER) + i] = inst.owner === 'A' ? 0 : 1;
    buf[colAt(layout, COL_ZONE) + i] = inst.zone === 'battlefield' ? ZONE_SLOTS - 1 : PLAYER_ZONES.indexOf(inst.zone);
    buf[colAt(layout, COL_FLAGS) + i] = flagsOf(inst);
    buf[colAt(layout, COL_DAMAGE) + i] = inst.damageMarked;
    buf[colAt(layout, COL_PLUS) + i] = inst.counters[PLUS_ONE] ?? 0;
  }

  for (let pi = 0; pi < PLAYER_IDS.length; pi++) {
    const p = PLAYER_IDS[pi] as PlayerId;
    const pl = state.players[p];
    for (let zi = 0; zi < PLAYER_ZONES.length; zi++) {
      const list = zoneListOf(pl, PLAYER_ZONES[zi] as ZoneName);
      buf[ZONE_LENS_AT + pi * ZONE_SLOTS + zi] = list.length;
      const at = zoneAt[pi * ZONE_SLOTS + zi] as number;
      for (let k = 0; k < list.length; k++) buf[at + k] = slotOf.get((list[k] as CardInstance).instanceId) as number;
    }
    for (let c = 0; c < MANA_COLORS.length; c++) {
      buf[POOLS_AT + pi * MANA_COLORS.length + c] = pl.manaPool[MANA_COLORS[c] as never];
    }
  }
  buf[BF_LEN_AT] = state.battlefield.length;
  for (let k = 0; k < state.battlefield.length; k++) {
    buf[battlefieldAt + k] = slotOf.get((state.battlefield[k] as CardInstance).instanceId) as number;
  }

  buf[SCALARS_AT + 0] = state.turnNumber;
  buf[SCALARS_AT + 1] = state.activePlayer === 'A' ? 0 : 1;
  buf[SCALARS_AT + 2] = state.priorityPlayer === 'A' ? 0 : 1;
  buf[SCALARS_AT + 3] = state.nextInstanceId;
  buf[SCALARS_AT + 4] = state.rngState | 0;
  buf[SCALARS_AT + 5] = state.consecutivePasses;
  buf[SCALARS_AT + 6] = state.players.A.life;
  buf[SCALARS_AT + 7] = state.players.B.life;
  buf[SCALARS_AT + 8] = state.players.A.landsPlayedThisTurn;
  buf[SCALARS_AT + 9] = state.players.B.landsPlayedThisTurn;
  buf[SCALARS_AT + 10] = state.gameOver ? 1 : 0;
  buf[SCALARS_AT + 11] = state.winner === null ? -1 : state.winner === 'A' ? 0 : 1;

  return { buf, layout, defs };
}

/**
 * The clone being priced: one allocation, one memcpy. The layout and the
 * definition table are immutable and shared, so nothing else is copied.
 */
export function cloneArenaState(s: ArenaState): ArenaState {
  return { buf: s.buf.slice(), layout: s.layout, defs: s.defs };
}

/** Rebuild a `GameState` from the arena, to prove the encoding is lossless. */
export function fromArenaState(s: ArenaState, template: GameState): GameState {
  const { buf, layout, defs } = s;
  const instances: CardInstance[] = new Array(layout.capacity);
  const idAt = colAt(layout, COL_INSTANCE_ID);
  const defAt = colAt(layout, COL_DEF);
  const ctrlAt = colAt(layout, COL_CONTROLLER);
  const ownAt = colAt(layout, COL_OWNER);
  const zoneAtCol = colAt(layout, COL_ZONE);
  const flagAt = colAt(layout, COL_FLAGS);
  const dmgAt = colAt(layout, COL_DAMAGE);
  const plusAt = colAt(layout, COL_PLUS);

  for (let i = 0; i < layout.capacity; i++) {
    const counters: Record<string, number> = {};
    const plus = buf[plusAt + i] as number;
    if (plus !== 0) counters[PLUS_ONE] = plus;
    const f = buf[flagAt + i] as number;
    const z = buf[zoneAtCol + i] as number;
    instances[i] = {
      instanceId: buf[idAt + i] as number,
      def: defs[buf[defAt + i] as number] as CardDefinition,
      controller: (buf[ctrlAt + i] === 0 ? 'A' : 'B') as PlayerId,
      owner: (buf[ownAt + i] === 0 ? 'A' : 'B') as PlayerId,
      zone: (z === ZONE_SLOTS - 1 ? 'battlefield' : PLAYER_ZONES[z]) as ZoneName,
      tapped: (f & FLAG_TAPPED) !== 0,
      summoningSick: (f & FLAG_SUMMONING_SICK) !== 0,
      damageMarked: buf[dmgAt + i] as number,
      markedByDeathtouch: (f & FLAG_DEATHTOUCHED) !== 0,
      counters,
    };
  }

  const players = {} as GameState['players'];
  for (let pi = 0; pi < PLAYER_IDS.length; pi++) {
    const p = PLAYER_IDS[pi] as PlayerId;
    const zoneList = (zi: number): CardInstance[] => {
      const at = layout.zoneAt[pi * ZONE_SLOTS + zi] as number;
      const len = buf[ZONE_LENS_AT + pi * ZONE_SLOTS + zi] as number;
      const out: CardInstance[] = new Array(len);
      for (let k = 0; k < len; k++) out[k] = instances[buf[at + k] as number] as CardInstance;
      return out;
    };
    const manaPool = {} as Record<string, number>;
    for (let c = 0; c < MANA_COLORS.length; c++) {
      manaPool[MANA_COLORS[c] as string] = buf[POOLS_AT + pi * MANA_COLORS.length + c] as number;
    }
    players[p] = {
      id: p,
      life: buf[SCALARS_AT + (p === 'A' ? 6 : 7)] as number,
      manaPool: manaPool as never,
      landsPlayedThisTurn: buf[SCALARS_AT + (p === 'A' ? 8 : 9)] as number,
      hasLost: template.players[p].hasLost,
      library: zoneList(0),
      hand: zoneList(1),
      graveyard: zoneList(2),
      exile: zoneList(3),
      command: zoneList(4),
    };
  }
  const bfLen = buf[BF_LEN_AT] as number;
  const battlefield: CardInstance[] = new Array(bfLen);
  for (let k = 0; k < bfLen; k++) battlefield[k] = instances[buf[layout.battlefieldAt + k] as number] as CardInstance;

  return {
    ...template,
    turnNumber: buf[SCALARS_AT + 0] as number,
    activePlayer: (buf[SCALARS_AT + 1] === 0 ? 'A' : 'B') as PlayerId,
    priorityPlayer: (buf[SCALARS_AT + 2] === 0 ? 'A' : 'B') as PlayerId,
    nextInstanceId: buf[SCALARS_AT + 3] as number,
    // uint32 cursor stored in a signed column — re-widen or every future shuffle forks.
    rngState: (buf[SCALARS_AT + 4] as number) >>> 0,
    consecutivePasses: buf[SCALARS_AT + 5] as number,
    gameOver: buf[SCALARS_AT + 10] === 1,
    winner: (buf[SCALARS_AT + 11] === -1 ? null : buf[SCALARS_AT + 11] === 0 ? 'A' : 'B') as PlayerId | null,
    players,
    battlefield,
  };
}

/** Bytes one clone copies — the honest size of the flat state. */
export function arenaBytes(s: ArenaState): number {
  return s.buf.byteLength;
}

function zoneListOf(player: GameState['players'][PlayerId], zone: ZoneName): readonly CardInstance[] {
  switch (zone) {
    case 'library':
      return player.library;
    case 'hand':
      return player.hand;
    case 'graveyard':
      return player.graveyard;
    case 'exile':
      return player.exile;
    default:
      return player.command;
  }
}
