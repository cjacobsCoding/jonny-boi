/**
 * THE CORPUS INDEX (§3.167) — the tier the app fetches on demand: the corpus
 * minus the pool, slimmed to what `normalizeCard` reads, disjoint from the pool
 * by the same key the pool resolved on.
 */
import { describe, expect, it } from 'vitest';
import {
  buildCorpusIndex,
  serializeCorpusIndex,
  slimCard,
  SLIM_CARD_KEYS,
  SLIM_FACE_KEYS,
  type CorpusIndex,
} from './corpus-index.js';
import { normalizeCard } from './normalize.js';
import { frontFaceName } from './verify.js';
import type { RawScryfallCard } from './types.js';

const IMAGE_URIS = { small: 'https://x/s.jpg', normal: 'https://x/n.jpg' };

const BOLT: RawScryfallCard & { set_name?: string } = {
  id: 'id-bolt',
  name: 'Lightning Bolt',
  mana_cost: '{R}',
  cmc: 1,
  type_line: 'Instant',
  oracle_text: 'Lightning Bolt deals 3 damage to any target.',
  colors: ['R'],
  color_identity: ['R'],
  keywords: [],
  layout: 'normal',
  set: 'lea',
  set_name: 'Limited Edition Alpha',
  collector_number: '161',
  rarity: 'common',
  image_uris: IMAGE_URIS,
};

const DELVER: RawScryfallCard = {
  id: 'id-delver',
  name: 'Delver of Secrets // Insectile Aberration',
  cmc: 1,
  layout: 'transform',
  set: 'isd',
  color_identity: ['U'],
  card_faces: [
    {
      name: 'Delver of Secrets',
      mana_cost: '{U}',
      type_line: 'Creature — Human Wizard',
      oracle_text: 'At the beginning of your upkeep, look at the top card of your library.',
      power: '1',
      toughness: '1',
      colors: ['U'],
      image_uris: IMAGE_URIS,
    },
    {
      name: 'Insectile Aberration',
      type_line: 'Creature — Human Insect',
      oracle_text: 'Flying',
      power: '3',
      toughness: '2',
      colors: ['U'],
      image_uris: IMAGE_URIS,
    },
  ],
};

describe('slimCard', () => {
  it('keeps exactly the closed key lists — no image URLs, no set name, no empty arrays', () => {
    const slim = slimCard(BOLT);
    expect(Object.keys(slim).every((k) => (SLIM_CARD_KEYS as readonly string[]).includes(k))).toBe(
      true,
    );
    expect(slim).not.toHaveProperty('image_uris');
    expect(slim).not.toHaveProperty('set_name');
    expect(slim).not.toHaveProperty('keywords'); // empty → dropped
    expect(slim.oracle_text).toBe(BOLT.oracle_text);

    const faces = slimCard(DELVER).card_faces!;
    expect(faces).toHaveLength(2);
    for (const face of faces) {
      expect(
        Object.keys(face).every((k) => (SLIM_FACE_KEYS as readonly string[]).includes(k)),
      ).toBe(true);
      expect(face).not.toHaveProperty('image_uris');
    }
  });

  it('a slim record normalizes to the same card as the raw one, image URLs aside', () => {
    for (const raw of [BOLT, DELVER]) {
      const full = normalizeCard(raw);
      const fromSlim = normalizeCard(slimCard(raw));
      const strip = (c: ReturnType<typeof normalizeCard>) => ({
        ...c,
        imageUris: {},
        faces: c.faces.map((f) => ({ ...f, imageUris: {} })),
      });
      expect(strip(fromSlim)).toEqual(strip(full));
    }
  });
});

describe('buildCorpusIndex', () => {
  const corpus = [BOLT, DELVER, { ...BOLT, id: 'id-bolt-reprint', set: 'm10' }, { nonsense: true }];

  it('is the corpus minus the pool, by front-face name, first printing wins, sorted by name', () => {
    const index = buildCorpusIndex(
      corpus,
      (key) => key === 'Delver of Secrets',
      frontFaceName,
      'attr',
      () => new Date(0),
    );
    expect(index.corpusSize).toBe(4);
    expect(index.cards.map((c) => c.id)).toEqual(['id-bolt']);
    expect(index.generatedAt).toBe(new Date(0).toISOString());

    const nothingInPool = buildCorpusIndex(corpus, () => false, frontFaceName, 'attr');
    expect(nothingInPool.cards.map((c) => c.name)).toEqual([DELVER.name, BOLT.name]);
  });

  it('serialises one card per line and parses back to the same index', () => {
    const index: CorpusIndex = buildCorpusIndex(
      corpus,
      () => false,
      frontFaceName,
      'attr',
      () => new Date(0),
    );
    const text = serializeCorpusIndex(index);
    expect(text.split('\n').filter((line) => line.startsWith('  {"id"'))).toHaveLength(2);
    expect(JSON.parse(text)).toEqual(index);
  });
});
