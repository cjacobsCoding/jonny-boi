/**
 * Resolves the package-relative directories the pipeline reads/writes. Keeps
 * filesystem layout in one place (DRY) and works regardless of CWD by anchoring
 * on this module's location.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CACHE_DIR_NAME,
  CARD_INDEX_FILENAME,
  CORPUS_INDEX_FILENAME,
  DATA_DIR_NAME,
  IMAGE_CACHE_SUBDIR,
  RAW_CACHE_SUBDIR,
  STARTER_CARD_LIST_FILENAME,
} from './constants.js';

/** Absolute path to the `packages/data-tools` package root. */
export function packageRoot(): string {
  // This file lives at <pkg>/src/paths.ts (source) or <pkg>/dist/paths.js (built).
  // Either way, one level up from the file's dir is <pkg>.
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, '..');
}

/** Committed data dir (`data/`) holding the card index + starter list. */
export function dataDir(): string {
  return join(packageRoot(), DATA_DIR_NAME);
}

/** Gitignored cache dir (`data-cache/`) for raw JSON + image bytes. */
export function cacheDir(): string {
  return join(packageRoot(), CACHE_DIR_NAME);
}

/** Gitignored subdir for raw Scryfall card JSON. */
export function rawCacheDir(): string {
  return join(cacheDir(), RAW_CACHE_SUBDIR);
}

/** Gitignored subdir for downloaded images. */
export function imageCacheDir(): string {
  return join(cacheDir(), IMAGE_CACHE_SUBDIR);
}

/** Path to the committed normalized card index. */
export function cardIndexPath(): string {
  return join(dataDir(), CARD_INDEX_FILENAME);
}

export function corpusIndexPath(): string {
  return join(dataDir(), CORPUS_INDEX_FILENAME);
}

/** Path to the committed curated starter card-name list. */
export function starterCardListPath(): string {
  return join(dataDir(), STARTER_CARD_LIST_FILENAME);
}
