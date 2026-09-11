/**
 * THE CAST TRANSACTION — propose, answer, then commit or back out (§3.143,
 * UX-3/4/5 and the commit half of UX-7). Pure, DOM-free, React-free.
 *
 * Caleb, verbatim: *"until Ive actually chosen the targets, I should be able to
 * back out of the spell/ability as long as nothing has mutated game state yet…
 * Once you choose targets (or choose no targets) and confirm, at that point,
 * the decision should be irreversible and show up on the stack (unless rules
 * state otherwise)… I should still be able to idempotently change my mind…
 * and at that point, the item should not have entered the stack anyways."*
 *
 * ## Why this module exists, in one line
 *
 * The board today holds FIVE independent half-decided states — `pendingCast`,
 * `pendingAbility`, `manaPicker`, `handChoice`, `pendingManaTap` — each with its
 * own ad-hoc cancel, plus a sixth case (a cast-time question the ENGINE parked)
 * with no cancel at all. That is the CLASS. This is one funnel: one proposal,
 * one cancel, one commit (CLAUDE.md rule 12).
 *
 * ## Two tiers, measured before building (rule 11)
 *
 * Measured against the real `CARD_POOL` (5,651 cards, 5,112 nonland) with the
 * tier census this module's test re-derives the important half of:
 *
 *   - **Tier 1 — the answer rides the ACTION.** 697 spells and 414 activated
 *     abilities (on 396 cards) declare a target, and `castSpell.targets` /
 *     `activateAbility.targets` / `activateAbility.costInstanceIds` all travel
 *     WITH the action. Nothing mutates until the action is dispatched, so a
 *     cancel here is simply dropping the proposal — no rewind machinery at all.
 *   - **Tier 2 — the engine parks a question AFTER the object is on the stack
 *     and the cost is paid.** Exactly **177 cards, 3.5% of nonland**
 *     (additionalCost 54, modal 54, kicker 28, X 26, buyback 17; multikicker,
 *     entwine and flashbackAdditionalCost are 0 in today's pool). Only these
 *     need the snapshot.
 *
 * So the transaction is overwhelmingly about NOT DISPATCHING YET. The rewind is
 * the smaller half, and it is cheap (below).
 *
 * ## Snapshot, not replay — and the snapshot costs nothing
 *
 * `GameSession` is immutable (every mutator returns a new one) and
 * `applyAction` deep-clones before it mutates (`engine.ts` — `applyActionToDraft
 * (cloneState(prevState), …)`). The PREVIOUS session's state is therefore
 * provably never written to, so **retaining the prior session object IS the
 * snapshot**: zero cost, and byte-identical BY CONSTRUCTION rather than by
 * re-derivation — which is literally what UX-3 asks for. Replay
 * (`persist.rebuildFromRecord`) was rejected: it re-runs pool load + registry
 * build + two deck validations plus every action, and it grows with the game.
 *
 * ## The soundness invariant (scope §2.3), stated so it can be tested
 *
 * A rewind is honest while, for the WORKING session:
 *
 *   - **I1** no seat but the proposer is being asked anything;
 *   - **I2** nothing is mid-RESOLUTION (`state.resolution` — both seats have
 *     already passed priority by then, CR 608.2);
 *   - **I3** the announcement is provably unfinished: either nothing has been
 *     dispatched, or the proposed spell still carries `awaitingCastChoice` —
 *     the ENGINE's own marker that a cast is not finished (CR 601.2);
 *   - **I4** the game is not over (a life cost can kill the caster);
 *   - **I5** no event since the proposal opened is classified as having moved
 *     information (see {@link PROPOSAL_EVENT_POLICY});
 *   - **I6** — a CONSTRUCTION obligation on lane D, not something this module
 *     can check: `Proposal.working` must never reach `setSession`. `PlayView`
 *     drives the AI seat and the auto-passer off the committed session, and
 *     handing either a working session makes the opponent act inside the
 *     proposal. The only sessions this module hands back for `setSession` are
 *     on a `committed` or `cancelled` step; `ProposalView.boardSession` is for
 *     RENDERING only.
 *
 * When any of I1–I5 fails the proposal **seals**: `canCancel` goes false and
 * carries a reason and a player-facing sentence, so the UI EXPLAINS rather than
 * silently dropping the affordance. Never un-reveal something a player saw.
 *
 * ## "Unless rules state otherwise" — where the rules genuinely refuse
 *
 *   - **A resolving `mayEffects` gate** ("you may…" asked while an ability
 *     RESOLVES) is past priority: CR 608.2, not CR 601.2. There is no honest
 *     rewind, and `rewindVerdict` refuses with `'resolving'`. UX-7 is
 *     achievable exactly for the CAST-TIME optional costs (kicker, buyback,
 *     entwine, additionalCost, modes, X), which is where `awaitingCastChoice`
 *     is set and the announcement is provably unfinished.
 *   - **Once the spell is cast** (CR 601.2i — no `awaitingCastChoice` left) the
 *     announcement is over and it cannot be taken back: `'announcementOver'`.
 *   - **Un-tapping lands is not a rules problem.** CR 601.2g activates mana
 *     abilities as part of paying costs, i.e. INSIDE a cast that, once
 *     cancelled, never happened; CR 728 is the rules' own "return to the moment
 *     before the process started". The board's auto-tap is a client convenience
 *     that decomposes into those same legal actions, so rewinding it is more
 *     rules-correct than stranding the lands, not less.
 *   - **An ACTIVATED ability has no announcement window at all.** The engine
 *     parks no cast-time question for one (`applyActivateAbility` pushes the
 *     ability and hands priority straight back), so an activation commits the
 *     moment it is dispatched. Every reversible decision for the 414 targeting
 *     and 137 sacrifice-cost abilities is therefore pre-dispatch — which is
 *     fine, because that is where all of them live.
 */
