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
import { DEFAULT_MANA_MODE } from './actions.js';
import type { ActivatedAbility, CardDefinition, EffectRef } from './card.js';
import { castTiming, isLand, isPermanentType, manaModesOf } from './card.js';
import type { ChoiceAnswer, PendingChoice, ResolutionFrame } from './choices.js';
import {
  choiceOptionCount,
  cloneChoiceAnswer,
  defaultAnswerFor,
  describeChoiceAnswer,
  enumerateChoiceAnswers,
  isTrivialChoice,
  MAX_CHOICES_PER_RESOLUTION,
  normalizeChoiceRequest,
  validateChoiceAnswer,
} from './choices.js';
import type { RulesConfig } from './config.js';
import { DEFAULT_RULES } from './config.js';
import type { ChoiceChannel, EffectRegistry } from './effects.js';
import { applyEffectRef, createEffectRegistry, shuffleLibraryInState } from './effects.js';
import type { GameEvent } from './events.js';
import { createRng, shuffle } from './rng.js';
import {
  addProduction,
  canPay,
  emptyPool,
  MANA_COLORS,
  payCost,
  poolTotal,
} from './mana.js';
import type {
  CardInstance,
  GameState,
  InstanceId,
  PlayerId,
  SpellStackObject,
  Step,
} from './state.js';
import {
  createPlayer,
  MAIN_STEPS,
  PLAYER_IDS,
  STEP_ORDER,
} from './state.js';
import {
  illegalTargetReason,
  illegalTargetReasonForEffects,
  legalTargetsFor,
  restrictionOfEffects,
  targetRestrictionOf,
} from './targeting.js';
import { cloneState } from './internal/clone.js';
import { createTriggerCollector } from './internal/triggers-runtime.js';
import { expireContinuousEffects, indexContinuous, NO_MOD, pruneOrphanContinuousEffects } from './internal/continuous.js';
import { effectiveKeywords } from './internal/stats.js';
import { findOnBattlefield, moveToZone, resetInstanceForNewZone } from './internal/zones.js';
import { checkStateBasedActions, loseGame, resolveWinner } from './internal/sba.js';
import {
  assignAndDealCombatDamage,
  canBlock,
  defendingPlayerOf,
  hasAnyFirstStrike,
  tapAttackers,
} from './internal/combat.js';
import { entersTapped, isCreature } from './card.js';

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
  const baseEmit = (e: GameEvent) => events.push(e);

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
    continuous: [],
    combat: null,
    winner: null,
    gameOver: false,
    consecutivePasses: 0,
    seed: setup.seed,
    rngState: rng.state,
  };

  // Wrap emit so events are scanned for triggers (none can fire during setup
  // before the first upkeep, but beginning-of-upkeep triggers fire as turn 1 opens).
  const collector = createTriggerCollector(state, baseEmit);
  const emit = collector.emit;

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

  // Put any triggers that fired during setup/turn-1 opening (e.g. an upkeep
  // trigger) onto the stack; the active player then holds priority over them.
  if (collector.flush() > 0) {
    state.priorityPlayer = state.activePlayer;
    state.consecutivePasses = 0;
  }

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
      state.combat = { attackers: [], blocks: {}, attackersDeclared: false, blockersDeclared: false };
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
      // "Until end of turn" continuous effects end here (emits an expiry event per
      // effect for the inspector/sim-log), then marked damage clears. Order matters
      // only for observability; expiry before damage-clear mirrors MTG cleanup.
      expireContinuousEffects(state, 'endOfTurn', emit);
      pruneOrphanContinuousEffects(state);
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
function onPassPriority(
  state: GameState,
  config: RulesConfig,
  registry: EffectRegistry,
  emit: (e: GameEvent) => void,
): void {
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
    resolveTopOfStack(state, config, registry, emit);
    // After resolution the active player receives priority again — UNLESS the
    // resolution stopped to ask somebody a question, in which case the floor now
    // belongs to that chooser and priority resumes when they answer.
    if (!state.gameOver && !state.pendingChoice) {
      state.priorityPlayer = state.activePlayer;
    }
    return;
  }
  // Empty stack, both passed → advance the step.
  advanceStep(state, config, emit);
}

/** Resolve the top (last) stack object: run its effects, move it to its zone. */
function resolveTopOfStack(
  state: GameState,
  _config: RulesConfig,
  registry: EffectRegistry,
  emit: (e: GameEvent) => void,
): void {
  const top = state.stack.pop();
  if (!top) return;

  if (top.kind === 'trigger') {
    resolveTriggeredAbility(state, top, registry, emit);
    return;
  }

  const card = top.card;

  emit({ type: 'stackResolved', instanceId: card.instanceId, name: card.def.name });

  // Fast path: a spell with no script (every vanilla creature and land) never asks
  // anybody anything, so it skips the resolution frame entirely and pays nothing
  // for the choice machinery.
  const effects = card.def.effects;
  if (!effects || effects.length === 0) {
    finishSpellResolution(state, card, top.resolvesTo, emit);
    checkStateBasedActions(state, emit);
    return;
  }

  runResolution(
    state,
    {
      origin: 'spell',
      controller: top.controller,
      targets: top.targets,
      effects: effects.slice(),
      next: 0,
      answers: [],
      askCount: 0,
      card,
      resolvesTo: top.resolvesTo,
    },
    registry,
    emit,
  );
}

