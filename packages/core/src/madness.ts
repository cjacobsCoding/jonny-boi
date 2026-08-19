/**
 * MADNESS (CR 702.35) — the discard half.
 *
 * Madness is not a cast-time cost like kicker or buyback: it is a REPLACEMENT
 * on the discard itself ("if you discard this card, exile it instead") plus a
 * cast opportunity that follows. This module owns the first half and the state
 * it opens; the engine owns the second (the cast from exile, and the pass that
 * declines it).
 *
 * It lives in its own module rather than inside `internal/zones.ts` because
 * there are TWO discard funnels in this codebase — core's `moveToZone` and the
 * cards package's `moveOwnedCard` — and a replacement that applies to one but
 * not the other is the same class of bug `spellLeaveDestination` exists to
 * prevent. Both call {@link discardDestination}, so a card with madness cannot
 * be exiled by one discard and buried by another.
 */

import type { CardInstance, GameState, ZoneName } from './state.js';
import type { GameEvent } from './events.js';

/**
 * Where a card being discarded (hand → graveyard) actually goes, opening a
 * madness window as a side effect when the answer is exile.
 *
 * Call it ONLY for a genuine discard — a card leaving a hand for a graveyard.
 * Every other move to the graveyard (a creature dying, a spell resolving) is
 * not a discard and must not be routed here, because madness does not apply to
 * it (CR 701.8a defines discarding as exactly this move).
 *
 * When a window is ALREADY open the card is not diverted and goes to the
 * graveyard. That is only reachable by discarding two madness cards
 * simultaneously — no card in the measured corpus can — and it errs in the
 * direction that plays WORSE than printed (a madness card that was simply
 * discarded), never better.
 */
export function discardDestination(
  state: GameState,
  card: CardInstance,
  emit: (event: GameEvent) => void,
): ZoneName {
  const cost = card.def.madness;
  if (cost === undefined) return 'graveyard';
  if (state.madnessWindow) return 'graveyard';
  state.madnessWindow = { instanceId: card.instanceId, controller: card.owner };
  emit({
    type: 'madnessWindowOpened',
    player: card.owner,
    instanceId: card.instanceId,
    name: card.def.name,
  });
  return 'exile';
}

/**
 * Close an open madness window by DECLINING it: the exiled card falls into its
 * owner's graveyard, which is where the discard that opened the window would
 * have put it (CR 702.35a — the card is exiled, and if it is not cast it stays
 * exiled *only* while the trigger is resolving; declining leaves it discarded).
 *
 * Returns false when there was no window or the card has since moved on, so a
 * caller can tell "declined" from "nothing to decline" without inspecting state
 * itself.
 */
export function declineMadness(state: GameState, emit: (event: GameEvent) => void): boolean {
  const window = state.madnessWindow;
  if (!window) return false;
  state.madnessWindow = null;
  const owner = state.players[window.controller];
  const index = owner.exile.findIndex((c) => c.instanceId === window.instanceId);
  if (index < 0) return false;
  const [card] = owner.exile.splice(index, 1);
  if (!card) return false;
  card.zone = 'graveyard';
  owner.graveyard.push(card);
  emit({ type: 'zoneChange', instanceId: card.instanceId, from: 'exile', to: 'graveyard' });
  emit({ type: 'madnessDeclined', player: window.controller, instanceId: card.instanceId, name: card.def.name });
  return true;
}
