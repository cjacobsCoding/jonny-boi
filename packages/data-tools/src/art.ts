/**
 * Art downloader: given normalized cards, download chosen image sizes to the
 * (gitignored) local cache, skipping files already present, and record the
 * local path on each card. Rate-limiting/retry come from the injected client.
 */

import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { ScryfallClient } from './client.js';
import { DEFAULT_IMAGE_SIZES } from './constants.js';
import type { NormalizedCard } from './types.js';

/** Image-size keys we download. */
type ImageSize = (typeof DEFAULT_IMAGE_SIZES)[number];

/** Map Scryfall image-size keys to a file extension. art_crop/png-less are jpg. */
function extensionFor(url: string): string {
  if (url.includes('.png')) return 'png';
  if (url.includes('.webp')) return 'webp';
  return 'jpg';
}

/** Filesystem-safe slug for a card name (used in image filenames). */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export interface DownloadArtOptions {
  /** Absolute path to the image cache directory (gitignored). */
  imageCacheDir: string;
  /** Which image sizes to download. Defaults to {@link DEFAULT_IMAGE_SIZES}. */
  sizes?: readonly ImageSize[];
}

export interface DownloadArtSummary {
  downloaded: number;
  skipped: number;
  failed: number;
}

/**
 * Download art for each card, mutating `card.localImages` with cache-relative
 * paths. Idempotent: a file already on disk is recorded and skipped, never
 * re-fetched (Scryfall etiquette — cache aggressively, don't re-host).
 *
 * Robust: a missing URL (e.g. a DFC face with no top-level art) or a failed
 * download is logged and skipped; the pass continues.
 */
export async function downloadArt(
  cards: NormalizedCard[],
  client: ScryfallClient,
  options: DownloadArtOptions,
): Promise<DownloadArtSummary> {
  const sizes = options.sizes ?? DEFAULT_IMAGE_SIZES;
  const summary: DownloadArtSummary = { downloaded: 0, skipped: 0, failed: 0 };

  await mkdir(options.imageCacheDir, { recursive: true });

  for (const card of cards) {
    for (const size of sizes) {
      const url = card.imageUris[size];
      if (!url) continue; // No art at this size (common for some DFCs) — skip.

      const ext = extensionFor(url);
      const filename = `${slugify(card.name)}-${size}.${ext}`;
      const absolutePath = join(options.imageCacheDir, filename);

      // Record the local path regardless of whether we (re)download.
      card.localImages[size] = filename;

      if (existsSync(absolutePath)) {
        summary.skipped += 1;
        continue;
      }

      const bytes = await client.fetchImageBytes(url);
      if (!bytes) {
        summary.failed += 1;
        // Remove the optimistic path record since the file isn't there.
        delete card.localImages[size];
        continue;
      }

      await mkdir(dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, bytes);
      summary.downloaded += 1;
    }
  }

  return summary;
}
