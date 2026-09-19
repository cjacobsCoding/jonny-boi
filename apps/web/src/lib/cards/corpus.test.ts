/**
 * THE CORPUS TIER (§3.167) — fetched once, expanded through the one normalizer,
 * honest about failure, and merged into every lookup the app has.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { CARD_POOL } from '@jonny-boi/cards';
import {
  CORPUS_INDEX_URL,
  corpusCard,
  corpusCardByName,
  corpusCards,
  corpusState,
  corpusVersion,
  expandCorpus,
  loadCorpus,
  resetCorpusForTests,
  retryCorpus,
  subscribeToCorpus,
} from './corpus.js';
import { allAvailableCards, cardImage, getCard, getCardByName } from '../cards.js';
import { isPlayableCard } from './playable.js';
import { whyUnplayable } from '../decklist/deckHealth.js';

/** A slim record shaped exactly as data-tools writes it — a card the pool does not hold. */
const MORPH_CARD = {
  id: 'a1b2c3d4-0000-4000-8000-0000000000aa',
  name: 'Test Mawcor',
  mana_cost: '{3}{U}{U}',
  cmc: 5,
  type_line: 'Creature — Beast',
  oracle_text: 'Flying\n{T}: Test Mawcor deals 1 damage to any target.\nMorph {U}{U}',
  power: '2',
  toughness: '2',
  colors: ['U'],
  color_identity: ['U'],
  keywords: ['Flying', 'Morph'],
  layout: 'normal',
  set: 'tst',
  collector_number: '1',
  rarity: 'uncommon',
};

const INDEX = {
  generatedAt: '2026-09-19T00:00:00.000Z',
  attribution: 'test',
  corpusSize: 2,
  cards: [MORPH_CARD],
};

function fetchOk(body: unknown): typeof fetch {
  return (() =>
    Promise.resolve(new Response(JSON.stringify(body), { status: 200 }))) as typeof fetch;
}

afterEach(() => resetCorpusForTests());

describe('the corpus asset', () => {
  it('is a content-hashed asset next to the app, not a JSON import bundled into the shell', () => {
    expect(CORPUS_INDEX_URL).toMatch(/corpus-index/);
    expect(CORPUS_INDEX_URL).toMatch(/\.json$/);
  });
});

describe('loadCorpus', () => {
  it('fetches, expands with normalizeCard, and joins every lookup', async () => {
    const ticks: number[] = [];
    const unsubscribe = subscribeToCorpus(() => ticks.push(corpusVersion()));
    expect(corpusState().state).toBe('idle');
    expect(getCard(MORPH_CARD.id)).toBeUndefined();

    await loadCorpus(fetchOk(INDEX));

    expect(corpusState()).toEqual({ state: 'ready', count: 1, corpusSize: 2 });
    expect(ticks.length).toBeGreaterThanOrEqual(2); // loading, ready
    const card = corpusCard(MORPH_CARD.id)!;
    expect(card.name).toBe('Test Mawcor');
    expect(card.manaCost).toMatchObject({ generic: 3, U: 2 });
    expect(card.typeLine.types).toEqual(['Creature']);
    expect(corpusCards()).toHaveLength(1);
    expect(corpusCardByName('test mawcor')).toBe(card);

    // The app-wide lookups see it…
    expect(getCard(MORPH_CARD.id)).toBe(card);
    expect(getCardByName('Test Mawcor')).toBe(card);
    expect(allAvailableCards().some((c) => c.id === MORPH_CARD.id)).toBe(true);
    // …its art derives from the printing id…
    expect(cardImage(card, 'normal')).toBe(
      `https://cards.scryfall.io/normal/front/a/1/${MORPH_CARD.id}.jpg`,
    );
    // …and it is honestly NOT playable, with the reason from the compiler.
    expect(isPlayableCard(card)).toBe(false);
    const why = whyUnplayable(MORPH_CARD.id);
    expect(why).toBeDefined();
    expect(why!.length).toBeGreaterThan(0);
    unsubscribe();
  });

  it('is idempotent while loading, and does not repeat a finished load', async () => {
    let calls = 0;
    const counting = (() => {
      calls += 1;
      return Promise.resolve(new Response(JSON.stringify(INDEX), { status: 200 }));
    }) as typeof fetch;
    await Promise.all([loadCorpus(counting), loadCorpus(counting)]);
    await loadCorpus(counting);
    expect(calls).toBe(1);
  });

  it('reports a failure by name and can be retried', async () => {
    const failing = (() => Promise.reject(new Error('offline'))) as typeof fetch;
    await loadCorpus(failing);
    expect(corpusState()).toEqual({ state: 'failed', error: 'offline' });
    expect(corpusCards()).toEqual([]);
    // A failed load is not silently repeated…
    await loadCorpus(failing);
    // …but a retry is.
    await retryCorpus(fetchOk(INDEX));
    expect(corpusState().state).toBe('ready');
  });

  it('refuses a body that is not an index, and a non-2xx response', async () => {
    await loadCorpus(fetchOk({ nope: true }));
    expect(corpusState()).toMatchObject({ state: 'failed' });
    resetCorpusForTests();
    await loadCorpus((() => Promise.resolve(new Response('', { status: 404 }))) as typeof fetch);
    expect(corpusState()).toMatchObject({ state: 'failed', error: expect.stringContaining('404') });
  });
});

describe('expandCorpus', () => {
  it('yields between chunks and keeps order', async () => {
    const many = {
      cards: Array.from({ length: 5 }, (_, i) => ({
        ...MORPH_CARD,
        id: `id-${i}`,
        name: `Card ${i}`,
      })),
    };
    const out = await expandCorpus(many, 2);
    expect(out.map((c) => c.name)).toEqual(['Card 0', 'Card 1', 'Card 2', 'Card 3', 'Card 4']);
  });
});

describe('the two tiers stay disjoint', () => {
  it('a corpus card that shares a name with a pool card never shadows it', async () => {
    const pooled = CARD_POOL[0]!;
    await loadCorpus(
      fetchOk({ ...INDEX, cards: [{ ...MORPH_CARD, id: 'dupe-id', name: pooled.name }] }),
    );
    const byName = getCardByName(pooled.name)!;
    expect(byName.id).not.toBe('dupe-id');
    expect(allAvailableCards().filter((c) => c.name === pooled.name)).toHaveLength(1);
  });
});
