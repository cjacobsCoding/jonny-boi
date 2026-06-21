/**
 * The engine orchestrator: game setup, the turn/step machine, priority + the
 * stack, casting/playing, and the single `applyAction` entry point.
 *
 * Determinism & purity: no DOM, no node APIs, no `Date.now`. All randomness comes
 * from the injected seeded RNG. `applyAction` clones the input state once (see
 * internal/clone), mutates the draft, and returns a fresh `{ state, events }` — the
 * caller's previous state is never touched.
 *
 * The engine is a set of pure functions over plain state — there is no
 * class-per-card hierarchy. Cards are data; systems read that data.
 */

import type { GameAction } from './actions.js';
import type { CardDefinition } from './card.js';
import { castTiming, isLand, isPermanentType } from './card.js';
import type { RulesConfig } from './config.js';
import { DEFAULT_RULES } from './config.js';
import type { EffectRegistry } from './effects.js';
import { applyEffectRef, createEffectRegistry } from './effects.js';
import type { GameEvent } from './events.js';
import { createRng, shuffle } from './rng.js';
import {
  addMana,
  canPay,
  emptyPool,
  payCost,
  poolTotal,
} from './mana.js';
import type {
  CardInstance,
  GameState,
  InstanceId,
  PlayerId,
  StackObject,
  Step,
} from './state.js';
import {
  createPlayer,
  MAIN_STEPS,
  PLAYER_IDS,
  STEP_ORDER,
} from './state.js';
import { cloneState } from './internal/clone.js';
import { findOnBattlefield, moveToZone, resetInstanceForNewZone } from './internal/zones.js';
import { checkStateBasedActions, loseGame, resolveWinner } from './internal/sba.js';
import {
  assignAndDealCombatDamage,
  canBlock,
  defendingPlayerOf,
  hasAnyFirstStrike,
  tapAttackers,
} from './internal/combat.js';
import { isCreature } from './card.js';

/** A deck list: an ordered array of card definitions (the library, pre-shuffle). */
export interface DeckList {
  readonly cards: readonly CardDefinition[];
}

/** Inputs to start a game. */
export interface GameSetup {
  readonly seed: number;
  readonly decks: Readonly<Record<PlayerId, DeckList>>;
  /** Who takes the first turn; defaults to 'A'. */
  readonly startingPlayer?: PlayerId;
  readonly config?: RulesConfig;
  /** The effect registry `cards` populated; defaults to an empty one. */
  readonly registry?: EffectRegistry;
}

/** The bundle a created/advanced game returns: state + the events emitted. */
export interface EngineResult {
  readonly state: GameState;
  readonly events: readonly GameEvent[];
}

/**
 * A live engine handle binding a config + registry + RNG to the pure functions,
 * so callers don't thread them on every call. The handle itself is stateless
 * w.r.t. game state — game state is always passed explicitly and returned anew.
 */
export interface Engine {
  readonly config: RulesConfig;
  readonly registry: EffectRegistry;
  /** Apply one action; returns the new state and the events it produced. */
  applyAction(state: GameState, action: GameAction): EngineResult;
  /** List the legal actions for the current priority-holder. */
  legalActions(state: GameState): readonly GameAction[];
}

// --- instance creation ---------------------------------------------------------

function makeInstance(state: GameState, def: CardDefinition, owner: PlayerId): CardInstance {
  const instanceId = state.nextInstanceId++;
  return {
    instanceId,
    def,
    controller: owner,
    owner,
    zone: 'library',
    tapped: false,
    summoningSick: true,
    damageMarked: 0,
    markedByDeathtouch: false,
    counters: {},
  };
}

// --- setup ---------------------------------------------------------------------

/**
 * Create a new game: build libraries, shuffle with the seeded RNG, draw opening
 * hands, and set the active player to their untap/upkeep. Returns the initial
 * state and the setup events.
 */
