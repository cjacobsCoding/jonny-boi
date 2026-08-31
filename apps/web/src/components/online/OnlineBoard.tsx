import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { actionBarHint } from '../../lib/play/action-hints.js';
import { blockerLinePairs } from '../../lib/play/combat-lines.js';
import { groupJailedByJailer, jailSourcesOf } from '../../lib/play/jail-view.js';
import {
  describeTargetSetWithOwners,
  makeRefIndex,
  type KnownRef,
} from '../../lib/play/option-labels.js';
import { CombatLines } from '../play/CombatLines.js';
import type {
  CardDefinition,
  CardInstance,
  CastZone,
  GameAction,
  InstanceId,
  PlayerId,
} from '@jonny-boi/core';
import { isPlaneswalker } from '@jonny-boi/core';
import { stepLabel } from '../../lib/play/play-config.js';
import { maskedViewToBoardView } from '../../lib/online/board-adapter.js';
import { castSequence, castableWithTaps, graveyardCastableWithTaps } from '../../lib/online/auto-tap.js';
import { alreadyPassedFrame, shouldAutoPass } from '../../lib/online/auto-pass.js';
import { DRAG_ID_ATTR, useDragToPlay } from '../../lib/play/useDragToPlay.js';
import { idleTurnNote, reasonCardIsDisabled } from '../../lib/online/why-disabled.js';
import { graveyardPanelView } from '../../lib/play/graveyard-cast.js';
import { AUTO_PASS_DELAY_MS, AUTO_PASS_EMPTY_PRIORITY } from '../../lib/online/online-config.js';
import { legalTargets, optionToTarget, targetRequirement } from '../../lib/play/targeting.js';
import { buildDeclareAttackersAction, type AbilityOption } from '../../lib/play/session.js';
import type { GameFrame } from '../../lib/online/online-state.js';
import {
  abilityChoices,
  castChoices,
  declareAttackersAction,
  declareBlockersAction,
  graveyardCastChoices,
  passAction,
  playableLandIds,
  type CastChoice,
} from '../../lib/online/legal-actions.js';
import { answerChoiceAction, onlineChoiceView } from '../../lib/online/pending-choice.js';
import { isModalTap, manaTapMenu, tappableIds, type ManaTapOption } from '../../lib/play/mana-tap.js';
import { ChoicePrompt } from '../play/ChoicePrompt.js';
import { AbilityMenuPrompt, AbilityTargetPrompt } from '../play/AbilityPrompts.js';
import { GraveyardPanel } from '../play/GraveyardPanel.js';
import { SeatPanel, type PermInteraction } from '../play/SeatPanel.js';
import { StackPanel } from '../play/StackPanel.js';
import { PlayCard, CardBack } from '../play/PlayCard.js';
import { CardZoomOverlay } from '../play/CardZoomOverlay.js';
import '../play/action-bar.css';

/**
 * The in-game board for ONLINE play. It renders the server-pushed `MaskedGameView`
 * (adapted to the shared `BoardView`) and offers ONLY the server's `legalActions` —
 * so an illegal move can't be built. On a choice it calls `onAction(GameAction)`,
 * which the hook serializes to `submitAction`. Unlike hotseat there is NO device
 * handoff: when it's not our turn we render a clear "Waiting for opponent…" state.
 *
 * It reuses `SeatPanel`/`StackPanel`/`PlayCard`/`CardBack`/`ChoicePrompt`/
 * `AbilityPrompts`/`GraveyardPanel` verbatim (DRY) — the adapter and the pure
 * `legal-actions` derivations are the only new glue. Every affordance the hotseat
 * board has is present here too (walker attacks, loyalty abilities, flashback from
 * the graveyard), driven off the masked view instead of a local engine: a mechanic
 * that ships must not be invisible online. The game log uses the server's lines.
 */
