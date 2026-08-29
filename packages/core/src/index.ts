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
  usableMana,
  restrictedTotal,
} from './mana.js';

// SPEND RESTRICTIONS on produced mana ("Spend this mana only to cast a creature
// spell"). The POOL carries them, not the source — see spend-restriction.ts.
export type {
  ManaSpendClause,
  ManaSpendKind,
  ManaSpendPurpose,
  ManaSpendRestriction,
  RestrictedMana,
} from './spend-restriction.js';
export { restrictionAllows } from './spend-restriction.js';

// Card model seam
export type {
  ActivatedAbility,
  AdditionalCastCost,
  CyclingAbility,
  ActivationCost,
  EntersUntappedCondition,
  RevealFromHandCondition,
  EntersTappedContext,
  CardDefinition,
  CardType,
  CastTiming,
  EffectRef,
  KeywordFlags,
  BooleanKeywordName,
  BlockRestriction,
  ManaAbility,
  ManaAbilityCost,
  ManaAbilityRider,
  ManaActivationCondition,
  ManaModeExtra,
  DerivedManaColors,
  ModalSpec,
  SpellMode,
  AsEntersChoice,
  ChoiceBearingPermanent,
} from './card.js';
export {
  hasType,
  hasSubtype,
  permanentHasSubtype,
  isLand,
  isCreature,
  isPlaneswalker,
  isBattle,
  isAttackable,
  isPermanentType,
  isManaSource,
  manaModesOf,
  manaExtrasOf,
  spendPurposeFor,
  spendPurposeIfRestricted,
  manaColorsOffered,
  fixedManaColorsOf,
  manaActivationConditionMet,
  bestManaYield,
  castTiming,
  canRevealForUntapped,
  entersTapped,
  backFaceCastZonesOf,
  hasCastableBackFace,
  isSplitCard,
  playableFaceOf,
} from './card.js';

/**
 * Static ("anthem") seam: how a `CardDefinition` declares a continuous modification
 * to OTHER permanents that lasts exactly as long as it is on the battlefield.
 * Aggregated through the same `indexContinuous` path as until-end-of-turn effects,
 * so every consumer that already reads effective values gets statics for free.
 */
export type { PermanentModification, StaticAbility, StaticAffects, StaticControllerScope } from './statics.js';

/**
 * "As ~ enters, choose a…" (CR 614.1c) — the value a permanent NAMES as it
 * enters, remembered on the instance and read back by its own abilities and by
 * other cards' filters. See `as-enters.ts` for why the memory, not the prompt,
 * is the system.
 */
export {
  CHOOSABLE_COLORS,
  asEntersOptions,
  asEntersPrompt,
  chosenColorOf,
  chosenPlayerOf,
  chosenSubtypeOf,
  describeChosenValue,
  recordChosenAsEntered,
} from './as-enters.js';

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
 * PLAYER-facing statics — continuous abilities whose subject is a player or a
 * spell rather than a permanent, so the anthem machinery cannot carry them:
 * "You have no maximum hand size", "You may play lands from your graveyard",
 * "Spells you control can't be countered". Each derives its answer from the board
 * on every read, so its lifetime ends with its source and nothing has to expire.
 */
export { hasNoMaximumHandSize, landPlayZonesFor } from './player-statics.js';

/**
 * BLOCK REQUIREMENTS (CR 509.1c/d). `forcedBlockAssignment` is the seam an AI uses
 * so it never proposes a declaration the engine would refuse: it returns the
 * creatures whose block was not a free choice (or `undefined` when nothing on the
 * board requires anything), and the pilot assigns the rest as it likes.
 */
export type { BlockAssignment } from './internal/block-solver.js';
export { forcedBlockAssignment } from './internal/block-solver.js';
export type { UncounterableSpellsAbility } from './countering.js';
export { spellCanBeCountered } from './countering.js';

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
  unattachDependentsOf,
} from './attachments.js';

// Removal from combat (CR 506.4), for the one case an id-keyed combat cannot
// see by itself: a blink that returns the same instance id to the battlefield.
export {
  attackingCreatureIds,
  isRemovedFromCombat,
  removeFromCombat,
} from './combat-removal.js';

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
  castPermissionFor,
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
 * COPY-EFFECT seam (`./copy.ts`) -- CR 707, the bottom of the layer system.
 * "You may have ~ enter as a copy of any creature on the battlefield" is
 * declared as data (`CardDefinition.copyAsEnters`) and applied by swapping the
 * instance's `def` in LAYER 1, so counters (7d), anthems (7c) and until-EOT
 * pumps all apply on top of the copied characteristics with no second code
 * path. `copiableDefOf` is the single answer to "what would copying this give
 * you" (CR 707.2 -- the printed front face, never the pumped board state), and
 * `copyResultDef` is its pure preview, used by the AI to rank copy targets.
 */
