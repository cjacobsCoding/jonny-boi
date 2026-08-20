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

import type { CastZone, GameAction } from './actions.js';
import { DEFAULT_MANA_MODE } from './actions.js';
import type {
  ActivatedAbility,
  AdditionalCastCost,
  CardDefinition,
  EffectRef,
  ManaAbility,
  ManaModeExtra,
} from './card.js';
import {
  canRevealForUntapped,
  castTiming,
  fixedManaColorsOf,
  backFaceCastZonesOf,
  hasCastableBackFace,
  isLand,
  isPermanentType,
  manaActivationConditionMet,
  manaExtrasOf,
  manaModesOf,
  playableFaceOf,
} from './card.js';
import type { ChoiceAnswer, ChoiceRequest, PendingChoice, ResolutionFrame, TargetOption } from './choices.js';
import {
  cardOption,
  choiceOptionCount,
  cloneChoiceAnswer,
  defaultAnswerFor,
  describeChoiceAnswer,
  enumerateChoiceAnswers,
  isTrivialChoice,
  matchesCardFilter,
  MAX_CHOICES_PER_RESOLUTION,
  normalizeChoiceRequest,
  NOTHING_CHOSEN,
  permanentTargetOption,
  validateChoiceAnswer,
} from './choices.js';
import { interveningIfHolds } from './intervening.js';
import { asEntersOptions, asEntersPrompt, chosenColorOf, recordChosenAsEntered } from './as-enters.js';
import type { RulesConfig } from './config.js';
import { DEFAULT_RULES } from './config.js';
import type { ChoiceChannel, EffectRegistry } from './effects.js';
import { applyEffectRef, createEffectRegistry, shuffleLibraryInState } from './effects.js';
import type { GameEvent } from './events.js';
import { createRng, shuffle } from './rng.js';
import type { ManaColor, ManaCost, ManaProduction } from './mana.js';
import { repeatCost } from './mana.js';
import {
  addProduction,
  canPay,
  emptyPool,
  formatManaCost,
  MANA_COLORS,
  payCost,
  poolTotal,
} from './mana.js';
import type { ManaTapPlan } from './mana-plan.js';
import { planManaPayment } from './mana-plan.js';
import type {
  CardInstance,
  GameState,
  InstanceId,
  ModePick,
  PlayerId,
  SpellStackObject,
  StackObject,
  Step,
  TriggeredStackObject,
} from './state.js';
import {
  createPlayer,
  MAIN_STEPS,
  NO_COUNTERS,
  PLAYER_IDS,
  protectorOf,
  spellLeaveDestination,
  STEP_ORDER,
} from './state.js';
import type { TargetRestriction } from './targeting.js';
import {
  describeRestriction,
  illegalTargetReason,
  illegalTargetReasonForEffects,
  isPlayerTarget,
  legalTargetsFor,
  restrictionOfEffects,
  targetRestrictionOf,
} from './targeting.js';
import { WARD_COST_PARAM, WARD_COUNTER_PRIMITIVE, effectiveWardOf } from './protection.js';
import {
  modalSpecOf,
  modalSpellIsCastable,
  modeById,
  modeCountsFor,
  nextUnaimedPick,
  orderPicks,
  picksToResolution,
} from './modal.js';
import {
  addCardGrant,
  castPermissionFor,
  expireCardGrants,
  flashbackCostOf,
  hasCardGrants,
  pruneCardGrantsFor,
} from './card-grants.js';
import { declineMadness } from './madness.js';
import { cloneState } from './internal/clone.js';
import { createTriggerCollector } from './internal/triggers-runtime.js';
import { clearTurnFacts } from './turn-facts.js';
import { expireContinuousEffects, indexContinuous, NO_MOD, pruneOrphanContinuousEffects } from './internal/continuous.js';
import { effectiveKeywords } from './internal/stats.js';
import { findOnBattlefield, moveToZone, resetInstanceForNewZone } from './internal/zones.js';
import { applyLegendRuleChoice, checkStateBasedActions, loseGame, resolveWinner } from './internal/sba.js';
import {
  assignAndDealCombatDamage,
  canBlock,
  illegalBlockDeclaration,
  defendingPlayerOf,
  hasAnyFirstStrike,
  tapAttackers,
} from './internal/combat.js';
import { entersTapped, isAttackable, isCreature, isPlaneswalker } from './card.js';
import { addLoyalty, applyEnteringDefense, applyEnteringLoyalty, loyaltyOf, removeLoyalty } from './internal/stats.js';

/**
 * The registry a caller that supplied none gets.
 *
 * Built once at module load rather than per action. `createEffectRegistry()` makes
 * a Map and four closures, and `applyAction` was calling it on EVERY registry-free
 * action — which is every action of every test and every look-ahead rollout that
 * doesn't thread the pool through. Sharing one is safe because it never escapes:
 * the registry is only ever READ (`applyEffectRef` calls `get`), it is not part of
 * `EffectContext`, and nothing hands it back to a caller who could `register` into
 * it. Callers that want a registry of their own still call `createEffectRegistry`.
 */
const NO_REGISTRY: EffectRegistry = createEffectRegistry();

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
    counters: NO_COUNTERS,
    // `attachedTo` is deliberately NOT written here. It is optional, absent means
    // "attached to nothing", and leaving it off keeps every freshly-minted instance
    // on the exact same object shape `cloneInstance` produces for an unattached
    // permanent — writing it here instead put the original and its clone on two
    // different shapes and cost measurable throughput on the engine's hottest loop.
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
    // A trigger that names a target chooses it now, before anybody holds priority.
    aimPendingTriggers(state, emit);
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
  // A new turn: nothing has happened in it yet. Cleared as the turn BEGINS
  // rather than at cleanup, so "this turn" still reads true for anything
  // resolving in the previous turn's end step (see turn-facts.ts).
  clearTurnFacts(state);
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
      // A grant made to a card in a graveyard wears off on the same clock
      // (Snapcaster's "until end of turn"), through its own list — see
      // `card-grants.ts` for why it is not part of the continuous layer.
      expireCardGrants(state, 'endOfTurn', emit);
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
  // A parked question outranks priority: while one is outstanding the ONLY legal
  // action is its chooser answering it (`generateLegalActions`), and that chooser
  // may not be the active player. Handing the floor to the active player here
  // would leave the board saying "your move" to a seat with nothing to do — the
  // exact UX defect the online branch spent a session diagnosing. State-based
  // actions can now raise such a question (the legend rule), so this is reachable
  // from the turn machine and not only from an action handler.
  if (state.pendingChoice) return;
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

  // Where the card goes when it is done: the battlefield for a permanent, and
  // otherwise the ONE answer `spellLeaveDestination` gives — graveyard, exile
  // for a flashback cast, or back to hand for a bought-back spell. Computed
  // once here so the fast path, the resolution frame, and countering all read
  // the same function rather than three opinions.
  const leaveTo: 'battlefield' | 'graveyard' | 'exile' | 'hand' =
    top.resolvesTo === 'battlefield' ? 'battlefield' : spellLeaveDestination(top, 'resolve');
  // A MODAL spell's script IS its announced modes: printed order, each mode's
  // effects carrying that mode's OWN chosen target (a mode whose target has
  // since become illegal simply does not happen, while its siblings still do —
  // CR 608.2b). This is the whole payoff of choosing at cast time.
  const picks = top.modePicks;
  const modal = picks ? picksToResolution(state, card.def, picks, top.controller) : undefined;
  const effects = modal ? modal.effects : card.def.effects;

  // Fast path: a spell with no script (every vanilla creature and land) never asks
  // anybody anything, so it skips the resolution frame entirely and pays nothing
  // for the choice machinery.
  if (!effects || effects.length === 0) {
    finishSpellResolution(state, card, leaveTo, emit, top);
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
      resolvesTo: leaveTo,
      // Cast-time choices ride the frame from here on: the resolution outlives
      // the stack object, and "deals X damage" is read during (and after) it.
      ...(top.xValue !== undefined ? { xValue: top.xValue } : {}),
      ...(top.kicked !== undefined ? { kicked: top.kicked } : {}),
      ...(top.kickCount !== undefined ? { kickCount: top.kickCount } : {}),
      ...(modal ? { effectTargets: modal.effectTargets } : {}),
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
  // CR 603.4's SECOND check: a trigger whose intervening "if" has stopped
  // holding is removed from the stack and does nothing. Checked here, before any
  // effect runs, against the same evaluator the collector used when the ability
  // triggered — one condition, one reader, no way for the two to disagree.
  if (!interveningIfHolds(state, obj.intervening, obj.sourceInstanceId, obj.controller, obj.triggeringPlayer)) {
    emit({
      type: 'triggerFizzled',
      sourceInstanceId: obj.sourceInstanceId,
      controller: obj.controller,
      label: obj.label,
      reason: 'its intervening "if" condition is no longer true',
    });
    checkStateBasedActions(state, emit);
    return;
  }
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
      // The triggering player rides the frame from here on, for the same reason
      // a cast's chosen X does: the resolution outlives the stack object, and
      // "that player draws an additional card" is read during it.
      ...(obj.triggeringPlayer !== undefined ? { triggeringPlayer: obj.triggeringPlayer } : {}),
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
      counters: NO_COUNTERS,
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
    // A modal spell's effects each point where THEIR mode was aimed; everything
    // else falls back to the one frame-wide target list, exactly as before.
    const refTargets = frame.effectTargets?.[frame.next] ?? frame.targets;
    applyEffectRef(
      registry,
      ref,
      {
        state,
        source,
        controller: frame.controller,
        xValue: frame.xValue,
        kicked: frame.kicked,
        kickCount: frame.kickCount,
        triggeringPlayer: frame.triggeringPlayer,
      },
      emit,
      refTargets,
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
    finishSpellResolution(state, frame.card, frame.resolvesTo ?? 'graveyard', emit, frame);
  } else {
    emit({
      type: 'triggeredAbilityResolved',
      sourceInstanceId: frame.sourceInstanceId ?? 0,
      label: frame.label ?? '',
    });
  }
  checkStateBasedActions(state, emit);
}

/**
 * What a resolving spell still remembers about how it was KICKED — carried from
 * the stack object (fast path) or the resolution frame (scripted path) so a
 * permanent entering the battlefield can record it on the instance.
 */
interface KickRecord {
  readonly kicked?: boolean;
  readonly kickCount?: number;
}

/** Move a finished spell/permanent off the stack into its destination zone. */
function finishSpellResolution(
  state: GameState,
  card: CardInstance,
  resolvesTo: 'battlefield' | 'graveyard' | 'exile' | 'hand',
  emit: (e: GameEvent) => void,
  kick?: KickRecord,
): void {
  if (resolvesTo === 'battlefield') {
    // Stack objects aren't in a player zone; place directly on battlefield.
    card.zone = 'battlefield';
    // How many times the spell was kicked follows the PERMANENT onto the
    // battlefield: the resolution frame dies here, but an enters-the-battlefield
    // trigger ("create a 1/1 for each time it was kicked") resolves afterwards
    // and must still be able to read it. A plain (non-multi) kicker records 1.
    const times = kick?.kickCount ?? (kick?.kicked === true ? 1 : 0);
    if (times > 0) card.timesKicked = times;
    // Evaluated BEFORE the push below, so a conditional land ("unless you
    // control two or fewer other lands") never counts itself among the others.
    card.tapped = entersTapped(card.def, {
      controller: card.controller,
      battlefield: state.battlefield,
      self: card,
    });
    card.damageMarked = 0;
    card.markedByDeathtouch = false;
    // Summoning sickness: a creature is sick unless it has haste.
    card.summoningSick = isCreature(card.def) ? !(card.def.keywords?.haste ?? false) : false;
    state.battlefield.push(card);
    emit({ type: 'zoneChange', instanceId: card.instanceId, from: 'stack', to: 'battlefield' });
    // A planeswalker enters with its printed loyalty (CR 306.5b) — said AFTER the
    // zoneChange so a replay folds "entered, then at loyalty N" in order.
    applyEnteringLoyalty(card, emit);
    // A battle enters with its printed defense counters (CR 310.4) by the same
    // rule and through the same kind of shared helper, so no entry path can
    // disagree with another about the number a permanent arrives carrying.
    applyEnteringDefense(card, emit);
    // The event log is the replay/inspector source (DESIGN §2), and a consumer
    // folding it starts every entering permanent untapped — so arriving tapped has
    // to be SAID, not just stored. `playLand` already emits this; without the same
    // emission here a resolved "enters tapped" permanent replayed as untapped.
    if (card.tapped) emit({ type: 'tapped', instanceId: card.instanceId });
    return;
  }
  // Spell → graveyard, or → exile for a flashback cast (CR 702.34a: a spell
  // cast from the graveyard is exiled instead of being put anywhere else as it
  // leaves the stack), or → its owner's HAND when its buyback cost was paid
  // (CR 702.27a). Same move every time; only the destination differs, and it was
  // decided by `spellLeaveDestination` before this was called.
  // Asked BEFORE the move, because `resetInstanceForNewZone` reverts the active
  // face to the printed front (CR 712.8a) and the adventure half is exactly the
  // face that is about to disappear.
  const wasAdventure = card.def.adventure === true;
  card.zone = resolvesTo;
  state.players[card.owner][resolvesTo].push(card);
  resetInstanceForNewZone(card);
  emit({ type: 'zoneChange', instanceId: card.instanceId, from: 'stack', to: resolvesTo });
  // CR 715.3d: a resolved adventure exiles its card, and its owner may cast the
  // CREATURE half from exile later. The permission is recorded as a card grant
  // — the list that already prunes itself whenever its card changes zones — so
  // an exiled adventurer that is somehow moved out of exile loses it with no
  // extra bookkeeping, exactly as CR 400.7 requires.
  if (wasAdventure && resolvesTo === 'exile') {
    addCardGrant(
      state,
      {
        targetInstanceId: card.instanceId,
        sourceInstanceId: card.instanceId,
        zone: 'exile',
        duration: 'permanent',
        castFace: 'front',
      },
      emit,
    );
  }
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
      // Only the ENGINE can say whether a payment is affordable — it is the one
      // that knows what is still untapped — so a `payMana` request is enriched
      // here rather than trusted from the effect that raised it.
      const asked: ChoiceRequest =
        request.kind === 'payMana'
          ? { ...request, affordable: canAffordManaCost(state, request.chooser, request.cost) }
          : request.kind === 'payLife'
            ? { ...request, affordable: canAffordLifeCost(state, request.chooser, request.amount) }
            : request;
      const choice = normalizeChoiceRequest(asked, {
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
      // Insert AFTER the ref now running, so a follow-up whose shape depended on
      // an answer resolves in order as part of this same resolution (and may ask
      // questions of its own).
      frame.effects.splice(frame.next + 1, 0, ...refs);
      // ⚠️ `effectTargets` is a PARALLEL array (see `ResolutionFrame`): splicing
      // one without the other silently shifts every later effect's targets by
      // the number of refs inserted — a modal spell's second mode would then
      // resolve pointed at the first mode's victim. The inserted refs inherit
      // the frame-wide targets (`undefined`), which is what an enqueued
      // follow-up has always used.
      if (frame.effectTargets) {
        frame.effectTargets.splice(frame.next + 1, 0, ...refs.map(() => undefined));
      }
    },
    shuffleLibrary(player) {
      shuffleLibraryInState(state, player);
    },
  };
}


/**
 * The per-player zones this searches, in order, named once at module scope — the
 * array literal used to be rebuilt (with a fresh `find` closure per zone) on every
 * lookup.
 */
const ZONE_SEARCH_ORDER = ['graveyard', 'exile', 'hand', 'library', 'command'] as const;

