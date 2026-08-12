/**
 * Browser-side Scryfall client for the Proxies feature.
 *
 * It reuses the exact etiquette the `@jonny-boi/data-tools` client established —
 * a descriptive User-Agent, a ≥100ms rate-limit floor, and the bulk
 * `POST /cards/collection` endpoint (≤75 identifiers per request) — but runs in
 * the browser and returns *print* image URLs rather than downloading bytes.
 *
 * The `fetch` call is isolated behind an injectable {@link FetchLike} so the
 * batching / rate-limit / image-selection logic is unit-testable with no live
 * network (CLAUDE.md: pure-core + mandatory tests).
 */

import {
  COLLECTION_BATCH_SIZE,
  MIN_REQUEST_INTERVAL_MS,
  SCRYFALL_API_BASE,
  SCRYFALL_COLLECTION_PATH,
  SCRYFALL_USER_AGENT,
} from './config.js';
import type { CountedProxyCard } from './paginate.js';
import type { ParsedCard } from './parseDecklist.js';

/** Scryfall's `image_uris` map (the keys we care about for print quality). */
export interface ScryfallImageUris {
  png?: string;
  large?: string;
  normal?: string;
  small?: string;
  border_crop?: string;
  art_crop?: string;
}

/** The subset of a raw Scryfall card we read for proxy rendering. */
export interface RawScryfallCard {
  name: string;
  set?: string;
  image_uris?: ScryfallImageUris;
  card_faces?: Array<{ name: string; image_uris?: ScryfallImageUris }>;
  layout?: string;
}

/** Scryfall's collection response shape. */
interface CollectionResponse {
  data?: RawScryfallCard[];
  not_found?: Array<{ name?: string }>;
}

/** A minimal structural subset of the global `fetch` we depend on. */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** A resolved card ready to print: its best print image (+ optional DFC back). */
export interface ResolvedProxyCard {
  name: string;
  set?: string;
  /** Best print image URL for the front face. */
  imageUrl: string;
  /** Best print image URL for the back face, if this is a double-faced card. */
  backImageUrl?: string;
}

/** Result of resolving a decklist: what printed, and what we couldn't find. */
export interface ResolveResult {
  resolved: ResolvedProxyCard[];
  /** Names Scryfall (or our matcher) couldn't resolve, verbatim. */
  unresolved: string[];
}

/**
 * Pick the best available print image from a Scryfall `image_uris` map. Print
 * quality order: `png` (745×1040, ~300+ DPI at card size) > `large` > `normal` >
 * `border_crop` > `small`. Returns `undefined` when none are present.
 */
export function bestPrintImage(uris: ScryfallImageUris | undefined): string | undefined {
  if (!uris) return undefined;
  return uris.png ?? uris.large ?? uris.normal ?? uris.border_crop ?? uris.small;
}

/**
 * Extract the printable image(s) from a raw card, handling double-faced layouts.
 * Single-faced cards carry `image_uris` at the top level; DFCs carry per-face
 * `image_uris` under `card_faces[]`. We always offer the front; the back is
 * returned separately so callers can optionally print it as its own proxy.
 */
export function extractImages(
  card: RawScryfallCard,
): { front?: string; back?: string } {
  const topLevel = bestPrintImage(card.image_uris);
  if (topLevel) {
    // Single-faced (or a card whose front image is at the top level).
    return { front: topLevel };
  }
  const faces = card.card_faces ?? [];
  const front = bestPrintImage(faces[0]?.image_uris);
  const back = bestPrintImage(faces[1]?.image_uris);
  return { front, back };
}

/** Delay helper for the rate-limit floor. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Split an array into chunks of at most `size`. */
function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Normalize a name for cache-keying / matching (case- and space-insensitive). */
function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * The browser Scryfall client. Enforces the rate-limit floor and batches name
 * lookups through the collection endpoint. Never throws on a partial failure —
 * a failed batch records its names as unresolved and the run continues so
 * whatever resolved still prints.
 */
export class ProxyScryfallClient {
  private readonly fetchImpl: FetchLike;
  private readonly minIntervalMs: number;
  private readonly batchSize: number;
  private lastRequestAt = 0;

