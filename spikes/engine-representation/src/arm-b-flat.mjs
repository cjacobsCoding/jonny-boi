/**
 * ARM B — the ESSENTIAL CONTROL: the same rules, the same policy, the same action
 * order, but a FLAT representation.
 *
 * Everything that differs from arm A is a data-layout choice, not a language or a
 * rules change:
 *
 *   1. the whole game state is ONE `Int32Array` arena addressed by fixed offsets
 *      (`layout.mjs`), struct-of-arrays across instances;
 *   2. state transitions are UNDONE with a delta journal rather than reconstructed
 *      by cloning — every write records (address, previous value), and `rewind`
 *      replays it backwards;
 *   3. `generateLegalActions` writes PACKED i32 actions into a preallocated buffer
 *      and returns a count, so a decision allocates nothing;
 *   4. no object is created anywhere on the hot path.
 *
 * Deliberately NOT flattered: **every write is journalled in every workload**,
 * including the full-game playout where nothing is ever undone. Making the journal
 * conditional would buy arm B a few percent it does not need and would make the
 * playout and search numbers incomparable to each other. The playout loop simply
 * truncates the journal each action.
 *
 * The port to AssemblyScript (arm C) is line-for-line from this file, and the
 * equivalence gate proves the port is faithful by comparing full game transcripts.
 */

import {
  ACT_CAST_SPELL,
  ACT_DECLARE_ATTACKERS,
  ACT_DECLARE_BLOCKERS,
  ACT_PASS,
  ACT_PLAY_LAND,
  ACT_TAP_FOR_MANA,
  ACTION_CAP,
  ATTACK_ALL,
  ATTACK_PROFITABLE,
  BLOCK_GREEDY,
  BLOCK_NONE,
  CAP_ACTIONS,
  CARD_AMOUNT,
  CARD_COST,
  CARD_KEYWORDS,
  CARD_KIND,
  CARD_POWER,
  CARD_PRODUCES,
  CARD_STRIDE,
  CARD_TARGET,
  CARD_TIMING,
  CARD_TOUGHNESS,
  COST_GENERIC,
  DECKS,
  DECK_SIZE,
  KIND_BOLT,
  KIND_CREATURE,
  KIND_LAND,
  KW_DEATHTOUCH,
  KW_FLYING,
  KW_HASTE,
  KW_LIFELINK,
  KW_VIGILANCE,
  MAX_INSTANCES,
  MAX_LANDS_PER_TURN,
  MAX_TURNS,
  NUM_COLORS,
  OPENING_HAND,
  POOL_COLORLESS,
  POOL_SLOTS,
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
  TARGET_ANY,
  TARGET_NONE,
  TARGET_NOTHING,
  TARGET_PLAYER_0,
  TIMING_INSTANT,
  actExtra,
  actInstance,
  actKind,
  actTarget,
  digestInstance,
  flatCardTable,
  fnv,
  packAction,
  rngNext,
} from './spec.mjs';

import {
  ARENA_SIZE,
  ATK_LIST,
  BF_BASE,
  BLK_LIST,
  BLK_OF,
  CAP_JOURNAL,
  CONT_DPOWER,
  CONT_DTOUGH,
  CONT_TARGET,
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
  LIB_BASE,
  LIB_STRIDE,
  PLAYERS_BASE,
  PLAYER_STRIDE,
  P_GY_COUNT,
  P_HAND_COUNT,
  P_HAS_LOST,
  P_LANDS_PLAYED,
  P_LIB_COUNT,
  P_LIFE,
  P_POOL,
  S_ACTIVE,
  S_ATTACKERS_DECLARED,
  S_ATTACKER_COUNT,
  S_BF_COUNT,
  S_BLOCKERS_DECLARED,
  S_BLOCK_COUNT,
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
  STK_CARD,
  STK_CONTROLLER,
  STK_TARGET,
  ZONE_BATTLEFIELD,
  ZONE_GRAVEYARD,
  ZONE_HAND,
  ZONE_LIBRARY,
  ZONE_STACK,
} from './layout.mjs';

// --- the arena and the undo journal -------------------------------------------------

export const arena = new Int32Array(ARENA_SIZE);
const cards = flatCardTable();
const journalAddr = new Int32Array(CAP_JOURNAL);
const journalPrev = new Int32Array(CAP_JOURNAL);
let journalTop = 0;
const actionBuf = new Int32Array(CAP_ACTIONS);
/** Scratch for the greedy block builder — avoids a Set allocation per call. */
const usedMark = new Int32Array(MAX_INSTANCES);
let usedGen = 0;

/**
 * When false, writes skip the journal entirely and `rewind` is unavailable.
 *
 * This exists because the two workloads want different things and conflating them
 * would hide the answer. A forward-only playout never undoes anything, so its
 * journal is pure overhead; a search undoes constantly, and the journal is the
 * whole reason it does not have to clone. Reporting both settings separates "what
 * does the flat LAYOUT cost/save?" from "what does UNDO cost/save?".
 */
let journalEnabled = true;
export function setJournalEnabled(on) {
  journalEnabled = on;
  journalTop = 0;
}

/** The ONLY way the arena is mutated. */
function W(addr, val) {
  if (journalEnabled) {
    journalAddr[journalTop] = addr;
    journalPrev[journalTop] = arena[addr];
    journalTop++;
  }
  arena[addr] = val;
}

