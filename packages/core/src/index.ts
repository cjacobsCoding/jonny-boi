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
  formatManaCost,
  payCost,
  canPay,
  repeatCost,
} from './mana.js';

// Card model seam
export type {
  ActivatedAbility,
  ActivationCost,
  EntersUntappedCondition,
  EntersTappedContext,
  CardDefinition,
  CardType,
  CastTiming,
  EffectRef,
  KeywordFlags,
  ManaAbility,
  ManaAbilityCost,
  ManaAbilityRider,
  ManaActivationCondition,
  ManaModeExtra,
  DerivedManaColors,
  ModalSpec,
  SpellMode,
} from './card.js';
export {
  hasType,
  hasSubtype,
  isLand,
  isCreature,
  isPlaneswalker,
  isBattle,
  isAttackable,
  isPermanentType,
  isManaSource,
  manaModesOf,
  manaExtrasOf,
  manaColorsOffered,
  fixedManaColorsOf,
  manaActivationConditionMet,
  bestManaYield,
  castTiming,
  entersTapped,
  hasCastableBackFace,
  playableFaceOf,
} from './card.js';

/**
 * Static ("anthem") seam: how a `CardDefinition` declares a continuous modification
 * to OTHER permanents that lasts exactly as long as it is on the battlefield.
 * Aggregated through the same `indexContinuous` path as until-end-of-turn effects,
 * so every consumer that already reads effective values gets statics for free.
 */
export type { PermanentModification, StaticAbility, StaticAffects, StaticControllerScope } from './statics.js';

// Derived values — the ONE evaluator behind "equal to the number of …" params
// and characteristic-defining P/T, plus its closed count vocabulary.
export type { CharacteristicFormula, CharacteristicPT, DerivedCountName } from './card.js';
export { evaluateDerivedCount, characteristicValue } from './derived.js';

// Turn-scoped fact memory (revolt / morbid / lifegain) — a NAMED closed
// vocabulary, not a general event query. See turn-facts.ts.
export type { TurnFact } from './turn-facts.js';
export { TURN_FACTS, turnFactHolds, setTurnFact, clearTurnFacts } from './turn-facts.js';
export {
  DEFAULT_STATIC_SCOPE,
  staticsOf,
  staticAppliesTo,
  staticIsInert,
  modificationIsInert,
} from './statics.js';

/**
 * Attachment seam: one permanent attached to another. Auras and Equipment are the
 * SAME relationship — a host filter, a modification, and what the state-based
 * actions do when it is not legally attached — so a card declares
 * `CardDefinition.attachment` and core needs no per-form system. See
 * `attachments.ts` for the full rationale.
 */
export type { AttachmentSpec, AttachmentHostFilter, AttachmentIllegalAction } from './attachments.js';
export {
  AURA_WHEN_ILLEGAL,
  EQUIPMENT_WHEN_ILLEGAL,
  DEFAULT_HOST_SCOPE,
  attachmentOf,
  attachmentProblem,
  attachTo,
  detachFromHost,
  isLegalHost,
  isLegallyAttached,
  illegalAttachmentReason,
} from './attachments.js';

// Target legality (targeting.ts): what a spell is ALLOWED to point at, declared
// as data on the effect ref (`params.targets`) and enforced when actions are
// offered, when a cast is applied, and again when the effect resolves.
export type { TargetRestriction } from './targeting.js';
export {
  TARGET_RESTRICTION_PARAM,
  DEFAULT_TARGET_RESTRICTION,
  isTargetRestriction,
  targetRestrictionOf,
  isPlayerTarget,
  isLegalTarget,
  legalTargetsFor,
  illegalTargetReason,
  restrictionOfEffects,
  describeRestriction,
} from './targeting.js';

// Protection from [quality] + ward (protection.ts): the source-aware half of
// targeting/damage/attachment/blocking legality, and the reserved ward seam.
export type { ProtectionQuality } from './card.js';
export { unionProtection } from './card.js';
export {
  PROTECTION_QUALITIES,
  WARD_COST_PARAM,
  WARD_COUNTER_PRIMITIVE,
  colorsOfDefinition,
  effectiveProtectionOf,
  effectiveWardOf,
  isProtectionQuality,
  protectionBlocksSource,
  protectionPreventsDamage,
  sourceHasQuality,
} from './protection.js';

// Card grants (card-grants.ts): continuous effects on cards in NON-battlefield
// zones — Snapcaster Mage's "target instant or sorcery card in your graveyard
// gains flashback until end of turn". A separate list from the continuous layer
// because that layer is keyed on battlefield permanents; see the module header
// for the CR 400.7 zone-change rule and the empty-check performance discipline.
export type { CardGrant, CardGrantRequest } from './card-grants.js';
export {
  addCardGrant,
  expireCardGrants,
  flashbackCostOf,
  hasCardGrants,
  pruneCardGrantsFor,
} from './card-grants.js';
/**
 * Transforming double-faced cards (CR 701.28 / 712): a front-face definition
 * nests its back face (`CardDefinition.backFace`), which face is up is
 * per-permanent state (`CardInstance.def` = the active face), and
 * `transformPermanent` is the ONE writer that swaps it. Effect primitives owned
 * by `cards` call it; nothing else mutates a face.
 */
