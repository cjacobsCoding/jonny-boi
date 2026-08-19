import { useMemo, useState, type ReactElement } from 'react';
import type { InstanceId, PlayerId } from '@jonny-boi/core';
import type { AbilityOption, GameSession, CastOption, SubmitResult } from '../../lib/play/session.js';
import { buildBoardView } from '../../lib/play/view-model.js';
import { optionToTarget, type TargetOption } from '../../lib/play/targeting.js';
import { stepLabel } from '../../lib/play/play-config.js';
import { SeatPanel, type PermInteraction } from './SeatPanel.js';
import { StackPanel } from './StackPanel.js';
import { GameLog } from './GameLog.js';
import { PlayCard, CardBack } from './PlayCard.js';
import { ChoicePrompt } from './ChoicePrompt.js';
import { GraveyardPanel, type GraveyardPanelCard } from './GraveyardPanel.js';
import { AbilityMenuPrompt, AbilityTargetPrompt } from './AbilityPrompts.js';
import { GRAVEYARD_CAST_BADGE, reasonGraveyardCardIsDisabled } from '../../lib/play/graveyard-cast.js';
import { isChoiceForViewer, waitingForChoiceText } from '../../lib/play/choice-view.js';
import { isModalTap, manaTapMenu, tappableIds, type ManaTapOption } from '../../lib/play/mana-tap.js';
import './action-bar.css';

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
  session,
  viewer,
  onSubmit,
  onConcede,
}: {
  session: GameSession;
  viewer: PlayerId;
  /** Apply a session-producing action; PlayView stores the new session. */
  onSubmit: (run: () => SubmitResult) => void;
  onConcede: () => void;
}): ReactElement {
  const names = session.names;
  const view = useMemo(() => buildBoardView(session.state, viewer, names), [session, viewer, names]);
  const step = session.state.step;

  // --- transient interaction state ---------------------------------------------
  // A pending cast awaiting a target selection.
  const [pendingCast, setPendingCast] = useState<CastOption | null>(null);
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
  const [toast, setToast] = useState<string | null>(null);

  const resetTransient = (): void => {
    setPendingCast(null);
    setChosenAttackers(new Set());
    setWalkerAssign(new Map());
    setBlockAssign(new Map());
    setActiveBlockTarget(null);
    setPendingManaTap(null);
    setAbilitySource(null);
    setPendingAbility(null);
  };

  const run = (fn: () => SubmitResult): void => {
    const result = fn();
    if (result.rejected) {
      setToast(result.rejected);
      window.setTimeout(() => setToast(null), 2600);
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
    run(() => session.tapForMana(only.instanceId, only.mode));
  };

  // --- targeting -----------------------------------------------------------------
  const targetOptions: readonly TargetOption[] = pendingCast
    ? session.targetsFor(pendingCast.requirement)
    : [];

  const commitCast = (targets: readonly (InstanceId | PlayerId)[]): void => {
    const cast = pendingCast;
    if (!cast) return;
    // `fromZone` rides the option: a flashback cast names its graveyard source
    // (and pays the flashback cost inside castWithAutoTap); hand casts omit it.
    run(() => session.castWithAutoTap(cast.instanceId, targets, cast.fromZone ?? 'hand'));
  };

  const onCastClick = (opt: CastOption): void => {
    if (opt.needsTarget) {
      setPendingCast(opt);
    } else {
      run(() => session.castWithAutoTap(opt.instanceId, [], opt.fromZone ?? 'hand'));
    }
  };

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
  const graveyardPanelCards: readonly GraveyardPanelCard[] = (view.self.graveyard ?? []).map((c) => {
    const opt = graveyardCasts.find((o) => o.instanceId === c.instanceId);
    const hasFlashback = session.state.players[viewer].graveyard.some(
      (inst) => inst.instanceId === c.instanceId && inst.def.flashback !== undefined,
    );
    return {
      instanceId: c.instanceId,
      cardId: c.cardId,
      name: c.name,
      badge: opt ? GRAVEYARD_CAST_BADGE : undefined,
      actionable: !!opt,
      reason: opt
        ? undefined
        : reasonGraveyardCardIsDisabled(
            { yourTurn: isViewersPriority, waitingOn: names[session.priorityPlayer], step },
            { hasFlashback },
          ),
    };
  });

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
      setToast('Select attackers first, then click the planeswalker to attack it.');
      window.setTimeout(() => setToast(null), 2600);
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
        setToast('Pick an attacker to block first.');
        window.setTimeout(() => setToast(null), 2000);
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
    // Board-clickable targets: creatures AND planeswalkers (both are permanents
    // the player naturally clicks; players stay buttons in the prompt).
    const permanentTargets = new Set(
      targetOptions
        .filter(
          (o) => (o.kind === 'creature' || o.kind === 'planeswalker') && ownedIds.includes(o.instanceId),
        )
        .map((o) => (o as { instanceId: InstanceId }).instanceId),
    );
    if (permanentTargets.size === 0) return undefined;
    return {
      selectableIds: permanentTargets,
      selectedIds: new Set(),
      onClick: (id) => commitCast([id]),
    };
  }

  // --- render --------------------------------------------------------------------
  const statusText = `Turn ${view.turnNumber} · ${stepLabel(step)} · ${names[view.activePlayer]}'s turn`;

  return (
    <div className="play-board">
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
        />
        <div className="play-hand play-hand--hidden" aria-label={`${view.opponent.name} hand (hidden)`}>
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
        <SeatPanel
          seat={view.self}
          isActive={view.activePlayer === view.self.id}
          hasPriority={isViewersPriority}
          interaction={selfInteraction}
          onGraveyardClick={() => setGraveyardOpen((open) => !open)}
        />
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
        <div className="play-hand" aria-label={`${view.self.name} hand`}>
          {(view.self.hand ?? []).map((c) => {
            const land = playableLands.includes(c.instanceId);
            const cast = castOptions.find((o) => o.instanceId === c.instanceId);
            const actionable = isViewersPriority && (land || !!cast);
            return (
              <PlayCard
                key={c.instanceId}
                cardId={c.cardId}
                name={c.name}
                badge={c.isLand ? 'Land' : cast?.affordableNow ? 'castable' : cast ? 'tap mana' : undefined}
                disabled={!actionable}
                onClick={
                  actionable
                    ? land
                      ? () => run(() => session.playLand(c.instanceId))
                      : cast
                        ? () => onCastClick(cast)
                        : undefined
                    : undefined
                }
              />
            );
          })}
          {(view.self.hand?.length ?? 0) === 0 && <span className="seat__empty">Empty hand</span>}
        </div>
      </div>

      {/* Action bar. */}
      <ActionBar
        session={session}
        viewer={viewer}
        step={step}
        waitingText={
          pendingChoice && !isChoiceForViewer(pendingChoice, viewer)
            ? waitingForChoiceText(pendingChoice, names)
            : pendingChoice
              ? 'Answer the question above to continue.'
              : undefined
        }
        isViewersPriority={isViewersPriority}
        inBlockStep={inBlockStep}
        hasEnemyWalkers={enemyWalkers.length > 0}
        chosenAttackers={chosenAttackers}
        blockAssign={blockAssign}
        eligibleAttackers={eligibleAttackers}
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
                  onClick={() => run(() => session.tapForMana(opt.instanceId, opt.mode))}
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
                  {opt.kind === 'player' ? `${opt.name} (player)` : opt.name}
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
    </div>
  );
}

