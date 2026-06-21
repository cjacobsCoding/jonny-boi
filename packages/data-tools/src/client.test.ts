import { describe, expect, it, vi } from 'vitest';
import { chunk, ScryfallClient, type HttpClient, type HttpResponse } from './client.js';
import { COLLECTION_BATCH_SIZE } from './constants.js';
import type { RawScryfallCard } from './types.js';

/** Build a successful JSON HttpResponse. */
function jsonResponse(body: unknown, status = 200): HttpResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
  };
}

/** A mock client that echoes each requested name back as a found card. */
function recordingClient(): { http: HttpClient; bodies: string[] } {
  const bodies: string[] = [];
  const http: HttpClient = {
    request(_url, options) {
      bodies.push(options?.body ?? '');
      const { identifiers } = JSON.parse(options?.body ?? '{}') as {
        identifiers: Array<{ name: string }>;
      };
      const data: RawScryfallCard[] = identifiers.map((id) => ({ name: id.name, cmc: 1 }));
      return Promise.resolve(jsonResponse({ data, not_found: [] }));
    },
  };
  return { http, bodies };
}

describe('chunk', () => {
  it('splits into chunks no larger than size', () => {
    const out = chunk([1, 2, 3, 4, 5], 2);
    expect(out).toEqual([[1, 2], [3, 4], [5]]);
  });

  it('throws on non-positive size', () => {
    expect(() => chunk([1], 0)).toThrow();
  });
});

describe('ScryfallClient.fetchCardsByNames — batching', () => {
  it('requests every name and never exceeds 75 ids per request', async () => {
    const { http, bodies } = recordingClient();
    // Use 0ms interval so the test doesn't actually wait.
    const client = new ScryfallClient(http, { minIntervalMs: 0 });

    const names = Array.from({ length: 160 }, (_, i) => `Card ${i}`);
    const result = await client.fetchCardsByNames(names);

    // 160 names → ceil(160/75) = 3 requests.
    expect(bodies).toHaveLength(3);
    for (const body of bodies) {
      const { identifiers } = JSON.parse(body) as { identifiers: unknown[] };
      expect(identifiers.length).toBeLessThanOrEqual(COLLECTION_BATCH_SIZE);
    }

    // Every requested name comes back exactly once, in order across batches.
    const requested = bodies.flatMap(
      (b) => (JSON.parse(b) as { identifiers: Array<{ name: string }> }).identifiers.map((i) => i.name),
    );
    expect(requested).toEqual(names);
    expect(result.cards).toHaveLength(160);
    expect(result.unresolved).toEqual([]);
  });

  it('deduplicates and trims names before batching', async () => {
    const { http, bodies } = recordingClient();
    const client = new ScryfallClient(http, { minIntervalMs: 0 });

    await client.fetchCardsByNames(['Bolt', ' Bolt ', 'Bolt', '', 'Counterspell']);

    const { identifiers } = JSON.parse(bodies[0] ?? '{}') as {
      identifiers: Array<{ name: string }>;
    };
    expect(identifiers.map((i) => i.name)).toEqual(['Bolt', 'Counterspell']);
  });
});

describe('ScryfallClient.fetchCardsByNames — misses', () => {
  it('records not_found names as unresolved and keeps the rest', async () => {
    const http: HttpClient = {
      request() {
        return Promise.resolve(
          jsonResponse({
            data: [{ name: 'Lightning Bolt', cmc: 1 }],
            not_found: [{ name: 'Notarealcard' }],
          }),
        );
      },
    };
    const client = new ScryfallClient(http, { minIntervalMs: 0 });
    const result = await client.fetchCardsByNames(['Lightning Bolt', 'Notarealcard']);

    expect(result.cards.map((c) => c.name)).toEqual(['Lightning Bolt']);
    expect(result.unresolved).toEqual(['Notarealcard']);
  });

  it('does not crash the run when a whole batch throws — records it unresolved', async () => {
    const http: HttpClient = {
      request() {
        return Promise.reject(new Error('network down'));
      },
    };
    const client = new ScryfallClient(http, { minIntervalMs: 0 });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await client.fetchCardsByNames(['A', 'B']);

    expect(result.cards).toEqual([]);
    expect(result.unresolved).toEqual(['A', 'B']);
    warn.mockRestore();
  });
});

describe('ScryfallClient — retry/backoff', () => {
  it('retries transient 503s then succeeds', async () => {
    let calls = 0;
    const http: HttpClient = {
      request() {
        calls += 1;
        if (calls < 3) return Promise.resolve(jsonResponse({}, 503));
        return Promise.resolve(jsonResponse({ data: [{ name: 'X' }], not_found: [] }));
      },
    };
    const client = new ScryfallClient(http, { minIntervalMs: 0 });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Speed up: stub the backoff timer by making setTimeout fire immediately.
    const result = await client.fetchCardsByNames(['X']);

    expect(calls).toBe(3); // 2 failures + 1 success
    expect(result.cards.map((c) => c.name)).toEqual(['X']);
    warn.mockRestore();
  });

  it('does not retry a 404 — returns it for the caller to handle', async () => {
    let calls = 0;
    const http: HttpClient = {
      request() {
        calls += 1;
        return Promise.resolve(jsonResponse({}, 404));
      },
    };
    const client = new ScryfallClient(http, { minIntervalMs: 0 });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await client.fetchCardsByNames(['Ghost']);

    expect(calls).toBe(1); // no retry on 404
    expect(result.unresolved).toEqual(['Ghost']);
    warn.mockRestore();
  });
});

describe('ScryfallClient.fetchImageBytes', () => {
  it('returns bytes on success', async () => {
    const buffer = new TextEncoder().encode('imgdata').buffer;
    const http: HttpClient = {
      request() {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({}),
          arrayBuffer: () => Promise.resolve(buffer),
        });
      },
    };
    const client = new ScryfallClient(http, { minIntervalMs: 0 });
    const bytes = await client.fetchImageBytes('https://example/img.jpg');
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes?.length).toBe(7);
  });

  it('returns null (not throw) on a failed image fetch', async () => {
    const http: HttpClient = {
      request() {
        return Promise.reject(new Error('boom'));
      },
    };
    const client = new ScryfallClient(http, { minIntervalMs: 0 });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await client.fetchImageBytes('https://example/img.jpg')).toBeNull();
    warn.mockRestore();
  });
});