export function mark() {
  return journalTop;
}

/** Undo every write made since `m`, in reverse order. */
export function rewind(m) {
  while (journalTop > m) {
    journalTop--;
    arena[journalAddr[journalTop]] = journalPrev[journalTop];
  }
}

export function resetJournal() {
  journalTop = 0;
}

// --- accessors -----------------------------------------------------------------------

function pbase(p) {
  return PLAYERS_BASE + p * PLAYER_STRIDE;
}
/**
 * The instance's card row, as a PRE-MULTIPLIED offset into the card table rather
 * than a card index.
 *
 * Storing the offset instead of the index is not micro-tuning — it was worth 1.35x
 * on the whole arm when measured. A flat layout reads card fields through one more
 * indirection than an object graph does (`inst.def.power` is two pointer loads that
 * V8's inline caches make nearly free), so if every field read also pays a multiply
 * the flat arm loses on the engine's single most common operation. Folding the
 * multiply into the stored value makes a card-field read one add and one load.
 */
function cardOf(instanceId) {
  return arena[I_DEF + instanceId];
}
function cf(defBase, field) {
  return cards[defBase + field];
}

// --- list primitives -------------------------------------------------------------------

function listPush(base, countAddr, id) {
  const n = arena[countAddr];
  W(base + n, id);
  W(countAddr, n + 1);
}

/** Remove index `i`, shifting the tail down — the same semantics as `Array.splice`. */
function listRemoveAt(base, countAddr, i) {
  const n = arena[countAddr];
  for (let k = i; k < n - 1; k++) W(base + k, arena[base + k + 1]);
  W(countAddr, n - 1);
}

function listIndexOf(base, count, id) {
  for (let i = 0; i < count; i++) if (arena[base + i] === id) return i;
  return -1;
}

// --- construction ------------------------------------------------------------------------

export function createGame(seed) {
  arena.fill(0);
  journalTop = 0;
  arena[S_TURN] = 1;
  arena[S_STEP] = STEP_MAIN1;
  arena[S_WINNER] = -1;
  arena[S_RNG] = seed | 0;
  for (let p = 0; p < 2; p++) {
    const pb = pbase(p);
    arena[pb + P_LIFE] = STARTING_LIFE;
  }

  for (let p = 0; p < 2; p++) {
    const deck = DECKS[p];
    const pb = pbase(p);
    const lib = LIB_BASE + p * LIB_STRIDE;
    for (let i = 0; i < DECK_SIZE; i++) {
      const id = p * DECK_SIZE + i;
      arena[I_DEF + id] = deck[i] * CARD_STRIDE;
      arena[I_OWNER + id] = p;
      arena[I_CONTROLLER + id] = p;
      arena[I_ZONE + id] = ZONE_LIBRARY;
      arena[lib + i] = id;
    }
    arena[pb + P_LIB_COUNT] = DECK_SIZE;
    // Fisher-Yates in the same direction, from the same stream, as arm A.
    for (let i = DECK_SIZE - 1; i > 0; i--) {
      arena[S_RNG] = rngNext(arena[S_RNG]);
      const j = (arena[S_RNG] >>> 0) % (i + 1);
      const t = arena[lib + i];
      arena[lib + i] = arena[lib + j];
      arena[lib + j] = t;
    }
    for (let i = 0; i < OPENING_HAND; i++) drawCard(p);
  }
  journalTop = 0;
}

function drawCard(p) {
  const pb = pbase(p);
  const n = arena[pb + P_LIB_COUNT];
  if (n === 0) {
    W(pb + P_HAS_LOST, 1);
    return;
  }
  const id = arena[LIB_BASE + p * LIB_STRIDE + (n - 1)];
  W(pb + P_LIB_COUNT, n - 1);
  W(I_ZONE + id, ZONE_HAND);
  listPush(HAND_BASE + p * HAND_STRIDE, pb + P_HAND_COUNT, id);
}

// --- effective characteristics ---------------------------------------------------------

/** Printed base layered over the continuous-effect list — the same walk arm A does. */
function effPower(id) {
  let v = cf(cardOf(id), CARD_POWER);
  const n = arena[S_CONT_COUNT];
  for (let i = 0; i < n; i++) if (arena[CONT_TARGET + i] === id) v += arena[CONT_DPOWER + i];
  return v;
}

function effToughness(id) {
  let v = cf(cardOf(id), CARD_TOUGHNESS);
  const n = arena[S_CONT_COUNT];
  for (let i = 0; i < n; i++) if (arena[CONT_TARGET + i] === id) v += arena[CONT_DTOUGH + i];
  return v;
}

// --- mana --------------------------------------------------------------------------------

function canPayFrom(poolBase, defIdx) {
  let spare = arena[poolBase + POOL_COLORLESS];
  for (let c = 0; c < NUM_COLORS; c++) {
    const need = cf(defIdx, CARD_COST + 1 + c);
    const have = arena[poolBase + c];
    if (have < need) return false;
    spare += have - need;
  }
  return spare >= cf(defIdx, CARD_COST + COST_GENERIC);
}

