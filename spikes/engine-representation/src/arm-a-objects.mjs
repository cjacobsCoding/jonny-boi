/**
 * ARM A — the BASELINE: an object-graph engine in the same style as `packages/core`.
 *
 * This arm exists to be the control for representation, so it deliberately copies
 * the shipped engine's DATA HABITS rather than being written the fastest way an
 * object-oriented engine could be:
 *
 *   - a `CardInstance` OBJECT per card, carrying a reference to its definition;
 *   - ordered zone ARRAYS of those objects (`library`, `hand`, `battlefield`, ...);
 *   - `generateLegalActions` returning a freshly allocated array of freshly
 *     allocated action objects;
 *   - a `continuous` array of effect objects that effective P/T is layered over;
 *   - `cloneState` — a structural deep copy — as the way to get a state you may
 *     mutate, next to an `applyActionInPlace` that mutates the caller's own state
 *     (both entry points exist in `packages/core` for the same reason);
 *   - an `events` array appended to during a transition.
 *
 * Every one of those is a real habit of the shipped engine, and every one of them
 * is what arm B changes. Nothing here is a straw man: the array walks are indexed
 * rather than `for...of` for exactly the reason `engine.ts` documents (V8 does not
 * reliably elide the iterator object on this path), and the empty-counters trick
 * the real engine uses is not needed because the model has no counters.
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
  CARDS,
  COST_GENERIC,
  DECKS,
  KIND_BOLT,
  KIND_CREATURE,
  KIND_LAND,
  KIND_PUMP,
  KW_DEATHTOUCH,
  KW_FLYING,
  KW_HASTE,
  KW_LIFELINK,
  KW_VIGILANCE,
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
  STEP_UNTAP,
  STEP_UPKEEP,
  TARGET_ANY,
  TARGET_NONE,
  TARGET_NOTHING,
  TARGET_PLAYER_0,
  TIMING_INSTANT,
  digestInstance,
  fnv,
  isMainStep,
  rngNext,
} from './spec.mjs';

// --- state construction ---------------------------------------------------------

function makeInstance(instanceId, def, owner) {
  return {
    instanceId,
    def,
    owner,
    controller: owner,
    zone: 'library',
    tapped: false,
    summoningSick: false,
    damageMarked: 0,
    markedByDeathtouch: false,
  };
}

function createPlayer(id) {
  return {
    id,
    life: STARTING_LIFE,
    manaPool: new Array(POOL_SLOTS).fill(0),
    landsPlayedThisTurn: 0,
    hasLost: false,
    library: [],
    hand: [],
    graveyard: [],
  };
}

export function createGame(seed) {
  const state = {
    turnNumber: 1,
    activePlayer: 0,
    priorityPlayer: 0,
    step: STEP_MAIN1,
    players: [createPlayer(0), createPlayer(1)],
    battlefield: [],
    stack: [],
    continuous: [],
    combat: null,
    winner: -1,
    gameOver: false,
    consecutivePasses: 0,
    rngState: seed | 0,
    events: [],
  };

  for (let p = 0; p < 2; p++) {
    const deck = DECKS[p];
    const player = state.players[p];
    for (let i = 0; i < deck.length; i++) {
      player.library.push(makeInstance(p * deck.length + i, CARDS[deck[i]], p));
    }
    shuffle(state, player.library);
    for (let i = 0; i < OPENING_HAND; i++) drawCard(state, p);
  }
  // The player on the play skips their first draw step; the model reaches main1
  // directly on turn 1, so nothing else is needed here.
  return state;
}

function shuffle(state, arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    state.rngState = rngNext(state.rngState);
    const j = (state.rngState >>> 0) % (i + 1);
    const t = arr[i];
    arr[i] = arr[j];
    arr[j] = t;
  }
}

function drawCard(state, p) {
  const player = state.players[p];
  const card = player.library.pop();
  if (card === undefined) {
    player.hasLost = true;
    return;
  }
  card.zone = 'hand';
  player.hand.push(card);
}

// --- cloning (the shipped engine's `cloneState`) --------------------------------

function cloneInstance(inst) {
  return {
    instanceId: inst.instanceId,
    def: inst.def,
    owner: inst.owner,
    controller: inst.controller,
    zone: inst.zone,
    tapped: inst.tapped,
    summoningSick: inst.summoningSick,
    damageMarked: inst.damageMarked,
    markedByDeathtouch: inst.markedByDeathtouch,
  };
}

function cloneZone(zone) {
  const out = new Array(zone.length);
  for (let i = 0; i < zone.length; i++) out[i] = cloneInstance(zone[i]);
  return out;
}

/**
 * A structural deep copy, the way `packages/core/src/internal/clone.ts` does it.
 * Note the instance identity problem this creates and that the real engine has
 * too: battlefield instances are copied independently of the zone arrays, so the
 * clone re-derives every reference by id rather than sharing objects.
 */