/**
 * Resolve a triggered ability off the stack: run its effect refs against its source
 * permanent, then leave the stack (no card moves zones). If the source has left the
 * battlefield, the ability still resolves (per MTG) using a last-known-information
 * stand-in source so the effects can run. Robust: unknown primitives degrade to
 * `effectUnsupported` via `applyEffectRef`.
 */
function resolveTriggeredAbility(
  state: GameState,
  obj: Extract<import('./state.js').StackObject, { kind: 'trigger' }>,
  registry: EffectRegistry,
  emit: (e: GameEvent) => void,
): void {
  runResolution(
    state,
    {
      origin: 'trigger',
      controller: obj.controller,
      targets: obj.targets,
      effects: obj.effects.slice(),
      next: 0,
      answers: [],
      askCount: 0,
      sourceInstanceId: obj.sourceInstanceId,
      label: obj.label,
    },
    registry,
    emit,
  );
}

// --- resolution frames + player choice -----------------------------------------

/**
 * The instance a frame's effects run against. Re-derived on every (re)entry rather
 * than captured, because a suspended resolution can outlive its source: a trigger's
 * permanent may die while its controller is answering a question. A source that has
 * gone entirely is replaced by a last-known-information stand-in so the ability
 * still resolves (as MTG requires) instead of silently vanishing.
 */
function frameSource(state: GameState, frame: ResolutionFrame): CardInstance {
  if (frame.card) return frame.card;
  const id = frame.sourceInstanceId ?? 0;
  return (
    findOnBattlefield(state, id) ??
    findInstanceAnywhere(state, id) ?? {
      instanceId: id,
      def: { id: 'unknown-trigger-source', name: 'unknown', types: [] },
      controller: frame.controller,
      owner: frame.controller,
      zone: 'exile',
      tapped: false,
      summoningSick: false,
      damageMarked: 0,
      markedByDeathtouch: false,
      counters: {},
    }
  );
}

/**
 * Run a resolution to completion, or until an effect asks a question.
 *
 * This is the whole suspend/resume mechanism. Effects run in order; if one parks a
 * question, the frame (which effect ref, which answers so far) is stored in state
 * and the chooser gets the floor. `applyAnswerChoice` calls straight back into here
 * with the answer appended, and the same effect ref is re-run — replaying its
 * already-answered questions from `frame.answers` until execution reaches the point
 * it stopped at. Everything is plain data, so this survives a clone, a serialize,
 * and a replay.
 */
function runResolution(
  state: GameState,
  frame: ResolutionFrame,
  registry: EffectRegistry,
  emit: (e: GameEvent) => void,
): void {
  while (frame.next < frame.effects.length) {
    const ref = frame.effects[frame.next] as EffectRef;
    const source = frameSource(state, frame);
    applyEffectRef(
      registry,
      ref,
      { state, source, controller: frame.controller },
      emit,
      frame.targets,
      createChoiceChannel(state, frame, source, emit),
    );
    if (state.pendingChoice) {
      // Parked. Bookmark the resolution and hand the floor to the chooser — who is
      // NOT necessarily the spell's controller (targeted discard is chosen by its
      // victim), and whose only legal action is to answer.
      state.resolution = frame;
      state.priorityPlayer = state.pendingChoice.chooser;
      state.consecutivePasses = 0;
      return;
    }
    frame.next += 1;
    // Answers belong to one effect ref; the next ref starts its own conversation.
    frame.answers.length = 0;
  }
  finishResolution(state, frame, emit);
}

/** Complete a resolution: put the card where it goes / close out the trigger. */
function finishResolution(state: GameState, frame: ResolutionFrame, emit: (e: GameEvent) => void): void {
  state.resolution = null;
  state.pendingChoice = null;
  if (frame.origin === 'spell' && frame.card) {
    finishSpellResolution(state, frame.card, frame.resolvesTo ?? 'graveyard', emit);
  } else {
    emit({
      type: 'triggeredAbilityResolved',
      sourceInstanceId: frame.sourceInstanceId ?? 0,
      label: frame.label ?? '',
    });
  }
  checkStateBasedActions(state, emit);
}