function payCost(poolBase, defIdx) {
  for (let c = 0; c < NUM_COLORS; c++) {
    W(poolBase + c, arena[poolBase + c] - cf(defIdx, CARD_COST + 1 + c));
  }
  let generic = cf(defIdx, CARD_COST + COST_GENERIC);
  const cl = arena[poolBase + POOL_COLORLESS];
  const take = generic < cl ? generic : cl;
  W(poolBase + POOL_COLORLESS, cl - take);
  generic -= take;
  for (let c = 0; c < NUM_COLORS && generic > 0; c++) {
    const have = arena[poolBase + c];
    const t = generic < have ? generic : have;
    W(poolBase + c, have - t);
    generic -= t;
  }
}

function emptyManaPools() {
  for (let p = 0; p < 2; p++) {
    const pb = pbase(p) + P_POOL;
    for (let i = 0; i < POOL_SLOTS; i++) if (arena[pb + i] !== 0) W(pb + i, 0);
  }
}

// --- legal action generation ---------------------------------------------------------------

/**
 * Emits packed i32 actions into the shared buffer and returns the count. Allocates
 * nothing. The EMISSION ORDER is identical to arm A's, which is what lets a shared
 * policy pick the same action by the same lowest-index tie-break.
 */
export function generateLegalActions() {
  if (arena[S_GAME_OVER] !== 0) return 0;
  const me = arena[S_PRIORITY];
  const pb = pbase(me);
  let n = 0;

  actionBuf[n++] = packAction(ACT_PASS, 0, TARGET_NOTHING, 0);

  const bfCount = arena[S_BF_COUNT];
  for (let b = 0; b < bfCount; b++) {
    const id = arena[BF_BASE + b];
    if (arena[I_CONTROLLER + id] !== me || arena[I_TAPPED + id] !== 0) continue;
    if (cf(cardOf(id), CARD_KIND) !== KIND_LAND) continue;
    actionBuf[n++] = packAction(ACT_TAP_FOR_MANA, id, TARGET_NOTHING, 0);
  }

  const step = arena[S_STEP];
  const sorcerySpeed =
    me === arena[S_ACTIVE] && (step === STEP_MAIN1 || step === STEP_MAIN2) && arena[S_STACK_COUNT] === 0;
  const handBase = HAND_BASE + me * HAND_STRIDE;
  const handCount = arena[pb + P_HAND_COUNT];

  if (sorcerySpeed && arena[pb + P_LANDS_PLAYED] < MAX_LANDS_PER_TURN) {
    for (let h = 0; h < handCount; h++) {
      const id = arena[handBase + h];
      if (cf(cardOf(id), CARD_KIND) === KIND_LAND) {
        actionBuf[n++] = packAction(ACT_PLAY_LAND, id, TARGET_NOTHING, 0);
      }
    }
  }

  for (let h = 0; h < handCount; h++) {
    const id = arena[handBase + h];
    const def = cardOf(id);
    if (cf(def, CARD_KIND) === KIND_LAND) continue;
    const timingOk = cf(def, CARD_TIMING) === TIMING_INSTANT ? true : sorcerySpeed;
    if (!timingOk) continue;
    if (!canPayFrom(pb + P_POOL, def)) continue;
    const restriction = cf(def, CARD_TARGET);
    if (restriction === TARGET_NONE) {
      actionBuf[n++] = packAction(ACT_CAST_SPELL, id, TARGET_NOTHING, 0);
      continue;
    }
    for (let b = 0; b < bfCount; b++) {
      const t = arena[BF_BASE + b];
      if (cf(cardOf(t), CARD_KIND) !== KIND_CREATURE) continue;
      actionBuf[n++] = packAction(ACT_CAST_SPELL, id, t, 0);
    }
    if (restriction === TARGET_ANY) {
      actionBuf[n++] = packAction(ACT_CAST_SPELL, id, TARGET_PLAYER_0, 0);
      actionBuf[n++] = packAction(ACT_CAST_SPELL, id, TARGET_PLAYER_0 + 1, 0);
    }
  }

  if (
    step === STEP_DECLARE_ATTACKERS &&
    me === arena[S_ACTIVE] &&
    arena[S_COMBAT_ACTIVE] !== 0 &&
    arena[S_ATTACKERS_DECLARED] === 0 &&
    countEligibleAttackers(me) > 0
  ) {
    actionBuf[n++] = packAction(ACT_DECLARE_ATTACKERS, 0, TARGET_NOTHING, ATTACK_ALL);
    actionBuf[n++] = packAction(ACT_DECLARE_ATTACKERS, 0, TARGET_NOTHING, ATTACK_PROFITABLE);
  }

  if (
    step === STEP_DECLARE_BLOCKERS &&
    me !== arena[S_ACTIVE] &&
    arena[S_COMBAT_ACTIVE] !== 0 &&
    arena[S_ATTACKERS_DECLARED] !== 0 &&
    arena[S_BLOCKERS_DECLARED] === 0
  ) {
    actionBuf[n++] = packAction(ACT_DECLARE_BLOCKERS, 0, TARGET_NOTHING, BLOCK_NONE);
    if (arena[S_ATTACKER_COUNT] > 0) {
      actionBuf[n++] = packAction(ACT_DECLARE_BLOCKERS, 0, TARGET_NOTHING, BLOCK_GREEDY);
    }
  }

  return n;
}

export function actionAt(i) {
  return actionBuf[i];
}