export function createGame(setup: GameSetup): EngineResult {
  const config = setup.config ?? DEFAULT_RULES;
  const startingPlayer = setup.startingPlayer ?? 'A';
  const rng = createRng(setup.seed);
  const events: GameEvent[] = [];
  const emit = (e: GameEvent) => events.push(e);

  const state: GameState = {
    nextInstanceId: 1,
    turnNumber: 0,
    activePlayer: startingPlayer,
    priorityPlayer: startingPlayer,
    step: 'untap',
    players: {
      A: createPlayer('A', config.startingLife),
      B: createPlayer('B', config.startingLife),
    },
    battlefield: [],
    stack: [],
    combat: null,
    winner: null,
    gameOver: false,
    consecutivePasses: 0,
    seed: setup.seed,
    rngState: rng.state,
  };

  // Build + shuffle libraries.
  for (const pid of PLAYER_IDS) {
    const deck = setup.decks[pid];
    const instances = deck.cards.map((def) => makeInstance(state, def, pid));
    const shuffled = shuffle(instances, rng);
    state.players[pid].library = shuffled;
  }
  state.rngState = rng.state;

  emit({ type: 'gameStart', seed: setup.seed, startingPlayer });

  // Draw opening hands.
  for (const pid of PLAYER_IDS) {
    for (let i = 0; i < config.startingHandSize; i++) {
      drawCard(state, pid, emit);
    }
  }

  // Begin the first turn.
  beginTurn(state, config, emit);

  return { state, events };
}

/** Create an engine handle. */
export function createEngine(config: RulesConfig = DEFAULT_RULES, registry?: EffectRegistry): Engine {
  const reg = registry ?? createEffectRegistry();
  return {
    config,
    registry: reg,
    applyAction(state, action) {
      return applyAction(state, action, config, reg);
    },
    legalActions(state) {
      return generateLegalActions(state, config);
    },
  };
}

// --- draw / turn machine -------------------------------------------------------

/** Draw one card for a player. Empty library flags a loss (decking). */
function drawCard(state: GameState, player: PlayerId, emit: (e: GameEvent) => void): void {
  const p = state.players[player];
  const top = p.library.shift();
  if (!top) {
    loseGame(state, player, 'attempted to draw from an empty library', emit);
    return;
  }
  top.zone = 'hand';
  p.hand.push(top);
  emit({ type: 'drawCard', player, instanceId: top.instanceId });
}

/** Begin a new turn: bump turn number, set active player, run untap/upkeep/draw. */
function beginTurn(state: GameState, _config: RulesConfig, emit: (e: GameEvent) => void): void {
  state.turnNumber += 1;
  emit({ type: 'turnBegin', turn: state.turnNumber, activePlayer: state.activePlayer });

  const active = state.players[state.activePlayer];
  active.landsPlayedThisTurn = 0;
  emptyManaPools(state, emit);

  // Untap step.
  enterStep(state, 'untap', emit);
  for (const inst of state.battlefield) {
    if (inst.controller === state.activePlayer && inst.tapped) {
      inst.tapped = false;
      emit({ type: 'untapped', instanceId: inst.instanceId, player: state.activePlayer });
    }
  }
  // Summoning sickness clears for the active player's permanents at the start of
  // their turn (they've been controlled since the turn began).
  for (const inst of state.battlefield) {
    if (inst.controller === state.activePlayer) inst.summoningSick = false;
  }

  // Upkeep step (priority window).
  advanceToStepWithPriority(state, 'upkeep', emit);
}

/** Empty every player's mana pool (between steps/phases), emitting if non-empty. */
function emptyManaPools(state: GameState, emit: (e: GameEvent) => void): void {
  for (const pid of PLAYER_IDS) {
    const p = state.players[pid];
    if (poolTotal(p.manaPool) > 0) {
      p.manaPool = emptyPool();
      emit({ type: 'manaPoolEmptied', player: pid });
    }
  }
}

/** Mark entry into a step (event only; no priority semantics). */
function enterStep(state: GameState, step: Step, emit: (e: GameEvent) => void): void {
  state.step = step;
  emit({ type: 'stepBegin', step, activePlayer: state.activePlayer });
}

/** Enter a step and give the active player priority (empties pools first). */
function advanceToStepWithPriority(state: GameState, step: Step, emit: (e: GameEvent) => void): void {
  emptyManaPools(state, emit);
  enterStep(state, step, emit);
  state.priorityPlayer = state.activePlayer;
  state.consecutivePasses = 0;
}