/** Move a finished spell/permanent off the stack into its destination zone. */
function finishSpellResolution(
  state: GameState,
  card: CardInstance,
  resolvesTo: 'battlefield' | 'graveyard',
  emit: (e: GameEvent) => void,
): void {
  if (resolvesTo === 'battlefield') {
    // Stack objects aren't in a player zone; place directly on battlefield.
    card.zone = 'battlefield';
    card.tapped = entersTapped(card.def);
    card.damageMarked = 0;
    card.markedByDeathtouch = false;
    // Summoning sickness: a creature is sick unless it has haste.
    card.summoningSick = isCreature(card.def) ? !(card.def.keywords?.haste ?? false) : false;
    state.battlefield.push(card);
    emit({ type: 'zoneChange', instanceId: card.instanceId, from: 'stack', to: 'battlefield' });
    // The event log is the replay/inspector source (DESIGN §2), and a consumer
    // folding it starts every entering permanent untapped — so arriving tapped has
    // to be SAID, not just stored. `playLand` already emits this; without the same
    // emission here a resolved "enters tapped" permanent replayed as untapped.
    if (card.tapped) emit({ type: 'tapped', instanceId: card.instanceId });
    return;
  }
  // Spell → graveyard.
  card.zone = 'graveyard';
  state.players[card.owner].graveyard.push(card);
  resetInstanceForNewZone(card);
  emit({ type: 'zoneChange', instanceId: card.instanceId, from: 'stack', to: 'graveyard' });
}

/**
 * Build the channel one effect-ref invocation asks its questions through.
 *
 * Questions are numbered per invocation: number `i` is answered from
 * `frame.answers[i]` when that answer already exists (a replay), and otherwise
 * becomes the new parked choice. Because the engine re-runs the ref from the top,
 * a primitive must ask BEFORE it mutates — see `EffectContext.ask`.
 *
 * Every path out of `ask` is safe. A question with exactly one legal answer is
 * answered here rather than put to a human; a chooser who can no longer act gets
 * the default; an unrepresentable question, or a runaway primitive that blows the
 * per-resolution ask budget, is abandoned with an event. None of them can hang.
 */
function createChoiceChannel(
  state: GameState,
  frame: ResolutionFrame,
  source: CardInstance,
  emit: (e: GameEvent) => void,
): ChoiceChannel {
  let askIndex = 0;
  const abandon = (reason: string): undefined => {
    emit({ type: 'choiceAbandoned', sourceInstanceId: source.instanceId, reason });
    return undefined;
  };
  const settle = (choice: PendingChoice, reason: string): ChoiceAnswer => {
    const answer = defaultAnswerFor(choice);
    emit({
      type: 'choiceAutoAnswered',
      choiceId: choice.id,
      chooser: choice.chooser,
      choiceKind: choice.kind,
      answer,
      reason,
    });
    frame.answers.push(answer);
    askIndex += 1;
    return answer;
  };

  return {
    ask(request) {
      const recorded = frame.answers[askIndex];
      if (recorded !== undefined) {
        askIndex += 1;
        return recorded;
      }
      if (frame.askCount >= MAX_CHOICES_PER_RESOLUTION) {
        return abandon(`asked more than ${MAX_CHOICES_PER_RESOLUTION} questions in one resolution`);
      }
      const choice = normalizeChoiceRequest(request, {
        id: state.nextInstanceId++,
        sourceInstanceId: source.instanceId,
        sourceName: source.def.name,
      });
      if (!choice) return abandon(`unknown choice kind '${String((request as { kind?: unknown }).kind)}'`);
      frame.askCount += 1;

      // Only one legal answer (including "no candidates left" — the shape a choice
      // takes when its objects have already left the zone): answer it here rather
      // than stopping the game to collect the inevitable.
      if (isTrivialChoice(choice)) return settle(choice, 'only one legal answer');
      // Nobody left to ask.
      if (state.gameOver || state.players[choice.chooser].hasLost) {
        return settle(choice, 'the chooser can no longer act');
      }

      state.pendingChoice = choice;
      emit({
        type: 'choiceAsked',
        choiceId: choice.id,
        chooser: choice.chooser,
        choiceKind: choice.kind,
        prompt: choice.prompt,
        sourceInstanceId: choice.sourceInstanceId,
        optionCount: choiceOptionCount(choice),
      });
      return undefined;
    },
    enqueueEffects(refs) {
      if (refs.length === 0) return;
      // Insert AFTER the ref now running, so a modal spell's chosen modes resolve
      // in order as part of this same resolution (and may ask questions of their own).
      frame.effects.splice(frame.next + 1, 0, ...refs);
    },
    shuffleLibrary(player) {
      shuffleLibraryInState(state, player);
    },
  };
}


/** Find an instance in any zone (battlefield/hand/grave/exile/stack), else undefined. */
function findInstanceAnywhere(state: GameState, id: InstanceId): CardInstance | undefined {
  const bf = findOnBattlefield(state, id);
  if (bf) return bf;
  for (const pid of PLAYER_IDS) {
    const p = state.players[pid];
    for (const zone of [p.graveyard, p.exile, p.hand, p.library, p.command]) {
      const found = zone.find((c) => c.instanceId === id);
      if (found) return found;
    }
  }
  return undefined;
}

// --- the action entry point ----------------------------------------------------

/**
 * Apply a single action to a state. Clones the input, validates, mutates the
 * draft, and returns the new state + events. Illegal actions are rejected cleanly
 * with an `actionRejected` event — the engine never throw-crashes on bad input.
 *
 * The caller's `prevState` is never modified: this is the pure entry point the
 * sim, the replay, and the UI all rely on. Look-ahead search that owns its state
 * outright can skip the copy with {@link applyActionInPlace}.
 */
