/**
 * @jonny-boi/data-tools — Scryfall fetch/cache pipeline (DESIGN.md §3.3).
 *
 * Fetches real MTG card data + art from Scryfall for a curated pool, normalizes
 * it into clean internal records, downloads art to a local (gitignored) cache,
 * and writes a committed normalized **card index** the engine/UI consume. The
 * engine and UI never call Scryfall at play time — they read the index.
 *
 * Public surface:
 *  - Types:        NormalizedCard, ManaCost, ParsedTypeLine, CardIndex, …
 *  - Pure logic:   parseManaCost, parseTypeLine, parseStat, normalizeCard
 *  - Client:       ScryfallClient, HttpClient (injectable), createFetchHttpClient
 *  - Art:          downloadArt
 *  - Pipeline:     runPipeline, loadStarterCardNames
 *  - Paths:        cardIndexPath, imageCacheDir, … (package-relative resolvers)
 */

export const PACKAGE_NAME = 'data-tools';

export * from './types.js';
export * from './constants.js';
export { parseManaCost, parseTypeLine, parseStat } from './parse.js';
export { normalizeCard } from './normalize.js';
export {
  ScryfallClient,
  createFetchHttpClient,
  chunk,
  type HttpClient,
  type HttpRequest,
  type HttpResponse,
} from './client.js';
export { downloadArt, slugify, type DownloadArtOptions, type DownloadArtSummary } from './art.js';
export {
  runPipeline,
  loadStarterCardNames,
  type PipelineOptions,
  type PipelineResult,
} from './pipeline.js';
export {
  cardIndexPath,
  starterCardListPath,
  imageCacheDir,
  rawCacheDir,
  cacheDir,
  dataDir,
} from './paths.js';