/**
 * Advance the game when both players have passed priority on an empty stack: move
 * to the next step (performing that step's turn-based action), or to the next
 * player's turn after cleanup. This is the heart of the turn machine.
 */
function advanceStep(state: GameState, config: RulesConfig, emit: (e: GameEvent) => void): void {
  if (state.gameOver) return;
  const idx = STEP_ORDER.indexOf(state.step);
  const isLastStep = idx === STEP_ORDER.length - 1;

  if (isLastStep) {
    // Cleanup just finished → next player's turn.
    passTurn(state, config, emit);
    return;
  }

  const next = STEP_ORDER[idx + 1] as Step;
  performStepTurnBasedActions(state, next, config, emit);
}

/** Run the turn-based action(s) for entering a given step, then grant priority. */
function performStepTurnBasedActions(
  state: GameState,
  step: Step,
  config: RulesConfig,
  emit: (e: GameEvent) => void,
): void {
  switch (step) {
    case 'draw': {
      enterStep(state, step, emit);
      // On turn 1 the active player is, by construction, the starting player
      // ("on the play"), who skips their first draw.
      const skipFirst = config.playerOnPlaySkipsFirstDraw && state.turnNumber === 1;
      if (!skipFirst) {
        for (let i = 0; i < config.cardsPerDrawStep; i++) drawCard(state, state.activePlayer, emit);
      }
      checkStateBasedActions(state, emit);
      grantPriority(state);
      break;
    }
    case 'beginCombat': {
      state.combat = { attackers: [], blocks: {} };
      advanceToStepWithPriority(state, step, emit);
      break;
    }
    case 'combatDamage': {
      enterStep(state, step, emit);
      emptyManaPools(state, emit);
      resolveCombatDamage(state, emit);
      checkStateBasedActions(state, emit);
      grantPriority(state);
      break;
    }
    case 'endCombat': {
      advanceToStepWithPriority(state, step, emit);
      break;
    }
    case 'cleanup': {
      enterStep(state, step, emit);
      // Clear marked damage; "until end of turn" effects would end here (none yet).
      for (const inst of state.battlefield) {
        inst.damageMarked = 0;
        inst.markedByDeathtouch = false;
      }
      emptyManaPools(state, emit);
      checkStateBasedActions(state, emit);
      // Cleanup normally grants no priority; advance straight to next turn.
      passTurn(state, config, emit);
      break;
    }
    default: {
      // Generic priority step (upkeep, mains, declare steps, end).
      advanceToStepWithPriority(state, step, emit);
      break;
    }
  }
}

/** Grant the active player priority with a fresh pass counter. */
function grantPriority(state: GameState): void {
  state.priorityPlayer = state.activePlayer;
  state.consecutivePasses = 0;
}

/** Hand the turn to the other player. */
function passTurn(state: GameState, config: RulesConfig, emit: (e: GameEvent) => void): void {
  if (state.gameOver) return;
  state.combat = null;
  state.activePlayer = otherPlayer(state.activePlayer);
  beginTurn(state, config, emit);
}

function otherPlayer(p: PlayerId): PlayerId {
  return p === 'A' ? 'B' : 'A';
}

// --- combat damage orchestration ----------------------------------------------

/** Run the first-strike step (if needed) + the normal step, with SBAs between. */
function resolveCombatDamage(state: GameState, emit: (e: GameEvent) => void): void {
  if (!state.combat || state.combat.attackers.length === 0) return;
  if (hasAnyFirstStrike(state, state.combat)) {
    assignAndDealCombatDamage(state, emit, 'firstStrike');
    checkStateBasedActions(state, emit);
    if (state.gameOver) return;
  }
  assignAndDealCombatDamage(state, emit, 'normal');
}

// --- priority + the stack ------------------------------------------------------

/**
 * Handle a priority pass. If both players pass in succession: resolve the top of
 * the stack if non-empty, else advance the step. Active player regains priority
 * after a stack object resolves.
 */