import type {
  ChoiceAnswer,
  GameEvent,
  GameState,
  InstanceId,
  ManaCost,
  PendingChoice,
  PlayerId,
  SpellStackObject,
} from '@jonny-boi/core';
import { isPublicZone } from '@jonny-boi/ai';
import { PROPOSAL_CONFIG } from './play-config.js';
import type {
  AbilityCostChoice,
  AbilityOption,
  AbilityTargetChoice,
  CastOption,
  CycleOption,
  GameSession,
  SubmitResult,
} from './session.js';
import { optionToTarget, type TargetOption, type TargetRequirement } from './targeting.js';

// --- what the engine itself calls an unfinished announcement ----------------------

/**
 * The engine's own CLOSED set of caster-private cast-time questions (CR 601.2).
 *
 * DERIVED from `SpellStackObject`, never retyped: a kind added to core reaches
 * this module in the same edit, and a kind core drops stops the build here.
 */
export type CastChoiceKind = NonNullable<SpellStackObject['awaitingCastChoice']>;

/**
 * The cast-time question the spell `instanceId` is still waiting on, or
 * `undefined` when it is not on the stack or its announcement is finished.
 *
 * THE one accessor for "is this cast still being announced?", so no caller
 * indexes the stack itself and no second reading of `awaitingCastChoice` can
 * drift from this one (rule 12).
 */
export function castChoiceOnStack(state: GameState, instanceId: InstanceId): CastChoiceKind | undefined {
  for (const obj of state.stack) {
    if (obj.kind !== 'spell' || obj.instanceId !== instanceId) continue;
    return obj.awaitingCastChoice;
  }
  return undefined;
}

// --- what opened the proposal -----------------------------------------------------

/**
 * What is being proposed. Each arm carries the option the board already built,
 * so the proposal re-derives nothing the session has already answered (cost,
 * affordability, the target requirement, the legal payers).
 */
export type ProposalOpening =
  | { readonly kind: 'cast'; readonly option: CastOption }
  | { readonly kind: 'activate'; readonly option: AbilityOption }
  | { readonly kind: 'cycle'; readonly option: CycleOption };

/** The instance a proposal is about — the card being cast/cycled, or the ability's source. */
export function openingInstanceId(opening: ProposalOpening): InstanceId {
  return opening.option.instanceId;
}

/** The human name of what is being proposed (the card, or the ability's source). */
export function openingName(opening: ProposalOpening): string {
  return opening.kind === 'activate' ? opening.option.sourceName : opening.option.name;
}

// --- where a proposal is ----------------------------------------------------------

/**
 * How far a proposal has gone.
 *
 * - `'aiming'` — NOTHING has been dispatched. `working === committed`.
 * - `'funding'` — only `tapForMana` has been dispatched (the §3.60 mana picker:
 *   the player is choosing WHICH sources pay).
 * - `'announcing'` — the opening action went in and the engine parked a
 *   cast-time question; the object is on the stack but the announcement is not
 *   finished, so it can still be taken back.
 * - `'sealed'` — the rewind is off (see {@link rewindVerdict}). Answering
 *   through to the commit is the only move left.
 */
export type ProposalStage = 'aiming' | 'funding' | 'announcing' | 'sealed';

/**
 * WHICH session the board renders at each stage. A ROW per stage; adding a
 * stage is a row, and each row states why it is not the other answer.
 *
 * This corrects a tempting over-simplification ("the board always renders
 * `committed`"): the §3.60 mana picker ALREADY renders its working session on
 * purpose — `PlayBoard`'s own comment is *"the picker's uncommitted taps light
 * up the board, empty the pool readout, and feed the 'still needed' line
 * through exactly the same derivations a committed tap does — one code path,
 * not a preview that can disagree."* A player choosing which lands to tap has
 * to see them tap. Hiding that would regress a shipped feature to satisfy a
 * rule that was never about the proposer's own mana.
 */
export const BOARD_SESSION_BY_STAGE: Readonly<Record<ProposalStage, 'committed' | 'working'>> = Object.freeze({
  // Nothing has been dispatched; the two sessions are the same object anyway.
  aiming: 'committed',
  // §3.60: the player is picking sources and must see each one tap.
  funding: 'working',
  // Caleb: "at that point, the item should not have entered the stack anyways."
  // Showing the spell on the stack and then yanking it off on cancel is exactly
  // the lie UX-3 exists to remove.
  announcing: 'committed',
  // The rewind is gone. Continuing to hide the real board would be the lie the
  // honest refusal exists to avoid — the player must see what actually happened.
  sealed: 'working',
});

// --- the outstanding question -----------------------------------------------------

/** One choosable target, with the richer option attached when core enumerated it. */
export interface ProposalTargetChoice extends AbilityTargetChoice {
  /**
   * The full enumerated option — present for a CAST (core's `legalTargetsFor`
   * answers with kinds the board lights tiles from) and absent for an
   * ACTIVATION, whose legal targets arrive as bare ids on the engine's own
   * offers. Re-deriving them here would be a second answer to a question the
   * engine has already answered (rule 12).
   */
  readonly option?: TargetOption;
}

/** The one question the proposer is being asked right now. `null` ⇒ ready to confirm. */
export type ProposalQuestion =
  | {
      readonly kind: 'targets';
      readonly requirement: TargetRequirement;
      readonly candidates: readonly ProposalTargetChoice[];
      readonly chosen: readonly (InstanceId | PlayerId)[];
    }
  | {
      readonly kind: 'costPayers';
      readonly candidates: readonly AbilityCostChoice[];
      readonly chosen: readonly InstanceId[];
    }
  | {
      /**
       * Funding. The "still needed" readout is deliberately NOT computed here:
       * `mana-picker.ts` owns that question and warns that it is display-only
       * while core's `canPay` is the authority. Lane D feeds this `cost` and
       * `ProposalView.boardSession`'s pool to `manaStillNeeded` exactly as the
       * board does today (rule 12 — one answer to one question).
       */
      readonly kind: 'mana';
      readonly cost: ManaCost | undefined;
      readonly spent: readonly InstanceId[];
    }
  | {
      /**
       * Parked by the ENGINE, after the object is on the stack. `castChoice` is
       * read off `awaitingCastChoice`, never inferred from the prompt string.
       */
      readonly kind: 'engine';
      readonly choice: PendingChoice;
      readonly castChoice: CastChoiceKind;
    };

