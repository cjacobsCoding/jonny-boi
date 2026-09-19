/**
 * The bridge from a `GameSession` to the pure stop rule's {@link StopContext}
 * — every fact the rule needs, read off the session's OWN derivations (legal
 * actions, cast options, `canRespond`) so the stop decision and the buttons on
 * screen are answers to one question.
 */
import type { GameSession } from './session.js';
import type { StopContext } from './priority-stops.js';

/** The rule's view of the current priority window. */
export function stopContextFor(session: GameSession): StopContext {
  const state = session.state;
  const holder = session.priorityPlayer;
  const legal = session.pendingChoice ? [] : session.legalActions();
  const top = state.stack[state.stack.length - 1];
  // §3.129 — can the holder RESPOND TO THEIR OWN stack? True when an activatable
  // ability (funded now or after auto-tapping — `abilityOptions` covers both)
  // legally aims at an object the holder controls on the stack. This is exactly
  // the Strionic Resonator moment, and it is read off the same option list the
  // board renders, so the stop and the button that appears in it are one answer.
  const ownStackIds = new Set(
    state.stack.filter((o) => o.controller === holder).map((o) => o.instanceId),
  );
  const canRespondToOwnStack =
    ownStackIds.size > 0 &&
    session
      .abilityOptions()
      .some((opt) => (opt.targets ?? []).some((c) => typeof c.target === 'number' && ownStackIds.has(c.target)));
  return {
    step: state.step,
    activePlayer: state.activePlayer,
    holder,
    pendingChoice: session.pendingChoice !== null,
    // A forced block declaration (no creature can block — bug report
    // 20260825_211445) is no decision; the auto-advance makes it, so the
    // Arena-style rule must not stop the board for it either.
    offersDeclaration: legal.some(
      (a) =>
        a.kind === 'declareAttackers' ||
        (a.kind === 'declareBlockers' && !session.blockDeclarationIsForced()),
    ),
    hasAnyPlay: session.hasMeaningfulChoice(),
    canRespond: session.canRespond(),
    stackTopController: top ? top.controller : null,
    canRespondToOwnStack,
  };
}