function isEligibleAttacker(id, me) {
  if (arena[I_CONTROLLER + id] !== me) return false;
  const def = cardOf(id);
  if (cf(def, CARD_KIND) !== KIND_CREATURE || arena[I_TAPPED + id] !== 0) return false;
  if (arena[I_SICK + id] !== 0 && (cf(def, CARD_KEYWORDS) & KW_HASTE) === 0) return false;
  return true;
}

function countEligibleAttackers(me) {
  let n = 0;
  const bfCount = arena[S_BF_COUNT];
  for (let b = 0; b < bfCount; b++) if (isEligibleAttacker(arena[BF_BASE + b], me)) n++;
  return n;
}

function bestDefenderPower(defender) {
  let best = 0;
  const bfCount = arena[S_BF_COUNT];
  for (let b = 0; b < bfCount; b++) {
    const id = arena[BF_BASE + b];
    if (arena[I_CONTROLLER + id] !== defender) continue;
    if (cf(cardOf(id), CARD_KIND) !== KIND_CREATURE || arena[I_TAPPED + id] !== 0) continue;
    const p = effPower(id);
    if (p > best) best = p;
  }
  return best;
}

/**
 * Writes the declared attacker set straight into the combat list. Called by BOTH
 * scoring and application, exactly as in arm A — scoring writes it speculatively
 * and application overwrites it, which is safe because scoring always precedes the
 * apply for the action that wins.
 */
function buildAttackers(me, variant) {
  const threat = variant === ATTACK_PROFITABLE ? bestDefenderPower(1 - me) : -1;
  let n = 0;
  const bfCount = arena[S_BF_COUNT];
  for (let b = 0; b < bfCount; b++) {
    const id = arena[BF_BASE + b];
    if (!isEligibleAttacker(id, me)) continue;
    if (variant === ATTACK_PROFITABLE && effToughness(id) <= threat) continue;
    W(ATK_LIST + n, id);
    n++;
  }
  W(S_ATTACKER_COUNT, n);
  return n;
}

/** The greedy block assignment, ported literally from arm A. */
function buildBlocks(me) {
  usedGen++;
  let n = 0;
  const atkCount = arena[S_ATTACKER_COUNT];
  const bfCount = arena[S_BF_COUNT];
  for (let a = 0; a < atkCount; a++) {
    const attacker = arena[ATK_LIST + a];
    if (arena[I_ZONE + attacker] !== ZONE_BATTLEFIELD) continue;
    const atkDef = cardOf(attacker);
    const atkFlying = (cf(atkDef, CARD_KEYWORDS) & KW_FLYING) !== 0;
    const atkDeathtouch = (cf(atkDef, CARD_KEYWORDS) & KW_DEATHTOUCH) !== 0;
    const atkPower = effPower(attacker);
    let chosen = -1;
    let chosenTough = 0;
    for (let b = 0; b < bfCount; b++) {
      const id = arena[BF_BASE + b];
      if (arena[I_CONTROLLER + id] !== me) continue;
      const def = cardOf(id);
      if (cf(def, CARD_KIND) !== KIND_CREATURE || arena[I_TAPPED + id] !== 0) continue;
      if (usedMark[id] === usedGen) continue;
      if (atkFlying && (cf(def, CARD_KEYWORDS) & KW_FLYING) === 0) continue;
      const t = effToughness(id);
      const survives = t > atkPower && !atkDeathtouch;
      if (chosen === -1 || (survives && chosenTough <= atkPower) || (survives && t < chosenTough)) {
        chosen = id;
        chosenTough = t;
      }
    }
    if (chosen !== -1) {
      usedMark[chosen] = usedGen;
      W(BLK_LIST + n, chosen);
      W(BLK_OF + n, attacker);
      n++;
    }
  }
  W(S_BLOCK_COUNT, n);
  return n;
}

// --- action application -----------------------------------------------------------------

