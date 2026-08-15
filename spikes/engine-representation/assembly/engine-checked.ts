/**
 * ARM C — the SAME flat representation as arm B, compiled to WebAssembly.
 *
 * This is a line-for-line port of `src/arm-b-flat.mjs`. Same layout, same
 * algorithm, same emission order, same policy, same RNG stream. The only variable
 * that changes between arm B and arm C is the RUNTIME — which is exactly what the
 * previous WASM spike could not isolate, because it compared a WASM kernel against
 * an object-graph JavaScript engine and so measured language and layout together.
 *
 * ## Why AssemblyScript, and what it does and does not tell us about C++
 *
 * No native toolchain is installed on this box (no emcc, clang, rustc or zig), and
 * installing one is a large external download. AssemblyScript was already in the
 * npm cache from the previous spike, so it is what could be measured.
 *
 * That substitution is defensible for THIS kernel specifically, and the reason is
 * worth stating precisely rather than hand-waving:
 *
 *   - the port declares **zero managed objects** — no classes, no strings, no
 *     closures, no arrays created after start-up. It is compiled with
 *     `--runtime stub`, so there is no garbage collector in the module at all;
 *   - every state access is `()`, so no bounds checks are emitted — the
 *     same code a C++ `int32_t*` would generate;
 *   - the whole program is i32 loads, stores, adds and compares over one linear
 *     buffer, which is the one workload class where AssemblyScript's Binaryen
 *     output and clang's LLVM output are closest.
 *
 * `verify.mjs` dumps the emitted `.wat` and asserts no GC/runtime call survives in
 * it, so the "no managed overhead" claim is checked rather than asserted. What this
 * still does NOT capture is LLVM's better instruction selection, loop unrolling and
 * autovectorisation. Treat arm C as a **lower bound** on native WASM performance —
 * a real C++ port would be somewhat faster, not slower. The recommendation says
 * what headroom would be needed to change the conclusion.
 */

import {
  ACT_CAST_SPELL,
  ACT_DECLARE_ATTACKERS,
  ACT_DECLARE_BLOCKERS,
  ACT_PASS,
  ACT_PLAY_LAND,
  ACT_TAP_FOR_MANA,
  ACTION_CAP,
  ARENA_SIZE,
  ATK_LIST,
  ATTACK_PROFITABLE,
  BF_BASE,
  BLK_LIST,
  BLK_OF,
  BLOCK_GREEDY,
  CAP_ACTIONS,
  CAP_JOURNAL,
  CARD_AMOUNT,
  CARD_COST,
  CARD_KEYWORDS,
  CARD_KIND,
  CARD_POWER,
  CARD_PRODUCES,
  CARD_STRIDE,
  CARD_TABLE,
  CARD_TARGET,
  CARD_TIMING,
  CARD_TOUGHNESS,
  CONT_DPOWER,
  CONT_DTOUGH,
  CONT_TARGET,
  COST_GENERIC,
  DECK0,
  DECK1,
  DECK_SIZE,
  GY_BASE,
  GY_STRIDE,
  HAND_BASE,
  HAND_STRIDE,
  I_CONTROLLER,
  I_DAMAGE,
  I_DEATHTOUCHED,
  I_DEF,
  I_OWNER,
  I_SICK,
  I_TAPPED,
  I_ZONE,
  KIND_BOLT,
  KIND_CREATURE,
  KIND_LAND,
  KW_DEATHTOUCH,
  KW_FLYING,
  KW_HASTE,
  KW_LIFELINK,
  KW_VIGILANCE,
  LIB_BASE,
  LIB_STRIDE,
  MAX_INSTANCES,
  MAX_LANDS_PER_TURN,
  MAX_TURNS,
  NUM_COLORS,
  OPENING_HAND,
  PLAYER_STRIDE,
  PLAYERS_BASE,
  POOL_COLORLESS,
  POOL_SLOTS,
  P_GY_COUNT,
  P_HAND_COUNT,
  P_HAS_LOST,
  P_LANDS_PLAYED,
  P_LIB_COUNT,
  P_LIFE,
  P_POOL,
  S_ACTIVE,
  S_ATTACKER_COUNT,
  S_ATTACKERS_DECLARED,
  S_BF_COUNT,
  S_BLOCK_COUNT,
  S_BLOCKERS_DECLARED,
  S_COMBAT_ACTIVE,
  S_CONT_COUNT,
  S_GAME_OVER,
  S_PASSES,
  S_PRIORITY,
  S_RNG,
  S_STACK_COUNT,
  S_STEP,
  S_TURN,
  S_WINNER,
  STARTING_LIFE,
  STEP_CLEANUP,
  STEP_COMBAT_DAMAGE,
  STEP_DECLARE_ATTACKERS,
  STEP_DECLARE_BLOCKERS,
  STEP_DRAW,
  STEP_MAIN1,
  STEP_MAIN2,
  STEP_UNTAP,
  STEP_UPKEEP,
  STK_CARD,
  STK_CONTROLLER,
  STK_TARGET,
  TARGET_ANY,
  TARGET_NONE,
  TARGET_NOTHING,
  TARGET_PLAYER_0,
  TIMING_INSTANT,
  ZONE_BATTLEFIELD,
  ZONE_GRAVEYARD,
  ZONE_HAND,
  ZONE_LIBRARY,
  ZONE_STACK,
} from './generated';

// --- storage (allocated once, never freed; `--runtime stub` has no collector) -------