export function applyAction(
  prevState: GameState,
  action: GameAction,
  config: RulesConfig = DEFAULT_RULES,
  registry?: EffectRegistry,
): EngineResult {
  return applyActionToDraft(cloneState(prevState), prevState, action, config, registry);
}

/**
 * Apply an action by MUTATING `state` directly, skipping the defensive clone.
 *
 * This exists for look-ahead search (the MCTS pilot), which plays out hundreds of
 * thousands of hypothetical actions and already owns a private copy of the state.
 * `applyAction`'s clone deep-copies both players' whole libraries — well over a
 * hundred card instances — on EVERY action, so cloning per ply dominated rollout
 * cost. Cloning once per playout instead and mutating from there is exactly the
 * same search: identical actions, identical results, far less garbage.
 *
 * ⚠️ The caller MUST own `state` exclusively — anything still holding a reference
 * observes the mutation. Never pass a state the sim, the UI, or a replay can see.
 * Prefer {@link applyAction} everywhere else.
 *
 * Rejections are still safe: every action validates fully before it mutates, so a
 * rejected action leaves `state` untouched (it returns a copy, as the pure path
 * does, keeping the two entry points' contracts identical).
 */
export function applyActionInPlace(
  state: GameState,
  action: GameAction,
  config: RulesConfig = DEFAULT_RULES,
  registry?: EffectRegistry,
): EngineResult {
  return applyActionToDraft(state, state, action, config, registry);
}

/**
 * The shared body: `state` is a draft the caller permits us to mutate, and
 * `prevState` is what a rejection reports (cloned by `rejectWith`, so a rejected
 * action never hands back an aliased or half-written state either way).
 */
function applyActionToDraft(
  state: GameState,
  prevState: GameState,
  action: GameAction,
  config: RulesConfig,
  registry?: EffectRegistry,
): EngineResult {
  const events: GameEvent[] = [];
  const baseEmit = (e: GameEvent) => events.push(e);
  // Wrap emit so every mutation's event is scanned for triggered abilities. The
  // collector queues matches; we flush onto the stack once the action's mutations
  // settle (below), so triggers go on the stack the moment before priority returns.
  const collector = createTriggerCollector(state, baseEmit);
  const emit = collector.emit;
  // Thread the effect registry explicitly through the call chain (no module
  // global). With none supplied, default to an empty registry: registry-free
  // actions (playLand/passPriority/combat) are unaffected; only spell resolution
  // needs primitives, and a bare call signals "no cards registered".
  const effectRegistry = registry ?? createEffectRegistry();

  if (state.gameOver) {
    baseEmit({ type: 'actionRejected', reason: 'the game is already over' });
    return { state, events };
  }

  const dispatch = (): EngineResult => {
    // A parked question freezes the game for everyone else: while it stands, the
    // only thing anybody may do is answer it. Without this a player could pass
    // priority (or attack) "around" a half-resolved spell.
    if (state.pendingChoice && action.kind !== 'answerChoice') {
      return rejectWith(prevState, 'a choice is awaiting an answer');
    }
    switch (action.kind) {
      case 'answerChoice':
        return applyAnswerChoice(state, prevState, action, effectRegistry, emit, events);
      case 'passPriority': {
        if (action.player !== state.priorityPlayer) return rejectWith(prevState, 'you do not have priority');
        onPassPriority(state, config, effectRegistry, emit);
        return { state, events };
      }
      case 'playLand':
        return applyPlayLand(state, prevState, action, config, emit, events);
      case 'tapForMana':
        return applyTapForMana(state, prevState, action, emit, events);
      case 'castSpell':
        return applyCastSpell(state, prevState, action, config, emit, events);
      case 'activateAbility':
        return applyActivateAbility(state, prevState, action, config, emit, events);
      case 'declareAttackers':
        return applyDeclareAttackers(state, prevState, action, emit, events);
      case 'declareBlockers':
        return applyDeclareBlockers(state, prevState, action, emit, events);
      default: {
        const _exhaustive: never = action;
        void _exhaustive;
        return rejectWith(prevState, 'unknown action');
      }
    }
  };

  const result = dispatch();
  // On a clean (non-rejected) action, put any triggered abilities that fired onto
  // the stack and hand the active player priority over them. Rejections return a
  // fresh clone of prevState, so `result.state !== state`; we only flush our draft.
  if (result.state === state && !result.events.some((e) => e.type === 'actionRejected')) {
    // A suspended resolution keeps the floor: a trigger that fired mid-resolution
    // goes on the stack and waits its turn, but the chooser must still answer first.
    if (collector.flush() > 0 && !state.gameOver && !state.pendingChoice) {
      state.priorityPlayer = state.activePlayer;
      state.consecutivePasses = 0;
    }
  }
  return result;
}

function rejectWith(prevState: GameState, reason: string): EngineResult {
  return { state: cloneState(prevState), events: [{ type: 'actionRejected', reason }] };
}

/**
 * Answer the parked question and resume the resolution it belongs to.
 *
 * Every rejection here is a *clean* one — the pending choice and the suspended
 * frame are left exactly as they were, so a wrong seat answering, a stale answer,
 * or a malformed one from a hostile client costs nothing and the real chooser can
 * still answer. This is the entry point the online server exposes to the wire, so
 * "rejects without corrupting" is a security property, not just tidiness.
 */