export function cloneState(state) {
  const players = new Array(2);
  for (let p = 0; p < 2; p++) {
    const src = state.players[p];
    players[p] = {
      id: src.id,
      life: src.life,
      manaPool: src.manaPool.slice(),
      landsPlayedThisTurn: src.landsPlayedThisTurn,
      hasLost: src.hasLost,
      library: cloneZone(src.library),
      hand: cloneZone(src.hand),
      graveyard: cloneZone(src.graveyard),
    };
  }
  const stack = new Array(state.stack.length);
  for (let i = 0; i < state.stack.length; i++) {
    const s = state.stack[i];
    stack[i] = { card: cloneInstance(s.card), controller: s.controller, target: s.target };
  }
  const continuous = new Array(state.continuous.length);
  for (let i = 0; i < state.continuous.length; i++) {
    const c = state.continuous[i];
    continuous[i] = { targetId: c.targetId, dPower: c.dPower, dToughness: c.dToughness };
  }
  return {
    turnNumber: state.turnNumber,
    activePlayer: state.activePlayer,
    priorityPlayer: state.priorityPlayer,
    step: state.step,
    players,
    battlefield: cloneZone(state.battlefield),
    stack,
    continuous,
    combat:
      state.combat === null
        ? null
        : {
            attackers: state.combat.attackers.slice(),
            blockers: state.combat.blockers.slice(),
            blockedBy: state.combat.blockedBy.slice(),
            attackersDeclared: state.combat.attackersDeclared,
            blockersDeclared: state.combat.blockersDeclared,
          },
    winner: state.winner,
    gameOver: state.gameOver,
    consecutivePasses: state.consecutivePasses,
    rngState: state.rngState,
    events: [],
  };
}

// --- lookups --------------------------------------------------------------------

function findOnBattlefield(state, id) {
  const bf = state.battlefield;
  for (let i = 0; i < bf.length; i++) if (bf[i].instanceId === id) return bf[i];
  return null;
}

/**
 * Effective power/toughness — printed base LAYERED OVER the continuous-effect list,
 * re-read on every call and never stored, which is the choice `statics.ts` makes in
 * the real engine. The walk over `state.continuous` is the model's stand-in for
 * `indexContinuous`.
 */
function effectivePower(state, inst) {
  let p = inst.def.power;
  const cont = state.continuous;
  for (let i = 0; i < cont.length; i++) if (cont[i].targetId === inst.instanceId) p += cont[i].dPower;
  return p;
}

function effectiveToughness(state, inst) {
  let t = inst.def.toughness;
  const cont = state.continuous;
  for (let i = 0; i < cont.length; i++) if (cont[i].targetId === inst.instanceId) t += cont[i].dToughness;
  return t;
}

// --- mana -----------------------------------------------------------------------

function canPay(pool, cost) {
  let spare = pool[POOL_COLORLESS];
  for (let c = 0; c < NUM_COLORS; c++) {
    const need = cost[1 + c];
    if (pool[c] < need) return false;
    spare += pool[c] - need;
  }
  return spare >= cost[COST_GENERIC];
}

function payCost(pool, cost) {
  for (let c = 0; c < NUM_COLORS; c++) pool[c] -= cost[1 + c];
  let generic = cost[COST_GENERIC];
  // Colorless first, then colors in a fixed order — deterministic, so every arm
  // leaves the pool in exactly the same shape.
  const take = Math.min(generic, pool[POOL_COLORLESS]);
  pool[POOL_COLORLESS] -= take;
  generic -= take;
  for (let c = 0; c < NUM_COLORS && generic > 0; c++) {
    const t = Math.min(generic, pool[c]);
    pool[c] -= t;
    generic -= t;
  }
}

function emptyManaPools(state) {
  for (let p = 0; p < 2; p++) {
    const pool = state.players[p].manaPool;
    for (let i = 0; i < POOL_SLOTS; i++) pool[i] = 0;
  }
}

// --- legal action generation ----------------------------------------------------

/**
 * Returns a NEWLY ALLOCATED array of NEWLY ALLOCATED action objects, exactly as
 * `packages/core`'s `generateLegalActions` does. This allocation is a first-class
 * part of what is being measured, not an accident of the prototype.
 */
