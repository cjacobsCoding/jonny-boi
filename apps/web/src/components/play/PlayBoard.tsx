import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactElement } from 'react';
import { createRng, opponentOf } from '@jonny-boi/core';
import { createDefaultAiRegistry, DEFAULT_PILOT_ID } from '@jonny-boi/ai';
import type {
  CardDefinition,
  CharacteristicExplanation,
  ChoiceAnswer,
  GameState,
  InstanceId,
  ManaCost,
  PlayerId,
} from '@jonny-boi/core';
import type {
  AbilityCostChoice,
  AbilityOption,
  GameSession,
  CastOption,
  CycleOption,
  SubmitResult,
} from '../../lib/play/session.js';
import { buildBoardView, explainForFace } from '../../lib/play/view-model.js';
/**
 * §3.143 / UX-3..UX-5 + the commit half of UX-7 — THE CAST TRANSACTION.
 *
 * ⚠️ ADOPTION, NOT DECORATION. `lib/play/proposal.ts` shipped in wave 1 with
 * 1,111 tested lines and **no importer at all**, which is why 137
 * sacrifice-cost abilities stayed dead buttons and why cancelling a cast still
 * had no single funnel. Every cast, activation and cycling ability on this
 * board now opens a proposal and commits or cancels through it;
 * `proposal-adoption.test.ts` fails if that stops being true.
 */
import {
  cancelProposal,
  openProposal,
  proposalView,
  stepProposal,
  type Proposal,
  type ProposalOpening,
  type ProposalStep,
} from '../../lib/play/proposal.js';
import { isBoardTargetOption, optionToTarget, type TargetOption } from '../../lib/play/targeting.js';
import {
  stepLabel,
  TOAST_MS,
  COPILOT_ADVICE_SEED,
  BOARD_3D_CONFIG,
  COMBAT_ADVANCE_CONFIG,
  PROPOSAL_CONFIG,
  SPELL_HOLD_CONFIG,
  TAP_ROTATION_CONFIG,
} from '../../lib/play/play-config.js';
import { SeatPanel, type PermInteraction } from './SeatPanel.js';
import { StackPanel } from './StackPanel.js';
import { GameLog } from './GameLog.js';
import { PlayCard, CardBack } from './PlayCard.js';
import { DRAG_ID_ATTR, useDragToPlay } from '../../lib/play/useDragToPlay.js';
import { CardZoomOverlay } from './CardZoomOverlay.js';
import { ChoicePrompt } from './ChoicePrompt.js';
import { GraveyardPanel } from './GraveyardPanel.js';
import { AbilityMenuPrompt, AbilityTargetPrompt } from './AbilityPrompts.js';
import { graveyardPanelView } from '../../lib/play/graveyard-cast.js';
import { isChoiceForViewer, waitingForChoiceText } from '../../lib/play/choice-view.js';
import { isModalTap, manaTapMenu, tappableIds, type ManaTapOption } from '../../lib/play/mana-tap.js';
import {
  manaPickerRows,
  manaStillNeeded,
  stillNeededText,
  type ManaPickerSource,
} from '../../lib/play/mana-picker.js';
import {
  loadManaChoicePref,
  saveManaChoicePref,
  shouldAskForMana,
} from '../../lib/play/mana-choice-pref.js';
import { actionBarHint, passButtonLabel, type StackHintContext } from '../../lib/play/action-hints.js';
import { withStepStop, type PriorityStops } from '../../lib/play/priority-stops.js';
import { CardHover } from '../CardHover.js';
import { RevealBanner } from './RevealBanner.js';
import { latestReveal } from '../../lib/play/reveals.js';
import {
  consumeDeferredMay,
  EMPTY_MAY_LEDGER,
  expireDeferredMay,
  matchDeferredMay,
  recordDeferredMay,
  type DeferredMayLedger,
} from '../../lib/play/optional-trigger.js';
import { StopsMenu } from './StopsMenu.js';
import './board-clarity.css';
import './board-scene.css';
import { combatArcPairs } from '../../lib/play/combat-lines.js';
import { CombatStage, type StageEntry } from './CombatStage.js';
import { NO_STAGED_PERMANENTS, StagedPermanentsContext } from './combat-stage-context.js';
import { STAGED_HOME_TILE_OPACITY } from '../../lib/play/combat-stage.js';
import { CardFace } from './CardFace.js';
import { HOLD_KINDS, type SpellHold } from '../../lib/play/spell-hold.js';
import { groupJailedByJailer, jailSourcesOf } from '../../lib/play/jail-view.js';
import { describeCastTarget, makeRefIndex, type KnownRef } from '../../lib/play/option-labels.js';
import type { AnimationCardInfo } from '../../lib/play/animations.js';
import {
  AnimationLayer,
  DamageLayer,
  useDamageSequence,
  usePrefersReducedMotion,
  useZoneAnimations,
} from './AnimationLayer.js';
import { VfxLayer, useGameVfx } from './VfxLayer.js';
import { OpponentActionFeed, useOpponentFeed } from './OpponentActionFeed.js';
import { CombatLines } from './CombatLines.js';
import { SoundEngine } from '../../lib/play/sound-engine.js';
import { useGameSounds } from '../../lib/play/useGameSounds.js';
import { loadSoundPrefs, saveSoundPrefs, type SoundPrefs } from '../../lib/play/sound-prefs.js';
import './action-bar.css';
import './mana-picker.css';
import './board-fit.css';
import './game-fx.css';
import {
  loadCopilotPref,
  saveCopilotPref,
  suggestMove,
  suggestionTarget,
  suggestionText,
} from '../../lib/play/copilot.js';
import './copilot.css';

/**
 * A cast option's identity — instance, zone AND face, because one instance can
 * offer several casts (a split card's two halves; a card castable from hand and
 * from the graveyard) and they are funded independently. The same three facts
 * `CastOption` itself is keyed on inside the session.
 */
function castOptionKey(option: CastOption): string {
  return `${option.instanceId}:${option.fromZone ?? 'hand'}:${option.face ?? 'front'}`;
}

/** A shared empty cost, so the no-picker render allocates nothing per frame. */
const EMPTY_COST: ManaCost = Object.freeze({});

/**
 * The first of a hand card's cast options that has a genuine choice of funding
 * sources, or undefined. A split card offers two casts of one instance and they
 * are funded independently, so the chip has to name WHICH one it is offering.
 */
function manaChoiceCast(
  casts: readonly CastOption[],
  withChoice: ReadonlySet<string>,
): CastOption | undefined {
  return casts.find((option) => withChoice.has(castOptionKey(option)));
}

/**
 * The in-game board for the player who currently holds priority (the `viewer`). It
 * renders their masked board view (own hand face-up, opponent's hidden), the stack,
 * the log, and an action bar wired to the `GameSession`. Every interactive control
 * is derived from the session's legal actions, so an illegal move can't be offered;
 * a rejected action surfaces a toast and never corrupts state.
 *
 * Transient interaction state (a pending cast's target choice, attacker/blocker
 * selection) lives here as local UI state; committing always goes through `submit`,
 * which threads a brand-new session up to the PlayView.
 */