const arena = new Int32Array(ARENA_SIZE);
const journalAddr = new Int32Array(CAP_JOURNAL);
const journalPrev = new Int32Array(CAP_JOURNAL);
const actionBuf = new Int32Array(CAP_ACTIONS);
const usedMark = new Int32Array(MAX_INSTANCES);
const potentialPool = new Int32Array(POOL_SLOTS);

let journalTop: i32 = 0;
let journalEnabled: bool = true;
let usedGen: i32 = 0;

// Result channels — scalars the host reads after a workload returns, so a run
// crosses the boundary a fixed number of times regardless of its size.
let outActions: i32 = 0;
let outGenerated: i32 = 0;
let outTurns: i32 = 0;
let outWinner: i32 = 0;
let outTransitions: i32 = 0;

// --- primitives ----------------------------------------------------------------------

@inline function R(addr: i32): i32 {
  return (arena[addr]);
}

@inline function W(addr: i32, val: i32): void {
  if (journalEnabled) {
    ((journalAddr[journalTop] = addr));
    ((journalPrev[journalTop] = (arena[addr])));
    journalTop++;
  }
  ((arena[addr] = val));
}

@inline function mark(): i32 {
  return journalTop;
}

function rewind(m: i32): void {
  while (journalTop > m) {
    journalTop--;
    ((arena[(journalAddr[journalTop])] = (journalPrev[journalTop])));
  }
}

@inline function pbase(p: i32): i32 {
  return PLAYERS_BASE + p * PLAYER_STRIDE;
}
@inline function cardOf(instanceId: i32): i32 {
  return R(I_DEF + instanceId);
}
@inline function cf(defBase: i32, field: i32): i32 {
  return (CARD_TABLE[defBase + field]);
}

@inline function rngNext(s: i32): i32 {
  let x = s;
  x ^= x << 13;
  x ^= <i32>((<u32>x) >>> 17);
  x ^= x << 5;
  return x;
}

@inline function fnv(h: i32, v: i32): i32 {
  return (h ^ v) * 0x01000193;
}

@inline function packAction(kind: i32, instanceId: i32, target: i32, extra: i32): i32 {
  return (kind & 0xf) | ((instanceId & 0xff) << 4) | ((target & 0x1ff) << 12) | ((extra & 0xf) << 21);
}
@inline function actKind(a: i32): i32 {
  return a & 0xf;
}
@inline function actInstance(a: i32): i32 {
  return (a >> 4) & 0xff;
}
@inline function actTarget(a: i32): i32 {
  return (a >> 12) & 0x1ff;
}
@inline function actExtra(a: i32): i32 {
  return (a >> 21) & 0xf;
}

@inline function digestInstance(kind: i32, instanceId: i32): i32 {
  if (kind == ACT_PASS || kind == ACT_DECLARE_ATTACKERS || kind == ACT_DECLARE_BLOCKERS) return -1;
  return instanceId;
}

// --- lists -------------------------------------------------------------------------------

function listPush(base: i32, countAddr: i32, id: i32): void {
  const n = R(countAddr);
  W(base + n, id);
  W(countAddr, n + 1);
}

function listRemoveAt(base: i32, countAddr: i32, i: i32): void {
  const n = R(countAddr);
  for (let k = i; k < n - 1; k++) W(base + k, R(base + k + 1));
  W(countAddr, n - 1);
}

function listIndexOf(base: i32, count: i32, id: i32): i32 {
  for (let i = 0; i < count; i++) if (R(base + i) == id) return i;
  return -1;
}

// --- construction ---------------------------------------------------------------------------

function deckCard(p: i32, i: i32): i32 {
  return p == 0 ? (DECK0[i]) : (DECK1[i]);
}

export function createGame(seed: i32): void {
  arena.fill(0);
  journalTop = 0;
  ((arena[S_TURN] = 1));
  ((arena[S_STEP] = STEP_MAIN1));
  ((arena[S_WINNER] = -1));
  ((arena[S_RNG] = seed));
  for (let p = 0; p < 2; p++) ((arena[pbase(p) + P_LIFE] = STARTING_LIFE));

  for (let p = 0; p < 2; p++) {
    const pb = pbase(p);
    const lib = LIB_BASE + p * LIB_STRIDE;
    for (let i = 0; i < DECK_SIZE; i++) {
      const id = p * DECK_SIZE + i;
      ((arena[I_DEF + id] = deckCard(p, i) * CARD_STRIDE));
      ((arena[I_OWNER + id] = p));
      ((arena[I_CONTROLLER + id] = p));
      ((arena[I_ZONE + id] = ZONE_LIBRARY));
      ((arena[lib + i] = id));
    }
    ((arena[pb + P_LIB_COUNT] = DECK_SIZE));
    for (let i = DECK_SIZE - 1; i > 0; i--) {
      ((arena[S_RNG] = rngNext((arena[S_RNG]))));
      const j = <i32>((<u32>(arena[S_RNG])) % (<u32>(i + 1)));
      const t = (arena[lib + i]);
      ((arena[lib + i] = (arena[lib + j])));
      ((arena[lib + j] = t));
    }
    for (let i = 0; i < OPENING_HAND; i++) drawCard(p);
  }
  journalTop = 0;
}

function drawCard(p: i32): void {
  const pb = pbase(p);
  const n = R(pb + P_LIB_COUNT);
  if (n == 0) {
    W(pb + P_HAS_LOST, 1);
    return;
  }
  const id = R(LIB_BASE + p * LIB_STRIDE + (n - 1));
  W(pb + P_LIB_COUNT, n - 1);
  W(I_ZONE + id, ZONE_HAND);
  listPush(HAND_BASE + p * HAND_STRIDE, pb + P_HAND_COUNT, id);
}

// --- effective characteristics -----------------------------------------------------------------

