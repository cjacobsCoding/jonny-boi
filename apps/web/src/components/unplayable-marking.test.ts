/**
 * THE WHOLE OF SCRYFALL IS BROWSABLE, SO THE UNPLAYABLE ONES ARE MARKED (§3.167)
 * — static renders of the real components, because every one of these is a
 * "wire the consumer" defect waiting to happen: the tier can load perfectly
 * while the grid shows 32,000 identical tiles.
 *
 *  - a tile the predicate rejects wears "Not playable yet"; one it admits does not;
 *  - the toolbar shows the All / Playable toggle and the honest count only when
 *    it is told how many are playable;
 *  - the detail view says what a corpus card needs, from the same funnel the
 *    deck builder's ⚠ reads.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { CARD_POOL } from '@jonny-boi/cards';
import { CardTile } from './CardTile.js';
import { CardGrid } from './CardGrid.js';
import { CardToolbar, PLAYABLE_FILTER_OPTIONS } from './CardToolbar.js';
import { CardDetail } from './CardDetail.js';
import { EMPTY_QUERY } from '../lib/filter.js';
import { allCards, getCard } from '../lib/cards.js';
import { loadCorpus, resetCorpusForTests } from '../lib/cards/corpus.js';

const POOLED = allCards.find((c) => CARD_POOL.some((p) => p.id === c.id)) ?? allCards[0]!;

const MORPH_CARD = {
  id: 'a1b2c3d4-0000-4000-8000-0000000000bb',
  name: 'Test Baloth',
  mana_cost: '{5}{G}{G}',
  cmc: 7,
  type_line: 'Creature — Beast',
  oracle_text: 'Morph {G}{G}{G}',
  power: '7',
  toughness: '6',
  colors: ['G'],
  color_identity: ['G'],
  keywords: ['Morph'],
  layout: 'normal',
  set: 'tst',
  collector_number: '2',
  rarity: 'common',
};

const fetchIndex = (() =>
  Promise.resolve(
    new Response(
      JSON.stringify({ generatedAt: '', attribution: '', corpusSize: 1, cards: [MORPH_CARD] }),
      { status: 200 },
    ),
  )) as typeof fetch;

afterEach(() => resetCorpusForTests());

describe('the tile', () => {
  it('wears the badge exactly when told it is not playable', () => {
    const marked = renderToStaticMarkup(
      createElement(CardTile, { card: POOLED, onSelect: () => {}, playable: false }),
    );
    expect(marked).toContain('Not playable yet');
    expect(marked).toContain('card-tile--unplayable');
    const plain = renderToStaticMarkup(
      createElement(CardTile, { card: POOLED, onSelect: () => {} }),
    );
    expect(plain).not.toContain('Not playable yet');
    expect(plain).not.toContain('card-tile--unplayable');
  });

  it('the grid asks the predicate per card', () => {
    const cards = allCards.slice(0, 3);
    const html = renderToStaticMarkup(
      createElement(CardGrid, {
        cards,
        onSelect: () => {},
        isPlayable: (c) => c.id !== cards[1]!.id,
      }),
    );
    expect(html.match(/Not playable yet/g)?.length).toBe(1);
  });
});

describe('the toolbar', () => {
  it('shows the All / Playable toggle and "· N playable" only when given a playable count', () => {
    const withCount = renderToStaticMarkup(
      createElement(CardToolbar, {
        query: EMPTY_QUERY,
        onChange: () => {},
        resultCount: 1204,
        playableCount: 310,
      }),
    );
    for (const option of PLAYABLE_FILTER_OPTIONS) expect(withCount).toContain(option.label);
    expect(withCount).toContain('1,204 cards');
    expect(withCount).toContain('310 playable');

    const without = renderToStaticMarkup(
      createElement(CardToolbar, { query: EMPTY_QUERY, onChange: () => {}, resultCount: 12 }),
    );
    expect(without).not.toContain('Playable');
    expect(without).not.toContain('playable');
    expect(without).toContain('12 cards');
  });
});

describe('the detail view', () => {
  it('says what a corpus card needs, and says nothing for a card the engine plays', async () => {
    await loadCorpus(fetchIndex);
    const card = getCard(MORPH_CARD.id)!;
    const html = renderToStaticMarkup(createElement(CardDetail, { card, onClose: () => {} }));
    expect(html).toContain('Not playable yet.');
    expect(html).toContain('cannot be played or tested until the engine learns');
    const pooled = renderToStaticMarkup(
      createElement(CardDetail, { card: POOLED, onClose: () => {} }),
    );
    expect(pooled).not.toContain('Not playable yet.');
  });
});