export function generateLegalActions(state) {
  if (state.gameOver) return [];
  const me = state.priorityPlayer;
  const player = state.players[me];
  const actions = [];

  actions.push({ kind: ACT_PASS, player: me, instanceId: -1, target: TARGET_NOTHING, extra: 0 });

  const sorcerySpeed = me === state.activePlayer && isMainStep(state.step) && state.stack.length === 0;

  const bf = state.battlefield;
  for (let b = 0; b < bf.length; b++) {
    const perm = bf[b];
    if (perm.controller !== me || perm.tapped) continue;
    if (perm.def.kind !== KIND_LAND) continue;
    actions.push({ kind: ACT_TAP_FOR_MANA, player: me, instanceId: perm.instanceId, target: TARGET_NOTHING, extra: 0 });
  }

  if (sorcerySpeed && player.landsPlayedThisTurn < MAX_LANDS_PER_TURN) {
    for (let h = 0; h < player.hand.length; h++) {
      const c = player.hand[h];
      if (c.def.kind === KIND_LAND) {
        actions.push({ kind: ACT_PLAY_LAND, player: me, instanceId: c.instanceId, target: TARGET_NOTHING, extra: 0 });
      }
    }
  }

  for (let h = 0; h < player.hand.length; h++) {
    const c = player.hand[h];
    const def = c.def;
    if (def.kind === KIND_LAND) continue;
    const timingOk = def.timing === TIMING_INSTANT ? true : sorcerySpeed;
    if (!timingOk) continue;
    if (!canPay(player.manaPool, def.cost)) continue;
    if (def.target === TARGET_NONE) {
      actions.push({ kind: ACT_CAST_SPELL, player: me, instanceId: c.instanceId, target: TARGET_NOTHING, extra: 0 });
      continue;
    }
    // A restricted spell is offered ONCE PER LEGAL TARGET, so a consumer picking
    // from this menu cannot choose an illegal one — the real engine's rule.
    for (let b = 0; b < bf.length; b++) {
      const perm = bf[b];
      if (perm.def.kind !== KIND_CREATURE) continue;
      actions.push({ kind: ACT_CAST_SPELL, player: me, instanceId: c.instanceId, target: perm.instanceId, extra: 0 });
    }
    if (def.target === TARGET_ANY) {
      actions.push({ kind: ACT_CAST_SPELL, player: me, instanceId: c.instanceId, target: TARGET_PLAYER_0, extra: 0 });
      actions.push({ kind: ACT_CAST_SPELL, player: me, instanceId: c.instanceId, target: TARGET_PLAYER_0 + 1, extra: 0 });
    }
  }

  if (
    state.step === STEP_DECLARE_ATTACKERS &&
    me === state.activePlayer &&
    state.combat !== null &&
    !state.combat.attackersDeclared &&
    countEligibleAttackers(state, me) > 0
  ) {
    actions.push({ kind: ACT_DECLARE_ATTACKERS, player: me, instanceId: -1, target: TARGET_NOTHING, extra: ATTACK_ALL });
    actions.push({
      kind: ACT_DECLARE_ATTACKERS,
      player: me,
      instanceId: -1,
      target: TARGET_NOTHING,
      extra: ATTACK_PROFITABLE,
    });
  }

  if (
    state.step === STEP_DECLARE_BLOCKERS &&
    me !== state.activePlayer &&
    state.combat !== null &&
    state.combat.attackersDeclared &&
    !state.combat.blockersDeclared
  ) {
    actions.push({ kind: ACT_DECLARE_BLOCKERS, player: me, instanceId: -1, target: TARGET_NOTHING, extra: BLOCK_NONE });
    if (state.combat.attackers.length > 0) {
      actions.push({
        kind: ACT_DECLARE_BLOCKERS,
        player: me,
        instanceId: -1,
        target: TARGET_NOTHING,
        extra: BLOCK_GREEDY,
      });
    }
  }

  return actions;
}

function isEligibleAttacker(state, perm, me) {
  if (perm.controller !== me || perm.def.kind !== KIND_CREATURE || perm.tapped) return false;
  if (perm.summoningSick && (perm.def.keywords & KW_HASTE) === 0) return false;
  return true;
}

function countEligibleAttackers(state, me) {
  let n = 0;
  const bf = state.battlefield;
  for (let b = 0; b < bf.length; b++) if (isEligibleAttacker(state, bf[b], me)) n++;
  return n;
}

/** The biggest effective power among the defender's untapped creatures. */
function bestDefenderPower(state, defender) {
  let best = 0;
  const bf = state.battlefield;
  for (let b = 0; b < bf.length; b++) {
    const c = bf[b];
    if (c.controller !== defender || c.def.kind !== KIND_CREATURE || c.tapped) continue;
    const p = effectivePower(state, c);
    if (p > best) best = p;
  }
  return best;
}

/** The declared attacker set for a variant. Shared by scoring and by application. */
function buildAttackers(state, me, variant, out) {
  out.length = 0;
  const threat = variant === ATTACK_PROFITABLE ? bestDefenderPower(state, 1 - me) : -1;
  const bf = state.battlefield;
  for (let b = 0; b < bf.length; b++) {
    const c = bf[b];
    if (!isEligibleAttacker(state, c, me)) continue;
    if (variant === ATTACK_PROFITABLE && effectiveToughness(state, c) <= threat) continue;
    out.push(c.instanceId);
  }
  return out;
}