export type { CopyAsEntersSpec, CopyExceptions, CopySourceZone } from './copy.js';
export {
  applyCopyAsEnters,
  applyCopyAsEntersAnswer,
  applyCopyExceptions,
  askCopyAsEnters,
  copiableDefOf,
  copyCandidates,
  copyResultDef,
  COPY_ID_SUFFIX,
  extraLoyaltyForCopy,
  isCopy,
  tokenCopyDefOf,
} from './copy.js';

/**
 * SPELL-COPY seam (`./spell-copy.ts`) -- CR 707.10, a stack object that is NOT
 * A CARD. `makeSpellCopy` builds the copy Reverberate and Fork put on the stack:
 * a fresh instance id, the original's copiable values, and every decision made
 * for the original (its targets, X, kicks and announced modes). It carries
 * `isSpellCopy`, which is what makes `spellLeaveDestination` answer
 * `'ceaseToExist'` (CR 704.5e) at BOTH exits from the stack, so a copy can never
 * leave a phantom card in a graveyard. The aim helpers are the other half:
 * "you may choose new targets for the copy" is an aiming moment inside a
 * RESOLUTION, and a modal copy re-aims each announced mode on its own.
 */
export {
  makeSpellCopy,
  spellCopyAimAt,
  spellCopyAimRestriction,
  spellCopyAimSlots,
  withSpellCopyAim,
  MODELESS_AIM_SLOT,
} from './spell-copy.js';

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
  TriggerWatches,
  PendingTrigger,
  TriggerSource,
  TriggerSubject,
} from './triggers.js';
export {
  DEFAULT_TRIGGER_WATCHES,
  conditionMatches,
  matchTriggers,
  orderPendingTriggers,
  triggeringPlayerFor,
} from './triggers.js';

// The printed intervening "if" (CR 603.4) — declared as trigger-condition DATA
// and evaluated by one shared reader at both of the moments the rules check it.
export type { InterveningIf } from './intervening.js';
export { interveningIfHolds } from './intervening.js';

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
  dropContinuousEffectsFor,
  expireContinuousEffects,
  NO_MOD,
} from './internal/continuous.js';

// Replacement + prevention effects (CR 614/615/616) — the ONE seam damage,
// counters and draws all consult. `replacement.ts` is the card-facing
// vocabulary (what a card DECLARES); `internal/replacement.ts` is the engine
// (what the layer DOES). A caller with a batch of damage to deal builds the
// index once and threads it, exactly as it does with `indexContinuous`.
export type {
  ReplacementAbility,
  ReplacementApplies,
  ReplacementEventKind,
  ReplacementOutcome,
} from './replacement.js';
export {
  REPLACEMENT_EVENT_KINDS,
  affectedPlayerPrefersMore,
  replacementIsInert,
  replacementsOf,
} from './replacement.js';
export type {
  ActiveReplacement,
  DamageReplacementResult,
  DrawReplacementResult,
  FloatingReplacement,
  ReplaceableEvent,
  ReplacementIndex,
} from './internal/replacement.js';
export {
  NO_REPLACEMENTS,
  ORDER_SEARCH_MAX_CANDIDATES,
  addFloatingReplacement,
  expireFloatingReplacements,
  hasAnyReplacement,
  indexReplacements,
  replaceTokenCount,
  projectDamage,
  replaceCounters,
  replaceDamage,
  replaceDraw,
  runReplacements,
} from './internal/replacement.js';

// Delayed triggered abilities (CR 603.7) — an ability created DURING a
// resolution that fires once at a named later moment. It lives on the STATE
// rather than on any object, which is how it outlives the source that made it.
export type { DelayedTriggeredAbility, DelayedTriggerRequest } from './delayed.js';
export {
  createDelayedTrigger,
  delayedRemovalTargets,
  matchDelayedTriggers,
  pendingFromDelayed,
  removeDelayedTrigger,
} from './delayed.js';

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
  MadnessWindow,
  SpellLeaveReason,
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

// Madness (CR 702.35): the discard replacement and the window it opens.
export { discardDestination, declineMadness } from './madness.js';

