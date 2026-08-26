/**
 * THE AI SEAT — the pure half of "play against the computer".
 *
 * Everything here is a decision about WHETHER and WHAT the pilot should do,
 * taken from a `GameSession` and nothing else, so the whole rule is testable
 * without React, without a timer and without a board.
 *
 * The driver is deliberately thin because the engine already does the hard part:
 * a parked question arrives as an `answerChoice` in `legalActions`, exactly as it
 * does for the headless sim's match loop (`packages/sim/src/match.ts`). So one
 * uniform "ask the pilot for a legal action and submit it" covers casting,
 * combat, mulligan-time questions and every card that stops to ask something —
 * rather than a branch per situation that would drift from the sim's behaviour.
 */
import type { GameAction, PlayerId, Rng } from '@jonny-boi/core';
import type { Pilot } from '@jonny-boi/ai';
import type { GameSession } from './session.js';

/** Which seat the computer plays, and with which pilot. */
export interface AiSeatConfig {
  readonly seat: PlayerId;
  /** A `SELECTABLE_PILOT_IDS` member — 'heuristic', 'hybrid', 'mcts', 'random', 'lookahead'. */
  readonly pilotId: string;
}

/**
 * Is it the AI's move right now?
 *
 * True only when the game is live and the pilot's seat holds priority. A parked
 * CHOICE is included by the same test, because the engine hands priority to
 * whoever must answer it — which is why this needs no separate question about
 * pending choices, and cannot go out of step with one.
 */
export function aiMustAct(session: GameSession, seat: PlayerId): boolean {
  if (session.gameOver) return false;
  return session.state.priorityPlayer === seat;
}

/**
 * The action the pilot picks, or `undefined` when there is nothing legal (which
 * the engine treats as "not our move" and the caller simply skips).
 *
 * `rng` is core's seeded {@link Rng}, passed in rather than made here: the pilots
 * are deterministic given a stream, so a solo game replays identically from its
 * seed the way every other seeded thing in this repo does. (Core owns seeded
 * randomness — a second generator here would be a second answer to the same
 * question, and only one of them would be the one the sim uses.)
 */
export function aiAction(
  session: GameSession,
  pilot: Pilot,
  rng: Rng,
): GameAction | undefined {
  const legalActions = session.legalActions();
  if (legalActions.length === 0) return undefined;
  return pilot.chooseAction({
    view: session.state,
    legalActions,
    rng,
    registry: session.registry,
    // `rulesConfig` is deliberately OMITTED, because `GameSession.submit` also
    // omits it and takes the engine default. Passing anything here would let a
    // look-ahead pilot roll out a different game from the one being played.
    observer: undefined,
  });
}
