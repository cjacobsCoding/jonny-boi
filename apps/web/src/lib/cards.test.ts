/**
 * DISPLAY RECORDS: back faces, and the synthesized fallback.
 *
 * Back-face display records (transforming DFCs).
 *
 * A transformed permanent's `cardId` is `<frontId>#back` (the compiler's
 * back-face id), and every render path — board tiles, CardHover — resolves art
 * through `getCard`. These tests pin that the back face resolves to its OWN
 * face data (name, art, P/T, type line), that the suffix agrees with the
 * compiler's, and that back faces never leak into the pickable card pool.
 */

import { describe, expect, it } from 'vitest';
import { BACK_FACE_ID_SUFFIX as COMPILER_SUFFIX } from '@jonny-boi/cards';
import type { CardDefinition } from '@jonny-boi/core';
import { allAvailableCards, allCards, BACK_FACE_ID_SUFFIX, cardImage, getCard, manaPips } from './cards.js';
import { displayRecordFor } from './cards/enginePool.js';

const DELVER = allCards.find((card) => card.name.startsWith('Delver of Secrets'));

describe('getCard — back faces of transforming DFCs', () => {
  it('agrees with the compiler about the back-face id suffix', () => {
    expect(BACK_FACE_ID_SUFFIX).toBe(COMPILER_SUFFIX);
  });

  it('resolves a back-face id to that face\'s own record', () => {
    expect(DELVER, 'Delver left the bundled card index').toBeDefined();
    const back = getCard(`${DELVER!.id}${BACK_FACE_ID_SUFFIX}`);
    expect(back).toBeDefined();
    expect(back!.name).toBe('Insectile Aberration');
    expect(back!.power).toBe(3);
    expect(back!.toughness).toBe(2);
    expect(back!.typeLine.subtypes).toContain('Insect');
    expect(back!.oracleText).toBe('Flying');
  });

  it('serves the BACK face\'s art, not the front\'s', () => {
    const back = getCard(`${DELVER!.id}${BACK_FACE_ID_SUFFIX}`)!;
    const art = cardImage(back, 'art_crop');
    expect(art).toBeDefined();
    // Scryfall serves DFC faces under /front/ and /back/ paths.
    expect(art).toContain('/back/');
    const front = getCard(DELVER!.id)!;
    expect(cardImage(front, 'art_crop')).toContain('/front/');
  });

  it('returns undefined for a back-face id with no such card', () => {
    expect(getCard(`no-such-card${BACK_FACE_ID_SUFFIX}`)).toBeUndefined();
  });

  it('never offers a back face in the pickable pool', () => {
    for (const card of allAvailableCards()) {
      expect(card.id.endsWith(BACK_FACE_ID_SUFFIX), card.name).toBe(false);
    }
  });
});

/**
 * §3.143 — the SYNTHESIZED display record for a cost with hybrid symbols.
 *
 * `enginePool.ts` builds a display record straight from an engine definition for
 * any card the Scryfall index does not cover. It handed `other` back empty, so a
 * `{1}{B/P}{B/P}` card was shown at `{1}` — a price it cannot be bought for —
 * counted on the curve at 1, and filed as colourless. Nothing in TypeScript can
 * catch that: the two `ManaCost` shapes are different types and the display one
 * was still perfectly well-formed, just wrong.
 *
 * The pip assertion is the render-path half: `manaPips` feeds `<ManaCost>` and
 * must yield the PRINTED symbol, never a stringified component object.
 */
describe('synthesized display records for hybrid costs', () => {
  const DISMEMBER: CardDefinition = {
    id: 'dismember',
    name: 'Dismember',
    types: ['instant'],
    cost: { generic: 1, hybrid: [['B', { life: 2 }], ['B', { life: 2 }]] },
  };
  const TIDEHOLLOW: CardDefinition = {
    id: 'two-brid',
    name: 'Spectral Procession',
    types: ['sorcery'],
    cost: { hybrid: [[{ generic: 2 }, 'W'], [{ generic: 2 }, 'W']] },
  };

  it('keeps a Phyrexian symbol, its mana value and its colour', () => {
    const record = displayRecordFor(DISMEMBER);
    expect(record.manaCost.generic).toBe(1);
    expect(record.manaCost.other).toEqual(['B/P', 'B/P']);
    expect(record.cmc, 'CR 202.3b/c — {B/P} counts as the coloured symbol').toBe(3);
    expect(record.colors).toEqual(['B']);
  });

  it('keeps a monocolour hybrid symbol the same way', () => {
    const record = displayRecordFor(TIDEHOLLOW);
    expect(record.manaCost.other).toEqual(['2/W', '2/W']);
    expect(record.cmc, 'CR 202.3b — the greatest component, twice').toBe(4);
    expect(record.colors).toEqual(['W']);
  });

  it('renders as the printed pips, never as a stringified component', () => {
    expect(manaPips(displayRecordFor(DISMEMBER).manaCost)).toEqual(['1', 'B/P', 'B/P']);
    expect(manaPips(displayRecordFor(TIDEHOLLOW).manaCost)).toEqual(['2/W', '2/W']);
  });
});