function applyAnswerChoice(
  state: GameState,
  prevState: GameState,
  action: Extract<GameAction, { kind: 'answerChoice' }>,
  registry: EffectRegistry,
  emit: (e: GameEvent) => void,
  events: GameEvent[],
): EngineResult {
  const choice = state.pendingChoice;
  if (!choice) return rejectWith(prevState, 'no choice is awaiting an answer');
  // Answers name their question, so an answer to an already-resolved choice (a
  // slow client, a replayed packet) is refused instead of applied to whatever
  // question happens to be open now.
  if (action.choiceId !== choice.id) return rejectWith(prevState, 'that answer is for a different choice');
  if (action.player !== choice.chooser) return rejectWith(prevState, `only player ${choice.chooser} makes this choice`);
  const verdict = validateChoiceAnswer(choice, action.answer);
  if (!verdict.ok) return rejectWith(prevState, verdict.reason);

  // Copy the answer out of the caller's action: it is about to live in both the
  // event log and the resumed frame, and neither may alias caller-owned data.
  const answer = cloneChoiceAnswer(action.answer);
  emit({
    type: 'choiceAnswered',
    choiceId: choice.id,
    chooser: choice.chooser,
    choiceKind: choice.kind,
    answer,
    summary: describeChoiceAnswer(answer),
  });
  state.pendingChoice = null;

  const frame = state.resolution;
  if (!frame) {
    // Defensive: a choice with nothing to resume (only reachable from a hand-built
    // state). Clearing it is the safe outcome — the game continues normally.
    state.priorityPlayer = state.activePlayer;
    state.consecutivePasses = 0;
    return { state, events };
  }
  state.resolution = null;
  frame.answers.push(cloneChoiceAnswer(answer));
  runResolution(state, frame, registry, emit);

  // Resolution finished (rather than parking on a follow-up question) → priority
  // returns to the active player, exactly as it does after any other resolution.
  if (!state.pendingChoice && !state.gameOver) {
    state.priorityPlayer = state.activePlayer;
    state.consecutivePasses = 0;
  }
  return { state, events };
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
  card.tapped = entersTapped(card.def);
  card.summoningSick = false; // lands aren't affected by summoning sickness
  if (card.tapped) emit({ type: 'tapped', instanceId: card.instanceId });
  player.landsPlayedThisTurn += 1;
  emit({ type: 'landPlayed', player: action.player, instanceId: card.instanceId });
  // Playing a land is a special action: the player retains priority.
  state.consecutivePasses = 0;
  return { state, events };
}

/**
 * Whether `perm` may activate a `{T}` mana ability right now — rule 302.6: a
 * summoning-sick **creature** can't pay a `{T}` cost unless it has haste. This is
 * the same restriction that gates attacking, and it is why a Birds of Paradise
 * cannot tap for mana the turn it lands. Non-creature sources (lands, mana rocks)
 * are never summoning sick, so they always qualify.
 *
 * `cont` is the continuous-effect index, consulted only to honour a *granted*
 * haste — printed haste already clears sickness on entry — so callers with no
 * sick creature source can skip building it and pass `undefined`.
 */
