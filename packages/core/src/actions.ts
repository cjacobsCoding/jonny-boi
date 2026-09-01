/**
 * Player ACTIONS — the seam the AI (§3.4) consumes. A legal-action generator
 * lists what the priority-holder may do; `applyAction` (engine.ts) executes one.
 * Actions are plain data and fully describe the choice (no hidden engine calls),
 * so an AI can enumerate, score, and pick one against a read-only view.
 */

import type { ChoiceAnswer } from './choices.js';
import type { InstanceId, PlayerId } from './state.js';

/** Pass priority. The single always-legal action when you hold priority. */
export interface PassPriorityAction {
  readonly kind: 'passPriority';
  readonly player: PlayerId;
}

/**
 * Which FACE of a double-faced card is being played.
 *
 * Only a card declaring `CardDefinition.backFaceCastable` (a MODAL DFC) accepts
 * `'back'`; a transforming DFC's back face is never castable (CR 712.8b) and a
 * `'back'` action naming one is rejected. Omitted means `'front'`, which keeps
 * every action built before modal DFCs existed valid unchanged.
 */
export type CastFace = 'front' | 'back';

/**
 * Where a land play may come from.
 *
 * It is {@link CastZone} plus exactly one value, and that is deliberate: a
 * consumer that already knows where a SPELL may be cast from learns nothing new
 * for `'hand'`, `'graveyard'` and `'exile'`. The extra value is `'libraryTop'`,
 * which has no cast equivalent because nothing is cast off the top of a library —
 * Courser of Kruphix plays the TOP CARD specifically rather than any card in the
 * library, and that one-card permission is a different thing from a zone.
 */
export type LandPlayZone = CastZone | 'libraryTop';

/** Play a land (sorcery-speed, one per turn, empty stack). */
export interface PlayLandAction {
  readonly kind: 'playLand';
  readonly player: PlayerId;
  readonly instanceId: InstanceId;
  /**
   * The face to play — `'back'` plays a modal DFC's land back face (Zendikar
   * Rising's spell//land MDFCs), which counts as the turn's land play exactly
   * like any other land.
   */
  readonly face?: CastFace;
  /**
   * Where the land is being played from. Omitted (the overwhelming default) means
   * the HAND, which is every land play in the game bar three:
   *   - `'exile'` — an ADVENTURER card whose primary half is a land ("Then exile
   *     this card. You may play the land later from exile"), validated by the same
   *     accessor the cast path uses so neither can be tricked into playing a card
   *     that was merely exiled;
   *   - `'graveyard'` — Crucible of Worlds / Ramunap Excavator;
   *   - `'libraryTop'` — Courser of Kruphix / Oracle of Mul Daya, which play the
   *     TOP CARD specifically rather than any card in the library.
   *
   * The last two must be unlocked by a permanent its controller controls declaring
   * `CardDefinition.playLandsFrom`, and the engine RE-DERIVES that permission from
   * the board at play time rather than trusting the action — so a hostile client
   * naming a zone nothing grants is rejected.
   *
   * Playing a land from anywhere is still a LAND PLAY (CR 305.1): it costs the
   * turn's land drop, needs an empty stack and a main phase, and is not a spell.
   * That is why this is a field on the land action rather than a second action kind
   * — every one of those rules would otherwise have a second implementation to keep
   * in step.
   */
  readonly fromZone?: LandPlayZone;
}

/** Tap a mana source for mana (adds to the controller's pool). */
export interface TapForManaAction {
  readonly kind: 'tapForMana';
  readonly player: PlayerId;
  readonly instanceId: InstanceId;
  /**
   * Which mana mode to activate, indexing the source's normalised mode list
   * (`manaModesOf`). A modal source — Birds of Paradise, a dual land — offers one
   * action per mode, so the *choice of color is part of the action* and an AI can
   * enumerate and score it. Omitted means {@link DEFAULT_MANA_MODE}, which is the
   * only mode a single-mode source has.
   */
  readonly mode?: number;
  /**
   * The permanent paying an ADDITIONAL cost that names another object —
   * "{T}, **Tap an untapped creature you control**: Add one mana of any
   * color" (Springleaf Drum), "{T}, **Sacrifice a creature**: Add {B}{B}"
   * (Phyrexian Tower).
   *
   * Part of the ACTION rather than a question asked while the ability
   * resolves, because a mana ability resolves immediately and may not park one
   * (CR 605.3a) — the same reason the colour MODE is part of the action. The
   * generator offers one action per legal payer, so a pilot enumerates and
   * scores "which creature do I tap" like any other choice.
   */
  readonly costInstanceId?: InstanceId;
}

/**
 * The mode a `tapForMana` action activates when it doesn't say. Single-mode
 * sources (every basic land) have only this one, so omitting `mode` stays the
 * natural way to tap a Forest.
 */
export const DEFAULT_MANA_MODE = 0;

