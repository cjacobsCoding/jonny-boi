import { describe, expect, it, vi } from 'vitest';
import {
  ProxyScryfallClient,
  bestPrintImage,
  extractImages,
  nameAliases,
  toCountedProxies,
  type FetchLike,
  type RawScryfallCard,
} from './scryfall.js';
import type { ParsedCard } from './parseDecklist.js';

describe('bestPrintImage', () => {
  it('prefers png over large over normal over small', () => {
    expect(
      bestPrintImage({ small: 's', normal: 'n', large: 'l', png: 'p' }),
    ).toBe('p');
    expect(bestPrintImage({ small: 's', normal: 'n', large: 'l' })).toBe('l');
    expect(bestPrintImage({ small: 's', normal: 'n' })).toBe('n');
    expect(bestPrintImage({ small: 's' })).toBe('s');
    expect(bestPrintImage(undefined)).toBeUndefined();
  });
});

describe('extractImages', () => {
  it('reads top-level image_uris for a single-faced card', () => {
    const card: RawScryfallCard = { name: 'Bolt', image_uris: { png: 'front.png' } };
    expect(extractImages(card)).toEqual({ front: 'front.png' });
  });

  it('reads per-face images for a double-faced card', () => {
    const card: RawScryfallCard = {
      name: 'Delver of Secrets',
      card_faces: [
        { name: 'Delver of Secrets', image_uris: { png: 'front.png' } },
        { name: 'Insectile Aberration', image_uris: { large: 'back.jpg' } },
      ],
    };
    expect(extractImages(card)).toEqual({ front: 'front.png', back: 'back.jpg' });
  });
});

describe('nameAliases', () => {
  it('gives a single-faced card exactly one alias', () => {
    expect(nameAliases('Lightning Bolt')).toEqual(['lightning bolt']);
  });

  it('gives a double-faced card its combined name and each face', () => {
    expect(nameAliases('Delver of Secrets // Insectile Aberration')).toEqual([
      'delver of secrets // insectile aberration',
      'delver of secrets',
      'insectile aberration',
    ]);
  });

  it('tolerates missing spaces around the face separator', () => {
    expect(nameAliases('Delver of Secrets//Insectile Aberration')).toContain(
      'delver of secrets',
    );
  });
});

/** Build a fake fetch that returns a canned collection response and records calls. */
function fakeFetch(
  response: { data?: RawScryfallCard[]; not_found?: Array<{ name?: string }> },
): { fetchImpl: FetchLike; bodies: unknown[] } {
  const bodies: unknown[] = [];
  const fetchImpl: FetchLike = vi.fn(async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return { ok: true, status: 200, json: async () => response };
  });
  return { fetchImpl, bodies };
}