function onPassPriority(state: GameState, config: RulesConfig, emit: (e: GameEvent) => void): void {
  emit({ type: 'priorityPassed', player: state.priorityPlayer });
  state.consecutivePasses += 1;

  if (state.consecutivePasses < PLAYER_IDS.length) {
    // Pass priority to the other player.
    state.priorityPlayer = otherPlayer(state.priorityPlayer);
    return;
  }

  // Both passed.
  state.consecutivePasses = 0;
  if (state.stack.length > 0) {
    resolveTopOfStack(state, config, emit);
    // After resolution the active player receives priority again.
    if (!state.gameOver) {
      state.priorityPlayer = state.activePlayer;
    }
    return;
  }
  // Empty stack, both passed → advance the step.
  advanceStep(state, config, emit);
}

/** Resolve the top (last) stack object: run its effects, move it to its zone. */
function resolveTopOfStack(state: GameState, _config: RulesConfig, emit: (e: GameEvent) => void): void {
  const top = state.stack.pop();
  if (!top) return;
  const registry = activeRegistry;
  const card = top.card;

  emit({ type: 'stackResolved', instanceId: card.instanceId, name: card.def.name });

  // Run the card's effects (ETB script for permanents, spell effect for non-permanents).
  const effects = card.def.effects ?? [];
  for (const ref of effects) {
    applyEffectRef(
      registry,
      ref,
      { state, source: card, controller: top.controller },
      emit,
      top.targets,
    );
  }

  if (top.resolvesTo === 'battlefield') {
    card.controller = top.controller;
    card.zone = 'stack'; // moveToZone will set it
    // Stack objects aren't in a player zone; place directly on battlefield.
    card.zone = 'battlefield';
    card.tapped = false;
    card.damageMarked = 0;
    card.markedByDeathtouch = false;
    // Summoning sickness: a creature is sick unless it has haste.
    card.summoningSick = isCreature(card.def) ? !(card.def.keywords?.haste ?? false) : false;
    state.battlefield.push(card);
    emit({ type: 'zoneChange', instanceId: card.instanceId, from: 'stack', to: 'battlefield' });
  } else {
    // Spell → graveyard.
    card.zone = 'graveyard';
    state.players[card.owner].graveyard.push(card);
    resetInstanceForNewZone(card);
    emit({ type: 'zoneChange', instanceId: card.instanceId, from: 'stack', to: 'graveyard' });
  }

  checkStateBasedActions(state, emit);
}

// The registry in force for the current applyAction call. Threaded via a closure
// in applyAction rather than a true global; reset on every entry (single-threaded).
let activeRegistry: EffectRegistry = createEffectRegistry();

// --- the action entry point ----------------------------------------------------

/**
 * Apply a single action to a state. Clones the input, validates, mutates the
 * draft, and returns the new state + events. Illegal actions are rejected cleanly
 * with an `actionRejected` event — the engine never throw-crashes on bad input.
 */
export function applyAction(
  prevState: GameState,
  action: GameAction,
  config: RulesConfig = DEFAULT_RULES,
  registry?: EffectRegistry,
): EngineResult {
  const state = cloneState(prevState);
  const events: GameEvent[] = [];
  const emit = (e: GameEvent) => events.push(e);
  activeRegistry = registry ?? createEffectRegistry();

  if (state.gameOver) {
    emit({ type: 'actionRejected', reason: 'the game is already over' });
    return { state, events };
  }

  const reject = (reason: string): EngineResult => {
    // Return a state with only the rejection appended; no mutation leaked because
    // we discard the draft's other changes by re-cloning from prevState.
    const clean = cloneState(prevState);
    return { state: clean, events: [{ type: 'actionRejected', reason }] };
  };

  switch (action.kind) {
    case 'passPriority': {
      if (action.player !== state.priorityPlayer) return reject('you do not have priority');
      onPassPriority(state, config, emit);
      return { state, events };
    }
    case 'playLand':
      return applyPlayLand(state, prevState, action, config, emit, events);
    case 'tapForMana':
      return applyTapForMana(state, prevState, action, emit, events);
    case 'castSpell':
      return applyCastSpell(state, prevState, action, config, emit, events);
    case 'declareAttackers':
      return applyDeclareAttackers(state, prevState, action, emit, events);
    case 'declareBlockers':
      return applyDeclareBlockers(state, prevState, action, emit, events);
    default: {
      const _exhaustive: never = action;
      void _exhaustive;
      return reject('unknown action');
    }
  }
}