export function OnlineBoard({
  frame,
  names,
  onAction,
  onConcede,
}: {
  frame: GameFrame;
  names: Readonly<Record<PlayerId, string>>;
  onAction: (action: GameAction) => void;
  onConcede: () => void;
}): ReactElement {
  const { view: masked, legalActions, yourTurn, log } = frame;
  const view = useMemo(() => maskedViewToBoardView(masked, names), [masked, names]);
  const step = masked.step;

  const lands = useMemo(() => playableLandIds(legalActions), [legalActions]);
  const casts = useMemo(() => castChoices(legalActions), [legalActions]);
  /** Flashback casts the server is ALREADY offering (its pool covers the cost). */
  const graveyardCasts = useMemo(() => graveyardCastChoices(legalActions), [legalActions]);
  const attackTemplate = useMemo(() => declareAttackersAction(legalActions), [legalActions]);
  const blockTemplate = useMemo(() => declareBlockersAction(legalActions), [legalActions]);
  const pass = useMemo(() => passAction(legalActions), [legalActions]);
  // A resolving card parked a question. The server masks it per seat, so the board
  // either has the real question to render or only a line naming who is answering.
  const { answerable: ownChoice, waitingText } = useMemo(
    () => onlineChoiceView(masked, names),
    [masked, names],
  );

  // Manual mana tapping, from the SAME pure menu the hotseat board uses. Without a
  // way to tap, the server never offers a `castSpell` (it only lists spells the
  // floating pool already covers), so online play could not cast anything at all —
  // and a card that asks a question could never be reached.
  const tapMenu = useMemo(() => manaTapMenu(masked, legalActions), [masked, legalActions]);
  const tappable = useMemo(() => tappableIds(tapMenu, masked, masked.viewer), [tapMenu, masked]);

  // Cards the server hasn't offered a cast for yet, but which we could pay for by
  // tapping. Without this the online seat can never cast anything at all: the
  // server only lists `castSpell` once the pool already covers the cost, and this
  // board has no other way to tap a land.
  /** The viewer's own hand instances (present only for their own seat). */
  const handCardOf = (id: InstanceId): CardInstance | undefined =>
    (masked.players[masked.viewer].hand ?? []).find((c) => c.instanceId === id);

  /** The viewer's graveyard instances (a PUBLIC zone — always present, both seats). */
  const ownGraveyard = masked.players[masked.viewer].graveyard;
  const graveyardCardOf = (id: InstanceId): CardInstance | undefined =>
    ownGraveyard.find((c) => c.instanceId === id);

  const tapCastable = useMemo(
    () => castableWithTaps(masked, masked.viewer, masked.players[masked.viewer].hand ?? [], legalActions),
    [masked, legalActions],
  );

  /** The sorcery-speed window, from public facts the masked view already carries. */
  const sorceryWindowOpen =
    masked.activePlayer === masked.viewer &&
    (step === 'precombatMain' || step === 'postcombatMain') &&
    masked.stack.length === 0;

  /** Flashback casts we could fund by tapping first (the server lists none of these). */
  const graveyardTapCastable = useMemo(
    () => graveyardCastableWithTaps(masked, masked.viewer, ownGraveyard, legalActions, sorceryWindowOpen),
    [masked, ownGraveyard, legalActions, sorceryWindowOpen],
  );

  // Transient interaction state.
  const [pendingCast, setPendingCast] = useState<CastChoice | null>(null);
  /** Taps that must be sent before the pending cast (empty for an offered cast). */
  const [pendingTaps, setPendingTaps] = useState<readonly GameAction[]>([]);
  /** A modal source the player tapped BY HAND, awaiting the colour they want. */
  const [pendingManaTap, setPendingManaTap] = useState<readonly ManaTapOption[] | null>(null);
  const [chosenAttackers, setChosenAttackers] = useState<Set<InstanceId>>(new Set());
  /** attacker → the defending planeswalker it attacks (absent = attacks the player). */
  const [walkerAssign, setWalkerAssign] = useState<Map<InstanceId, InstanceId>>(new Map());
  /** A permanent whose activated-ability menu is open (a walker's loyalty lines). */
  const [abilitySource, setAbilitySource] = useState<InstanceId | null>(null);
  /** An ability chosen from that menu, awaiting its target choice. */
  const [pendingAbility, setPendingAbility] = useState<AbilityOption | null>(null);
  const [blockAssign, setBlockAssign] = useState<Map<InstanceId, InstanceId>>(new Map());
  const [activeBlockTarget, setActiveBlockTarget] = useState<InstanceId | null>(null);
  /** The card being inspected full-size, if any (report 20260825_210026). */
  const [zoomed, setZoomed] = useState<{ cardId: string; name: string } | null>(null);
  /** The viewer's graveyard panel (the flashback affordance's entry point). */
  const [graveyardOpen, setGraveyardOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  /** A transient board message (the hotseat board's toast, same feel). */
  const flash = (message: string): void => {
    setToast(message);
    window.setTimeout(() => setToast(null), TOAST_MS);
  };

  const reset = (): void => {
    setPendingCast(null);
    setPendingTaps([]);
    setPendingManaTap(null);
    setChosenAttackers(new Set());
    setWalkerAssign(new Map());
    setBlockAssign(new Map());
    setActiveBlockTarget(null);
    setAbilitySource(null);
    setPendingAbility(null);
  };

  const submit = (action: GameAction): void => {
    reset();
    onAction(action);
  };

  /**
   * Send an ordered sequence (taps, then the cast). The server applies messages in
   * order, so each tap is legal on arrival and the cast is legal once the last one
   * lands. It still validates every one — a rejection just stops the sequence.
   */
  const submitSequence = (actions: readonly GameAction[]): void => {
    reset();
    for (const action of actions) onAction(action);
  };

  /**
   * Advance automatically through priority windows where passing is the ONLY legal
   * action. Without this a new game opens in `upkeep` and needs four `Pass / advance`
   * clicks (two per seat, through `upkeep` and `draw`) before the first land can be
   * played — with the whole hand greyed out and the bar still reading "Your move".
   *
   * `passedFrame` rate-limits it to once per server-pushed frame: a re-render must
   * not spend a second pass, but a NEW frame in the same step legitimately may (see
   * `alreadyPassedFrame` for the declareBlockers case that rules out a step key).
   */
  const passedFrame = useRef<GameFrame | null>(null);
  const autoPass =
    AUTO_PASS_EMPTY_PRIORITY &&
    !!pass &&
    shouldAutoPass({
      yourTurn,
      legalActions,
      stackSize: masked.stack.length,
      awaitingOwnChoice: !!ownChoice,
      // A flashback the seat could fund is a real play, exactly like a hand card —
      // auto-passing over it would make the new affordance unreachable in the very
      // windows the card is castable in.
      tapCastableCount: tapCastable.size + graveyardTapCastable.size,
    });

  useEffect(() => {
    if (!autoPass || !pass) return;
    if (alreadyPassedFrame(passedFrame.current, frame)) return;
    const handle = window.setTimeout(() => {
      // Mark the frame only once the pass actually GOES OUT. Marking it at
      // schedule time instead deadlocks under StrictMode's double-invoke: the
      // first run marks and schedules, the cleanup cancels the timer, and the
      // second run sees the mark and declines to reschedule — so the game sits
      // saying "advancing…" forever.
      passedFrame.current = frame;
      onAction(pass);
    }, AUTO_PASS_DELAY_MS);
    return () => window.clearTimeout(handle);
  }, [autoPass, pass, frame, onAction]);

  // --- casting -------------------------------------------------------------------
  const onCastClick = (choice: CastChoice): void => {
    if (choice.canCastUntargeted) {
      submit({
        kind: 'castSpell',
        player: masked.viewer,
        instanceId: choice.instanceId,
        targets: [],
        ...(choice.fromZone === 'graveyard' ? { fromZone: 'graveyard' as const } : {}),
      });
    } else if (choice.targetSets.length > 0) {
      setPendingCast(choice);
    }
  };

  const commitCast = (targets: ReadonlyArray<InstanceId | PlayerId>): void => {
    if (!pendingCast) return;
    const cast: GameAction = {
      kind: 'castSpell',
      player: masked.viewer,
      instanceId: pendingCast.instanceId,
      targets,
      // The zone rides the choice: a flashback cast must name its graveyard source
      // or the server looks for the card in the hand and cleanly rejects it.
      ...(pendingCast.fromZone === 'graveyard' ? { fromZone: 'graveyard' as const } : {}),
    };
    submitSequence([...pendingTaps, cast]);
  };

  /**
   * Cast a card the server hasn't offered yet, tapping for it first. Targets are
   * derived client-side (the server only enumerates them for casts it is already
   * offering) and the server re-validates the chosen one on arrival. Serves both
   * zones: a graveyard cast plans against the FLASHBACK cost and carries the zone.
   */
  const onTapCastClick = (card: CardInstance, fromZone: CastZone = 'hand'): void => {
    const sequence = castSequence(masked, masked.viewer, card, [], legalActions, fromZone);
    if (!sequence) return;
    const requirement = targetRequirement(card.def);
    if (requirement.count === 0) {
      submitSequence(sequence);
      return;
    }
    const options = legalTargets(requirement, masked, names);
    if (options.length === 0) return; // no legal target → the cast would fizzle
    // Hold the taps, then reuse the existing target picker for the choice.
    setPendingTaps(sequence.slice(0, -1));
    setPendingCast({
      instanceId: card.instanceId,
      targetSets: options.map((o) => [optionToTarget(o)]),
      canCastUntargeted: false,
      fromZone,
    });
  };

  /**
   * The ONE thing a playable card does — play the land, cast the offered spell, or
   * start a tap-funded cast — for a card in EITHER castable zone. Click, drag and
   * the graveyard panel all route here, so no gesture can diverge from what
   * clicking the same card would have done. Re-checks the frame's affordances on
   * entry: a card that stopped being actionable mid-gesture (a new frame arrived)
   * simply does nothing.
   */
  const activateCard = (id: InstanceId, zone: CastZone = 'hand'): void => {
    if (!yourTurn) return;
    if (zone === 'graveyard') {
      const offered = graveyardCasts.get(id);
      if (offered) {
        onCastClick(offered);
        return;
      }
      if (graveyardTapCastable.has(id)) {
        const card = graveyardCardOf(id);
        if (card) onTapCastClick(card, 'graveyard');
      }
      return;
    }
    if (lands.has(id)) {
      submit({ kind: 'playLand', player: masked.viewer, instanceId: id });
      return;
    }
    const cast = casts.get(id);
    if (cast) {
      onCastClick(cast);
      return;
    }
    if (tapCastable.has(id)) {
      const card = handCardOf(id);
      if (card) onTapCastClick(card, 'hand');
    }
  };

  /** The hand's chokepoint (drag + click), named for the drag hook. */
  const activateHandCard = (id: InstanceId): void => activateCard(id, 'hand');

  // Drag a hand card onto your battlefield — the gesture the original bug report
  // reached for first. Same action as clicking; see useDragToPlay for the model.
  const { drag, dropRef, handProps: dragHandProps } = useDragToPlay(activateHandCard);

  // --- the graveyard panel ---------------------------------------------------------
  /**
   * Every graveyard card as the panel renders it. The judging lives in the shared
   * pure `graveyardPanelView` — the hotseat board calls the same function, so the
   * two graveyards cannot drift.
   */
  const graveyardPanelCards = useMemo(
    () =>
      graveyardPanelView(
        ownGraveyard.map((c) => ({
          instanceId: c.instanceId,
          cardId: c.def.id,
          name: c.def.name,
          hasFlashback: c.def.flashback !== undefined,
        })),
        new Set([...graveyardCasts.keys(), ...graveyardTapCastable]),
        { yourTurn, waitingOn: names[masked.priorityPlayer], step },
      ),
    [ownGraveyard, graveyardCasts, graveyardTapCastable, yourTurn, names, masked.priorityPlayer, step],
  );

  // --- activated abilities (a planeswalker's loyalty lines) -------------------------
  /** Definitions come from the PUBLIC battlefield the server already sent. */
  const defOf = (id: InstanceId): CardDefinition | undefined =>
    masked.battlefield.find((c) => c.instanceId === id)?.def;
  const nameOfTarget = (target: InstanceId | PlayerId): string =>
    target === 'A' || target === 'B' ? `${names[target]} (player)` : nameOfPerm(view, target);

  /**
   * The activatable abilities, grouped per source permanent — derived from the
   * server's offers ALONE, exactly like the hotseat's `abilityOptions()`. An
   * ability the engine did not offer (used this turn, unpayable minus, wrong
   * timing) is simply absent, so the menu can hold no dead buttons.
   */
  const abilityMenu = useMemo(() => {
    const map = new Map<InstanceId, AbilityOption[]>();
    for (const opt of abilityChoices(legalActions, defOf, nameOfTarget)) {
      const list = map.get(opt.instanceId);
      if (list) list.push(opt);
      else map.set(opt.instanceId, [opt]);
    }
    return map;
    // `defOf`/`nameOfTarget` read the same frame the actions arrived on, so the
    // frame's identity below is the whole dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [legalActions, masked, names, view]);

  const onChooseAbility = (opt: AbilityOption): void => {
    setAbilitySource(null);
    if (opt.targets === null) {
      submit({
        kind: 'activateAbility',
        player: masked.viewer,
        instanceId: opt.instanceId,
        abilityIndex: opt.abilityIndex,
      });
    } else {
      setPendingAbility(opt);
    }
  };

  // --- mana ------------------------------------------------------------------------
  const onTapForMana = (id: InstanceId): void => {
    const options = tapMenu.get(id);
    if (!options || options.length === 0) return;
    // One mode is not a decision; more than one is, so ask rather than pick.
    if (isModalTap(options)) {
      setPendingManaTap(options);
      return;
    }
    const only = options[0] as ManaTapOption;
    submit({ kind: 'tapForMana', player: masked.viewer, instanceId: only.instanceId, mode: only.mode });
  };

  // --- combat: attacker / blocker selection from the server templates -----------
  const eligibleAttackers = useMemo(
    () => new Set<InstanceId>(attackTemplate ? attackTemplate.attackers : []),
    [attackTemplate],
  );
  const attackerIds = masked.combat?.attackers ?? [];
  const inBlockStep = !!blockTemplate;
  const eligibleBlockers = useMemo(() => {
    if (!blockTemplate) return new Set<InstanceId>();
    return new Set<InstanceId>(blockTemplate.blocks.map((b) => b.blocker));
  }, [blockTemplate]);

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

  /**
   * Defending planeswalkers that can be attacked instead of the player. Read off
   * the PUBLIC battlefield in the masked view — loyalty and walker-ness are public
   * (the protocol redacts neither), so the online client needs nothing extra.
   */
  const enemyWalkers = useMemo(
    () =>
      yourTurn && step === 'declareAttackers' && attackTemplate
        ? masked.battlefield.filter((c) => c.controller !== masked.viewer && isPlaneswalker(c.def))
        : [],
    [yourTurn, step, attackTemplate, masked],
  );

  /**
   * Clicking a defending walker routes the CURRENTLY selected attackers at it;
   * clicking it again (when they all already attack it) sends them back at the
   * player — identical semantics to the hotseat board, so a player who learned one
   * has learned the other.
   */
  const onAssignAttackWalker = (walkerId: InstanceId): void => {
    if (chosenAttackers.size === 0) {
      flash('Select attackers first, then click the planeswalker to attack it.');
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

  const onBlockBoardClick = (id: InstanceId): void => {
    if (attackerIds.includes(id)) {
      setActiveBlockTarget((cur) => (cur === id ? null : id));
      return;
    }
    if (eligibleBlockers.has(id) && activeBlockTarget !== null) {
      setBlockAssign((cur) => {
        const next = new Map(cur);
        if (next.get(id) === activeBlockTarget) next.delete(id);
        else next.set(id, activeBlockTarget);
        return next;
      });
    }
  };

  // --- per-seat interactions -----------------------------------------------------
  const selfInteraction: PermInteraction | undefined = (() => {
    if (yourTurn && step === 'declareAttackers' && attackTemplate) {
      // An attacker aimed at a walker says so on its marker; the rest read "ATK".
      const markers = new Map<InstanceId, string>();
      for (const id of chosenAttackers) {
        const walker = walkerAssign.get(id);
        markers.set(id, walker !== undefined ? `ATK → ${nameOfPerm(view, walker)}` : 'ATK');
      }
      return { selectableIds: eligibleAttackers, selectedIds: chosenAttackers, markers, onClick: toggleAttacker };
    }
    if (yourTurn && inBlockStep) {
      const markers = new Map<InstanceId, string>();
      for (const [blocker, atk] of blockAssign) markers.set(blocker, `→ ${nameOfPerm(view, atk)}`);
      return {
        selectableIds: eligibleBlockers,
        selectedIds: new Set(blockAssign.keys()),
        markers,
        onClick: onBlockBoardClick,
      };
    }
    // Outside a combat declaration, clicking your own untapped source taps it (the
    // marker shows what it makes), and a permanent with a server-offered activated
    // ability — a walker's loyalty lines — opens its ability menu. Mana-tapping
    // wins an overlap: it is the frequent action, and no pool permanent is both
    // today. Same chain, same precedence as the hotseat board.
    const activatable = new Set(abilityMenu.keys());
    if (yourTurn && (tappable.size > 0 || activatable.size > 0)) {
      const markers = new Map<InstanceId, string>();
      for (const id of activatable) markers.set(id, 'activate');
      for (const [id, options] of tapMenu) {
        if (tappable.has(id)) markers.set(id, isModalTap(options) ? 'any' : (options[0]?.label ?? ''));
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
  })();

  const opponentInteraction: PermInteraction | undefined = (() => {
    // Declaring attackers with defending walkers on the board: the walkers are
    // clickable attack targets (see onAssignAttackWalker for the toggle semantics).
    if (yourTurn && step === 'declareAttackers' && enemyWalkers.length > 0) {
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
        selectableIds: new Set(enemyWalkers.map((w) => w.instanceId)),
        selectedIds: selected,
        markers,
        onClick: onAssignAttackWalker,
      };
    }
    if (yourTurn && inBlockStep) {
      const markers = new Map<InstanceId, string>();
      if (activeBlockTarget !== null) markers.set(activeBlockTarget, 'blocking…');
      return {
        selectableIds: new Set(attackerIds),
        selectedIds: activeBlockTarget !== null ? new Set([activeBlockTarget]) : new Set(),
        markers,
        onClick: onBlockBoardClick,
      };
    }
    return undefined;
  })();

  const statusText = `Turn ${view.turnNumber} · ${stepLabel(step)} · ${names[view.activePlayer]}'s turn`;
  const inAttackStep = yourTurn && step === 'declareAttackers' && !!attackTemplate;

  // Context a greyed hand card explains itself against. `anyLandOffered` is the
  // server's own answer to "may a land be played this window", which is what
  // separates "wrong step" from "already played one".
  const disabledContext = useMemo(
    () => ({
      yourTurn,
      yourTurnToAct: masked.activePlayer === masked.viewer,
      step,
      waitingOn: names[masked.priorityPlayer],
      anyLandOffered: lands.size > 0,
    }),
    [yourTurn, masked, step, names, lands],
  );

  // --- §3.57 clarity systems -------------------------------------------------------
  /** The board container: the combat-lines canvas measures inside it. */
  const boardRootRef = useRef<HTMLDivElement>(null);

  /** Jailed cards tucked under their jailer — the exile zones are PUBLIC. */
  const jails = useMemo(
    () =>
      groupJailedByJailer(
        jailSourcesOf([...masked.players.A.exile, ...masked.players.B.exile]),
        new Set(masked.battlefield.map((perm) => perm.instanceId)),
      ),
    [masked],
  );

  /**
   * Owner/zone lookup over the PUBLIC halves of the masked view plus the
   * viewer's OWN hand — exactly the zones the server already sent this seat,
   * so no label can say more than the wire did.
   */
  const refIndex = useMemo(() => {
    const refs: KnownRef[] = [];
    for (const perm of masked.battlefield) {
      refs.push({ instanceId: perm.instanceId, name: perm.def.name, controller: perm.controller, zone: 'battlefield' });
    }
    for (const pid of ['A', 'B'] as const) {
      for (const dead of masked.players[pid].graveyard) {
        refs.push({ instanceId: dead.instanceId, name: dead.def.name, controller: pid, zone: 'graveyard' });
      }
      for (const exiled of masked.players[pid].exile) {
        refs.push({ instanceId: exiled.instanceId, name: exiled.def.name, controller: pid, zone: 'exile' });
      }
    }
    for (const obj of masked.stack) {
      if (obj.kind === 'spell') {
        refs.push({ instanceId: obj.instanceId, name: obj.card.def.name, controller: obj.controller, zone: 'stack' });
      }
    }
    for (const held of masked.players[masked.viewer].hand ?? []) {
      refs.push({ instanceId: held.instanceId, name: held.def.name, controller: masked.viewer, zone: 'hand' });
    }
    return makeRefIndex(refs, masked.viewer, names);
  }, [masked, names]);

  /** Which blocker→attacker lines to draw this frame (pure rule, tested). */
  const combatLines = blockerLinePairs({
    step,
    declaredBlocks: view.combat?.blocks,
    draftAssign: blockAssign,
  });

  /** Is there ANY move available — a card, a mana source, or a combat declaration? */
  const hasAnyPlay =
    lands.size > 0 ||
    casts.size > 0 ||
    tapCastable.size > 0 ||
    graveyardCasts.size > 0 ||
    graveyardTapCastable.size > 0 ||
    tappable.size > 0 ||
    abilityMenu.size > 0 ||
    inAttackStep ||
    inBlockStep;
  const idleNote = idleTurnNote({ yourTurn, hasAnyPlay, step });
  /** Flashbacks available while the panel is shut — otherwise the affordance hides. */
  const flashbackCount = graveyardCasts.size + graveyardTapCastable.size;

  return (
    <div className="play-board" ref={boardRootRef}>
      <div className="play-board__status">
        <span className="play-board__turn">{statusText}</span>
        <span className="play-board__priority">
          {yourTurn ? 'Your move' : `Waiting for ${names[view.priorityPlayer]}…`}
        </span>
        <button type="button" className="btn btn--danger btn--ghost play-board__concede" onClick={onConcede}>
          Concede
        </button>
      </div>

      {/* Opponent (top) — hand hidden (count only). */}
      <div className="play-board__opponent">
        <SeatPanel
          seat={view.opponent}
          isActive={view.activePlayer === view.opponent.id}
          hasPriority={view.priorityPlayer === view.opponent.id}
          interaction={opponentInteraction}
          jails={jails}
          onInspectCard={setZoomed}
        />
        <div className="play-hand play-hand--hidden" aria-label={`${view.opponent.name} hand (hidden)`}>
          {Array.from({ length: view.opponent.handCount }).map((_, i) => (
            <CardBack key={i} index={i} />
          ))}
          {view.opponent.handCount === 0 && <span className="seat__empty">Empty hand</span>}
        </div>
      </div>

      {/* Center: stack + server log. */}
      <div className="play-board__center">
        <StackPanel stack={view.stack} names={names} nameOf={() => 'card'} />
        <ServerLog lines={log} />
      </div>

      {/* Viewer (bottom) — own hand face-up. The seat panel doubles as the drag-to-
          play drop zone: it lights up while a card is in flight, and releasing a
          dragged card over it plays that card (same action as clicking it). */}
      <div className="play-board__self">
        <div
          ref={dropRef}
          className={`drop-zone${drag ? ' drop-zone--active' : ''}${drag?.overDrop ? ' drop-zone--over' : ''}`}
        >
          <SeatPanel
            seat={view.self}
            isActive={view.activePlayer === view.self.id}
            hasPriority={view.priorityPlayer === view.self.id}
            interaction={selfInteraction}
            onGraveyardClick={() => setGraveyardOpen((open) => !open)}
            jails={jails}
            onInspectCard={setZoomed}
          />
        </div>
        {/* The opened graveyard. Flashback casts arrive in `legalActions` but the
            hand was the only clickable zone, so they were unreachable online —
            this is that affordance, routed through the same `activateCard`. */}
        {graveyardOpen && (
          <GraveyardPanel
            ownerName={view.self.name}
            cards={graveyardPanelCards}
            onActivate={(id) => activateCard(id, 'graveyard')}
            onClose={() => setGraveyardOpen(false)}
          />
        )}
        <div
          className="play-hand"
          aria-label={`${view.self.name} hand`}
          {...dragHandProps}
          onDragStart={(e) => e.preventDefault()}
        >
          {(view.self.hand ?? []).map((c) => {
            const isLand = lands.has(c.instanceId);
            const cast = casts.get(c.instanceId);
            // A card the server hasn't offered but we can fund by tapping.
            const tapCard = !cast && tapCastable.has(c.instanceId) ? handCardOf(c.instanceId) : undefined;
            const actionable = yourTurn && (isLand || !!cast || !!tapCard);
            const dragging = drag?.id === c.instanceId ? drag : null;
            return (
              // The wrapper is the drag handle: `data-drag-id` marks it draggable
              // for the delegated pointer handlers, `touch-action: none` keeps
              // mobile browsers from turning the drag into a page scroll, and the
              // transform is the ghost following the pointer.
              <div
                key={c.instanceId}
                className={`hand-card-slot${dragging ? ' hand-card-slot--dragging' : ''}`}
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
                <PlayCard
                  cardId={c.cardId}
                  name={c.name}
                  face="full"
                  badge={c.isLand ? 'Land' : cast ? 'castable' : tapCard ? 'tap mana' : undefined}
                  disabled={!actionable}
                  reason={actionable ? undefined : reasonCardIsDisabled(disabledContext, c)}
                  onClick={actionable ? () => activateCard(c.instanceId, 'hand') : undefined}
                />
                <button
                  type="button"
                  className="hand-card-slot__zoom"
                  aria-label={`Inspect ${c.name}`}
                  title={`Inspect ${c.name}`}
                  onClick={() => setZoomed({ cardId: c.cardId, name: c.name })}
                >
                  🔍
                </button>
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
      <div className="action-bar">
        {!yourTurn ? (
          <span className="action-bar__wait">
            {/* Names the asker and the card, never a candidate — the summary carries no more. */}
            {waitingText ?? `Waiting for ${names[view.priorityPlayer]}…`}
          </span>
        ) : (
          <>
            {inAttackStep && (
              <button
                type="button"
                className="btn btn--primary"
                onClick={() =>
                  // `attackTargets` routes attackers at a defending walker; with no
                  // assignment the action is byte-identical to the pre-walker one.
                  submit(
                    buildDeclareAttackersAction(
                      masked.viewer,
                      [...chosenAttackers],
                      Object.fromEntries(walkerAssign),
                    ),
                  )
                }
              >
                {chosenAttackers.size > 0 ? `Attack with ${chosenAttackers.size}` : 'Attack with none'}
              </button>
            )}
            {inBlockStep && (
              <button
                type="button"
                className="btn btn--primary"
                onClick={() =>
                  submit({
                    kind: 'declareBlockers',
                    player: masked.viewer,
                    blocks: [...blockAssign].map(([blocker, attacker]) => ({ blocker, attacker })),
                  })
                }
              >
                {blockAssign.size > 0
                  ? `Confirm ${blockAssign.size} block${blockAssign.size === 1 ? '' : 's'}`
                  : 'No blocks'}
              </button>
            )}
            {pass && (
              <button type="button" className="btn" onClick={() => submit(pass)}>
                Pass / advance
              </button>
            )}
            {/* A castable flashback is invisible while the graveyard is shut, and an
                affordance nobody can see is the same as not shipping it. */}
            {flashbackCount > 0 && !graveyardOpen && (
              <button type="button" className="btn btn--ghost" onClick={() => setGraveyardOpen(true)}>
                {`Flashback available (${flashbackCount})`}
              </button>
            )}
            <span className="action-bar__hint">
              {drag
                ? 'Drop the card on your battlefield to play it.'
                : ownChoice
                  ? 'Answer the question above to continue.'
                  : // A seat that holds priority with nothing to do is the state that
                    // read as a frozen app — say so plainly instead of giving the
                    // generic step hint next to a hand of dead cards.
                    autoPass
                    ? 'Nothing to do this step — advancing…'
                    : (idleNote ??
                      actionBarHint(step, {
                        // The active player's own declare window, pre-declaration;
                        // once attackers are declared this seat is responding.
                        isAttackWindow:
                          masked.activePlayer === masked.viewer &&
                          masked.combat !== null &&
                          !masked.combat.attackersDeclared,
                        hasAttackers: (attackTemplate?.attackers.length ?? 0) > 0,
                        // The server offers a declareBlockers template only to
                        // the seat that may block, so its presence IS the window.
                        isBlockWindow: inBlockStep,
                        hasBlockers: eligibleBlockers.size > 0,
                        hasEnemyWalkers: enemyWalkers.length > 0,
                        mainPhaseFlavor: 'online',
                      }))}
            </span>
          </>
        )}
      </div>

      {/*
        The parked question, rendered by the SAME `ChoicePrompt` the hotseat uses —
        one choice UI, not two. It appears only for the seat the server addressed the
        choice to, which is also the only seat that was sent its candidates. Every
        kind routes here, including the CAST-TIME questions: an {'{X}'} cost arrives
        as `chooseNumber`, kicker as `payMana`, a shockland's as `payLife`, and the
        naming a permanent makes as it enters ("choose a creature type") as
        `chooseValue`.
      */}
      {ownChoice && (
        <ChoicePrompt
          choice={ownChoice}
          names={names}
          onAnswer={(answer) => submit(answerChoiceAction(masked.viewer, ownChoice, answer))}
          zoneOf={refIndex.zoneOf}
        />
      )}

      {/* Which ability of this permanent? (a planeswalker's loyalty lines). Only
          server-offered abilities are listed, so a used-this-turn or unpayable line
          is simply absent rather than disabled. */}
      {abilitySource !== null && (
        <AbilityMenuPrompt
          sourceName={nameOfPerm(view, abilitySource)}
          options={abilityMenu.get(abilitySource) ?? []}
          onChoose={onChooseAbility}
          onCancel={() => setAbilitySource(null)}
        />
      )}

      {/* The chosen ability's targets — one button per server-offered legal target. */}
      {pendingAbility && pendingAbility.targets !== null && (
        <AbilityTargetPrompt
          ability={pendingAbility}
          annotateTarget={refIndex.noteOf}
          onPick={(target) =>
            submit({
              kind: 'activateAbility',
              player: masked.viewer,
              instanceId: pendingAbility.instanceId,
              abilityIndex: pendingAbility.abilityIndex,
              targets: [target],
            })
          }
          onCancel={() => setPendingAbility(null)}
        />
      )}

      {/* Which colour should this modal source make? (Birds of Paradise, a dual land.) */}
      {pendingManaTap && (
        <div className="target-prompt" role="dialog" aria-label="Choose which mana to add">
          <div className="target-prompt__card">
            <div className="target-prompt__title">
              Add which mana from {nameOfPerm(view, pendingManaTap[0]?.instanceId ?? 0)}?
            </div>
            <div className="target-prompt__options">
              {pendingManaTap.map((opt) => (
                <button
                  key={opt.mode ?? 0}
                  type="button"
                  className="btn"
                  onClick={() =>
                    submit({
                      kind: 'tapForMana',
                      player: masked.viewer,
                      instanceId: opt.instanceId,
                      mode: opt.mode,
                    })
                  }
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

      {/* Target prompt: choose among the server's enumerated legal target sets. */}
      {pendingCast && (
        <div className="target-prompt" role="dialog" aria-label="Choose a target">
          <div className="target-prompt__card">
            <div className="target-prompt__title">Choose a target</div>
            <div className="target-prompt__options">
              {pendingCast.targetSets.length === 0 && (
                <span className="seat__empty">No legal targets — cancel.</span>
              )}
              {pendingCast.targetSets.map((set, i) => (
                <button key={i} type="button" className="btn" onClick={() => commitCast(set)}>
                  {/* Owner + zone ride every row (§3.57) — resolved through the
                      public-zone index, so a graveyard target names its yard. */}
                  {describeTargetSetWithOwners(set, refIndex)}
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

      {/* Blocker→attacker lines (§3.57) — same overlay as the hotseat board. */}
      <CombatLines lines={combatLines} containerRef={boardRootRef} measureKey={frame} />
    </div>
  );
}

/** How long a transient board message stays up (matches the hotseat board's feel). */
const TOAST_MS = 2600;

/** The running game log, rendered from the server's pre-formatted text lines. */
function ServerLog({ lines }: { lines: readonly string[] }): ReactElement {
  return (
    <div className="game-log" aria-label="Game log" aria-live="polite">
      <div className="game-log__title">Game Log</div>
      <div className="game-log__lines">
        {lines.length === 0 ? (
          <div className="game-log__empty">The game begins…</div>
        ) : (
          lines.map((line, i) => (
            <div key={i} className="game-log__line">
              {line}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

/** Name a permanent on the board by instance id (falls back to the raw id). */
function nameOfPerm(
  view: ReturnType<typeof maskedViewToBoardView>,
  id: InstanceId,
): string {
  const all = [...view.self.permanents, ...view.opponent.permanents];
  return all.find((p) => p.instanceId === id)?.name ?? `#${id}`;
}

// The per-step hint and the target-set labels both moved to shared, tested
// modules (`lib/play/action-hints.ts`, `lib/play/option-labels.ts`) so the two
// boards render identical copy from one rule (§3.57).