/**
 * Whether a question with exactly ONE legal answer is still put to the player.
 * A ROW per question kind; adding a kind is a row, and each row says why.
 */
const ASK_WHEN_ONLY_ONE_ANSWER: Readonly<Record<ProposalQuestion['kind'], boolean>> = Object.freeze({
  // Caleb asked for exactly this beat: "consider/inspect the potential targets,
  // then decide not to". A single legal target is still a target worth seeing
  // before committing, and skipping it removes the pause the proposal is for.
  targets: true,
  // The engine's own rule for a forced answer (`askNextCastChoice`: "a question
  // with a single legal answer is settled here instead of stopping the game to
  // collect the inevitable"). One legal sacrifice is not a decision.
  costPayers: false,
  // Funding is opened by the board's picker, never raised by a missing answer.
  mana: false,
  // The engine already settles its own trivial answers before parking one.
  engine: true,
});

// --- the soundness invariant ------------------------------------------------------

/** Why a rewind is refused. CLOSED: a reason outside this set is not a reason. */
export type RewindBlockedReason =
  /** I1 — `pendingChoice.chooser` is not the proposer. */
  | 'anotherSeatDecides'
  /** I3 — the spell is cast: no `awaitingCastChoice` is left (CR 601.2i). */
  | 'announcementOver'
  /** I2 — `state.resolution` is set: both seats already passed priority (CR 608.2). */
  | 'resolving'
  /** I5 — information moved, and a cancel cannot un-move it. */
  | 'revealed'
  /** I4 — the game ended inside the announcement (a life cost can kill). */
  | 'gameOver';

/**
 * ONE player-facing sentence per refusal — the UI must EXPLAIN, not merely grey
 * out (Caleb's whole complaint is about not understanding what is happening).
 * Modelled on core's `CHARACTERISTIC_SUPPORT.note`: the vocabulary lives with
 * the rule it belongs to, so a lane rendering it invents no copy of its own.
 */
export const REWIND_BLOCK_EXPLANATIONS: Readonly<Record<RewindBlockedReason, string>> = Object.freeze({
  anotherSeatDecides: 'Your opponent is being asked something — backing out now would take back their decision.',
  announcementOver: 'The spell is cast and on the stack. It can no longer be taken back.',
  resolving: 'This is being asked while the ability resolves, which is past the point of no return.',
  revealed: 'Cards have already been seen. Backing out cannot un-see them.',
  gameOver: 'The game has ended.',
});

/** The answer to "may this proposal still be taken back?". */
export type RewindVerdict =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: RewindBlockedReason;
      /** The player-facing sentence — {@link REWIND_BLOCK_EXPLANATIONS}. */
      readonly explanation: string;
      /** The specific fact behind it, for the log and the debug inspector. */
      readonly detail: string;
    };

/**
 * Everything the verdict reads, and nothing else. Small and constructible on
 * purpose: the guard test builds a VIOLATING case directly rather than trying
 * to coax today's engine into producing one — see the honest count in
 * {@link PROPOSAL_EVENT_POLICY}.
 */
export interface RewindContext {
  readonly proposer: PlayerId;
  /** Has the OPENING action (the cast/activate/cycle) been dispatched yet? */
  readonly dispatched: boolean;
  /** The card being cast/cycled, or the ability's source permanent. */
  readonly proposedId: InstanceId;
  /** The WORKING state — what would be discarded by a cancel. */
  readonly state: GameState;
  /** The worst class over every event since the proposal opened. */
  readonly eventVerdict: ProposalEventClass;
  /** The event that earned that class, for `detail`. */
  readonly because: GameEvent | null;
}

/** I1–I5, in the order a player would notice them. Pure and total. */
export function rewindVerdict(ctx: RewindContext): RewindVerdict {
  const blocked = (reason: RewindBlockedReason, detail: string): RewindVerdict => ({
    ok: false,
    reason,
    explanation: REWIND_BLOCK_EXPLANATIONS[reason],
    detail,
  });
  // I4 first: a finished game outranks every other reading of the state.
  if (ctx.state.gameOver) return blocked('gameOver', 'the game ended during the announcement');
  // I1 — someone else is deciding. `parkCastChoice` always names the caster, so
  // a choice belonging to anyone else means the announcement is already over.
  const choice = ctx.state.pendingChoice ?? null;
  if (choice && choice.chooser !== ctx.proposer) {
    return blocked('anotherSeatDecides', `${choice.chooser} is answering "${choice.prompt}"`);
  }
  // I2 — a resolution frame means both seats passed priority (CR 608.2).
  if (ctx.state.resolution != null) return blocked('resolving', 'a spell or ability is resolving');
  // I5 — information moved. Checked before I3 because a reveal is the honest
  // refusal a player most needs explained, and it can only be true after a
  // dispatch anyway.
  if (ctx.eventVerdict !== 'rewindable') {
    const what = ctx.because ? ctx.because.type : 'an event';
    return ctx.eventVerdict === 'handsOff'
      ? blocked('anotherSeatDecides', `${what} gave another seat a decision`)
      : blocked('revealed', `${what} moved information out of a hidden zone`);
  }
  // I3 — nothing dispatched is always rewindable; after a dispatch the ENGINE
  // must still say the announcement is unfinished.
  if (!ctx.dispatched) return { ok: true };
  if (castChoiceOnStack(ctx.state, ctx.proposedId) === undefined) {
    return blocked('announcementOver', 'the announcement is finished (CR 601.2i)');
  }
  return { ok: true };
}