/**
 * A deterministic greedy block assignment: walk attackers in declaration order and
 * give each the smallest untapped creature that can legally block it and survives,
 * else the smallest that can block at all. Bounded and identical in every arm.
 */
function buildBlocks(state, me, blockers, blockedBy) {
  blockers.length = 0;
  blockedBy.length = 0;
  const combat = state.combat;
  const used = new Set();
  for (let a = 0; a < combat.attackers.length; a++) {
    const attacker = findOnBattlefield(state, combat.attackers[a]);
    if (attacker === null) continue;
    const atkFlying = (attacker.def.keywords & KW_FLYING) !== 0;
    const atkPower = effectivePower(state, attacker);
    let chosen = null;
    let chosenTough = 0;
    const bf = state.battlefield;
    for (let b = 0; b < bf.length; b++) {
      const c = bf[b];
      if (c.controller !== me || c.def.kind !== KIND_CREATURE || c.tapped) continue;
      if (used.has(c.instanceId)) continue;
      if (atkFlying && (c.def.keywords & KW_FLYING) === 0) continue;
      const t = effectiveToughness(state, c);
      const survives = t > atkPower && (attacker.def.keywords & KW_DEATHTOUCH) === 0;
      if (chosen === null || (survives && chosenTough <= atkPower) || (survives && t < chosenTough)) {
        chosen = c;
        chosenTough = t;
      }
    }
    if (chosen !== null) {
      used.add(chosen.instanceId);
      blockers.push(chosen.instanceId);
      blockedBy.push(attacker.instanceId);
    }
  }
}

// --- action application ---------------------------------------------------------

const scratchAttackers = [];
const scratchBlockers = [];
const scratchBlockedBy = [];

/**
 * Mutates `state`. The real engine's `applyActionInPlace` — the entry point MCTS
 * uses because it owns its state exclusively. `applyAction` (clone-then-mutate) is
 * below it.
 */
export function applyActionInPlace(state, action) {
  if (state.gameOver) return;
  const me = action.player;
  const player = state.players[me];

  switch (action.kind) {
    case ACT_PASS: {
      state.consecutivePasses++;
      if (state.consecutivePasses >= 2) {
        state.consecutivePasses = 0;
        if (state.stack.length > 0) {
          resolveTopOfStack(state);
          state.priorityPlayer = state.activePlayer;
        } else {
          advanceStep(state);
        }
      } else {
        state.priorityPlayer = 1 - state.priorityPlayer;
      }
      break;
    }
    case ACT_PLAY_LAND: {
      const idx = handIndexOf(player, action.instanceId);
      if (idx < 0) break;
      const card = player.hand[idx];
      player.hand.splice(idx, 1);
      card.zone = 'battlefield';
      card.tapped = false;
      card.summoningSick = true;
      state.battlefield.push(card);
      player.landsPlayedThisTurn++;
      state.consecutivePasses = 0;
      break;
    }
    case ACT_TAP_FOR_MANA: {
      const perm = findOnBattlefield(state, action.instanceId);
      if (perm === null || perm.tapped) break;
      perm.tapped = true;
      player.manaPool[perm.def.produces]++;
      state.consecutivePasses = 0;
      break;
    }
    case ACT_CAST_SPELL: {
      const idx = handIndexOf(player, action.instanceId);
      if (idx < 0) break;
      const card = player.hand[idx];
      if (!canPay(player.manaPool, card.def.cost)) break;
      payCost(player.manaPool, card.def.cost);
      player.hand.splice(idx, 1);
      card.zone = 'stack';
      state.stack.push({ card, controller: me, target: action.target });
      state.consecutivePasses = 0;
      state.priorityPlayer = me;
      break;
    }
    case ACT_DECLARE_ATTACKERS: {
      buildAttackers(state, me, action.extra, scratchAttackers);
      state.combat.attackers = scratchAttackers.slice();
      state.combat.attackersDeclared = true;
      for (let i = 0; i < state.combat.attackers.length; i++) {
        const c = findOnBattlefield(state, state.combat.attackers[i]);
        if (c !== null && (c.def.keywords & KW_VIGILANCE) === 0) c.tapped = true;
      }
      state.consecutivePasses = 0;
      break;
    }
    case ACT_DECLARE_BLOCKERS: {
      if (action.extra === BLOCK_GREEDY) {
        buildBlocks(state, me, scratchBlockers, scratchBlockedBy);
        state.combat.blockers = scratchBlockers.slice();
        state.combat.blockedBy = scratchBlockedBy.slice();
      } else {
        state.combat.blockers = [];
        state.combat.blockedBy = [];
      }
      state.combat.blockersDeclared = true;
      state.consecutivePasses = 0;
      break;
    }
    default:
      break;
  }

  checkStateBasedActions(state);
}