function effPower(id: i32): i32 {
  let v = cf(cardOf(id), CARD_POWER);
  const n = R(S_CONT_COUNT);
  for (let i = 0; i < n; i++) if (R(CONT_TARGET + i) == id) v += R(CONT_DPOWER + i);
  return v;
}

function effToughness(id: i32): i32 {
  let v = cf(cardOf(id), CARD_TOUGHNESS);
  const n = R(S_CONT_COUNT);
  for (let i = 0; i < n; i++) if (R(CONT_TARGET + i) == id) v += R(CONT_DTOUGH + i);
  return v;
}

// --- mana ---------------------------------------------------------------------------------------

function canPayFrom(poolBase: i32, defBase: i32): bool {
  let spare = R(poolBase + POOL_COLORLESS);
  for (let c = 0; c < NUM_COLORS; c++) {
    const need = cf(defBase, CARD_COST + 1 + c);
    const have = R(poolBase + c);
    if (have < need) return false;
    spare += have - need;
  }
  return spare >= cf(defBase, CARD_COST + COST_GENERIC);
}

function canPayScratch(defBase: i32): bool {
  let spare = (potentialPool[POOL_COLORLESS]);
  for (let c = 0; c < NUM_COLORS; c++) {
    const need = cf(defBase, CARD_COST + 1 + c);
    const have = (potentialPool[c]);
    if (have < need) return false;
    spare += have - need;
  }
  return spare >= cf(defBase, CARD_COST + COST_GENERIC);
}

function payCost(poolBase: i32, defBase: i32): void {
  for (let c = 0; c < NUM_COLORS; c++) W(poolBase + c, R(poolBase + c) - cf(defBase, CARD_COST + 1 + c));
  let generic = cf(defBase, CARD_COST + COST_GENERIC);
  const cl = R(poolBase + POOL_COLORLESS);
  const take = generic < cl ? generic : cl;
  W(poolBase + POOL_COLORLESS, cl - take);
  generic -= take;
  for (let c = 0; c < NUM_COLORS && generic > 0; c++) {
    const have = R(poolBase + c);
    const t = generic < have ? generic : have;
    W(poolBase + c, have - t);
    generic -= t;
  }
}

function emptyManaPools(): void {
  for (let p = 0; p < 2; p++) {
    const pb = pbase(p) + P_POOL;
    for (let i = 0; i < POOL_SLOTS; i++) if (R(pb + i) != 0) W(pb + i, 0);
  }
}

// --- legal action generation -----------------------------------------------------------------------

export function generateLegalActions(): i32 {
  if (R(S_GAME_OVER) != 0) return 0;
  const me = R(S_PRIORITY);
  const pb = pbase(me);
  let n = 0;

  ((actionBuf[n++] = packAction(ACT_PASS, 0, TARGET_NOTHING, 0)));

  const bfCount = R(S_BF_COUNT);
  for (let b = 0; b < bfCount; b++) {
    const id = R(BF_BASE + b);
    if (R(I_CONTROLLER + id) != me || R(I_TAPPED + id) != 0) continue;
    if (cf(cardOf(id), CARD_KIND) != KIND_LAND) continue;
    ((actionBuf[n++] = packAction(ACT_TAP_FOR_MANA, id, TARGET_NOTHING, 0)));
  }

  const step = R(S_STEP);
  const sorcerySpeed = me == R(S_ACTIVE) && (step == STEP_MAIN1 || step == STEP_MAIN2) && R(S_STACK_COUNT) == 0;
  const handBase = HAND_BASE + me * HAND_STRIDE;
  const handCount = R(pb + P_HAND_COUNT);

  if (sorcerySpeed && R(pb + P_LANDS_PLAYED) < MAX_LANDS_PER_TURN) {
    for (let h = 0; h < handCount; h++) {
      const id = R(handBase + h);
      if (cf(cardOf(id), CARD_KIND) == KIND_LAND) {
        ((actionBuf[n++] = packAction(ACT_PLAY_LAND, id, TARGET_NOTHING, 0)));
      }
    }
  }

  for (let h = 0; h < handCount; h++) {
    const id = R(handBase + h);
    const def = cardOf(id);
    if (cf(def, CARD_KIND) == KIND_LAND) continue;
    const timingOk = cf(def, CARD_TIMING) == TIMING_INSTANT ? true : sorcerySpeed;
    if (!timingOk) continue;
    if (!canPayFrom(pb + P_POOL, def)) continue;
    const restriction = cf(def, CARD_TARGET);
    if (restriction == TARGET_NONE) {
      ((actionBuf[n++] = packAction(ACT_CAST_SPELL, id, TARGET_NOTHING, 0)));
      continue;
    }
    for (let b = 0; b < bfCount; b++) {
      const t = R(BF_BASE + b);
      if (cf(cardOf(t), CARD_KIND) != KIND_CREATURE) continue;
      ((actionBuf[n++] = packAction(ACT_CAST_SPELL, id, t, 0)));
    }
    if (restriction == TARGET_ANY) {
      ((actionBuf[n++] = packAction(ACT_CAST_SPELL, id, TARGET_PLAYER_0, 0)));
      ((actionBuf[n++] = packAction(ACT_CAST_SPELL, id, TARGET_PLAYER_0 + 1, 0)));
    }
  }

  if (
    step == STEP_DECLARE_ATTACKERS &&
    me == R(S_ACTIVE) &&
    R(S_COMBAT_ACTIVE) != 0 &&
    R(S_ATTACKERS_DECLARED) == 0 &&
    countEligibleAttackers(me) > 0
  ) {
    ((actionBuf[n++] = packAction(ACT_DECLARE_ATTACKERS, 0, TARGET_NOTHING, 0)));
    ((actionBuf[n++] = packAction(ACT_DECLARE_ATTACKERS, 0, TARGET_NOTHING, ATTACK_PROFITABLE)));
  }

  if (
    step == STEP_DECLARE_BLOCKERS &&
    me != R(S_ACTIVE) &&
    R(S_COMBAT_ACTIVE) != 0 &&
    R(S_ATTACKERS_DECLARED) != 0 &&
    R(S_BLOCKERS_DECLARED) == 0
  ) {
    ((actionBuf[n++] = packAction(ACT_DECLARE_BLOCKERS, 0, TARGET_NOTHING, 0)));
    if (R(S_ATTACKER_COUNT) > 0) {
      ((actionBuf[n++] = packAction(ACT_DECLARE_BLOCKERS, 0, TARGET_NOTHING, BLOCK_GREEDY)));
    }
  }

  return n;
}

