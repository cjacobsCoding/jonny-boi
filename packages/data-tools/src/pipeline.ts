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
import { buildCorpusIndex, serializeCorpusIndex, type CorpusIndex } from './corpus-index.js';
import {
  cardIndexPath,
  corpusIndexPath,
  imageCacheDir,
  rawCacheDir,
  starterCardListPath,
} from './paths.js';
import type { CardIndex, NormalizedCard } from './types.js';
import { frontFaceName } from './verify.js';

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
  /**
   * Raw Scryfall records to use INSTEAD of asking Scryfall.
   *
   * The whole printed corpus arrives in ONE bulk download (see
   * `packages/cards/scripts/fetch-full-corpus.mjs`), and once it is on disk,
   * building an index for thousands of cards is a FILTER rather than sixty-five
   * paged requests. Everything downstream — normalize, sort, the index shape,
   * the write — stays the same code either way, because two writers of one file
   * are two files that eventually disagree.
   */
  rawCards?: readonly unknown[];
  /**
   * §3.167 — where a CORPUS run writes the slim index of everything it did not
   * select into the pool. Defaults to the committed location; ignored (nothing
   * is written) when `rawCards` is absent, because a network run has no corpus
   * to subtract the pool from.
   */
  corpusIndexPath?: string;
}

export interface PipelineResult {
  index: CardIndex;
  outputPath: string;
  resolved: number;
  unresolved: string[];
  art: DownloadArtSummary | null;
  /** §3.167 — the corpus index a corpus run wrote, or null for a network run. */
  corpus: { index: CorpusIndex; outputPath: string } | null;
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
 * The requested cards, from an offline corpus when one was supplied and from
 * Scryfall otherwise.
 *
 * A corpus record is matched on its FRONT-FACE name, the same key the network
 * path asks Scryfall with, so "Fire // Ice" resolves identically on both — a
 * name that resolved online and not offline would be an index that silently
 * changes shape depending on how it was built.
 */
async function resolveCards(
  options: PipelineOptions,
  client: ScryfallClient,
  names: readonly string[],
): Promise<{ cards: Parameters<typeof normalizeCard>[0][]; unresolved: string[] }> {
  if (options.rawCards === undefined) {
    console.info(`[pipeline] resolving ${names.length} card names via Scryfall…`);
    return client.fetchCardsByNames([...names]);
  }
  console.info(`[pipeline] selecting ${names.length} cards from an offline corpus…`);
  const byName = new Map<string, Parameters<typeof normalizeCard>[0]>();
  for (const raw of options.rawCards) {
    const record = raw as Parameters<typeof normalizeCard>[0] & { name?: string };
    if (typeof record.name !== 'string') continue;
    // First printing wins, so a re-run over the same corpus is byte-identical.
    const key = frontFaceName(record.name);
    if (!byName.has(key)) byName.set(key, record);
  }
  const cards: Parameters<typeof normalizeCard>[0][] = [];
  const unresolved: string[] = [];
  for (const name of names) {
    const found = byName.get(frontFaceName(name));
    if (found === undefined) unresolved.push(name);
    else cards.push(found);
  }
  return { cards, unresolved };
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

  const { cards: rawCards, unresolved } = await resolveCards(options, client, names);
  console.info(`[pipeline] resolved ${rawCards.length}; unresolved ${unresolved.length}`);

  // Cache raw responses (gitignored) so a re-run/repair doesn't re-fetch. A
  // CORPUS run skips it: the corpus file already IS the cache, and re-spooling
  // it into thousands of one-card files buys nothing and costs a lot of I/O.
  if (options.rawCards === undefined) await writeRawCache(rawCards);

  const cards: NormalizedCard[] = rawCards.map(normalizeCard);
  // ⚠️ THE INDEX OWNS IDS; THE CORPUS OWNS EVERYTHING ELSE. Two rules in one
  // place, because getting either half wrong breaks a different thing:
  //
  //   - The ID is the join key. `pool.ts` stores it per card, and a bulk
  //     `oracle-cards` corpus carries ONE printing per Oracle name with Scryfall
  //     choosing which — so re-picking would rewrite Plains' id out from under
  //     every reference to it. A name already in the index keeps its id.
  //   - Everything else is taken FRESH. Preserving whole rows instead was the
  //     first attempt, and it made the index and the pool disagree: the pool
  //     compiles from the corpus's Oracle text while the index kept an older
  //     fetch's, so a card whose wording WotC has since updated compiled two
  //     different ways and the ground-truth test caught it.
  //
  // `localImages` rides along with the id because it names files already on
  // disk for that printing; re-deriving it would point at art nobody downloaded.
  // The network path is untouched: a deliberate refetch SHOULD refresh a row.
  if (options.rawCards !== undefined) {
    const existing = await readExistingIndex(outputPath);
    for (let i = 0; i < cards.length; i++) {
      const fresh = cards[i] as NormalizedCard;
      const known = existing.get(fresh.name);
      if (known === undefined) continue;
      cards[i] = {
        ...fresh,
        id: known.id,
        ...(known.localImages === undefined ? {} : { localImages: known.localImages }),
      };
    }
  }
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

  // §3.167 — the other tier: everything in the corpus the pool did not take,
  // keyed by the same front-face name the selection above resolved on, so the
  // two files are disjoint by construction and a regeneration moves a card
  // between them rather than duplicating it.
  let corpus: PipelineResult['corpus'] = null;
  if (options.rawCards !== undefined) {
    const poolNames = new Set(cards.map((card) => frontFaceName(card.name)));
    const corpusIndex = buildCorpusIndex(
      options.rawCards,
      (key) => poolNames.has(key),
      frontFaceName,
      ATTRIBUTION,
    );
    const corpusPath = options.corpusIndexPath ?? corpusIndexPath();
    await mkdir(dirname(corpusPath), { recursive: true });
    await writeFile(corpusPath, serializeCorpusIndex(corpusIndex), 'utf8');
    console.info(
      `[pipeline] wrote ${corpusIndex.cards.length} corpus-only cards (of ${corpusIndex.corpusSize}) → ${corpusPath}`,
    );
    corpus = { index: corpusIndex, outputPath: corpusPath };
  }

  return { index, outputPath, resolved: rawCards.length, unresolved, art, corpus };
}

/**
 * The rows the committed index already holds, by card name.
 *
 * A missing or unreadable index is an EMPTY map, not an error: the very first
 * run has no file to read, and a corpus build must work from nothing.
 */
async function readExistingIndex(outputPath: string): Promise<Map<string, NormalizedCard>> {
  try {
    const parsed = JSON.parse(await readFile(outputPath, 'utf8')) as CardIndex;
    return new Map(parsed.cards.map((card) => [card.name, card]));
  } catch {
    return new Map();
  }
}

/** Persist raw card JSON to the gitignored cache, one file per card. */
async function writeRawCache(rawCards: { name: string }[]): Promise<void> {
  const dir = rawCacheDir();
  await mkdir(dir, { recursive: true });
  await Promise.all(
    rawCards.map(async (raw) => {
      const safe = raw.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
      await writeFile(`${dir}/${safe}.json`, JSON.stringify(raw, null, 2), 'utf8');
    }),
  );
}
