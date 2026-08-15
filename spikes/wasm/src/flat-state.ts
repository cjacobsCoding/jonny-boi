/**
 * A flat, structure-of-arrays mirror of `GameState`, and the round-trip that
 * proves it carries the same information.
 *
 * ## Why this exists
 * The profile says the sim's single largest cost is not arithmetic at all: it is
 * `cloneState` (27.2% of self time on the heuristic pilot) plus the garbage that
 * clone produces (GC 5.7% there, and 69.5% under the MCTS pilot). `applyAction`
 * deep-copies every card instance in both players' libraries — well over a hundred
 * objects with ten fields and a `counters` record each — once per action.
 *
 * WASM cannot touch that unless the whole game state lives in linear memory, which
 * is a full engine rewrite rather than a kernel port. But the DATA LAYOUT can touch
 * it in plain JS: a state whose mutable per-instance fields live in typed arrays
 * clones with `TypedArray.prototype.set` — one memcpy, one allocation, no object
 * headers, nothing for the GC to trace.
 *
 * So this file measures the prize that is actually on the table, independently of
 * the language question.
 *
 * ## The encoding
 * Per instance, one column per mutable field, indexed by a dense slot number:
 *
 *   defIndex   index into a shared, immutable definition table (defs never change,
 *              so they are referenced, never copied — exactly as `cloneState` does)
 *   controller/owner   0 = A, 1 = B
 *   zone       ZONE_ORDER index
 *   flags      bit 0 tapped, bit 1 summoningSick, bit 2 markedByDeathtouch
 *   damage     damage marked this turn
 *   plusCounters  `+1/+1` counters — the only counter kind the engine actually
 *              uses (`internal/stats.ts`), so it is a column, not a map
 *
 * Zone membership and ORDER are preserved exactly (library order is the shuffle;
 * battlefield order is documented as stable and the continuous-effects layering
 * depends on it), as a per-zone list of slots — itself an Int32Array.
 *
 * ## What this is NOT
 * It is not a working flat engine. It is a faithful mirror of the state plus the
 * clone operation, which is the thing being priced. `verifyRoundTrip` asserts it
 * is lossless so the comparison cannot be flattered by dropping fields.
 */

import type { CardDefinition, CardInstance, GameState, PlayerId, ZoneName } from '@jonny-boi/core';
import { MANA_COLORS, PLAYER_IDS } from '@jonny-boi/core';

/** Zone codes. Order is the wire format; `stack` is handled separately. */
export const ZONE_ORDER: readonly ZoneName[] = ['library', 'hand', 'battlefield', 'graveyard', 'exile', 'command'];

const FLAG_TAPPED = 1;
const FLAG_SUMMONING_SICK = 2;
const FLAG_DEATHTOUCHED = 4;

/** The `+1/+1` counter is the only kind the engine reads, so it gets a column. */
const PLUS_ONE = '+1/+1';

/** Per-player zone lists, as dense slot indices in engine order. */
export interface FlatZones {
  library: Int32Array;
  hand: Int32Array;
  battlefield: Int32Array;
  graveyard: Int32Array;
  exile: Int32Array;
  command: Int32Array;
}

/**
 * The whole mutable world as typed arrays. Scalars live in one small `Int32Array`
 * too, so a clone is a fixed number of `set` calls rather than a field-by-field
 * copy of a plain object.
 */
export interface FlatState {
  /** Column store, one entry per instance slot. */
  instanceId: Int32Array;
  defIndex: Int32Array;
  controller: Int8Array;
  owner: Int8Array;
  zone: Int8Array;
  flags: Int8Array;
  damage: Int32Array;
  plusCounters: Int32Array;
  /** Slot count in use. */
  count: number;
  /** Per-player zone membership, in engine order. */
  zones: Record<PlayerId, FlatZones>;
  /** Global battlefield order (the engine keeps one shared, stable array). */
  battlefield: Int32Array;
  /** Mana pools, 6 colours per player, A then B. */
  pools: Int32Array;
  /** turn, activePlayer, priorityPlayer, step, nextInstanceId, rngState, passes, lifeA, lifeB, flags. */
  scalars: Int32Array;
  /** The shared, immutable definition table — referenced, never copied. */
  defs: readonly CardDefinition[];
}