// --- which events make a rewind a lie ---------------------------------------------

/**
 * What one event does to a rewind.
 *
 * - `'rewindable'` — discarding the working session restores the world exactly.
 * - `'revealed'` — information reached SOMEBODY (the proposer included) that a
 *   cancel cannot un-give. Cancelling would sell a free library peek.
 * - `'handsOff'` — a seat other than the proposer has made a decision.
 *
 * Structural facts ("we are past the announcement", "something is resolving")
 * are deliberately NOT in this vocabulary — {@link rewindVerdict} reads those
 * off the STATE (I1–I4). Two tables answering "are we still announcing?" would
 * be the exact fork rule 12 forbids.
 */
export type ProposalEventClass = 'rewindable' | 'revealed' | 'handsOff';

/** What a payload-conditional row needs to judge an event. */
export interface ProposalEventContext {
  readonly proposer: PlayerId;
  /** The proposed object's own moves are its own; they vanish with the session. */
  readonly proposedId: InstanceId;
}

export type ProposalEventPolicy<K extends GameEvent['type']> =
  | ProposalEventClass
  | ((event: Extract<GameEvent, { readonly type: K }>, ctx: ProposalEventContext) => ProposalEventClass);

/**
 * Every event the engine can emit, classified. A mapped type over
 * `GameEvent['type']`, so adding an event to `packages/core/src/events.ts`
 * fails `tsc` here until somebody says what it does to a rewind — the same
 * default-deny shape as `OBSERVATION_POLICY`, `RULES_MANIFEST` and
 * `KEYWORD_RULES`, and for the same reason.
 *
 * ⚠️ **This is NOT a second copy of `OBSERVATION_POLICY`.** That one answers
 * *"what may a SPECTATOR be told"*; this one answers *"can this proposal still
 * be taken back"*, and the two genuinely disagree in BOTH directions:
 *   - `spellCast` is `'public'` there and `'rewindable'` here, because during an
 *     announcement the board is still rendering the committed session (I6) and
 *     no spectator has been shown anything;
 *   - `cardsLookedAt` is `'public'` there (it carries only a COUNT — everybody
 *     at a real table sees you pick cards up and nobody sees which) and
 *     `'revealed'` here, because the PROPOSER now knows the top of their
 *     library and cancelling would let them keep that for free.
 *
 * ⚠️ **MEASURED, and reported as zero.** In today's engine none of the blocking
 * rows can fire between the opening dispatch and the last cast-time answer:
 * cascade and ripple push a TRIGGER at cast time and exile on RESOLUTION, which
 * is past priority and already refused by I2/I3. This table is therefore the
 * SECOND line of defence, not the first. It exists so the next card that
 * changes that fails a test instead of shipping a free library peek, and
 * `proposal.test.ts` feeds it a synthetic batch so the guard can actually go
 * red (§3.28: a claim nothing can falsify is this repo's most-recorded defect).
 */
export const PROPOSAL_EVENT_POLICY: { readonly [K in GameEvent['type']]: ProposalEventPolicy<K> } = {
  // --- information moved, and a cancel cannot un-move it --------------------
  // The seed is the whole game (`OBSERVATION_POLICY` says exactly that), so
  // anyone who saw this knows everything. Unreachable inside a proposal; the
  // classification is by meaning, not by reachability.
  gameStart: 'revealed',
  // The proposer saw a card off the top of their own library.
  drawCard: 'revealed',
  // A look carries only a count, but the LOOKER now knows the top of the deck.
  cardsLookedAt: 'revealed',
  // Milled cards come to rest face up in a public graveyard.
  cardsMilled: 'revealed',
  cardRevealed: 'revealed',
  // The pile was revealed on its way to the bottom of the library.
  pileBottomed: 'revealed',
  // Each of these exiles cards FACE UP out of a hidden zone to open its window.
  madnessWindowOpened: 'revealed',
  cascadeWindowOpened: 'revealed',
  rippleWindowOpened: 'revealed',
  // The suspend SPECIAL ACTION moves a card hand → exile face up; the window
  // opening later reveals nothing new, because the card has been face up for
  // turns. Two rows, two answers, because they are two different moments.
  cardSuspended: 'revealed',
  suspendWindowOpened: 'rewindable',
  // Foretell/plot exile FACE DOWN (that is the whole point), so nothing is
  // learned — but the card leaving a hidden hand for exile is still a public
  // fact about the count. `zoneChange` below judges the move itself.
  cardExiledToCastLater: 'rewindable',
  /*
   * THE ONE PAYLOAD-CONDITIONAL MOVE. The proposed object's own trip to the
   * stack is the proposal itself and vanishes with it. Any OTHER card coming to
   * rest somewhere public after leaving a hidden zone has been seen.
   */
  zoneChange: (e, ctx) =>
    e.instanceId === ctx.proposedId ? 'rewindable' : !isPublicZone(e.from) && isPublicZone(e.to) ? 'revealed' : 'rewindable',

  // --- another seat now has a decision --------------------------------------
  choiceAsked: (e, ctx) => (e.chooser === ctx.proposer ? 'rewindable' : 'handsOff'),
  choiceAnswered: (e, ctx) => (e.chooser === ctx.proposer ? 'rewindable' : 'handsOff'),
  choiceAutoAnswered: (e, ctx) => (e.chooser === ctx.proposer ? 'rewindable' : 'handsOff'),
  // The proposer never surrenders priority mid-announcement; anybody else
  // passing means the floor moved on without them.
  priorityPassed: (e, ctx) => (e.player === ctx.proposer ? 'rewindable' : 'handsOff'),
  // A choice the engine gave up on is still a choice somebody was holding.
  choiceAbandoned: 'handsOff',

  // --- everything else: discarding the working session restores it exactly ---
  // (Most of these cannot fire during an announcement at all; they are
  // classified by what a cancel would have to undo if they ever did.)
  turnBegin: 'rewindable',
  stepBegin: 'rewindable',
  untapped: 'rewindable',
  tapped: 'rewindable',
  landPlayed: 'rewindable',
  spellCast: 'rewindable',
  cardCycled: 'rewindable',
  triggerCopied: 'rewindable',
  madnessDeclined: 'rewindable',
  suspendDeclined: 'rewindable',
  stackResolved: 'rewindable',
  manaAdded: 'rewindable',
  manaCostPaid: 'rewindable',
  manaPoolEmptied: 'rewindable',
  abilityActivated: 'rewindable',
  effectUnsupported: 'rewindable',
  attackersDeclared: 'rewindable',
  blockersDeclared: 'rewindable',
  damageDealt: 'rewindable',
  damagePrevented: 'rewindable',
  counterPrevented: 'rewindable',
  replacementApplied: 'rewindable',
  replacementExpired: 'rewindable',
  lifeChanged: 'rewindable',
  gainLife: 'rewindable',
  poisonChanged: 'rewindable',
  creatureDied: 'rewindable',
  planeswalkerDied: 'rewindable',
  battleDefeated: 'rewindable',
  defenseChanged: 'rewindable',
  loyaltyChanged: 'rewindable',
  regenerated: 'rewindable',
  playerLost: 'rewindable',
  gameOver: 'rewindable',
  actionRejected: 'rewindable',
  counterAdded: 'rewindable',
  becameRenowned: 'rewindable',
  becameCopy: 'rewindable',
  spellCopied: 'rewindable',
  spellCopyCeasedToExist: 'rewindable',
  tokenCreated: 'rewindable',
  tokenCopyCreated: 'rewindable',
  tokenCeasedToExist: 'rewindable',
  emblemCreated: 'rewindable',
  transformed: 'rewindable',
  controlChanged: 'rewindable',
  permanentAttached: 'rewindable',
  permanentUnattached: 'rewindable',
  attachmentFailed: 'rewindable',
  attachmentPutIntoGraveyard: 'rewindable',
  continuousEffectAdded: 'rewindable',
  continuousEffectExpired: 'rewindable',
  cardGrantAdded: 'rewindable',
  cardGrantExpired: 'rewindable',
  delayedTriggerCreated: 'rewindable',
  delayedTriggerFired: 'rewindable',
  triggerPutOnStack: 'rewindable',
  triggerRemovedFromStack: 'rewindable',
  triggerFizzled: 'rewindable',
  triggerTargetsChosen: 'rewindable',
  triggerModesChosen: 'rewindable',
  triggeredAbilityResolved: 'rewindable',
  modesChosen: 'rewindable',
  modeTargetChosen: 'rewindable',
  chosenAsEnters: 'rewindable',
  legendRuleApplied: 'rewindable',
  effectApplied: 'rewindable',
};