function canActivateManaAbility(
  perm: CardInstance,
  cont: ReturnType<typeof indexContinuous> | undefined,
): boolean {
  if (!perm.summoningSick || !isCreature(perm.def)) return true;
  return Boolean(effectiveKeywords(perm, cont?.get(perm.instanceId) ?? NO_MOD).haste);
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
  const modes = manaModesOf(source.def);
  if (modes.length === 0) return rejectWith(prevState, 'that permanent does not produce mana');
  // Short-circuit BEFORE indexing continuous effects: tapping for mana is the most
  // frequent action in the game, and only a summoning-sick creature source can
  // raise the granted-haste question that needs the index.
  if (source.summoningSick && isCreature(source.def) && !canActivateManaAbility(source, indexContinuous(state))) {
    return rejectWith(prevState, `${source.def.name} has summoning sickness`);
  }
  const mode = action.mode ?? DEFAULT_MANA_MODE;
  const production = modes[mode];
  if (!production) return rejectWith(prevState, `${source.def.name} has no mana mode ${mode}`);

  source.tapped = true;
  emit({ type: 'tapped', instanceId: source.instanceId });
  const player = state.players[action.player];
  player.manaPool = addProduction(player.manaPool, production);
  for (const color of MANA_COLORS) {
    const amount = production[color] ?? 0;
    if (amount > 0) emit({ type: 'manaAdded', player: action.player, color, amount });
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

  // Target legality (targeting.ts). A spell whose printed text restricts what it
  // may point at ("to target creature", "to target player or planeswalker") is
  // rejected here when handed an illegal target — the engine, not the caller, is
  // the authority, so a pilot or a UI that builds its own action cannot play a
  // card as strictly better than printed.
  const targetProblem = illegalTargetReason(state, card.def, action.targets ?? []);
  if (targetProblem) return rejectWith(prevState, targetProblem);

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
  const resolvesTo: SpellStackObject['resolvesTo'] = isPermanentType(card.def) ? 'battlefield' : 'graveyard';
  const stackObject: SpellStackObject = {
    kind: 'spell',
    instanceId: card.instanceId,
    card,
    controller: action.player,
    resolvesTo,
    targets: action.targets ?? [],
  };
  state.stack.push(stackObject);
  emit({
    type: 'spellCast',
    player: action.player,
    instanceId: card.instanceId,
    name: card.def.name,
    castTypes: [...card.def.types],
  });
  // Caster retains priority after putting something on the stack.
  state.priorityPlayer = action.player;
  state.consecutivePasses = 0;
  return { state, events };
}

/**
 * Activate a permanent's non-mana ability: check timing and legality, PAY the
 * whole cost, then put the ability on the stack.
 *
 * Order matters and follows rule 602.2: everything is validated first, then the
 * cost is paid in full, then the ability goes on the stack. Costs are not
 * refunded if the ability is later countered or its target disappears — which is
 * why a fetchland that gets its search fizzled has still paid the life and gone
 * to the graveyard.
 *
 * The ability goes on the stack as a `trigger` object. It is not a triggered
 * ability, but the two are identical from the stack's point of view — a
 * controller, a source, effects, and targets, with no card changing zones — so
 * they share one resolution path rather than growing a third stack-object kind
 * that every consumer (masking, replay, AI) would have to learn.
 */
function applyActivateAbility(
  state: GameState,
  prevState: GameState,
  action: Extract<GameAction, { kind: 'activateAbility' }>,
  _config: RulesConfig,
  emit: (e: GameEvent) => void,
  events: GameEvent[],
): EngineResult {
  if (action.player !== state.priorityPlayer) return rejectWith(prevState, 'you do not have priority');

  const source = findOnBattlefield(state, action.instanceId);
  if (!source) return rejectWith(prevState, 'that permanent is not on the battlefield');
  if (source.controller !== action.player) return rejectWith(prevState, 'you do not control that permanent');

  const ability = source.def.activated?.[action.abilityIndex];
  if (!ability) return rejectWith(prevState, 'that permanent has no such activated ability');

  // Timing: the rules default for an activated ability is instant speed; only
  // one that says "activate only as a sorcery" is restricted.
  const timing = ability.timing ?? 'instant';
  const sorcerySpeedOk =
    action.player === state.activePlayer && MAIN_STEPS.includes(state.step) && state.stack.length === 0;
  if (timing === 'sorcery' && !sorcerySpeedOk) {
    return rejectWith(prevState, 'this ability can only be activated at sorcery speed');
  }

  const problem = unpayableActivationReason(state, source, ability);
  if (problem) return rejectWith(prevState, problem);

  // Target legality, from the ability's OWN effects rather than the card's — a
  // permanent's spell script and its activated ability can target different
  // things, so the ability is policed against what it actually does.
  const targetProblem = illegalTargetReasonForEffects(
    state,
    `${source.def.name}'s ability`,
    ability.effects,
    action.targets ?? [],
  );
  if (targetProblem) return rejectWith(prevState, targetProblem);

  // --- pay the cost, in full, before anything reaches the stack ---
  const player = state.players[action.player];
  const cost = ability.cost;
  if (cost.mana) {
    const paid = payCost(player.manaPool, cost.mana);
    if (!paid.ok) return rejectWith(prevState, paid.reason);
    player.manaPool = paid.pool;
  }
  if (cost.tap) {
    source.tapped = true;
    emit({ type: 'tapped', instanceId: source.instanceId });
  }
  if (cost.life && cost.life > 0) {
    player.life -= cost.life;
    emit({ type: 'lifeChanged', player: action.player, delta: -cost.life, to: player.life });
  }
  if (cost.sacrificeSelf) {
    // Sacrificing is a zone change to the graveyard, using the same path death
    // does, so leaves-the-battlefield triggers and instance reset behave alike.
    moveToZone(state, source, 'graveyard', emit, source.owner);
    resetInstanceForNewZone(source);
  }

  state.stack.push({
    kind: 'trigger',
    instanceId: state.nextInstanceId++,
    sourceInstanceId: source.instanceId,
    controller: action.player,
    effects: ability.effects,
    targets: action.targets ?? [],
    label: ability.label,
  });
  emit({
    type: 'abilityActivated',
    player: action.player,
    instanceId: source.instanceId,
    label: ability.label,
  });

  // The activating player retains priority, as with casting a spell.
  state.priorityPlayer = action.player;
  state.consecutivePasses = 0;
  return { state, events };
}

/**
 * Why this ability's cost cannot be paid right now, or `undefined` when it can.
 *
 * Shared by the legal-action generator and the applier so "offered" and
 * "accepted" can never disagree — a pilot is never handed an action the engine
 * would then reject.
 */
function unpayableActivationReason(
  state: GameState,
  source: CardInstance,
  ability: ActivatedAbility,
): string | undefined {
  const cost = ability.cost;
  if (cost.tap) {
    if (source.tapped) return 'that permanent is already tapped';
    // Rule 302.6: a creature's {T} cost needs it to have been under your control
    // since your turn began, unless it has haste. Reuses the same check the mana
    // abilities use, so both kinds of `{T}` obey summoning sickness identically.
    if (!canActivateManaAbility(source, indexContinuous(state))) {
      return `${source.def.name} has summoning sickness`;
    }
  }
  const player = state.players[source.controller];
  if (cost.life && cost.life > 0 && player.life <= cost.life) {
    // You may pay life only down to 0, and paying all of it would lose the game
    // to a state-based action before the ability ever resolved.
    return 'you do not have enough life to pay that cost';
  }
  if (cost.mana && !canPay(player.manaPool, cost.mana)) return 'insufficient mana for that ability';
  return undefined;
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
  if (state.combat.attackersDeclared) return rejectWith(prevState, 'attackers already declared');

  // A creature attacks at most ONCE. `combat.attackers` is a flat list the damage
  // step iterates, so a repeated id would have the same creature deal its damage
  // once per occurrence — a caller passing `[id, id]` hit for double power. Reject
  // the malformed declaration rather than silently doubling combat damage.
  const declaredAttackers = new Set<InstanceId>();
  for (const id of action.attackers) {
    if (declaredAttackers.has(id)) return rejectWith(prevState, `attacker ${id} was declared more than once`);
    declaredAttackers.add(id);
  }

  // Validate each attacker. Read EFFECTIVE keywords (printed OR continuous grants)
  // so an until-EOT haste/defender grant is honored for attack legality (DESIGN §3.9).
  const cont = indexContinuous(state);
  for (const id of action.attackers) {
    const a = findOnBattlefield(state, id);
    if (!a) return rejectWith(prevState, `attacker ${id} is not on the battlefield`);
    if (a.controller !== action.player) return rejectWith(prevState, `you do not control ${a.def.name}`);
    if (!isCreature(a.def)) return rejectWith(prevState, `${a.def.name} is not a creature`);
    if (a.tapped) return rejectWith(prevState, `${a.def.name} is tapped and cannot attack`);
    const kw = effectiveKeywords(a, cont.get(a.instanceId) ?? NO_MOD);
    if (a.summoningSick && !kw.haste) {
      return rejectWith(prevState, `${a.def.name} has summoning sickness`);
    }
    if (kw.defender) return rejectWith(prevState, `${a.def.name} has defender and cannot attack`);
  }

  state.combat.attackers = [...action.attackers];
  state.combat.attackersDeclared = true;
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
  if (state.combat.blockersDeclared) return rejectWith(prevState, 'blockers already declared');

  // Read EFFECTIVE evasion (printed OR continuous grants) so an until-EOT flying/reach
  // grant is honored for block legality, matching the damage step which builds the same
  // index (DESIGN §3.9). Build it once and thread it into every canBlock check.
  const cont = indexContinuous(state);
  // `combat.blocks` is a blocker→attacker map, so a blocker named twice would have
  // all but its LAST assignment silently discarded — turning "I block both" into
  // "one attacker is unblocked" without telling the player. A creature blocks one
  // attacker in this MVP, so a repeated blocker is an illegal declaration: reject it
  // instead of quietly rewriting the defender's choice.
  const declaredBlockers = new Set<InstanceId>();
  for (const { blocker } of action.blocks) {
    if (declaredBlockers.has(blocker)) return rejectWith(prevState, `blocker ${blocker} was assigned more than once`);
    declaredBlockers.add(blocker);
  }
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
    if (!canBlock(a, b, cont)) return rejectWith(prevState, `${b.def.name} cannot block ${a.def.name}`);
  }

  const blocks: Record<InstanceId, InstanceId> = {};
  for (const { blocker, attacker } of action.blocks) blocks[blocker] = attacker;
  state.combat.blocks = blocks;
  state.combat.blockersDeclared = true;
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
  // A parked question preempts the whole game: the only legal action is its
  // chooser answering it. This is what makes the choice system invisible to every
  // consumer — the sim loop, MCTS, the hotseat UI and the server already ask for
  // legal actions and apply one, so they answer questions with no change at all.
  if (state.pendingChoice) return choiceActionsFor(state.pendingChoice);
  const me = state.priorityPlayer;
  const player = state.players[me];
  const actions: GameAction[] = [];

  // Pass priority is always available to the priority-holder.
  actions.push({ kind: 'passPriority', player: me });

  // Tap untapped mana sources you control for mana. A MODAL source offers one
  // action per mode, so choosing the color is part of the action an AI scores
  // rather than a hidden engine default. Summoning-sick creature sources are
  // excluded (rule 302.6 — see `canActivateManaAbility`).
  let manaCont: ReturnType<typeof indexContinuous> | undefined;
  for (const perm of state.battlefield) {
    if (perm.controller !== me || perm.tapped) continue;
    const modes = manaModesOf(perm.def);
    if (modes.length === 0) continue;
    // Build the continuous index only when a sick creature source actually raises
    // the granted-haste question — the ordinary board never pays for it.
    if (perm.summoningSick && isCreature(perm.def)) {
      manaCont ??= indexContinuous(state);
      if (!canActivateManaAbility(perm, manaCont)) continue;
    }
    for (let mode = 0; mode < modes.length; mode++) {
      actions.push({ kind: 'tapForMana', player: me, instanceId: perm.instanceId, mode });
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
  //
  // A spell that declares a TARGET RESTRICTION (targeting.ts) is offered once per
  // LEGAL target instead of once bare, so a consumer that only picks from this
  // menu physically cannot choose an illegal target — and a restricted spell with
  // no legal target on the board is not offered at all, because a spell with no
  // legal target cannot be cast. Unrestricted spells keep their single bare offer:
  // their targets (a stack object, the source itself, none) are chosen by the
  // caller, and enumerating them here would change every consumer's action space.
  for (const card of player.hand) {
    if (isLand(card.def)) continue;
    const timing = castTiming(card.def);
    const timingOk = timing === 'instant' ? true : sorcerySpeedWindow;
    if (!timingOk) continue;
    if (card.def.cost && !canPay(player.manaPool, card.def.cost)) continue;
    const restriction = targetRestrictionOf(card.def);
    if (restriction === undefined) {
      actions.push({ kind: 'castSpell', player: me, instanceId: card.instanceId });
      continue;
    }
    for (const target of legalTargetsFor(state, restriction)) {
      actions.push({ kind: 'castSpell', player: me, instanceId: card.instanceId, targets: [target] });
    }
  }

  // Activate non-mana abilities of permanents you control. Mirrors the casting
  // rules above: timing is checked, the whole cost must be payable, and an
  // ability with a target restriction is offered once per LEGAL target (and not
  // at all when there is none), so this menu can only contain playable actions.
  for (const perm of state.battlefield) {
    if (perm.controller !== me) continue;
    const abilities = perm.def.activated;
    if (!abilities || abilities.length === 0) continue;
    for (let index = 0; index < abilities.length; index++) {
      const ability = abilities[index]!;
      const timing = ability.timing ?? 'instant';
      if (timing === 'sorcery' && !sorcerySpeedWindow) continue;
      if (unpayableActivationReason(state, perm, ability)) continue;
      const restriction = restrictionOfEffects(ability.effects);
      if (restriction === undefined) {
        actions.push({ kind: 'activateAbility', player: me, instanceId: perm.instanceId, abilityIndex: index });
        continue;
      }
      for (const target of legalTargetsFor(state, restriction)) {
        actions.push({
          kind: 'activateAbility',
          player: me,
          instanceId: perm.instanceId,
          abilityIndex: index,
          targets: [target],
        });
      }
    }
  }

  // Declare attackers: a single composite action listing all eligible attackers.
  // Gated on the DECLARED flag, not on emptiness — "I attack with nobody" is a
  // real choice, and re-offering it afterwards is what let a searching pilot
  // declare an empty attack forever without the step ever advancing.
  if (state.step === 'declareAttackers' && me === state.activePlayer && state.combat && !state.combat.attackersDeclared) {
    // Effective keywords (printed OR continuous grants) so a haste/defender granted
    // by an until-EOT effect is reflected in the eligible-attacker set (DESIGN §3.9).
    const cont = indexContinuous(state);
    const eligible = state.battlefield
      .filter((c) => {
        if (c.controller !== me || !isCreature(c.def) || c.tapped) return false;
        const kw = effectiveKeywords(c, cont.get(c.instanceId) ?? NO_MOD);
        return (!c.summoningSick || Boolean(kw.haste)) && !kw.defender;
      })
      .map((c) => c.instanceId);
    if (eligible.length > 0) {
      // Offer "attack with all eligible" as the canonical option; the AI may also
      // construct narrower subsets and pass them to applyAction directly.
      actions.push({ kind: 'declareAttackers', player: me, attackers: eligible });
    }
  }

  // Declare blockers: offer the empty (no-block) declaration as a baseline; the AI
  // constructs specific assignments and passes them to applyAction. Same reasoning
  // as attackers — gate on the flag, since declaring no blocks is legal and common.
  if (
    state.step === 'declareBlockers' &&
    me === defendingPlayerOf(state) &&
    state.combat &&
    !state.combat.blockersDeclared
  ) {
    actions.push({ kind: 'declareBlockers', player: me, blocks: [] });
  }

  return actions;
}

/**
 * The `answerChoice` actions offered for a parked choice — a BOUNDED, always
 * non-empty menu (see `MAX_ENUMERATED_CHOICE_ANSWERS`). `applyAction` accepts any
 * valid answer besides these, exactly as it accepts attack/block subsets a pilot
 * builds itself, so a UI or a pilot that wants a specific ordering is not limited
 * to the menu.
 */
export function choiceActionsFor(choice: PendingChoice): readonly GameAction[] {
  return enumerateChoiceAnswers(choice).map(
    (answer): GameAction => ({ kind: 'answerChoice', player: choice.chooser, choiceId: choice.id, answer }),
  );
}

/** Convenience: re-export winner resolution for callers that force-end a game. */
export { resolveWinner };
