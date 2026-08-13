import { describe, expect, it, vi } from 'vitest';
import {
  ProxyPrintsClient,
  parsePrintsResponse,
  printLabel,
} from './prints.js';
import type { FetchLike } from './scryfall.js';

/** A fixture mirroring a Scryfall `/cards/search?unique=prints` response. */
const SEARCH_FIXTURE = {
  data: [
    {
      id: 'id-mh2',
      name: 'Lightning Bolt',
      set: 'mh2',
      set_name: 'Modern Horizons 2',
      collector_number: '123',
      artist: 'Christopher Rush',
      image_uris: { png: 'mh2.png', normal: 'mh2-n.jpg', small: 'mh2-s.jpg' },
    },
    {
      id: 'id-lea',
      name: 'Lightning Bolt',
      set: 'lea',
      set_name: 'Limited Edition Alpha',
      collector_number: '161',
      image_uris: { large: 'lea-l.jpg' },
    },
    // Duplicate id — must be de-duplicated.
    {
      id: 'id-mh2',
      name: 'Lightning Bolt',
      set: 'mh2',
      image_uris: { png: 'mh2.png' },
    },
    // No usable image — must be skipped.
    { id: 'id-noimg', name: 'Lightning Bolt', set: 'xxx' },
  ],
  has_more: false,
};

describe('parsePrintsResponse', () => {
  it('parses, dedupes by id, and skips imageless printings', () => {
    const options = parsePrintsResponse(SEARCH_FIXTURE);
    expect(options).toHaveLength(2);

    const mh2 = options[0]!;
    expect(mh2).toMatchObject({
      scryfallId: 'id-mh2',
      set: 'MH2',
      setName: 'Modern Horizons 2',
      collectorNumber: '123',
      imageUrl: 'mh2.png',
      artist: 'Christopher Rush',
    });
    // Thumbnail prefers the small image over the print image.
    expect(mh2.thumbnailUrl).toBe('mh2-s.jpg');

    // The image-less printing is absent.
    expect(options.some((o) => o.scryfallId === 'id-noimg')).toBe(false);
  });

  it('returns an empty list for a malformed payload', () => {
    expect(parsePrintsResponse(null)).toEqual([]);
    expect(parsePrintsResponse({})).toEqual([]);
    expect(parsePrintsResponse({ data: 'nope' })).toEqual([]);
  });

  it('builds a readable label', () => {
    const [mh2] = parsePrintsResponse(SEARCH_FIXTURE);
    expect(printLabel(mh2!)).toBe('MH2 · #123 · Christopher Rush');
  });
});

describe('ProxyPrintsClient.fetchPrints', () => {
  it('requests the exact-name unique-prints search and parses it', async () => {
    let calledUrl = '';
    const fetchImpl: FetchLike = vi.fn(async (url) => {
      calledUrl = url;
      return { ok: true, status: 200, json: async () => SEARCH_FIXTURE };
    });
    const client = new ProxyPrintsClient(fetchImpl, { minIntervalMs: 0 });
    const options = await client.fetchPrints('Lightning Bolt');

    expect(options).toHaveLength(2);
    expect(calledUrl).toContain('/cards/search');
    expect(calledUrl).toContain('unique=prints');
    // Exact-name token `!"Lightning Bolt"` is URL-encoded into the query.
    expect(decodeURIComponent(calledUrl)).toContain('!"Lightning Bolt"');
  });

  it('returns [] on a non-ok response (e.g. name with no prints → 404)', async () => {
    const fetchImpl: FetchLike = vi.fn(async () => ({
      ok: false,
      status: 404,
      json: async () => ({}),
    }));
    const client = new ProxyPrintsClient(fetchImpl, { minIntervalMs: 0 });
    expect(await client.fetchPrints('Notacard')).toEqual([]);
  });

  it('never throws — a network failure yields []', async () => {
    const fetchImpl: FetchLike = vi.fn(async () => {
      throw new Error('network down');
    });
    const client = new ProxyPrintsClient(fetchImpl, { minIntervalMs: 0 });
    expect(await client.fetchPrints('Lightning Bolt')).toEqual([]);
  });
});