function isEligibleAttacker(id: i32, me: i32): bool {
  if (R(I_CONTROLLER + id) != me) return false;
  const def = cardOf(id);
  if (cf(def, CARD_KIND) != KIND_CREATURE || R(I_TAPPED + id) != 0) return false;
  if (R(I_SICK + id) != 0 && (cf(def, CARD_KEYWORDS) & KW_HASTE) == 0) return false;
  return true;
}

function countEligibleAttackers(me: i32): i32 {
  let n = 0;
  const bfCount = R(S_BF_COUNT);
  for (let b = 0; b < bfCount; b++) if (isEligibleAttacker(R(BF_BASE + b), me)) n++;
  return n;
}

function bestDefenderPower(defender: i32): i32 {
  let best = 0;
  const bfCount = R(S_BF_COUNT);
  for (let b = 0; b < bfCount; b++) {
    const id = R(BF_BASE + b);
    if (R(I_CONTROLLER + id) != defender) continue;
    if (cf(cardOf(id), CARD_KIND) != KIND_CREATURE || R(I_TAPPED + id) != 0) continue;
    const p = effPower(id);
    if (p > best) best = p;
  }
  return best;
}

function buildAttackers(me: i32, variant: i32): i32 {
  const threat = variant == ATTACK_PROFITABLE ? bestDefenderPower(1 - me) : -1;
  let n = 0;
  const bfCount = R(S_BF_COUNT);
  for (let b = 0; b < bfCount; b++) {
    const id = R(BF_BASE + b);
    if (!isEligibleAttacker(id, me)) continue;
    if (variant == ATTACK_PROFITABLE && effToughness(id) <= threat) continue;
    W(ATK_LIST + n, id);
    n++;
  }
  W(S_ATTACKER_COUNT, n);
  return n;
}

function buildBlocks(me: i32): i32 {
  usedGen++;
  let n = 0;
  const atkCount = R(S_ATTACKER_COUNT);
  const bfCount = R(S_BF_COUNT);
  for (let a = 0; a < atkCount; a++) {
    const attacker = R(ATK_LIST + a);
    if (R(I_ZONE + attacker) != ZONE_BATTLEFIELD) continue;
    const atkDef = cardOf(attacker);
    const atkFlying = (cf(atkDef, CARD_KEYWORDS) & KW_FLYING) != 0;
    const atkDeathtouch = (cf(atkDef, CARD_KEYWORDS) & KW_DEATHTOUCH) != 0;
    const atkPower = effPower(attacker);
    let chosen = -1;
    let chosenTough = 0;
    for (let b = 0; b < bfCount; b++) {
      const id = R(BF_BASE + b);
      if (R(I_CONTROLLER + id) != me) continue;
      const def = cardOf(id);
      if (cf(def, CARD_KIND) != KIND_CREATURE || R(I_TAPPED + id) != 0) continue;
      if ((usedMark[id]) == usedGen) continue;
      if (atkFlying && (cf(def, CARD_KEYWORDS) & KW_FLYING) == 0) continue;
      const t = effToughness(id);
      const survives = t > atkPower && !atkDeathtouch;
      if (chosen == -1 || (survives && chosenTough <= atkPower) || (survives && t < chosenTough)) {
        chosen = id;
        chosenTough = t;
      }
    }
    if (chosen != -1) {
      ((usedMark[chosen] = usedGen));
      W(BLK_LIST + n, chosen);
      W(BLK_OF + n, attacker);
      n++;
    }
  }
  W(S_BLOCK_COUNT, n);
  return n;
}

// --- application -------------------------------------------------------------------------------------