export function applyAction(action) {
  if (arena[S_GAME_OVER] !== 0) return;
  const me = arena[S_PRIORITY];
  const pb = pbase(me);
  const kind = actKind(action);
  const inst = actInstance(action);
  const target = actTarget(action);
  const extra = actExtra(action);

  if (kind === ACT_PASS) {
    const passes = arena[S_PASSES] + 1;
    if (passes >= 2) {
      W(S_PASSES, 0);
      if (arena[S_STACK_COUNT] > 0) {
        resolveTopOfStack();
        W(S_PRIORITY, arena[S_ACTIVE]);
      } else {
        advanceStep();
      }
    } else {
      W(S_PASSES, passes);
      W(S_PRIORITY, 1 - me);
    }
  } else if (kind === ACT_PLAY_LAND) {
    const handBase = HAND_BASE + me * HAND_STRIDE;
    const idx = listIndexOf(handBase, arena[pb + P_HAND_COUNT], inst);
    if (idx >= 0) {
      listRemoveAt(handBase, pb + P_HAND_COUNT, idx);
      W(I_ZONE + inst, ZONE_BATTLEFIELD);
      W(I_TAPPED + inst, 0);
      W(I_SICK + inst, 1);
      listPush(BF_BASE, S_BF_COUNT, inst);
      W(pb + P_LANDS_PLAYED, arena[pb + P_LANDS_PLAYED] + 1);
      W(S_PASSES, 0);
    }
  } else if (kind === ACT_TAP_FOR_MANA) {
    if (arena[I_ZONE + inst] === ZONE_BATTLEFIELD && arena[I_TAPPED + inst] === 0) {
      W(I_TAPPED + inst, 1);
      const color = cf(cardOf(inst), CARD_PRODUCES);
      W(pb + P_POOL + color, arena[pb + P_POOL + color] + 1);
      W(S_PASSES, 0);
    }
  } else if (kind === ACT_CAST_SPELL) {
    const handBase = HAND_BASE + me * HAND_STRIDE;
    const idx = listIndexOf(handBase, arena[pb + P_HAND_COUNT], inst);
    if (idx >= 0) {
      const def = cardOf(inst);
      if (canPayFrom(pb + P_POOL, def)) {
        payCost(pb + P_POOL, def);
        listRemoveAt(handBase, pb + P_HAND_COUNT, idx);
        W(I_ZONE + inst, ZONE_STACK);
        const sc = arena[S_STACK_COUNT];
        W(STK_CARD + sc, inst);
        W(STK_CONTROLLER + sc, me);
        W(STK_TARGET + sc, target);
        W(S_STACK_COUNT, sc + 1);
        W(S_PASSES, 0);
        W(S_PRIORITY, me);
      }
    }
  } else if (kind === ACT_DECLARE_ATTACKERS) {
    const n = buildAttackers(me, extra);
    W(S_ATTACKERS_DECLARED, 1);
    for (let i = 0; i < n; i++) {
      const id = arena[ATK_LIST + i];
      if ((cf(cardOf(id), CARD_KEYWORDS) & KW_VIGILANCE) === 0) W(I_TAPPED + id, 1);
    }
    W(S_PASSES, 0);
  } else if (kind === ACT_DECLARE_BLOCKERS) {
    if (extra === BLOCK_GREEDY) buildBlocks(me);
    else W(S_BLOCK_COUNT, 0);
    W(S_BLOCKERS_DECLARED, 1);
    W(S_PASSES, 0);
  }

  checkStateBasedActions();
}

function resolveTopOfStack() {
  const sc = arena[S_STACK_COUNT] - 1;
  const id = arena[STK_CARD + sc];
  const controller = arena[STK_CONTROLLER + sc];
  const target = arena[STK_TARGET + sc];
  W(S_STACK_COUNT, sc);
  const def = cardOf(id);
  const kind = cf(def, CARD_KIND);

  if (kind === KIND_CREATURE) {
    W(I_ZONE + id, ZONE_BATTLEFIELD);
    W(I_CONTROLLER + id, controller);
    W(I_TAPPED + id, 0);
    W(I_SICK + id, (cf(def, CARD_KEYWORDS) & KW_HASTE) === 0 ? 1 : 0);
    W(I_DAMAGE + id, 0);
    W(I_DEATHTOUCHED + id, 0);
    listPush(BF_BASE, S_BF_COUNT, id);
    return;
  }

  const restriction = cf(def, CARD_TARGET);
  if (restriction !== TARGET_NONE && target < TARGET_PLAYER_0) {
    // Fizzles if the only target has left the battlefield.
    if (arena[I_ZONE + target] === ZONE_BATTLEFIELD) {
      if (kind === KIND_BOLT) {
        W(I_DAMAGE + target, arena[I_DAMAGE + target] + cf(def, CARD_AMOUNT));
      } else {
        const cn = arena[S_CONT_COUNT];
        W(CONT_TARGET + cn, target);
        W(CONT_DPOWER + cn, cf(def, CARD_AMOUNT));
        W(CONT_DTOUGH + cn, cf(def, CARD_AMOUNT));
        W(S_CONT_COUNT, cn + 1);
      }
    }
  } else if (kind === KIND_BOLT && target >= TARGET_PLAYER_0) {
    const vb = pbase(target - TARGET_PLAYER_0);
    W(vb + P_LIFE, arena[vb + P_LIFE] - cf(def, CARD_AMOUNT));
  }

  const owner = arena[I_OWNER + id];
  W(I_ZONE + id, ZONE_GRAVEYARD);
  listPush(GY_BASE + owner * GY_STRIDE, pbase(owner) + P_GY_COUNT, id);
}

function checkStateBasedActions() {
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = arena[S_BF_COUNT] - 1; i >= 0; i--) {
      const id = arena[BF_BASE + i];
      if (cf(cardOf(id), CARD_KIND) !== KIND_CREATURE) continue;
      const lethal = arena[I_DAMAGE + id] >= effToughness(id) || arena[I_DEATHTOUCHED + id] !== 0;
      if (!lethal) continue;
      listRemoveAt(BF_BASE, S_BF_COUNT, i);
      W(I_ZONE + id, ZONE_GRAVEYARD);
      W(I_DAMAGE + id, 0);
      W(I_DEATHTOUCHED + id, 0);
      const owner = arena[I_OWNER + id];
      listPush(GY_BASE + owner * GY_STRIDE, pbase(owner) + P_GY_COUNT, id);
      changed = true;
    }
  }
  for (let p = 0; p < 2; p++) {
    const pb = pbase(p);
    if (arena[pb + P_LIFE] <= 0 && arena[pb + P_HAS_LOST] === 0) W(pb + P_HAS_LOST, 1);
  }
  const aLost = arena[pbase(0) + P_HAS_LOST] !== 0;
  const bLost = arena[pbase(1) + P_HAS_LOST] !== 0;
  if (aLost || bLost) {
    W(S_GAME_OVER, 1);
    W(S_WINNER, aLost && bLost ? -1 : aLost ? 1 : 0);
  }
}

