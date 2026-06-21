import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ScryfallClient, type HttpClient, type HttpResponse } from './client.js';
import { runPipeline } from './pipeline.js';
import type { CardIndex, RawScryfallCard } from './types.js';

import lightningBolt from './__fixtures__/lightning-bolt.json' with { type: 'json' };
import delver from './__fixtures__/delver-dfc.json' with { type: 'json' };

function jsonResponse(body: unknown): HttpResponse {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
    arrayBuffer: () => Promise.resolve(new TextEncoder().encode('img').buffer),
  };
}

/**
 * An offline client: the collection POST returns our two fixtures plus one
 * miss; any other (image) GET returns fake bytes.
 */
function fixtureClient(): ScryfallClient {
  const http: HttpClient = {
    request(url) {
      if (url.includes('/cards/collection')) {
        return Promise.resolve(
          jsonResponse({
            data: [lightningBolt as RawScryfallCard, delver as RawScryfallCard],
            not_found: [{ name: 'Notarealcard' }],
          }),
        );
      }
      return Promise.resolve(jsonResponse({}));
    },
  };
  return new ScryfallClient(http, { minIntervalMs: 0 });
}

describe('runPipeline (offline, injected client)', () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'jb-data-tools-'));
    vi.spyOn(console, 'info').mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(workDir, { recursive: true, force: true });
  });

  it('fetches, normalizes, downloads art, and writes a card index', async () => {
    const outputPath = join(workDir, 'card-index.json');
    const imageCacheDir = join(workDir, 'images');

    const result = await runPipeline({
      names: ['Lightning Bolt', 'Delver of Secrets', 'Notarealcard'],
      outputPath,
      imageCacheDir,
      client: fixtureClient(),
    });

    expect(result.resolved).toBe(2);
    expect(result.unresolved).toEqual(['Notarealcard']);

    // Index file written and well-formed.
    const index = JSON.parse(await readFile(outputPath, 'utf8')) as CardIndex;
    expect(index.requested).toBe(3);
    expect(index.cards).toHaveLength(2);
    expect(index.attribution).toContain('Scryfall');
    // Sorted by name: Delver before Lightning Bolt.
    expect(index.cards.map((c) => c.name)).toEqual([
      'Delver of Secrets // Insectile Aberration',
      'Lightning Bolt',
    ]);

    // Art summary + files on disk + local paths recorded.
    expect(result.art?.downloaded).toBeGreaterThan(0);
    const bolt = index.cards.find((c) => c.name === 'Lightning Bolt');
    expect(bolt?.localImages.normal).toBeDefined();
    expect(existsSync(join(imageCacheDir, bolt!.localImages.normal!))).toBe(true);
  });

  it('skips art when skipArt is set', async () => {
    const result = await runPipeline({
      names: ['Lightning Bolt'],
      outputPath: join(workDir, 'idx.json'),
      imageCacheDir: join(workDir, 'images'),
      client: fixtureClient(),
      skipArt: true,
    });
    expect(result.art).toBeNull();
    expect(result.index.cards[0]?.localImages).toEqual({});
  });
});