export type { FaceUp } from './transform.js';
export { transformPermanent, faceUpOf, transformTargetOf } from './transform.js';

/**
 * MODAL-SPELL seam (`./modal.ts`): which modes of a "Choose one --" card may be
 * ANNOUNCED on this board, and what each announced mode resolves into. Read by
 * the engine at cast time, by the AI to price a mode before choosing it, and by
 * the web UI to label the question.
 */
export type { ModeCounts, ModalResolution } from './modal.js';
export {
  modalSpecOf,
  modalSpellIsCastable,
  modeById,
  modeCountsFor,
  modeIsChoosable,
  choosableModes,
  nextUnaimedPick,
  orderPicks,
  pickTargetIsLegal,
  picksToResolution,
} from './modal.js';

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

// Continuous-effects seam (DESIGN §3.9): the ONE layering path. `indexContinuous`
// aggregates both lifetimes — "until end of turn" P/T buffs / keyword grants AND the
// statics radiating from permanents currently on the battlefield.
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
  ModePick,
  CombatState,
} from './state.js';
export {
  PLAYER_IDS,
  STEP_ORDER,
  MAIN_STEPS,
  NO_COUNTERS,
  createPlayer,
  playerZone,
  opponentOf,
  protectorOf,
  spellLeaveDestination,
} from './state.js';

// Events
export type { GameEvent, EventLog } from './events.js';
export { createEventLog, eventsOfType } from './events.js';

// Effect registry seam
export type {
  EffectContext,
  EffectContextBase,
  EffectPrimitive,
  EffectRegistry,
  ContinuousModRequest,
  ChoiceChannel,
  ChoiceRequestArgs,
} from './effects.js';
export { createEffectRegistry, applyEffectRef, shuffleLibraryInState } from './effects.js';

// Actions seam
export type {
  GameAction,
  ActionKind,
  PassPriorityAction,
  PlayLandAction,
  TapForManaAction,
  ActivateAbilityAction,
  CastSpellAction,
  CastZone,
  DeclareAttackersAction,
  DeclareBlockersAction,
  AnswerChoiceAction,
} from './actions.js';
export { DEFAULT_MANA_MODE } from './actions.js';

/**
 * Player-choice seam (DESIGN §3.11 "player choice during resolution"): a resolving
 * spell/ability asks a typed question, the engine parks it in
 * `GameState.pendingChoice`, and an `answerChoice` action resumes the resolution.
 * Card authors ask via `EffectContext.chooseCards / choosePlayers / chooseModes /
 * confirm / payOrDecline`; the AI, the hotseat UI and the online server all answer
 * through the ordinary action seam.
 */
export type {
  CardFilter,
  CardOption,
  ChoiceMode,
  ChoiceKind,
  ChoiceValence,
  ChoiceRequest,
  SelectCardsRequest,
  SelectPlayersRequest,
  ChooseModesRequest,
  ConfirmRequest,
  PayManaRequest,
  PayLifeRequest,
  ChooseNumberRequest,
  SelectTargetsRequest,
  TargetOption,
  PendingChoice,
  SelectCardsChoice,
  SelectPlayersChoice,
  ChooseModesChoice,
  ConfirmChoice,
  PayManaChoice,
  PayLifeChoice,
  ChooseNumberChoice,
  SelectTargetsChoice,
  ChoiceAnswer,
  SelectCardsAnswer,
  SelectPlayersAnswer,
  ChooseModesAnswer,
  ConfirmAnswer,
  PayManaAnswer,
  PayLifeAnswer,
  ChooseNumberAnswer,
  SelectTargetsAnswer,
  AnswerValidation,
  ResolutionFrame,
  CollectOptions,
} from './choices.js';
export {
  matchesCardFilter,
  cardOption,
  permanentTargetOption,
  collectCardOptions,
  normalizeChoiceRequest,
  validateChoiceAnswer,
  defaultAnswerFor,
  isTrivialChoice,
  enumerateChoiceAnswers,
  describeChoiceAnswer,
  choiceOptionCount,
  cloneChoiceAnswer,
  MAX_CHOICES_PER_RESOLUTION,
  MAX_ENUMERATED_CHOICE_ANSWERS,
} from './choices.js';

// Mana payment planning — shared by the AI pilots and the hotseat/online auto-tap
// so "which lands do I tap" has exactly one implementation.
export type { ManaTapPlan, ManaPlanView } from './mana-plan.js';
export { planManaPayment, distanceToPayable } from './mana-plan.js';

// Engine
export type { DeckList, GameSetup, EngineResult, Engine } from './engine.js';
export {
  createGame,
  createEngine,
  applyAction,
  applyActionInPlace,
  generateLegalActions,
  choiceActionsFor,
  canAffordManaCost,
} from './engine.js';
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
  mergeKeywordGrant,
  hasKeyword,
  PLUS_ONE_COUNTER,
  MINUS_ONE_COUNTER,
  LOYALTY_COUNTER,
  loyaltyOf,
  DEFENSE_COUNTER,
  defenseOf,
} from './internal/stats.js';

// Combat's "what was this attacker declared attacking" accessor — the walker /
// attackable-permanent half of combat, shared with the AI and any UI.
export { attackedObjectOf } from './internal/combat.js';

// Debug / inspector seam
export type { SerializedState } from './serialize.js';
export { serializeState, dumpState } from './serialize.js';