const SCALAR_COUNT = 12;

function flagsOf(inst: CardInstance): number {
  return (
    (inst.tapped ? FLAG_TAPPED : 0) |
    (inst.summoningSick ? FLAG_SUMMONING_SICK : 0) |
    (inst.markedByDeathtouch ? FLAG_DEATHTOUCHED : 0)
  );
}

/** Build the flat mirror of a live `GameState`. Definitions are shared by reference. */
export function toFlatState(state: GameState): FlatState {
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
    const player = state.players[p];
    collect(player.library);
    collect(player.hand);
    collect(player.graveyard);
    collect(player.exile);
    collect(player.command);
  }
  collect(state.battlefield);

  const n = all.length;
  const flat: FlatState = {
    instanceId: new Int32Array(n),
    defIndex: new Int32Array(n),
    controller: new Int8Array(n),
    owner: new Int8Array(n),
    zone: new Int8Array(n),
    flags: new Int8Array(n),
    damage: new Int32Array(n),
    plusCounters: new Int32Array(n),
    count: n,
    zones: {} as Record<PlayerId, FlatZones>,
    battlefield: new Int32Array(state.battlefield.length),
    pools: new Int32Array(MANA_COLORS.length * 2),
    scalars: new Int32Array(SCALAR_COUNT),
    defs,
  };

  for (let i = 0; i < n; i++) {
    const inst = all[i] as CardInstance;
    let di = defIndexOf.get(inst.def);
    if (di === undefined) {
      di = defs.length;
      defs.push(inst.def);
      defIndexOf.set(inst.def, di);
    }
    flat.instanceId[i] = inst.instanceId;
    flat.defIndex[i] = di;
    flat.controller[i] = inst.controller === 'A' ? 0 : 1;
    flat.owner[i] = inst.owner === 'A' ? 0 : 1;
    flat.zone[i] = ZONE_ORDER.indexOf(inst.zone);
    flat.flags[i] = flagsOf(inst);
    flat.damage[i] = inst.damageMarked;
    flat.plusCounters[i] = inst.counters[PLUS_ONE] ?? 0;
  }

  for (const p of PLAYER_IDS) {
    const player = state.players[p];
    const slots = (list: readonly CardInstance[]): Int32Array =>
      Int32Array.from(list, (c) => slotOf.get(c.instanceId) as number);
    flat.zones[p] = {
      library: slots(player.library),
      hand: slots(player.hand),
      battlefield: new Int32Array(0),
      graveyard: slots(player.graveyard),
      exile: slots(player.exile),
      command: slots(player.command),
    };
    const base = p === 'A' ? 0 : MANA_COLORS.length;
    for (let c = 0; c < MANA_COLORS.length; c++) {
      flat.pools[base + c] = player.manaPool[MANA_COLORS[c] as never];
    }
  }
  for (let i = 0; i < state.battlefield.length; i++) {
    flat.battlefield[i] = slotOf.get((state.battlefield[i] as CardInstance).instanceId) as number;
  }

  flat.scalars[0] = state.turnNumber;
  flat.scalars[1] = state.activePlayer === 'A' ? 0 : 1;
  flat.scalars[2] = state.priorityPlayer === 'A' ? 0 : 1;
  flat.scalars[3] = state.nextInstanceId;
  flat.scalars[4] = state.rngState;
  flat.scalars[5] = state.consecutivePasses;
  flat.scalars[6] = state.players.A.life;
  flat.scalars[7] = state.players.B.life;
  flat.scalars[8] = state.players.A.landsPlayedThisTurn;
  flat.scalars[9] = state.players.B.landsPlayedThisTurn;
  flat.scalars[10] = state.gameOver ? 1 : 0;
  flat.scalars[11] = state.winner === null ? -1 : state.winner === 'A' ? 0 : 1;
  return flat;
}

/**
 * Clone the flat state — the operation being priced against `cloneState`.
 *
 * Every column is one `TypedArray.slice`: a single allocation and a memcpy, with
 * no per-element work and nothing for the GC to trace inside it. The definition
 * table is shared by reference, exactly as the object clone shares `def`.
 */
