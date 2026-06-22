import { describe, expect, it } from 'vitest';
import type { PlayerId } from '@jonny-boi/core';
import { maskStateForSeat } from '@jonny-boi/protocol';
import { SAMPLE_DECKS } from '@jonny-boi/sim';
import { startHotseatGame } from '../play/setup.js';
import { maskedViewToBoardView } from './board-adapter.js';

const NAMES: Readonly<Record<PlayerId, string>> = { A: 'Alice', B: 'Bob' };

/** Build a real game state, then mask it for `seat` exactly as the server would. */
function maskedFor(seat: PlayerId) {
  const red = SAMPLE_DECKS.find((d) => d.name.toLowerCase().includes('red'))!;
  const started = startHotseatGame({
    choiceA: { source: 'sample', deck: red },
    choiceB: { source: 'sample', deck: red },
    seed: 12345,
    startingPlayer: 'A',
  });
  if (!started.ok) throw new Error('sample decks should be legal');
  const state = started.game.created.state;
  return maskStateForSeat(state, seat);
}

describe('maskedViewToBoardView', () => {
  it("reveals the viewer's own hand (cards present, count matches)", () => {
    const view = maskedViewToBoardView(maskedFor('A'), NAMES);
    expect(view.viewer).toBe('A');
    expect(view.self.id).toBe('A');
    expect(view.self.hand).not.toBeNull();
    expect(view.self.hand!.length).toBe(view.self.handCount);
    // Each revealed hand card carries a real card id + name (no placeholders).
    for (const card of view.self.hand!) {
      expect(typeof card.cardId).toBe('string');
      expect(card.name.length).toBeGreaterThan(0);
    }
  });

  it("masks the opponent's hand to a count only (never the identities)", () => {
    const view = maskedViewToBoardView(maskedFor('A'), NAMES);
    expect(view.opponent.id).toBe('B');
    expect(view.opponent.hand).toBeNull();
    expect(view.opponent.handCount).toBeGreaterThan(0);
  });

  it('mirrors correctly from the opponent seat (B sees B revealed, A hidden)', () => {
    const view = maskedViewToBoardView(maskedFor('B'), NAMES);
    expect(view.viewer).toBe('B');
    expect(view.self.id).toBe('B');
    expect(view.self.hand).not.toBeNull();
    expect(view.opponent.id).toBe('A');
    expect(view.opponent.hand).toBeNull();
  });

  it('carries display names, turn metadata, and public scalars through', () => {
    const masked = maskedFor('A');
    const view = maskedViewToBoardView(masked, NAMES);
    expect(view.self.name).toBe('Alice');
    expect(view.opponent.name).toBe('Bob');
    expect(view.turnNumber).toBe(masked.turnNumber);
    expect(view.activePlayer).toBe(masked.activePlayer);
    expect(view.priorityPlayer).toBe(masked.priorityPlayer);
    expect(view.step).toBe(masked.step);
    expect(view.self.life).toBe(masked.players.A.life);
  });

  it('never copies opponent card data into the board view (anti-cheat)', () => {
    const view = maskedViewToBoardView(maskedFor('A'), NAMES);
    // The opponent SeatView exposes no hand array at all.
    expect(view.opponent.hand).toBeNull();
    // Serializing the view must not contain a populated opponent hand.
    const json = JSON.stringify(view);
    const parsed = JSON.parse(json);
    expect(parsed.opponent.hand).toBeNull();
  });
});