/** The pure entry point: clone at the boundary, mutate the draft. */
export function applyAction(state, action) {
  const draft = cloneState(state);
  applyActionInPlace(draft, action);
  return draft;
}

function handIndexOf(player, id) {
  const hand = player.hand;
  for (let i = 0; i < hand.length; i++) if (hand[i].instanceId === id) return i;
  return -1;
}

function resolveTopOfStack(state) {
  const obj = state.stack.pop();
  const card = obj.card;
  const def = card.def;
  if (def.kind === KIND_CREATURE) {
    card.zone = 'battlefield';
    card.controller = obj.controller;
    card.tapped = false;
    card.summoningSick = (def.keywords & KW_HASTE) === 0;
    card.damageMarked = 0;
    card.markedByDeathtouch = false;
    state.battlefield.push(card);
  } else {
    // A targeted spell whose only target has left the battlefield is countered on
    // resolution (fizzles) — cheap, and it is real MTG.
    let fizzled = false;
    if (def.target !== TARGET_NONE && obj.target < TARGET_PLAYER_0) {
      const t = findOnBattlefield(state, obj.target);
      if (t === null) fizzled = true;
      else if (def.kind === KIND_BOLT) t.damageMarked += def.amount;
      else if (def.kind === KIND_PUMP) state.continuous.push({ targetId: t.instanceId, dPower: def.amount, dToughness: def.amount });
    } else if (def.kind === KIND_BOLT && obj.target >= TARGET_PLAYER_0) {
      const victim = state.players[obj.target - TARGET_PLAYER_0];
      victim.life -= def.amount;
    }
    if (fizzled) {
      // still goes to the graveyard
    }
    card.zone = 'graveyard';
    state.players[card.owner].graveyard.push(card);
  }
}

function checkStateBasedActions(state) {
  let changed = true;
  while (changed) {
    changed = false;
    const bf = state.battlefield;
    for (let i = bf.length - 1; i >= 0; i--) {
      const c = bf[i];
      if (c.def.kind !== KIND_CREATURE) continue;
      const lethal = c.damageMarked >= effectiveToughness(state, c) || c.markedByDeathtouch;
      if (!lethal) continue;
      bf.splice(i, 1);
      c.zone = 'graveyard';
      c.damageMarked = 0;
      c.markedByDeathtouch = false;
      state.players[c.owner].graveyard.push(c);
      changed = true;
    }
  }
  for (let p = 0; p < 2; p++) {
    if (state.players[p].life <= 0) state.players[p].hasLost = true;
  }
  const aLost = state.players[0].hasLost;
  const bLost = state.players[1].hasLost;
  if (aLost || bLost) {
    state.gameOver = true;
    state.winner = aLost && bLost ? -1 : aLost ? 1 : 0;
  }
}

// --- turn structure --------------------------------------------------------------

function advanceStep(state) {
  emptyManaPools(state);
  let step = state.step + 1;
  if (step > STEP_CLEANUP) {
    passTurn(state);
    return;
  }
  enterStep(state, step);
}

function passTurn(state) {
  // Cleanup: clear marked damage and expire until-EOT effects.
  const bf = state.battlefield;
  for (let i = 0; i < bf.length; i++) {
    bf[i].damageMarked = 0;
    bf[i].markedByDeathtouch = false;
  }
  state.continuous.length = 0;
  state.combat = null;
  state.turnNumber++;
  state.activePlayer = 1 - state.activePlayer;
  if (state.turnNumber > MAX_TURNS) {
    state.gameOver = true;
    state.winner = -1;
    return;
  }
  enterStep(state, STEP_UNTAP);
}

function enterStep(state, step) {
  state.step = step;
  state.priorityPlayer = state.activePlayer;
  state.consecutivePasses = 0;

  switch (step) {
    case STEP_UNTAP: {
      const bf = state.battlefield;
      for (let i = 0; i < bf.length; i++) {
        const c = bf[i];
        if (c.controller !== state.activePlayer) continue;
        c.tapped = false;
        c.summoningSick = false;
      }
      state.players[state.activePlayer].landsPlayedThisTurn = 0;
      // No priority in untap.
      enterStep(state, STEP_UPKEEP);
      return;
    }
    case STEP_DRAW: {
      drawCard(state, state.activePlayer);
      checkStateBasedActions(state);
      break;
    }
    case STEP_DECLARE_ATTACKERS: {
      state.combat = { attackers: [], blockers: [], blockedBy: [], attackersDeclared: false, blockersDeclared: false };
      break;
    }
    case STEP_COMBAT_DAMAGE: {
      resolveCombatDamage(state);
      checkStateBasedActions(state);
      break;
    }
    case STEP_CLEANUP: {
      // Cleanup takes no priority in the model; fall straight through to the turn
      // change so a game cannot idle here.
      passTurn(state);
      return;
    }
    default:
      break;
  }
}

