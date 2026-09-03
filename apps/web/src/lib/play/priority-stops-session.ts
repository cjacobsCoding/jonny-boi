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
  return {
    step: state.step,
    activePlayer: state.activePlayer,
    holder,
    pendingChoice: session.pendingChoice !== null,
    offersDeclaration: legal.some((a) => a.kind === 'declareAttackers' || a.kind === 'declareBlockers'),
    hasAnyPlay: session.hasMeaningfulChoice(),
    canRespond: session.canRespond(),
    stackTopController: top ? top.controller : null,
  };
}
