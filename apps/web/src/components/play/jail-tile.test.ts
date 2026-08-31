/**
 * §3.57 — the jailed-under-jailer TILE renders structurally: prisoners peek
 * from behind the jailer, are zoomable buttons, and (§3.54's standing rule) no
 * image near a gesture surface is natively draggable. Pinned with a static
 * render exactly like `no-native-drag.test.ts`, because synthetic-event tests
 * cannot catch a native drag.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { CARD_POOL } from '@jonny-boi/cards';
import { BoardPermanentTile } from './BoardPermanentTile.js';
import type { BoardPermanent } from '../../lib/play/view-model.js';
import type { JailedCardView } from '../../lib/play/jail-view.js';

const JAILER_CARD = CARD_POOL.find((c) => c.name === 'Banisher Priest') ?? CARD_POOL[0]!;
const PRISONER_CARD = CARD_POOL.find((c) => c.name === 'Grizzly Bears') ?? CARD_POOL[1]!;

const JAILER: BoardPermanent = {
  instanceId: 40,
  cardId: JAILER_CARD.id,
  name: JAILER_CARD.name,
  controller: 'A',
  isCreature: true,
  isLand: false,
  isPlaneswalker: false,
  loyalty: 0,
  isBattle: false,
  defense: 0,
  protector: null,
  tapped: false,
  summoningSick: false,
  power: 2,
  toughness: 2,
  damageMarked: 0,
  keywords: {},
  producesIfTapped: [],
};

const PRISONER: JailedCardView = { instanceId: 11, cardId: PRISONER_CARD.id, name: PRISONER_CARD.name };

describe('the jailer tile with a tucked prisoner', () => {
  const html = renderToStaticMarkup(
    createElement(BoardPermanentTile, {
      perm: JAILER,
      jailed: [PRISONER],
      onInspectJailed: () => {},
    }),
  );

  it('wraps the tile in a stack with one peeking prisoner button', () => {
    expect(html).toContain('perm-stack');
    expect(html).toContain('perm-stack__jailed');
    // The prisoner explains itself: name + the until-it-leaves rule.
    expect(html).toContain(`exiled until ${JAILER_CARD.name} leaves the battlefield`);
  });

  it('marks the tile as a measurable anchor (data-perm-id)', () => {
    expect(html).toContain('data-perm-id="40"');
  });

  it('no image in the stack is natively draggable (§3.54)', () => {
    const imgs = html.match(/<img\b[^>]*>/g) ?? [];
    for (const img of imgs) expect(img).toContain('draggable="false"');
  });

  it('without prisoners the wrapper is absent — the old DOM exactly', () => {
    const bare = renderToStaticMarkup(createElement(BoardPermanentTile, { perm: JAILER }));
    expect(bare).not.toContain('perm-stack');
    expect(bare).toContain('data-perm-id="40"');
  });
});