function resolveCombatDamage(state) {
  const combat = state.combat;
  if (combat === null || !combat.attackersDeclared) return;
  const defender = 1 - state.activePlayer;

  for (let a = 0; a < combat.attackers.length; a++) {
    const attackerId = combat.attackers[a];
    const attacker = findOnBattlefield(state, attackerId);
    if (attacker === null) continue;
    const power = effectivePower(state, attacker);
    const deathtouch = (attacker.def.keywords & KW_DEATHTOUCH) !== 0;
    const lifelink = (attacker.def.keywords & KW_LIFELINK) !== 0;

    // Which blockers were assigned to this attacker?
    let assigned = 0;
    let remaining = power;
    for (let b = 0; b < combat.blockedBy.length; b++) {
      if (combat.blockedBy[b] !== attackerId) continue;
      const blocker = findOnBattlefield(state, combat.blockers[b]);
      if (blocker === null) continue;
      assigned++;
      // The attacker assigns all remaining damage to the first blocker in order.
      if (remaining > 0) {
        blocker.damageMarked += remaining;
        if (deathtouch) blocker.markedByDeathtouch = true;
        if (lifelink) state.players[attacker.controller].life += remaining;
        remaining = 0;
      }
      const bPower = effectivePower(state, blocker);
      attacker.damageMarked += bPower;
      if ((blocker.def.keywords & KW_DEATHTOUCH) !== 0) attacker.markedByDeathtouch = true;
      if ((blocker.def.keywords & KW_LIFELINK) !== 0) state.players[blocker.controller].life += bPower;
    }

    if (assigned === 0 && power > 0) {
      state.players[defender].life -= power;
      if (lifelink) state.players[attacker.controller].life += power;
    }
  }
}

// --- the policy ------------------------------------------------------------------
//
// Deterministic argmax with a lowest-index tie-break, so every arm picks the same
// action from the same menu. `scoreAction` does real board reading — the real
// profile spends 10.6% of its time in pilot scoring, and a policy that read nothing
// would quietly delete that from the comparison.

/**
 * Should the policy tap a land right now?
 *
 * This rule matters more than it looks. A naive "tap whenever you hold something
 * you cannot pay for" makes both pilots tap out at the first opportunity, mana
 * pools empty at the next step boundary, and the board ends up with almost no
 * untapped permanents — which collapses the measured BRANCHING FACTOR to ~2 and
 * quietly deletes most of `generateLegalActions`'s work from the benchmark. The
 * rule below keeps mana up until it can actually be spent, which is both better
 * play and a far more representative action space (measured branching ≈ 8).
 */
function wantsToTap(state, me) {
  const sorcerySpeed = me === state.activePlayer && isMainStep(state.step) && state.stack.length === 0;
  const defendingWithTrick =
    state.step === STEP_DECLARE_BLOCKERS && state.combat !== null && state.combat.attackers.length > 0;
  if (!sorcerySpeed && !defendingWithTrick) return false;

  // What could this player produce if every untapped land were tapped?
  const potential = state.players[me].manaPool.slice();
  const bf = state.battlefield;
  for (let b = 0; b < bf.length; b++) {
    const perm = bf[b];
    if (perm.controller !== me || perm.tapped || perm.def.kind !== KIND_LAND) continue;
    potential[perm.def.produces]++;
  }

  const player = state.players[me];
  for (let h = 0; h < player.hand.length; h++) {
    const def = player.hand[h].def;
    if (def.kind === KIND_LAND) continue;
    if (!sorcerySpeed && def.timing !== TIMING_INSTANT) continue;
    // Only worth tapping for a spell that is not yet payable but WOULD become
    // payable — never for one that is already castable, nor one out of reach.
    if (canPay(player.manaPool, def.cost)) continue;
    if (canPay(potential, def.cost)) return true;
  }
  return false;
}

function creatureValue(def) {
  let v = def.power * 2 + def.toughness;
  if ((def.keywords & KW_FLYING) !== 0) v += 3;
  if ((def.keywords & KW_LIFELINK) !== 0) v += 2;
  if ((def.keywords & KW_DEATHTOUCH) !== 0) v += 3;
  if ((def.keywords & KW_VIGILANCE) !== 0) v += 1;
  if ((def.keywords & KW_HASTE) !== 0) v += 1;
  return v;
}