export function applyAction(action: i32): void {
  if (R(S_GAME_OVER) != 0) return;
  const me = R(S_PRIORITY);
  const pb = pbase(me);
  const kind = actKind(action);
  const inst = actInstance(action);
  const target = actTarget(action);
  const extra = actExtra(action);

  if (kind == ACT_PASS) {
    const passes = R(S_PASSES) + 1;
    if (passes >= 2) {
      W(S_PASSES, 0);
      if (R(S_STACK_COUNT) > 0) {
        resolveTopOfStack();
        W(S_PRIORITY, R(S_ACTIVE));
      } else {
        advanceStep();
      }
    } else {
      W(S_PASSES, passes);
      W(S_PRIORITY, 1 - me);
    }
  } else if (kind == ACT_PLAY_LAND) {
    const handBase = HAND_BASE + me * HAND_STRIDE;
    const idx = listIndexOf(handBase, R(pb + P_HAND_COUNT), inst);
    if (idx >= 0) {
      listRemoveAt(handBase, pb + P_HAND_COUNT, idx);
      W(I_ZONE + inst, ZONE_BATTLEFIELD);
      W(I_TAPPED + inst, 0);
      W(I_SICK + inst, 1);
      listPush(BF_BASE, S_BF_COUNT, inst);
      W(pb + P_LANDS_PLAYED, R(pb + P_LANDS_PLAYED) + 1);
      W(S_PASSES, 0);
    }
  } else if (kind == ACT_TAP_FOR_MANA) {
    if (R(I_ZONE + inst) == ZONE_BATTLEFIELD && R(I_TAPPED + inst) == 0) {
      W(I_TAPPED + inst, 1);
      const color = cf(cardOf(inst), CARD_PRODUCES);
      W(pb + P_POOL + color, R(pb + P_POOL + color) + 1);
      W(S_PASSES, 0);
    }
  } else if (kind == ACT_CAST_SPELL) {
    const handBase = HAND_BASE + me * HAND_STRIDE;
    const idx = listIndexOf(handBase, R(pb + P_HAND_COUNT), inst);
    if (idx >= 0) {
      const def = cardOf(inst);
      if (canPayFrom(pb + P_POOL, def)) {
        payCost(pb + P_POOL, def);
        listRemoveAt(handBase, pb + P_HAND_COUNT, idx);
        W(I_ZONE + inst, ZONE_STACK);
        const sc = R(S_STACK_COUNT);
        W(STK_CARD + sc, inst);
        W(STK_CONTROLLER + sc, me);
        W(STK_TARGET + sc, target);
        W(S_STACK_COUNT, sc + 1);
        W(S_PASSES, 0);
        W(S_PRIORITY, me);
      }
    }
  } else if (kind == ACT_DECLARE_ATTACKERS) {
    const n = buildAttackers(me, extra);
    W(S_ATTACKERS_DECLARED, 1);
    for (let i = 0; i < n; i++) {
      const id = R(ATK_LIST + i);
      if ((cf(cardOf(id), CARD_KEYWORDS) & KW_VIGILANCE) == 0) W(I_TAPPED + id, 1);
    }
    W(S_PASSES, 0);
  } else if (kind == ACT_DECLARE_BLOCKERS) {
    if (extra == BLOCK_GREEDY) buildBlocks(me);
    else W(S_BLOCK_COUNT, 0);
    W(S_BLOCKERS_DECLARED, 1);
    W(S_PASSES, 0);
  }

  checkStateBasedActions();
}

function resolveTopOfStack(): void {
  const sc = R(S_STACK_COUNT) - 1;
  const id = R(STK_CARD + sc);
  const controller = R(STK_CONTROLLER + sc);
  const target = R(STK_TARGET + sc);
  W(S_STACK_COUNT, sc);
  const def = cardOf(id);
  const kind = cf(def, CARD_KIND);

  if (kind == KIND_CREATURE) {
    W(I_ZONE + id, ZONE_BATTLEFIELD);
    W(I_CONTROLLER + id, controller);
    W(I_TAPPED + id, 0);
    W(I_SICK + id, (cf(def, CARD_KEYWORDS) & KW_HASTE) == 0 ? 1 : 0);
    W(I_DAMAGE + id, 0);
    W(I_DEATHTOUCHED + id, 0);
    listPush(BF_BASE, S_BF_COUNT, id);
    return;
  }

  const restriction = cf(def, CARD_TARGET);
  if (restriction != TARGET_NONE && target < TARGET_PLAYER_0) {
    if (R(I_ZONE + target) == ZONE_BATTLEFIELD) {
      if (kind == KIND_BOLT) {
        W(I_DAMAGE + target, R(I_DAMAGE + target) + cf(def, CARD_AMOUNT));
      } else {
        const cn = R(S_CONT_COUNT);
        W(CONT_TARGET + cn, target);
        W(CONT_DPOWER + cn, cf(def, CARD_AMOUNT));
        W(CONT_DTOUGH + cn, cf(def, CARD_AMOUNT));
        W(S_CONT_COUNT, cn + 1);
      }
    }
  } else if (kind == KIND_BOLT && target >= TARGET_PLAYER_0) {
    const vb = pbase(target - TARGET_PLAYER_0);
    W(vb + P_LIFE, R(vb + P_LIFE) - cf(def, CARD_AMOUNT));
  }

  const owner = R(I_OWNER + id);
  W(I_ZONE + id, ZONE_GRAVEYARD);
  listPush(GY_BASE + owner * GY_STRIDE, pbase(owner) + P_GY_COUNT, id);
}

function checkStateBasedActions(): void {
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = R(S_BF_COUNT) - 1; i >= 0; i--) {
      const id = R(BF_BASE + i);
      if (cf(cardOf(id), CARD_KIND) != KIND_CREATURE) continue;
      const lethal = R(I_DAMAGE + id) >= effToughness(id) || R(I_DEATHTOUCHED + id) != 0;
      if (!lethal) continue;
      listRemoveAt(BF_BASE, S_BF_COUNT, i);
      W(I_ZONE + id, ZONE_GRAVEYARD);
      W(I_DAMAGE + id, 0);
      W(I_DEATHTOUCHED + id, 0);
      const owner = R(I_OWNER + id);
      listPush(GY_BASE + owner * GY_STRIDE, pbase(owner) + P_GY_COUNT, id);
      changed = true;
    }
  }
  for (let p = 0; p < 2; p++) {
    const pb = pbase(p);
    if (R(pb + P_LIFE) <= 0 && R(pb + P_HAS_LOST) == 0) W(pb + P_HAS_LOST, 1);
  }
  const aLost = R(pbase(0) + P_HAS_LOST) != 0;
  const bLost = R(pbase(1) + P_HAS_LOST) != 0;
  if (aLost || bLost) {
    W(S_GAME_OVER, 1);
    W(S_WINNER, aLost && bLost ? -1 : aLost ? 1 : 0);
  }
}