/** Worst-first, so one lookup answers "is this batch still rewindable?". */
const CLASS_SEVERITY: Readonly<Record<ProposalEventClass, number>> = Object.freeze({
  rewindable: 0,
  revealed: 1,
  handsOff: 2,
});

/** The single verdict over a batch of freshly-produced events. */
export function classifyProposalEvents(
  events: readonly GameEvent[],
  ctx: ProposalEventContext,
): { readonly worst: ProposalEventClass; readonly because: GameEvent | null } {
  let worst: ProposalEventClass = 'rewindable';
  let because: GameEvent | null = null;
  for (const event of events) {
    // The mapped type guarantees a row per event type; the cast is the seam
    // between "a row for every K" and "a row for THIS event's K", which
    // TypeScript cannot narrow across a union-keyed lookup.
    const row = PROPOSAL_EVENT_POLICY[event.type] as ProposalEventPolicy<GameEvent['type']>;
    const verdict = typeof row === 'function' ? row(event, ctx) : row;
    if (CLASS_SEVERITY[verdict] <= CLASS_SEVERITY[worst]) continue;
    worst = verdict;
    because = event;
  }
  return { worst, because };
}

// --- the proposal -----------------------------------------------------------------

/** A live proposal. Immutable: every step returns a new one. */
export interface Proposal {
  /**
   * Monotonic, supplied by the caller. Rides every intent so a click on a stale
   * prompt is REFUSED rather than misapplied — the same guard `answerChoice`
   * gets from `choiceId`.
   */
  readonly id: number;
  readonly proposer: PlayerId;
  readonly opening: ProposalOpening;
  /**
   * THE REWIND TARGET, and the session the board renders while a cancel is
   * still honest. Byte-identical by CONSTRUCTION, not by re-derivation:
   * `applyAction` cloned before it mutated, so this object's state was never
   * written to.
   */
  readonly committed: GameSession;
  /**
   * The private fold. `=== committed` until the first dispatch.
   *
   * ⚠️ **I6** — never hand this to `setSession`. `PlayView` drives the AI seat
   * and the auto-passer off the session it is given; a working session there
   * makes the opponent act inside the proposal. Render
   * {@link ProposalView.boardSession}; commit through a `committed` step.
   */
  readonly working: GameSession;
  /** The card being cast/cycled, or the ability's source permanent. */
  readonly proposedId: InstanceId;
  readonly targets: readonly (InstanceId | PlayerId)[];
  /** The permanents chosen to pay a "Sacrifice a …" activation cost. */
  readonly costPayers: readonly InstanceId[];
  /**
   * Sources the PLAYER chose to tap through the §3.60 picker — not every source
   * the proposal taps. The auto-tap inside `castWithAutoTap` may still take more
   * on confirm; those are rewound with everything else, but they were not a
   * decision, so they are not recorded as one.
   */
  readonly spentManaSources: readonly InstanceId[];
  /** True once the opening action has gone to the engine. */
  readonly dispatched: boolean;
  readonly stage: ProposalStage;
  readonly rewind: RewindVerdict;
  /** Every event since the proposal opened — the batch I5 judges and the commit hands on. */
  readonly events: readonly GameEvent[];
}

