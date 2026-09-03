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
import { opponentOf } from './state.js';
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
  | 'drewInOwnDrawStep'
  /**
   * §3.112 — "you … have cast another spell this turn" (SURGE, CR 702.117a).
   * True for the player who cast any spell so far this turn. Read BEFORE the
   * surge spell itself is announced, so "another" is exactly the prior casts.
   */
  | 'castASpell'
  /**
   * §3.110 — "**an opponent was dealt damage this turn**" (BLOODTHIRST, CR
   * 702.54a; Skarrgan Firebird's activation restriction). True for a player
   * when a `damageDealt` event landed on THEIR OPPONENT — combat or not, by
   * any source — so it is recorded for the player on the other side of the
   * damage, never for the one who took it.
   */
  | 'opponentWasDealtDamage';

/** Every tracked fact, in canonical order — the closed vocabulary itself. */
export const TURN_FACTS: readonly TurnFact[] = Object.freeze([
  'permanentLeftBattlefield',
  'creatureDied',
  'youGainedLife',
  'drewInOwnDrawStep',
  'castASpell',
  'opponentWasDealtDamage',
]);

/** The bit each fact occupies in a player's mask. */
const FACT_BIT: Readonly<Record<TurnFact, number>> = Object.freeze({
  permanentLeftBattlefield: 1 << 0,
  creatureDied: 1 << 1,
  youGainedLife: 1 << 2,
  drewInOwnDrawStep: 1 << 3,
  // ⚠️ ONE BIT PER FACT. §3.112 and §3.110 both landed a fifth fact at
  // `1 << 4` on their own branches; sharing a bit would make surge's "you cast
  // another spell" true the moment an opponent took damage, and neither test
  // would see it — each family passes on its own bit. The next fact is
  // `1 << 6`.
  castASpell: 1 << 4,
  opponentWasDealtDamage: 1 << 5,
});

/** Clear every player's facts. Called as a turn begins. */
export function clearTurnFacts(state: GameState): void {
  state.turnFactsA = 0;
  state.turnFactsB = 0;
  // §3.113 — the spell count has the facts' lifetime: it is a turn's memory.
  state.spellsCastThisTurn = 0;
}

// --- the spell-count family (§3.113) -------------------------------------------
/**
 * How many spells have been cast so far this turn, by either player — storm's
 * count (CR 702.40a). A state with no record answers zero, for the reason
 * `turnFactHolds` does.
 */
export function spellsCastThisTurn(state: GameState): number {
  return state.spellsCastThisTurn ?? 0;
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
    // §3.110 — damage that LANDED on a player is a fact for their opponent
    // (bloodthirst). A player target is a PlayerId string; an instance id is a
    // number, which is how "to a player" is told from "to a creature" here.
    case 'damageDealt': {
      if (typeof event.target === 'string' && event.amount > 0) {
        setTurnFact(state, 'opponentWasDealtDamage', opponentOf(event.target));
      }
      return;
    }
    // §3.113 — storm's count. Every cast by either player, counted at the one
    // chokepoint every event passes; a COPY of a spell is never cast (CR
    // 707.10) and emits `spellCopied`, not `spellCast`, so it is not counted.
    case 'spellCast': {
      state.spellsCastThisTurn = (state.spellsCastThisTurn ?? 0) + 1;
      // §3.112 — surge's "another spell this turn" (CR 702.117a) is the same
      // event seen per PLAYER: any cast, from any zone, for any cost. Read
      // before the surge spell itself is announced, so "another" is exactly
      // the prior casts. One case, two readings — a second `case 'spellCast'`
      // would be unreachable, which is how the merge of these two families
      // could have silently lost surge.
      setTurnFact(state, 'castASpell', event.player);
      return;
    }
    default:
      return;
  }
}