describe('ProxyScryfallClient.resolve', () => {
  it('resolves names to their best print image', async () => {
    const { fetchImpl } = fakeFetch({
      data: [{ name: 'Lightning Bolt', image_uris: { png: 'bolt.png', normal: 'bolt-n.jpg' } }],
    });
    const client = new ProxyScryfallClient(fetchImpl, { minIntervalMs: 0 });
    const result = await client.resolve([{ name: 'Lightning Bolt', qty: 4 }]);
    expect(result.resolved).toEqual([{ name: 'Lightning Bolt', imageUrl: 'bolt.png' }]);
    expect(result.unresolved).toHaveLength(0);
  });

  it('batches into chunks of at most 75 and requests every unique name', async () => {
    const names: ParsedCard[] = Array.from({ length: 160 }, (_, i) => ({
      name: `Card ${i}`,
      qty: 1,
    }));
    const { fetchImpl, bodies } = fakeFetch({ data: [] });
    const client = new ProxyScryfallClient(fetchImpl, { minIntervalMs: 0, batchSize: 75 });
    await client.resolve(names);

    // 160 unique names / 75 → 3 batches of 75, 75, 10.
    expect(bodies).toHaveLength(3);
    const sizes = bodies.map((b) => (b as { identifiers: unknown[] }).identifiers.length);
    expect(sizes).toEqual([75, 75, 10]);

    // Every requested name appears exactly once across the batches.
    const requested = bodies.flatMap((b) =>
      (b as { identifiers: Array<{ name: string }> }).identifiers.map((id) => id.name),
    );
    expect(new Set(requested).size).toBe(160);
  });

  it('deduplicates repeated names into a single identifier', async () => {
    const { fetchImpl, bodies } = fakeFetch({ data: [] });
    const client = new ProxyScryfallClient(fetchImpl, { minIntervalMs: 0 });
    await client.resolve([
      { name: 'Island', qty: 9 },
      { name: 'island', qty: 4 },
    ]);
    const ids = (bodies[0] as { identifiers: unknown[] }).identifiers;
    expect(ids).toHaveLength(1);
  });

  it('records names Scryfall could not find as unresolved', async () => {
    const { fetchImpl } = fakeFetch({
      data: [{ name: 'Sol Ring', image_uris: { png: 'sol.png' } }],
      not_found: [{ name: 'Notacard' }],
    });
    const client = new ProxyScryfallClient(fetchImpl, { minIntervalMs: 0 });
    const result = await client.resolve([
      { name: 'Sol Ring', qty: 1 },
      { name: 'Notacard', qty: 1 },
    ]);
    expect(result.resolved.map((r) => r.name)).toEqual(['Sol Ring']);
    expect(result.unresolved).toContain('Notacard');
  });

  it('never throws on a failed batch — records its names and continues', async () => {
    const fetchImpl: FetchLike = vi.fn(async () => {
      throw new Error('network down');
    });
    const client = new ProxyScryfallClient(fetchImpl, { minIntervalMs: 0 });
    const result = await client.resolve([{ name: 'Bolt', qty: 1 }]);
    expect(result.resolved).toHaveLength(0);
    expect(result.unresolved).toEqual(['Bolt']);
  });

  it('captures a double-faced back image on the resolved card', async () => {
    const { fetchImpl } = fakeFetch({
      data: [
        {
          name: 'Delver of Secrets',
          card_faces: [
            { name: 'Delver of Secrets', image_uris: { png: 'front.png' } },
            { name: 'Insectile Aberration', image_uris: { png: 'back.png' } },
          ],
        },
      ],
    });
    const client = new ProxyScryfallClient(fetchImpl, { minIntervalMs: 0 });
    const result = await client.resolve([{ name: 'Delver of Secrets', qty: 1 }]);
    expect(result.resolved[0]).toMatchObject({
      name: 'Delver of Secrets',
      imageUrl: 'front.png',
      backImageUrl: 'back.png',
    });
  });

  // Regression: Scryfall echoes a DFC's COMBINED name ("Front // Back") even
  // when asked for the front face, which is how every decklist writes it.
  // Matching on the echoed name alone reported the card as "couldn't find".
  it('resolves a double-faced card requested by its front-face name', async () => {
    const { fetchImpl } = fakeFetch({
      data: [
        {
          name: 'Delver of Secrets // Insectile Aberration',
          card_faces: [
            { name: 'Delver of Secrets', image_uris: { png: 'front.png' } },
            { name: 'Insectile Aberration', image_uris: { png: 'back.png' } },
          ],
        },
      ],
    });
    const client = new ProxyScryfallClient(fetchImpl, { minIntervalMs: 0 });
    const result = await client.resolve([{ name: 'Delver of Secrets', qty: 4 }]);
    expect(result.unresolved).toEqual([]);
    expect(result.resolved).toHaveLength(1);
    expect(result.resolved[0]).toMatchObject({ imageUrl: 'front.png', backImageUrl: 'back.png' });
  });

  it('counts a card asked for by both its face and combined name only once', async () => {
    const { fetchImpl } = fakeFetch({
      data: [
        {
          name: 'Delver of Secrets // Insectile Aberration',
          card_faces: [
            { name: 'Delver of Secrets', image_uris: { png: 'front.png' } },
            { name: 'Insectile Aberration', image_uris: { png: 'back.png' } },
          ],
        },
      ],
    });
    const client = new ProxyScryfallClient(fetchImpl, { minIntervalMs: 0 });
    const result = await client.resolve([
      { name: 'Delver of Secrets', qty: 2 },
      { name: 'Delver of Secrets // Insectile Aberration', qty: 2 },
    ]);
    expect(result.resolved).toHaveLength(1);
    expect(result.unresolved).toEqual([]);
  });
});

describe('toCountedProxies', () => {
  const parsed: ParsedCard[] = [
    { name: 'Lightning Bolt', qty: 4 },
    { name: 'Delver of Secrets', qty: 2 },
  ];
  const resolved = [
    { name: 'Lightning Bolt', imageUrl: 'bolt.png' },
    { name: 'Delver of Secrets', imageUrl: 'front.png', backImageUrl: 'back.png' },
  ];

  it('joins quantities with resolved images', () => {
    const counted = toCountedProxies(parsed, resolved, false);
    expect(counted).toEqual([
      { name: 'Lightning Bolt', imageUrl: 'bolt.png', qty: 4 },
      { name: 'Delver of Secrets', imageUrl: 'front.png', qty: 2 },
    ]);
  });

  it('adds DFC backs as extra proxies when requested', () => {
    const counted = toCountedProxies(parsed, resolved, true);
    const back = counted.find((c) => c.faceLabel === 'back');
    expect(back).toMatchObject({ imageUrl: 'back.png', qty: 2, faceLabel: 'back' });
  });

  it('skips cards that did not resolve', () => {
    const counted = toCountedProxies([{ name: 'Ghost', qty: 1 }], resolved, false);
    expect(counted).toHaveLength(0);
  });

  // Regression: the resolved card carries Scryfall's combined DFC name, while
  // the decklist line carries only the front face — they must still join.
  it('joins a front-face decklist line to a combined-name resolved card', () => {
    const counted = toCountedProxies(
      [{ name: 'Delver of Secrets', qty: 3 }],
      [
        {
          name: 'Delver of Secrets // Insectile Aberration',
          imageUrl: 'front.png',
          backImageUrl: 'back.png',
        },
      ],
      true,
    );
    expect(counted.map((c) => ({ url: c.imageUrl, qty: c.qty }))).toEqual([
      { url: 'front.png', qty: 3 },
      { url: 'back.png', qty: 3 },
    ]);
  });
});