// --- turn structure ---------------------------------------------------------------------------------

function advanceStep(): void {
  emptyManaPools();
  const step = R(S_STEP) + 1;
  if (step > STEP_CLEANUP) {
    passTurn();
    return;
  }
  enterStep(step);
}

function passTurn(): void {
  const bfCount = R(S_BF_COUNT);
  for (let i = 0; i < bfCount; i++) {
    const id = R(BF_BASE + i);
    if (R(I_DAMAGE + id) != 0) W(I_DAMAGE + id, 0);
    if (R(I_DEATHTOUCHED + id) != 0) W(I_DEATHTOUCHED + id, 0);
  }
  W(S_CONT_COUNT, 0);
  W(S_COMBAT_ACTIVE, 0);
  W(S_ATTACKERS_DECLARED, 0);
  W(S_BLOCKERS_DECLARED, 0);
  W(S_ATTACKER_COUNT, 0);
  W(S_BLOCK_COUNT, 0);
  const turn = R(S_TURN) + 1;
  W(S_TURN, turn);
  W(S_ACTIVE, 1 - R(S_ACTIVE));
  if (turn > MAX_TURNS) {
    W(S_GAME_OVER, 1);
    W(S_WINNER, -1);
    return;
  }
  enterStep(STEP_UNTAP);
}

function enterStep(step: i32): void {
  W(S_STEP, step);
  W(S_PRIORITY, R(S_ACTIVE));
  W(S_PASSES, 0);

  if (step == STEP_UNTAP) {
    const active = R(S_ACTIVE);
    const bfCount = R(S_BF_COUNT);
    for (let i = 0; i < bfCount; i++) {
      const id = R(BF_BASE + i);
      if (R(I_CONTROLLER + id) != active) continue;
      if (R(I_TAPPED + id) != 0) W(I_TAPPED + id, 0);
      if (R(I_SICK + id) != 0) W(I_SICK + id, 0);
    }
    W(pbase(active) + P_LANDS_PLAYED, 0);
    enterStep(STEP_UPKEEP);
    return;
  }
  if (step == STEP_DRAW) {
    drawCard(R(S_ACTIVE));
    checkStateBasedActions();
    return;
  }
  if (step == STEP_DECLARE_ATTACKERS) {
    W(S_COMBAT_ACTIVE, 1);
    W(S_ATTACKER_COUNT, 0);
    W(S_BLOCK_COUNT, 0);
    W(S_ATTACKERS_DECLARED, 0);
    W(S_BLOCKERS_DECLARED, 0);
    return;
  }
  if (step == STEP_COMBAT_DAMAGE) {
    resolveCombatDamage();
    checkStateBasedActions();
    return;
  }
  if (step == STEP_CLEANUP) passTurn();
}

function resolveCombatDamage(): void {
  if (R(S_COMBAT_ACTIVE) == 0 || R(S_ATTACKERS_DECLARED) == 0) return;
  const defender = 1 - R(S_ACTIVE);
  const atkCount = R(S_ATTACKER_COUNT);
  const blkCount = R(S_BLOCK_COUNT);

  for (let a = 0; a < atkCount; a++) {
    const attacker = R(ATK_LIST + a);
    if (R(I_ZONE + attacker) != ZONE_BATTLEFIELD) continue;
    const def = cardOf(attacker);
    const kw = cf(def, CARD_KEYWORDS);
    const power = effPower(attacker);
    const deathtouch = (kw & KW_DEATHTOUCH) != 0;
    const lifelink = (kw & KW_LIFELINK) != 0;
    const ab = pbase(R(I_CONTROLLER + attacker));

    let assigned = 0;
    let remaining = power;
    for (let b = 0; b < blkCount; b++) {
      if (R(BLK_OF + b) != attacker) continue;
      const blocker = R(BLK_LIST + b);
      if (R(I_ZONE + blocker) != ZONE_BATTLEFIELD) continue;
      assigned++;
      if (remaining > 0) {
        W(I_DAMAGE + blocker, R(I_DAMAGE + blocker) + remaining);
        if (deathtouch) W(I_DEATHTOUCHED + blocker, 1);
        if (lifelink) W(ab + P_LIFE, R(ab + P_LIFE) + remaining);
        remaining = 0;
      }
      const bPower = effPower(blocker);
      W(I_DAMAGE + attacker, R(I_DAMAGE + attacker) + bPower);
      const bkw = cf(cardOf(blocker), CARD_KEYWORDS);
      if ((bkw & KW_DEATHTOUCH) != 0) W(I_DEATHTOUCHED + attacker, 1);
      if ((bkw & KW_LIFELINK) != 0) {
        const bb = pbase(R(I_CONTROLLER + blocker));
        W(bb + P_LIFE, R(bb + P_LIFE) + bPower);
      }
    }

    if (assigned == 0 && power > 0) {
      const db = pbase(defender);
      W(db + P_LIFE, R(db + P_LIFE) - power);
      if (lifelink) W(ab + P_LIFE, R(ab + P_LIFE) + power);
    }
  }
}

// --- policy --------------------------------------------------------------------------------------------

