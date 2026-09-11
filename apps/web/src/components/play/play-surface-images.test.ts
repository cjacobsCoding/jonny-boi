/**
 * PLAY-SURFACE IMAGES ARE NEVER LAZY, AND THE BOARD SAYS WHAT IT KNOWS (§3.119).
 *
 * Bug report 20260901_202314 — "Some cards were blank. They showed up when I
 * hovered over them." Every image on the hand and the battlefield carried
 * `loading="lazy"`, and Chrome deferred them inside the play surface's
 * scrolling, transformed, `:has()`-sized box until a hover repainted the slot.
 * Nothing on a play surface is ever off-screen, so there is nothing to defer.
 * Pinned STRUCTURALLY, like §3.54's draggable rule: render the real components
 * and require `loading="eager"` on every <img> they emit — a lazy image added
 * to any of them fails here.
 *
 * Bug reports 20260901_204957 (a pumped 1/2 read as a 1/2) and 20260901_204854
 * ("way more clear who is attacking"): the tile prints its current truth and
 * wears its combat role. Pinned on the literal Swiftspear.
 *
 * ⚠️ §3.143 / UX-17 RETIRED THE BARE DELTA BADGE, and these tests were rewritten
 * in the same edit rather than left knowingly red. The old assertions pinned
 * `perm__pt-delta` — a "+1/+1" that could state the NUMBER but never the SOURCE,
 * because `indexContinuous` aggregates a sum and throws the attribution away.
 * The tile now renders lane P's `CardFace` over core's own
 * `explainCharacteristics`, which prints the effective P/T in place with a hover
 * breakdown naming every contributing card. Keeping both would be two answers to
 * one question on one card (rule 12), so what is pinned here is the RETIREMENT:
 * putting the badge back turns these red. The positive half — that the turn, the
 * face and the anchors are right — lives in `tile-transform.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { CARD_POOL } from '@jonny-boi/cards';
import { PlayCard } from './PlayCard.js';
import { BoardPermanentTile, COMBAT_BADGES } from './BoardPermanentTile.js';
import type { BoardPermanent } from '../../lib/play/view-model.js';

const FOREST = CARD_POOL.find((c) => c.name === 'Forest')!;
const SWIFTSPEAR = CARD_POOL.find((c) => c.name === 'Monastery Swiftspear')!;

function imgsOf(html: string): string[] {
  return html.match(/<img\b[^>]*>/g) ?? [];
}

function permanent(overrides: Partial<BoardPermanent> = {}): BoardPermanent {
  return {
    instanceId: 7,
    cardId: SWIFTSPEAR.id,
    name: SWIFTSPEAR.name,
    controller: 'B',
    isCreature: true,
    isLand: false,
    isPlaneswalker: false,
    loyalty: 0,
    isBattle: false,
    defense: 0,
    protector: null,
    tapped: false,
    summoningSick: false,
    power: 1,
    toughness: 2,
    printedPower: 1,
    printedToughness: 2,
    ptDelta: null,
    ptFromEffects: null,
    counters: [],
    damageMarked: 0,
    keywords: { haste: true },
    producesIfTapped: [],
    attacking: false,
    blocking: null,
    ...overrides,
  };
}

describe('play-surface images load eagerly', () => {
  it('the full-face hand card', () => {
    const html = renderToStaticMarkup(
      createElement(PlayCard, { cardId: FOREST.id, name: FOREST.name, face: 'full', onClick: () => {} }),
    );
    const imgs = imgsOf(html);
    expect(imgs.length).toBeGreaterThan(0);
    for (const img of imgs) {
      expect(img).toContain('loading="eager"');
      expect(img).not.toContain('loading="lazy"');
    }
  });

  it('the chip face', () => {
    const html = renderToStaticMarkup(createElement(PlayCard, { cardId: FOREST.id, name: FOREST.name }));
    for (const img of imgsOf(html)) expect(img).toContain('loading="eager"');
  });

  it('the battlefield tile, with and without a prisoner', () => {
    const plain = renderToStaticMarkup(createElement(BoardPermanentTile, { perm: permanent() }));
    expect(imgsOf(plain).length).toBeGreaterThan(0);
    for (const img of imgsOf(plain)) expect(img).toContain('loading="eager"');
    const jailed = renderToStaticMarkup(
      createElement(BoardPermanentTile, {
        perm: permanent(),
        jailed: [{ instanceId: 9, cardId: FOREST.id, name: FOREST.name }],
      }),
    );
    for (const img of imgsOf(jailed)) expect(img).toContain('loading="eager"');
  });
});

describe('the tile says what the view-model knows', () => {
  it('the reported Swiftspear: the CARD FACE states the current P/T, not a badge beside it', () => {
    const html = renderToStaticMarkup(
      createElement(BoardPermanentTile, {
        perm: permanent({ power: 2, toughness: 3, ptDelta: { power: 1, toughness: 1 } }),
      }),
    );
    // The number the combat used is on screen (this fixture carries no
    // explanation, so it is the footer's honest fallback — see the tile's
    // comment, and `tile-transform.test.ts` for the with-explanation case).
    expect(html).toContain('2/3');
    // …and the unattributed badge that used to sit beside it is GONE.
    expect(html).not.toContain('perm__pt-delta');
  });

  it('an unpumped creature carries no delta badge either — the retirement is total', () => {
    const html = renderToStaticMarkup(createElement(BoardPermanentTile, { perm: permanent() }));
    expect(html).not.toContain('perm__pt-delta');
    expect(html).not.toContain('perm__mark--effect');
  });

  it('an attacker wears the attacking band and class; a blocker the blocking one', () => {
    const attacking = renderToStaticMarkup(createElement(BoardPermanentTile, { perm: permanent({ attacking: true }) }));
    expect(attacking).toContain('perm--attacking');
    expect(attacking).toContain(COMBAT_BADGES.attacking);
    const blocking = renderToStaticMarkup(createElement(BoardPermanentTile, { perm: permanent({ blocking: 3 }) }));
    expect(blocking).toContain('perm--blocking');
    expect(blocking).toContain(COMBAT_BADGES.blocking);
    const idle = renderToStaticMarkup(createElement(BoardPermanentTile, { perm: permanent() }));
    expect(idle).not.toContain('perm--attacking');
    expect(idle).not.toContain('perm--blocking');
  });

  it('a legal spell target pulses', () => {
    const html = renderToStaticMarkup(createElement(BoardPermanentTile, { perm: permanent(), targetable: true }));
    expect(html).toContain('perm--targetable');
  });
});