function rejectWith(prevState: GameState, reason: string): EngineResult {
  return { state: cloneState(prevState), events: [{ type: 'actionRejected', reason }] };
}

function applyPlayLand(
  state: GameState,
  prevState: GameState,
  action: Extract<GameAction, { kind: 'playLand' }>,
  config: RulesConfig,
  emit: (e: GameEvent) => void,
  events: GameEvent[],
): EngineResult {
  if (action.player !== state.activePlayer) return rejectWith(prevState, 'only the active player may play a land');
  if (action.player !== state.priorityPlayer) return rejectWith(prevState, 'you do not have priority');
  if (state.stack.length > 0) return rejectWith(prevState, 'cannot play a land while the stack is non-empty');
  if (!MAIN_STEPS.includes(state.step)) return rejectWith(prevState, 'lands can only be played during a main phase');
  const player = state.players[action.player];
  if (player.landsPlayedThisTurn >= config.maxLandsPerTurn) {
    return rejectWith(prevState, 'no land plays remaining this turn');
  }
  const card = player.hand.find((c) => c.instanceId === action.instanceId);
  if (!card) return rejectWith(prevState, 'that card is not in your hand');
  if (!isLand(card.def)) return rejectWith(prevState, 'that card is not a land');

  moveToZone(state, card, 'battlefield', emit, action.player);
  card.controller = action.player;
  card.tapped = false;
  card.summoningSick = false; // lands aren't affected by summoning sickness
  player.landsPlayedThisTurn += 1;
  emit({ type: 'landPlayed', player: action.player, instanceId: card.instanceId });
  // Playing a land is a special action: the player retains priority.
  state.consecutivePasses = 0;
  return { state, events };
}

function applyTapForMana(
  state: GameState,
  prevState: GameState,
  action: Extract<GameAction, { kind: 'tapForMana' }>,
  emit: (e: GameEvent) => void,
  events: GameEvent[],
): EngineResult {
  if (action.player !== state.priorityPlayer) return rejectWith(prevState, 'you do not have priority');
  const source = findOnBattlefield(state, action.instanceId);
  if (!source) return rejectWith(prevState, 'that permanent is not on the battlefield');
  if (source.controller !== action.player) return rejectWith(prevState, 'you do not control that permanent');
  if (source.tapped) return rejectWith(prevState, 'that permanent is already tapped');
  const produces = source.def.produces;
  if (!produces || produces.length === 0) return rejectWith(prevState, 'that permanent does not produce mana');

  source.tapped = true;
  emit({ type: 'tapped', instanceId: source.instanceId });
  const player = state.players[action.player];
  for (const color of produces) {
    player.manaPool = addMana(player.manaPool, color, 1);
    emit({ type: 'manaAdded', player: action.player, color, amount: 1 });
  }
  // Mana abilities don't use the stack and don't reset priority passing.
  return { state, events };
}