/** What the player did. */
export type ProposalIntent =
  | { readonly kind: 'setTargets'; readonly targets: readonly (InstanceId | PlayerId)[] }
  | { readonly kind: 'setCostPayers'; readonly instanceIds: readonly InstanceId[] }
  | { readonly kind: 'tapSource'; readonly instanceId: InstanceId; readonly mode?: number }
  | { readonly kind: 'answer'; readonly answer: ChoiceAnswer }
  | { readonly kind: 'confirm' }
  | { readonly kind: 'cancel' };

/** What one step produced. */
export type ProposalStep =
  /** Still open; keep this proposal and render it. */
  | { readonly kind: 'open'; readonly proposal: Proposal }
  /**
   * DONE and irreversible. The caller does ONE `setSession(session)` — every
   * tap, the opening action and every answered cast-time question land in a
   * single React update, exactly as `confirmManaPicker` already does today.
   */
  | { readonly kind: 'committed'; readonly session: GameSession; readonly events: readonly GameEvent[] }
  /**
   * Backed out. `session` is `proposal.committed` BY REFERENCE, so a caller may
   * `setSession` it (React bails out on an identical reference) or simply drop
   * the proposal. Cancelling the same proposal again returns the same session
   * again — idempotent by purity (UX-4).
   */
  | { readonly kind: 'cancelled'; readonly session: GameSession }
  /** There was nothing to do. NOT an error: cancelling an absent proposal is a no-op. */
  | { readonly kind: 'noop' }
  /**
   * Nothing changed, and here is why — the engine refused the action, or the
   * rewind is no longer honest. The proposal (when there is one) survives
   * unchanged so the player can retry or finish.
   */
  | {
      readonly kind: 'refused';
      readonly proposal: Proposal | null;
      readonly reason: string;
      /** Set when the refusal was the soundness invariant rather than the engine. */
      readonly blocked: RewindBlockedReason | null;
    };

/** Why a second proposal is refused rather than guessed at (PROPOSAL_CONFIG.maxOpenProposals). */
const NESTED_PROPOSAL_REASON =
  'finish or cancel the current spell before starting another — a nested proposal has no single state to restore';

/**
 * Open a proposal. **Dispatches NOTHING**: `working === committed` on return,
 * which is the whole of UX-3's "zero game-state mutation is visible".
 *
 * `openCount` is how many proposals are already open, so the
 * `PROPOSAL_CONFIG.maxOpenProposals` cap is a config fact a test can assert
 * rather than a hidden `if`.
 */
export function openProposal(
  session: GameSession,
  opening: ProposalOpening,
  proposer: PlayerId,
  id: number,
  openCount = 0,
): ProposalStep {
  if (openCount >= PROPOSAL_CONFIG.maxOpenProposals) {
    return { kind: 'refused', proposal: null, reason: NESTED_PROPOSAL_REASON, blocked: null };
  }
  if (session.gameOver) {
    return { kind: 'refused', proposal: null, reason: 'the game is over', blocked: 'gameOver' };
  }
  if (session.priorityPlayer !== proposer) {
    return { kind: 'refused', proposal: null, reason: 'you do not have priority', blocked: null };
  }
  if (session.pendingChoice) {
    return {
      kind: 'refused',
      proposal: null,
      reason: 'answer the outstanding question first',
      blocked: null,
    };
  }
  return { kind: 'open', proposal: build(session, session, opening, proposer, id, [], [], [], false, []) };
}

/**
 * The ONE transition. Pure: the same proposal and the same intent always
 * produce the same step, which is what makes cancel idempotent for free.
 */
export function stepProposal(proposal: Proposal, intent: ProposalIntent): ProposalStep {
  switch (intent.kind) {
    case 'cancel':
      return cancelProposal(proposal);
    case 'setTargets':
      return { kind: 'open', proposal: withChoices(proposal, { targets: intent.targets }) };
    case 'setCostPayers':
      return { kind: 'open', proposal: withChoices(proposal, { costPayers: intent.instanceIds }) };
    case 'tapSource':
      return tapSource(proposal, intent.instanceId, intent.mode);
    case 'answer':
      return answer(proposal, intent.answer);
    case 'confirm':
      return confirm(proposal);
  }
}

/**
 * Back out. TOTAL and idempotent, which is exactly what Caleb asked for:
 * cancelling twice returns the same session object twice, and cancelling a
 * proposal that is already gone is a `noop`, not an error and not a second
 * rewind.
 */
export function cancelProposal(proposal: Proposal | null): ProposalStep {
  if (!proposal) return { kind: 'noop' };
  if (!proposal.rewind.ok) {
    return {
      kind: 'refused',
      proposal,
      reason: proposal.rewind.explanation,
      blocked: proposal.rewind.reason,
    };
  }
  // The rewind IS dropping the working session. `committed` was never written
  // to (the engine cloned before mutating), so this is byte-identical by
  // construction rather than by restoring field by field.
  return { kind: 'cancelled', session: proposal.committed };
}

// --- what the view reads ----------------------------------------------------------

/** Everything lane D needs to render a proposal, so it re-derives nothing. */
export interface ProposalView {
  readonly proposalId: number;
  readonly sourceInstanceId: InstanceId;
  readonly sourceName: string;
  readonly stage: ProposalStage;
  /** The one question outstanding, or null when Confirm is the only move left. */
  readonly question: ProposalQuestion | null;
  /** UX-4: true from ANY pre-commit step, repeatedly. UX-5: false once sealed. */
  readonly canCancel: boolean;
  /** Non-null exactly when `canCancel` is false — the HONEST REFUSAL's reason. */
  readonly cancelBlockedReason: RewindBlockedReason | null;
  /**
   * The sentence to show beside (or instead of) the Cancel control. A control
   * that merely vanishes reads as a bug; `PlayCard` already carries a reason
   * prop for exactly this.
   */
  readonly cancelBlockedExplanation: string | null;
  /** True when confirming is a legal move right now (no question outstanding). */
  readonly canConfirm: boolean;
  /**
   * THE SESSION THE BOARD RENDERS — chosen by {@link BOARD_SESSION_BY_STAGE}.
   *
   * ⚠️ Render it; never `setSession` it. See I6 on {@link Proposal.working}.
   */
  readonly boardSession: GameSession;
}

