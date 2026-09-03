import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { createRng } from '@jonny-boi/core';
import { createDefaultAiRegistry, DEFAULT_PILOT_ID } from '@jonny-boi/ai';
import type { InstanceId, ManaCost, PlayerId } from '@jonny-boi/core';
import type {
  AbilityOption,
  GameSession,
  CastOption,
  CycleOption,
  SubmitResult,
} from '../../lib/play/session.js';
import { buildBoardView } from '../../lib/play/view-model.js';
import { isBoardTargetOption, optionToTarget, type TargetOption } from '../../lib/play/targeting.js';
import { stepLabel, TOAST_MS, COPILOT_ADVICE_SEED } from '../../lib/play/play-config.js';
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
import { StopsMenu } from './StopsMenu.js';
import './board-clarity.css';
import { blockerLinePairs } from '../../lib/play/combat-lines.js';
import { groupJailedByJailer, jailSourcesOf } from '../../lib/play/jail-view.js';
import { describeCastTarget, makeRefIndex, type KnownRef } from '../../lib/play/option-labels.js';
import type { AnimationCardInfo } from '../../lib/play/animations.js';
import { AnimationLayer, useZoneAnimations } from './AnimationLayer.js';
import { CombatLines } from './CombatLines.js';
import './action-bar.css';
import './mana-picker.css';
import './board-fit.css';
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
 * A cast paused so the player can say WHICH sources pay for it (§3.60).
 *
 * The `working` session is the whole rollback story: taps are folded into it and
 * nothing reaches `onSubmit` until Confirm, so Cancel is `setManaPicker(null)`
 * and the game is exactly where it was — no untap loop, no compensating action,
 * no half-tapped board.
 */