/** The action bar with phase-appropriate primary controls. */
function ActionBar({
  session,
  step,
  isViewersPriority,
  inBlockStep,
  hasEnemyWalkers,
  chosenAttackers,
  blockAssign,
  eligibleAttackers,
  waitingText,
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
  /** The defender controls at least one attackable planeswalker (hint wording). */
  hasEnemyWalkers: boolean;
  chosenAttackers: Set<InstanceId>;
  blockAssign: Map<InstanceId, InstanceId>;
  eligibleAttackers: Set<InstanceId>;
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
    <div className="action-bar">
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
      <button type="button" className="btn" onClick={onPass}>
        {passLabel(step)}
      </button>
      <span className="action-bar__hint">{hintFor(step, hasEnemyWalkers)}</span>
    </div>
  );
}

function passLabel(step: string): string {
  if (step === 'declareAttackers' || step === 'declareBlockers') return 'Pass priority';
  return 'Pass / advance';
}

function hintFor(step: string, hasEnemyWalkers = false): string {
  switch (step) {
    case 'precombatMain':
    case 'postcombatMain':
      return 'Play a land or cast a spell from your hand, or pass to advance.';
    case 'declareAttackers':
      return hasEnemyWalkers
        ? 'Tap your creatures to attack, then click an enemy planeswalker to attack it instead of the player. Confirm when done.'
        : 'Tap your creatures to attack, then confirm — or attack with none.';
    case 'declareBlockers':
      return 'Tap an attacker, then your creature, to block. Confirm when done.';
    default:
      return 'Cast instants in response, or pass priority to continue.';
  }
}

function otherOf(p: PlayerId): PlayerId {
  return p === 'A' ? 'B' : 'A';
}