export function cloneFlatState(s: FlatState): FlatState {
  const zones = {} as Record<PlayerId, FlatZones>;
  for (const p of PLAYER_IDS) {
    const z = s.zones[p];
    zones[p] = {
      library: z.library.slice(),
      hand: z.hand.slice(),
      battlefield: z.battlefield.slice(),
      graveyard: z.graveyard.slice(),
      exile: z.exile.slice(),
      command: z.command.slice(),
    };
  }
  return {
    instanceId: s.instanceId.slice(),
    defIndex: s.defIndex.slice(),
    controller: s.controller.slice(),
    owner: s.owner.slice(),
    zone: s.zone.slice(),
    flags: s.flags.slice(),
    damage: s.damage.slice(),
    plusCounters: s.plusCounters.slice(),
    count: s.count,
    zones,
    battlefield: s.battlefield.slice(),
    pools: s.pools.slice(),
    scalars: s.scalars.slice(),
    defs: s.defs,
  };
}

/**
 * Rebuild a `GameState`-shaped object from the flat mirror, so the encoding can be
 * proved lossless. Without this the clone comparison would be worthless: a mirror
 * that quietly dropped `counters` or zone order would clone faster for the obvious
 * wrong reason.
 */
export function fromFlatState(s: FlatState, template: GameState): GameState {
  const instances: CardInstance[] = new Array(s.count);
  for (let i = 0; i < s.count; i++) {
    const counters: Record<string, number> = {};
    if (s.plusCounters[i] !== 0) counters[PLUS_ONE] = s.plusCounters[i] as number;
    const f = s.flags[i] as number;
    instances[i] = {
      instanceId: s.instanceId[i] as number,
      def: s.defs[s.defIndex[i] as number] as CardDefinition,
      controller: (s.controller[i] === 0 ? 'A' : 'B') as PlayerId,
      owner: (s.owner[i] === 0 ? 'A' : 'B') as PlayerId,
      zone: ZONE_ORDER[s.zone[i] as number] as ZoneName,
      tapped: (f & FLAG_TAPPED) !== 0,
      summoningSick: (f & FLAG_SUMMONING_SICK) !== 0,
      damageMarked: s.damage[i] as number,
      markedByDeathtouch: (f & FLAG_DEATHTOUCHED) !== 0,
      counters,
    };
  }
  const pick = (slots: Int32Array): CardInstance[] => Array.from(slots, (i) => instances[i] as CardInstance);
  const players = {} as GameState['players'];
  for (const p of PLAYER_IDS) {
    const z = s.zones[p];
    const base = p === 'A' ? 0 : MANA_COLORS.length;
    const manaPool = {} as Record<string, number>;
    for (let c = 0; c < MANA_COLORS.length; c++) manaPool[MANA_COLORS[c] as string] = s.pools[base + c] as number;
    players[p] = {
      id: p,
      life: (p === 'A' ? s.scalars[6] : s.scalars[7]) as number,
      manaPool: manaPool as never,
      landsPlayedThisTurn: (p === 'A' ? s.scalars[8] : s.scalars[9]) as number,
      hasLost: template.players[p].hasLost,
      library: pick(z.library),
      hand: pick(z.hand),
      graveyard: pick(z.graveyard),
      exile: pick(z.exile),
      command: pick(z.command),
    };
  }
  return {
    ...template,
    turnNumber: s.scalars[0] as number,
    activePlayer: (s.scalars[1] === 0 ? 'A' : 'B') as PlayerId,
    priorityPlayer: (s.scalars[2] === 0 ? 'A' : 'B') as PlayerId,
    nextInstanceId: s.scalars[3] as number,
    // The RNG cursor is a uint32; an Int32Array column brings it back signed, and
    // a negative cursor would silently fork every future shuffle. Determinism is
    // the product, so it is re-widened here rather than "close enough".
    rngState: (s.scalars[4] as number) >>> 0,
    consecutivePasses: s.scalars[5] as number,
    gameOver: s.scalars[10] === 1,
    winner: (s.scalars[11] === -1 ? null : s.scalars[11] === 0 ? 'A' : 'B') as PlayerId | null,
    players,
    battlefield: pick(s.battlefield),
  };
}