// --- turn structure -------------------------------------------------------------------

function advanceStep() {
  emptyManaPools();
  const step = arena[S_STEP] + 1;
  if (step > STEP_CLEANUP) {
    passTurn();
    return;
  }
  enterStep(step);
}

function passTurn() {
  const bfCount = arena[S_BF_COUNT];
  for (let i = 0; i < bfCount; i++) {
    const id = arena[BF_BASE + i];
    if (arena[I_DAMAGE + id] !== 0) W(I_DAMAGE + id, 0);
    if (arena[I_DEATHTOUCHED + id] !== 0) W(I_DEATHTOUCHED + id, 0);
  }
  W(S_CONT_COUNT, 0);
  W(S_COMBAT_ACTIVE, 0);
  W(S_ATTACKERS_DECLARED, 0);
  W(S_BLOCKERS_DECLARED, 0);
  W(S_ATTACKER_COUNT, 0);
  W(S_BLOCK_COUNT, 0);
  const turn = arena[S_TURN] + 1;
  W(S_TURN, turn);
  W(S_ACTIVE, 1 - arena[S_ACTIVE]);
  if (turn > MAX_TURNS) {
    W(S_GAME_OVER, 1);
    W(S_WINNER, -1);
    return;
  }
  enterStep(STEP_UNTAP);
}

function enterStep(step) {
  W(S_STEP, step);
  W(S_PRIORITY, arena[S_ACTIVE]);
  W(S_PASSES, 0);

  if (step === STEP_UNTAP) {
    const active = arena[S_ACTIVE];
    const bfCount = arena[S_BF_COUNT];
    for (let i = 0; i < bfCount; i++) {
      const id = arena[BF_BASE + i];
      if (arena[I_CONTROLLER + id] !== active) continue;
      if (arena[I_TAPPED + id] !== 0) W(I_TAPPED + id, 0);
      if (arena[I_SICK + id] !== 0) W(I_SICK + id, 0);
    }
    W(pbase(active) + P_LANDS_PLAYED, 0);
    enterStep(STEP_UPKEEP);
    return;
  }
  if (step === STEP_DRAW) {
    drawCard(arena[S_ACTIVE]);
    checkStateBasedActions();
    return;
  }
  if (step === STEP_DECLARE_ATTACKERS) {
    W(S_COMBAT_ACTIVE, 1);
    W(S_ATTACKER_COUNT, 0);
    W(S_BLOCK_COUNT, 0);
    W(S_ATTACKERS_DECLARED, 0);
    W(S_BLOCKERS_DECLARED, 0);
    return;
  }
  if (step === STEP_COMBAT_DAMAGE) {
    resolveCombatDamage();
    checkStateBasedActions();
    return;
  }
  if (step === STEP_CLEANUP) {
    passTurn();
  }
}

function resolveCombatDamage() {
  if (arena[S_COMBAT_ACTIVE] === 0 || arena[S_ATTACKERS_DECLARED] === 0) return;
  const defender = 1 - arena[S_ACTIVE];
  const atkCount = arena[S_ATTACKER_COUNT];
  const blkCount = arena[S_BLOCK_COUNT];

  for (let a = 0; a < atkCount; a++) {
    const attacker = arena[ATK_LIST + a];
    if (arena[I_ZONE + attacker] !== ZONE_BATTLEFIELD) continue;
    const def = cardOf(attacker);
    const kw = cf(def, CARD_KEYWORDS);
    const power = effPower(attacker);
    const deathtouch = (kw & KW_DEATHTOUCH) !== 0;
    const lifelink = (kw & KW_LIFELINK) !== 0;
    const ab = pbase(arena[I_CONTROLLER + attacker]);

    let assigned = 0;
    let remaining = power;
    for (let b = 0; b < blkCount; b++) {
      if (arena[BLK_OF + b] !== attacker) continue;
      const blocker = arena[BLK_LIST + b];
      if (arena[I_ZONE + blocker] !== ZONE_BATTLEFIELD) continue;
      assigned++;
      if (remaining > 0) {
        W(I_DAMAGE + blocker, arena[I_DAMAGE + blocker] + remaining);
        if (deathtouch) W(I_DEATHTOUCHED + blocker, 1);
        if (lifelink) W(ab + P_LIFE, arena[ab + P_LIFE] + remaining);
        remaining = 0;
      }
      const bPower = effPower(blocker);
      W(I_DAMAGE + attacker, arena[I_DAMAGE + attacker] + bPower);
      const bkw = cf(cardOf(blocker), CARD_KEYWORDS);
      if ((bkw & KW_DEATHTOUCH) !== 0) W(I_DEATHTOUCHED + attacker, 1);
      if ((bkw & KW_LIFELINK) !== 0) {
        const bb = pbase(arena[I_CONTROLLER + blocker]);
        W(bb + P_LIFE, arena[bb + P_LIFE] + bPower);
      }
    }

    if (assigned === 0 && power > 0) {
      const db = pbase(defender);
      W(db + P_LIFE, arena[db + P_LIFE] - power);
      if (lifelink) W(ab + P_LIFE, arena[ab + P_LIFE] + power);
    }
  }
}

// --- the policy -------------------------------------------------------------------------

/**
 * Scratch mana pool for the tap heuristic. NOT game state, so it lives outside the
 * arena and outside the journal — it is recomputed from scratch on every call and
 * never read across one.
 */
