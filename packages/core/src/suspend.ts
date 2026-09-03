/**
 * SUSPEND (CR 702.62) — the exile-side half of the keyword, as state.
 *
 * "Suspend N—[cost]" is three abilities (CR 702.62a). The first — pay the cost
 * and exile the card with N time counters — is the `suspendCard` special action
 * in engine.ts. The other two "function in the exile zone", and the trigger
 * collector reads the battlefield and the command zone only: walking every
 * exiled card on every event would put a cost on the engine's hottest path for
 * a mechanic most games never see. So the exile-side abilities ride a DELAYED
 * triggered ability (CR 603.7) created as the card is suspended and re-created
 * by its own resolution while time counters remain — the record lives on
 * `GameState.delayedTriggers`, which is precisely the home for an ability that
 * belongs to no permanent. Its body is the cards package's `suspendTick`
 * primitive, handed over as `SuspendAbility.upkeep` exactly the way a cycling
 * ability's body is; core never names a primitive.
 *
 * ## The free cast is a WINDOW, not a permission
 * "When the last time counter is removed … you may cast it without paying its
 * mana cost if able. If you don't, it remains exiled." That is a decision made
 * AT THAT MOMENT, not a standing permission to cast the card whenever it suits
 * — a card-grant permission (`castFree`) would let a pilot hold a free Rift
 * Bolt in exile until the perfect turn, a strictly better card than printed.
 * The madness window is already the engine's "cast this exiled card now or
 * decline" moment, with the offer loop, `dispatchAction` and the pilots all
 * built around it, so suspend reuses that record with `kind: 'suspend'` (see
 * `MadnessWindow.kind`) rather than growing a second window nobody would remember
 * to freeze the game for.
 *
 * ## Haste, without a continuous effect
 * "If you cast a creature spell this way, it gains haste until you lose control
 * of the spell or the permanent it becomes." In this engine haste is read only
 * ever as `summoningSick && !haste` — attacking and {T} abilities — and every
 * control change re-sets `summoningSick`. So a creature that ENTERS UNSICK is
 * exactly a creature with haste until its controller loses it, with no
 * continuous effect to expire on a control change (`ContinuousDuration` has no
 * "until you lose control" and inventing one for this corner is more machinery
 * than the rule). The cast marks the stack object `hasteOnEntry`; the entry
 * reads it. The one thing this does NOT say is the word "haste" on the
 * creature's characteristics, which nothing in the pool reads.
 */

import type { GameEvent } from './events.js';
import type { CardInstance, GameState } from './state.js';
import { TIME_COUNTER } from './upkeep-costs.js';

/**
 * Whether `card` is SUSPENDED in the CR 702.62b sense: in exile, printing
 * suspend, with a time counter on it.
 */
export function isSuspended(card: CardInstance): boolean {
  return card.zone === 'exile' && card.def.suspend !== undefined && (card.counters[TIME_COUNTER] ?? 0) > 0;
}

/**
 * Open the free-cast window for a suspended card whose last time counter has
 * just been removed. Returns false — and the card simply remains exiled — when
 * another window already stands: two suspends resolving in the same upkeep
 * open their windows one at a time, because the first window freezes the game
 * until it is answered and the second trigger resolves only afterwards, so
 * this branch is reachable only from a hand-built state.
 */
export function openSuspendWindow(state: GameState, card: CardInstance, emit: (e: GameEvent) => void): boolean {
  if (state.madnessWindow) return false;
  if (card.zone !== 'exile') return false;
  state.madnessWindow = { instanceId: card.instanceId, controller: card.owner, kind: 'suspend' };
  emit({ type: 'suspendWindowOpened', player: card.owner, instanceId: card.instanceId, name: card.def.name });
  return true;
}

/**
 * Whether the open window (if any) is a SUSPEND window for this card and
 * player — the question the cast path and the offer loop ask before charging
 * nothing for the cast.
 */
export function suspendWindowOpenFor(state: GameState, card: CardInstance, player: CardInstance['controller']): boolean {
  const window = state.madnessWindow;
  return (
    window !== undefined &&
    window !== null &&
    window.kind === 'suspend' &&
    window.instanceId === card.instanceId &&
    window.controller === player
  );
}
