/**
 * `@jonny-boi/core` — the pure, deterministic MTG rules-engine MVP (DESIGN §3.1).
 *
 * This is the lowest layer of the monorepo; `cards`, `ai`, and `sim` import it.
 * It is DOM-free and node-free so it runs in Node and a browser Web Worker.
 *
 * Public API surface (what other packages build against):
 *   - Game lifecycle: `createGame`, `createEngine`, `applyAction`, `generateLegalActions`.
 *   - State seam: `GameState`, `CardInstance`, `PlayerState`, `StackObject`, zones/steps.
 *   - Action seam (AI): `GameAction` union + the per-action interfaces.
 *   - Card seam (cards pkg): `CardDefinition`, `EffectRef`, `KeywordFlags`, predicates.
 *   - Effect seam (cards pkg): `EffectRegistry`, `EffectContext`, `createEffectRegistry`.
 *   - Event log: `GameEvent` union, `eventsOfType`.
 *   - Mana: `ManaCost`, `ManaPool`, `payCost`, `canPay`, etc.
 *   - RNG: `Rng`, `createRng`, `shuffle`.
 *   - Config: `RulesConfig`, `DEFAULT_RULES` (named, designer-tunable constants).
 *   - Debug: `serializeState`, `dumpState`.
 */

/**
 * Stable package identity placeholder retained from the scaffold so the
 * cross-workspace import smoke test in `@jonny-boi/sim` keeps resolving.
 */
export const PACKAGE_NAME = 'core';

// Config / constants
export type { RulesConfig } from './config.js';
export { DEFAULT_RULES } from './config.js';

// RNG
export type { Rng } from './rng.js';
export { createRng, shuffle } from './rng.js';

// Mana
export type { ManaColor, ManaCost, ManaPool, ManaProduction, PaymentResult } from './mana.js';
export {
  MANA_COLORS,
  emptyPool,
  addMana,
  addProduction,
  productionTotal,
  poolTotal,
  convertedManaCost,
  payCost,
  canPay,
} from './mana.js';

// Card model seam
export type {
  CardDefinition,
  CardType,
  CastTiming,
  EffectRef,
  KeywordFlags,
} from './card.js';
export {
  hasType,
  isLand,
  isCreature,
  isPermanentType,
  isManaSource,
  manaModesOf,
  manaColorsOffered,
  bestManaYield,
  castTiming,
} from './card.js';

// Triggered-ability seam (DESIGN §3.9): how a CardDefinition declares triggers.
export type {
  TriggeredAbility,
  TriggerCondition,
  TriggerEvent,
  TriggerWho,
  PendingTrigger,
  TriggerSource,
} from './triggers.js';
export { conditionMatches, matchTriggers, orderPendingTriggers } from './triggers.js';

// Continuous-effects seam (DESIGN §3.9): "until end of turn" P/T buffs + keyword grants.
export type {
  ContinuousEffect,
  ContinuousDuration,
  AggregatedMod,
  ContinuousIndex,
} from './internal/continuous.js';
export {
  indexContinuous,
  aggregateFor,
  expireContinuousEffects,
  NO_MOD,
} from './internal/continuous.js';

// State
export type {
  GameState,
  CardInstance,
  PlayerState,
  PlayerId,
  InstanceId,
  ZoneName,
  Step,
  StackObject,
  SpellStackObject,
  TriggeredStackObject,
  CombatState,
} from './state.js';
export { PLAYER_IDS, STEP_ORDER, MAIN_STEPS, createPlayer, playerZone } from './state.js';

// Events
export type { GameEvent, EventLog } from './events.js';
export { createEventLog, eventsOfType } from './events.js';

// Effect registry seam
export type { EffectContext, EffectPrimitive, EffectRegistry, ContinuousModRequest } from './effects.js';
export { createEffectRegistry, applyEffectRef } from './effects.js';

// Actions seam
export type {
  GameAction,
  ActionKind,
  PassPriorityAction,
  PlayLandAction,
  TapForManaAction,
  CastSpellAction,
  DeclareAttackersAction,
  DeclareBlockersAction,
} from './actions.js';
export { DEFAULT_MANA_MODE } from './actions.js';

// Mana payment planning — shared by the AI pilots and the hotseat/online auto-tap
// so "which lands do I tap" has exactly one implementation.
export type { ManaTapPlan } from './mana-plan.js';
export { planManaPayment, distanceToPayable } from './mana-plan.js';

// Engine
export type { DeckList, GameSetup, EngineResult, Engine } from './engine.js';
export { createGame, createEngine, applyAction, applyActionInPlace, generateLegalActions } from './engine.js';
/**
 * Deep-copy the mutable parts of a state (card definitions stay shared). Paired
 * with `applyActionInPlace`: a look-ahead pilot clones once, then mutates freely.
 */
export { cloneState } from './internal/clone.js';

// Stat helpers (combat/SBA-facing; AI heuristics will want these). The effective
// accessors take an optional AggregatedMod so callers can layer continuous effects
// (e.g. `effectivePower(inst, indexContinuous(state).get(inst.instanceId) ?? NO_MOD)`).
export {
  effectivePower,
  effectiveToughness,
  remainingToughness,
  effectiveKeywords,
  hasKeyword,
  PLUS_ONE_COUNTER,
} from './internal/stats.js';

// Debug / inspector seam
export type { SerializedState } from './serialize.js';
export { serializeState, dumpState } from './serialize.js';
