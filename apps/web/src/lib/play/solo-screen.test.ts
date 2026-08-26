/**
 * The solo-mode screen rules — the pin on bug report 20260825_210108 ("it
 * showed me just a flash of my opponents hand").
 *
 * The COMPONENT guarantee is structural and lives beside these: the screen
 * rendered for `aiDeciding` (`AiMulliganScreen`) takes a hand COUNT, not a
 * hand — its props cannot carry card identities, so a regression would need
 * someone to change a type signature, not merely reorder two effects.
 */
import { describe, expect, it } from 'vitest';
import { handoffIsToComputer, mulliganPresentationFor } from './solo-screen.js';

describe('mulliganPresentationFor', () => {
  it('never shows the hand for the seat the computer plays', () => {
    expect(mulliganPresentationFor('B', 'B')).toEqual({ kind: 'aiDeciding' });
    expect(mulliganPresentationFor('A', 'A')).toEqual({ kind: 'aiDeciding' });
  });

  it('shows the hand to a human, in solo and in pass-and-play alike', () => {
    expect(mulliganPresentationFor('A', 'B')).toEqual({ kind: 'human' });
    expect(mulliganPresentationFor('B', undefined)).toEqual({ kind: 'human' });
    expect(mulliganPresentationFor('A', undefined)).toEqual({ kind: 'human' });
  });
});

describe('handoffIsToComputer', () => {
  it('auto-acknowledges a handoff addressed to the computer', () => {
    expect(handoffIsToComputer('B', 'B')).toBe(true);
  });

  it('leaves human handoffs alone', () => {
    expect(handoffIsToComputer('A', 'B')).toBe(false);
    expect(handoffIsToComputer('B', undefined)).toBe(false);
  });
});
