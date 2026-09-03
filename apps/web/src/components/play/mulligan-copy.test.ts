/**
 * Bug report 20260901_212439 — "I thought Mulligan was scry? Which means choose
 * to leave on top or put on bottom? This just says put on bottom." The rule is
 * the London mulligan and the screens now SAY so — pinned on the pure copy
 * table and on the rendered markup of both screens (the human's and the
 * computer's), in the literal reported state: mulligan 1, choosing 1 of 7 to
 * bottom, 0 chosen so far.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { CARD_POOL } from '@jonny-boi/cards';
import { MulliganScreen } from './MulliganScreen.js';
import { AiMulliganScreen } from './AiMulliganScreen.js';
import { LONDON_MULLIGAN_RULE, mulliganCopy } from '../../lib/play/mulligan-copy.js';

const FOREST = CARD_POOL.find((c) => c.name === 'Forest')!;

describe('mulliganCopy', () => {
  it('names the London mulligan in every phase', () => {
    for (const phase of ['choose', 'bottom'] as const) {
      for (const taken of [0, 1, 2]) {
        const copy = mulliganCopy({ handSize: 7, mulligansTaken: taken, phase, selectedCount: 0 });
        expect(copy.rule).toBe(LONDON_MULLIGAN_RULE);
        expect(copy.rule).toMatch(/London mulligan/);
        expect(copy.rule).toMatch(/bottom/);
      }
    }
  });

  it('the reported state: mulligan 1, bottoming, says bottom-of-library and never "scry" or "top"', () => {
    const copy = mulliganCopy({ handSize: 7, mulligansTaken: 1, phase: 'bottom', selectedCount: 0 });
    expect(copy.status).toBe(
      'Mulligan 1 — choose 1 card to put on the bottom of your library (0/1). The rest stay in your hand.',
    );
    expect(copy.status).not.toMatch(/scry|on top/i);
    expect(copy.confirmButton).toBe('Put 1 card on the bottom and keep');
  });

  it('before keeping, explains what a keep will cost', () => {
    const copy = mulliganCopy({ handSize: 7, mulligansTaken: 2, phase: 'choose', selectedCount: 0 });
    expect(copy.status).toMatch(/put 2 cards of your choice on the bottom, keeping 5/);
    expect(copy.keepButton).toBe('Keep (5 cards)');
    expect(copy.mulliganButton).toMatch(/redraw seven/);
  });
});

describe('both mulligan screens render the rule', () => {
  const hand = Array.from({ length: 7 }, (_, i) => ({
    instanceId: i + 1,
    cardId: FOREST.id,
    name: FOREST.name,
    isLand: true,
  }));

  it('the human screen, in the reported state', () => {
    const html = renderToStaticMarkup(
      createElement(MulliganScreen, {
        seat: 'A',
        name: 'Player 1',
        hand,
        mulligansTaken: 1,
        maxMulligans: 6,
        onKeep: () => {},
        onMulligan: () => {},
      }),
    );
    expect(html).toContain('London mulligan');
    expect(html).toContain('mulligan__rule');
  });

  it('the computer’s screen', () => {
    const html = renderToStaticMarkup(createElement(AiMulliganScreen, { name: 'Computer', handCount: 7 }));
    expect(html).toContain('London mulligan');
  });
});
