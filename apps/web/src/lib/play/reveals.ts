/**
 * THE LATEST REVEAL, as the board shows it (pure, unit-tested).
 *
 * Bug report 20260901_210413: Goblin Guide's attack trigger reveals the top
 * card of the defending player's library, and the engine did it correctly —
 * but the reveal existed nowhere a player could look. The engine now emits
 * `cardRevealed` (public by definition: a reveal is a card turned face up for
 * everyone), and this fold turns the event stream into the one banner worth
 * showing: the most recent reveal, with the card's identity and what became of
 * it.
 *
 * A FOLD over the events rather than state stored on the board, for the same
 * reason §3.57's animations are: a derived value cannot go stale, and a replay
 * or a resumed game re-derives the same banner from the same log.
 */
import type { GameEvent, InstanceId, PlayerId } from '@jonny-boi/core';

/** What the banner needs to draw one reveal. */
export interface RevealView {
  /** The revealing player's own index into the event stream, so a repeat re-shows. */
  readonly at: number;
  readonly instanceId: InstanceId;
  readonly cardId: string;
  readonly name: string;
  readonly player: PlayerId;
  readonly text: string;
}

/** How a reveal event names the card and its outcome, from `viewer`'s seat. */
export function describeReveal(
  event: Extract<GameEvent, { type: 'cardRevealed' }>,
  viewer: PlayerId,
  names: Readonly<Record<PlayerId, string>>,
  sourceName: string,
): string {
  const whose = event.player === viewer ? 'your' : `${names[event.player]}'s`;
  const outcome = event.matched
    ? `it goes to ${event.player === viewer ? 'your' : 'their'} hand`
    : 'it stays on top';
  return `${sourceName} reveals ${event.name} from the top of ${whose} ${event.fromZone} — ${outcome}.`;
}

/**
 * The most recent reveal in `events`, or null when there has never been one.
 *
 * `cardId` is resolved through the caller's lookup (the board's instance
 * index): the event carries the printed NAME, which is what makes it safe to
 * log, and the board wants the art too. A card the lookup cannot resolve still
 * yields a banner — with no image rather than no banner.
 */
export function latestReveal(
  events: readonly GameEvent[],
  viewer: PlayerId,
  names: Readonly<Record<PlayerId, string>>,
  lookup: (id: InstanceId) => { readonly cardId: string; readonly name: string } | undefined,
  nameOf: (id: InstanceId) => string,
): RevealView | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (!event || event.type !== 'cardRevealed') continue;
    const found = lookup(event.instanceId);
    return {
      at: i,
      instanceId: event.instanceId,
      cardId: found?.cardId ?? '',
      name: event.name,
      player: event.player,
      text: describeReveal(event, viewer, names, nameOf(event.sourceInstanceId)),
    };
  }
  return null;
}