export function proposalView(proposal: Proposal): ProposalView {
  const question = outstandingQuestion(proposal);
  const blocked = proposal.rewind.ok ? null : proposal.rewind;
  return {
    proposalId: proposal.id,
    sourceInstanceId: proposal.proposedId,
    sourceName: openingName(proposal.opening),
    stage: proposal.stage,
    question,
    canCancel: proposal.rewind.ok,
    cancelBlockedReason: blocked ? blocked.reason : null,
    cancelBlockedExplanation: blocked ? blocked.explanation : null,
    canConfirm: question === null,
    boardSession:
      BOARD_SESSION_BY_STAGE[proposal.stage] === 'working' ? proposal.working : proposal.committed,
  };
}

/**
 * The one question outstanding, or null. Asked in ANNOUNCEMENT ORDER: the
 * engine's own parked question outranks everything (it is the only one with a
 * half-finished cast behind it), then the pre-dispatch answers in the order the
 * action needs them.
 */
export function outstandingQuestion(proposal: Proposal): ProposalQuestion | null {
  if (proposal.dispatched) {
    const castChoice = castChoiceOnStack(proposal.working.state, proposal.proposedId);
    const choice = proposal.working.pendingChoice;
    if (castChoice !== undefined && choice) return { kind: 'engine', choice, castChoice };
    return null;
  }
  const targets = targetQuestion(proposal);
  if (targets) return targets;
  const payers = costPayerQuestion(proposal);
  if (payers) return payers;
  return null;
}

// --- internals --------------------------------------------------------------------

/** Build a proposal and derive `stage`/`rewind` from one reading of the world. */
function build(
  committed: GameSession,
  working: GameSession,
  opening: ProposalOpening,
  proposer: PlayerId,
  id: number,
  targets: readonly (InstanceId | PlayerId)[],
  costPayers: readonly InstanceId[],
  spentManaSources: readonly InstanceId[],
  dispatched: boolean,
  events: readonly GameEvent[],
): Proposal {
  const proposedId = openingInstanceId(opening);
  const { worst, because } = classifyProposalEvents(events, { proposer, proposedId });
  const rewind = rewindVerdict({
    proposer,
    dispatched,
    proposedId,
    state: working.state,
    eventVerdict: worst,
    because,
  });
  // `stage` is DERIVED from `rewind`, never stored beside it — two fields
  // answering "is this still reversible?" would eventually answer differently.
  const positional: ProposalStage = dispatched
    ? 'announcing'
    : spentManaSources.length > 0
      ? 'funding'
      : 'aiming';
  return {
    id,
    proposer,
    opening,
    committed,
    working,
    proposedId,
    targets,
    costPayers,
    spentManaSources,
    dispatched,
    stage: rewind.ok ? positional : 'sealed',
    rewind,
    events,
  };
}

/** Re-derive a proposal with new pre-dispatch answers. */
function withChoices(
  proposal: Proposal,
  patch: {
    readonly targets?: readonly (InstanceId | PlayerId)[];
    readonly costPayers?: readonly InstanceId[];
  },
): Proposal {
  return build(
    proposal.committed,
    proposal.working,
    proposal.opening,
    proposal.proposer,
    proposal.id,
    patch.targets ?? proposal.targets,
    patch.costPayers ?? proposal.costPayers,
    proposal.spentManaSources,
    proposal.dispatched,
    proposal.events,
  );
}

/** Thread one `tapForMana` into the working session (the §3.60 picker's spend). */
function tapSource(proposal: Proposal, instanceId: InstanceId, mode?: number): ProposalStep {
  if (proposal.dispatched) {
    return {
      kind: 'refused',
      proposal,
      reason: 'the spell is already announced — its cost is paid',
      blocked: null,
    };
  }
  const result = proposal.working.tapForMana(instanceId, mode);
  if (result.rejected) {
    return { kind: 'refused', proposal, reason: result.rejected, blocked: null };
  }
  return {
    kind: 'open',
    proposal: build(
      proposal.committed,
      result.session,
      proposal.opening,
      proposal.proposer,
      proposal.id,
      proposal.targets,
      proposal.costPayers,
      [...proposal.spentManaSources, instanceId],
      false,
      [...proposal.events, ...result.events],
    ),
  };
}

/** Answer the engine's parked cast-time question, then see whether any remain. */
function answer(proposal: Proposal, choiceAnswer: ChoiceAnswer): ProposalStep {
  if (!proposal.dispatched) {
    return {
      kind: 'refused',
      proposal,
      reason: 'nothing has been announced yet, so the engine is not asking anything',
      blocked: null,
    };
  }
  return advance(proposal, proposal.working.answerChoice(choiceAnswer));
}

/**
 * Dispatch the opening action (or finish an announcement that is already under
 * way). Refused while a pre-dispatch question is outstanding, so the board can
 * never submit a cast whose targets the player has not chosen.
 */
function confirm(proposal: Proposal): ProposalStep {
  const question = outstandingQuestion(proposal);
  if (question !== null) {
    return {
      kind: 'refused',
      proposal,
      reason:
        question.kind === 'engine'
          ? 'answer the question on the spell first'
          : `choose ${question.kind === 'targets' ? 'targets' : 'what to sacrifice'} first`,
      blocked: null,
    };
  }
  // DEFENSIVE, and deliberately not reachable through this module: `advance`
  // already commits a dispatched proposal the moment its last question is
  // answered, so a live proposal with `dispatched` always has one outstanding.
  // The guard stays because the alternative — falling through — would dispatch
  // the opening action a SECOND time and cast the spell twice.
  if (proposal.dispatched) {
    return { kind: 'committed', session: proposal.working, events: proposal.events };
  }
  return advance(proposal, dispatchOpening(proposal));
}

