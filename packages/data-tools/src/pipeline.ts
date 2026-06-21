/**
 * The end-to-end pipeline: names → fetch → normalize → download art → write a
 * committed normalized card index. The raw cache + image bytes stay gitignored;
 * the text-only index is committed so others get card data without re-fetching.
 *
 * Fetching/downloading happen behind the injected {@link ScryfallClient} (whose
 * HTTP is itself injectable), so this orchestration is testable offline.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { downloadArt, type DownloadArtSummary } from './art.js';
import { createFetchHttpClient, ScryfallClient } from './client.js';
import { normalizeCard } from './normalize.js';
import { cardIndexPath, imageCacheDir, rawCacheDir, starterCardListPath } from './paths.js';
import type { CardIndex, NormalizedCard } from './types.js';

/** Attribution string baked into the index (Scryfall etiquette). */
const ATTRIBUTION =
  'Card data and images via the Scryfall API (https://scryfall.com). Card names, text, and art © Wizards of the Coast.';

/** Shape of the committed starter card-name list data file. */
interface StarterCardList {
  names: string[];
}

export interface PipelineOptions {
  /** Card names to fetch. Defaults to the committed starter list. */
  names?: string[];
  /** Where to write the normalized index. Defaults to the committed location. */
  outputPath?: string;
  /** Image cache dir (gitignored). Defaults to the package cache. */
  imageCacheDir?: string;
  /** Inject a client (e.g. for tests). Defaults to a live Scryfall client. */
  client?: ScryfallClient;
  /** Skip art download (e.g. data-only refresh). Defaults to false. */
  skipArt?: boolean;
}

export interface PipelineResult {
  index: CardIndex;
  outputPath: string;
  resolved: number;
  unresolved: string[];
  art: DownloadArtSummary | null;
}

/** Load the committed curated starter card-name list. */
export async function loadStarterCardNames(): Promise<string[]> {
  const raw = await readFile(starterCardListPath(), 'utf8');
  const parsed = JSON.parse(raw) as StarterCardList;
  if (!Array.isArray(parsed.names)) {
    throw new Error('starter card list is missing a `names` array');
  }
  return parsed.names;
}

/**
 * Run the full pipeline. Returns the index plus a summary. Caches the raw
 * Scryfall responses to the gitignored cache as it goes, so partial progress
 * survives even if a later step fails.
 */
export async function runPipeline(options: PipelineOptions = {}): Promise<PipelineResult> {
  const names = options.names ?? (await loadStarterCardNames());
  const outputPath = options.outputPath ?? cardIndexPath();
  const artDir = options.imageCacheDir ?? imageCacheDir();
  const client = options.client ?? new ScryfallClient(createFetchHttpClient());

  console.info(`[pipeline] resolving ${names.length} card names via Scryfall…`);
  const { cards: rawCards, unresolved } = await client.fetchCardsByNames(names);
  console.info(`[pipeline] resolved ${rawCards.length}; unresolved ${unresolved.length}`);

  // Cache raw responses (gitignored) so a re-run/repair doesn't re-fetch.
  await writeRawCache(rawCards);

  const cards: NormalizedCard[] = rawCards.map(normalizeCard);
  cards.sort((a, b) => a.name.localeCompare(b.name));

  let art: DownloadArtSummary | null = null;
  if (!options.skipArt) {
    console.info('[pipeline] downloading art…');
    art = await downloadArt(cards, client, { imageCacheDir: artDir });
    console.info(
      `[pipeline] art: ${art.downloaded} downloaded, ${art.skipped} cached, ${art.failed} failed`,
    );
  }

  const index: CardIndex = {
    generatedAt: new Date().toISOString(),
    attribution: ATTRIBUTION,
    requested: names.length,
    unresolved,
    cards,
  };

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(index, null, 2)}\n`, 'utf8');
  console.info(`[pipeline] wrote ${cards.length} cards → ${outputPath}`);

  return { index, outputPath, resolved: rawCards.length, unresolved, art };
}

/** Persist raw card JSON to the gitignored cache, one file per card. */
async function writeRawCache(rawCards: { name: string }[]): Promise<void> {
  const dir = rawCacheDir();
  await mkdir(dir, { recursive: true });
  await Promise.all(
    rawCards.map(async (raw) => {
      const safe = raw.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
      await writeFile(`${dir}/${safe}.json`, JSON.stringify(raw, null, 2), 'utf8');
    }),
  );
}