function applyCastSpell(
  state: GameState,
  prevState: GameState,
  action: Extract<GameAction, { kind: 'castSpell' }>,
  _config: RulesConfig,
  emit: (e: GameEvent) => void,
  events: GameEvent[],
): EngineResult {
  if (action.player !== state.priorityPlayer) return rejectWith(prevState, 'you do not have priority');
  const player = state.players[action.player];
  const card = player.hand.find((c) => c.instanceId === action.instanceId);
  if (!card) return rejectWith(prevState, 'that card is not in your hand');
  if (isLand(card.def)) return rejectWith(prevState, 'lands are played, not cast');

  // Timing: sorcery-speed spells require your main phase, empty stack, your priority.
  const timing = castTiming(card.def);
  const sorcerySpeedOk =
    action.player === state.activePlayer && MAIN_STEPS.includes(state.step) && state.stack.length === 0;
  if (timing === 'sorcery' && !sorcerySpeedOk) {
    return rejectWith(prevState, 'this spell can only be cast at sorcery speed (your main phase, empty stack)');
  }

  // Pay the mana cost from the floating pool.
  const cost = card.def.cost;
  if (cost) {
    if (!canPay(player.manaPool, cost)) return rejectWith(prevState, 'insufficient mana to cast this spell');
    const result = payCost(player.manaPool, cost);
    if (!result.ok) return rejectWith(prevState, result.reason);
    player.manaPool = result.pool;
  }

  // Move the card to the stack.
  removeFromHand(player, card.instanceId);
  card.zone = 'stack';
  const resolvesTo: StackObject['resolvesTo'] = isPermanentType(card.def) ? 'battlefield' : 'graveyard';
  const stackObject: StackObject = {
    instanceId: card.instanceId,
    card,
    controller: action.player,
    resolvesTo,
    targets: action.targets ?? [],
  };
  state.stack.push(stackObject);
  emit({ type: 'spellCast', player: action.player, instanceId: card.instanceId, name: card.def.name });
  // Caster retains priority after putting something on the stack.
  state.priorityPlayer = action.player;
  state.consecutivePasses = 0;
  return { state, events };
}

function removeFromHand(player: GameState['players'][PlayerId], id: InstanceId): void {
  const idx = player.hand.findIndex((c) => c.instanceId === id);
  if (idx >= 0) player.hand.splice(idx, 1);
}

function applyDeclareAttackers(
  state: GameState,
  prevState: GameState,
  action: Extract<GameAction, { kind: 'declareAttackers' }>,
  emit: (e: GameEvent) => void,
  events: GameEvent[],
): EngineResult {
  if (action.player !== state.activePlayer) return rejectWith(prevState, 'only the active player declares attackers');
  if (action.player !== state.priorityPlayer) return rejectWith(prevState, 'you do not have priority');
  if (state.step !== 'declareAttackers') return rejectWith(prevState, 'not the declare-attackers step');
  if (!state.combat) return rejectWith(prevState, 'not in combat');
  if (state.combat.attackers.length > 0) return rejectWith(prevState, 'attackers already declared');

  // Validate each attacker.
  for (const id of action.attackers) {
    const a = findOnBattlefield(state, id);
    if (!a) return rejectWith(prevState, `attacker ${id} is not on the battlefield`);
    if (a.controller !== action.player) return rejectWith(prevState, `you do not control ${a.def.name}`);
    if (!isCreature(a.def)) return rejectWith(prevState, `${a.def.name} is not a creature`);
    if (a.tapped) return rejectWith(prevState, `${a.def.name} is tapped and cannot attack`);
    if (a.summoningSick && !(a.def.keywords?.haste ?? false)) {
      return rejectWith(prevState, `${a.def.name} has summoning sickness`);
    }
    if (a.def.keywords?.defender) return rejectWith(prevState, `${a.def.name} has defender and cannot attack`);
  }

  state.combat.attackers = [...action.attackers];
  tapAttackers(state, action.attackers, emit);
  emit({ type: 'attackersDeclared', attackers: [...action.attackers] });
  // Priority passes to active player (could cast a trick), then on to blockers.
  state.priorityPlayer = action.player;
  state.consecutivePasses = 0;
  return { state, events };
}