/** Submit the proposal's opening action against the working session. */
function dispatchOpening(proposal: Proposal): SubmitResult {
  const working = proposal.working;
  const opening = proposal.opening;
  switch (opening.kind) {
    case 'cast':
      // `castWithAutoTap` taps only what the pool still owes — in `funding` the
      // picker has already paid, so it taps nothing and just casts — and it
      // rolls back its own taps if the engine refuses, which keeps a refused
      // confirm from stranding lands inside the proposal.
      return working.castWithAutoTap(
        opening.option.instanceId,
        proposal.targets,
        opening.option.fromZone ?? 'hand',
        opening.option.face,
      );
    case 'activate': {
      const payers = chosenPayers(proposal);
      return opening.option.affordableWithTap
        ? working.activateWithAutoTap(
            opening.option.instanceId,
            opening.option.abilityIndex,
            proposal.targets,
            payers,
          )
        : working.activateAbility(
            opening.option.instanceId,
            opening.option.abilityIndex,
            proposal.targets,
            payers,
          );
    }
    case 'cycle':
      return working.cycleWithAutoTap(opening.option.instanceId, opening.option.abilityIndex);
  }
}

/**
 * Fold one submit into the proposal: refuse cleanly on rejection, otherwise
 * re-derive and decide whether the announcement is finished.
 */
function advance(proposal: Proposal, result: SubmitResult): ProposalStep {
  if (result.rejected) {
    return { kind: 'refused', proposal, reason: result.rejected, blocked: null };
  }
  const events = [...proposal.events, ...result.events];
  const next = build(
    proposal.committed,
    result.session,
    proposal.opening,
    proposal.proposer,
    proposal.id,
    proposal.targets,
    proposal.costPayers,
    proposal.spentManaSources,
    true,
    events,
  );
  // The ENGINE decides when the announcement is over: no `awaitingCastChoice`
  // means the object is cast (CR 601.2i) and there is nothing left to ask.
  // An ACTIVATED ability never parks one, so an activation commits here.
  return outstandingQuestion(next) === null
    ? { kind: 'committed', session: next.working, events }
    : { kind: 'open', proposal: next };
}

/** The payer set to submit: the player's pick, or the only legal one. */
function chosenPayers(proposal: Proposal): readonly InstanceId[] {
  if (proposal.costPayers.length > 0) return proposal.costPayers;
  const candidates = payerCandidates(proposal);
  // Exactly one legal answer is not a decision (`ASK_WHEN_ONLY_ONE_ANSWER`).
  return candidates.length === 1 ? (candidates[0] as AbilityCostChoice).instanceIds : [];
}

/** The legal sacrifice-cost payer sets the ENGINE offered, or none. */
function payerCandidates(proposal: Proposal): readonly AbilityCostChoice[] {
  return proposal.opening.kind === 'activate' ? (proposal.opening.option.costPayers ?? []) : [];
}

/** The outstanding TARGETS question, or null when the aim is settled. */
function targetQuestion(proposal: Proposal): ProposalQuestion | null {
  const candidates = targetCandidates(proposal);
  const required = requiredTargetCount(proposal);
  if (required === 0) return null;
  if (proposal.targets.length >= required) return null;
  if (candidates.length === 0) {
    // Nothing legal to aim at. The engine will refuse the cast with its own
    // words; offering an empty menu would be a dead end, so Confirm is allowed
    // through and the refusal surfaces honestly (rule 6 — a clear signal, never
    // a silent crash).
    return null;
  }
  if (candidates.length === 1 && !ASK_WHEN_ONLY_ONE_ANSWER.targets) return null;
  return {
    kind: 'targets',
    requirement: targetRequirementOf(proposal),
    candidates,
    chosen: proposal.targets,
  };
}

/** The outstanding COST-PAYER question, or null. */
function costPayerQuestion(proposal: Proposal): ProposalQuestion | null {
  const candidates = payerCandidates(proposal);
  if (candidates.length === 0) return null;
  if (proposal.costPayers.length > 0) return null;
  if (candidates.length === 1 && !ASK_WHEN_ONLY_ONE_ANSWER.costPayers) return null;
  return { kind: 'costPayers', candidates, chosen: proposal.costPayers };
}

/** How many targets the opening action must carry. */
function requiredTargetCount(proposal: Proposal): number {
  const opening = proposal.opening;
  switch (opening.kind) {
    case 'cast':
      return opening.option.needsTarget ? opening.option.requirement.count : 0;
    // The engine offers an activation once per LEGAL TARGET and the action
    // carries exactly that one, so a targeting ability needs exactly one.
    case 'activate':
      return opening.option.targets === null ? 0 : 1;
    case 'cycle':
      return 0;
  }
}

/** The requirement behind the targets question (an ability's is a single aim). */
function targetRequirementOf(proposal: Proposal): TargetRequirement {
  return proposal.opening.kind === 'cast'
    ? proposal.opening.option.requirement
    : { count: requiredTargetCount(proposal), kind: 'any' };
}

/**
 * The legal targets to choose from.
 *
 * For a CAST they come from `session.castTargets`, which asks core's own
 * enumerator with the caster and the card — the set the engine will accept and
 * nothing wider (bug report 20260901_211035). For an ACTIVATION they are the
 * ids the engine already offered; re-enumerating them would be a second answer.
 */
function targetCandidates(proposal: Proposal): readonly ProposalTargetChoice[] {
  const opening = proposal.opening;
  if (opening.kind === 'cast') {
    return proposal.working.castTargets(opening.option).map((option) => ({
      target: optionToTarget(option),
      label: option.name,
      option,
    }));
  }
  if (opening.kind === 'activate') return opening.option.targets ?? [];
  return [];
}