const potentialPool = new Int32Array(POOL_SLOTS);

function canPayScratch(defIdx) {
  let spare = potentialPool[POOL_COLORLESS];
  for (let c = 0; c < NUM_COLORS; c++) {
    const need = cf(defIdx, CARD_COST + 1 + c);
    const have = potentialPool[c];
    if (have < need) return false;
    spare += have - need;
  }
  return spare >= cf(defIdx, CARD_COST + COST_GENERIC);
}

function wantsToTap(me) {
  const step = arena[S_STEP];
  const sorcerySpeed =
    me === arena[S_ACTIVE] && (step === STEP_MAIN1 || step === STEP_MAIN2) && arena[S_STACK_COUNT] === 0;
  const defendingWithTrick =
    step === STEP_DECLARE_BLOCKERS && arena[S_COMBAT_ACTIVE] !== 0 && arena[S_ATTACKER_COUNT] > 0;
  if (!sorcerySpeed && !defendingWithTrick) return false;

  const pb = pbase(me);
  const poolBase = pb + P_POOL;
  for (let i = 0; i < POOL_SLOTS; i++) potentialPool[i] = arena[poolBase + i];
  const bfCount = arena[S_BF_COUNT];
  for (let b = 0; b < bfCount; b++) {
    const id = arena[BF_BASE + b];
    if (arena[I_CONTROLLER + id] !== me || arena[I_TAPPED + id] !== 0) continue;
    const def = cardOf(id);
    if (cf(def, CARD_KIND) !== KIND_LAND) continue;
    potentialPool[cf(def, CARD_PRODUCES)]++;
  }

  const handBase = HAND_BASE + me * HAND_STRIDE;
  const handCount = arena[pb + P_HAND_COUNT];
  for (let h = 0; h < handCount; h++) {
    const def = cardOf(arena[handBase + h]);
    if (cf(def, CARD_KIND) === KIND_LAND) continue;
    if (!sorcerySpeed && cf(def, CARD_TIMING) !== TIMING_INSTANT) continue;
    if (canPayFrom(poolBase, def)) continue;
    if (canPayScratch(def)) return true;
  }
  return false;
}

function creatureValue(def) {
  const kw = cf(def, CARD_KEYWORDS);
  let v = cf(def, CARD_POWER) * 2 + cf(def, CARD_TOUGHNESS);
  if ((kw & KW_FLYING) !== 0) v += 3;
  if ((kw & KW_LIFELINK) !== 0) v += 2;
  if ((kw & KW_DEATHTOUCH) !== 0) v += 3;
  if ((kw & KW_VIGILANCE) !== 0) v += 1;
  if ((kw & KW_HASTE) !== 0) v += 1;
  return v;
}

export function scoreAction(action) {
  const me = arena[S_PRIORITY];
  const kind = actKind(action);
  const inst = actInstance(action);
  const target = actTarget(action);
  const extra = actExtra(action);

  if (kind === ACT_PASS) return 0;
  if (kind === ACT_PLAY_LAND) return 500;
  if (kind === ACT_TAP_FOR_MANA) return wantsToTap(me) ? 300 : -1;

  if (kind === ACT_CAST_SPELL) {
    if (arena[I_ZONE + inst] !== ZONE_HAND) return -1000;
    const def = cardOf(inst);
    const k = cf(def, CARD_KIND);
    if (k === KIND_CREATURE) return 1000 + creatureValue(def);
    const amount = cf(def, CARD_AMOUNT);
    if (k === KIND_BOLT) {
      if (target >= TARGET_PLAYER_0) {
        const victim = target - TARGET_PLAYER_0;
        if (victim === me) return -1000;
        return arena[pbase(victim) + P_LIFE] <= amount ? 5000 : 1000 + amount;
      }
      if (arena[I_ZONE + target] !== ZONE_BATTLEFIELD || arena[I_CONTROLLER + target] === me) return -1000;
      return effToughness(target) - arena[I_DAMAGE + target] <= amount
        ? 1200 + creatureValue(cardOf(target))
        : 1000 + amount;
    }
    // PUMP
    if (arena[I_ZONE + target] !== ZONE_BATTLEFIELD || arena[I_CONTROLLER + target] !== me) return -1000;
    return arena[S_STEP] === STEP_DECLARE_BLOCKERS ? 1100 + amount : 1001;
  }

  if (kind === ACT_DECLARE_ATTACKERS) {
    const before = mark();
    const n = buildAttackers(me, extra);
    const threat = bestDefenderPower(1 - me);
    let score = 190;
    for (let i = 0; i < n; i++) {
      const id = arena[ATK_LIST + i];
      score += effPower(id);
      if (effToughness(id) <= threat) score -= 2;
    }
    rewind(before);
    return score;
  }

  if (kind === ACT_DECLARE_BLOCKERS) {
    if (extra === BLOCK_NONE) {
      let incoming = 0;
      const atkCount = arena[S_ATTACKER_COUNT];
      for (let i = 0; i < atkCount; i++) {
        const id = arena[ATK_LIST + i];
        if (arena[I_ZONE + id] === ZONE_BATTLEFIELD) incoming += effPower(id);
      }
      return 100 + (arena[pbase(me) + P_LIFE] > incoming ? 0 : -50);
    }
    const before = mark();
    const n = buildBlocks(me);
    let score = 100;
    for (let i = 0; i < n; i++) {
      const blocker = arena[BLK_LIST + i];
      const attacker = arena[BLK_OF + i];
      const aPow = effPower(attacker);
      score += aPow;
      if (effToughness(blocker) <= aPow || (cf(cardOf(attacker), CARD_KEYWORDS) & KW_DEATHTOUCH) !== 0) {
        score -= creatureValue(cardOf(blocker));
      }
      if (effToughness(attacker) <= effPower(blocker)) score += creatureValue(cardOf(attacker));
    }
    rewind(before);
    return score;
  }
  return 0;
}