function wantsToTap(me: i32): bool {
  const step = R(S_STEP);
  const sorcerySpeed = me == R(S_ACTIVE) && (step == STEP_MAIN1 || step == STEP_MAIN2) && R(S_STACK_COUNT) == 0;
  const defendingWithTrick = step == STEP_DECLARE_BLOCKERS && R(S_COMBAT_ACTIVE) != 0 && R(S_ATTACKER_COUNT) > 0;
  if (!sorcerySpeed && !defendingWithTrick) return false;

  const pb = pbase(me);
  const poolBase = pb + P_POOL;
  for (let i = 0; i < POOL_SLOTS; i++) ((potentialPool[i] = R(poolBase + i)));
  const bfCount = R(S_BF_COUNT);
  for (let b = 0; b < bfCount; b++) {
    const id = R(BF_BASE + b);
    if (R(I_CONTROLLER + id) != me || R(I_TAPPED + id) != 0) continue;
    const def = cardOf(id);
    if (cf(def, CARD_KIND) != KIND_LAND) continue;
    const color = cf(def, CARD_PRODUCES);
    ((potentialPool[color] = (potentialPool[color]) + 1));
  }

  const handBase = HAND_BASE + me * HAND_STRIDE;
  const handCount = R(pb + P_HAND_COUNT);
  for (let h = 0; h < handCount; h++) {
    const def = cardOf(R(handBase + h));
    if (cf(def, CARD_KIND) == KIND_LAND) continue;
    if (!sorcerySpeed && cf(def, CARD_TIMING) != TIMING_INSTANT) continue;
    if (canPayFrom(poolBase, def)) continue;
    if (canPayScratch(def)) return true;
  }
  return false;
}

function creatureValue(def: i32): i32 {
  const kw = cf(def, CARD_KEYWORDS);
  let v = cf(def, CARD_POWER) * 2 + cf(def, CARD_TOUGHNESS);
  if ((kw & KW_FLYING) != 0) v += 3;
  if ((kw & KW_LIFELINK) != 0) v += 2;
  if ((kw & KW_DEATHTOUCH) != 0) v += 3;
  if ((kw & KW_VIGILANCE) != 0) v += 1;
  if ((kw & KW_HASTE) != 0) v += 1;
  return v;
}

function scoreAction(action: i32): i32 {
  const me = R(S_PRIORITY);
  const kind = actKind(action);
  const inst = actInstance(action);
  const target = actTarget(action);
  const extra = actExtra(action);

  if (kind == ACT_PASS) return 0;
  if (kind == ACT_PLAY_LAND) return 500;
  if (kind == ACT_TAP_FOR_MANA) return wantsToTap(me) ? 300 : -1;

  if (kind == ACT_CAST_SPELL) {
    if (R(I_ZONE + inst) != ZONE_HAND) return -1000;
    const def = cardOf(inst);
    const k = cf(def, CARD_KIND);
    if (k == KIND_CREATURE) return 1000 + creatureValue(def);
    const amount = cf(def, CARD_AMOUNT);
    if (k == KIND_BOLT) {
      if (target >= TARGET_PLAYER_0) {
        const victim = target - TARGET_PLAYER_0;
        if (victim == me) return -1000;
        return R(pbase(victim) + P_LIFE) <= amount ? 5000 : 1000 + amount;
      }
      if (R(I_ZONE + target) != ZONE_BATTLEFIELD || R(I_CONTROLLER + target) == me) return -1000;
      return effToughness(target) - R(I_DAMAGE + target) <= amount ? 1200 + creatureValue(cardOf(target)) : 1000 + amount;
    }
    if (R(I_ZONE + target) != ZONE_BATTLEFIELD || R(I_CONTROLLER + target) != me) return -1000;
    return R(S_STEP) == STEP_DECLARE_BLOCKERS ? 1100 + amount : 1001;
  }

  if (kind == ACT_DECLARE_ATTACKERS) {
    const before = mark();
    const n = buildAttackers(me, extra);
    const threat = bestDefenderPower(1 - me);
    let score = 190;
    for (let i = 0; i < n; i++) {
      const id = R(ATK_LIST + i);
      score += effPower(id);
      if (effToughness(id) <= threat) score -= 2;
    }
    rewind(before);
    return score;
  }

  if (kind == ACT_DECLARE_BLOCKERS) {
    if (extra != BLOCK_GREEDY) {
      let incoming = 0;
      const atkCount = R(S_ATTACKER_COUNT);
      for (let i = 0; i < atkCount; i++) {
        const id = R(ATK_LIST + i);
        if (R(I_ZONE + id) == ZONE_BATTLEFIELD) incoming += effPower(id);
      }
      return 100 + (R(pbase(me) + P_LIFE) > incoming ? 0 : -50);
    }
    const before = mark();
    const n = buildBlocks(me);
    let score = 100;
    for (let i = 0; i < n; i++) {
      const blocker = R(BLK_LIST + i);
      const attacker = R(BLK_OF + i);
      const aPow = effPower(attacker);
      score += aPow;
      if (effToughness(blocker) <= aPow || (cf(cardOf(attacker), CARD_KEYWORDS) & KW_DEATHTOUCH) != 0) {
        score -= creatureValue(cardOf(blocker));
      }
      if (effToughness(attacker) <= effPower(blocker)) score += creatureValue(cardOf(attacker));
    }
    rewind(before);
    return score;
  }
  return 0;
}

function chooseAction(count: i32): i32 {
  let best = 0;
  let bestScore = -0x7fffffff;
  for (let i = 0; i < count; i++) {
    const s = scoreAction((actionBuf[i]));
    if (s > bestScore) {
      bestScore = s;
      best = i;
    }
  }
  return best;
}

