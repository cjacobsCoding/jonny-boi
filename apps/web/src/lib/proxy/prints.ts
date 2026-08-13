/**
 * Alternate-printings lookup for the Proxies feature.
 *
 * When the user wants different art for a card, we ask Scryfall for every
 * *printing* of that exact name (`GET /cards/search?q=!"Name"&unique=prints`)
 * and offer them in a thumbnail picker. This module owns the pure parse/dedupe
 * of that response ({@link parsePrintsResponse}) and a thin client method
 * ({@link fetchPrints}) that reuses the existing rate-limit + User-Agent
 * etiquette. The network call is isolated behind {@link FetchLike} so parsing is
 * unit-testable with no live network.
 */

import {
  MAX_PRINTS_SHOWN,
  MIN_REQUEST_INTERVAL_MS,
  SCRYFALL_API_BASE,
  SCRYFALL_SEARCH_PATH,
  SCRYFALL_USER_AGENT,
} from './config.js';
import {
  bestPrintImage,
  extractImages,
  normalizeName,
  type FetchLike,
  type RawScryfallCard,
} from './scryfall.js';

/** One selectable printing in the "change printing" picker. */
export interface PrintOption {
  /** Scryfall id — stable identity for the chosen printing. */
  scryfallId: string;
  /** Card name (front-face name for DFCs). */
  name: string;
  /** Set code, uppercased for display (e.g. "MH2"). */
  set?: string;
  /** Full set name (e.g. "Modern Horizons 2"). */
  setName?: string;
  /** Collector number within the set. */
  collectorNumber?: string;
  /** Best print image URL for the front face. */
  imageUrl: string;
  /** Best print image URL for the back face, if double-faced. */
  backImageUrl?: string;
  /** Small image for the picker grid (falls back to the print image). */
  thumbnailUrl: string;
  /** Illustrator credit, if present. */
  artist?: string;
}

/** The extra fields a full `/cards/search` card carries beyond the print subset. */
interface RawPrintCard extends RawScryfallCard {
  id?: string;
  set_name?: string;
  collector_number?: string;
  artist?: string;
}

/** Scryfall `/cards/search` list response shape (the parts we read). */
interface SearchResponse {
  data?: RawPrintCard[];
  has_more?: boolean;
}

/**
 * Parse a Scryfall search response into de-duplicated {@link PrintOption}s.
 * Skips printings with no usable image, dedupes by Scryfall id (a search can
 * echo the same physical printing), and caps the list at
 * {@link MAX_PRINTS_SHOWN}. Never throws on a malformed payload — a bad shape
 * yields an empty list.
 */
export function parsePrintsResponse(payload: unknown): PrintOption[] {
  const response = (payload ?? {}) as SearchResponse;
  const rows = Array.isArray(response.data) ? response.data : [];
  const out: PrintOption[] = [];
  const seen = new Set<string>();

  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') continue;
    const images = extractImages(raw);
    if (!images.front) continue; // No printable image → not a usable option.

    // Prefer the Scryfall id; fall back to a synthetic key so a missing id
    // doesn't collapse distinct printings into one.
    const id = typeof raw.id === 'string' && raw.id.length > 0
      ? raw.id
      : `${raw.set ?? '?'}:${raw.collector_number ?? out.length}`;
    if (seen.has(id)) continue;
    seen.add(id);

    // A small thumbnail keeps the picker light; fall back to the print image.
    const smallish =
      raw.image_uris?.small ??
      raw.image_uris?.normal ??
      raw.card_faces?.[0]?.image_uris?.small ??
      raw.card_faces?.[0]?.image_uris?.normal ??
      bestPrintImage(raw.image_uris);

    const option: PrintOption = {
      scryfallId: id,
      name: raw.name,
      imageUrl: images.front,
      thumbnailUrl: smallish ?? images.front,
    };
    if (raw.set) option.set = raw.set.toUpperCase();
    if (raw.set_name) option.setName = raw.set_name;
    if (raw.collector_number) option.collectorNumber = raw.collector_number;
    if (raw.artist) option.artist = raw.artist;
    if (images.back) option.backImageUrl = images.back;

    out.push(option);
    if (out.length >= MAX_PRINTS_SHOWN) break;
  }

  return out;
}

/** Build a display label for a printing, e.g. "MH2 · #123 · Ron Spencer". */
export function printLabel(option: PrintOption): string {
  const parts: string[] = [];
  if (option.set) parts.push(option.set);
  if (option.collectorNumber) parts.push(`#${option.collectorNumber}`);
  if (option.artist) parts.push(option.artist);
  return parts.join(' · ') || option.name;
}

/** Delay helper for the rate-limit floor (mirrors the collection client). */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A tiny GET client for a card's printings. Shares the Scryfall etiquette
 * (User-Agent + ≥100ms floor) with {@link ProxyScryfallClient} but is a separate
 * throttle since it's a distinct, on-demand code path. Never throws — a failed
 * lookup returns an empty list so the picker degrades to "no alternates found".
 */
export class ProxyPrintsClient {
  private readonly fetchImpl: FetchLike;
  private readonly minIntervalMs: number;
  private lastRequestAt = 0;

  constructor(fetchImpl: FetchLike, options: { minIntervalMs?: number } = {}) {
    this.fetchImpl = fetchImpl;
    this.minIntervalMs = options.minIntervalMs ?? MIN_REQUEST_INTERVAL_MS;
  }

  private async throttle(): Promise<void> {
    const elapsed = Date.now() - this.lastRequestAt;
    if (elapsed < this.minIntervalMs) await delay(this.minIntervalMs - elapsed);
    this.lastRequestAt = Date.now();
  }

  /** Fetch (the first page of) alternate printings for an exact card name. */
  async fetchPrints(name: string): Promise<PrintOption[]> {
    // `!"Name"` = exact-name match; `unique=prints` = one row per printing;
    // `order=released` = newest first. `include_extras` pulls tokens/promos too.
    const query = `!${JSON.stringify(name)} unique:prints`;
    const url =
      `${SCRYFALL_API_BASE}${SCRYFALL_SEARCH_PATH}` +
      `?q=${encodeURIComponent(query)}&unique=prints&order=released`;
    try {
      await this.throttle();
      const response = await this.fetchImpl(url, {
        method: 'GET',
        headers: { 'User-Agent': SCRYFALL_USER_AGENT, Accept: 'application/json' },
      });
      // A name with no alternates yields a 404 from search — that's not an error.
      if (!response.ok) return [];
      return parsePrintsResponse(await response.json());
    } catch {
      return [];
    }
  }
}

export { normalizeName };
