/**
 * TURN-SCOPED FACT MEMORY — "did X happen this turn?", for the handful of
 * printed cards that ask.
 *
 * ## Why a NAMED CLOSED VOCABULARY, not an event query
 * Revolt ("a permanent you controlled left the battlefield this turn"), morbid
 * ("a creature died this turn") and the lifegain check ("you gained life this
 * turn") are each a single boolean the card reads at resolution. A general
 * "query the event log" facility would be a different, much larger feature —
 * and one the compiler could not pattern-match honestly, because it would
 * accept text whose semantics it only half understood. So this is a fixed list
 * of {@link TurnFact}s, each with an exact meaning and an exact feed point, and
 * a card asking anything outside the list is reported unsupported.
 *
 * ## Storage: two integers, per player, as a BITMASK
 * `GameState.turnFacts` is one small record of two numbers. That shape is
 * deliberate: it is on the clone path (every action clones the state), so a
 * per-fact object or a Set would be a real allocation on the engine's hottest
 * path for a game in which nothing ever reads a fact. Two number copies cost
 * nothing measurable, and the field is OPTIONAL so every state serialized (or
 * hand-built in a test) before this existed still reads as "nothing happened".
 *
 * ## Feed point: the event stream, at the one place every event already passes
 * `recordTurnFacts` is called from the engine's emit wrapper — the same
 * chokepoint the trigger collector uses — so a fact cannot be recorded on one
 * mutation path and missed on another. Nothing new has to be emitted: every
 * fact here is derivable from events the engine already publishes, which is
 * also why this feature adds no `GameEvent` variant.
 *
 * ## Lifetime: cleared as a turn BEGINS
 * Cleared in `beginTurn` rather than at end-of-turn cleanup, so the facts are
 * still readable by anything resolving during the end step (where "this turn"
 * plainly still means this turn), and are empty for every player the moment a
 * new turn starts. Rule 500.7-style extra turns need no special handling: each
 * turn begins, so each turn clears.
 */

import type { GameEvent } from './events.js';
import type { GameState, PlayerId } from './state.js';

/**
 * The facts the engine remembers for the current turn. Each is a printed
 * card's question, spelled exactly:
 *  - `permanentLeftBattlefield` — "a permanent you controlled left the
 *    battlefield this turn" (REVOLT, Fatal Push). True for the player who
 *    CONTROLLED the permanent as it left, whoever destroyed it, and true for a
 *    sacrifice, a bounce, an exile and a land cracking alike — every one of
 *    those is the permanent leaving the battlefield.
 *  - `creatureDied` — "a creature died this turn" (MORBID). Deaths only: a
 *    creature exiled or bounced did not die.
 *  - `youGainedLife` — "you gained life this turn". True for the player whose
 *    life total went UP; a payment that later restores it does not un-gain it.
 */
export type TurnFact = 'permanentLeftBattlefield' | 'creatureDied' | 'youGainedLife';

/** Every tracked fact, in canonical order — the closed vocabulary itself. */
export const TURN_FACTS: readonly TurnFact[] = Object.freeze([
  'permanentLeftBattlefield',
  'creatureDied',
  'youGainedLife',
]);

/** The bit each fact occupies in a player's mask. */
const FACT_BIT: Readonly<Record<TurnFact, number>> = Object.freeze({
  permanentLeftBattlefield: 1 << 0,
  creatureDied: 1 << 1,
  youGainedLife: 1 << 2,
});

/** Per-player bitmask of what has happened so far this turn. */
export interface TurnFacts {
  A: number;
  B: number;
}

/** A fresh, empty record — nothing has happened yet this turn. */
export function emptyTurnFacts(): TurnFacts {
  return { A: 0, B: 0 };
}

/** Clear every player's facts. Called as a turn begins. */
export function clearTurnFacts(state: GameState): void {
  const facts = state.turnFacts;
  if (facts === undefined) {
    state.turnFacts = emptyTurnFacts();
    return;
  }
  facts.A = 0;
  facts.B = 0;
}

/**
 * Whether `fact` has happened for `player` so far this turn. A state with no
 * fact record answers false for everything, which is the correct reading of
 * "nothing has been recorded" and keeps pre-existing states valid.
 */
export function turnFactHolds(state: GameState, fact: TurnFact, player: PlayerId): boolean {
  const facts = state.turnFacts;
  return facts !== undefined && (facts[player] & FACT_BIT[fact]) !== 0;
}

/** Record `fact` for `player`. Idempotent — a fact is a boolean, not a count. */
export function setTurnFact(state: GameState, fact: TurnFact, player: PlayerId): void {
  const facts = (state.turnFacts ??= emptyTurnFacts());
  facts[player] |= FACT_BIT[fact];
}

/**
 * Fold one event into the turn's facts. Called for EVERY event, so it is written
 * as a switch on `type` with an immediate return for the (overwhelmingly common)
 * events that feed nothing.
 *
 * `controllerOfLeavingPermanent` is supplied by the caller because the
 * `zoneChange` event carries only an instance id, and by the time it is emitted
 * the permanent is already off the battlefield — the engine's emit wrapper is
 * the one place that can still look the instance up (its `controller` field is
 * preserved as last-known information by every leave path, which is exactly
 * what "a permanent YOU controlled left" needs to read).
 */
export function recordTurnFacts(
  state: GameState,
  event: GameEvent,
  controllerOfLeavingPermanent: (instanceId: number) => PlayerId | undefined,
): void {
  switch (event.type) {
    case 'zoneChange': {
      if (event.from !== 'battlefield') return;
      const controller = controllerOfLeavingPermanent(event.instanceId);
      if (controller !== undefined) setTurnFact(state, 'permanentLeftBattlefield', controller);
      return;
    }
    case 'creatureDied': {
      // A death is recorded for BOTH seats: morbid asks whether a creature died
      // this turn at all, not whose. Recording it per-player keeps one storage
      // shape for every fact, and the two writes are two OR-assignments.
      setTurnFact(state, 'creatureDied', 'A');
      setTurnFact(state, 'creatureDied', 'B');
      return;
    }
    case 'lifeChanged': {
      if (event.delta > 0) setTurnFact(state, 'youGainedLife', event.player);
      return;
    }
    default:
      return;
  }
}
