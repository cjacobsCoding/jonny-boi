/**
 * THE AI CO-PILOT (§3.67) — "what would you do here?", asked of the same pilot
 * that plays the deck in the Lab, on YOUR side of the board.
 *
 * ## Why this is a thin module and not a new brain
 * The pilot already answers exactly this question — `chooseAction` takes a view
 * and returns the move it would make — and it already knows WHY: the heuristic
 * emits a `DecisionTrace` with a reason and a score whenever a caller supplies
 * a `trace` sink, and skips building the string entirely when nobody is
 * listening. So the co-pilot is: ask the pilot as if it held your seat, keep the
 * trace, and hand both to the board.
 *
 * ⚠️ That is why the explanation can be trusted. It is the pilot's OWN stated
 * reason for the move it actually chose — not prose written about a move after
 * the fact, which is what an explanation invented at this layer would be, and
 * which would eventually describe a decision that was made for another reason.
 *
 * ## What it deliberately does not do
 * It never submits anything. The suggestion is advice on a board the human is
 * driving; acting on it is a click the human makes. And it is recomputed from
 * the CURRENT session every time, so after any move — yours, the opponent's, a
 * trigger resolving — the next question is asked afresh rather than a stale
 * answer being aged.
 */
import type { GameAction, PlayerId, Rng } from '@jonny-boi/core';
import type { Pilot } from '@jonny-boi/ai';
import type { GameSession } from './session.js';
import { COPILOT_STORAGE_KEY } from '../config.js';
import { writeStorage } from '../persistence/write.js';

/** What the co-pilot would do, and why it says it would. */
export interface CopilotSuggestion {
  /** The move itself — the board matches this to a control to highlight. */
  readonly action: GameAction;
  /**
   * The pilot's own words for this decision, or `null` when the pilot did not
   * offer one (only the heuristic family traces; `random` has nothing to say).
   */
  readonly reason: string | null;
  /** The pilot's score for the move, when it reported one. */
  readonly score?: number;
}

/**
 * Ask the pilot what it would do in the viewer's seat right now.
 *
 * Returns null when there is nothing to advise: the game is over, it is not the
 * viewer's decision, or the engine offers no legal action. Advice on someone
 * else's turn would be noise at best and a hidden-information leak at worst —
 * the pilot sees the whole state, and the human must not learn from it what
 * their own board does not already show.
 */
export function suggestMove(
  session: GameSession,
  viewer: PlayerId,
  pilot: Pilot,
  rng: Rng,
): CopilotSuggestion | null {
  if (session.gameOver) return null;
  if (session.state.priorityPlayer !== viewer) return null;
  const legalActions = session.legalActions();
  if (legalActions.length === 0) return null;

  let traced: { reason: string; score?: number } | null = null;
  const action = pilot.chooseAction({
    view: session.state,
    legalActions,
    rng,
    registry: session.registry,
    // Supplying a sink is what makes the pilot build its reason at all. The sink
    // may fire more than once (a pilot that reconsiders); the LAST trace is the
    // one that belongs to the action actually returned.
    trace: (t) => {
      traced = t.score === undefined ? { reason: t.reason } : { reason: t.reason, score: t.score };
    },
    // Same omission as the AI seat: passing a rulesConfig here would let a
    // look-ahead pilot roll out a different game from the one being played.
    observer: undefined,
  });

  const detail = traced as { reason: string; score?: number } | null;
  const reason = detail && detail.reason !== '' ? detail.reason : null;
  return {
    action,
    reason,
    ...(detail?.score !== undefined ? { score: detail.score } : {}),
  };
}

/**
 * Which on-screen thing a suggested action points at, so the board can highlight
 * it without every component learning the shape of every action.
 *
 * A table, not a chain of ifs: adding the next highlightable action is a ROW.
 * An action with no card to point at resolves to the ACTION BAR, which is where
 * its button lives (pass, declare attackers with none, confirm blocks).
 */
export type SuggestionTarget =
  | { readonly kind: 'card'; readonly instanceId: number }
  | { readonly kind: 'bar' };

/** Actions whose subject is a specific card, and the field naming it. */
const CARD_FIELD_BY_ACTION: Readonly<Record<string, string>> = Object.freeze({
  playLand: 'instanceId',
  castSpell: 'instanceId',
  activateAbility: 'instanceId',
  tapForMana: 'instanceId',
});

/** Where the board should draw the co-pilot's hint. */
export function suggestionTarget(action: GameAction): SuggestionTarget {
  const field = CARD_FIELD_BY_ACTION[action.kind];
  if (field !== undefined) {
    const id = (action as unknown as Record<string, unknown>)[field];
    if (typeof id === 'number') return { kind: 'card', instanceId: id };
  }
  return { kind: 'bar' };
}

/**
 * The line shown to the player. Always says WHAT first and why second, because
 * the move is the actionable part and the reasoning is the justification —
 * and a suggestion whose pilot offered no reason still has to read as advice.
 */
export function suggestionText(
  suggestion: CopilotSuggestion,
  nameOf: (instanceId: number) => string,
): string {
  const target = suggestionTarget(suggestion.action);
  const what = describeAction(suggestion.action, target, nameOf);
  return suggestion.reason ? `${what} — ${suggestion.reason}` : what;
}

/** A short, honest description of the move itself. */
function describeAction(
  action: GameAction,
  target: SuggestionTarget,
  nameOf: (instanceId: number) => string,
): string {
  const name = target.kind === 'card' ? nameOf(target.instanceId) : '';
  switch (action.kind) {
    case 'playLand':
      return `Play ${name}`;
    case 'castSpell':
      return `Cast ${name}`;
    case 'activateAbility':
      return `Activate ${name}`;
    case 'tapForMana':
      return `Tap ${name} for mana`;
    case 'passPriority':
      return 'Pass';
    case 'declareAttackers':
      return 'Declare attackers';
    case 'declareBlockers':
      return 'Declare blockers';
    case 'answerChoice':
      return 'Answer the question';
    default:
      // A move this module has no phrasing for still gets named rather than
      // hidden: an unfamiliar action is exactly when a player wants the hint.
      return action.kind;
  }
}

// --- the stored preference ----------------------------------------------------------

/** Co-pilot mode is OFF until asked for: hints on a board you did not ask for
 *  advice about are noise, and the feature is about wanting a second opinion. */
export const COPILOT_DEFAULT = false;

/** Read the stored "show me what the AI would do" preference. Never throws. */
export function loadCopilotPref(): boolean {
  try {
    const raw = localStorage.getItem(COPILOT_STORAGE_KEY);
    if (raw === null) return COPILOT_DEFAULT;
    return raw === 'true';
  } catch {
    return COPILOT_DEFAULT;
  }
}

/** Persist it. `quiet` like every other checkbox: losing it costs one click. */
export function saveCopilotPref(on: boolean): void {
  writeStorage('pref-copilot', COPILOT_STORAGE_KEY, on ? 'true' : 'false', { quiet: true });
}