export function evaluate(): i32 {
  let v = (R(pbase(0) + P_LIFE) - R(pbase(1) + P_LIFE)) * 3;
  const bfCount = R(S_BF_COUNT);
  for (let i = 0; i < bfCount; i++) {
    const id = R(BF_BASE + i);
    if (cf(cardOf(id), CARD_KIND) != KIND_CREATURE) continue;
    const side = R(I_CONTROLLER + id) == 0 ? 1 : -1;
    v += side * (effPower(id) + effToughness(id)) * 2;
  }
  v += R(pbase(0) + P_HAND_COUNT) - R(pbase(1) + P_HAND_COUNT);
  return v;
}

// --- workloads (whole runs stay inside the module; the host reads scalars after) ------------------------

export function playGame(seed: i32): i32 {
  createGame(seed);
  let digest = 0x811c9dc5;
  let actions = 0;
  let generated = 0;
  while (R(S_GAME_OVER) == 0 && actions < ACTION_CAP) {
    journalTop = 0;
    const count = generateLegalActions();
    if (count == 0) break;
    generated += count;
    const a = (actionBuf[chooseAction(count)]);
    digest = fnv(digest, actKind(a));
    digest = fnv(digest, digestInstance(actKind(a), actInstance(a)));
    digest = fnv(digest, actTarget(a));
    digest = fnv(digest, actExtra(a));
    digest = fnv(digest, R(S_STEP));
    digest = fnv(digest, R(S_PRIORITY));
    digest = fnv(digest, R(pbase(0) + P_LIFE));
    digest = fnv(digest, R(pbase(1) + P_LIFE));
    digest = fnv(digest, R(S_BF_COUNT));
    applyAction(a);
    actions++;
  }
  digest = fnv(digest, R(S_WINNER));
  digest = fnv(digest, R(S_TURN));
  outActions = actions;
  outGenerated = generated;
  outTurns = R(S_TURN);
  outWinner = R(S_WINNER);
  return digest;
}

/** Plays `count` seeded games back to back — ONE boundary crossing for the whole run. */
export function playGames(firstSeed: i32, count: i32): i32 {
  let digest = 0x811c9dc5;
  let actions = 0;
  for (let i = 0; i < count; i++) {
    digest = fnv(digest, playGame(firstSeed + i));
    actions += outActions;
  }
  outActions = actions;
  return digest;
}

export const MIDGAME_ACTIONS: i32 = 300;

export function midGameState(seed: i32): void {
  createGame(seed);
  for (let i = 0; i < MIDGAME_ACTIONS && R(S_GAME_OVER) == 0; i++) {
    journalTop = 0;
    const count = generateLegalActions();
    if (count == 0) break;
    applyAction((actionBuf[chooseAction(count)]));
  }
  journalTop = 0;
}

export function searchWorkload(seed: i32, rollouts: i32, depth: i32): i32 {
  midGameState(seed);
  let rng = seed * 2654435761;
  let checksum = 0x811c9dc5;
  let transitions = 0;
  for (let r = 0; r < rollouts; r++) {
    const root = mark();
    for (let d = 0; d < depth; d++) {
      if (R(S_GAME_OVER) != 0) break;
      const count = generateLegalActions();
      if (count == 0) break;
      rng = rngNext(rng);
      applyAction((actionBuf[<i32>((<u32>rng) % (<u32>count))]));
      transitions++;
    }
    checksum = fnv(checksum, evaluate());
    rewind(root);
  }
  outTransitions = transitions;
  return checksum;
}

// --- per-operation microbenchmarks (loop INSIDE the module, so no boundary in the timing) ------------

/** `iters` legal-action generations from one fixed position. */
export function benchGenerate(seed: i32, iters: i32): i32 {
  midGameState(seed);
  let sum = 0;
  for (let i = 0; i < iters; i++) sum += generateLegalActions();
  return sum;
}

/** `iters` leaf evaluations from one fixed position. */
export function benchEvaluate(seed: i32, iters: i32): i32 {
  midGameState(seed);
  let sum = 0;
  for (let i = 0; i < iters; i++) sum += evaluate();
  return sum;
}

/** `iters` × (apply one action, then undo it) from one fixed position. */
export function benchTransition(seed: i32, iters: i32): i32 {
  midGameState(seed);
  const count = generateLegalActions();
  const action = (actionBuf[count > 1 ? 1 : 0]);
  let sum = 0;
  for (let i = 0; i < iters; i++) {
    const m = mark();
    applyAction(action);
    sum += R(S_PASSES) + R(S_BF_COUNT);
    rewind(m);
  }
  return sum;
}

/** `iters` policy decisions (score the whole menu and pick) from one fixed position. */
export function benchDecide(seed: i32, iters: i32): i32 {
  midGameState(seed);
  let sum = 0;
  for (let i = 0; i < iters; i++) {
    const count = generateLegalActions();
    sum += chooseAction(count);
  }
  return sum;
}

// --- host channel ------------------------------------------------------------------------------------

export function getActions(): i32 {
  return outActions;
}
export function getGenerated(): i32 {
  return outGenerated;
}
export function getTurns(): i32 {
  return outTurns;
}
export function getWinner(): i32 {
  return outWinner;
}
export function getTransitions(): i32 {
  return outTransitions;
}
export function setJournalEnabled(on: i32): void {
  journalEnabled = on != 0;
  journalTop = 0;
}
export function arenaSize(): i32 {
  return ARENA_SIZE;
}
/** Byte offset of the arena in linear memory — used to measure state copy-out cost. */
export function arenaPtr(): i32 {
  return arena.dataStart as i32;
}
/** A do-nothing export: the host times a loop of these to price ONE boundary crossing. */
export function noop(x: i32): i32 {
  return x;
}