// CR 704.5d, exported because the cards package owns the OTHER
// leave-the-battlefield funnel (`movePermanentTo`) and both must apply it — a
// token that ceases to exist only when core's mover was used would depend on
// which primitive killed it.
export { ceaseToExistIfToken } from './internal/zones.js';

// Events
export type { GameEvent, EventLog } from './events.js';
export { createEventLog, eventsOfType } from './events.js';

/**
 * WHERE AN INSTANCE ID CAN HIDE — the enforced answer to "does this value name a
 * card?", which is the question the hidden-information guarantee is proved with
 * (`packages/sim/src/observation.ts`, `@jonny-boi/protocol`'s masking scan).
 * Exported because a guarantee whose checker lives inside one consumer is a
 * guarantee only that consumer has.
 */
export type { InstanceIdShape } from './instance-ids.js';
export {
  CHOICE_ANSWER_ID_FIELDS,
  EVENT_ID_FIELDS,
  INSTANCE_ID_FIELD_NAMES,
  instanceIdsNamedBy,
} from './instance-ids.js';

// Effect registry seam
export type {
  EffectContext,
  EffectContextBase,
  EffectPrimitive,
  EffectRegistry,
  ContinuousModRequest,
  ReplacementEffectRequest,
  DelayedTriggerArgs,
  TokenEntryOptions,
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
  LandPlayZone,
  CycleCardAction,
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
  ChoiceValueOption,
  ChosenValueSubject,
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
  ChooseValueRequest,
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
  ChooseValueChoice,
  SelectTargetsChoice,
  ChoiceAnswer,
  SelectCardsAnswer,
  SelectPlayersAnswer,
  ChooseModesAnswer,
  ConfirmAnswer,
  PayManaAnswer,
  PayLifeAnswer,
  ChooseNumberAnswer,
  ChooseValueAnswer,
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
  NOTHING_CHOSEN,
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
  drawCardForPlayer,
  applyActionInPlace,
  generateLegalActions,
  choiceActionsFor,
  canAffordManaCost,
  castManaCostFor,
  // CR 601.2h. Exported because a PILOT builds its cast actions itself rather
  // than picking one off the menu, so it needs the same reader the offer loop
  // and the cast path already use — three opinions about "can this be paid" is
  // exactly how a spell becomes offerable and un-castable.
  unpayableAdditionalCostReason,
} from './engine.js';
/**
 * Deep-copy the mutable parts of a state (card definitions stay shared). Paired
 * with `applyActionInPlace`: a look-ahead pilot clones once, then mutates freely.
 */
export { cloneState } from './internal/clone.js';
/**
 * Reset the transient, battlefield-only state on an instance that has just
 * CHANGED ZONES (CR 400.7 - it is a new object now): tapped, marked damage,
 * summoning sickness, counters, what it was attached to, whether its loyalty
 * ability has been used this turn, how many times its spell was kicked, the
 * value it named as it entered, and which face is up.
 *
 * Exported because there are TWO funnels that move a permanent off the
 * battlefield - core's own `moveToZone` and the cards package's
 * `movePermanentTo` - and a hand-copied second list DID drift: it cleared five
 * of the eight fields, so a bounced Aura came back still pointing at its old
 * host, a bounced planeswalker could not re-activate, and a bounced
 * "as ~ enters, choose a type" lord still lorded over the type it named last
 * time. One function, one answer.
 */
export { resetInstanceForNewZone } from './internal/zones.js';

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

/**
 * The state-based action pass, and the cheap gate the CR 704.3 priority boundary
 * asks before running it.
 *
 * Exported because a test that builds a position by hand — putting counters on a
 * permanent, setting a life total — is asking about a rule the GAME performs, and
 * the only honest way to observe it is to make the game perform it. The
 * alternative is a test that re-implements the rule and then agrees with itself.
 * Nothing outside core's own machinery should CALL the check to drive play: the
 * engine already runs it at every mutation site and at the priority boundary.
 */
export { checkStateBasedActions, stateBasedActionsPossible } from './internal/sba.js';
// The two game-deciding verbs, exported for the cards package's "you win/lose
// the game" primitives — ONE implementation, so an alt-win card and the SBA
// pass can never disagree about what winning means.
export { loseGame, winGame } from './internal/sba.js';

// Debug / inspector seam
export type { SerializedState } from './serialize.js';
export { serializeState, dumpState } from './serialize.js';