/** The instance with this id in a zone array, or undefined. */
function instanceIn(zone: readonly CardInstance[], id: InstanceId): CardInstance | undefined {
  for (let i = 0; i < zone.length; i++) {
    const inst = zone[i] as CardInstance;
    if (inst.instanceId === id) return inst;
  }
  return undefined;
}

/** Find an instance in any zone (battlefield/hand/grave/exile/stack), else undefined. */
function findInstanceAnywhere(state: GameState, id: InstanceId): CardInstance | undefined {
  const bf = findOnBattlefield(state, id);
  if (bf) return bf;
  for (const pid of PLAYER_IDS) {
    const p = state.players[pid];
    for (const zone of ZONE_SEARCH_ORDER) {
      const found = instanceIn(p[zone], id);
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
  // global). With none supplied, default to the shared empty registry: registry-free
  // actions (playLand/passPriority/combat) are unaffected; only spell resolution
  // needs primitives, and a bare call signals "no cards registered".
  const effectRegistry = registry ?? NO_REGISTRY;

  if (state.gameOver) {
    baseEmit({ type: 'actionRejected', reason: 'the game is already over' });
    return { state, events };
  }

  // Dispatch inline rather than through a local `dispatch()` closure: that arrow
  // captured six locals and was allocated on every single action.
  const result = dispatchAction(state, prevState, action, config, effectRegistry, emit, events);
  // On a clean (non-rejected) action, put any triggered abilities that fired onto
  // the stack and hand the active player priority over them. Rejections return a
  // fresh clone of prevState, so `result.state !== state`; we only flush our draft.
  if (result.state === state && !wasRejected(result.events)) {
    // A suspended resolution keeps the floor: a trigger that fired mid-resolution
    // goes on the stack and waits its turn, but the chooser must still answer first.
    if (collector.flush() > 0 && !state.gameOver && !state.pendingChoice) {
      state.priorityPlayer = state.activePlayer;
      state.consecutivePasses = 0;
      // Targets are chosen as the ability goes on the stack, which is HERE —
      // before priority, and with no resolution in progress to park a question in.
      aimPendingTriggers(state, emit);
    }
    // A madness window opened by this action (a discard, anywhere — a cost, a
    // spell's effect, an opponent's Thoughtseize) hands the floor to the player
    // who may cast the exiled card. Nothing else may act until they do or
    // decline, which `dispatchAction` enforces; this is what makes the window a
    // window rather than a flag nobody is ever asked about.
    if (state.madnessWindow && !state.pendingChoice && !state.gameOver) {
      state.priorityPlayer = state.madnessWindow.controller;
      state.consecutivePasses = 0;
    }
  }
  return result;
}

/** Route one validated-so-far action to its applier. Extracted from
 * `applyActionToDraft` so the switch is a plain call rather than a closure
 * allocated on every action. */
function dispatchAction(
  state: GameState,
  prevState: GameState,
  action: GameAction,
  config: RulesConfig,
  effectRegistry: EffectRegistry,
  emit: (e: GameEvent) => void,
  events: GameEvent[],
): EngineResult {
  // A parked question freezes the game for everyone else: while it stands, the
  // only thing anybody may do is answer it. Without this a player could pass
  // priority (or attack) "around" a half-resolved spell.
  if (state.pendingChoice && action.kind !== 'answerChoice') {
    return rejectWith(prevState, 'a choice is awaiting an answer');
  }
  // An open MADNESS window freezes the game the same way, and for the same
  // reason: a card sits in exile waiting to be cast or declined, and letting
  // anybody act around it would leave it stranded there forever. Answering a
  // parked question is always allowed — the window can open in the middle of a
  // suspended resolution (a discard effect that asks), and that resolution must
  // still be able to finish.
  if (state.madnessWindow && action.kind !== 'answerChoice') {
    const window = state.madnessWindow;
    const isMadnessCast =
      action.kind === 'castSpell' &&
      action.fromZone === 'exile' &&
      action.instanceId === window.instanceId &&
      action.player === window.controller;
    const isDecline = action.kind === 'passPriority' && action.player === window.controller;
    // Mana abilities stay legal, because a cast needs paying for: the madness
    // cast happens while the window's controller holds priority, and CR 605.3a
    // lets a mana ability be activated whenever a player is casting a spell.
    // Without this the window is a trap — a pilot with untapped lands and an
    // empty pool could never fund the cast it is being offered.
    const isFunding = action.kind === 'tapForMana' && action.player === window.controller;
    if (!isMadnessCast && !isDecline && !isFunding) {
      return rejectWith(prevState, 'a madness window is awaiting its controller');
    }
  }
  switch (action.kind) {
    case 'answerChoice':
      return applyAnswerChoice(state, prevState, action, effectRegistry, emit, events);
    case 'passPriority': {
      if (action.player !== state.priorityPlayer) return rejectWith(prevState, 'you do not have priority');
      // Passing with a madness window open DECLINES it (CR 702.35a): the card
      // falls into the graveyard the discard would have put it in. It is a pass
      // in name only — no priority actually changes hands and no step advances,
      // because what the player declined to do was cast a spell, not act.
      if (state.madnessWindow) {
        declineMadness(state, emit);
        return { state, events };
      }
      onPassPriority(state, config, effectRegistry, emit);
      return { state, events };
    }
    case 'playLand':
      return applyPlayLand(state, prevState, action, config, emit, events);
    case 'tapForMana':
      return applyTapForMana(state, prevState, action, emit, events);
    case 'castSpell':
      return applyCastSpell(state, prevState, action, config, emit, events);
    case 'cycleCard':
      return applyCycleCard(state, prevState, action, emit, events);
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
}

/** Whether an action's events report a rejection. A loop, not `.some()`, which
 * allocated a predicate closure per action for a scan of two or three events. */
function wasRejected(events: readonly GameEvent[]): boolean {
  for (const event of events) {
    if (event.type === 'actionRejected') return true;
  }
  return false;
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
  let answer = cloneChoiceAnswer(action.answer);
  // A payment happens HERE, once, as the answer is accepted — not inside the
  // effect that asked. The effect is re-run from the top when it resumes (see
  // `ResolutionFrame`), so a payment made there would be made again for every
  // later question it asks. What the effect is then told is what actually
  // happened: an agreement the board could not honour is recorded as a decline,
  // so the effect can never act on a payment that did not occur.
  if (choice.kind === 'payMana' && answer.kind === 'payMana' && answer.pay) {
    if (!payManaCostFromBoard(state, choice.chooser, choice.cost, emit)) {
      answer = { kind: 'payMana', pay: false };
    }
  }
  // Life is charged the same way, for the same reason — and re-checked against
  // the live total, so an answer racing a stale affordability can never drive a
  // life total below zero through a "payment" (CR 118.4).
  if (choice.kind === 'payLife' && answer.kind === 'payLife' && answer.pay) {
    if (!payLifeCost(state, choice.chooser, choice.amount, emit)) {
      answer = { kind: 'payLife', pay: false };
    }
  }
  emit({
    type: 'choiceAnswered',
    choiceId: choice.id,
    chooser: choice.chooser,
    choiceKind: choice.kind,
    answer,
    summary: describeChoiceAnswer(answer),
  });
  state.pendingChoice = null;

  // A CAST-TIME answer belongs to a spell still being cast — the stack object
  // carrying the `awaitingCastChoice` marker this question was asked for. The
  // extra cost is charged HERE, once, exactly like the payment kinds above
  // (indeed the kicker IS a payMana, already charged by that block); the answer
  // is recorded on the stack object, and the next cast question (a kicker after
  // an X) asks immediately. When the cast is fully announced, any triggers that
  // fired off the cast are aimed and the caster keeps priority — exactly where
  // they would be had the spell needed no question.
  const casting = spellOnStack(state, choice.sourceInstanceId);
  if (casting?.awaitingCastChoice !== undefined) {
    // The modes announced for a modal spell. Nothing is charged (modes are free
    // — the choice IS the card), the picks are written in printed order, and the
    // next cast question (aiming the first targeting mode) asks immediately.
    if (casting.awaitingCastChoice === 'modes' && choice.kind === 'chooseModes' && answer.kind === 'chooseModes') {
      recordModePicks(state, casting.instanceId, answer.modeIds, emit);
      return finishCastChoice(state, casting.instanceId, choice.chooser, emit, events);
    }
    // One announced mode's target. `nextUnaimedPick` names the pick being aimed
    // — the same rule the question was raised by, so an answer cannot land on
    // the wrong copy of a repeated mode.
    if (
      casting.awaitingCastChoice === 'modeTarget' &&
      choice.kind === 'selectTargets' &&
      answer.kind === 'selectTargets'
    ) {
      const index = nextUnaimedPick(casting.card.def, casting.modePicks ?? []);
      aimModePick(state, casting.instanceId, index, answer.targets, emit);
      return finishCastChoice(state, casting.instanceId, choice.chooser, emit, events);
    }
    if (casting.awaitingCastChoice === 'x' && choice.kind === 'chooseNumber' && answer.kind === 'chooseNumber') {
      const perSymbol = xCountForCast(casting);
      let value = answer.value;
      if (value > 0 && perSymbol > 0 && !payManaCostFromBoard(state, choice.chooser, { generic: value * perSymbol }, emit)) {
        // The board could not honour the agreed X (only reachable from a
        // hand-built state — the offered range was computed from this board).
        // Recorded as what actually happened: nothing was paid, X is 0.
        value = 0;
      }
      patchSpellOnStack(state, casting.instanceId, { xValue: value, awaitingCastChoice: undefined });
      return finishCastChoice(state, casting.instanceId, choice.chooser, emit, events);
    }
    if (casting.awaitingCastChoice === 'buyback' && choice.kind === 'payMana' && answer.kind === 'payMana') {
      // The mana was already spent by the shared payMana block above; a payment
      // the board could not honour arrives here as a decline, and the spell
      // simply resolves to the graveyard like any other.
      patchSpellOnStack(state, casting.instanceId, { boughtBack: answer.pay, awaitingCastChoice: undefined });
      return finishCastChoice(state, casting.instanceId, choice.chooser, emit, events);
    }
    if (casting.awaitingCastChoice === 'kicker' && choice.kind === 'payMana' && answer.kind === 'payMana') {
      // The mana (if paid) was already spent by the shared payMana block above,
      // and a payment the board could not honour arrives here as a decline.
      patchSpellOnStack(state, casting.instanceId, { kicked: answer.pay, awaitingCastChoice: undefined });
      return finishCastChoice(state, casting.instanceId, choice.chooser, emit, events);
    }
    if (
      casting.awaitingCastChoice === 'additionalCost' &&
      choice.kind === 'selectCards' &&
      answer.kind === 'selectCards'
    ) {
      const extra = casting.card.def.additionalCost;
      if (extra) payAdditionalCost(state, extra, choice.chooser, answer.instanceIds, emit);
      patchSpellOnStack(state, casting.instanceId, {
        additionalCostPaid: true,
        awaitingCastChoice: undefined,
      });
      return finishCastChoice(state, casting.instanceId, choice.chooser, emit, events);
    }
    if (
      casting.awaitingCastChoice === 'multikicker' &&
      choice.kind === 'chooseNumber' &&
      answer.kind === 'chooseNumber'
    ) {
      const perKick = casting.card.def.multikicker;
      let count = answer.value;
      if (count > 0 && perKick) {
        // Charged ONCE, here, exactly like X — and as one payment of the
        // repeated cost rather than N payments, so a planner that would have
        // stranded a hybrid symbol across separate charges cannot.
        if (!payManaCostFromBoard(state, choice.chooser, repeatCost(perKick, count), emit)) {
          // Only reachable from a hand-built state: the offered range was
          // computed from this board. Recorded as what actually happened.
          count = 0;
        }
      }
      patchSpellOnStack(state, casting.instanceId, {
        kickCount: count,
        // "If this spell was kicked" reads TRUE for any positive number of
        // multikicks — one rider, both kicker shapes, so a card printing both
        // (or a rider written against the single kicker) cannot disagree.
        ...(count > 0 ? { kicked: true } : {}),
        awaitingCastChoice: undefined,
      });
      return finishCastChoice(state, casting.instanceId, choice.chooser, emit, events);
    }
  }

  // A NAMING answer with no resolution behind it is a land naming a value as it
  // entered (`raiseLandEntryChoice` parked it). The value is written onto the
  // permanent the choice named — `appliesToInstanceId`, not "whatever asked", so
  // a source that ever names on another permanent's behalf cannot silently
  // record it on itself — and then the SAME step function is called again, which
  // is what lets one land ask a naming AND a tapped question (Multiversal
  // Passage, Temple of the Dragon Queen) instead of dropping the second.
  //
  // A naming asked mid-RESOLUTION (the `chooseAsEnters` primitive, for a
  // permanent spell) is deliberately not handled here: it flows through the
  // ordinary frame path below, and the primitive writes the value itself against
  // the instance that is entering.
  if (choice.context === 'asEnters' && answer.kind === 'chooseValue' && !state.resolution) {
    const entering = findOnBattlefield(state, choice.appliesToInstanceId ?? choice.sourceInstanceId);
    const naming = entering?.def.asEntersChoice;
    if (entering && naming) {
      recordChosenAsEntered(entering, naming, answer.value, emit);
      raiseLandEntryChoice(state, entering, choice.chooser, emit);
    }
    checkStateBasedActions(state, emit);
    // Aim any waiting trigger only once the land has finished asking. Two
    // reasons, and they agree: the entry questions are REPLACEMENT effects that
    // all happen as the permanent enters, before a landfall trigger is put on
    // the stack (CR 614.1c) — and `aimPendingTriggers` parks a question of its
    // own, which would overwrite the land's second question and lose it.
    if (!state.pendingChoice) aimPendingTriggers(state, emit);
    if (!state.pendingChoice && !state.gameOver) {
      // The land play never surrendered priority, so its player keeps the floor.
      state.priorityPlayer = choice.chooser;
      state.consecutivePasses = 0;
    }
    return { state, events };
  }

  // A LEGEND-RULE answer belongs to the state-based actions, not to a resolution
  // (CR 704.5j — the game performs the rule; the player only picks the survivor).
  // Routed by the choice's own `context` marker rather than by "there is no frame
  // behind it", because that description also fits the shockland question below
  // and the two must never be confused. The rule's own re-check runs the SBAs
  // again, so a cascade — a second duplicated name, an Aura orphaned by the copy
  // that left — settles before anyone gets priority back.
  if (choice.context === 'legendRule' && answer.kind === 'selectCards') {
    const kept = answer.instanceIds[0];
    if (kept !== undefined) applyLegendRuleChoice(state, kept, emit);
    else checkStateBasedActions(state, emit);
    aimPendingTriggers(state, emit);
    if (!state.pendingChoice && !state.gameOver) {
      state.priorityPlayer = state.activePlayer;
      state.consecutivePasses = 0;
    }
    return { state, events };
  }

  // A TARGETING answer belongs to the stack, not to a resolution: it names what a
  // triggered ability points at, chosen as the ability went on the stack. Nothing
  // is resumed — the aim is recorded, and any trigger still waiting behind it asks
  // next (see `aimPendingTriggers`).
  if (choice.kind === 'selectTargets' && answer.kind === 'selectTargets') {
    recordTriggerTargets(state, answer.targets, emit);
    aimPendingTriggers(state, emit);
    if (!state.pendingChoice && !state.gameOver) {
      state.priorityPlayer = state.activePlayer;
      state.consecutivePasses = 0;
    }
    return { state, events };
  }

  // A LIFE payment with no resolution behind it is a shockland entering off a
  // land play (`applyPlayLand` parked it; the land is the choice's source). The
  // life was already charged above; what is left is the printed "if you don't":
  // a decline turns the just-entered land tapped. Also the moment to settle any
  // state-based consequence of the payment (paying to exactly zero is legal and
  // lethal) and to aim any landfall trigger that fired while the question stood.
  if (choice.kind === 'payLife' && answer.kind === 'payLife' && !state.resolution) {
    if (!answer.pay) {
      const land = findOnBattlefield(state, choice.sourceInstanceId);
      if (land && !land.tapped) {
        land.tapped = true;
        emit({ type: 'tapped', instanceId: land.instanceId });
      }
    }
    checkStateBasedActions(state, emit);
    aimPendingTriggers(state, emit);
    if (!state.pendingChoice && !state.gameOver) {
      // The land play never surrendered priority, so its player keeps the floor —
      // exactly where they would be had the land needed no question.
      state.priorityPlayer = choice.chooser;
      state.consecutivePasses = 0;
    }
    return { state, events };
  }

  // A CONFIRM with no resolution behind it is a reveal-land entering off a land
  // play (`applyPlayLand` parked it; the land is the choice's source). The
  // printed "if you don't" is all that is left: a decline taps the fresh entry.
  if (choice.kind === 'confirm' && answer.kind === 'confirm' && !state.resolution) {
    if (!answer.yes) {
      const land = findOnBattlefield(state, choice.sourceInstanceId);
      if (land && !land.tapped) {
        land.tapped = true;
        emit({ type: 'tapped', instanceId: land.instanceId });
      }
    }
    checkStateBasedActions(state, emit);
    aimPendingTriggers(state, emit);
    if (!state.pendingChoice && !state.gameOver) {
      // The land play never surrendered priority, so its player keeps the floor.
      state.priorityPlayer = choice.chooser;
      state.consecutivePasses = 0;
    }
    return { state, events };
  }

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
  // Nearly every land play comes from the hand; the one that does not is an
  // ADVENTURER card whose primary half is a land, waiting in exile with the
  // permission its own adventure left behind ("You may play the land later from
  // exile"). Validated the same way the cast path validates a cast from exile,
  // by the same accessor, so neither can be tricked into playing a card that
  // was merely exiled.
  const fromZone = action.fromZone ?? 'hand';
  if (fromZone !== 'hand' && fromZone !== 'exile') {
    return rejectWith(prevState, 'a land can only be played from your hand or from exile');
  }
  const card =
    fromZone === 'exile'
      ? instanceIn(player.exile, action.instanceId)
      : instanceIn(player.hand, action.instanceId);
  if (!card) {
    return rejectWith(prevState, fromZone === 'exile' ? 'that card is not in exile' : 'that card is not in your hand');
  }
  const permission = fromZone === 'exile' ? castPermissionFor(state, card) : undefined;
  if (fromZone === 'exile') {
    if (permission === undefined) return rejectWith(prevState, 'that card has no permission to be played from exile');
    if ((action.face ?? 'front') !== permission.face) {
      return rejectWith(prevState, 'that face of this card may not be played from exile');
    }
  }
  // Same CR 712.8b guard as casting: a transforming DFC's back face is never
  // playable from hand.
  if (card.def.isBackFace === true) {
    return rejectWith(prevState, 'the back face of a double-faced card cannot be played');
  }
  // WHICH FACE — a modal DFC's land half is played by naming `face: 'back'`, and
  // it is a land play like any other (it counts against the turn's land drop,
  // checked above). `playableFaceOf` refuses a back face that is not castable,
  // so a transforming DFC cannot be played as its back.
  const playDef = playableFaceOf(card.def, action.face);
  if (!playDef) return rejectWith(prevState, 'that card has no playable back face');
  if (!isLand(playDef)) return rejectWith(prevState, 'that card is not a land');
  // The face swap, identical to the cast path: `def` IS the active face, and
  // `printedDef` is the way back to the front should the land ever leave.
  if (playDef !== card.def) {
    card.printedDef = card.def;
    card.def = playDef;
  }

  moveToZone(state, card, 'battlefield', emit, action.player);
  card.controller = action.player;
  // `moveToZone` has already put the land on the battlefield, so `self` excludes
  // it from its own "other lands you control" count.
  card.tapped = entersTapped(card.def, {
    controller: action.player,
    battlefield: state.battlefield,
    self: card,
  });
  card.summoningSick = false; // lands aren't affected by summoning sickness

  raiseLandEntryChoice(state, card, action.player, emit);
  player.landsPlayedThisTurn += 1;
  emit({ type: 'landPlayed', player: action.player, instanceId: card.instanceId });
  // Playing a land is a special action: the player retains priority.
  state.consecutivePasses = 0;
  return { state, events };
}

/**
 * Ask the NEXT question a freshly-played land still owes, or settle its tapped
 * state when it owes none.
 *
 * Three printed questions can land on the same permanent as it enters, and only
 * ONE choice can be parked at a time — Multiversal Passage names a basic land
 * type and *then* offers to pay 2 life; Temple of the Dragon Queen offers a
 * reveal and names a colour. So this is written as a step function that asks the
 * first unanswered question and is CALLED AGAIN from the answer handler, rather
 * than as three independent branches that would silently drop the second one.
 *
 * Order is the printed order, naming first: the naming is what the land's other
 * abilities read, and a payment question answered first would be the only one a
 * player ever saw on a card printing both.
 *
 * The land has already entered with the unpaid/unrevealed default (tapped, from
 * `entersTapped`), and the `tapped` EVENT is deferred until every question is
 * settled — so a replay never shows a land flickering tapped→untapped, and
 * nothing can observe the intermediate state because answering is the only legal
 * action while a question stands.
 */
function raiseLandEntryChoice(
  state: GameState,
  card: CardInstance,
  player: PlayerId,
  emit: (e: GameEvent) => void,
): void {
  const park = (request: ChoiceRequest, context?: PendingChoice['context']): void => {
    const normalized = normalizeChoiceRequest(request, {
      id: state.nextInstanceId++,
      sourceInstanceId: card.instanceId,
      sourceName: card.def.name,
    });
    if (!normalized) return;
    // The context marker is what routes the answer, exactly as the legend rule's
    // does: "a choice with no resolution behind it" also describes the shockland
    // question, and the two must never be confused.
    const choice: PendingChoice =
      context === undefined ? normalized : { ...normalized, context, appliesToInstanceId: card.instanceId };
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
  };

  // 1. THE NAMING — "As ~ enters, choose a color / a basic land type"
  //    (CR 614.1c). Asked only while nothing has been named yet, which is what
  //    makes this function safe to call again after each answer.
  const naming = card.def.asEntersChoice;
  if (naming !== undefined && card.chosenAsEntered === undefined) {
    const options = asEntersOptions(state, naming, player);
    if (options.length > 0) {
      park({
        kind: 'chooseValue',
        chooser: player,
        prompt: asEntersPrompt(card.def, naming),
        subject: naming.subject,
        options,
        // Naming costs nothing and unlocks the card's own abilities; the real
        // decision is WHICH value, which a pilot makes from the board rather
        // than from a valence.
        valence: 'gain',
      }, 'asEnters');
      if (state.pendingChoice) return;
    } else {
      // Nothing on offer (an empty menu) settles to "nothing named" WITHOUT
      // stopping the game — the inert default, reached honestly and announced
      // like any other naming. Recorded rather than left absent so this step
      // function, which is called again after every answer, cannot come back
      // round and ask again.
      recordChosenAsEntered(card, naming, NOTHING_CHOSEN, emit);
    }
  }

  // 2. A REVEAL-LAND: "you may reveal an Island or Swamp card from your hand. If
  //    you don't, this land enters tapped." A controller holding nothing to show
  //    is not asked — the printed default is then the only outcome, and
  //    stopping the game for it would wedge the turn.
  const revealCondition = card.def.entersTappedUnlessRevealed;
  if (revealCondition !== undefined && canRevealForUntapped(revealCondition, state.players[player].hand)) {
    card.tapped = false;
    park({
      kind: 'confirm',
      chooser: player,
      prompt: `Reveal ${describeRevealTypes(revealCondition.anyOfSubtypes)} from your hand, or ${card.def.name} enters tapped`,
      // Showing a card costs nothing and unlocks an untapped land, so a pilot
      // with nothing better to go on should take it.
      valence: 'gain',
    });
    return;
  }

  // 3. A SHOCKLAND: "you may pay N life. If you don't, it enters tapped." A
  //    player who cannot pay is not asked — the default already IS the only
  //    outcome, so the game does not stop.
  const shockCost = card.def.entersTappedUnlessLifePaid;
  if (shockCost !== undefined && canAffordLifeCost(state, player, shockCost)) {
    card.tapped = false;
    park({
      kind: 'payLife',
      chooser: player,
      prompt: `Pay ${shockCost} life, or ${card.def.name} enters tapped`,
      amount: shockCost,
      affordable: true,
      valence: 'neutral',
    });
    return;
  }

  // 4. Nothing left to ask — announce the entry state.
  if (card.tapped) emit({ type: 'tapped', instanceId: card.instanceId });
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

/**
 * Aim every triggered ability that has just gone on the stack and does not know
 * yet what it points at (CR 603.3d — **targets are chosen as the ability is put
 * on the stack**, which is the moment this whole subsystem exists for: there is
 * no resolution frame to park a question in, because nothing is resolving).
 *
 * Three outcomes per waiting trigger, in the order that keeps a game moving:
 *  - **no legal target** — the ability is removed from the stack and never
 *    resolves (CR 603.3d again). This is a rules requirement, not a shortcut: an
 *    ability that stayed would resolve pointing at nothing and read as a blank.
 *  - **exactly one legal target** — taken. One legal aim is not a decision; it is
 *    the only lawful one, and `isTrivialChoice` settles it without stopping the
 *    game. ⚠️ TWO or more is a REAL decision and is always asked — auto-picking
 *    there is precisely the shortcut that would make a card report as playable
 *    and then fizzle the moment the board grew a second creature.
 *  - **several** — the controller is asked, and this returns with the question
 *    parked. The remaining waiters are aimed after the answer arrives.
 *
 * Stack order is bottom-up: triggers were pushed in APNAP order, so aiming them
 * in that order is the order they were put on the stack in.
 */
function aimPendingTriggers(state: GameState, emit: (e: GameEvent) => void): void {
  // Bounded by the stack, and each pass either aims a trigger, removes one, or
  // parks a question — so it cannot spin.
  for (;;) {
    const index = state.stack.findIndex((object) => object.kind === 'trigger' && object.awaitingTargets !== undefined);
    if (index < 0) return;
    const trigger = state.stack[index] as TriggeredStackObject;
    const restriction = trigger.awaitingTargets as TargetRestriction;
    // The SOURCE card's definition rides along so a protected permanent is never
    // offered to an ability whose source has a protected quality (a red
    // creature's ETB damage cannot be aimed at protection-from-red). The source
    // may already have left the battlefield; the ability still resolves, so the
    // definition is recovered from wherever the card now is.
    const triggerSourceDef = (findOnBattlefield(state, trigger.sourceInstanceId) ??
      findInstanceAnywhere(state, trigger.sourceInstanceId))?.def;
    const candidates = legalTargetsFor(state, restriction, trigger.controller, triggerSourceDef);

    if (candidates.length === 0) {
      state.stack.splice(index, 1);
      emit({
        type: 'triggerRemovedFromStack',
        sourceInstanceId: trigger.sourceInstanceId,
        controller: trigger.controller,
        label: trigger.label,
        reason: `no legal target (${describeRestriction(restriction)})`,
      });
      continue;
    }

    const choice = normalizeChoiceRequest(
      {
        kind: 'selectTargets',
        chooser: trigger.controller,
        prompt: `Choose ${describeRestriction(restriction)} for ${trigger.label}`,
        candidates: candidates.map((ref) => targetOptionFor(state, ref)),
        restriction,
        min: SINGLE_TARGET,
        max: SINGLE_TARGET,
      },
      {
        id: state.nextInstanceId++,
        // The SOURCE PERMANENT, not the stack object: it is what a UI draws and
        // what the log names. The ability being aimed is found from the stack by
        // its `awaitingTargets` marker, which is unique while a question is open.
        sourceInstanceId: trigger.sourceInstanceId,
        sourceName: nameOfInstance(state, trigger.sourceInstanceId) ?? trigger.label,
      },
    );
    if (!choice) return; // unrepresentable — leave the trigger unaimed rather than crash

    if (isTrivialChoice(choice) || state.gameOver || state.players[choice.chooser].hasLost) {
      const answer = defaultAnswerFor(choice);
      emit({
        type: 'choiceAutoAnswered',
        choiceId: choice.id,
        chooser: choice.chooser,
        choiceKind: choice.kind,
        answer,
        reason: isTrivialChoice(choice) ? 'only one legal target' : 'the chooser can no longer act',
      });
      recordTriggerTargets(state, answer.kind === 'selectTargets' ? answer.targets : [], emit);
      continue;
    }

    state.pendingChoice = choice;
    state.priorityPlayer = choice.chooser;
    state.consecutivePasses = 0;
    emit({
      type: 'choiceAsked',
      choiceId: choice.id,
      chooser: choice.chooser,
      choiceKind: choice.kind,
      prompt: choice.prompt,
      sourceInstanceId: choice.sourceInstanceId,
      optionCount: choiceOptionCount(choice),
    });
    return;
  }
}

/** A printed targeted trigger names exactly one target (see `TriggeredAbility.targets`). */
const SINGLE_TARGET = 1;

/**
 * Write chosen targets onto the trigger that was waiting for them, clearing the
 * marker so it is no longer waiting. The waiting trigger is unique — only one
 * question is ever open — so the answer cannot be applied to the wrong ability.
 */
function recordTriggerTargets(
  state: GameState,
  targets: ReadonlyArray<InstanceId | PlayerId>,
  emit: (e: GameEvent) => void,
): void {
  const index = state.stack.findIndex((object) => object.kind === 'trigger' && object.awaitingTargets !== undefined);
  if (index < 0) return;
  const trigger = state.stack[index] as TriggeredStackObject;
  // Replaced rather than mutated: a stack object is read-only data to everyone
  // else (the masked view, the replay, a look-ahead clone), and a fresh object
  // keeps that true without a mutable escape hatch on the type.
  state.stack[index] = { ...trigger, targets: [...targets], awaitingTargets: undefined };
  emit({
    type: 'triggerTargetsChosen',
    sourceInstanceId: trigger.sourceInstanceId,
    controller: trigger.controller,
    label: trigger.label,
    targets: [...targets],
  });
  // A triggered ability aimed at an opponent's warded permanent triggers ward
  // exactly as a spell does — "the target of a spell OR ABILITY".
  pushWardTriggers(state, trigger.controller, targets, trigger.instanceId, emit);
}

/**
 * WARD (CR 702.21) — for every warded permanent an OPPONENT's spell or ability
 * has just targeted, put the "counter it unless its controller pays {N}" trigger
 * on the stack, above the targeting object.
 *
 * The trigger is an ordinary trigger stack object whose one effect is core's
 * reserved {@link WARD_COUNTER_PRIMITIVE} (implemented by `cards`, which asks
 * the payment through the same `payMana` machinery Mana Leak uses and counters
 * on a decline). Its TARGET is the stack object that trespassed, so the
 * resolution knows exactly what to counter even if the stack has moved on — and
 * a registry without the primitive degrades to `effectUnsupported`, never a
 * crash.
 *
 * Own-controller targeting never triggers (ward names an opponent), and the
 * ward cost is read through the continuous layer so a granted ward charges too.
 */
function pushWardTriggers(
  state: GameState,
  actingPlayer: PlayerId,
  targets: ReadonlyArray<InstanceId | PlayerId>,
  targetedStackInstanceId: InstanceId,
  emit: (e: GameEvent) => void,
): void {
  for (const target of targets) {
    if (isPlayerTarget(target)) continue;
    const permanent = findOnBattlefield(state, target);
    if (!permanent || permanent.controller === actingPlayer) continue;
    const wardCost = effectiveWardOf(state, permanent);
    if (wardCost <= 0) continue;
    const label = `Ward {${wardCost}}`;
    state.stack.push({
      kind: 'trigger',
      instanceId: state.nextInstanceId++,
      sourceInstanceId: permanent.instanceId,
      controller: permanent.controller,
      effects: [
        { primitive: WARD_COUNTER_PRIMITIVE, params: { [WARD_COST_PARAM]: { generic: wardCost } } },
      ],
      targets: [targetedStackInstanceId],
      label,
    });
    emit({
      type: 'triggerPutOnStack',
      sourceInstanceId: permanent.instanceId,
      controller: permanent.controller,
      label,
    });
  }
}

/** Describe a target reference (a permanent or a seat) for a choice's option list. */
function targetOptionFor(state: GameState, ref: InstanceId | PlayerId): TargetOption {
  if (isPlayerTarget(ref)) return { ref, name: `Player ${ref}`, controller: ref };
  const permanent = findOnBattlefield(state, ref);
  if (permanent) return permanentTargetOption(permanent);
  // A target need not be a PERMANENT: a graveyard card is a legal target for
  // `'instantOrSorceryInYourGraveyard'`, and describing it as `#7` would leave
  // a UI rendering an unnamed button and the AI's own target scorer with
  // nothing to read. Found wherever it actually is.
  const card = findInstanceAnywhere(state, ref);
  return card
    ? { ref, name: card.def.name, controller: card.controller }
    : // Only reachable if the board changed between listing and describing, which
      // it cannot inside one action; described rather than dropped so a candidate
      // list can never come out shorter than the legality check that built it.
      { ref, name: `#${ref}`, controller: state.activePlayer };
}

/** The name of an instance anywhere in the game, for a prompt. */
function nameOfInstance(state: GameState, instanceId: InstanceId): string | undefined {
  return findOnBattlefield(state, instanceId)?.def.name ?? findInstanceAnywhere(state, instanceId)?.def.name;
}

/**
 * Append every `tapForMana` activation `player` could make right now.
 *
 * ONE definition of "which sources can this player tap", used by the two places
 * that ask: `generateLegalActions` (what a pilot may do with priority) and the
 * mid-resolution payment path (what a player could produce to pay "unless its
 * controller pays {3}"). A second copy would be free to disagree with the engine
 * about summoning sickness or modal sources — and a payment path that offers a tap
 * the engine would refuse is a payment that fails for no visible reason.
 *
 * A MODAL source contributes one action per mode, so choosing the colour is part
 * of the action an AI scores rather than a hidden engine default. Summoning-sick
 * creature sources are excluded (rule 302.6 — see `canActivateManaAbility`).
 *
 * Pushes into the caller's array rather than returning a new one: the caller in
 * the hot path is building an action list anyway, so this adds no allocation and
 * no closure to it.
 */
function pushManaTapActions(state: GameState, player: PlayerId, out: GameAction[]): void {
  // Built only when a sick creature source actually raises the granted-haste
  // question — the ordinary board never pays for it.
  let manaCont: ReturnType<typeof indexContinuous> | undefined;
  const battlefield = state.battlefield;
  for (let b = 0; b < battlefield.length; b++) {
    const perm = battlefield[b] as CardInstance;
    if (perm.controller !== player || perm.tapped) continue;
    const modes = manaModesOf(perm.def);
    if (modes.length === 0) continue;
    if (perm.summoningSick && isCreature(perm.def)) {
      manaCont ??= indexContinuous(state);
      if (!canActivateManaAbility(perm, manaCont)) continue;
    }
    // The rich mana model (costs / riders / restrictions / derived colours) is
    // read ONCE per source. The `manaAbilities` test is inlined rather than left
    // to `manaExtrasOf` so the ordinary board — where no source has one — pays a
    // single property read on an immutable definition and never a call, on the
    // engine's hottest loop.
    const extras = perm.def.manaAbilities === undefined ? undefined : manaExtrasOf(perm.def);
    for (let mode = 0; mode < modes.length; mode++) {
      if (extras !== undefined && manaModeBlockedReason(state, perm, extras[mode]) !== undefined) {
        continue;
      }
      out.push({ kind: 'tapForMana', player, instanceId: perm.instanceId, mode });
    }
  }
}

/**
 * Why `perm`'s mana mode cannot be activated right now, or `undefined` when it
 * can. ONE answer, asked by the offer path and by the apply path, so a mode the
 * menu shows is a mode the engine will accept — an unmet "Activate only if …" has
 * to make the source *invisible* to the payment planner, not merely refuse after
 * the planner has already counted on it.
 *
 * The mana half of an additional cost is checked against the FLOATING pool, which
 * is exactly the gate `unpayableActivationReason` puts on an activated ability's
 * mana cost. A filter land is therefore offered once its input mana is actually
 * floating; the funding source is tapped first, which is how the activation
 * happens in paper too (CR 605.3a lets you activate mana abilities while paying,
 * and here that is simply the previous action).
 */
function manaModeBlockedReason(
  state: GameState,
  perm: CardInstance,
  extra: ManaModeExtra | undefined,
): string | undefined {
  if (!extra) return undefined;
  const { ability, derivedColor } = extra;
  const player = state.players[perm.controller];
  if (
    ability.restriction &&
    !manaActivationConditionMet(ability.restriction, {
      controller: perm.controller,
      battlefield: state.battlefield,
    })
  ) {
    return `${perm.def.name}'s ability cannot be activated right now`;
  }
  if (derivedColor !== undefined) {
    // "any color" never reaches {C}, whatever the board offers (see
    // `ManaAbility.derivedIncludesColorless`).
    if (derivedColor === 'C' && ability.derivedIncludesColorless !== true) {
      return `${perm.def.name} cannot make colorless mana`;
    }
    if (!derivedManaColors(state, perm, ability).has(derivedColor)) {
      return `no land makes {${derivedColor}} for ${perm.def.name} to copy`;
    }
  }
  // A CHOSEN-colour mode is available only for the colour THIS permanent named as
  // it entered. A permanent that named nothing has no available mode at all, so
  // it taps for nothing — the inert default, refused here rather than silently
  // downgraded to "any colour".
  const modeChosenColor = extra.chosenColor;
  if (modeChosenColor !== undefined && chosenColorOf(perm) !== modeChosenColor) {
    return chosenColorOf(perm) === undefined
      ? `${perm.def.name} has not named a color`
      : `${perm.def.name} names a different color`;
  }
  const cost = ability.cost;
  if (cost) {
    // CR 118.4: life pays down to zero and no further.
    if (cost.life !== undefined && cost.life > 0 && player.life < cost.life) {
      return 'you do not have enough life to pay that cost';
    }
    if (cost.mana && !canPay(player.manaPool, cost.mana)) {
      return `insufficient mana to activate ${perm.def.name}`;
    }
  }
  return undefined;
}

/**
 * The colours a board-derived mana ability may currently produce.
 *
 * Recomputed per query and never cached on the definition: the answer is a
 * function of the battlefield, so a cached one would be a different card's answer
 * the moment a land entered. Only sources that actually print a derived ability
 * ever reach here, and there are a handful of those in the whole format, so the
 * per-query set costs nothing a real board notices.
 *
 * The source permanent is excluded from its own derivation, and
 * `fixedManaColorsOf` excludes every OTHER derived source too — so a pair of
 * Reflecting Pools reads each other as producing nothing rather than looping.
 */
function derivedManaColors(
  state: GameState,
  source: CardInstance,
  ability: ManaAbility,
): ReadonlySet<ManaColor> {
  const wantOpponents = ability.derivedColors === 'landsOpponentsControl';
  const colors = new Set<ManaColor>();
  for (const perm of state.battlefield) {
    if (perm === source) continue;
    const mine = perm.controller === source.controller;
    if (wantOpponents ? mine : !mine) continue;
    if (!isLand(perm.def)) continue;
    // The chosen colour is read off the INSTANCE, so a Temple of the Dragon Queen
    // that named red contributes exactly red to a Reflecting Pool — not all five,
    // and not nothing.
    for (const color of fixedManaColorsOf(perm.def, chosenColorOf(perm))) colors.add(color);
  }
  return colors;
}

/**
 * Whether `player` could produce `cost` right now: what is already floating plus
 * what they could still tap. Answers {@link PayManaChoice.affordable}.
 *
 * Delegates to `planManaPayment`, which is the same planner the pilots and the
 * client fund a spell with — so "can you pay this?" cannot answer differently
 * from "here is how you would pay it".
 *
 * Exported because the AI asks the same question from the other side: a soft
 * counter ("unless its controller pays {3}") is worth far less against an
 * opponent holding three untapped lands, and a pilot working that out from its own
 * copy of the rules would be free to disagree with the engine that will actually
 * offer the payment.
 */
export function canAffordManaCost(state: GameState, player: PlayerId, cost: ManaCost): boolean {
  return planPaymentFor(state, player, cost) !== undefined;
}

/**
 * Whether `player` may pay `amount` life: CR 118.4 — life is a resource down to
 * exactly zero. Paying to zero is legal (and promptly lethal via the SBAs),
 * which is the player's call to make, not the engine's to forbid.
 */
function canAffordLifeCost(state: GameState, player: PlayerId, amount: number): boolean {
  return amount > 0 && state.players[player].life >= amount;
}

/**
 * Deduct a life payment, saying so in the log. Returns false — having changed
 * nothing — when the chooser no longer has the life, which mirrors
 * `payManaCostFromBoard`: the caller records what actually happened, and an
 * agreement the total cannot honour is recorded as a decline.
 */
/**
 * The printed land types of a reveal-land, as the prompt shows them ("an Island
 * or Swamp card"). Built from the condition rather than stored as prose so the
 * question a player is asked can never disagree with the condition being tested.
 */
function describeRevealTypes(subtypes: readonly string[]): string {
  const named = subtypes.map((subtype) => subtype.charAt(0).toUpperCase() + subtype.slice(1));
  return `${named.join(' or ')} card`;
}

function payLifeCost(state: GameState, player: PlayerId, amount: number, emit: (e: GameEvent) => void): boolean {
  if (!canAffordLifeCost(state, player, amount)) return false;
  const owner = state.players[player];
  owner.life -= amount;
  emit({ type: 'lifeChanged', player, delta: -amount, to: owner.life });
  return true;
}

/** The taps that would fund `cost` for `player`, or undefined if it cannot be paid. */
function planPaymentFor(state: GameState, player: PlayerId, cost: ManaCost): ManaTapPlan[] | undefined {
  const taps: GameAction[] = [];
  pushManaTapActions(state, player, taps);
  return planManaPayment(state, player, cost, taps);
}

/**
 * Spend `cost` from `player`'s mana, tapping sources as needed. Returns false —
 * having changed NOTHING — when the cost cannot be produced.
 *
 * This is how a payment agreed to mid-resolution actually happens ("unless its
 * controller pays {3}"). Rule 605.3 lets a player activate mana abilities to pay
 * a cost during resolution, which is exactly what the taps here are; the engine
 * picks the sources with the shared planner (least-flexible source first) instead
 * of asking a second question about *which* land, and the whole plan is computed
 * before anything is tapped so a failure cannot leave a half-tapped board.
 */
function payManaCostFromBoard(
  state: GameState,
  player: PlayerId,
  cost: ManaCost,
  emit: (e: GameEvent) => void,
): boolean {
  const plan = planPaymentFor(state, player, cost);
  if (!plan) return false;
  for (const tap of plan) {
    const source = findOnBattlefield(state, tap.instanceId);
    // The plan was built from this same board a moment ago, so a missing or
    // already-tapped source is not reachable — but a payment that silently taps
    // nothing and then "pays" would be worse than a refusal, so it is checked.
    if (!source || source.tapped) return false;
    tapPermanentForMana(state, source, player, tap.production, emit);
  }
  const result = payCost(state.players[player].manaPool, cost);
  if (!result.ok) return false;
  state.players[player].manaPool = result.pool;
  emit({ type: 'manaCostPaid', player, cost: { ...cost } });
  return true;
}

/** Tap a source and add its production to its controller's pool, with events. */
function tapPermanentForMana(
  state: GameState,
  source: CardInstance,
  player: PlayerId,
  production: ManaProduction,
  emit: (e: GameEvent) => void,
): void {
  source.tapped = true;
  emit({ type: 'tapped', instanceId: source.instanceId });
  const owner = state.players[player];
  owner.manaPool = addProduction(owner.manaPool, production);
  for (const color of MANA_COLORS) {
    const amount = production[color] ?? 0;
    if (amount > 0) emit({ type: 'manaAdded', player, color, amount });
  }
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

  // Everything a RICH mana ability prints beyond the colour bundle. `undefined`
  // for every plain land and rock, so the ordinary tap is untouched by all of it.
  const extra = manaExtrasOf(source.def)?.[mode];
  if (extra) {
    // Same single answer the offer path used, so a mode the menu showed is a mode
    // this accepts — and one it hid is refused here too, even if a hostile client
    // sends it anyway.
    const blocked = manaModeBlockedReason(state, source, extra);
    if (blocked) return rejectWith(prevState, blocked);
    const player = state.players[action.player];
    const cost = extra.ability.cost;
    if (cost?.mana) {
      // Paid BEFORE the production is added, which is what makes a filter land a
      // filter rather than a free two mana: the input leaves the pool, then the
      // output arrives.
      const paid = payCost(player.manaPool, cost.mana);
      if (!paid.ok) return rejectWith(prevState, paid.reason);
      player.manaPool = paid.pool;
      emit({ type: 'manaCostPaid', player: action.player, cost: { ...cost.mana } });
    }
    if (cost?.life !== undefined && cost.life > 0) {
      player.life -= cost.life;
      emit({ type: 'lifeChanged', player: action.player, delta: -cost.life, to: player.life });
    }
  }

  tapPermanentForMana(state, source, action.player, production, emit);

  // The RIDER runs as part of the ability's own resolution, AFTER the mana is
  // added — a pain land's damage is not a cost you may decline, and it is damage
  // rather than life loss, so it goes through the same player-damage shape combat
  // and burn use. It happens even when it is lethal; the SBA pass that follows
  // this action is what ends the game, exactly as in paper.
  const damage = extra?.ability.rider?.damageToController ?? 0;
  if (damage > 0) {
    const player = state.players[action.player];
    player.life -= damage;
    emit({
      type: 'damageDealt',
      source: source.instanceId,
      target: action.player,
      amount: damage,
      combat: false,
    });
    emit({ type: 'lifeChanged', player: action.player, delta: -damage, to: player.life });
  }
  // Paying life or taking a rider's damage can reach zero, and that is legal —
  // the player's call, not the engine's to forbid (CR 118.4). Settling it needs
  // the SBA pass, exactly as the shockland payment does: a tap that kills you
  // must end the game here rather than leaving a corpse holding priority. Run
  // only when something actually changed a life total, so the ordinary tap —
  // by far the most frequent action in the game — pays nothing for it.
  if (damage > 0 || (extra?.ability.cost?.life ?? 0) > 0) checkStateBasedActions(state, emit);
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
  const fromZone = action.fromZone ?? 'hand';
  // The source zone is explicit and validated FIRST: a flashback cast finds its
  // card in the caster's own graveyard (the card is cast "from your graveyard",
  // so it is the owner's copy), and a card that has left that zone mid-response
  // — exiled, or already flashed back — is cleanly rejected here, exactly as a
  // hand card that was discarded in response would be.
  const card =
    fromZone === 'graveyard'
      ? instanceIn(player.graveyard, action.instanceId)
      : fromZone === 'exile'
        ? instanceIn(player.exile, action.instanceId)
        : instanceIn(player.hand, action.instanceId);
  if (!card) {
    return rejectWith(
      prevState,
      fromZone === 'graveyard'
        ? 'that card is not in your graveyard'
        : fromZone === 'exile'
          ? 'that card is not in exile'
          : 'that card is not in your hand',
    );
  }
  // A cast from EXILE is one of exactly two things, and neither may be assumed:
  // a MADNESS cast (the one card whose window is open), or a cast the card has
  // been given explicit PERMISSION for — an adventurer exiled by its adventure
  // (CR 715.3d) or a defeated Siege (CR 310.4). Both are checked here, so a
  // pilot or a hostile client cannot cast an arbitrary exiled card by naming
  // the zone. Madness is asked first because its window preempts the game.
  const madnessWindowOpen =
    fromZone === 'exile' &&
    state.madnessWindow?.instanceId === card.instanceId &&
    state.madnessWindow?.controller === action.player;
  const permission = fromZone === 'exile' && !madnessWindowOpen ? castPermissionFor(state, card) : undefined;
  const madnessCost = madnessWindowOpen ? card.def.madness : undefined;
  if (fromZone === 'exile') {
    if (!madnessWindowOpen && permission === undefined) {
      return rejectWith(prevState, 'that card has no open madness window and no permission to be cast from exile');
    }
    if (madnessWindowOpen && madnessCost === undefined) {
      return rejectWith(prevState, 'that card has no madness cost');
    }
    // The permission names ONE face. Casting the other half of an exiled
    // adventurer (or a Siege's battle half) is not something the rules ever
    // allow, so it is refused rather than silently redirected.
    if (permission !== undefined && (action.face ?? 'front') !== permission.face) {
      return rejectWith(prevState, 'that face of this card may not be cast from exile');
    }
  }
  // CR 712.8b: the back face of a transforming DFC can never be cast. A card in
  // hand is front-face-up by construction, so this is defensive — but a state
  // built by hand (a test, a hostile online client) must be refused, not played.
  if (card.def.isBackFace === true) {
    return rejectWith(prevState, 'the back face of a double-faced card cannot be cast');
  }
  // WHICH FACE. A modal DFC is one card with two castable halves, and every
  // characteristic below — type, cost, timing, targets, script — belongs to the
  // face being cast, not to the front. `playableFaceOf` refuses `'back'` for a
  // card with no CASTABLE back face, so a transforming DFC (whose back face is
  // only ever reached by a transform instruction) is rejected here, not cast.
  const castDef = playableFaceOf(card.def, action.face);
  if (!castDef) return rejectWith(prevState, 'that card has no castable back face');
  if (isLand(castDef)) return rejectWith(prevState, 'lands are played, not cast');
  // A back half restricted to certain zones (AFTERMATH's graveyard, a Siege
  // reward's exile) is legal only from one of them — the same table the offer
  // loop reads, so offer and accept cannot disagree about where a half lives.
  if (action.face === 'back' && !backFaceCastZonesOf(card.def).includes(fromZone)) {
    return rejectWith(prevState, `the second half of ${card.def.name} cannot be cast from your ${fromZone}`);
  }
  // Flashback may be PRINTED or GRANTED (Snapcaster Mage). One accessor answers
  // both, so the cast path cannot disagree with the offer loop about what a card
  // in the graveyard costs — or about whether it may be cast at all. On a face
  // OTHER than the front, the face's own printed cost is the answer: a grant is
  // made on the card as the granter saw it, which is its front face.
  //
  // AFTERMATH is the deliberate exception: its second half is cast from the
  // graveyard for its OWN printed cost, not for a flashback cost it does not
  // print, so a graveyard-legal back half skips this question entirely.
  const aftermath = fromZone === 'graveyard' && action.face === 'back';
  const flashbackCost =
    fromZone === 'graveyard' && !aftermath
      ? (castDef === card.def ? flashbackCostOf(state, card) : castDef.flashback)
      : undefined;
  if (fromZone === 'graveyard' && !aftermath && flashbackCost === undefined) {
    return rejectWith(prevState, 'that card has no flashback');
  }

  // Timing: sorcery-speed spells require your main phase, empty stack, your priority.
  const timing = castTiming(castDef);
  const sorcerySpeedOk =
    action.player === state.activePlayer && MAIN_STEPS.includes(state.step) && state.stack.length === 0;
  // A MADNESS cast happens inside its own window (CR 702.35a) — the card is cast
  // as the madness trigger resolves, so the spell's own timing restriction does
  // not apply and a sorcery really is cast on an opponent's turn. Every other
  // cast is timed exactly as before.
  if (timing === 'sorcery' && !sorcerySpeedOk && fromZone !== 'exile') {
    return rejectWith(prevState, 'this spell can only be cast at sorcery speed (your main phase, empty stack)');
  }

  // Target legality (targeting.ts). A spell whose printed text restricts what it
  // may point at ("to target creature", "to target player or planeswalker") is
  // rejected here when handed an illegal target — the engine, not the caller, is
  // the authority, so a pilot or a UI that builds its own action cannot play a
  // card as strictly better than printed.
  //
  // A MODAL spell is exempt from the whole-card check: it has no whole-card
  // target, because each announced mode is aimed separately at cast time (CR
  // 601.2c). Its aims are collected by the cast-time question pipeline below and
  // policed there, one mode at a time.
  const modalSpec = modalSpecOf(castDef);
  if (modalSpec) {
    if ((action.targets?.length ?? 0) > 0) {
      return rejectWith(prevState, `${castDef.name} chooses its targets per mode, not for the whole spell`);
    }
    // A modal spell that can announce NO mode cannot be cast at all (CR 601.2b):
    // every mode names a target and none has a legal one. Judged before any cost
    // is paid, by the very helper `generateLegalActions` offers by — so offer
    // and accept cannot disagree.
    if (!modalSpellIsCastable(state, castDef, action.player)) {
      return rejectWith(prevState, `${castDef.name} has no mode you could legally choose`);
    }
  } else {
    const targetProblem = illegalTargetReason(state, castDef, action.targets ?? [], action.player);
    if (targetProblem) return rejectWith(prevState, targetProblem);
  }

  // The MANDATORY additional cost, judged before any mana leaves the pool: a
  // cost that cannot be paid makes the whole cast illegal (CR 601.2h), so this
  // must refuse rather than let the spell resolve without paying. Same helper
  // the offer loop screens with.
  const additionalCostProblem = unpayableAdditionalCostReason(state, castDef, action.player, card.instanceId);
  if (additionalCostProblem) return rejectWith(prevState, additionalCostProblem);

  // A flashback cost may print a LIFE rider ("Flashback—{1}{U}, Pay 3 life").
  // It is a mandatory part of the cost, not a choice, so a caster who cannot pay
  // it simply cannot cast (CR 118.4) — checked before any mana leaves the pool,
  // so a refusal can never strand a half-paid cost.
  const flashbackLife = fromZone === 'graveyard' && !aftermath ? (castDef.flashbackLifeCost ?? 0) : 0;
  if (flashbackLife > 0 && !canAffordLifeCost(state, action.player, flashbackLife)) {
    return rejectWith(prevState, `you do not have ${flashbackLife} life to pay this flashback cost`);
  }

  // Pay the mana cost from the floating pool. A flashback cast pays the
  // FLASHBACK cost, not the printed one — that substitution is the whole of
  // what "cast it for its flashback cost" means at this seam.
  //
  // A permission may say WITHOUT PAYING ITS MANA COST (a Siege reward, CR
  // 310.4). That is data on the grant, so the one cast path charges exactly
  // what the card says and nothing here special-cases a layout.
  const cost = permission?.free
    ? undefined
    : fromZone === 'graveyard' && !aftermath
      ? flashbackCost
      : madnessWindowOpen
        ? madnessCost
        : castDef.cost;
  if (cost) {
    if (!canPay(player.manaPool, cost)) return rejectWith(prevState, 'insufficient mana to cast this spell');
    const result = payCost(player.manaPool, cost);
    if (!result.ok) return rejectWith(prevState, result.reason);
    player.manaPool = result.pool;
  }
  // The life half of the flashback cost, charged alongside the mana. Everything
  // above is validated, so this cannot half-pay.
  if (flashbackLife > 0) {
    payLifeCost(state, action.player, flashbackLife, emit);
    /*
     * PAYING A COST CAN KILL YOU, AND THAT HAS TO END THE GAME HERE.
     *
     * "Flashback—{1}{B}, Pay 3 life" at exactly 3 life is a legal thing to do
     * (CR 118.4 — the engine does not forbid it), and the caster then receives
     * priority, which is when state-based actions are checked (CR 704.3) and a
     * player at 0 or less life loses (CR 704.5a). Without this the game carried
     * on with a corpse holding priority: the soak found a player sitting at 0
     * life, casting spells, on turn 20 of seed 3856639351.
     *
     * The two sibling payment paths already do exactly this — `applyTapForMana`
     * for a pain land's rider and the shockland's pay-life choice — so this is
     * the third copy of one rule, not a new one.
     */
    checkStateBasedActions(state, emit);
  }

  // Move the card to the stack, out of whichever zone it was cast from.
  removeFromZoneArray(
    fromZone === 'graveyard' ? player.graveyard : fromZone === 'exile' ? player.exile : player.hand,
    card.instanceId,
  );
  // The madness window is CONSUMED by the cast: the card has left exile, so
  // nothing may decline it afterwards. A permission cast never had a window and
  // must not clear somebody else's.
  if (madnessWindowOpen) state.madnessWindow = null;
  card.zone = 'stack';
  // The card just changed zones, so any grant on it stops applying (CR 400.7).
  // Nothing is lost by dropping it here: the granted cost has already been paid,
  // and the EXILE replacement rides the stack object's own `castFrom`
  // (`spellLeaveDestination`) rather than the grant — see card-grants.ts.
  pruneCardGrantsFor(state, card.instanceId);
  // THE FACE SWAP, done exactly as a transform does it: `def` IS the active face
  // and `printedDef` is the way back to the front, so every characteristic read
  // in the engine routes through the face being cast with no second code path. A
  // back-face cast that later leaves for a graveyard/hand/library reverts in
  // `resetInstanceForNewZone` (CR 712.8a).
  if (castDef !== card.def) {
    card.printedDef = card.def;
    card.def = castDef;
  }
  // The source zone decides the exit: a permanent still resolves to the
  // battlefield, but a flashback spell resolves to EXILE, and the stack object
  // carries `castFrom` so countering reaches the same answer (see
  // `spellLeaveDestination`).
  const resolvesTo: SpellStackObject['resolvesTo'] = isPermanentType(castDef)
    ? 'battlefield'
    : fromZone === 'graveyard'
      ? 'exile'
      : 'graveyard';
  const stackObject: SpellStackObject = {
    kind: 'spell',
    instanceId: card.instanceId,
    card,
    controller: action.player,
    resolvesTo,
    targets: action.targets ?? [],
    ...(fromZone === 'hand' ? {} : { castFrom: fromZone }),
  };
  state.stack.push(stackObject);
  emit({
    type: 'spellCast',
    player: action.player,
    instanceId: card.instanceId,
    name: castDef.name,
    castTypes: [...castDef.types],
    ...(fromZone === 'hand' ? {} : { fromZone }),
  });
  // Ward (CR 702.21): targeting an opponent's warded permanent triggers the
  // "counter unless you pay" ability, stacked ABOVE the spell so it resolves
  // first. Raised here because "becomes the target" is a moment only the
  // engine sees — no effect resolves and no event exists a data trigger could
  // watch.
  pushWardTriggers(state, action.player, stackObject.targets, card.instanceId, emit);
  // Caster retains priority after putting something on the stack.
  state.priorityPlayer = action.player;
  state.consecutivePasses = 0;
  // CAST-TIME CHOICES. Every decision the caster makes while announcing this
  // spell — which modes, what each mode points at, the value of X, whether to
  // kick and how many times — is asked HERE: after the base cost is paid and
  // the spell is on the stack, with nothing resolving (so, like a shockland's
  // pay-life and a trigger's aiming, each question is parked with no resolution
  // frame behind it). While one stands, the only legal action is answering it,
  // and the ENGINE charges any extra cost as it accepts the answer. A question
  // with only one legal answer (X capped at 0, an unaffordable kicker, a
  // one-mode menu) is never asked — the forced answer is recorded and the game
  // does not stop.
  askNextCastChoice(state, card.instanceId, emit);
  /*
   * STATE-BASED ACTIONS AFTER THE ANNOUNCEMENT (CR 704.3). The caster receives
   * priority the instant the spell is announced, and that is a check point —
   * so casting is not exempt just because nothing has resolved yet.
   *
   * It matters because CASTING MOVES A CARD BETWEEN ZONES, and characteristic-
   * defining P/T reads zones: a flashback cast takes the last instant out of a
   * graveyard, every Tarmogoyf on the board loses a point of toughness, and one
   * wearing a Weakness (-2/-1) is at 0 and must die. Without this the game
   * handed priority to a player looking at a creature that should already be in
   * a graveyard — they could respond by targeting it, and its controller could
   * still spend it. Found by the full-pool soak (`@jonny-boi/sim`'s `soak.ts`)
   * at turn 8 of seed 1727114651, once in ~5,000 games and 3.2 million actions.
   *
   * Skipped while a CAST-TIME CHOICE stands, because then the announcement is
   * not finished and nobody has priority yet (CR 601.2) — the answer path runs
   * the pass itself. The check is a no-op on an ordinary board, and emits
   * nothing when nothing dies, so no event log or paired-arm comparison moves.
   */
  if (!state.pendingChoice) checkStateBasedActions(state, emit);
  return { state, events };
}

/** The spell stack object with this instance id, or undefined. */
function spellOnStack(state: GameState, instanceId: InstanceId): SpellStackObject | undefined {
  for (let i = state.stack.length - 1; i >= 0; i--) {
    const object = state.stack[i] as StackObject;
    if (object.kind === 'spell' && object.instanceId === instanceId) return object;
  }
  return undefined;
}

/**
 * Replace a spell stack object with a patched copy. Replaced rather than
 * mutated for the same reason `recordTriggerTargets` replaces: a stack object
 * is read-only data to everyone else (the masked view, the replay, a look-ahead
 * clone), and a fresh object keeps that true without a mutable escape hatch.
 */
function patchSpellOnStack(
  state: GameState,
  instanceId: InstanceId,
  patch: Partial<
    Pick<
      SpellStackObject,
      | 'xValue'
      | 'kicked'
      | 'kickCount'
      | 'modePicks'
      | 'boughtBack'
      | 'additionalCostPaid'
      | 'awaitingCastChoice'
    >
  >,
): void {
  const index = state.stack.findIndex((object) => object.kind === 'spell' && object.instanceId === instanceId);
  if (index < 0) return;
  const spell = state.stack[index] as SpellStackObject;
  const next: SpellStackObject = { ...spell, ...patch };
  // `awaitingCastChoice: undefined` must CLEAR the marker, not store undefined —
  // a field-by-field consumer (clone.ts) keys on presence.
  if (patch.awaitingCastChoice === undefined && 'awaitingCastChoice' in patch) {
    delete (next as { awaitingCastChoice?: unknown }).awaitingCastChoice;
  }
  state.stack[index] = next;
}

/**
 * The bound the engine offers for X: the largest value whose generic cost the
 * caster could actually produce (floating pool + everything still untappable),
 * answered by the SAME planner that will later make the payment — so the range
 * on offer cannot disagree with what the board can fund.
 *
 * Linear from zero: the planner refuses quickly once the board runs dry, X
 * spells are cast a handful of times per game (never on the per-decision hot
 * path), and a closed-form sum would be a second opinion on payability that
 * could drift from the planner's.
 */
function maxAffordableX(state: GameState, player: PlayerId, xCount: number): number {
  let max = 0;
  while (max < MAX_X_VALUE && planPaymentFor(state, player, { generic: (max + 1) * xCount }) !== undefined) {
    max += 1;
  }
  return max;
}

/**
 * A hard ceiling on the X range the engine will offer. Generous — funding it
 * needs this much mana available AT ONCE — and present so a degenerate board
 * cannot make the bound search (or the answer enumeration) unbounded.
 */
const MAX_X_VALUE = 64;

/**
 * The largest number of times `cost` could be paid on top of everything already
 * spent — multikicker's bound, and the exact analogue of {@link maxAffordableX}.
 *
 * Asked of the SAME planner that will make the payment, so the range on offer
 * cannot disagree with what the board can fund, and `repeatCost` (not a mana-
 * value multiply) is what it plans against — three copies of a hybrid cost are
 * three symbols the payer may satisfy in three different colours.
 */
function maxAffordableKicks(state: GameState, player: PlayerId, cost: ManaCost): number {
  let max = 0;
  while (max < MAX_X_VALUE && planPaymentFor(state, player, repeatCost(cost, max + 1)) !== undefined) {
    max += 1;
  }
  return max;
}

/**
 * How many `{X}` symbols THIS cast is paying for — the printed cost's, or the
 * FLASHBACK cost's when the spell is being cast from a graveyard ("Flashback
 * {X}{R}{R}{R}"). Read from the stack object rather than the definition alone,
 * because which cost is being paid is a fact about the cast, not the card.
 */
function xCountForCast(spell: SpellStackObject): number {
  const def = spell.card.def;
  return spell.castFrom === 'graveyard' ? (def.flashbackXCost ?? 0) : (def.xCost ?? 0);
}

/**
 * Ask the next unanswered cast-time question for a spell being cast, or record
 * the forced answer and move on when only one answer is legal.
 *
 * ORDER IS THE PRINTED ANNOUNCEMENT ORDER (CR 601.2b–601.2h), and it is not
 * cosmetic — each step's legal answers depend on the ones before it:
 *   1. **Modes**, because everything after is about the modes you announced.
 *   2. **Each chosen mode's targets**, in printed order (CR 601.2c).
 *   3. **The value of X** (CR 601.2f), then
 *   4. **the optional additional costs** — kicker, then multikicker.
 * A question with a single legal answer is settled here instead of stopping the
 * game to collect the inevitable, exactly as `isTrivialChoice` does mid-
 * resolution.
 */
function askNextCastChoice(state: GameState, spellInstanceId: InstanceId, emit: (e: GameEvent) => void): void {
  if (askModeChoice(state, spellInstanceId, emit)) return;
  if (askModeTargetChoice(state, spellInstanceId, emit)) return;
  askCostChoices(state, spellInstanceId, emit);
}

/**
 * Step 1 — "Choose one —". Returns true when a question was parked.
 *
 * The menu is the modes that can legally be announced RIGHT NOW (a mode whose
 * target does not exist is not on it), and the counts are the printed ones
 * clamped to that menu — which is how a "Choose two" Command with only one
 * legal mode left still casts, as the best legal version of itself.
 */
function askModeChoice(state: GameState, spellInstanceId: InstanceId, emit: (e: GameEvent) => void): boolean {
  const spell = spellOnStack(state, spellInstanceId);
  if (!spell || spell.modePicks !== undefined) return false;
  const def = spell.card.def;
  const spec = modalSpecOf(def);
  if (!spec) return false;
  const caster = spell.controller;
  const counts = modeCountsFor(state, def, caster);
  if (!counts) return false;

  const choice = normalizeChoiceRequest(
    {
      kind: 'chooseModes',
      chooser: caster,
      prompt:
        counts.min === counts.max
          ? `Choose ${counts.max} — ${def.name}`
          : `Choose up to ${counts.max} — ${def.name}`,
      modes: counts.choosable.map((mode) => ({ id: mode.id, label: mode.label })),
      min: counts.min,
      max: counts.max,
      // Choosing is the upside the caster cast the spell for; the AI prices each
      // mode on the board rather than following this steer blindly, but the
      // steer is what stops a neutral pilot taking the minimum every time.
      valence: 'gain',
      ...(spec.allowRepeats ? { allowRepeats: true } : {}),
    },
    { id: state.nextInstanceId++, sourceInstanceId: spell.instanceId, sourceName: def.name },
  );
  // Unrepresentable (a build that does not know this kind): announce as many
  // modes as the printed floor demands, taking the menu in printed order. That
  // is the same "safe default" `defaultAnswerFor` would produce, and it keeps a
  // half-understood state moving instead of wedging it.
  if (!choice) {
    recordModePicks(state, spellInstanceId, counts.choosable.slice(0, counts.min).map((mode) => mode.id), emit);
    return false;
  }
  if (isTrivialChoice(choice) || state.gameOver || state.players[caster].hasLost) {
    const answer = defaultAnswerFor(choice);
    emit({
      type: 'choiceAutoAnswered',
      choiceId: choice.id,
      chooser: caster,
      choiceKind: choice.kind,
      answer,
      reason: isTrivialChoice(choice) ? 'only one legal set of modes' : 'the chooser can no longer act',
    });
    recordModePicks(state, spellInstanceId, answer.kind === 'chooseModes' ? answer.modeIds : [], emit);
    return false;
  }
  patchSpellOnStack(state, spellInstanceId, { awaitingCastChoice: 'modes' });
  parkCastChoice(state, choice, emit);
  return true;
}

/**
 * Write the announced modes onto the stack object, in printed order, and say so
 * in the log. Announced modes are PUBLIC information — in paper they are
 * declared out loud as the spell is cast — so the event carries them plainly.
 */
function recordModePicks(
  state: GameState,
  spellInstanceId: InstanceId,
  modeIds: readonly string[],
  emit: (e: GameEvent) => void,
): void {
  const spell = spellOnStack(state, spellInstanceId);
  if (!spell) return;
  const def = spell.card.def;
  const picks = orderPicks(def, modeIds);
  patchSpellOnStack(state, spellInstanceId, { modePicks: picks, awaitingCastChoice: undefined });
  emit({
    type: 'modesChosen',
    player: spell.controller,
    instanceId: spell.instanceId,
    name: def.name,
    modes: picks.map((pick) => modeById(def, pick.modeId)?.label ?? pick.modeId),
  });
}

/**
 * Step 2 — aim the announced modes, one question per targeting pick, in printed
 * order. Returns true when a question was parked.
 *
 * This is the half a resolution-time modal system structurally cannot do: two
 * modes of one spell point at two different objects, and both are chosen before
 * the opponent may respond.
 */
function askModeTargetChoice(
  state: GameState,
  spellInstanceId: InstanceId,
  emit: (e: GameEvent) => void,
): boolean {
  for (;;) {
    const spell = spellOnStack(state, spellInstanceId);
    const picks = spell?.modePicks;
    if (!spell || !picks) return false;
    const def = spell.card.def;
    const index = nextUnaimedPick(def, picks);
    if (index < 0) return false;
    const pick = picks[index] as ModePick;
    const mode = modeById(def, pick.modeId);
    const restriction = mode?.targets;
    if (!mode || restriction === undefined) return false;
    const caster = spell.controller;
    const candidates = legalTargetsFor(state, restriction, caster, def);

    // A mode's target can vanish between announcement and aiming only in a
    // hand-built state (the menu was filtered by this same check a moment ago),
    // but the branch must exist: an unaimable pick is recorded as aimed at
    // nothing, so it contributes nothing at resolution rather than wedging the
    // cast.
    if (candidates.length === 0) {
      aimModePick(state, spellInstanceId, index, [], emit);
      continue;
    }

    const choice = normalizeChoiceRequest(
      {
        kind: 'selectTargets',
        chooser: caster,
        prompt: `Choose ${describeRestriction(restriction)} for "${mode.label}" (${def.name})`,
        candidates: candidates.map((ref) => targetOptionFor(state, ref)),
        restriction,
        min: SINGLE_TARGET,
        max: SINGLE_TARGET,
      },
      { id: state.nextInstanceId++, sourceInstanceId: spell.instanceId, sourceName: def.name },
    );
    if (!choice) {
      aimModePick(state, spellInstanceId, index, candidates.slice(0, SINGLE_TARGET), emit);
      continue;
    }
    if (isTrivialChoice(choice) || state.gameOver || state.players[caster].hasLost) {
      const answer = defaultAnswerFor(choice);
      emit({
        type: 'choiceAutoAnswered',
        choiceId: choice.id,
        chooser: caster,
        choiceKind: choice.kind,
        answer,
        reason: isTrivialChoice(choice) ? 'only one legal target' : 'the chooser can no longer act',
      });
      aimModePick(state, spellInstanceId, index, answer.kind === 'selectTargets' ? answer.targets : [], emit);
      continue;
    }
    patchSpellOnStack(state, spellInstanceId, { awaitingCastChoice: 'modeTarget' });
    parkCastChoice(state, choice, emit);
    return true;
  }
}

/**
 * Record one mode's chosen target. The pick being aimed is named by INDEX
 * (rather than by mode id) because the same mode may legally be chosen twice,
 * each copy with its own aim.
 */
function aimModePick(
  state: GameState,
  spellInstanceId: InstanceId,
  index: number,
  targets: ReadonlyArray<InstanceId | PlayerId>,
  emit: (e: GameEvent) => void,
): void {
  const spell = spellOnStack(state, spellInstanceId);
  const picks = spell?.modePicks;
  if (!spell || !picks || index < 0 || index >= picks.length) return;
  const def = spell.card.def;
  const next = picks.map((pick, i) => (i === index ? { modeId: pick.modeId, targets: [...targets] } : pick));
  patchSpellOnStack(state, spellInstanceId, { modePicks: next, awaitingCastChoice: undefined });
  emit({
    type: 'modeTargetChosen',
    player: spell.controller,
    instanceId: spell.instanceId,
    mode: modeById(def, (picks[index] as ModePick).modeId)?.label ?? (picks[index] as ModePick).modeId,
    targets: [...targets],
  });
  // A mode aimed at an opponent's warded permanent triggers ward exactly as any
  // other targeting does — "the target of a spell or ability".
  pushWardTriggers(state, spell.controller, targets, spell.instanceId, emit);
}

/**
 * Steps 3 and 4 — the value of X, then the optional additional costs. Split out
 * of {@link askNextCastChoice} so the modal steps read as their own pipeline.
 */
/**
 * The cards that could pay a spell's MANDATORY additional cost right now —
 * permanents its caster controls for a `'sacrifice'`, cards in their hand for a
 * `'discard'`.
 *
 * ONE reader, used by all three places that must agree about it: the offer loop
 * (which must not offer an uncastable spell), the cast path (which must reject
 * one), and the question that collects the payment. Three separate opinions
 * about "can this be paid" is exactly how a spell becomes offerable but
 * un-castable.
 *
 * The card being cast is EXCLUDED from a discard's candidates: by the time this
 * is asked it has already left the hand for the stack, but a caller judging
 * castability asks while it is still in hand, and a spell can never pay its own
 * additional cost with itself (CR 601.2h — it is on the stack).
 */
export function additionalCostCandidates(
  state: GameState,
  cost: AdditionalCastCost,
  caster: PlayerId,
  excludeInstanceId?: InstanceId,
): readonly CardInstance[] {
  const source =
    cost.kind === 'sacrifice'
      ? state.battlefield.filter((perm) => perm.controller === caster)
      : state.players[caster].hand;
  const out: CardInstance[] = [];
  for (const card of source) {
    if (card.instanceId === excludeInstanceId) continue;
    if (!matchesCardFilter(card, cost.filter)) continue;
    out.push(card);
  }
  return out;
}

/**
 * Why a spell's mandatory additional cost cannot be paid, or `undefined`.
 *
 * CR 601.2h: a cost you cannot pay makes the cast ILLEGAL — the spell is not
 * cast at all, rather than cast without the cost. That is the entire reason
 * this is a hard gate and not a declinable question.
 */
function unpayableAdditionalCostReason(
  state: GameState,
  def: CardDefinition,
  caster: PlayerId,
  excludeInstanceId?: InstanceId,
): string | undefined {
  const cost = def.additionalCost;
  if (!cost) return undefined;
  const need = cost.count ?? 1;
  const have = additionalCostCandidates(state, cost, caster, excludeInstanceId).length;
  return have >= need ? undefined : `you cannot pay ${def.name}'s additional cost (${cost.label})`;
}

/**
 * Pay a mandatory additional cost with the chosen cards, as the cast-time answer
 * is accepted.
 *
 * Both halves go through the SAME zone-change funnel every other sacrifice and
 * discard uses (`moveToZone`), which is what makes a dies/leaves-the-battlefield
 * trigger and the madness discard replacement see it — because in the rules they
 * genuinely do see it, and because the cost is paid BEFORE the spell finishes
 * being cast. A cost paid through a private shortcut would be a silently
 * different card. (When a "whenever you sacrifice a permanent" trigger event is
 * added, this path is already the one it must watch — there is no second one.)
 */
function payAdditionalCost(
  state: GameState,
  cost: AdditionalCastCost,
  caster: PlayerId,
  instanceIds: readonly InstanceId[],
  emit: (e: GameEvent) => void,
): void {
  for (const id of instanceIds) {
    const card =
      cost.kind === 'sacrifice'
        ? state.battlefield.find((perm) => perm.instanceId === id && perm.controller === caster)
        : state.players[caster].hand.find((held) => held.instanceId === id);
    if (!card) continue; // already gone — never a throw (rule 6)
    moveToZone(state, card, 'graveyard', emit, card.owner);
    resetInstanceForNewZone(card);
  }
}

function askCostChoices(state: GameState, spellInstanceId: InstanceId, emit: (e: GameEvent) => void): void {
  const spell = spellOnStack(state, spellInstanceId);
  if (!spell) return;
  const def = spell.card.def;
  const caster = spell.controller;

  const xCount = xCountForCast(spell);
  if (xCount > 0 && spell.xValue === undefined) {
    const max = maxAffordableX(state, caster, xCount);
    if (max <= 0) {
      // X = 0 is the only value this board can fund — not a decision, so the
      // game is not stopped to collect the inevitable (same rule as an
      // unaffordable payMana). Recorded, then on to the next question.
      patchSpellOnStack(state, spellInstanceId, { xValue: 0 });
    } else {
      const choice = normalizeChoiceRequest(
        {
          kind: 'chooseNumber',
          chooser: caster,
          prompt: `Choose a value for X (${def.name})`,
          min: 0,
          max,
          // More X is the upside the caster cast the spell for — the steer a
          // pilot answers by. It never affects which answers are legal.
          valence: 'gain',
        },
        { id: state.nextInstanceId++, sourceInstanceId: spell.instanceId, sourceName: def.name },
      );
      if (choice) {
        patchSpellOnStack(state, spellInstanceId, { awaitingCastChoice: 'x' });
        parkCastChoice(state, choice, emit);
        return;
      }
      patchSpellOnStack(state, spellInstanceId, { xValue: 0 });
    }
  }

  const refreshed = spellOnStack(state, spellInstanceId);
  if (!refreshed) return;
  if (def.kicker && refreshed.kicked === undefined) {
    if (!canAffordManaCost(state, caster, def.kicker)) {
      // A caster who cannot pay is never asked — the spell is simply unkicked,
      // the printed default.
      patchSpellOnStack(state, spellInstanceId, { kicked: false });
      return;
    }
    const choice = normalizeChoiceRequest(
      {
        kind: 'payMana',
        chooser: caster,
        prompt: `Pay the kicker ${formatManaCost(def.kicker)}? (${def.name})`,
        cost: def.kicker,
        affordable: true,
        valence: 'gain',
      },
      { id: state.nextInstanceId++, sourceInstanceId: refreshed.instanceId, sourceName: def.name },
    );
    if (choice) {
      patchSpellOnStack(state, spellInstanceId, { awaitingCastChoice: 'kicker' });
      parkCastChoice(state, choice, emit);
      return;
    }
    patchSpellOnStack(state, spellInstanceId, { kicked: false });
  }

  // MULTIKICKER — "you may pay {1}{G} any number of times as you cast this
  // spell". Same seam as X, and for the same reason: the answer is a COUNT, so
  // it is a `chooseNumber` bounded by what the planner can actually fund, never
  // the single yes/no a plain kicker asks. A board that cannot fund even one
  // extra payment yields the range 0..0, which is not a decision and is settled
  // without stopping the game.
  const afterKicker = spellOnStack(state, spellInstanceId);
  if (!afterKicker) return;
  if (def.multikicker && afterKicker.kickCount === undefined) {
    const max = maxAffordableKicks(state, caster, def.multikicker);
    if (max <= 0) {
      patchSpellOnStack(state, spellInstanceId, { kickCount: 0 });
      return;
    }
    const choice = normalizeChoiceRequest(
      {
        kind: 'chooseNumber',
        chooser: caster,
        prompt: `How many times do you pay the multikicker ${formatManaCost(def.multikicker)}? (${def.name})`,
        min: 0,
        max,
        valence: 'gain',
      },
      { id: state.nextInstanceId++, sourceInstanceId: afterKicker.instanceId, sourceName: def.name },
    );
    if (choice) {
      patchSpellOnStack(state, spellInstanceId, { awaitingCastChoice: 'multikicker' });
      parkCastChoice(state, choice, emit);
      return;
    }
    patchSpellOnStack(state, spellInstanceId, { kickCount: 0 });
  }

  // BUYBACK is the same shape as the plain kicker — an optional additional cost
  // asked once, charged by the engine as the answer is accepted — and differs
  // only in what the answer means later: not a branch inside the spell's script,
  // but where the card goes as it resolves (`spellLeaveDestination`).
  const afterKick = spellOnStack(state, spellInstanceId);
  if (!afterKick) return;
  if (def.buyback && afterKick.boughtBack === undefined) {
    if (!canAffordManaCost(state, caster, def.buyback)) {
      patchSpellOnStack(state, spellInstanceId, { boughtBack: false });
      return;
    }
    const choice = normalizeChoiceRequest(
      {
        kind: 'payMana',
        chooser: caster,
        prompt: `Pay the buyback ${formatManaCost(def.buyback)} to return ${def.name} to your hand?`,
        cost: def.buyback,
        affordable: true,
        valence: 'gain',
      },
      { id: state.nextInstanceId++, sourceInstanceId: afterKick.instanceId, sourceName: def.name },
    );
    if (choice) {
      patchSpellOnStack(state, spellInstanceId, { awaitingCastChoice: 'buyback' });
      parkCastChoice(state, choice, emit);
      return;
    }
    patchSpellOnStack(state, spellInstanceId, { boughtBack: false });
  }

  // THE MANDATORY ADDITIONAL COST, asked last — it is paid at CR 601.2h, after
  // X (601.2f) and the optional additional costs have been announced, so its
  // position in this list is the printed announcement order and not a
  // convenience.
  //
  // Unlike every question above it, this one has NO decline: the cast was only
  // legal because the cost is payable (`unpayableAdditionalCostReason`, checked
  // at the offer and again at the cast). What is being chosen is WHICH card
  // pays, so it is a `selectCards` with min === max, and a caster with exactly
  // enough candidates is not stopped to collect the inevitable.
  const afterBuyback = spellOnStack(state, spellInstanceId);
  if (!afterBuyback) return;
  const extra = def.additionalCost;
  if (extra && afterBuyback.additionalCostPaid === undefined) {
    const count = extra.count ?? 1;
    const candidates = additionalCostCandidates(state, extra, caster);
    if (candidates.length < count) {
      // Only reachable from a hand-built state — the cast path refused this.
      // Recorded as unpaid so the loop cannot spin asking again.
      patchSpellOnStack(state, spellInstanceId, { additionalCostPaid: false, awaitingCastChoice: undefined });
      return;
    }
    const choice = normalizeChoiceRequest(
      {
        kind: 'selectCards',
        chooser: caster,
        prompt: `${def.name}: ${extra.label}`,
        candidates: candidates.map((card) => cardOption(card)),
        min: count,
        max: count,
        // Paying a cost is a LOSS — the pilot gives up its worst qualifying
        // card, which is the whole skill in a sacrifice outlet.
        valence: 'loss',
        fromZone: extra.kind === 'sacrifice' ? 'battlefield' : 'hand',
      },
      { id: state.nextInstanceId++, sourceInstanceId: afterBuyback.instanceId, sourceName: def.name },
    );
    // A chooser who can no longer act is never stopped for a question, exactly as
    // the mode/X questions above handle it — the cost is still PAID, because it
    // is mandatory and the spell is already on the stack.
    const settleHere =
      !choice || isTrivialChoice(choice) || state.gameOver || state.players[caster].hasLost;
    if (!settleHere) {
      patchSpellOnStack(state, spellInstanceId, { awaitingCastChoice: 'additionalCost' });
      parkCastChoice(state, choice, emit);
      return;
    }
    // Exactly one legal set of payers (or a build that cannot represent the
    // question): pay it here, in the same order the answer would have.
    const forced = choice
      ? (defaultAnswerFor(choice) as { kind: 'selectCards'; instanceIds: readonly InstanceId[] }).instanceIds
      : candidates.slice(0, count).map((card) => card.instanceId);
    if (choice) {
      emit({
        type: 'choiceAutoAnswered',
        choiceId: choice.id,
        chooser: caster,
        choiceKind: choice.kind,
        answer: { kind: 'selectCards', instanceIds: forced },
        reason: isTrivialChoice(choice)
          ? 'only one legal way to pay this additional cost'
          : 'the chooser can no longer act',
      });
    }
    payAdditionalCost(state, extra, caster, forced, emit);
    patchSpellOnStack(state, spellInstanceId, { additionalCostPaid: true, awaitingCastChoice: undefined });
  }
}

/**
 * After one cast-time answer is recorded: ask the spell's next question if it
 * has one, aim any triggers that fired while the cast was being finished, and —
 * when nothing further is being asked — hand the floor back to the caster, who
 * never surrendered priority by casting.
 */
function finishCastChoice(
  state: GameState,
  spellInstanceId: InstanceId,
  caster: PlayerId,
  emit: (e: GameEvent) => void,
  events: GameEvent[],
): EngineResult {
  askNextCastChoice(state, spellInstanceId, emit);
  if (!state.pendingChoice) aimPendingTriggers(state, emit);
  if (!state.pendingChoice && !state.gameOver) {
    state.priorityPlayer = caster;
    state.consecutivePasses = 0;
  }
  return { state, events };
}

/** Park a cast-time question: the caster (its chooser) gets the floor. */
function parkCastChoice(state: GameState, choice: PendingChoice, emit: (e: GameEvent) => void): void {
  state.pendingChoice = choice;
  state.priorityPlayer = choice.chooser;
  state.consecutivePasses = 0;
  emit({
    type: 'choiceAsked',
    choiceId: choice.id,
    chooser: choice.chooser,
    choiceKind: choice.kind,
    prompt: choice.prompt,
    sourceInstanceId: choice.sourceInstanceId,
    optionCount: choiceOptionCount(choice),
  });
}

/**
 * CYCLE a card from hand (CR 702.29): pay the cycling cost, discard the card as
 * the rest of that cost, and put the cycling ability on the stack.
 *
 * Order follows rule 602.2 exactly as `applyActivateAbility` does — validate
 * everything, then pay the WHOLE cost, then put the ability on the stack — and
 * the order matters here more than usual, because the discard is a COST. Being
 * a cost is what makes cycling a madness card exile it (the discard funnel sees
 * an ordinary discard), what makes "whenever you cycle or discard" triggers
 * fire, and what makes the card already gone from hand while the drawn card
 * arrives. Countering the cycling ability would not put the card back.
 *
 * Cycling is instant-speed: it is an activated ability with no timing
 * restriction printed on it, so it is legal whenever its controller has
 * priority — including on an opponent's turn, which is most of what makes a
 * cycling land better than a tapland.
 */
function applyCycleCard(
  state: GameState,
  prevState: GameState,
  action: Extract<GameAction, { kind: 'cycleCard' }>,
  emit: (e: GameEvent) => void,
  events: GameEvent[],
): EngineResult {
  if (action.player !== state.priorityPlayer) return rejectWith(prevState, 'you do not have priority');
  const player = state.players[action.player];
  const card = instanceIn(player.hand, action.instanceId);
  if (!card) return rejectWith(prevState, 'that card is not in your hand');
  const index = action.abilityIndex ?? 0;
  const ability = card.def.cycling?.[index];
  if (!ability) return rejectWith(prevState, 'that card has no such cycling ability');
  if (!canPay(player.manaPool, ability.cost)) return rejectWith(prevState, 'insufficient mana to cycle this card');
  const paid = payCost(player.manaPool, ability.cost);
  if (!paid.ok) return rejectWith(prevState, paid.reason);
  player.manaPool = paid.pool;

  // The discard half of the cost, through the SAME funnel every other discard
  // uses — which is why a cycled madness card is exiled rather than buried.
  moveToZone(state, card, 'graveyard', emit, card.owner);
  resetInstanceForNewZone(card);
  emit({ type: 'cardCycled', player: action.player, instanceId: card.instanceId, name: card.def.name });

  const abilityStackId = state.nextInstanceId++;
  state.stack.push({
    kind: 'trigger',
    instanceId: abilityStackId,
    sourceInstanceId: card.instanceId,
    controller: action.player,
    effects: ability.effects,
    // Cycling abilities target nothing: every printed one draws a card or
    // searches a library, both of which act on their controller alone.
    targets: [],
    label: ability.label,
  });
  emit({
    type: 'abilityActivated',
    player: action.player,
    instanceId: card.instanceId,
    label: ability.label,
  });
  // The cycling player retains priority, as with casting a spell.
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
    action.player,
    source.def,
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
  if (cost.loyalty !== undefined) {
    // The loyalty cost is PAID here, before the ability reaches the stack, and
    // is not refunded if the ability is countered or fizzles (CR 602.2) — a
    // minus ability whose target vanishes has still spent the loyalty. The
    // 0-loyalty death from paying down to exactly zero is the SBA pass after
    // this action settles, exactly like paying life to zero.
    if (cost.loyalty > 0) addLoyalty(source, cost.loyalty);
    else if (cost.loyalty < 0) removeLoyalty(source, -cost.loyalty);
    if (cost.loyalty !== 0) {
      emit({
        type: 'loyaltyChanged',
        instanceId: source.instanceId,
        delta: cost.loyalty,
        to: loyaltyOf(source),
      });
    }
    source.loyaltyActivatedTurn = state.turnNumber;
  }

  const abilityStackId = state.nextInstanceId++;
  state.stack.push({
    kind: 'trigger',
    instanceId: abilityStackId,
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
  // Ward fires on "becomes the target of an ability an opponent controls" too.
  pushWardTriggers(state, action.player, action.targets ?? [], abilityStackId, emit);

  // Paying loyalty down to exactly zero is legal and immediately fatal to the
  // walker (CR 704.5i) — settled before anybody acts again, because the next
  // thing a player sees must not be a 0-loyalty walker still standing. The
  // ability already on the stack still resolves; its source is simply gone,
  // which `frameSource` handles with last-known information.
  if (cost.loyalty !== undefined && cost.loyalty < 0 && loyaltyOf(source) === 0) {
    checkStateBasedActions(state, emit);
  }

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
  if (cost.loyalty !== undefined) {
    // A loyalty cost only means anything on a planeswalker carrying loyalty
    // counters; anything else declaring one is malformed data, refused loudly.
    if (!isPlaneswalker(source.def)) return `${source.def.name} is not a planeswalker`;
    // One loyalty ability per permanent per turn (CR 606.3, modern form).
    if (source.loyaltyActivatedTurn === state.turnNumber) {
      return `${source.def.name} has already activated a loyalty ability this turn`;
    }
    // A minus cost removes counters, and you can never remove more than are
    // there (CR 118.5): a walker at 4 cannot pay −6.
    if (cost.loyalty < 0 && loyaltyOf(source) < -cost.loyalty) {
      return `${source.def.name} does not have ${-cost.loyalty} loyalty to pay`;
    }
  }
  return undefined;
}

/** Remove an instance from a zone array in place (hand or graveyard, at cast). */
function removeFromZoneArray(zone: CardInstance[], id: InstanceId): void {
  for (let i = 0; i < zone.length; i++) {
    if ((zone[i] as CardInstance).instanceId === id) {
      zone.splice(i, 1);
      return;
    }
  }
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

  // Per-attacker attacked OBJECTS (a planeswalker rather than the player). Every
  // entry must name a declared attacker, and its value must be the defending
  // player or an attackable permanent THAT PLAYER controls — you cannot attack
  // your own walker, the caster's seat, or a creature.
  const attackTargets = action.attackTargets;
  let storedTargets: Record<InstanceId, InstanceId | PlayerId> | undefined;
  if (attackTargets !== undefined) {
    const defender = defendingPlayerOf(state);
    for (const key of Object.keys(attackTargets)) {
      const attackerId = Number(key);
      if (!declaredAttackers.has(attackerId)) {
        return rejectWith(prevState, `attack target given for ${key}, which is not a declared attacker`);
      }
      const attacked = attackTargets[attackerId]!;
      if (typeof attacked === 'string') {
        if (attacked !== defender) return rejectWith(prevState, 'a creature can only attack the defending player');
        continue; // the default; storing it would be redundant but is harmless
      }
      const object = findOnBattlefield(state, attacked);
      if (!object) return rejectWith(prevState, `attacked permanent ${attacked} is not on the battlefield`);
      // WHO defends the object, not who controls it. For a planeswalker those are
      // the same player; for a BATTLE they are deliberately opposite — a Siege is
      // protected by its controller's opponent (CR 310.11), which is exactly what
      // makes attacking your OWN battle the printed play pattern. Deriving this
      // through `protectorOf` rather than comparing controllers is the whole
      // reason battles needed no second combat path.
      if (protectorOf(object) !== defender) {
        return rejectWith(prevState, `${object.def.name} is not defended by the defending player`);
      }
      if (!isAttackable(object.def)) {
        return rejectWith(prevState, `${object.def.name} is not a permanent that can be attacked`);
      }
      (storedTargets ??= {})[attackerId] = attacked;
    }
  }

  state.combat.attackers = [...action.attackers];
  state.combat.attackersDeclared = true;
  if (storedTargets !== undefined) state.combat.attackTargets = storedTargets;
  tapAttackers(state, action.attackers, emit);
  emit({
    type: 'attackersDeclared',
    attackers: [...action.attackers],
    ...(storedTargets !== undefined ? { attackTargets: { ...storedTargets } } : {}),
  });
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

  // Declaration-level restrictions (menace), which no per-pair check can see.
  const attackingCreatures = state.combat.attackers
    .map((id) => findOnBattlefield(state, id))
    .filter((c): c is CardInstance => c !== undefined);
  const declarationProblem = illegalBlockDeclaration(attackingCreatures, action.blocks, cont);
  if (declarationProblem) return rejectWith(prevState, declarationProblem);

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

/**
 * The two moves an open madness window offers its controller: cast the exiled
 * card for its madness cost (once per legal target, exactly as the hand and
 * graveyard loops do), or pass to decline.
 *
 * Pass is listed FIRST and unconditionally — an unaffordable madness cost must
 * still leave a way out, or the window would deadlock the game.
 */
function madnessActionsFor(state: GameState): GameAction[] {
  const window = state.madnessWindow;
  if (!window) return [];
  const me = window.controller;
  const player = state.players[me];
  const actions: GameAction[] = [{ kind: 'passPriority', player: me }];
  // Mana sources first: the cast below is only offered once the pool already
  // covers the madness cost, so a board of untapped lands has to be able to
  // produce before the offer can appear at all.
  pushManaTapActions(state, me, actions);
  const card = instanceIn(player.exile, window.instanceId);
  const cost = card?.def.madness;
  if (!card || cost === undefined || !canPay(player.manaPool, cost)) return actions;
  const restriction = targetRestrictionOf(card.def);
  if (restriction === undefined) {
    actions.push({ kind: 'castSpell', player: me, instanceId: card.instanceId, fromZone: 'exile' });
    return actions;
  }
  for (const target of legalTargetsFor(state, restriction, me, card.def)) {
    actions.push({
      kind: 'castSpell',
      player: me,
      instanceId: card.instanceId,
      targets: [target],
      fromZone: 'exile',
    });
  }
  return actions;
}

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
  // An open MADNESS window preempts the game the same way, with exactly two
  // moves: cast the exiled card for its madness cost, or pass, which declines
  // and drops it into the graveyard. Enumerated here rather than left to a
  // consumer's imagination, so every seat — a pilot, the hotseat UI, the online
  // client — plays madness by picking from the menu it already reads.
  if (state.madnessWindow) return madnessActionsFor(state);
  const me = state.priorityPlayer;
  const player = state.players[me];
  const actions: GameAction[] = [];

  // Pass priority is always available to the priority-holder.
  actions.push({ kind: 'passPriority', player: me });

  // Tap untapped mana sources you control for mana.
  //
  // Every array walk in this function is indexed rather than `for...of`. That is
  // not style: V8 does not reliably elide the array-iterator object here, and this
  // function runs once per decision for the whole game — the iterators alone were
  // the largest remaining source of per-action garbage once cloning is out of the
  // picture. Confined to this function and the mana helpers it calls, which are
  // the only places it has ever measured.
  pushManaTapActions(state, me, actions);
  const battlefield = state.battlefield;

  const sorcerySpeedWindow = me === state.activePlayer && MAIN_STEPS.includes(state.step) && state.stack.length === 0;

  // Play a land (sorcery-speed, land plays remaining).
  if (sorcerySpeedWindow && player.landsPlayedThisTurn < config.maxLandsPerTurn) {
    for (let h = 0; h < player.hand.length; h++) {
      const card = player.hand[h] as CardInstance;
      if (card.def.isBackFace === true) continue;
      if (isLand(card.def)) {
        actions.push({ kind: 'playLand', player: me, instanceId: card.instanceId });
      }
      // A modal DFC whose SECOND face is a land offers that land play too — the
      // spell//land MDFCs are exactly the card whose value is being able to
      // choose. Both halves are offered when both are playable.
      if (
        hasCastableBackFace(card.def) &&
        backFaceCastZonesOf(card.def).includes('hand') &&
        isLand(card.def.backFace as CardDefinition)
      ) {
        actions.push({ kind: 'playLand', player: me, instanceId: card.instanceId, face: 'back' });
      }
    }
    // The LAND half of an adventurer card, waiting in exile with permission
    // (CR 715.3d, "you may play the land later from exile"). Behind the same
    // empty check as every other card-grant consumer, so a game with nothing
    // exiled under permission walks no exile zone here either.
    if (hasCardGrants(state)) {
      const exile = player.exile;
      for (let e = 0; e < exile.length; e++) {
        const card = exile[e] as CardInstance;
        const permission = castPermissionFor(state, card);
        if (permission === undefined) continue;
        const playDef = playableFaceOf(card.def, permission.face);
        if (playDef === undefined || !isLand(playDef)) continue;
        actions.push({
          kind: 'playLand',
          player: me,
          instanceId: card.instanceId,
          ...(permission.face === 'back' ? { face: 'back' as const } : {}),
          fromZone: 'exile',
        });
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
  for (let h = 0; h < player.hand.length; h++) {
    const card = player.hand[h] as CardInstance;
    // A TRANSFORMING back face is never castable (CR 712.8b) — mirror
    // `applyCastSpell`'s guard so the offered menu can only contain playable
    // actions. A MODAL DFC is different: both of its faces are real casts, so
    // each is offered on its own terms (own cost, own timing, own targets).
    if (card.def.isBackFace === true) continue;
    // `playableFaceOf` is what makes a SPLIT card work here with no branch: on
    // one, `'front'` means its LEFT half rather than the CR 709.4 combined
    // object nobody can cast; on everything else it is the definition itself.
    pushCastOffers(
      state,
      card,
      playableFaceOf(card.def, 'front') as CardDefinition,
      'front',
      me,
      player.manaPool,
      sorcerySpeedWindow,
      actions,
    );
    // The second half - a modal DFC's other face, a split card's right half -
    // but only when the HAND is a zone it may be cast from. Aftermath prints a
    // right half castable only from the graveyard (CR 702.127a), and offering
    // it here would be a strictly better card than the one printed.
    if (hasCastableBackFace(card.def) && backFaceCastZonesOf(card.def).includes('hand')) {
      pushCastOffers(
        state,
        card,
        card.def.backFace as CardDefinition,
        'back',
        me,
        player.manaPool,
        sorcerySpeedWindow,
        actions,
      );
    }
  }

  // Flashback: cast a card with a flashback cost out of YOUR OWN graveyard.
  // Mirrors the hand loop exactly — same timing gate (a sorcery flashes back
  // only at sorcery speed), same pool-funds-it gate, same one-offer-per-legal-
  // target rule for restricted spells — with the flashback cost in place of the
  // printed one and the action carrying its explicit source zone.
  const graveyard = player.graveyard;
  for (let g = 0; g < graveyard.length; g++) {
    const card = graveyard[g] as CardInstance;
    // Printed OR granted — one accessor, so a granted flashback is offered
    // exactly as a printed one is, and costs one property read per graveyard
    // card on a board where no grant exists anywhere.
    // AFTERMATH (CR 702.127a) first: a right half printed "cast this spell only
    // from your graveyard" is offered here for its OWN cost, and is the one
    // graveyard cast that is not a flashback. A card could print both - nothing
    // does today - so this is an extra offer, not an early exit.
    if (hasCastableBackFace(card.def) && backFaceCastZonesOf(card.def).includes('graveyard')) {
      pushCastOffers(
        state,
        card,
        card.def.backFace as CardDefinition,
        'back',
        me,
        player.manaPool,
        sorcerySpeedWindow,
        actions,
        AFTERMATH_OFFER,
      );
    }
    const flashbackCost = flashbackCostOf(state, card);
    if (flashbackCost === undefined || isLand(card.def)) continue;
    const timing = castTiming(card.def);
    if (timing !== 'instant' && !sorcerySpeedWindow) continue;
    if (!canPay(player.manaPool, flashbackCost)) continue;
    // A flashback cost may print a mandatory life rider ("Flashback—{1}{U}, Pay
    // 3 life"). It is part of the cost, so a caster who cannot pay it is not
    // offered the cast — the same gate `applyCastSpell` enforces.
    const lifeCost = card.def.flashbackLifeCost ?? 0;
    if (lifeCost > 0 && !canAffordLifeCost(state, me, lifeCost)) continue;
    // A modal spell cast from the graveyard obeys the same "can you announce a
    // mode at all?" rule as one cast from hand.
    if (!modalSpellIsCastable(state, card.def, me)) continue;
    const restriction = modalSpecOf(card.def) ? undefined : targetRestrictionOf(card.def);
    if (restriction === undefined) {
      actions.push({ kind: 'castSpell', player: me, instanceId: card.instanceId, fromZone: 'graveyard' });
      continue;
    }
    for (const target of legalTargetsFor(state, restriction, me, card.def)) {
      actions.push({
        kind: 'castSpell',
        player: me,
        instanceId: card.instanceId,
        targets: [target],
        fromZone: 'graveyard',
      });
    }
  }

  // Cast a card sitting in EXILE that has been given explicit permission - an
  // adventurer exiled by its own adventure (CR 715.3d), or a Siege exiled when
  // its last defense counter came off (CR 310.4). The permission names the face
  // and whether the cast is free; everything else (timing, targets, the pool
  // funding it) is judged by the same helper every other cast offer uses.
  //
  // Guarded by the SAME empty check every other card-grant consumer starts with,
  // so a game in which nothing is ever exiled with permission walks no exile
  // zone at all. That matters: this runs once per priority decision.
  if (hasCardGrants(state)) {
    const exile = player.exile;
    for (let e = 0; e < exile.length; e++) {
      const card = exile[e] as CardInstance;
      const permission = castPermissionFor(state, card);
      if (permission === undefined) continue;
      const castDef = playableFaceOf(card.def, permission.face);
      if (castDef === undefined) continue;
      pushCastOffers(state, card, castDef, permission.face, me, player.manaPool, sorcerySpeedWindow, actions, {
        fromZone: 'exile',
        free: permission.free,
      });
    }
  }

  // Cycle a card in hand (CR 702.29). Instant speed — cycling prints no timing
  // restriction — so the only gate is affording the cycling cost, which mirrors
  // the pool-funds-it gate every other offer above uses. Offered once per
  // printed cycling ability, so a card with both cycling and landcycling is two
  // distinct, separately scoreable actions.
  for (let h = 0; h < player.hand.length; h++) {
    const card = player.hand[h] as CardInstance;
    const cycling = card.def.cycling;
    if (!cycling || cycling.length === 0) continue;
    for (let index = 0; index < cycling.length; index++) {
      if (!canPay(player.manaPool, cycling[index]!.cost)) continue;
      actions.push({ kind: 'cycleCard', player: me, instanceId: card.instanceId, abilityIndex: index });
    }
  }

  // Activate non-mana abilities of permanents you control. Mirrors the casting
  // rules above: timing is checked, the whole cost must be payable, and an
  // ability with a target restriction is offered once per LEGAL target (and not
  // at all when there is none), so this menu can only contain playable actions.
  for (let b = 0; b < battlefield.length; b++) {
    const perm = battlefield[b] as CardInstance;
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
      for (const target of legalTargetsFor(state, restriction, me, perm.def)) {
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
    // One pass building the id list directly. `filter(...).map(...)` allocated two
    // closures and an intermediate array of instances that was thrown away.
    const eligible: InstanceId[] = [];
    for (let b = 0; b < battlefield.length; b++) {
      const c = battlefield[b] as CardInstance;
      if (c.controller !== me || !isCreature(c.def) || c.tapped) continue;
      const kw = effectiveKeywords(c, cont.get(c.instanceId) ?? NO_MOD);
      if ((c.summoningSick && !kw.haste) || kw.defender) continue;
      eligible.push(c.instanceId);
    }
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
/**
 * Offer every legal way to cast ONE FACE of a card from hand, appending to
 * `actions`.
 *
 * Extracted so a modal DFC's two faces go through identical logic — the whole
 * point of a second castable face is that it is a real cast with its OWN cost,
 * timing, target restriction and modal header, and a second inline copy of
 * these gates is exactly where the two would drift apart.
 */
function pushCastOffers(
  state: GameState,
  card: CardInstance,
  def: CardDefinition,
  face: 'front' | 'back',
  me: PlayerId,
  pool: import('./mana.js').ManaPool,
  sorcerySpeedWindow: boolean,
  actions: GameAction[],
  options?: CastOfferOptions,
): void {
  if (isLand(def)) return; // lands are played, not cast (the MDFC land half)
  const timing = castTiming(def);
  if (timing !== 'instant' && !sorcerySpeedWindow) return;
  // `free` is a permission that says "without paying its mana cost" (a Siege
  // reward, CR 310.4). Otherwise the face's own printed cost - which is also
  // exactly what an AFTERMATH half cast from the graveyard pays.
  if (options?.free !== true && def.cost && !canPay(pool, def.cost)) return;
  // A modal spell with nothing it could legally announce cannot be cast — the
  // same judgement `applyCastSpell` makes, from the same helper.
  if (!modalSpellIsCastable(state, def, me)) return;
  // A MANDATORY additional cost this board cannot pay makes the cast illegal
  // (CR 601.2h) — so the spell is not offered at all. Same helper the cast path
  // rejects with, so offer and accept cannot disagree. The card itself is
  // excluded from a discard's candidates: it will be on the stack by the time
  // the cost is paid.
  if (unpayableAdditionalCostReason(state, def, me, card.instanceId)) return;
  // Written only for a back-face offer, so a front-face cast action stays
  // byte-for-byte the object every consumer has always seen.
  const faceField = face === 'back' ? ({ face: 'back' } as const) : undefined;
  // Same rule for the source zone: absent means `'hand'`, so every cast from
  // hand keeps producing the action object consumers have always seen.
  const zoneField =
    options?.fromZone !== undefined && options.fromZone !== 'hand'
      ? ({ fromZone: options.fromZone } as const)
      : undefined;
  // A modal spell has no whole-card target: its aims are per mode, collected by
  // the cast-time question pipeline. So it is offered bare, exactly once.
  const restriction = modalSpecOf(def) ? undefined : targetRestrictionOf(def);
  if (restriction === undefined) {
    actions.push({ kind: 'castSpell', player: me, instanceId: card.instanceId, ...faceField, ...zoneField });
    return;
  }
  for (const target of legalTargetsFor(state, restriction, me, def)) {
    actions.push({
      kind: 'castSpell',
      player: me,
      instanceId: card.instanceId,
      targets: [target],
      ...faceField,
      ...zoneField,
    });
  }
}

/**
 * How a cast offer differs from the ordinary one from hand: which zone the card
 * is being cast out of, and whether a permission waives its mana cost. Both
 * default to the hand cast nearly every spell in the game makes, so the
 * overwhelming majority of offers pass nothing at all.
 */
interface CastOfferOptions {
  readonly fromZone?: CastZone;
  readonly free?: boolean;
}

/**
 * The offer shape an AFTERMATH half is made with: cast from the graveyard, for
 * its own printed cost. Hoisted so the per-graveyard-card loop allocates no
 * options object on a board where nothing prints aftermath.
 */
const AFTERMATH_OFFER: CastOfferOptions = { fromZone: 'graveyard' };

export function choiceActionsFor(choice: PendingChoice): readonly GameAction[] {
  return enumerateChoiceAnswers(choice).map(
    (answer): GameAction => ({ kind: 'answerChoice', player: choice.chooser, choiceId: choice.id, answer }),
  );
}

/** Convenience: re-export winner resolution for callers that force-end a game. */
export { resolveWinner };