function applyDeclareBlockers(
  state: GameState,
  prevState: GameState,
  action: Extract<GameAction, { kind: 'declareBlockers' }>,
  emit: (e: GameEvent) => void,
  events: GameEvent[],
): EngineResult {
  const defender = defendingPlayerOf(state);
  if (action.player !== defender) return rejectWith(prevState, 'only the defending player declares blockers');
  if (state.step !== 'declareBlockers') return rejectWith(prevState, 'not the declare-blockers step');
  if (!state.combat) return rejectWith(prevState, 'not in combat');
  if (Object.keys(state.combat.blocks).length > 0) return rejectWith(prevState, 'blockers already declared');

  for (const { blocker, attacker } of action.blocks) {
    const b = findOnBattlefield(state, blocker);
    const a = findOnBattlefield(state, attacker);
    if (!b) return rejectWith(prevState, `blocker ${blocker} is not on the battlefield`);
    if (!a) return rejectWith(prevState, `attacker ${attacker} is not on the battlefield`);
    if (b.controller !== action.player) return rejectWith(prevState, `you do not control ${b.def.name}`);
    if (!isCreature(b.def)) return rejectWith(prevState, `${b.def.name} is not a creature`);
    if (!state.combat.attackers.includes(attacker)) {
      return rejectWith(prevState, `${a.def.name} is not attacking`);
    }
    if (!canBlock(a, b)) return rejectWith(prevState, `${b.def.name} cannot block ${a.def.name}`);
  }

  const blocks: Record<InstanceId, InstanceId> = {};
  for (const { blocker, attacker } of action.blocks) blocks[blocker] = attacker;
  state.combat.blocks = blocks;
  emit({
    type: 'blockersDeclared',
    blocks: action.blocks.map((b) => ({ blocker: b.blocker, attacker: b.attacker })),
  });
  state.priorityPlayer = state.activePlayer;
  state.consecutivePasses = 0;
  return { state, events };
}

// --- legal-action generation ---------------------------------------------------

/**
 * Enumerate the legal actions for the current priority-holder. The AI seam: an AI
 * picks one of these against a read-only view. Always includes `passPriority`.
 */
export function generateLegalActions(state: GameState, config: RulesConfig = DEFAULT_RULES): readonly GameAction[] {
  if (state.gameOver) return [];
  const me = state.priorityPlayer;
  const player = state.players[me];
  const actions: GameAction[] = [];

  // Pass priority is always available to the priority-holder.
  actions.push({ kind: 'passPriority', player: me });

  // Tap untapped mana sources you control for mana.
  for (const perm of state.battlefield) {
    if (perm.controller === me && !perm.tapped && (perm.def.produces?.length ?? 0) > 0) {
      actions.push({ kind: 'tapForMana', player: me, instanceId: perm.instanceId });
    }
  }

  const sorcerySpeedWindow = me === state.activePlayer && MAIN_STEPS.includes(state.step) && state.stack.length === 0;

  // Play a land (sorcery-speed, land plays remaining).
  if (sorcerySpeedWindow && player.landsPlayedThisTurn < config.maxLandsPerTurn) {
    for (const card of player.hand) {
      if (isLand(card.def)) {
        actions.push({ kind: 'playLand', player: me, instanceId: card.instanceId });
      }
    }
  }

  // Cast spells you can afford at the appropriate timing.
  for (const card of player.hand) {
    if (isLand(card.def)) continue;
    const timing = castTiming(card.def);
    const timingOk = timing === 'instant' ? true : sorcerySpeedWindow;
    if (!timingOk) continue;
    if (card.def.cost && !canPay(player.manaPool, card.def.cost)) continue;
    actions.push({ kind: 'castSpell', player: me, instanceId: card.instanceId });
  }

  // Declare attackers: a single composite action listing all eligible attackers.
  if (state.step === 'declareAttackers' && me === state.activePlayer && state.combat && state.combat.attackers.length === 0) {
    const eligible = state.battlefield
      .filter(
        (c) =>
          c.controller === me &&
          isCreature(c.def) &&
          !c.tapped &&
          (!c.summoningSick || (c.def.keywords?.haste ?? false)) &&
          !(c.def.keywords?.defender ?? false),
      )
      .map((c) => c.instanceId);
    if (eligible.length > 0) {
      // Offer "attack with all eligible" as the canonical option; the AI may also
      // construct narrower subsets and pass them to applyAction directly.
      actions.push({ kind: 'declareAttackers', player: me, attackers: eligible });
    }
  }

  // Declare blockers: offer the empty (no-block) declaration as a baseline; the AI
  // constructs specific assignments and passes them to applyAction.
  if (state.step === 'declareBlockers' && me === defendingPlayerOf(state) && state.combat) {
    if (Object.keys(state.combat.blocks).length === 0) {
      actions.push({ kind: 'declareBlockers', player: me, blocks: [] });
    }
  }

  return actions;
}

/** Convenience: re-export winner resolution for callers that force-end a game. */
export { resolveWinner };