export function scoreAction(state, action) {
  const me = action.player;
  switch (action.kind) {
    case ACT_PASS:
      return 0;
    case ACT_PLAY_LAND:
      return 500;
    case ACT_TAP_FOR_MANA:
      return wantsToTap(state, me) ? 300 : -1;
    case ACT_CAST_SPELL: {
      const card = findInHand(state.players[me], action.instanceId);
      if (card === null) return -1000;
      const def = card.def;
      if (def.kind === KIND_CREATURE) return 1000 + creatureValue(def);
      if (def.kind === KIND_BOLT) {
        if (action.target >= TARGET_PLAYER_0) {
          const victim = action.target - TARGET_PLAYER_0;
          if (victim === me) return -1000;
          // Burn to the face is only the plan when it actually closes the game.
          return state.players[victim].life <= def.amount ? 5000 : 1000 + def.amount;
        }
        const t = findOnBattlefield(state, action.target);
        if (t === null || t.controller === me) return -1000;
        return effectiveToughness(state, t) - t.damageMarked <= def.amount
          ? 1200 + creatureValue(t.def)
          : 1000 + def.amount;
      }
      // PUMP
      const t = findOnBattlefield(state, action.target);
      if (t === null || t.controller !== me) return -1000;
      return state.step === STEP_DECLARE_BLOCKERS ? 1100 + def.amount : 1001;
    }
    case ACT_DECLARE_ATTACKERS: {
      buildAttackers(state, me, action.extra, scratchAttackers);
      const threat = bestDefenderPower(state, 1 - me);
      let score = 190;
      for (let i = 0; i < scratchAttackers.length; i++) {
        const c = findOnBattlefield(state, scratchAttackers[i]);
        if (c === null) continue;
        score += effectivePower(state, c);
        if (effectiveToughness(state, c) <= threat) score -= 2;
      }
      return score;
    }
    case ACT_DECLARE_BLOCKERS: {
      if (action.extra === BLOCK_NONE) {
        let incoming = 0;
        const combat = state.combat;
        for (let i = 0; i < combat.attackers.length; i++) {
          const c = findOnBattlefield(state, combat.attackers[i]);
          if (c !== null) incoming += effectivePower(state, c);
        }
        return 100 + (state.players[me].life > incoming ? 0 : -50);
      }
      buildBlocks(state, me, scratchBlockers, scratchBlockedBy);
      let score = 100;
      for (let i = 0; i < scratchBlockers.length; i++) {
        const blocker = findOnBattlefield(state, scratchBlockers[i]);
        const attacker = findOnBattlefield(state, scratchBlockedBy[i]);
        if (blocker === null || attacker === null) continue;
        const aPow = effectivePower(state, attacker);
        score += aPow; // damage prevented
        if (effectiveToughness(state, blocker) <= aPow || (attacker.def.keywords & KW_DEATHTOUCH) !== 0) {
          score -= creatureValue(blocker.def);
        }
        if (effectiveToughness(state, attacker) <= effectivePower(state, blocker)) {
          score += creatureValue(attacker.def);
        }
      }
      return score;
    }
    default:
      return 0;
  }
}

function findInHand(player, id) {
  const hand = player.hand;
  for (let i = 0; i < hand.length; i++) if (hand[i].instanceId === id) return hand[i];
  return null;
}

export function chooseAction(state, actions) {
  let best = 0;
  let bestScore = -Infinity;
  for (let i = 0; i < actions.length; i++) {
    const s = scoreAction(state, actions[i]);
    if (s > bestScore) {
      bestScore = s;
      best = i;
    }
  }
  return best;
}

// --- leaf evaluation ---------------------------------------------------------------

export const EVAL_LIFE_WEIGHT = 3;
export const EVAL_BOARD_WEIGHT = 2;
export const EVAL_CARD_WEIGHT = 1;

/** A bounded-depth leaf evaluator, from player 0's seat. */
export function evaluate(state) {
  let v = (state.players[0].life - state.players[1].life) * EVAL_LIFE_WEIGHT;
  const bf = state.battlefield;
  for (let i = 0; i < bf.length; i++) {
    const c = bf[i];
    if (c.def.kind !== KIND_CREATURE) continue;
    const side = c.controller === 0 ? 1 : -1;
    v += side * (effectivePower(state, c) + effectiveToughness(state, c)) * EVAL_BOARD_WEIGHT;
  }
  v += (state.players[0].hand.length - state.players[1].hand.length) * EVAL_CARD_WEIGHT;
  return v;
}

// --- the workload ------------------------------------------------------------------

/**
 * Play one full game. Returns a transcript fingerprint plus counters so a caller
 * can prove two arms played identical games, and can derive per-action costs.
 */
