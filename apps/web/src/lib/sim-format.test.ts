import { describe, expect, it } from 'vitest';
import type { ProportionCI } from '@jonny-boi/sim';
import {
  toSimPayload,
  pct,
  signedPct,
  ciStr,
  pValueStr,
  verdictDisplay,
  gamesPerSecond,
  throughputText,
  etaText,
  durationText,
} from './sim-format.js';
import type { Deck } from './deck.js';

const makeDeck = (cards: Deck['cards']): Deck => ({
  id: 'd1',
  name: 'Test Deck',
  cards,
  updatedAt: '2026-01-01T00:00:00.000Z',
});

describe('toSimPayload', () => {
  it('carries cardIds and counts verbatim into the sim Deck shape', () => {
    const deck = makeDeck([
      { cardId: 'abc-123', count: 4 },
      { cardId: 'def-456', count: 2 },
    ]);
    const payload = toSimPayload(deck);
    expect(payload.name).toBe('Test Deck');
    // The sim Deck requires an archetype; we derive it from the name.
    expect(payload.archetype).toBe('Test Deck');
    expect(payload.cards).toEqual([
      { cardId: 'abc-123', count: 4 },
      { cardId: 'def-456', count: 2 },
    ]);
  });

  it('produces an independent cards array (no shared reference)', () => {
    const deck = makeDeck([{ cardId: 'x', count: 1 }]);
    const payload = toSimPayload(deck);
    expect(payload.cards).not.toBe(deck.cards);
  });
});

describe('formatting helpers', () => {
  it('pct renders a probability as a one-decimal percentage', () => {
    expect(pct(0.5)).toBe('50.0%');
    expect(pct(0.532)).toBe('53.2%');
    expect(pct(0)).toBe('0.0%');
    expect(pct(1)).toBe('100.0%');
  });

  it('signedPct prefixes a + for non-negative deltas only', () => {
    expect(signedPct(0.024)).toBe('+2.4%');
    expect(signedPct(0)).toBe('+0.0%');
    expect(signedPct(-0.011)).toBe('-1.1%');
  });

  it('ciStr renders the point estimate with its interval', () => {
    const ci: ProportionCI = { p: 0.532, low: 0.481, high: 0.582, successes: 53, n: 100 };
    expect(ciStr(ci)).toBe('53.2% (48.1%–58.2%)');
  });

  it('pValueStr uses exponential for tiny values and decimals otherwise', () => {
    expect(pValueStr(0)).toBe('0');
    expect(pValueStr(0.0001)).toBe('1.00e-4');
    expect(pValueStr(0.04)).toBe('0.040');
    expect(pValueStr(1)).toBe('1.000');
  });
});

describe('verdictDisplay', () => {
  it('maps each verdict to a label + tone', () => {
    expect(verdictDisplay('better')).toEqual({ label: 'BETTER', tone: 'better' });
    expect(verdictDisplay('worse')).toEqual({ label: 'WORSE', tone: 'worse' });
    expect(verdictDisplay('inconclusive')).toEqual({
      label: 'INCONCLUSIVE',
      tone: 'inconclusive',
    });
  });
});

describe('gamesPerSecond', () => {
  it('divides games by elapsed seconds', () => {
    expect(gamesPerSecond(1000, 2)).toBe(500);
  });

  it('returns 0 rather than dividing by zero', () => {
    expect(gamesPerSecond(1000, 0)).toBe(0);
  });
});

describe('throughputText', () => {
  it('reads as games/sec for a run fast enough to round meaningfully', () => {
    expect(throughputText(42)).toBe('42 games/sec');
    expect(throughputText(1)).toBe('1 games/sec');
  });

  it('flips to seconds-per-game when games/sec would round to zero', () => {
    // An MCTS game can take tens of seconds; "0 games/sec" reads as broken.
    expect(throughputText(1 / 37.1)).toBe('37.1s/game');
    expect(throughputText(0.5)).toBe('2.0s/game');
  });

  it('shows a dash rather than a number before any game has finished', () => {
    expect(throughputText(0)).toBe('— games/sec');
    expect(throughputText(-1)).toBe('— games/sec');
  });
});

describe('etaText', () => {
  it('extrapolates the remaining time from the work done so far', () => {
    // 5 of 10 games in 30s => 5 games at 6s each = 30s.
    expect(etaText(5, 10, 30)).toBe('~30s left');
    // 2 of 10 in 20s => 80s, long enough to read in minutes.
    expect(etaText(2, 10, 20)).toBe('~1 min left');
  });

  it('switches to minutes once the estimate is long', () => {
    expect(etaText(1, 100, 12)).toBe('~20 min left');
  });

  it('says nothing when there is nothing to extrapolate from', () => {
    expect(etaText(0, 10, 5)).toBeNull();
    expect(etaText(2, 10, 0)).toBeNull();
    expect(etaText(10, 10, 50)).toBeNull();
    expect(etaText(2, 0, 5)).toBeNull();
  });
});

describe('durationText', () => {
  it('names one unit, coarsely — it renders ESTIMATES, not stopwatch readings', () => {
    expect(durationText(12)).toBe('12 seconds');
    expect(durationText(90)).toBe('2 minutes');
    expect(durationText(3 * 3600)).toBe('3 hours');
    expect(durationText(2 * 86400)).toBe('2 days');
  });

  it('says "seconds" for anything under a minute, and never "0 seconds"', () => {
    expect(durationText(0.2)).toBe('1 second');
    expect(durationText(59)).toBe('59 seconds');
  });

  it('singularises exactly one of each unit', () => {
    expect(durationText(1)).toBe('1 second');
    expect(durationText(60)).toBe('1 minute');
    expect(durationText(3600)).toBe('1 hour');
    expect(durationText(86400)).toBe('1 day');
  });

  it('degrades on nonsense instead of printing NaN', () => {
    expect(durationText(0)).toBe('no time at all');
    expect(durationText(-5)).toBe('no time at all');
    expect(durationText(Number.NaN)).toBe('no time at all');
  });
});