export function PlayBoard({
  session: committedSession,
  viewer,
  onSubmit,
  onConcede,
  stops,
  onStops,
  hold,
  onHoldPointer,
  onHoldExtend,
  onHoldRelease,
}: {
  session: GameSession;
  viewer: PlayerId;
  /** Apply a session-producing action; PlayView stores the new session. */
  onSubmit: (run: () => SubmitResult) => void;
  onConcede: () => void;
  /**
   * §3.143 / UX-16 — the opponent's spell currently HELD on screen, or null.
   *
   * Owned by PlayView, not here, because the hold's whole job is to stop the
   * auto-advance effect and the AI-seat effect, and both of those live there.
   * The board only renders it and reports the player's attention back up: one
   * value, so the pause and the walker cannot disagree about whether the game
   * is moving — the same rule §3.119 set for the priority stops.
   */
  hold?: SpellHold | null;
  /** The pointer moved onto / off the held card (it extends the hold). */
  onHoldPointer?: (over: boolean) => void;
  /** "Keep looking" — one explicit `extendMs`. */
  onHoldExtend?: () => void;
  /** "Let it resolve" — end the hold now. */
  onHoldRelease?: () => void;
  /**
   * §3.119 — the priority stops, OWNED BY PlayView because it is the auto-pass
   * effect that has to obey them. The board renders their controls and reports
   * changes; it never keeps its own copy, or the bar and the walker could
   * disagree about where the game stops.
   */
  stops: PriorityStops;
  onStops: (next: PriorityStops) => void;
}): ReactElement {
  /**
   * THE LIVE PROPOSAL — a cast, an activation or a cycling ability that has been
   * started and not yet committed (§3.143 / UX-3..UX-5). It owns the rewind
   * target, the working fold, the outstanding question and the honest refusal;
   * this component only renders it and hands intents back.
   */
  const [proposal, setProposal] = useState<Proposal | null>(null);
  /**
   * The sources that were tappable when the §3.60 mana picker opened,
   * snapshotted so rows stay put as they are spent (see `manaPickerRows`).
   *
   * Non-null IS "the picker is open": a proposal only reaches stage `funding`
   * after the FIRST tap, and the picker has to be on screen before that.
   */
  const [fundingSources, setFundingSources] = useState<readonly ManaPickerSource[] | null>(null);
  /** The ⛁ chip opened this cast — remembered across its target question. */
  const [castRequestedMana, setCastRequestedMana] = useState(false);
  /**
   * Monotonic proposal id (`Proposal.id`). A ref, not state: it must advance
   * exactly once per opening and must never itself cause a render.
   */
  const proposalSeq = useRef(0);

  /**
   * Everything the view needs about the proposal, derived ONCE per proposal
   * object (it is immutable, so the memo can never serve a stale question).
   */
  const proposalPreview = useMemo(() => (proposal ? proposalView(proposal) : null), [proposal]);

  /**
   * THE BOARD'S SOURCE OF TRUTH — chosen by the proposal's own
   * `BOARD_SESSION_BY_STAGE` row (read through `ProposalView.boardSession`), so
   * "which session does the board render?" has exactly one answer.
   *
   * That row is why the §3.60 picker's uncommitted taps still light up the
   * board, empty the pool readout and feed the "still needed" line through
   * exactly the same derivations a committed tap does (stage `funding` →
   * `working`), while a half-announced spell is NOT shown on the stack
   * (stage `announcing` → `committed`, because Caleb asked for exactly that:
   * *"at that point, the item should not have entered the stack anyways"*).
   */
  const session = proposalPreview ? proposalPreview.boardSession : committedSession;
  const names = session.names;
  const view = useMemo(() => buildBoardView(session.state, viewer, names), [session, viewer, names]);
  const step = session.state.step;

  // --- transient interaction state ---------------------------------------------
  // Attacker selection (active player, declareAttackers).
  const [chosenAttackers, setChosenAttackers] = useState<Set<InstanceId>>(new Set());
  // Per-attacker walker assignment: attacker -> the defending planeswalker it
  // attacks. An attacker with no entry attacks the defending player (the default).
  const [walkerAssign, setWalkerAssign] = useState<Map<InstanceId, InstanceId>>(new Map());
  // A permanent whose activated-ability menu is open (click a walker → its abilities).
  const [abilitySource, setAbilitySource] = useState<InstanceId | null>(null);
  // Blocker assignment (defender, declareBlockers): blocker -> attacker.
  const [blockAssign, setBlockAssign] = useState<Map<InstanceId, InstanceId>>(new Map());
  // The attacker currently being assigned a blocker (click attacker, then blocker).
  const [activeBlockTarget, setActiveBlockTarget] = useState<InstanceId | null>(null);
  // A modal mana source the player tapped, awaiting the colour they want.
  const [pendingManaTap, setPendingManaTap] = useState<readonly ManaTapOption[] | null>(null);
  // The viewer's graveyard panel (the flashback affordance's entry point).
  const [graveyardOpen, setGraveyardOpen] = useState(false);
  // A hand card the player clicked that can be played in more than one way (a
  // cycling land is both a land drop and a cycling ability), awaiting the pick.
  const [handChoice, setHandChoice] = useState<InstanceId | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  /** "Always let me choose my mana" — the persisted §3.60 preference. */
  const [alwaysChooseMana, setAlwaysChooseMana] = useState<boolean>(loadManaChoicePref);

  /**
   * §3.130 — the procedural game audio. ONE engine per board (a ref, so a
   * rematch keeps its gesture-unlocked AudioContext), driven by the session's
   * event log through `useGameSounds`. The preference outlives the game like the
   * mana and co-pilot ones; toggling it is a user gesture, which is also what
   * unlocks the browser's audio.
   */
  const [soundPrefs, setSoundPrefs] = useState<SoundPrefs>(loadSoundPrefs);
  // Created once (a lazy state initializer, never re-set) so a rematch keeps its
  // gesture-unlocked AudioContext; from here it is only fed and configured.
  const [soundEngine] = useState(() => new SoundEngine(soundPrefs.enabled, soundPrefs.volume));
  useEffect(() => {
    soundEngine.setEnabled(soundPrefs.enabled);
    soundEngine.setVolume(soundPrefs.volume);
  }, [soundEngine, soundPrefs]);
  useEffect(() => () => soundEngine.dispose(), [soundEngine]);
  useGameSounds(session.events, viewer, soundEngine, !soundPrefs.enabled);
  const onToggleSound = useCallback((): void => {
    setSoundPrefs((prev) => {
      const next = { ...prev, enabled: !prev.enabled };
      saveSoundPrefs(next);
      return next;
    });
    // The click IS the user gesture the autoplay policy wants — unlock now.
    void soundEngine.resume();
  }, [soundEngine]);
  /**
   * §3.119 — WHERE THE GAME STOPS. The persisted per-step stops, read once and
   * written on every change. The board does not auto-advance itself (PlayView
   * owns that effect), so these are handed UP through `onStops` — the rule and
   * the walker must read one value, or the bar would promise a stop the walker
   * passes through.
   */
  const [stopsMenuOpen, setStopsMenuOpen] = useState(false);
  /** A reveal the player has dismissed, by its index in the event log. */
  const [dismissedReveal, setDismissedReveal] = useState<number | null>(null);

  /**
   * §3.67 — AI CO-PILOT. Off by default; the preference outlives the game.
   *
   * The suggestion is DERIVED from the session rather than stored, so it can
   * never be stale: every committed change re-runs it, which is exactly the
   * "once you make a move it recalculates" the feature promises. The pilot is
   * asked from a fresh seeded stream per call so the advice for a given board is
   * the same every time it is shown — advice that flickered between renders
   * would be impossible to act on.
   */
  const [copilotOn, setCopilotOn] = useState<boolean>(loadCopilotPref);
  const copilotPilot = useMemo(() => createDefaultAiRegistry().getPilot(DEFAULT_PILOT_ID) ?? null, []);
  const suggestion = useMemo(() => {
    if (!copilotOn || !copilotPilot) return null;
    try {
      return suggestMove(session, viewer, copilotPilot, createRng(COPILOT_ADVICE_SEED));
    } catch {
      // Advice is a convenience: a pilot that throws must not take the game
      // down with it, and the board simply shows no hint this frame.
      return null;
    }
  }, [copilotOn, copilotPilot, session, viewer]);
  const suggestionHint = suggestion ? suggestionText(suggestion, (id) => session.nameOf(id as never)) : null;
  const suggestedCard =
    suggestion && suggestionTarget(suggestion.action).kind === 'card'
      ? (suggestionTarget(suggestion.action) as { instanceId: number }).instanceId
      : null;
  const suggestBar = suggestion !== null && suggestedCard === null;

  /**
   * THE ONE CANCEL (§3.143 / UX-4), **PROPOSAL SCOPE**. Clears every
   * half-decided pre-commit state the board holds *about the thing being cast or
   * activated*, and dispatches nothing at all — which is what makes it
   * idempotent and free: a dropped `proposal` carries its own working session
   * (and its own action-log entries, §3.58) away with it, so a cancelled cast
   * leaves no trace, and every other state here is a local choice the engine has
   * never been told about.
   *
   * ⚠️ **IT MUST NOT TOUCH THE COMBAT DRAFT.** It used to, and that was a live
   * defect: pressing Escape to back out of an instant during declare-blockers
   * threw away every block the player had drafted. UX-4's acceptance line is
   * "returns to the pre-proposal board WITH NO SIDE EFFECTS", and destroying a
   * combat draft is the most expensive side effect on this surface. The draft is
   * {@link clearCombatDraft}'s, and the two scopes are disjoint — which is what
   * `cancel-funnel.test.ts` now asserts, because a regex over `pending…` names
   * could never see the four combat setters that were hiding in here.
   *
   * ⚠️ ADD YOUR NEW PRE-COMMIT STATE HERE, and to `preCommitOpen`. The shape
   * this replaces is "five independent half-decided states, each with its own
   * ad-hoc cancel" — a sixth with a seventh cancel is how it comes back.
   */
  const resetProposal = (): void => {
    setProposal(null);
    setFundingSources(null);
    setCastRequestedMana(false);
    setPendingManaTap(null);
    setAbilitySource(null);
    setHandChoice(null);
  };

  /**
   * THE COMBAT DRAFT scope — attackers and blockers the player has clicked but
   * not yet declared. Cleared by the two actions that CONSUME it, and by leaving
   * the declare step it belongs to (the effect below). By nothing else: a cast,
   * a land tap or a cancel in the middle of drafting blocks must leave the draft
   * exactly where it was.
   */
  const clearCombatDraft = (): void => {
    setChosenAttackers(new Set());
    setWalkerAssign(new Map());
    setBlockAssign(new Map());
    setActiveBlockTarget(null);
  };

  /**
   * A combat draft belongs to ONE declare step, so LEAVING that step is what
   * makes it stale — nothing else is. Clearing it here instead of inside every
   * commit path is what lets an instant cast mid-draft (or a cancelled one)
   * leave the draft alone. The updaters return the current value unchanged when
   * there is nothing to clear, so React bails out and this costs an idle board
   * no render at all.
   */
  useEffect(() => {
    if (step !== 'declareAttackers') {
      setChosenAttackers((cur) => (cur.size === 0 ? cur : new Set()));
      setWalkerAssign((cur) => (cur.size === 0 ? cur : new Map()));
    }
    if (step !== 'declareBlockers') {
      setBlockAssign((cur) => (cur.size === 0 ? cur : new Map()));
      setActiveBlockTarget((cur) => (cur === null ? cur : null));
    }
  }, [step]);

  const notify = (message: string): void => {
    setToast(message);
    window.setTimeout(() => setToast(null), TOAST_MS);
  };

  /**
   * Submit one action that is NOT a proposal (a land drop, a pass, a declaration,
   * a free-hand mana tap, an answer to a resolving spell's question).
   *
   * `alsoClearCombatDraft` is set by exactly the two declarations that consume
   * the draft — and only on success, so a refused declaration keeps the clicks
   * the player made.
   */
  const run = (fn: () => SubmitResult, alsoClearCombatDraft = false): void => {
    const result = fn();
    if (result.rejected) {
      notify(result.rejected);
      return;
    }
    resetProposal();
    if (alsoClearCombatDraft) clearCombatDraft();
    onSubmit(() => result);
  };

  // --- the proposal, unpacked ------------------------------------------------------
  /** The one question the proposal is asking right now, or null. */
  const proposalQuestion = proposalPreview?.question ?? null;
  /** The cast this proposal is about, or null when it is not a cast. */
  const proposedCast: CastOption | null =
    proposal && proposal.opening.kind === 'cast' ? proposal.opening.option : null;
  /** The activated ability this proposal is about, or null. */
  const proposedAbility: AbilityOption | null =
    proposal && proposal.opening.kind === 'activate' ? proposal.opening.option : null;
  /** The §3.60 mana picker is on screen (see {@link fundingSources}). */
  const fundingOpen = fundingSources !== null;
  /**
   * An ENGINE-parked cast-time question (kicker, X, modes, an additional cost)
   * belongs to a proposal whose spell is already on the WORKING stack while the
   * board still renders the COMMITTED one (`BOARD_SESSION_BY_STAGE.announcing`).
   * The committed session therefore looks completely idle — so without this the
   * hand would stay clickable underneath a half-announced spell.
   */
  const announcingQuestion = proposalQuestion?.kind === 'engine' ? proposalQuestion : null;
  /**
   * The state a question's source card must be looked up in. A parked cast-time
   * question names a spell that exists only on the working stack.
   */
  const questionState = announcingQuestion && proposal ? proposal.working.state : session.state;

  // A parked question preempts everything: while it stands the engine offers no
  // other action, so the board's own controls must go quiet until it is answered.
  const pendingChoice = session.pendingChoice;
  const isViewersPriority =
    session.priorityPlayer === viewer && !pendingChoice && announcingQuestion === null;
  const playableLands = isViewersPriority ? session.playableLands() : [];
  const castOptions = isViewersPriority ? session.castOptions() : [];
  // Flashback: cards castable OUT OF the viewer's graveyard, same option shape as
  // the hand so the whole cast flow below (target pick → proposal → dispatch) is shared.
  const graveyardCasts = isViewersPriority ? session.graveyardCastOptions() : [];
  // Cycling: an ability of a card in HAND, so it is a second way to play a card
  // that may already have one (a cycling land is also a land drop) — which is
  // why the hand click below can open a menu rather than always acting.
  const cycleOptions = isViewersPriority ? session.cycleOptions() : [];
  // MADNESS: a card of the viewer's discarded to exile, still castable. The
  // window is the only thing the engine will accept right now, so it is shown as
  // a prompt rather than tucked into a panel the player might not open.
  const madnessCasts = session.exileCastOptions().filter(() => session.priorityPlayer === viewer);

  // --- manual mana tapping --------------------------------------------------------
  // Auto-tap covers casting; this covers everything else a player does with mana by
  // hand — floating it deliberately, and above all telling a MODAL source (Birds of
  // Paradise, a dual land) which colour to make, which no planner can decide for them.
  const tapMenu = useMemo(
    () => manaTapMenu(session.state, isViewersPriority ? session.legalActions() : []),
    [session, isViewersPriority],
  );
  const tappable = useMemo(
    () => tappableIds(tapMenu, session.state, viewer),
    [tapMenu, session, viewer],
  );

  // --- activated abilities --------------------------------------------------------
  // Grouped per source permanent, derived from the engine's offers alone: an
  // ability the engine did not offer (used this turn, unpayable, wrong timing)
  // never appears, so no dead buttons.
  const abilityMenu = useMemo(() => {
    const map = new Map<InstanceId, AbilityOption[]>();
    if (!isViewersPriority) return map;
    for (const opt of session.abilityOptions()) {
      const list = map.get(opt.instanceId);
      if (list) list.push(opt);
      else map.set(opt.instanceId, [opt]);
    }
    return map;
  }, [session, isViewersPriority]);

  /**
   * Activate an ability. **Everything** — the targets, the "Sacrifice another
   * …" payers, the §3.129 tap-to-afford float — goes through the proposal, which
   * already knows which of those are real questions and which have exactly one
   * legal answer (`ASK_WHEN_ONLY_ONE_ANSWER`), and which submit shape to use.
   *
   * ⚠️ THIS IS THE 137-DEAD-BUTTONS FIX. The board used to call
   * `session.activateAbility(id, idx)` — with NO `costInstanceIds` — and
   * `applyActivateAbility` rejects that outright for any ability that prints a
   * sacrifice cost. `AbilityOption.costPayers` existed; nothing on a screen read
   * it. `sacrifice-cost-activation.test.ts` drives a real pool card through this
   * same funnel and fails if the engine refuses.
   */
  const onChooseAbility = (opt: AbilityOption): void => {
    setAbilitySource(null);
    propose({ kind: 'activate', option: opt });
  };

  const onTapForMana = (id: InstanceId): void => {
    const options = tapMenu.get(id);
    if (!options || options.length === 0) return;
    // One mode is not a decision; more than one is, so ask rather than pick.
    if (isModalTap(options)) {
      setPendingManaTap(options);
      return;
    }
    const only = options[0] as ManaTapOption;
    tapSource(only.instanceId, only.mode);
  };

  /**
   * Tap one source — the ONE path both the free-hand board tap and the picker's
   * rows take. While the picker stands the tap folds into the PROPOSAL's private
   * working session; otherwise it commits as it always has. Splitting these
   * would be two answers to "what does clicking a land do".
   */
  const tapSource = (instanceId: InstanceId, mode: number | undefined): void => {
    setPendingManaTap(null);
    if (fundingOpen && proposal) {
      // `applyStep`, never `driveProposal`: a tap answers no question, so
      // driving forward here would confirm the cast the moment the pool covered
      // it — before the player had said they were done paying.
      applyStep(
        stepProposal(proposal, { kind: 'tapSource', instanceId, ...(mode !== undefined ? { mode } : {}) }),
      );
      return;
    }
    run(() => session.tapForMana(instanceId, mode));
  };

  // --- the §3.60 mana picker --------------------------------------------------------
  /**
   * Which castable cards have a GENUINE choice of funding sources — the set that
   * earns a "choose mana" affordance and the gate on opening the picker.
   *
   * Only asked for options that would actually TAP something: a cast the pool
   * already covers taps nothing, so there is nothing to choose. That prune is
   * what keeps a per-card predicate (which plans once per source in the auto
   * plan) off the render path for a hand of lands.
   */
  const castsWithManaChoice = useMemo(() => {
    const ids = new Set<string>();
    if (!isViewersPriority) return ids;
    // Re-read the option lists off the session rather than closing over the
    // conditional locals: the session memoizes both, so this is the same work,
    // and the memo's dependencies stay the two values that actually drive it.
    for (const option of [...session.castOptions(), ...session.graveyardCastOptions()]) {
      if (option.affordableNow || !option.affordableWithTap) continue;
      if (session.manaChoiceForCast(option)) ids.add(castOptionKey(option));
    }
    return ids;
  }, [session, isViewersPriority]);

  /** The live "still needed: {1}{G}" readout, against the WORKING pool. */
  const manaOwed =
    fundingOpen && proposedCast
      ? manaStillNeeded(session.state.players[session.priorityPlayer].manaPool, proposedCast.cost ?? {})
      : EMPTY_COST;

  /**
   * Whether Confirm may fire. Read off the ENGINE'S own offer — the paused cast
   * re-derived from the working session, whose `affordableNow` is the engine
   * saying the floating pool covers the cost. The readout above is a label;
   * this is the decision, and the two must not be the same opinion twice.
   */
  const manaPickerReady =
    proposedCast !== null &&
    [...castOptions, ...graveyardCasts, ...madnessCasts].some(
      (option) => castOptionKey(option) === castOptionKey(proposedCast) && option.affordableNow,
    );

  /** The tappable sources as picker rows, snapshotted when funding opens. */
  const fundingSourcesNow = (): readonly ManaPickerSource[] => {
    const sources: ManaPickerSource[] = [];
    for (const [instanceId, options] of tapMenu) {
      const perm = session.state.battlefield.find((p) => p.instanceId === instanceId);
      if (!perm || perm.controller !== viewer) continue;
      sources.push({ instanceId, name: perm.def.name, controller: perm.controller, options });
    }
    return sources;
  };

  /** Which sources this payment has already spent — the PROPOSAL's own record. */
  const fundingSpent = useMemo(
    () => new Set<InstanceId>(proposal?.spentManaSources ?? []),
    [proposal],
  );

  const setAlwaysChoose = (always: boolean): void => {
    setAlwaysChooseMana(always);
    saveManaChoicePref(always);
  };

  /**
   * A PUBLIC instance's card face, so a target — on the stack panel, in a
   * prompt — is hoverable rather than a bare name (UX-1 / UX-8 / UX-10).
   * `null` for anything with no pool card or no public home, which the
   * consumers render as a named plate rather than guessing at art.
   */
  const faceOfInstance = useCallback(
    (ref: InstanceId | PlayerId): string | null =>
      typeof ref === 'number' ? (findInstanceAnywhere(session.state, ref)?.def.id ?? null) : null,
    [session],
  );

  /**
   * The same lookup against the state a PARKED CAST-TIME question lives in. The
   * spell being announced is on the working stack and nowhere else, so the
   * board's own `faceOfInstance` (which reads the committed session while a
   * proposal is `announcing`) cannot see it.
   */
  const questionFaceOf = useCallback(
    (ref: InstanceId | PlayerId): string | null =>
      typeof ref === 'number' ? (findInstanceAnywhere(questionState, ref)?.def.id ?? null) : null,
    [questionState],
  );

  /**
   * The face of the hand card whose "how do you want to play this?" menu is
   * open. The viewer's OWN hand is the one hidden zone they may see, so the
   * lookup is theirs alone.
   */
  const handChoiceFaceId =
    handChoice === null ? null : ((view.self.hand ?? []).find((c) => c.instanceId === handChoice)?.cardId ?? null);

  /**
   * The player-facing sentence to show INSTEAD of a cancel control, or null
   * while backing out is still honest. Straight off `ProposalView` — the
   * vocabulary (`REWIND_BLOCK_EXPLANATIONS`) lives with the rule it belongs to,
   * so this surface invents no copy of its own.
   */
  const cancelBlockedExplanation = proposalPreview?.cancelBlockedExplanation ?? null;

  // --- the cast transaction ---------------------------------------------------------
  /**
   * Fold ONE proposal step into the board. THE single place a step is applied,
   * so "what happens when the transaction moves" has one answer (rule 12) — and
   * so the I6 obligation holds by construction: the only session that ever
   * reaches `onSubmit` comes off a `committed` step.
   */
  const applyStep = (next: ProposalStep): void => {
    switch (next.kind) {
      // Cancelling a proposal that is already gone is a no-op, not an error.
      case 'noop':
        return;
      case 'open':
        setProposal(next.proposal);
        return;
      case 'refused':
        // The engine's words, or the honest refusal's sentence. The proposal
        // survives unchanged so the player can retry or finish it.
        notify(next.reason);
        if (next.proposal) setProposal(next.proposal);
        return;
      case 'cancelled':
        resetProposal();
        return;
      case 'committed': {
        const result: SubmitResult = { session: next.session, rejected: null, events: next.events };
        resetProposal();
        onSubmit(() => result);
        return;
      }
    }
  };

  /**
   * Whether THIS cast earns the §3.60 picker. The per-cast way in (the hand
   * card's ⛁ chip) is subject to the same "is there a real choice?" gate as the
   * persisted setting, so neither route can raise a picker with one button in it.
   */
  const wantsManaPicker = (cast: CastOption, requested: boolean): boolean =>
    shouldAskForMana({
      always: alwaysChooseMana,
      requested,
      choiceExists: castsWithManaChoice.has(castOptionKey(cast)),
    });

  /**
   * Drive a proposal to the next thing the PLAYER has to decide, and CONFIRM it
   * when nothing is outstanding — which is what keeps a target-less, cost-less
   * ability a single click, exactly as it was before the transaction existed.
   *
   * The mana picker is asked LAST, once the aim is settled: it is the final
   * question before the dispatch, and asking it earlier would make the player
   * place mana for a spell they had not finished pointing.
   */
  const driveProposal = (next: ProposalStep, askForMana: boolean): void => {
    if (next.kind !== 'open') {
      applyStep(next);
      return;
    }
    const open = next.proposal;
    if (proposalView(open).question !== null) {
      setProposal(open);
      return;
    }
    if (askForMana && fundingSources === null) {
      setFundingSources(fundingSourcesNow());
      setProposal(open);
      return;
    }
    applyStep(stepProposal(open, { kind: 'confirm' }));
  };

  /**
   * Open a proposal. THE single door into the transaction: a cast from hand, a
   * flashback out of the graveyard, a madness cast from exile, an activated
   * ability and a cycling ability all come through here, so none of them can
   * acquire a cancel of its own — which is the CLASS this replaces.
   *
   * The rewind target is always `committedSession`, never the rendered one: a
   * proposal opened against a working session would restore to a half-paid board.
   *
   * The open COUNT is handed over so `PROPOSAL_CONFIG.maxOpenProposals` is a
   * live gate rather than a dead config field: clicking a second card while a
   * target prompt stands is REFUSED in words ("finish or cancel the current
   * spell first"), not silently allowed to replace the first proposal — which
   * would drop a half-made decision with no explanation at all.
   */
  const propose = (opening: ProposalOpening, askForMana = false): void => {
    proposalSeq.current += 1;
    driveProposal(
      openProposal(committedSession, opening, viewer, proposalSeq.current, proposal ? 1 : 0),
      askForMana,
    );
  };

  /**
   * The face of the card being cast, for the target prompt (UX-8). `CastOption`
   * carries a name and not a card id, so it is resolved from the VIEWER'S OWN
   * hand first (the one hidden zone this viewer may see) and from the public
   * zones after — a flashback cast comes from a graveyard, a madness cast from
   * exile. `null` for anything unresolvable, which draws a named plate.
   */
  const castFaceId = proposedCast
    ? ((view.self.hand ?? []).find((c) => c.instanceId === proposedCast.instanceId)?.cardId ??
      faceOfInstance(proposedCast.instanceId))
    : null;

  /** The cast's TARGETS question, when that is what is outstanding. */
  const castTargetQuestion =
    proposedCast && proposalQuestion?.kind === 'targets' ? proposalQuestion : null;

  /**
   * Board-clickable target candidates. The proposal asked core's own enumerator
   * (`session.castTargets`) and kept each enumerated `TargetOption`, so the board
   * re-derives nothing: bug report 20260901_211035 was exactly the opposite —
   * the board's private table did not know `blinkTarget` targeted anything, so
   * Cloudshift was cast with no target and refused.
   */
  const targetOptions: readonly TargetOption[] = castTargetQuestion
    ? castTargetQuestion.candidates.flatMap((choice) => (choice.option ? [choice.option] : []))
    : [];

  /**
   * Answer the outstanding TARGETS question with one more target. APPENDS,
   * because a requirement of two targets is one question answered by two clicks
   * and `targetQuestion` closes itself once enough have been named.
   */
  const chooseTarget = (target: InstanceId | PlayerId): void => {
    if (!proposal) return;
    driveProposal(
      stepProposal(proposal, { kind: 'setTargets', targets: [...proposal.targets, target] }),
      proposedCast !== null && wantsManaPicker(proposedCast, castRequestedMana),
    );
  };

  /** Answer the outstanding "what do you sacrifice?" question (CR 602.2b). */
  const choosePayers = (payer: AbilityCostChoice): void => {
    if (!proposal) return;
    driveProposal(stepProposal(proposal, { kind: 'setCostPayers', instanceIds: payer.instanceIds }), false);
  };

  /**
   * Back out, from ANY pre-commit step, repeatedly (UX-4). A live proposal is
   * cancelled THROUGH the transaction, so a rewind that is no longer honest is
   * REFUSED with its reason rather than silently un-showing something a player
   * saw; everything else here is a menu the engine was never told about.
   */
  const backOut = (): void => {
    if (proposal) {
      applyStep(cancelProposal(proposal));
      return;
    }
    resetProposal();
  };

  const onCastClick = (opt: CastOption, requested = false): void => {
    setCastRequestedMana(requested);
    propose({ kind: 'cast', option: opt }, wantsManaPicker(opt, requested));
  };

  const onCycleClick = (opt: CycleOption): void => {
    setHandChoice(null);
    propose({ kind: 'cycle', option: opt });
  };

  /**
   * A hand card was clicked. A card with exactly one way to be played acts
   * immediately; a card with several (a cycling land is a land drop AND a
   * cycling ability, a cycling spell is a cast AND a cycling ability) opens a
   * menu, because picking one for the player would silently throw away the
   * choice the printed card exists to offer.
   */
  const onHandCardClick = (id: InstanceId, land: boolean, casts: readonly CastOption[]): void => {
    const cycles = cycleOptions.filter((o) => o.instanceId === id);
    // A SPLIT card is two ways to cast one instance, so the count is the number
    // of cast options rather than "is there one?" — otherwise clicking a split
    // card would silently cast its left half and throw away the choice the card
    // exists to offer.
    const ways = (land ? 1 : 0) + casts.length + cycles.length;
    if (ways > 1) {
      setHandChoice(id);
      return;
    }
    if (cycles.length === 1) {
      onCycleClick(cycles[0] as CycleOption);
      return;
    }
    if (land) {
      run(() => session.playLand(id));
      return;
    }
    if (casts[0]) onCastClick(casts[0]);
  };

  // Drag a hand card onto your battlefield — the gesture bug report
  // 20260825_210220 asked for, identical to the online board's. The drop routes
  // through the SAME `onHandCardClick` chokepoint as a click, so a drag cannot
  // diverge from what clicking the card would have done (menus for multi-way
  // cards included). The re-lookup on drop is deliberate: the frame may have
  // changed mid-gesture, and stale affordances must not fire.
  /** The card being inspected full-size, if any (report 20260825_210026). */
  const [zoomed, setZoomed] = useState<{ cardId: string; name: string } | null>(null);

  // --- §3.57 clarity systems -------------------------------------------------------
  /** The board container: the combat-lines canvas and the animation anchors' root. */
  const boardRootRef = useRef<HTMLDivElement>(null);

  /** Jailed cards tucked under their jailer (both seats' PUBLIC exile zones). */
  const jails = useMemo(
    () =>
      groupJailedByJailer(
        jailSourcesOf([...session.state.players.A.exile, ...session.state.players.B.exile]),
        new Set(session.state.battlefield.map((perm) => perm.instanceId)),
      ),
    [session],
  );

  /** Owner/zone lookup over the PUBLIC board + the viewer's own hand (§3.57 labels). */
  const refIndex = useMemo(() => {
    const refs: KnownRef[] = [];
    const state = session.state;
    for (const perm of state.battlefield) {
      refs.push({ instanceId: perm.instanceId, name: perm.def.name, controller: perm.controller, zone: 'battlefield' });
    }
    for (const pid of ['A', 'B'] as const) {
      for (const dead of state.players[pid].graveyard) {
        refs.push({ instanceId: dead.instanceId, name: dead.def.name, controller: pid, zone: 'graveyard' });
      }
      for (const exiled of state.players[pid].exile) {
        refs.push({ instanceId: exiled.instanceId, name: exiled.def.name, controller: pid, zone: 'exile' });
      }
    }
    for (const obj of state.stack) {
      if (obj.kind === 'spell') {
        refs.push({ instanceId: obj.instanceId, name: obj.card.def.name, controller: obj.controller, zone: 'stack' });
      }
    }
    // The viewer's OWN hand only — the one hidden zone this viewer may see.
    for (const held of state.players[viewer].hand) {
      refs.push({ instanceId: held.instanceId, name: held.def.name, controller: viewer, zone: 'hand' });
    }
    return makeRefIndex(refs, viewer, names);
  }, [session, viewer, names]);

  /**
   * Identities the animation layer may need after an object left the board (a
   * token that died ceases to exist and is in NO zone afterwards). Only ever
   * fed from PUBLIC battlefield rows; append-only for the life of the board.
   */
  const boardIdentityRef = useRef(new Map<InstanceId, AnimationCardInfo>());

  /** Resolve a moved card's public identity for the animation descriptors. */
  const animLookup = useCallback(
    (id: InstanceId): AnimationCardInfo | undefined => {
      for (const pid of ['A', 'B'] as const) {
        const player = session.state.players[pid];
        for (const zone of [player.graveyard, player.exile]) {
          const hit = zone.find((card) => card.instanceId === id);
          if (hit) return { cardId: hit.def.id, name: hit.def.name, owner: pid };
        }
      }
      // A ceased token: fall back to what the battlefield last said it was.
      return boardIdentityRef.current.get(id);
    },
    [session],
  );

  const { sprites, retire } = useZoneAnimations(session.events, animLookup);
  // §3.131 — the visual-effects layer, folded from the same event log and
  // positioned with the same anchors/tile rects as the zone-flight layer.
  const { effects: vfxEffects, retire: retireVfx } = useGameVfx(session.events, viewer);
  // §3.133 — what the OPPONENT just did, held on screen after the stack has
  // already resolved it. Folded from the accepted ACTIONS (they carry targets;
  // the events do not) and labelled with the session's own resolver.
  const labelTarget = useCallback(
    (ref: InstanceId | PlayerId): string => (ref === 'A' || ref === 'B' ? names[ref] : session.nameOf(ref)),
    [names, session],
  );
  const opponentNotes = useOpponentFeed(session.actions, viewer, labelTarget);

  /**
   * LAST-KNOWN tile rect per instance, refreshed after every commit and never
   * evicted: the death ghost positions itself where the tile last stood, and
   * "last stood" must survive the burst of auto-advance commits between the
   * death event and the ghost's mount (a 2-deep window was measured losing the
   * rect to exactly that burst). Memory: one DOMRect per instance that ever
   * hit the battlefield — trivially small next to the game itself. The walk is
   * a board's worth of getBoundingClientRect calls per commit, nothing next to
   * a re-render.
   */
  const tileRectsRef = useRef(new Map<InstanceId, DOMRect>());
  useEffect(() => {
    const root = boardRootRef.current;
    if (!root) return;
    const rects = tileRectsRef.current;
    for (const el of root.querySelectorAll('[data-perm-id]')) {
      if (!(el instanceof HTMLElement)) continue;
      const id = Number(el.dataset['permId']);
      if (!Number.isNaN(id)) rects.set(id, el.getBoundingClientRect());
    }
    // Record public identities beside the rects (same walk over the view).
    const identities = boardIdentityRef.current;
    for (const seat of [view.self, view.opponent]) {
      for (const perm of seat.permanents) {
        identities.set(perm.instanceId, { cardId: perm.cardId, name: perm.name, owner: seat.id });
      }
    }
  });
  const tileRectOf = useCallback((id: InstanceId): DOMRect | undefined => tileRectsRef.current.get(id), []);


  const { drag, dropRef, handProps: dragHandProps } = useDragToPlay((id) => {
    const land = playableLands.includes(id);
    const casts = castOptions.filter((o) => o.instanceId === id);
    const cycles = cycleOptions.filter((o) => o.instanceId === id);
    if (!isViewersPriority || (!land && casts.length === 0 && cycles.length === 0)) return;
    onHandCardClick(id, land, casts);
  });

  /**
   * Activate a graveyard card from the panel. Routed through the SAME
   * `onCastClick` chokepoint as a hand card, so the flashback flow (target
   * prompt, auto-tap, rejection toast) cannot diverge from the hand's.
   */
  const onGraveyardCardClick = (id: InstanceId): void => {
    const opt = graveyardCasts.find((o) => o.instanceId === id);
    if (opt) onCastClick(opt);
  };

  /** The panel's view of the viewer's graveyard, with the why-disabled treatment. */
  const graveyardPanelCards = graveyardPanelView(
    session.state.players[viewer].graveyard.map((inst) => ({
      instanceId: inst.instanceId,
      cardId: inst.def.id,
      name: inst.def.name,
      hasFlashback: inst.def.flashback !== undefined,
    })),
    new Set(graveyardCasts.map((o) => o.instanceId)),
    { yourTurn: isViewersPriority, waitingOn: names[session.priorityPlayer], step },
  );

  // --- combat: attacker selection -----------------------------------------------
  const eligibleAttackers = useMemo(() => {
    if (step !== 'declareAttackers' || !isViewersPriority) return new Set<InstanceId>();
    // The engine's "attack with all eligible" action lists every eligible attacker.
    const all = session
      .legalActions()
      .find((a) => a.kind === 'declareAttackers');
    return new Set<InstanceId>(all && all.kind === 'declareAttackers' ? all.attackers : []);
  }, [session, step, isViewersPriority]);

  const toggleAttacker = (id: InstanceId): void => {
    const deselecting = chosenAttackers.has(id);
    setChosenAttackers((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    // A deselected attacker attacks nothing — drop its walker assignment too.
    if (deselecting) {
      setWalkerAssign((assign) => {
        if (!assign.has(id)) return assign;
        const cleaned = new Map(assign);
        cleaned.delete(id);
        return cleaned;
      });
    }
  };

  // Defending planeswalkers that can be attacked instead of the player.
  const enemyWalkers = useMemo(
    () =>
      step === 'declareAttackers' && isViewersPriority
        ? view.opponent.permanents.filter((p) => p.isPlaneswalker)
        : [],
    [step, isViewersPriority, view],
  );

  /**
   * Clicking a defending walker routes the CURRENTLY selected attackers at it;
   * clicking it again (when they all already attack it) sends them back at the
   * player. Attackers selected afterwards default to the player, keeping the
   * common all-at-the-face declaration untouched.
   */
  const onAssignAttackWalker = (walkerId: InstanceId): void => {
    if (chosenAttackers.size === 0) {
      notify('Select attackers first, then click the planeswalker to attack it.');
      return;
    }
    setWalkerAssign((cur) => {
      const next = new Map(cur);
      const allAtWalker = [...chosenAttackers].every((a) => next.get(a) === walkerId);
      for (const a of chosenAttackers) {
        if (allAtWalker) next.delete(a);
        else next.set(a, walkerId);
      }
      return next;
    });
  };

  // --- combat: blocker assignment -----------------------------------------------
  const defender = session.state.combat ? otherOf(session.state.activePlayer) : null;
  const inBlockStep = step === 'declareBlockers' && isViewersPriority && viewer === defender;
  const attackerIds = session.state.combat?.attackers ?? [];

  // Eligible blockers: my untapped creatures (the engine validates legality on submit).
  const eligibleBlockers = useMemo(() => {
    if (!inBlockStep) return new Set<InstanceId>();
    const ids = view.self.permanents.filter((p) => p.isCreature && !p.tapped).map((p) => p.instanceId);
    return new Set(ids);
  }, [inBlockStep, view]);

  const onBlockBoardClick = (id: InstanceId): void => {
    // Click an attacker to "arm" it, then click your creature to assign as blocker.
    if (attackerIds.includes(id)) {
      setActiveBlockTarget((cur) => (cur === id ? null : id));
      return;
    }
    if (eligibleBlockers.has(id)) {
      if (activeBlockTarget === null) {
        notify('Pick an attacker to block first.');
        return;
      }
      setBlockAssign((cur) => {
        const next = new Map(cur);
        if (next.get(id) === activeBlockTarget) next.delete(id);
        else next.set(id, activeBlockTarget);
        return next;
      });
    }
  };

  // --- per-seat board interactions ----------------------------------------------
  const selfInteraction = buildSelfInteraction();
  const opponentInteraction = buildOpponentInteraction();

  function buildSelfInteraction(): PermInteraction | undefined {
    // THE PICKER OWNS THE BOARD while it stands: the only thing to do is choose
    // sources, so nothing else may steal a click. Spent sources stay marked so
    // the player can see the payment they are assembling.
    if (fundingOpen) {
      const markers = new Map<InstanceId, string>();
      for (const id of fundingSpent) markers.set(id, 'paying');
      for (const id of tappable) {
        const options = tapMenu.get(id) ?? [];
        markers.set(id, isModalTap(options) ? 'pay: any' : `pay: ${options[0]?.label ?? ''}`);
      }
      return {
        selectableIds: tappable,
        selectedIds: fundingSpent,
        markers,
        onClick: onTapForMana,
      };
    }
    if (step === 'declareAttackers' && isViewersPriority) {
      // An attacker aimed at a walker says so on its marker; the rest read "ATK"
      // (attacking the player) exactly as before.
      const markers = new Map<InstanceId, string>();
      for (const id of chosenAttackers) {
        const walker = walkerAssign.get(id);
        markers.set(id, walker !== undefined ? `ATK → ${session.nameOf(walker)}` : 'ATK');
      }
      return {
        selectableIds: eligibleAttackers,
        selectedIds: chosenAttackers,
        markers,
        onClick: toggleAttacker,
      };
    }
    if (inBlockStep) {
      const markers = new Map<InstanceId, string>();
      for (const [blocker, atk] of blockAssign) markers.set(blocker, `→ ${session.nameOf(atk)}`);
      return {
        selectableIds: eligibleBlockers,
        selectedIds: new Set(blockAssign.keys()),
        markers,
        onClick: onBlockBoardClick,
      };
    }
    // Spell targeting: allow clicking own creatures as targets.
    if (castTargetQuestion) return targetInteraction(view.self.permanents.map((p) => p.instanceId));
    // Otherwise your untapped mana sources are tappable by hand, and permanents
    // with an engine-offered activated ability (a planeswalker's loyalty lines)
    // open their ability menu. Last in the chain so neither steals a click from
    // combat selection or targeting. Mana-tapping wins an overlap: it is the
    // frequent action, and no pool permanent is both today.
    const activatable = new Set(abilityMenu.keys());
    if (tappable.size > 0 || activatable.size > 0) {
      const markers = new Map<InstanceId, string>();
      for (const id of activatable) markers.set(id, 'activate');
      for (const id of tappable) {
        const options = tapMenu.get(id) ?? [];
        markers.set(id, isModalTap(options) ? 'tap: any' : `tap: ${options[0]?.label ?? ''}`);
      }
      return {
        selectableIds: new Set([...activatable, ...tappable]),
        selectedIds: new Set(),
        markers,
        onClick: (id) => {
          if (tappable.has(id)) onTapForMana(id);
          else setAbilitySource(id);
        },
      };
    }
    return undefined;
  }

  function buildOpponentInteraction(): PermInteraction | undefined {
    // Declaring attackers with defending walkers on the board: the walkers are
    // clickable attack targets (see onAssignAttackWalker for the toggle semantics).
    if (step === 'declareAttackers' && isViewersPriority && enemyWalkers.length > 0) {
      const markers = new Map<InstanceId, string>();
      const selected = new Set<InstanceId>();
      for (const walker of enemyWalkers) {
        const incoming = [...chosenAttackers].filter((a) => walkerAssign.get(a) === walker.instanceId).length;
        if (incoming > 0) {
          markers.set(walker.instanceId, `⚔ ${incoming}`);
          selected.add(walker.instanceId);
        }
      }
      return {
        selectableIds: new Set(enemyWalkers.map((p) => p.instanceId)),
        selectedIds: selected,
        markers,
        onClick: onAssignAttackWalker,
      };
    }
    if (inBlockStep) {
      // Opponent's attackers are the things you arm to assign a blocker to.
      const markers = new Map<InstanceId, string>();
      if (activeBlockTarget !== null) markers.set(activeBlockTarget, 'blocking…');
      return {
        selectableIds: new Set(attackerIds),
        selectedIds: activeBlockTarget !== null ? new Set([activeBlockTarget]) : new Set(),
        markers,
        onClick: onBlockBoardClick,
      };
    }
    if (castTargetQuestion) return targetInteraction(view.opponent.permanents.map((p) => p.instanceId));
    return undefined;
  }

  function targetInteraction(ownedIds: readonly InstanceId[]): PermInteraction | undefined {
    if (!castTargetQuestion) return undefined;
    // Board-clickable targets: anything of the engine's offers that is ON THE
    // BATTLEFIELD (creature, planeswalker or any other permanent — Naturalize
    // aims at an artifact, and a tile is a tile). Players and stack objects
    // stay buttons in the prompt, because there is no tile to click.
    const permanentTargets = new Set(
      targetOptions
        .filter((o) => isBoardTargetOption(o) && ownedIds.includes(o.instanceId))
        .map((o) => (o as { instanceId: InstanceId }).instanceId),
    );
    if (permanentTargets.size === 0) return undefined;
    return {
      selectableIds: permanentTargets,
      selectedIds: new Set(),
      // The same set, marked so it PULSES: "which creature can this go on?" is
      // answered by looking (§3.119, report 20260901_211035).
      targetableIds: permanentTargets,
      onClick: (id) => chooseTarget(id),
    };
  }

  // --- render --------------------------------------------------------------------
  const statusText = `Turn ${view.turnNumber} · ${stepLabel(step)} · ${names[view.activePlayer]}'s turn`;

  /**
   * §3.143 / UX-14 — the fiery arcs, both directions. `combatArcPairs` is the
   * funnel: blocker→attacker as before, PLUS attacker→(player | planeswalker),
   * which the board could never draw because `blockerLinePairs` knew only one
   * pair kind. `defendingSeat` is required for an attack on a PLAYER to draw
   * anything — who defends is a rules question (CR 506.2) core owns, and the
   * arc module deliberately refuses to re-answer it.
   */
  const combatLines = combatArcPairs({
    step,
    declaredBlocks: view.combat?.blocks,
    draftAssign: blockAssign,
    declaredAttackers: session.state.combat?.attackers,
    ...(session.state.combat?.attackTargets !== undefined
      ? { attackTargets: session.state.combat.attackTargets }
      : {}),
    defendingSeat: opponentOf(session.state.activePlayer),
    draftAttackers: chosenAttackers,
    draftAttackTargets: walkerAssign,
  });

  /**
   * §3.143 / UX-12 + UX-13 — WHICH CARDS WALK OUT.
   *
   * Declared attackers and declared blockers only. A DRAFT selection does not
   * advance: while the player is still clicking, the cards must stay where they
   * are so the next click lands on the tile they aimed at — the arcs already
   * show the draft, dashed, which is the right channel for "not yet decided".
   */
  const stageEntries = useMemo((): readonly StageEntry[] => {
    const combat = session.state.combat;
    if (!combat || !combat.attackersDeclared) return [];
    const permById = new Map<InstanceId, (typeof view.self.permanents)[number]>();
    for (const seat of [view.self, view.opponent]) {
      for (const perm of seat.permanents) permById.set(perm.instanceId, perm);
    }
    // The attacker's seat is the ACTIVE player's; everyone advances toward the
    // midline, so the sign is "am I the viewer's seat or the far one".
    const towardFor = (controller: PlayerId): 1 | -1 => (controller === viewer ? -1 : 1);
    const entries: StageEntry[] = [];
    for (const id of combat.attackers) {
      const perm = permById.get(id);
      if (perm) entries.push({ perm, role: 'attacker', toward: towardFor(perm.controller) });
    }
    if (combat.blockersDeclared) {
      for (const [blockerId, attackerId] of Object.entries(combat.blocks)) {
        const perm = permById.get(Number(blockerId));
        if (perm) {
          entries.push({
            perm,
            role: 'blocker',
            toward: towardFor(perm.controller),
            meets: attackerId,
          });
        }
      }
    }
    return entries;
  }, [session, view, viewer]);

  /**
   * Which cards are OUT, so their home tiles hand `data-perm-id` over to the
   * copy the player is actually looking at. Delivered through a CONTEXT rather
   * than a prop because `SeatPanel` renders every tile and belongs to no lane —
   * see `combat-stage-context.ts`.
   */
  const [stagedIds, setStagedIds] = useState<ReadonlySet<InstanceId>>(NO_STAGED_PERMANENTS);

  /** The element between the two seats: its vertical centre IS the midline. */
  const midlineRef = useRef<HTMLDivElement>(null);

  /** §3.143 / UX-15 — damage travels from source to recipient (lane H). */
  const { beats: damageBeats, retire: retireDamage } = useDamageSequence(session.events);

  /**
   * §3.143 / UX-9 — the tabletop's own numbers, handed to the CSS as custom
   * properties so `board-scene.css` contains no literal at all. A player who
   * asked for reduced motion gets `reducedMotionTiltDeg` — a NUMBER, not a
   * boolean, so a designer can pick a gentler tilt without a code change. A
   * static perspective is not literally motion, but `prefers-reduced-motion` is
   * the only signal browsers give for vestibular discomfort, and a tilted plane
   * with tiles sliding across it is exactly that trigger.
   */
  const reducedMotion = usePrefersReducedMotion();
  const sceneVars = {
    '--board-perspective-px': `${BOARD_3D_CONFIG.perspectivePx}px`,
    '--board-tilt-deg': `${reducedMotion ? BOARD_3D_CONFIG.reducedMotionTiltDeg : BOARD_3D_CONFIG.tiltDeg}deg`,
    '--board-origin-x': `${BOARD_3D_CONFIG.perspectiveOriginXFraction * 100}%`,
    '--board-origin-y': `${BOARD_3D_CONFIG.perspectiveOriginYFraction * 100}%`,
    '--board-scene-ms': `${BOARD_3D_CONFIG.sceneTransitionMs}ms`,
    '--perm-turn-ms': `${TAP_ROTATION_CONFIG.turnMs}ms`,
    '--perm-tapped-opacity': String(TAP_ROTATION_CONFIG.tappedOpacity),
    '--perm-tapped-grayscale': String(TAP_ROTATION_CONFIG.tappedGrayscaleFraction),
    '--perm-staged-opacity': String(STAGED_HOME_TILE_OPACITY),
    '--combat-advance-ms': `${COMBAT_ADVANCE_CONFIG.advanceMs}ms`,
    '--spell-hold-fade-ms': `${SPELL_HOLD_CONFIG.fadeMs}ms`,
  } as CSSProperties;

  // The §3.57 hint rule: the copy must describe the buttons that exist. The
  // attack window is the ACTIVE player's own declare step, pre-declaration;
  // everyone else in that step is merely responding.
  const isAttackWindow =
    step === 'declareAttackers' &&
    session.state.activePlayer === viewer &&
    session.state.combat !== null &&
    !session.state.combat.attackersDeclared;
  /**
   * §3.119 — THE STACK OUTRANKS THE STEP. Bug reports 20260901_212245
   * (Thragtusk's life-gain trigger) and 20260901_213414 (Angel of Serenity
   * "swallowed") were both a spell or trigger sitting on the stack while the
   * bar read empty-stack main-phase copy. When something is waiting, the hint
   * names it and the pass button says "Resolve".
   */
  const stackTop = view.stack[0];
  const stackHintCtx: StackHintContext | undefined =
    stackTop && isViewersPriority
      ? {
          topName: stackTop.name,
          topIsMine: stackTop.controller === viewer,
          canRespond: session.canRespond(),
        }
      : undefined;
  const barHint = actionBarHint(
    step,
    {
      isAttackWindow,
      hasAttackers: eligibleAttackers.size > 0,
      // `inBlockStep` already means "the defender, holding priority, in the
      // declare-blockers step" — precisely the window the hint asks about.
      isBlockWindow: inBlockStep,
      hasBlockers: eligibleBlockers.size > 0,
      hasEnemyWalkers: enemyWalkers.length > 0,
      mainPhaseFlavor: 'hotseat',
    },
    stackHintCtx,
  );

  /**
   * §3.143 / UX-6 — "MAY" IS ASKED BEFORE TARGETS, and the answer is REMEMBERED.
   *
   * ⚠️ THE OLD FOLD DID NOT WORK, AND ITS DOC COMMENT WAS THE REASON. It
   * answered the target and then read `aimed.session.pendingChoice`
   * synchronously, on a comment asserting that the "may" was already parked on
   * that session. Lane C measured it: it is `null` — the trigger is on the
   * stack and needs a full priority round before it resolves and asks. So
   * "Don't use Conjurer's Closet" chose a target FOR the player (via
   * `defaultAnswerFor`) and then showed the may modal anyway, on all 24 cards
   * of the class. The answer is now carried across that round in a LEDGER and
   * spent by the effect below.
   *
   * ⚠️ AND THE SOURCE LOOKUP WAS BATTLEFIELD-ONLY. Every modal spell's per-mode
   * target question carries the SPELL's instance id (it is on the stack, not the
   * battlefield), so the prompt fell back to a named placeholder — 110 modal
   * modes on 60 pool cards, measured by lane C. `findDefAnywhere` is what makes
   * UX-8 ("show the actual card that is provoking the choice") true for them.
   */
  const [mayLedger, setMayLedger] = useState<DeferredMayLedger>(EMPTY_MAY_LEDGER);
  const choiceSourceDef = pendingChoice
    ? findDefAnywhere(session.state, pendingChoice.sourceInstanceId)
    : undefined;

  const answerFoldedMay = (yes: boolean, answer: ChoiceAnswer): void => {
    const choice = pendingChoice;
    if (!choice) return;
    const targets = answer.kind === 'selectTargets' ? [...answer.targets] : [];
    run(() => {
      const res = session.answerChoice(answer);
      if (res.rejected === null) {
        const turnNumber = res.session.state.turnNumber;
        setMayLedger((ledger) =>
          recordDeferredMay(expireDeferredMay(ledger, turnNumber), {
            sourceInstanceId: choice.sourceInstanceId,
            targets,
            yes,
            turnNumber,
          }),
        );
      }
      return res;
    });
  };

  // Spend a remembered "no" the moment the trigger finally asks. It fires a
  // full priority round after the target was answered, which is exactly why the
  // synchronous version above could never have worked.
  useEffect(() => {
    const choice = session.pendingChoice;
    if (!choice || mayLedger.length === 0) return;
    const hit = matchDeferredMay(mayLedger, choice, session.state.resolution);
    if (!hit) return;
    setMayLedger((ledger) => consumeDeferredMay(ledger, hit.index));
    const res = session.answerChoice({ kind: 'confirm', yes: hit.yes });
    if (!res.rejected) onSubmit(() => res);
  }, [session, mayLedger, onSubmit]);

  /**
   * §3.143 / UX-4 — IS ANYTHING PRE-COMMIT OPEN RIGHT NOW?
   *
   * Caleb: *"Anytime I activate an ability or anything that targets cards, until
   * I've actually chosen the targets, I should be able to back out of the
   * spell/ability as long as nothing has mutated game state yet."*
   *
   * `proposal` covers BOTH of lane B's tiers now that the transaction is wired:
   * the 97.3% whose answer rides the action and never dispatched at all, and the
   * 177 pool cards that park a cast-time question after the object is on the
   * stack. For the second group the proposal still refuses HONESTLY when the
   * announcement is genuinely over (`ProposalView.cancelBlockedExplanation`)
   * instead of offering a cancel it cannot deliver.
   *
   * The other three are menus the engine has never been told about, so dropping
   * one is free. `fundingSources` and `castRequestedMana` ride `proposal` and
   * are not separately openable.
   */
  const preCommitOpen =
    proposal !== null ||
    abilitySource !== null ||
    handChoice !== null ||
    pendingManaTap !== null;

  /**
   * THE WORLD MOVED UNDER AN OPEN PROPOSAL — drop it, and SAY SO.
   *
   * A proposal snapshots the session it opened against, and that snapshot is
   * what the board renders while the rewind is honest. `PlayView` owns the AI
   * seat and the auto-passer, so it can hand down a different committed session
   * at any time; when it does, the proposal's rewind target no longer describes
   * the game and confirming it would apply the player's action to a board that
   * has moved. Dropping it with a toast is the honest answer (rule 6) — a silent
   * freeze on a stale board is the failure mode this replaces.
   *
   * It cannot fire on our own commits: `applyStep` clears the proposal in the
   * same update that submits the new session.
   */
  useEffect(() => {
    if (proposal === null || proposal.committed === committedSession) return;
    resetProposal();
    notify('The game moved on — that was not cast.');
  }, [committedSession, proposal]);

  /**
   * Escape backs out, from ANY pre-commit step, repeatedly. The key is
   * `PROPOSAL_CONFIG.cancelKey` rather than a fourth copy of the string
   * `'Escape'` — the handler, the hint and the test all read the one value.
   *
   * The listener is re-bound whenever the proposal changes because `backOut`
   * closes over it: a stale closure would cancel a proposal that is two answers
   * old, which is exactly the class `Proposal.id` exists to refuse.
   */
  useEffect(() => {
    if (!preCommitOpen) return undefined;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== PROPOSAL_CONFIG.cancelKey) return;
      event.preventDefault();
      backOut();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preCommitOpen, proposal]);

  /** The reveal to announce on the board, if any and not yet dismissed (§3.119). */
  const reveal = useMemo(
    () =>
      latestReveal(
        session.events,
        viewer,
        names,
        (id) => {
          for (const pid of ['A', 'B'] as const) {
            const player = session.state.players[pid];
            for (const zone of [player.hand, player.library, player.graveyard, player.exile]) {
              const hit = zone.find((c) => c.instanceId === id);
              if (hit) return { cardId: hit.def.id, name: hit.def.name };
            }
          }
          return undefined;
        },
        session.nameOf,
      ),
    [session, viewer, names],
  );
  const showReveal = reveal !== null && reveal.at !== dismissedReveal;

  return (
    /*
     * ⚠️ `.play-board` ITSELF CARRIES NO `transform` / `perspective` / `filter`
     * / `contain: paint`, AND MUST NOT. Twelve `position: fixed` overlays are
     * rendered as its descendants (the prompts, the toast, the reveal, the
     * stops menu, the animation/VFX/damage/stage layers), and any of those four
     * properties on an ancestor makes that ancestor their containing block —
     * silently re-rooting every one of them and moving every measured
     * coordinate. The tilt goes on `.board-scene`, which contains only the two
     * seats and the log. `board-scene.test.ts` is the guard; the first person
     * who wants a screen shake will need to read it.
     */
    <div className="play-board" ref={boardRootRef} style={sceneVars}>
      {suggestionHint && (
        <div className="copilot-hint" role="status">
          <span className="copilot-hint__label">Co-pilot</span>
          <span className="copilot-hint__text">{suggestionHint}</span>
        </div>
      )}
      <div className="play-board__status">
        <span className="play-board__turn">{statusText}</span>
        <span className="play-board__priority">{names[view.priorityPlayer]} has priority</span>
        <button type="button" className="btn btn--danger btn--ghost play-board__concede" onClick={onConcede}>
          Concede
        </button>
      </div>

      {/*
        THE TABLETOP (UX-9). Only the two seats and the centre column are tilted
        — every modal, every overlay and the viewer's own hand are SIBLINGS of
        this box, so none of them is projected, re-rooted or mis-measured.
        The staged-permanent context wraps it because `SeatPanel` renders the
        tiles and cannot be given a prop.
      */}
      <StagedPermanentsContext.Provider value={stagedIds}>
      <div className="board-scene">
      <div className="board-scene__table">
      {/* Opponent (top) — hand hidden. */}
      <div className="play-board__opponent">
        <SeatPanel
          seat={view.opponent}
          isActive={view.activePlayer === view.opponent.id}
          hasPriority={view.priorityPlayer === view.opponent.id}
          interaction={opponentInteraction}
          jails={jails}
          onInspectCard={setZoomed}
        />
        <div
          className="play-hand play-hand--hidden"
          aria-label={`${view.opponent.name} hand (hidden)`}
          data-anim-anchor={`hand:${view.opponent.id}`}
        >
          {Array.from({ length: view.opponent.handCount }).map((_, i) => (
            <CardBack key={i} index={i} />
          ))}
          {view.opponent.handCount === 0 && <span className="seat__empty">Empty hand</span>}
        </div>
      </div>

      {/*
        The centre column — now the LOG alone; the stack floats (see below).
        It is also the MIDLINE: the region between the two seats, measured
        rather than recomputed from seat heights, which is the one answer that
        stays true when board-fit.css squeezes a seat.
      */}
      <div className="play-board__center" ref={midlineRef}>
        <GameLog events={session.events} resolvers={{ name: session.nameOf, playerName: session.playerName }} />
      </div>

      {/* Viewer (bottom) — own hand face-up. */}
      <div className="play-board__self">
        {/* The seat panel doubles as the drag-to-play drop zone, exactly as on
            the online board: dashed while a card is in flight, solid when over. */}
        <div
          ref={dropRef}
          className={`drop-zone${drag ? ' drop-zone--active' : ''}${drag?.overDrop ? ' drop-zone--over' : ''}`}
        >
          <SeatPanel
            seat={view.self}
            isActive={view.activePlayer === view.self.id}
            hasPriority={isViewersPriority}
            interaction={selfInteraction}
            onGraveyardClick={() => setGraveyardOpen((open) => !open)}
            jails={jails}
            onInspectCard={setZoomed}
          />
        </div>
        {/* The opened graveyard. Flashback casts live in `legalActions` but the
            hand was the only clickable zone, so they were unreachable — this is
            that affordance, routed through the same cast chokepoint. */}
        {graveyardOpen && (
          <GraveyardPanel
            ownerName={view.self.name}
            cards={graveyardPanelCards}
            onActivate={onGraveyardCardClick}
            onClose={() => setGraveyardOpen(false)}
          />
        )}
      </div>
      </div>{/* .board-scene__table */}
      </div>{/* .board-scene */}
      </StagedPermanentsContext.Provider>

      {/*
        YOUR HAND IS OUTSIDE THE SCENE (UX-9). A tilted hand is unreadable, and
        under `transform-style: flat` — which is all this board can have, see
        board-scene.css — there is no counter-rotation that undoes the parent's
        projection. board-fit.css rule 5 is unchanged and in fact stronger: the
        hand is now `flex: 0 0 auto` against the whole board rather than against
        a seat band that could be squeezed.
      */}
        <div
          className="play-hand"
          aria-label={`${view.self.name} hand`}
          data-anim-anchor={`hand:${view.self.id}`}
          {...dragHandProps}
          onDragStart={(e) => e.preventDefault()}
        >
          {(view.self.hand ?? []).map((c) => {
            const land = playableLands.includes(c.instanceId);
            // A split card contributes ONE option per half; the badge summarises
            // them and the menu below lists them by name.
            const casts = castOptions.filter((o) => o.instanceId === c.instanceId);
            const cast = casts[0];
            const cycles = cycleOptions.filter((o) => o.instanceId === c.instanceId);
            const actionable = isViewersPriority && (land || casts.length > 0 || cycles.length > 0);
            const badge = c.isLand
              ? cycles.length > 0
                ? 'Land · cycling'
                : 'Land'
              : casts.some((o) => o.affordableNow)
                ? casts.length > 1
                  ? 'castable · 2 halves'
                  : 'castable'
                : cast
                  ? 'tap mana'
                  : cycles.length > 0
                    ? 'cycling'
                    : undefined;
            const dragging = drag?.id === c.instanceId ? drag : null;
            return (
              // The wrapper is the drag handle (see the online board): the
              // attribute marks it draggable for the delegated handlers, the
              // transform is the ghost, touch-action keeps phones from turning
              // the gesture into a scroll.
              <div
                key={c.instanceId}
                className={`hand-card-slot${dragging ? ' hand-card-slot--dragging' : ''}${
                  /* §3.67 — the co-pilot's pick, outlined not forced. */
                  suggestedCard === c.instanceId ? ' copilot-suggested' : ''
                }`}
                {...(actionable ? { [DRAG_ID_ATTR]: c.instanceId } : {})}
                style={
                  dragging
                    ? { touchAction: 'none', transform: `translate(${dragging.dx}px, ${dragging.dy}px)` }
                    : actionable
                      ? { touchAction: 'none' }
                      : undefined
                }
                onContextMenu={(e) => {
                  e.preventDefault();
                  setZoomed({ cardId: c.cardId, name: c.name });
                }}
              >
                {/*
                  HOVER YOUR OWN HAND (§3.119, report 20260901_205149 — "I cant
                  hover over my own in hand cards to see what they are"). Every
                  battlefield tile has had the full-card preview since §3.53 and
                  the hand never did: at the fanned sizes the printed text on a
                  148px face is unreadable, and the card's name lived only in
                  the image's `alt`. Same wrapper, same component — the one the
                  board already trusts — so hand, battlefield and mulligan now
                  answer "what is this card?" identically.
                */}
                <CardHover cardId={c.cardId}>
                  <PlayCard
                    cardId={c.cardId}
                    name={c.name}
                    face="full"
                    badge={badge}
                    disabled={!actionable}
                    onClick={actionable ? () => onHandCardClick(c.instanceId, land, casts) : undefined}
                  />
                </CardHover>
                <button
                  type="button"
                  className="hand-card-slot__zoom"
                  aria-label={`Inspect ${c.name}`}
                  title={`Inspect ${c.name}`}
                  onClick={() => setZoomed({ cardId: c.cardId, name: c.name })}
                >
                  🔍
                </button>
                {/* THE PER-CAST WAY IN (§3.60). Shown only on a cast that has a
                    genuinely different way to be funded, so it is an offer where
                    there is something to offer and absent everywhere else — no
                    dead control, and no nag on the cards it cannot help. */}
                {manaChoiceCast(casts, castsWithManaChoice) && (
                  <button
                    type="button"
                    className="hand-card-slot__choose-mana"
                    aria-label={`Choose which mana pays for ${c.name}`}
                    title={`Choose which mana pays for ${c.name}`}
                    onClick={() => onCastClick(manaChoiceCast(casts, castsWithManaChoice) as CastOption, true)}
                  >
                    ⛁
                  </button>
                )}
              </div>
            );
          })}
          {(view.self.hand?.length ?? 0) === 0 && <span className="seat__empty">Empty hand</span>}
        </div>

      {/*
        §3.143 / UX-2 — THE STACK IS ALWAYS VISIBLE. It floats over the board
        (`placement="floating"`, `position: absolute` inside the already-relative
        `.play-board`) instead of sharing the centre column with the log, so it
        costs the battlefield NO height — which matters because that column is
        `flex: 0 4 auto`, the designated first-to-yield, and report
        20260901_204618 ("Battleground is super crunched") was already paid once.
        Mounted OUTSIDE `.board-scene`: an absolutely-positioned descendant of a
        transformed box is positioned against that box and tilted with it.
      */}
      <StackPanel
        stack={view.stack}
        names={names}
        nameOf={session.nameOf}
        faceOf={faceOfInstance}
        viewer={viewer}
        placement="floating"
      />

      {zoomed && (
        <CardZoomOverlay cardId={zoomed.cardId} name={zoomed.name} onClose={() => setZoomed(null)} />
      )}

      {/* Action bar. */}
      <ActionBar
        session={session}
        viewer={viewer}
        step={step}
        hint={barHint}
        waitingText={
          pendingChoice && !isChoiceForViewer(pendingChoice, viewer)
            ? waitingForChoiceText(pendingChoice, names)
            : pendingChoice
              ? 'Answer the question above to continue.'
              : undefined
        }
        isViewersPriority={isViewersPriority}
        inBlockStep={inBlockStep}
        chosenAttackers={chosenAttackers}
        blockAssign={blockAssign}
        eligibleAttackers={eligibleAttackers}
        alwaysChooseMana={alwaysChooseMana}
        stackNonEmpty={view.stack.length > 0}
        fullControl={stops.fullControl}
        onFullControl={(on) => onStops({ ...stops, fullControl: on })}
        onOpenStops={() => setStopsMenuOpen(true)}
        suggested={suggestBar}
        copilotOn={copilotOn}
        onCopilot={(on) => {
          setCopilotOn(on);
          saveCopilotPref(on);
        }}
        soundOn={soundPrefs.enabled}
        onToggleSound={onToggleSound}
        onAlwaysChooseMana={setAlwaysChoose}
        onPass={() => run(() => session.passPriority())}
        /* The two actions that CONSUME the combat draft — and the only two that
           clear it. Cleared on SUCCESS only, so a refused declaration keeps the
           clicks the player made. */
        onDeclareAttackers={(ids) =>
          run(() => session.declareAttackers(ids, Object.fromEntries(walkerAssign)), true)
        }
        onDeclareBlockers={(blocks) => run(() => session.declareBlockers(blocks), true)}
      />

      {/*
        A question a resolving spell parked. Rendered ONLY for the seat it was
        addressed to — its candidates can include cards the other seat may not see,
        so the chooser check is a hidden-information guard, not just routing. The
        hotseat handoff already gates the device on the engine moving priority to
        the chooser, so in practice the viewer IS the chooser here.
      */}
      {announcingQuestion && proposal ? (
        /*
          §3.143 / UX-7's commit half — a CAST-TIME question the engine parked
          (kicker, X, modes, an additional cost) on a spell that is on the
          WORKING stack only. It is answered THROUGH the proposal, so backing out
          here really does leave nothing behind, and when the announcement is
          over the proposal says so in words rather than dropping the affordance.
          Its source is looked up in `questionState` because the spell exists in
          no other one.
        */
        <ChoicePrompt
          choice={announcingQuestion.choice}
          names={names}
          onAnswer={(answer) => applyStep(stepProposal(proposal, { kind: 'answer', answer }))}
          zoneOf={refIndex.zoneOf}
          sourceDef={choiceSourceDef ?? null}
          cardIdOf={questionFaceOf}
        />
      ) : (
        pendingChoice &&
        isChoiceForViewer(pendingChoice, viewer) && (
          <ChoicePrompt
            choice={pendingChoice}
            names={names}
            onAnswer={(answer) => run(() => session.answerChoice(answer))}
            zoneOf={refIndex.zoneOf}
            sourceDef={choiceSourceDef ?? null}
            cardIdOf={faceOfInstance}
            onFoldedMay={answerFoldedMay}
          />
        )
      )}

      {/* Which colour should this modal source make? (Birds of Paradise, a dual land.) */}
      {pendingManaTap && (
        <div className="target-prompt" role="dialog" aria-label="Choose which mana to add">
          <div className="target-prompt__card">
            <div className="target-prompt__title">
              Add which mana from {session.nameOf(pendingManaTap[0]?.instanceId ?? 0)}?
            </div>
            <div className="target-prompt__options">
              {pendingManaTap.map((opt) => (
                <button
                  key={opt.mode ?? 0}
                  type="button"
                  className="btn"
                  onClick={() => tapSource(opt.instanceId, opt.mode)}
                >
                  {opt.label}
                </button>
              ))}
            </div>
            <button type="button" className="btn btn--ghost" onClick={() => setPendingManaTap(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* §3.60 — WHICH sources pay for this spell. Click them on the board or in
          this list; the readout counts the cost down live. Confirm casts with
          exactly what is tapped, Cancel drops the whole working session and the
          board is back where it started. */}
      {fundingOpen && proposedCast && !pendingManaTap && (
        <div className="target-prompt mana-picker" role="dialog" aria-label="Choose which mana pays">
          <div className="target-prompt__card">
            <div className="target-prompt__title">Pay for {proposedCast.name}</div>
            <div className="mana-picker__owed" role="status">
              {stillNeededText(manaOwed)}
            </div>
            <div className="target-prompt__options mana-picker__sources">
              {manaPickerRows(fundingSources ?? [], fundingSpent, viewer, names).map((row) => (
                <button
                  key={row.instanceId}
                  type="button"
                  className={`btn${row.spent ? ' btn--ghost' : ''}`}
                  disabled={row.spent}
                  onClick={() => onTapForMana(row.instanceId)}
                >
                  {row.spent ? `✓ ${row.label}` : row.label}
                </button>
              ))}
            </div>
            <label className="mana-picker__always">
              <input
                type="checkbox"
                checked={alwaysChooseMana}
                onChange={(e) => setAlwaysChoose(e.currentTarget.checked)}
              />
              Always let me choose my mana
            </label>
            <div className="target-prompt__options">
              <button
                type="button"
                className="btn"
                disabled={!manaPickerReady}
                onClick={() => proposal && applyStep(stepProposal(proposal, { kind: 'confirm' }))}
              >
                Confirm &amp; cast
              </button>
              <ProposalCancelButton onCancel={backOut} blocked={cancelBlockedExplanation} />
            </div>
          </div>
        </div>
      )}

      {/* HOW to play this hand card, when there is more than one way. A cycling
          land is a land drop and a cycling ability; picking for the player would
          throw away exactly the decision the printed card exists to offer. */}
      {handChoice !== null && (
        <div className="target-prompt" role="dialog" aria-label="Choose how to play this card">
          <div className="target-prompt__card">
            <div className="target-prompt__title">How do you want to play {session.nameOf(handChoice)}?</div>
            {/* UX-8/UX-10 — the card provoking the choice, not just its name. */}
            <CardHover cardId={handChoiceFaceId}>
              <CardFace
                size="full"
                cardId={handChoiceFaceId}
                name={session.nameOf(handChoice)}
                explanation={explainForFace(session.state, handChoice)}
              />
            </CardHover>
            <div className="target-prompt__options">
              {playableLands.includes(handChoice) && (
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    const id = handChoice;
                    setHandChoice(null);
                    run(() => session.playLand(id));
                  }}
                >
                  Play as a land
                </button>
              )}
              {castOptions
                .filter((o) => o.instanceId === handChoice)
                .map((o, _index, all) => (
                  <button
                    // Keyed by FACE as well as instance: a split card puts two
                    // buttons here for one card, and two identical React keys
                    // would collapse them into one.
                    key={`cast:${o.instanceId}:${o.face ?? 'front'}`}
                    type="button"
                    className="btn"
                    onClick={() => {
                      setHandChoice(null);
                      onCastClick(o);
                    }}
                  >
                    {all.length > 1 ? `Cast ${o.name}` : 'Cast it'}
                  </button>
                ))}
              {cycleOptions
                .filter((o) => o.instanceId === handChoice)
                .map((o) => (
                  <button
                    key={`cycle:${o.instanceId}:${o.abilityIndex}`}
                    type="button"
                    className="btn"
                    onClick={() => onCycleClick(o)}
                  >
                    {o.label}
                  </button>
                ))}
            </div>
            <button type="button" className="btn btn--ghost" onClick={() => setHandChoice(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* MADNESS: a discarded card of the viewer's is in exile and the game is
          waiting to hear whether they cast it. Declining is the pass action the
          engine already accepts — said out loud here, because a player who does
          not know the window is open would stall the game staring at a board
          that refuses every other move. */}
      {madnessCasts.map((opt) => (
        <div
          key={`madness:${opt.instanceId}`}
          className="target-prompt"
          role="dialog"
          aria-label="Cast the discarded card for its madness cost"
        >
          <div className="target-prompt__card">
            <div className="target-prompt__title">
              {opt.name} was discarded and exiled. Cast it for its madness cost?
            </div>
            {/* UX-8/UX-10 — the exiled card itself. Exile is public, so the face
                resolves off the board's own public lookup. */}
            <CardHover cardId={faceOfInstance(opt.instanceId)}>
              <CardFace
                size="full"
                cardId={faceOfInstance(opt.instanceId)}
                name={opt.name}
                explanation={explainForFace(session.state, opt.instanceId)}
              />
            </CardHover>
            <div className="target-prompt__options">
              <button
                type="button"
                className="btn"
                disabled={!opt.affordableNow && !opt.affordableWithTap}
                onClick={() => onCastClick(opt)}
              >
                Cast for madness
              </button>
              <button type="button" className="btn btn--ghost" onClick={() => run(() => session.passPriority())}>
                Decline
              </button>
            </div>
          </div>
        </div>
      ))}

      {/* Which ability of this permanent? (a planeswalker's loyalty lines). Only
          engine-offered abilities are listed, so a used-this-turn or unpayable
          line is simply absent rather than disabled. The prompt components are
          SHARED with the online board — one loyalty UI, not two that drift. */}
      {abilitySource !== null && (
        <AbilityMenuPrompt
          sourceName={session.nameOf(abilitySource)}
          options={abilityMenu.get(abilitySource) ?? []}
          onChoose={onChooseAbility}
          onCancel={() => setAbilitySource(null)}
        />
      )}

      {/* The chosen ability's targets — one button per engine-offered legal
          target. The PICK goes into the proposal; the dispatch (with the payers,
          and with or without the §3.129 auto-tap) is the proposal's to make. */}
      {proposedAbility && proposalQuestion?.kind === 'targets' && (
        <AbilityTargetPrompt
          ability={proposedAbility}
          onPick={chooseTarget}
          onCancel={backOut}
          annotateTarget={refIndex.noteOf}
        />
      )}

      {/*
        §3.143 — WHICH PERMANENT PAYS THE SACRIFICE COST (CR 602.2b).

        THE 137-DEAD-BUTTONS PROMPT. `AbilityOption.costPayers` shipped in wave 1
        and no screen ever read it, so every "Sacrifice another creature:" ability
        — 137 of them, on 134 pool cards — submitted an activation with no
        `costInstanceIds` and died on the engine's own rejection. A cost is a
        choice exactly as a target is, so it gets what UX-8 demands of a target:
        the ACTUAL CARD FACES, not a list of names.

        Asked only when there is more than one legal payer set —
        `ASK_WHEN_ONLY_ONE_ANSWER.costPayers` is false, matching the engine's own
        rule that a question with a single legal answer is settled rather than
        put to the player.
      */}
      {proposedAbility && proposalQuestion?.kind === 'costPayers' && (
        <div className="target-prompt" role="dialog" aria-label="Choose what to sacrifice">
          <div className="target-prompt__card">
            <div className="target-prompt__title">
              {proposedAbility.sourceName} — {proposedAbility.label} Choose what to sacrifice.
            </div>
            <div className="target-prompt__options">
              {proposalQuestion.candidates.map((choice) => (
                <button
                  key={choice.instanceIds.join(',')}
                  type="button"
                  className="btn cost-payer"
                  onClick={() => choosePayers(choice)}
                >
                  {/* A payer set can name SEVERAL permanents ("sacrifice two
                      artifacts" is ONE answer naming two), so every face in it
                      is drawn. */}
                  {choice.instanceIds.map((id) => (
                    <CardHover key={id} cardId={faceOfInstance(id)}>
                      <CardFace
                        size="tile"
                        cardId={faceOfInstance(id)}
                        name={session.nameOf(id)}
                        explanation={explainForFace(session.state, id)}
                      />
                    </CardHover>
                  ))}
                  <span className="cost-payer__label">{choice.label}</span>
                </button>
              ))}
            </div>
            <ProposalCancelButton onCancel={backOut} blocked={cancelBlockedExplanation} />
          </div>
        </div>
      )}

      {/* Targeting prompt (for player/spell targets; creature targets are clicked on the board).
          §3.143 / UX-8 + UX-10: the SOURCE renders as a real face — lane P's
          `CardFace`, so a granted keyword is visible on the card you are about
          to aim — and every candidate that is a card is wrapped in the ONE hover
          funnel. Both were bare strings; the complaint was "it should be showing
          the actual card(s) that is provoking the choice - not just the card
          name". */}
      {proposedCast && castTargetQuestion && (
        <div className="target-prompt" role="dialog" aria-label="Choose a target">
          <div className="target-prompt__card">
            <div className="target-prompt__title">Choose a target for {proposedCast.name}</div>
            <CardHover cardId={castFaceId}>
              {/* UX-17 — the face carries its PROVENANCE, so a granted keyword or
                  an altered P/T is visible on the very card you are aiming. */}
              <CardFace
                size="full"
                cardId={castFaceId}
                name={proposedCast.name}
                explanation={explainForFace(session.state, proposedCast.instanceId)}
              />
            </CardHover>
            <div className="target-prompt__options">
              {targetOptions.map((opt) => (
                <CardHover
                  key={opt.kind === 'player' ? `p:${opt.player}` : `i:${opt.instanceId}`}
                  cardId={opt.kind === 'player' ? null : faceOfInstance(opt.instanceId)}
                >
                  <button
                    type="button"
                    className="btn"
                    onClick={() => chooseTarget(optionToTarget(opt))}
                  >
                    {/* Owner rides every row (§3.57): "Wall (yours)" vs "Wall (Computer’s)". */}
                    {describeCastTarget(opt, viewer, names)}
                  </button>
                </CardHover>
              ))}
            </div>
            <ProposalCancelButton onCancel={backOut} blocked={cancelBlockedExplanation} />
          </div>
        </div>
      )}

      {toast && (
        <div className="play-toast" role="status">
          {toast}
        </div>
      )}

      {/* §3.143 / UX-4 — the cancel affordance SAYS it is there, and when the
          rewind is genuinely gone it says THAT instead (UX-5's "unless the rules
          genuinely allow one"). A control that silently vanishes reads as a bug;
          `REWIND_BLOCK_EXPLANATIONS` is the vocabulary, owned beside the rule. */}
      {preCommitOpen && (
        <div className="play-cancel-hint" role="status">
          {cancelBlockedExplanation ?? `${PROPOSAL_CONFIG.cancelKey} backs out — nothing has happened yet.`}
        </div>
      )}

      {/* §3.119 — a card revealed to both players, ON the board (report 210413). */}
      {showReveal && reveal && (
        <RevealBanner reveal={reveal} onDismiss={() => setDismissedReveal(reveal.at)} />
      )}

      {/* §3.119 — where the game stops (reports 210141 / 211035 / 211359). */}
      {stopsMenuOpen && (
        <StopsMenu
          stops={stops}
          onToggleStep={(key, on) => onStops(withStepStop(stops, key, on))}
          onSwitch={(which, on) => onStops({ ...stops, [which]: on })}
          onClose={() => setStopsMenuOpen(false)}
        />
      )}

      {/* Blocker→attacker lines (§3.57) — decorative overlay, tested pairing rule. */}
      <CombatLines lines={combatLines} containerRef={boardRootRef} measureKey={session} />

      {/* Transient zone-change sprites (§3.57) — draw/mill/discard/death. */}
      <AnimationLayer
        sprites={sprites}
        boardRootRef={boardRootRef}
        tileRectOf={tileRectOf}
        onDone={retire}
      />
      <VfxLayer
        effects={vfxEffects}
        boardRootRef={boardRootRef}
        tileRectOf={tileRectOf}
        onDone={retireVfx}
      />
      {/* §3.143 / UX-15 — damage TRAVELS from source to recipient, sequenced so
          first-strike reads as two rounds rather than one blur (lane H). */}
      <DamageLayer
        beats={damageBeats}
        boardRootRef={boardRootRef}
        tileRectOf={tileRectOf}
        onDone={retireDamage}
      />
      {/* §3.143 / UX-12 + UX-13 — the advanced attackers and blockers. An
          UNCLIPPED sibling of the scene, because a transform on the tile is
          clipped by its own row (lib/play/combat-stage.ts names the four
          clipping boxes and why none of them can be relaxed). */}
      <CombatStage
        entries={stageEntries}
        boardRootRef={boardRootRef}
        midlineRef={midlineRef}
        measureKey={session}
        onPlaced={setStagedIds}
      />
      {/* §3.143 / UX-16 — the opponent's spell, held and inspectable BEFORE it
          resolves. The post-hoc feed below still reports what happened; this is
          the part that was missing. */}
      {hold && (
        <SpellHoldCard
          hold={hold}
          name={session.nameOf(hold.instanceId)}
          cardId={faceOfInstance(hold.instanceId)}
          /* UX-17 — the held spell wears its PROVENANCE too. A stack object is
             public, so explaining it leaks nothing the viewer cannot already
             read off the stack panel. */
          explanation={explainForFace(session.state, hold.instanceId)}
          opponentName={names[hold.controller]}
          {...(onHoldPointer ? { onPointer: onHoldPointer } : {})}
          {...(onHoldExtend ? { onExtend: onHoldExtend } : {})}
          {...(onHoldRelease ? { onRelease: onHoldRelease } : {})}
        />
      )}
      <OpponentActionFeed notes={opponentNotes} opponentName={names[otherOf(viewer)]} />
    </div>
  );
}

/**
 * §3.143 / UX-4 + UX-5 — THE ONE CANCEL CONTROL, WHICH EXPLAINS ITSELF.
 *
 * Every pre-commit prompt on this board ends with this, so "can I still back
 * out, and if not why not?" is answered the same way everywhere (rule 12). When
 * the rewind is gone the button does **not** silently vanish and is **not**
 * greyed out without a word: it is replaced by the proposal's own sentence from
 * `REWIND_BLOCK_EXPLANATIONS`, because Caleb's whole complaint is about not
 * understanding what is happening.
 */
function ProposalCancelButton({
  onCancel,
  blocked,
}: {
  onCancel: () => void;
  /** The honest refusal's sentence, or null while cancelling is still legal. */
  blocked: string | null;
}): ReactElement {
  if (blocked !== null) {
    return (
      <span className="target-prompt__blocked" role="status">
        {blocked}
      </span>
    );
  }
  return (
    <button type="button" className="btn btn--ghost" onClick={onCancel}>
      Cancel
    </button>
  );
}

/**
 * §3.143 / UX-16 — AN OPPONENT'S SPELL, HELD ON SCREEN.
 *
 * Caleb: *"when an opponent casts a sorcery or instant card, I need to be able
 * to see it and inspect the card before it goes off - even if I have no
 * instant-speed things I could do in response … Right now, they just happen
 * invisibly and I have no idea why things are happening."*
 *
 * The card is drawn by lane P's `CardFace` at full size and wrapped in the ONE
 * hover funnel, so the held card is inspected exactly the way every other card
 * on this surface is. Moving the pointer onto it extends the hold (bounded by
 * `pointerHoldMs`); "Keep looking" adds one `extendMs`; "Let it resolve" ends
 * it now — so it is never a click-through tax on a player who does not want it.
 */
function SpellHoldCard({
  hold,
  name,
  cardId,
  explanation,
  opponentName,
  onPointer,
  onExtend,
  onRelease,
}: {
  hold: SpellHold;
  name: string;
  cardId: string | null;
  /** Core's characteristic breakdown for the held spell (§3.143 / UX-17). */
  explanation: CharacteristicExplanation | undefined;
  opponentName: string;
  onPointer?: (over: boolean) => void;
  onExtend?: () => void;
  onRelease?: () => void;
}): ReactElement {
  return (
    <div
      className="spell-hold"
      role="dialog"
      aria-label={`${opponentName} is casting ${name}`}
      onPointerEnter={() => onPointer?.(true)}
      onPointerLeave={() => onPointer?.(false)}
    >
      {/* The verb comes from the KIND table, not from an `if`: "is casting" and
          "is activating" are different facts and a third kind is a row. */}
      <span className="spell-hold__who">
        {opponentName} {HOLD_KINDS[hold.kind].announce}:
      </span>
      <CardHover cardId={cardId}>
        <CardFace size="full" cardId={cardId} name={name} explanation={explanation} />
      </CardHover>
      <span className="spell-hold__name">{name}</span>
      <span className="spell-hold__hint">
        Hover the card to keep reading it — it resolves on its own when you stop.
      </span>
      <div className="spell-hold__actions">
        <button type="button" className="btn" onClick={onExtend}>
          Keep looking
        </button>
        <button type="button" className="btn btn--ghost" onClick={onRelease}>
          Let it resolve
        </button>
      </div>
    </div>
  );
}

/** The action bar with phase-appropriate primary controls. */
function ActionBar({
  session,
  step,
  isViewersPriority,
  inBlockStep,
  hint,
  chosenAttackers,
  blockAssign,
  eligibleAttackers,
  waitingText,
  alwaysChooseMana,
  stackNonEmpty,
  fullControl,
  onFullControl,
  onOpenStops,
  suggested,
  copilotOn,
  onCopilot,
  soundOn,
  onToggleSound,
  onAlwaysChooseMana,
  onPass,
  onDeclareAttackers,
  onDeclareBlockers,
}: {
  session: GameSession;
  viewer: PlayerId;
  step: string;
  /** Overrides the generic "waiting for …" line (e.g. while a choice is parked). */
  waitingText?: string;
  isViewersPriority: boolean;
  inBlockStep: boolean;
  /** The per-step guidance line — the shared, tested `actionBarHint` rule. */
  hint: string;
  chosenAttackers: Set<InstanceId>;
  blockAssign: Map<InstanceId, InstanceId>;
  eligibleAttackers: Set<InstanceId>;
  /** The persisted "always let me choose my mana" preference (§3.60). */
  alwaysChooseMana: boolean;
  /** Something is waiting to resolve — the pass button RESOLVES it (§3.119). */
  stackNonEmpty: boolean;
  /** "Full control": stop in every window where anything could be done (§3.119). */
  fullControl: boolean;
  onFullControl: (on: boolean) => void;
  /** Open the per-step stops menu (§3.119). */
  onOpenStops: () => void;
  /** The co-pilot's move is a button in THIS bar (§3.67) — mark it. */
  suggested: boolean;
  copilotOn: boolean;
  onCopilot: (on: boolean) => void;
  /** Whether procedural game audio is on (§3.130). */
  soundOn: boolean;
  onToggleSound: () => void;
  onAlwaysChooseMana: (always: boolean) => void;
  onPass: () => void;
  onDeclareAttackers: (ids: readonly InstanceId[]) => void;
  onDeclareBlockers: (blocks: readonly { blocker: InstanceId; attacker: InstanceId }[]) => void;
}): ReactElement {
  if (!isViewersPriority) {
    return (
      <div className="action-bar">
        <span className="action-bar__wait">
          {waitingText ?? `Waiting for ${session.names[session.priorityPlayer]}…`}
        </span>
      </div>
    );
  }

  const inAttackStep = step === 'declareAttackers' && eligibleAttackers.size > 0;

  return (
    /* §3.67 — outlined when the co-pilot's move is one of THESE buttons. Only
       this bar can carry it: the waiting bar above renders precisely when it is
       not the viewer's decision, and the co-pilot never advises then. */
    <div className={`action-bar${suggested ? ' action-bar--suggested' : ''}`}>
      {inAttackStep && (
        <button
          type="button"
          className="btn btn--primary"
          onClick={() => onDeclareAttackers([...chosenAttackers])}
        >
          {chosenAttackers.size > 0 ? `Attack with ${chosenAttackers.size}` : 'Attack with none'}
        </button>
      )}
      {inBlockStep && (
        <button
          type="button"
          className="btn btn--primary"
          onClick={() =>
            onDeclareBlockers([...blockAssign].map(([blocker, attacker]) => ({ blocker, attacker })))
          }
        >
          {blockAssign.size > 0 ? `Confirm ${blockAssign.size} block${blockAssign.size === 1 ? '' : 's'}` : 'No blocks'}
        </button>
      )}
      {/* §3.119 — ONE CLICK, and it says what it does. With something on the
          stack this is the button that resolves it, which is the whole answer
          to "the game swallowed my card" (report 20260901_213414). */}
      <button type="button" className={`btn${stackNonEmpty ? ' btn--primary' : ''}`} onClick={onPass}>
        {passButtonLabel(step, stackNonEmpty)}
      </button>
      {/* §3.119 — the two priority controls players change mid-game. The other
          twenty live in the menu; putting them all in the bar is the bar
          nobody reads. */}
      <button
        type="button"
        className={`btn btn--toggle${fullControl ? ' btn--toggle-on' : ''}`}
        aria-pressed={fullControl}
        title="Hold priority in every window where you could act"
        onClick={() => onFullControl(!fullControl)}
      >
        {fullControl ? '⏸ Full control' : '⏸ Auto-pass'}
      </button>
      <button type="button" className="btn btn--ghost" title="Choose which steps stop" onClick={onOpenStops}>
        ⚙ Stops
      </button>
      {/* §3.60 — the persisted "let me place my own mana" setting, always in
          reach rather than buried in a settings screen: it is a decision players
          change mid-game, spell by spell. Pressed = the picker opens for every
          cast that has a real choice; unpressed = auto-tap, as before. */}
      <button
        type="button"
        className={`btn btn--toggle${alwaysChooseMana ? ' btn--toggle-on' : ''}`}
        aria-pressed={alwaysChooseMana}
        title="Always let me choose which mana pays"
        onClick={() => onAlwaysChooseMana(!alwaysChooseMana)}
      >
        {alwaysChooseMana ? '⛁ Choosing mana' : '⛁ Auto mana'}
      </button>
      {/* §3.67 — ask the AI what it would do in YOUR seat. Beside the mana
          toggle because it is the same kind of setting: a thing players switch
          on mid-game when a board gets hard, not a preferences-screen decision. */}
      <button
        type="button"
        className={`btn btn--toggle${copilotOn ? ' btn--toggle-on' : ''}`}
        aria-pressed={copilotOn}
        title="Show what the AI would do on your turn"
        onClick={() => onCopilot(!copilotOn)}
      >
        {copilotOn ? '🧭 Co-pilot on' : '🧭 Co-pilot'}
      </button>
      {/* §3.130 — mute the procedural game audio. A player setting, so it lives
          beside the others; the click doubles as the gesture that unlocks the
          browser's AudioContext. */}
      <button
        type="button"
        className={`btn btn--toggle${soundOn ? ' btn--toggle-on' : ''}`}
        aria-pressed={soundOn}
        title={soundOn ? 'Mute game sounds' : 'Unmute game sounds'}
        onClick={onToggleSound}
      >
        {soundOn ? '🔊 Sound' : '🔇 Muted'}
      </button>
      <span className="action-bar__hint">{hint}</span>
    </div>
  );
}

function otherOf(p: PlayerId): PlayerId {
  return p === 'A' ? 'B' : 'A';
}

/**
 * Find an instance in any PUBLIC zone, plus the stack.
 *
 * ⚠️ The battlefield alone is not enough, which is what made UX-8 miss every
 * modal spell: a per-mode target question carries the SPELL's instance id, and
 * a spell is on the STACK. Lane C measured the cost of that omission at 110
 * modal modes across 60 pool cards, each of which showed a named placeholder
 * where the card should have been.
 *
 * Public zones only — a hand is hidden information and this result is used to
 * DRAW A CARD FACE.
 */
function findInstanceAnywhere(state: GameState, id: InstanceId): { def: CardDefinition } | undefined {
  for (const perm of state.battlefield) if (perm.instanceId === id) return perm;
  for (const pid of ['A', 'B'] as const) {
    const player = state.players[pid];
    for (const zone of [player.graveyard, player.exile]) {
      const hit = zone.find((c) => c.instanceId === id);
      if (hit) return hit;
    }
  }
  for (const obj of state.stack) {
    if (obj.kind === 'spell' && obj.instanceId === id) return obj.card;
  }
  return undefined;
}

/** The definition of whatever asked a question — see {@link findInstanceAnywhere}. */
function findDefAnywhere(state: GameState, id: InstanceId): CardDefinition | undefined {
  return findInstanceAnywhere(state, id)?.def;
}