export function playGame(seed) {
  const state = createGame(seed);
  let digest = 0x811c9dc5 | 0;
  let actions = 0;
  let generated = 0;
  while (!state.gameOver && actions < ACTION_CAP) {
    const legal = generateLegalActions(state);
    if (legal.length === 0) break;
    generated += legal.length;
    const pick = chooseAction(state, legal);
    const a = legal[pick];
    digest = fnv(digest, a.kind);
    digest = fnv(digest, digestInstance(a.kind, a.instanceId));
    digest = fnv(digest, a.target);
    digest = fnv(digest, a.extra);
    digest = fnv(digest, state.step);
    digest = fnv(digest, state.priorityPlayer);
    digest = fnv(digest, state.players[0].life);
    digest = fnv(digest, state.players[1].life);
    digest = fnv(digest, state.battlefield.length);
    applyActionInPlace(state, a);
    actions++;
  }
  digest = fnv(digest, state.winner);
  digest = fnv(digest, state.turnNumber);
  return { digest, actions, generated, turns: state.turnNumber, winner: state.winner };
}

/**
 * The SEARCH workload — the shape the real MCTS bottleneck has. From a captured
 * position, run `rollouts` playouts of `depth` plies each, evaluating at the leaf.
 * Arm A must clone before each playout because it has no undo; that cost is the
 * whole point of the comparison.
 */
export function searchWorkload(seed, rollouts, depth) {
  const root = midGameState(seed);
  let rng = (seed * 2654435761) | 0;
  let checksum = 0x811c9dc5 | 0;
  let transitions = 0;
  for (let r = 0; r < rollouts; r++) {
    const s = cloneState(root);
    for (let d = 0; d < depth; d++) {
      if (s.gameOver) break;
      const legal = generateLegalActions(s);
      if (legal.length === 0) break;
      rng = rngNext(rng);
      applyActionInPlace(s, legal[(rng >>> 0) % legal.length]);
      transitions++;
    }
    checksum = fnv(checksum, evaluate(s));
  }
  return { checksum, transitions };
}

/** Play a fixed number of policy actions to reach a developed mid-game board. */
export function midGameState(seed) {
  const state = createGame(seed);
  for (let i = 0; i < MIDGAME_ACTIONS && !state.gameOver; i++) {
    const legal = generateLegalActions(state);
    if (legal.length === 0) break;
    applyActionInPlace(state, legal[chooseAction(state, legal)]);
  }
  return state;
}

export const MIDGAME_ACTIONS = 300;

// --- per-operation microbenchmarks (mirrors of arm C's, so all arms report alike) ------

/** `iters` legal-action generations from one fixed position. */
export function benchGenerate(seed, iters) {
  const s = midGameState(seed);
  let sum = 0;
  for (let i = 0; i < iters; i++) sum += generateLegalActions(s).length;
  return sum;
}

/** `iters` leaf evaluations from one fixed position. */
export function benchEvaluate(seed, iters) {
  const s = midGameState(seed);
  let sum = 0;
  for (let i = 0; i < iters; i++) sum += evaluate(s);
  return sum;
}

/**
 * `iters` UNDOABLE transitions from one fixed position.
 *
 * An object graph has no undo, so the only way to apply the same action to the same
 * state repeatedly is to clone first. That is not a handicap invented for the
 * benchmark — it is exactly what `packages/ai`'s MCTS must do today, and it is the
 * cost arm B's journal removes.
 */
export function benchTransition(seed, iters) {
  const root = midGameState(seed);
  const legal = generateLegalActions(root);
  const action = legal[legal.length > 1 ? 1 : 0];
  let sum = 0;
  for (let i = 0; i < iters; i++) {
    const s = cloneState(root);
    applyActionInPlace(s, action);
    sum += s.consecutivePasses + s.battlefield.length;
  }
  return sum;
}

/** The clone alone, so the transition cost above can be decomposed. */
export function benchClone(seed, iters) {
  const root = midGameState(seed);
  let sum = 0;
  for (let i = 0; i < iters; i++) sum += cloneState(root).turnNumber;
  return sum;
}

/** `iters` policy decisions (score the whole menu and pick) from one fixed position. */
export function benchDecide(seed, iters) {
  const s = midGameState(seed);
  let sum = 0;
  for (let i = 0; i < iters; i++) {
    const legal = generateLegalActions(s);
    sum += chooseAction(s, legal);
  }
  return sum;
}

/** Instances a clone of the mid-game position must copy — context for the clone cost. */
export function midGameInstanceCount(seed) {
  const s = midGameState(seed);
  return (
    s.battlefield.length +
    s.players[0].library.length + s.players[1].library.length +
    s.players[0].hand.length + s.players[1].hand.length +
    s.players[0].graveyard.length + s.players[1].graveyard.length
  );
}