  constructor(
    fetchImpl: FetchLike,
    options: { minIntervalMs?: number; batchSize?: number } = {},
  ) {
    this.fetchImpl = fetchImpl;
    this.minIntervalMs = options.minIntervalMs ?? MIN_REQUEST_INTERVAL_MS;
    this.batchSize = options.batchSize ?? COLLECTION_BATCH_SIZE;
  }

  /** Block until at least `minIntervalMs` has elapsed since the last request. */
  private async throttle(): Promise<void> {
    const elapsed = Date.now() - this.lastRequestAt;
    if (elapsed < this.minIntervalMs) await delay(this.minIntervalMs - elapsed);
    this.lastRequestAt = Date.now();
  }

  /**
   * Resolve parsed decklist cards to print images. Deduplicates by name+set,
   * batches ≤{@link COLLECTION_BATCH_SIZE} identifiers per request, and returns
   * both the resolved cards and the names Scryfall couldn't find.
   */
  async resolve(cards: readonly ParsedCard[]): Promise<ResolveResult> {
    // Deduplicate the identifiers we ask Scryfall for (qty is applied later).
    const identifierMap = new Map<string, { name: string; set?: string }>();
    for (const card of cards) {
      const key = `${normalizeName(card.name)}|${card.set ?? ''}`;
      if (!identifierMap.has(key)) {
        identifierMap.set(key, card.set ? { name: card.name, set: card.set } : { name: card.name });
      }
    }
    const identifiers = [...identifierMap.values()];

    const byNormName = new Map<string, ResolvedProxyCard>();
    const unresolved: string[] = [];

    for (const batch of chunk(identifiers, this.batchSize)) {
      try {
        await this.throttle();
        const response = await this.fetchImpl(
          `${SCRYFALL_API_BASE}${SCRYFALL_COLLECTION_PATH}`,
          {
            method: 'POST',
            headers: {
              'User-Agent': SCRYFALL_USER_AGENT,
              Accept: 'application/json',
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ identifiers: batch }),
          },
        );
        if (!response.ok) {
          unresolved.push(...batch.map((id) => id.name));
          continue;
        }
        const payload = (await response.json()) as CollectionResponse;
        for (const raw of payload.data ?? []) {
          const images = extractImages(raw);
          if (!images.front) continue; // No usable image → treat as a miss below.
          const resolvedCard: ResolvedProxyCard = { name: raw.name, imageUrl: images.front };
          if (raw.set) resolvedCard.set = raw.set;
          if (images.back) resolvedCard.backImageUrl = images.back;
          byNormName.set(normalizeName(raw.name), resolvedCard);
        }
        for (const miss of payload.not_found ?? []) {
          if (miss.name) unresolved.push(miss.name);
        }
      } catch {
        unresolved.push(...batch.map((id) => id.name));
      }
    }

    // Map back to the requested-name order and flag any that didn't resolve.
    const resolved: ResolvedProxyCard[] = [];
    const seen = new Set<string>();
    for (const id of identifiers) {
      const hit = byNormName.get(normalizeName(id.name));
      if (hit && !seen.has(normalizeName(id.name))) {
        resolved.push(hit);
        seen.add(normalizeName(id.name));
      } else if (!hit && !unresolved.some((u) => normalizeName(u) === normalizeName(id.name))) {
        unresolved.push(id.name);
      }
    }

    return { resolved, unresolved };
  }
}

/**
 * Combine parsed cards (which carry quantities) with resolved images into the
 * counted proxy-card list the renderer expands. Cards whose name resolved get
 * their front (and, when `includeBacks`, their DFC back as an extra proxy).
 */
export function toCountedProxies(
  parsed: readonly ParsedCard[],
  resolved: readonly ResolvedProxyCard[],
  includeBacks: boolean,
): CountedProxyCard[] {
  const byName = new Map<string, ResolvedProxyCard>();
  for (const r of resolved) byName.set(normalizeName(r.name), r);

  const out: CountedProxyCard[] = [];
  for (const card of parsed) {
    const hit = byName.get(normalizeName(card.name));
    if (!hit) continue;
    out.push({ name: hit.name, imageUrl: hit.imageUrl, qty: card.qty });
    if (includeBacks && hit.backImageUrl) {
      out.push({
        name: hit.name,
        imageUrl: hit.backImageUrl,
        qty: card.qty,
        faceLabel: 'back',
      });
    }
  }
  return out;
}

export { normalizeName };
