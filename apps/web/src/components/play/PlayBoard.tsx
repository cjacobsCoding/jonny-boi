import { useMemo, useState, type ReactElement } from 'react';
import type { InstanceId, PlayerId } from '@jonny-boi/core';
import type { GameSession, CastOption, SubmitResult } from '../../lib/play/session.js';
import { buildBoardView } from '../../lib/play/view-model.js';
import { optionToTarget, type TargetOption } from '../../lib/play/targeting.js';
import { stepLabel } from '../../lib/play/play-config.js';
import { SeatPanel, type PermInteraction } from './SeatPanel.js';
import { StackPanel } from './StackPanel.js';
import { GameLog } from './GameLog.js';
import { PlayCard, CardBack } from './PlayCard.js';
import { ChoicePrompt } from './ChoicePrompt.js';
import { isChoiceForViewer, waitingForChoiceText } from '../../lib/play/choice-view.js';
import { isModalTap, manaTapMenu, tappableIds, type ManaTapOption } from '../../lib/play/mana-tap.js';

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
  // Blocker assignment (defender, declareBlockers): blocker -> attacker.
  const [blockAssign, setBlockAssign] = useState<Map<InstanceId, InstanceId>>(new Map());
  // The attacker currently being assigned a blocker (click attacker, then blocker).
  const [activeBlockTarget, setActiveBlockTarget] = useState<InstanceId | null>(null);
  // A modal mana source the player tapped, awaiting the colour they want.
  const [pendingManaTap, setPendingManaTap] = useState<readonly ManaTapOption[] | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const resetTransient = (): void => {
    setPendingCast(null);
    setChosenAttackers(new Set());
    setBlockAssign(new Map());
    setActiveBlockTarget(null);
    setPendingManaTap(null);
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
    run(() => session.castWithAutoTap(cast.instanceId, targets));
  };

  const onCastClick = (opt: CastOption): void => {
    if (opt.needsTarget) {
      setPendingCast(opt);
    } else {
      run(() => session.castWithAutoTap(opt.instanceId, []));
    }
  };

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
    setChosenAttackers((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
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
      return {
        selectableIds: eligibleAttackers,
        selectedIds: chosenAttackers,
        markers: markerMap(chosenAttackers, 'ATK'),
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
    // Otherwise your untapped mana sources are tappable by hand. Last in the chain
    // so it never steals a click from combat selection or targeting.
    if (tappable.size > 0) {
      const markers = new Map<InstanceId, string>();
      for (const id of tappable) {
        const options = tapMenu.get(id) ?? [];
        markers.set(id, isModalTap(options) ? 'tap: any' : `tap: ${options[0]?.label ?? ''}`);
      }
      return { selectableIds: tappable, selectedIds: new Set(), markers, onClick: onTapForMana };
    }
    return undefined;
  }

  function buildOpponentInteraction(): PermInteraction | undefined {
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
    const creatureTargets = new Set(
      targetOptions.filter((o) => o.kind === 'creature' && ownedIds.includes(o.instanceId)).map((o) => (o as { instanceId: InstanceId }).instanceId),
    );
    if (creatureTargets.size === 0) return undefined;
    return {
      selectableIds: creatureTargets,
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
        />
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
        chosenAttackers={chosenAttackers}
        blockAssign={blockAssign}
        eligibleAttackers={eligibleAttackers}
        onPass={() => run(() => session.passPriority())}
        onDeclareAttackers={(ids) => run(() => session.declareAttackers(ids))}
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
      <span className="action-bar__hint">{hintFor(step)}</span>
    </div>
  );
}

function passLabel(step: string): string {
  if (step === 'declareAttackers' || step === 'declareBlockers') return 'Pass priority';
  return 'Pass / advance';
}

function hintFor(step: string): string {
  switch (step) {
    case 'precombatMain':
    case 'postcombatMain':
      return 'Play a land or cast a spell from your hand, or pass to advance.';
    case 'declareAttackers':
      return 'Tap your creatures to attack, then confirm — or attack with none.';
    case 'declareBlockers':
      return 'Tap an attacker, then your creature, to block. Confirm when done.';
    default:
      return 'Cast instants in response, or pass priority to continue.';
  }
}

function markerMap(ids: Set<InstanceId>, label: string): Map<InstanceId, string> {
  const m = new Map<InstanceId, string>();
  for (const id of ids) m.set(id, label);
  return m;
}

function otherOf(p: PlayerId): PlayerId {
  return p === 'A' ? 'B' : 'A';
}
