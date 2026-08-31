/**
 * The update-timing rule, exhaustively. This matrix IS the user requirement —
 * "an update should come in without breaking or interrupting things" — so every
 * cell is spelled out rather than sampled.
 */
import { describe, expect, it } from 'vitest';
import {
  UPDATE_PILL_TEXT,
  decideUpdate,
  type LiveGameScreen,
  type UpdateInputs,
} from './update-decision.js';

const SCREENS: readonly (LiveGameScreen | null)[] = ['game', 'game-over', 'online-game', null];

describe('decideUpdate', () => {
  it('no update waiting → do nothing, show nothing (whatever else is true)', () => {
    for (const gameLive of [false, true]) {
      for (const screen of SCREENS) {
        const inputs: UpdateInputs = { updateReady: false, gameLive, screen };
        expect(decideUpdate(inputs)).toEqual({ action: 'none', pillText: null });
      }
    }
  });

  it('update waiting, no live game → apply now, no pill', () => {
    for (const screen of SCREENS) {
      const inputs: UpdateInputs = { updateReady: true, gameLive: false, screen };
      expect(decideUpdate(inputs)).toEqual({ action: 'applyNow', pillText: null });
    }
  });

  it('update waiting, live game → defer with the screen-appropriate pill', () => {
    for (const screen of ['game', 'game-over', 'online-game'] as const) {
      const decision = decideUpdate({ updateReady: true, gameLive: true, screen });
      expect(decision.action).toBe('defer');
      expect(decision.pillText).toBe(UPDATE_PILL_TEXT[screen]);
    }
  });

  it('a live game with no named screen still defers, with the in-game copy', () => {
    const decision = decideUpdate({ updateReady: true, gameLive: true, screen: null });
    expect(decision).toEqual({ action: 'defer', pillText: UPDATE_PILL_TEXT.game });
  });

  it('every pill copy is distinct and says when the update lands', () => {
    const texts = Object.values(UPDATE_PILL_TEXT);
    expect(new Set(texts).size).toBe(texts.length);
    for (const text of texts) expect(text).toMatch(/^Update ready — applies when /);
  });
});
