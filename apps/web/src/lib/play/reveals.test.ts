/**
 * Bug report 20260901_210413 — "The goblin guide of the enemy is not revealing
 * the top card of my library so I can see it, and give me it if its a land. In
 * fact I dont even see a library."
 *
 * The engine was right (the land did reach the hand); the reveal was invisible.
 * These pin the fold the board's banner reads — including the wording from the
 * VICTIM's seat, which is the seat the reporter was sitting in.
 */
import { describe, expect, it } from 'vitest';
import type { GameEvent, PlayerId } from '@jonny-boi/core';
import { latestReveal, describeReveal } from './reveals.js';

const NAMES: Readonly<Record<PlayerId, string>> = { A: 'Player 1', B: 'Computer' };

const revealed = (over: Partial<Extract<GameEvent, { type: 'cardRevealed' }>> = {}): GameEvent => ({
  type: 'cardRevealed',
  player: 'A',
  instanceId: 42,
  name: 'Plains',
  fromZone: 'library',
  sourceInstanceId: 7,
  matched: true,
  ...over,
});

const lookup = (id: number) => (id === 42 ? { cardId: 'plains-id', name: 'Plains' } : undefined);
const nameOf = (id: number) => (id === 7 ? 'Goblin Guide' : `#${id}`);

describe('describeReveal', () => {
  it('the reported case, from the victim’s seat: their Goblin Guide, YOUR library', () => {
    expect(describeReveal(revealed() as never, 'A', NAMES, 'Goblin Guide')).toBe(
      'Goblin Guide reveals Plains from the top of your library — it goes to your hand.',
    );
  });

  it('from the attacker’s seat it names the other player', () => {
    expect(describeReveal(revealed() as never, 'B', NAMES, 'Goblin Guide')).toBe(
      "Goblin Guide reveals Plains from the top of Player 1's library — it goes to their hand.",
    );
  });

  it('a non-land reveal says the card stays on top', () => {
    expect(describeReveal(revealed({ name: 'Grizzly Bears', matched: false }) as never, 'A', NAMES, 'Goblin Guide')).toBe(
      'Goblin Guide reveals Grizzly Bears from the top of your library — it stays on top.',
    );
  });
});

describe('latestReveal', () => {
  it('is null with no reveals in the log', () => {
    expect(latestReveal([{ type: 'turnBegin', turn: 1, activePlayer: 'A' }], 'A', NAMES, lookup, nameOf)).toBeNull();
  });

  it('takes the MOST RECENT reveal, and carries the art id for the banner', () => {
    const events: GameEvent[] = [
      revealed({ name: 'Forest' }),
      { type: 'turnBegin', turn: 4, activePlayer: 'B' },
      revealed({ name: 'Plains' }),
    ];
    const view = latestReveal(events, 'A', NAMES, lookup, nameOf);
    expect(view?.name).toBe('Plains');
    expect(view?.cardId).toBe('plains-id');
    expect(view?.at).toBe(2);
  });

  it('a card the board cannot resolve still gets a banner, just no image', () => {
    const view = latestReveal([revealed({ instanceId: 999 })], 'A', NAMES, lookup, nameOf);
    expect(view?.cardId).toBe('');
    expect(view?.text).toContain('reveals Plains');
  });
});