/**
 * The zones a spell may be cast from. `'hand'` is the default everywhere it is
 * omitted; `'graveyard'` is a flashback cast (the card must declare
 * `CardDefinition.flashback`, whose cost is paid instead of the printed one);
 * `'exile'` is a MADNESS cast (`CardDefinition.madness`, legal only while that
 * card's madness window is open — see `state.ts`'s `MadnessWindow`).
 */
export type CastZone = 'hand' | 'graveyard' | 'exile';

/**
 * Cast a spell onto the stack. `targets` carries any chosen targets (instance
 * ids and/or players); empty when the spell needs none.
 *
 * `fromZone` names the SOURCE ZONE explicitly (omitted means `'hand'`), and the
 * engine threads it cast → stack → resolution — which is what makes flashback's
 * "exile instead of graveyard" fall out of tracked state rather than being a
 * special case at each exit from the stack.
 */
export interface CastSpellAction {
  readonly kind: 'castSpell';
  readonly player: PlayerId;
  readonly instanceId: InstanceId;
  readonly targets?: ReadonlyArray<InstanceId | PlayerId>;
  readonly fromZone?: CastZone;
  /**
   * The face to cast — `'back'` casts a modal DFC's second face, with THAT
   * face's cost, types, timing, targets and script. See {@link CastFace}.
   */
  readonly face?: CastFace;
}

/**
 * CYCLE a card from hand: pay its cycling cost, discard it, and put the cycling
 * ability on the stack (CR 702.29).
 *
 * Its own action kind rather than an `activateAbility` with a zone, because the
 * two share nothing an implementation could reuse: `activateAbility` starts by
 * finding a permanent on the battlefield and can pay in taps, sacrifices and
 * loyalty, none of which a card in hand has. `abilityIndex` indexes the card's
 * `CardDefinition.cycling` list exactly as `activateAbility` indexes
 * `activated`, so a card printing both cycling and landcycling offers one
 * action each and a pilot can score them separately. Omitted means the first.
 */
export interface CycleCardAction {
  readonly kind: 'cycleCard';
  readonly player: PlayerId;
  readonly instanceId: InstanceId;
  readonly abilityIndex?: number;
}

/**
 * Activate a permanent's non-mana activated ability, paying its cost.
 *
 * `abilityIndex` indexes the source's `CardDefinition.activated` list, so the
 * choice of WHICH ability is part of the action and an AI can enumerate and
 * score each one separately. `targets` carries any targets the ability's effects
 * need, chosen at activation exactly as a spell's are.
 */
export interface ActivateAbilityAction {
  readonly kind: 'activateAbility';
  readonly player: PlayerId;
  readonly instanceId: InstanceId;
  readonly abilityIndex: number;
  readonly targets?: ReadonlyArray<InstanceId | PlayerId>;
}

/**
 * Declare attackers (active player, declareAttackers step).
 *
 * `attackTargets` optionally names, per attacker, the ATTACKED OBJECT when it is
 * not the defending player: a planeswalker the defender controls (any permanent
 * for which core's `isAttackable` answers true — the seam battles will reuse).
 * An attacker with no entry attacks the defending player, so every existing
 * caller keeps meaning exactly what it always meant.
 */
export interface DeclareAttackersAction {
  readonly kind: 'declareAttackers';
  readonly player: PlayerId;
  readonly attackers: readonly InstanceId[];
  readonly attackTargets?: Readonly<Record<InstanceId, InstanceId | PlayerId>>;
}

/**
 * Declare blockers (defending player, declareBlockers step). Each entry assigns a
 * blocker to an attacker it legally blocks.
 */
export interface DeclareBlockersAction {
  readonly kind: 'declareBlockers';
  readonly player: PlayerId;
  readonly blocks: ReadonlyArray<{ readonly blocker: InstanceId; readonly attacker: InstanceId }>;
}

/**
 * Answer the question a resolving spell/ability parked in `GameState.pendingChoice`
 * (see choices.ts). It is an ordinary action deliberately: the sim's pilots, the
 * hotseat UI, and the online server all already know how to enumerate, choose, and
 * submit actions, so a question needs no separate transport, no callback, and no
 * change to any consumer's loop.
 *
 * `choiceId` must name the choice actually outstanding — a stale answer (a slow
 * client replying to a question that has already been resolved) is rejected rather
 * than misapplied to whatever is open now.
 */
export interface AnswerChoiceAction {
  readonly kind: 'answerChoice';
  /** Must equal `pendingChoice.chooser` — the engine enforces WHO answers. */
  readonly player: PlayerId;
  readonly choiceId: number;
  readonly answer: ChoiceAnswer;
}

/** The union of all player actions. */
export type GameAction =
  | PassPriorityAction
  | PlayLandAction
  | TapForManaAction
  | CastSpellAction
  | CycleCardAction
  | ActivateAbilityAction
  | DeclareAttackersAction
  | DeclareBlockersAction
  | AnswerChoiceAction;

/** A discriminator helper for exhaustiveness. */
export type ActionKind = GameAction['kind'];
