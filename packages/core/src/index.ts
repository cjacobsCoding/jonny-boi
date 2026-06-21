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
export type { ManaColor, ManaCost, ManaPool, PaymentResult } from './mana.js';
export {
  MANA_COLORS,
  emptyPool,
  addMana,
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
  castTiming,
} from './card.js';

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
  CombatState,
} from './state.js';
export { PLAYER_IDS, STEP_ORDER, MAIN_STEPS, createPlayer, playerZone } from './state.js';

// Events
export type { GameEvent, EventLog } from './events.js';
export { createEventLog, eventsOfType } from './events.js';

// Effect registry seam
export type { EffectContext, EffectPrimitive, EffectRegistry } from './effects.js';
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

// Engine
export type { DeckList, GameSetup, EngineResult, Engine } from './engine.js';
export { createGame, createEngine, applyAction, generateLegalActions } from './engine.js';

// Stat helpers (combat/SBA-facing; AI heuristics will want these)
export { effectivePower, effectiveToughness, remainingToughness, PLUS_ONE_COUNTER } from './internal/stats.js';

// Debug / inspector seam
export type { SerializedState } from './serialize.js';
export { serializeState, dumpState } from './serialize.js';
