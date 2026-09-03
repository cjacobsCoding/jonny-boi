/**
 * POISON COUNTERS — the one counter a PLAYER carries (CR 122.1f), and the
 * second way a game of Magic is lost (CR 704.5c). §3.105.
 *
 * ## Why a module, and why a single writer
 * Life has exactly one damage funnel (`internal/damage-result.ts`) so that a
 * burn spell, a combat hit and a lifelink gain can never disagree about what a
 * point of damage means. Poison is the same resource shape — a per-player
 * integer with a game-losing threshold — and it gets the same discipline:
 * {@link addPoisonCounters} is the ONLY code that writes `PlayerState.poison`,
 * and {@link poisonOf} the only reader of the raw field. Infect (CR 702.90),
 * toxic (CR 702.164), proliferate (CR 701.34) and any printed "gets a poison
 * counter" all come through here, which is what makes the `poisonChanged`
 * event complete: a replay that folds it sees every poison counter that was
 * ever given.
 *
 * ## Why the field is optional
 * `PlayerState.poison` is absent, not zero, on every state that predates this
 * module — serialized replays, persisted online games, hand-built test boards.
 * Reading it through {@link poisonOf} is what keeps "absent" meaning "no poison"
 * instead of `undefined >= 10`, exactly as `turn-facts.ts` treats its bitmask.
 */

import type { GameEvent } from './events.js';
import type { GameState, PlayerId, PlayerState } from './state.js';

/**
 * The one field the readers need — structural, so a pilot's deep-readonly view
 * of a player and the engine's mutable `PlayerState` read through the same
 * function rather than each casting or restating `?? 0`.
 */
type HasPoison = Pick<PlayerState, 'poison'>;

/**
 * CR 704.5c — "If a player has ten or more poison counters, that player loses
 * the game." The threshold is the rule's own number; nothing else in the engine
 * may restate it.
 */
export const POISON_LOSS_THRESHOLD = 10;

/** The `playerLost` reason the state-based action writes, so a test can pin it. */
export const POISON_LOSS_REASON = 'ten or more poison counters';

/** A player's poison counters — zero when the field was never written. */
export function poisonOf(player: HasPoison): number {
  return player.poison ?? 0;
}

/** CR 122.1f — a player is "poisoned" if they have one or more poison counters. */
export function isPoisoned(player: HasPoison): boolean {
  return poisonOf(player) > 0;
}

/** Whether CR 704.5c would take this player's game on the next check. */
export function hasLethalPoison(player: HasPoison): boolean {
  return poisonOf(player) >= POISON_LOSS_THRESHOLD;
}

/**
 * Give a player poison counters — THE ONE WRITER. Emits `poisonChanged` with the
 * resulting total, and nothing else: the loss itself is a state-based action
 * (CR 704.5c) performed by the next SBA pass, exactly as a life total reaching
 * zero is, so a player given their tenth counter mid-resolution still finishes
 * that resolution before the game ends.
 *
 * A non-positive amount is a no-op rather than a removal: no printed card
 * removes poison through this verb, and a negative delta arriving here would be
 * a bug worth keeping visible rather than absorbing.
 */
export function addPoisonCounters(
  state: GameState,
  player: PlayerId,
  amount: number,
  emit: (e: GameEvent) => void,
): void {
  if (amount <= 0) return;
  const p = state.players[player];
  const to = poisonOf(p) + amount;
  p.poison = to;
  emit({ type: 'poisonChanged', player, delta: amount, to });
}
