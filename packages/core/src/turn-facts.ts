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
 * ## Storage: two FLAT number fields on the state, as bitmasks
 * `GameState.turnFactsA` / `turnFactsB` are plain optional numbers, not a
 * nested record — and that shape was chosen with a measurement, not a guess.
 * A `{ A, B }` object is one allocation PER CLONE, and the engine clones the
 * whole state at every action boundary; on a paired same-box gauntlet that cost
 * ~3% of sim throughput for a game in which nothing ever reads a fact. Two
 * number copies allocate nothing and measure at parity. (Same argument as the
 * shared frozen NO_COUNTERS record documented in state.ts.)
 *
 * The two fields are OPTIONAL so every state serialized (or hand-built in a
 * test) before this existed still reads as "nothing happened", and every access
 * goes through the helpers below so the flat shape stays an implementation
 * detail rather than something callers index into.
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
import type { GameState, InstanceId, PlayerId } from './state.js';
import { findInstance } from './internal/zones.js';

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
 *  - `drewInOwnDrawStep` — "you have already taken the first draw of your draw
 *    step this turn". The exact reading of the printed exception "except the
 *    FIRST one you draw in each of your draw steps" (Teferi's Ageless Insight,
 *    Alhammarret's Archive, Notion Thief). Set as that draw happens, so the
 *    replacement layer — which asks BEFORE the draw — sees `false` for the first
 *    one and `true` for every later draw in the same step. Each player has one
 *    draw step per turn, so a turn-scoped fact says exactly what a step-scoped
 *    one would, with no second lifetime to keep.
 */
export type TurnFact =
  | 'permanentLeftBattlefield'
  | 'creatureDied'
  | 'youGainedLife'
  | 'drewInOwnDrawStep';

/** Every tracked fact, in canonical order — the closed vocabulary itself. */
export const TURN_FACTS: readonly TurnFact[] = Object.freeze([
  'permanentLeftBattlefield',
  'creatureDied',
  'youGainedLife',
  'drewInOwnDrawStep',
]);

/** The bit each fact occupies in a player's mask. */
const FACT_BIT: Readonly<Record<TurnFact, number>> = Object.freeze({
  permanentLeftBattlefield: 1 << 0,
  creatureDied: 1 << 1,
  youGainedLife: 1 << 2,
  drewInOwnDrawStep: 1 << 3,
});

/** Clear every player's facts. Called as a turn begins. */
export function clearTurnFacts(state: GameState): void {
  state.turnFactsA = 0;
  state.turnFactsB = 0;
}

/**
 * Whether `fact` has happened for `player` so far this turn. A state with no
 * fact record answers false for everything, which is the correct reading of
 * "nothing has been recorded" and keeps pre-existing states valid.
 */
export function turnFactHolds(state: GameState, fact: TurnFact, player: PlayerId): boolean {
  const mask = (player === 'A' ? state.turnFactsA : state.turnFactsB) ?? 0;
  return (mask & FACT_BIT[fact]) !== 0;
}

/** Record `fact` for `player`. Idempotent — a fact is a boolean, not a count. */
export function setTurnFact(state: GameState, fact: TurnFact, player: PlayerId): void {
  const bit = FACT_BIT[fact];
  if (player === 'A') state.turnFactsA = (state.turnFactsA ?? 0) | bit;
  else state.turnFactsB = (state.turnFactsB ?? 0) | bit;
}

/**
 * Who controlled a permanent that has just left the battlefield. Only consulted
 * for a leave event, so an ordinary event never pays for the scan.
 */
function lastKnownController(state: GameState, instanceId: InstanceId): PlayerId | undefined {
  return findInstance(state, instanceId)?.controller;
}

/**
 * Fold one event into the turn's facts. Called for EVERY event, so it is written
 * as a switch on `type` with an immediate return for the (overwhelmingly common)
 * events that feed nothing.
 *
 * The leaving permanent's controller is looked up HERE rather than passed in:
 * the `zoneChange` event carries only an instance id, and by the time it is
 * emitted the permanent is already off the battlefield — but every leave path
 * preserves `controller` as last-known information, which is exactly what "a
 * permanent YOU controlled left the battlefield" has to read. Doing the lookup
 * inline (rather than through a callback the emit wrapper has to allocate once
 * per action) keeps this off the per-action allocation budget.
 */
export function recordTurnFacts(state: GameState, event: GameEvent): void {
  switch (event.type) {
    case 'zoneChange': {
      if (event.from !== 'battlefield') return;
      const controller = lastKnownController(state, event.instanceId);
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
    case 'drawCard': {
      // Only a draw taken during that player's OWN draw step counts — the
      // printed exception is about the draw step, not about drawing generally.
      if (state.step === 'draw' && event.player === state.activePlayer) {
        setTurnFact(state, 'drewInOwnDrawStep', event.player);
      }
      return;
    }
    default:
      return;
  }
}