interface ManaPickerState {
  /** The cast that is waiting, with the cost it will actually be charged. */
  readonly cast: CastOption;
  /** Targets already chosen for it (the target prompt runs first). */
  readonly targets: readonly (InstanceId | PlayerId)[];
  /** The session with this payment's taps folded in so far. */
  readonly working: GameSession;
  /**
   * The sources that were tappable when the picker opened, snapshotted so rows
   * stay put as they are spent (see `manaPickerRows`).
   */
  readonly sources: readonly ManaPickerSource[];
  /** Which of them this payment has already spent. */
  readonly spent: ReadonlySet<InstanceId>;
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
}: {
  session: GameSession;
  viewer: PlayerId;
  /** Apply a session-producing action; PlayView stores the new session. */
  onSubmit: (run: () => SubmitResult) => void;
  onConcede: () => void;
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
   * A cast whose mana the player is placing by hand (§3.60). While it stands, it
   * holds a WORKING session — a private fold of `tapForMana` submits that the
   * board renders from and that is committed on Confirm. Cancel simply drops it,
   * and the discarded session carries its own taps and its own action-log
   * entries away with it (§3.58), so a cancelled cast leaves no trace at all.
   */
  const [manaPicker, setManaPicker] = useState<ManaPickerState | null>(null);
  /**
   * THE BOARD'S SOURCE OF TRUTH. Everything below reads `session`, so the
   * picker's uncommitted taps light up the board, empty the pool readout, and
   * feed the "still needed" line through exactly the same derivations a
   * committed tap does — one code path, not a preview that can disagree.
   */
  const session = manaPicker?.working ?? committedSession;
  const names = session.names;
  const view = useMemo(() => buildBoardView(session.state, viewer, names), [session, viewer, names]);
  const step = session.state.step;

  // --- transient interaction state ---------------------------------------------
  // A pending cast awaiting a target selection.
  const [pendingCast, setPendingCast] = useState<CastOption | null>(null);
  // Whether THAT cast asked for the mana picker (the per-cast way in), carried
  // across the target prompt so the request survives choosing a target.
  const [pendingCastAsks, setPendingCastAsks] = useState(false);
  // Attacker selection (active player, declareAttackers).
  const [chosenAttackers, setChosenAttackers] = useState<Set<InstanceId>>(new Set());
  // Per-attacker walker assignment: attacker -> the defending planeswalker it
  // attacks. An attacker with no entry attacks the defending player (the default).
  const [walkerAssign, setWalkerAssign] = useState<Map<InstanceId, InstanceId>>(new Map());
  // A permanent whose activated-ability menu is open (click a walker → its abilities).
  const [abilitySource, setAbilitySource] = useState<InstanceId | null>(null);
  // An ability chosen from that menu, awaiting its target choice.
  const [pendingAbility, setPendingAbility] = useState<AbilityOption | null>(null);
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

  const resetTransient = (): void => {
    setPendingCast(null);
    setPendingCastAsks(false);
    setChosenAttackers(new Set());
    setWalkerAssign(new Map());
    setBlockAssign(new Map());
    setActiveBlockTarget(null);
    setPendingManaTap(null);
    setAbilitySource(null);
    setPendingAbility(null);
    setHandChoice(null);
    setManaPicker(null);
  };

  const notify = (message: string): void => {
    setToast(message);
    window.setTimeout(() => setToast(null), TOAST_MS);
  };

  const run = (fn: () => SubmitResult): void => {
    const result = fn();
    if (result.rejected) {
      notify(result.rejected);
      return;
    }
    resetTransient();
    onSubmit(() => result);
  };

  // A parked question preempts everything: while it stands the engine offers no
  // other action, so the board's own controls must go quiet until it is answered.
  const pendingChoice = session.pendingChoice;
  const isViewersPriority = session.priorityPlayer === viewer && !pendingChoice;
  const playableLands = isViewersPriority ? session.playableLands() : [];
  const castOptions = isViewersPriority ? session.castOptions() : [];
  // Flashback: cards castable OUT OF the viewer's graveyard, same option shape as
  // the hand so the whole cast flow below (target pick → castWithAutoTap) is shared.
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

  const onChooseAbility = (opt: AbilityOption): void => {
    setAbilitySource(null);
    if (opt.targets === null) {
      run(() => session.activateAbility(opt.instanceId, opt.abilityIndex));
    } else {
      setPendingAbility(opt);
    }
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
   * rows take. While a picker stands the tap folds into its private working
   * session; otherwise it commits as it always has. Splitting these would be two
   * answers to "what does clicking a land do".
   */
  const tapSource = (instanceId: InstanceId, mode: number | undefined): void => {
    setPendingManaTap(null);
    if (!manaPicker) {
      run(() => session.tapForMana(instanceId, mode));
      return;
    }
    const tapped = manaPicker.working.tapForMana(instanceId, mode);
    if (tapped.rejected) {
      notify(tapped.rejected);
      return;
    }
    const spent = new Set(manaPicker.spent);
    spent.add(instanceId);
    setManaPicker({ ...manaPicker, working: tapped.session, spent });
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
  const manaOwed = manaPicker
    ? manaStillNeeded(session.state.players[session.priorityPlayer].manaPool, manaPicker.cast.cost ?? {})
    : EMPTY_COST;

  /**
   * Whether Confirm may fire. Read off the ENGINE'S own offer — the paused cast
   * re-derived from the working session, whose `affordableNow` is the engine
   * saying the floating pool covers the cost. The readout above is a label;
   * this is the decision, and the two must not be the same opinion twice.
   */
  const manaPickerReady =
    manaPicker !== null &&
    [...castOptions, ...graveyardCasts, ...madnessCasts].some(
      (option) =>
        castOptionKey(option) === castOptionKey(manaPicker.cast) && option.affordableNow,
    );

  /** Open the picker for a cast whose targets are already settled. */
  const openManaPicker = (cast: CastOption, targets: readonly (InstanceId | PlayerId)[]): void => {
    const sources: ManaPickerSource[] = [];
    for (const [instanceId, options] of tapMenu) {
      const perm = session.state.battlefield.find((p) => p.instanceId === instanceId);
      if (!perm || perm.controller !== viewer) continue;
      sources.push({ instanceId, name: perm.def.name, controller: perm.controller, options });
    }
    resetTransient();
    setManaPicker({ cast, targets, working: committedSession, sources, spent: new Set() });
  };

  /**
   * Commit the picked payment. The pool already covers the cost (Confirm is
   * disabled until it does), so `castWithAutoTap` taps NOTHING more — it just
   * casts, and its own rollback still guards a cast the engine refuses.
   */
  const confirmManaPicker = (): void => {
    const picker = manaPicker;
    if (!picker) return;
    const result = picker.working.castWithAutoTap(
      picker.cast.instanceId,
      picker.targets,
      picker.cast.fromZone ?? 'hand',
      picker.cast.face,
    );
    if (result.rejected) {
      notify(result.rejected);
      return;
    }
    setManaPicker(null);
    resetTransient();
    onSubmit(() => result);
  };

  /** Abandon the payment. Dropping the working session IS the rollback. */
  const cancelManaPicker = (): void => {
    setManaPicker(null);
    setPendingManaTap(null);
  };

  const setAlwaysChoose = (always: boolean): void => {
    setAlwaysChooseMana(always);
    saveManaChoicePref(always);
  };

  // --- targeting -----------------------------------------------------------------
  // Asked of the SESSION with the cast option itself (§3.119), so core's own
  // enumerator answers with the caster and the card in hand: the set the engine
  // will accept, and nothing wider. Bug report 20260901_211035 was the opposite
  // — the board's private table did not know `blinkTarget` targeted anything,
  // so Cloudshift was cast with no target and refused.
  const targetOptions: readonly TargetOption[] = pendingCast ? session.castTargets(pendingCast) : [];

  /**
   * Finish a cast whose targets are settled: either hand the payment to the
   * player (§3.60) or auto-tap it exactly as before.
   *
   * `requested` is the per-cast way in — the hand card's "choose mana" chip —
   * and it is still subject to the same "is there a real choice?" gate as the
   * persisted setting, so neither route can raise a picker with one button in it.
   */
  const startCast = (
    cast: CastOption,
    targets: readonly (InstanceId | PlayerId)[],
    requested = false,
  ): void => {
    const ask = shouldAskForMana({
      always: alwaysChooseMana,
      requested,
      choiceExists: castsWithManaChoice.has(castOptionKey(cast)),
    });
    if (ask) {
      openManaPicker(cast, targets);
      return;
    }
    // `fromZone` rides the option: a flashback cast names its graveyard source
    // (and pays the flashback cost inside castWithAutoTap); hand casts omit it.
    run(() => session.castWithAutoTap(cast.instanceId, targets, cast.fromZone ?? 'hand', cast.face));
  };

  const commitCast = (targets: readonly (InstanceId | PlayerId)[]): void => {
    const cast = pendingCast;
    if (!cast) return;
    startCast(cast, targets, pendingCastAsks);
  };

  const onCastClick = (opt: CastOption, requested = false): void => {
    if (opt.needsTarget) {
      setPendingCast(opt);
      setPendingCastAsks(requested);
    } else {
      startCast(opt, [], requested);
    }
  };

  const onCycleClick = (opt: CycleOption): void => {
    setHandChoice(null);
    run(() => session.cycleWithAutoTap(opt.instanceId, opt.abilityIndex));
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
    if (manaPicker) {
      const markers = new Map<InstanceId, string>();
      for (const id of manaPicker.spent) markers.set(id, 'paying');
      for (const id of tappable) {
        const options = tapMenu.get(id) ?? [];
        markers.set(id, isModalTap(options) ? 'pay: any' : `pay: ${options[0]?.label ?? ''}`);
      }
      return {
        selectableIds: tappable,
        selectedIds: new Set(manaPicker.spent),
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
    if (pendingCast) return targetInteraction(view.self.permanents.map((p) => p.instanceId));
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
    if (pendingCast) return targetInteraction(view.opponent.permanents.map((p) => p.instanceId));
    return undefined;
  }

  function targetInteraction(ownedIds: readonly InstanceId[]): PermInteraction | undefined {
    if (!pendingCast) return undefined;
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
      onClick: (id) => commitCast([id]),
    };
  }

  // --- render --------------------------------------------------------------------
  const statusText = `Turn ${view.turnNumber} · ${stepLabel(step)} · ${names[view.activePlayer]}'s turn`;

  // Which blocker→attacker lines to draw this frame (pure rule, tested).
  const combatLines = blockerLinePairs({
    step,
    declaredBlocks: view.combat?.blocks,
    draftAssign: blockAssign,
  });

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
    <div className="play-board" ref={boardRootRef}>
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

      {/* Center column: stack + log. */}
      <div className="play-board__center">
        <StackPanel stack={view.stack} names={names} nameOf={session.nameOf} />
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
      </div>

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
        onAlwaysChooseMana={setAlwaysChoose}
        onPass={() => run(() => session.passPriority())}
        onDeclareAttackers={(ids) =>
          run(() => session.declareAttackers(ids, Object.fromEntries(walkerAssign)))
        }
        onDeclareBlockers={(blocks) => run(() => session.declareBlockers(blocks))}
      />

      {/*
        A question a resolving spell parked. Rendered ONLY for the seat it was
        addressed to — its candidates can include cards the other seat may not see,
        so the chooser check is a hidden-information guard, not just routing. The
        hotseat handoff already gates the device on the engine moving priority to
        the chooser, so in practice the viewer IS the chooser here.
      */}
      {pendingChoice && isChoiceForViewer(pendingChoice, viewer) && (
        <ChoicePrompt
          choice={pendingChoice}
          names={names}
          onAnswer={(answer) => run(() => session.answerChoice(answer))}
          zoneOf={refIndex.zoneOf}
        />
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
      {manaPicker && !pendingManaTap && (
        <div className="target-prompt mana-picker" role="dialog" aria-label="Choose which mana pays">
          <div className="target-prompt__card">
            <div className="target-prompt__title">Pay for {manaPicker.cast.name}</div>
            <div className="mana-picker__owed" role="status">
              {stillNeededText(manaOwed)}
            </div>
            <div className="target-prompt__options mana-picker__sources">
              {manaPickerRows(manaPicker.sources, manaPicker.spent, viewer, names).map((row) => (
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
                onClick={confirmManaPicker}
              >
                Confirm &amp; cast
              </button>
              <button type="button" className="btn btn--ghost" onClick={cancelManaPicker}>
                Cancel
              </button>
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

      {/* The chosen ability targets — one button per engine-offered legal target. */}
      {pendingAbility && pendingAbility.targets !== null && (
        <AbilityTargetPrompt
          ability={pendingAbility}
          onPick={(target) =>
            run(() => session.activateAbility(pendingAbility.instanceId, pendingAbility.abilityIndex, [target]))
          }
          onCancel={() => setPendingAbility(null)}
          annotateTarget={refIndex.noteOf}
        />
      )}

      {/* Targeting prompt (for player/spell targets; creature targets are clicked on the board). */}
      {pendingCast && (
        <div className="target-prompt" role="dialog" aria-label="Choose a target">
          <div className="target-prompt__card">
            <div className="target-prompt__title">Choose a target for {pendingCast.name}</div>
            <div className="target-prompt__options">
              {targetOptions.length === 0 && <span className="seat__empty">No legal targets — cancel.</span>}
              {targetOptions.map((opt) => (
                <button
                  key={opt.kind === 'player' ? `p:${opt.player}` : `i:${opt.instanceId}`}
                  type="button"
                  className="btn"
                  onClick={() => commitCast([optionToTarget(opt)])}
                >
                  {/* Owner rides every row (§3.57): "Wall (yours)" vs "Wall (Computer’s)". */}
                  {describeCastTarget(opt, viewer, names)}
                </button>
              ))}
            </div>
            <button type="button" className="btn btn--ghost" onClick={() => setPendingCast(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {toast && (
        <div className="play-toast" role="status">
          {toast}
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
      <span className="action-bar__hint">{hint}</span>
    </div>
  );
}

function otherOf(p: PlayerId): PlayerId {
  return p === 'A' ? 'B' : 'A';
}