export function chooseAction(count) {
  let best = 0;
  let bestScore = -0x7fffffff;
  for (let i = 0; i < count; i++) {
    const s = scoreAction(actionBuf[i]);
    if (s > bestScore) {
      bestScore = s;
      best = i;
    }
  }
  return best;
}

// --- leaf evaluation -----------------------------------------------------------------------

export function evaluate() {
  let v = (arena[pbase(0) + P_LIFE] - arena[pbase(1) + P_LIFE]) * 3;
  const bfCount = arena[S_BF_COUNT];
  for (let i = 0; i < bfCount; i++) {
    const id = arena[BF_BASE + i];
    if (cf(cardOf(id), CARD_KIND) !== KIND_CREATURE) continue;
    const side = arena[I_CONTROLLER + id] === 0 ? 1 : -1;
    v += side * (effPower(id) + effToughness(id)) * 2;
  }
  v += (arena[pbase(0) + P_HAND_COUNT] - arena[pbase(1) + P_HAND_COUNT]) * 1;
  return v;
}

// --- workloads -------------------------------------------------------------------------------

export function playGame(seed) {
  createGame(seed);
  let digest = 0x811c9dc5 | 0;
  let actions = 0;
  let generated = 0;
  while (arena[S_GAME_OVER] === 0 && actions < ACTION_CAP) {
    journalTop = 0;
    const count = generateLegalActions();
    if (count === 0) break;
    generated += count;
    const a = actionBuf[chooseAction(count)];
    digest = fnv(digest, actKind(a));
    digest = fnv(digest, digestInstance(actKind(a), actInstance(a)));
    digest = fnv(digest, actTarget(a));
    digest = fnv(digest, actExtra(a));
    digest = fnv(digest, arena[S_STEP]);
    digest = fnv(digest, arena[S_PRIORITY]);
    digest = fnv(digest, arena[pbase(0) + P_LIFE]);
    digest = fnv(digest, arena[pbase(1) + P_LIFE]);
    digest = fnv(digest, arena[S_BF_COUNT]);
    applyAction(a);
    actions++;
  }
  digest = fnv(digest, arena[S_WINNER]);
  digest = fnv(digest, arena[S_TURN]);
  return { digest, actions, generated, turns: arena[S_TURN], winner: arena[S_WINNER] };
}

export const MIDGAME_ACTIONS = 300;

export function midGameState(seed) {
  createGame(seed);
  for (let i = 0; i < MIDGAME_ACTIONS && arena[S_GAME_OVER] === 0; i++) {
    journalTop = 0;
    const count = generateLegalActions();
    if (count === 0) break;
    applyAction(actionBuf[chooseAction(count)]);
  }
  journalTop = 0;
}

/**
 * The SEARCH workload. Where arm A must clone the root before every playout, this
 * marks the journal and REWINDS it — the whole point of the representation change.
 */
export function searchWorkload(seed, rollouts, depth) {
  midGameState(seed);
  let rng = (seed * 2654435761) | 0;
  let checksum = 0x811c9dc5 | 0;
  let transitions = 0;
  for (let r = 0; r < rollouts; r++) {
    const root = mark();
    for (let d = 0; d < depth; d++) {
      if (arena[S_GAME_OVER] !== 0) break;
      const count = generateLegalActions();
      if (count === 0) break;
      rng = rngNext(rng);
      applyAction(actionBuf[(rng >>> 0) % count]);
      transitions++;
    }
    checksum = fnv(checksum, evaluate());
    rewind(root);
  }
  return { checksum, transitions };
}

// --- per-operation microbenchmarks (mirrors of arm A's and arm C's) -----------------------

export function benchGenerate(seed, iters) {
  midGameState(seed);
  let sum = 0;
  for (let i = 0; i < iters; i++) sum += generateLegalActions();
  return sum;
}

export function benchEvaluate(seed, iters) {
  midGameState(seed);
  let sum = 0;
  for (let i = 0; i < iters; i++) sum += evaluate();
  return sum;
}

/** `iters` UNDOABLE transitions: apply, read, rewind. No clone, no allocation. */
export function benchTransition(seed, iters) {
  midGameState(seed);
  const count = generateLegalActions();
  const action = actionBuf[count > 1 ? 1 : 0];
  let sum = 0;
  for (let i = 0; i < iters; i++) {
    const m = mark();
    applyAction(action);
    sum += arena[S_PASSES] + arena[S_BF_COUNT];
    rewind(m);
  }
  return sum;
}

export function benchDecide(seed, iters) {
  midGameState(seed);
  let sum = 0;
  for (let i = 0; i < iters; i++) {
    const count = generateLegalActions();
    sum += chooseAction(count);
  }
  return sum;
}
