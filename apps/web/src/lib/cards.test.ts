/**
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
import { allAvailableCards, allCards, BACK_FACE_ID_SUFFIX, cardImage, getCard } from './cards.js';

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
