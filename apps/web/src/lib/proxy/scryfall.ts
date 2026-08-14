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

import { COLLECTION_BATCH_SIZE, MIN_REQUEST_INTERVAL_MS } from './config.js';
import { fetchCardCollection, type FetchLike } from '../scryfall/collection.js';
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

/**
 * The `fetch` shape this client needs, re-exported from the shared Scryfall
 * client so there is one definition. `body` is optional so callers can issue
 * both `POST /cards/collection` and a bare `GET /cards/search`.
 */
export type { FetchLike };

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

  constructor(
    fetchImpl: FetchLike,
    options: { minIntervalMs?: number; batchSize?: number } = {},
  ) {
    this.fetchImpl = fetchImpl;
    this.minIntervalMs = options.minIntervalMs ?? MIN_REQUEST_INTERVAL_MS;
    this.batchSize = options.batchSize ?? COLLECTION_BATCH_SIZE;
  }

  /**
   * Resolve parsed decklist cards to print images. Deduplicates by name+set,
   * batches ≤{@link COLLECTION_BATCH_SIZE} identifiers per request, and returns
   * both the resolved cards and the names Scryfall couldn't find.
   *
   * The fetching itself — batching, the rate-limit floor, the descriptive
   * User-Agent, and continuing past a failed batch — lives in the shared
   * `lib/scryfall/collection.ts` client that deck import also uses, so there is
   * one implementation of Scryfall etiquette in the app. This method keeps only
   * what is specific to printing proxies: choosing the best print image and
   * handling double-faced backs.
   */
  async resolve(cards: readonly ParsedCard[]): Promise<ResolveResult> {
    const identifiers = cards.map((card) =>
      card.set ? { name: card.name, set: card.set } : { name: card.name },
    );

    const { cards: rawCards, notFound } = await fetchCardCollection(
      identifiers,
      this.fetchImpl,
      { minIntervalMs: this.minIntervalMs, batchSize: this.batchSize },
    );

    const byNormName = new Map<string, ResolvedProxyCard>();
    const unresolved: string[] = [...notFound];

    for (const card of rawCards) {
      const raw = card as RawScryfallCard;
      const images = extractImages(raw);
      if (!images.front) continue; // No usable image → treated as a miss below.
      const resolvedCard: ResolvedProxyCard = { name: raw.name, imageUrl: images.front };
      if (raw.set) resolvedCard.set = raw.set;
      if (images.back) resolvedCard.backImageUrl = images.back;
      byNormName.set(normalizeName(raw.name), resolvedCard);
    }

    // De-duplicated identifier order drives the result order below.
    const identifierMap = new Map<string, { name: string; set?: string }>();
    for (const identifier of identifiers) {
      const key = `${normalizeName(identifier.name)}|${identifier.set ?? ''}`;
      if (!identifierMap.has(key)) identifierMap.set(key, identifier);
    }
    const uniqueIdentifiers = [...identifierMap.values()];

    // Map back to the requested-name order and flag any that didn't resolve.
    const resolved: ResolvedProxyCard[] = [];
    const seen = new Set<string>();
    for (const id of uniqueIdentifiers) {
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
