import { useMemo, useState, type ReactElement } from 'react';
import type { GameAction, InstanceId, PlayerId } from '@jonny-boi/core';
import { stepLabel } from '../../lib/play/play-config.js';
import { maskedViewToBoardView } from '../../lib/online/board-adapter.js';
import type { GameFrame } from '../../lib/online/online-state.js';
import {
  castChoices,
  declareAttackersAction,
  declareBlockersAction,
  passAction,
  playableLandIds,
  type CastChoice,
} from '../../lib/online/legal-actions.js';
import { isAwaitingChoiceAnswer, onlineChoiceOptions } from '../../lib/online/choice-actions.js';
import { SeatPanel, type PermInteraction } from '../play/SeatPanel.js';
import { StackPanel } from '../play/StackPanel.js';
import { PlayCard, CardBack } from '../play/PlayCard.js';

/**
 * The in-game board for ONLINE play. It renders the server-pushed `MaskedGameView`
 * (adapted to the shared `BoardView`) and offers ONLY the server's `legalActions` —
 * so an illegal move can't be built. On a choice it calls `onAction(GameAction)`,
 * which the hook serializes to `submitAction`. Unlike hotseat there is NO device
 * handoff: when it's not our turn we render a clear "Waiting for opponent…" state.
 *
 * It reuses `SeatPanel`/`StackPanel`/`PlayCard`/`CardBack` verbatim (DRY) — the
 * adapter is the only new glue. The game log uses the server-provided text lines.
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
  const attackTemplate = useMemo(() => declareAttackersAction(legalActions), [legalActions]);
  const blockTemplate = useMemo(() => declareBlockersAction(legalActions), [legalActions]);
  const pass = useMemo(() => passAction(legalActions), [legalActions]);
  // A resolving card is asking this seat a question. The server's `MaskedGameView`
  // carries no `pendingChoice`, so the question itself never reached us — but its
  // legal ANSWERS did, and offering them is what keeps the game from dead-ending
  // with an unplayable board (see lib/online/choice-actions.ts).
  const awaitingChoice = useMemo(() => isAwaitingChoiceAnswer(legalActions), [legalActions]);
  const choiceOptions = useMemo(
    () => (awaitingChoice ? onlineChoiceOptions(legalActions, masked, names) : []),
    [awaitingChoice, legalActions, masked, names],
  );

  // Transient interaction state.
  const [pendingCast, setPendingCast] = useState<CastChoice | null>(null);
  const [chosenAttackers, setChosenAttackers] = useState<Set<InstanceId>>(new Set());
  const [blockAssign, setBlockAssign] = useState<Map<InstanceId, InstanceId>>(new Map());
  const [activeBlockTarget, setActiveBlockTarget] = useState<InstanceId | null>(null);

  const reset = (): void => {
    setPendingCast(null);
    setChosenAttackers(new Set());
    setBlockAssign(new Map());
    setActiveBlockTarget(null);
  };

  const submit = (action: GameAction): void => {
    reset();
    onAction(action);
  };

  // --- casting -------------------------------------------------------------------
  const onCastClick = (choice: CastChoice): void => {
    if (choice.canCastUntargeted) {
      submit({ kind: 'castSpell', player: masked.viewer, instanceId: choice.instanceId, targets: [] });
    } else if (choice.targetSets.length > 0) {
      setPendingCast(choice);
    }
  };

  const commitCast = (targets: ReadonlyArray<InstanceId | PlayerId>): void => {
    if (!pendingCast) return;
    submit({ kind: 'castSpell', player: masked.viewer, instanceId: pendingCast.instanceId, targets });
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
    setChosenAttackers((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
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
      const markers = new Map<InstanceId, string>();
      for (const id of chosenAttackers) markers.set(id, 'ATK');
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
    return undefined;
  })();

  const opponentInteraction: PermInteraction | undefined = (() => {
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

  return (
    <div className="play-board">
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

      {/* Viewer (bottom) — own hand face-up. */}
      <div className="play-board__self">
        <SeatPanel
          seat={view.self}
          isActive={view.activePlayer === view.self.id}
          hasPriority={view.priorityPlayer === view.self.id}
          interaction={selfInteraction}
        />
        <div className="play-hand" aria-label={`${view.self.name} hand`}>
          {(view.self.hand ?? []).map((c) => {
            const isLand = lands.has(c.instanceId);
            const cast = casts.get(c.instanceId);
            const actionable = yourTurn && (isLand || !!cast);
            return (
              <PlayCard
                key={c.instanceId}
                cardId={c.cardId}
                name={c.name}
                badge={c.isLand ? 'Land' : cast ? 'castable' : undefined}
                disabled={!actionable}
                onClick={
                  actionable
                    ? isLand
                      ? () => submit({ kind: 'playLand', player: masked.viewer, instanceId: c.instanceId })
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
      <div className="action-bar">
        {!yourTurn ? (
          <span className="action-bar__wait">Waiting for {names[view.priorityPlayer]}…</span>
        ) : (
          <>
            {inAttackStep && (
              <button
                type="button"
                className="btn btn--primary"
                onClick={() =>
                  submit({ kind: 'declareAttackers', player: masked.viewer, attackers: [...chosenAttackers] })
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
            <span className="action-bar__hint">
              {awaitingChoice ? 'Answer the question above to continue.' : hintFor(step)}
            </span>
          </>
        )}
      </div>

      {/*
        A parked question. Until the protocol carries `pendingChoice`, we can offer
        the engine's own legal answers but not the wording of the question — so the
        panel says exactly that rather than inventing a prompt.
      */}
      {yourTurn && choiceOptions.length > 0 && (
        <div className="choice-prompt" role="dialog" aria-modal="true" aria-label="A card is asking you a question">
          <div className="choice-prompt__card">
            <header className="choice-prompt__head">
              <span className="choice-prompt__who">{names[masked.viewer]} must choose</span>
              <h3 className="choice-prompt__title">A resolving card is asking you a question</h3>
              <p className="choice-prompt__requirement">
                This build's online mode can show the legal answers but not the question's wording.
                {choiceOptions.some((o) => !o.fullyNamed) && ' Some options name cards this seat cannot see.'}
              </p>
            </header>
            <div className="choice-prompt__options">
              <div className="choice-prompt__list">
                {choiceOptions.map((opt) => (
                  <button
                    key={opt.key}
                    type="button"
                    className="choice-option"
                    onClick={() => submit(opt.action)}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>
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
                  {describeTargetSet(view, names, set)}
                </button>
              ))}
            </div>
            <button type="button" className="btn btn--ghost" onClick={() => setPendingCast(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

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

/** Render a legal target set as a readable label. */
function describeTargetSet(
  view: ReturnType<typeof maskedViewToBoardView>,
  names: Readonly<Record<PlayerId, string>>,
  set: ReadonlyArray<InstanceId | PlayerId>,
): string {
  if (set.length === 0) return 'No target';
  return set
    .map((t) => (t === 'A' || t === 'B' ? `${names[t]} (player)` : nameOfPerm(view, t)))
    .join(', ');
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
