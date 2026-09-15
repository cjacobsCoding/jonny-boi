/**
 * Per-card art overrides for the Proxies feature.
 *
 * A card resolved from a decklist prints its default Scryfall art. The user can
 * override that art two ways — pick a different *printing* of the same card, or
 * upload their own image (a full-art custom, a token, an altered card). This
 * module is the ONE override model: a normalized-name → {@link CardOverride}
 * map, persisted to localStorage (reusing the cache.ts defensive pattern) so
 * overrides survive reloads and re-fetches, plus the pure `applyOverrides`
 * function that folds overrides onto a resolved list for the preview and print
 * sheet.
 *
 * Kept dependency-free (no DOM, no network) so the model is unit-testable.
 */

import { PROXY_OVERRIDES_STORAGE_KEY } from './config.js';
import { normalizeName, type ResolvedProxyCard } from './scryfall.js';
import { writeStorage } from '../persistence/write.js';

/** An override that swaps in a different Scryfall printing of the same card. */
export interface PrintingOverride {
  kind: 'printing';
  /** Scryfall id of the chosen printing (stable identity for the selection). */
  scryfallId: string;
  /** Best print image URL for the front face of the chosen printing. */
  imageUrl: string;
  /** Best print image URL for the back face, if the printing is double-faced. */
  backImageUrl?: string;
  /** Set code of the chosen printing (for the "custom" badge label). */
  set?: string;
  /** Human label for the badge, e.g. "MH2 · #123". */
  label?: string;
}

/** An override that replaces the art with a user-uploaded image (data URL). */
export interface UploadOverride {
  kind: 'upload';
  /** The uploaded image as a data URL — self-contained, survives reload. */
  imageUrl: string;
  /** Original file name (for the badge/label), if known. */
  fileName?: string;
}

/** Either kind of per-card override. */
export type CardOverride = PrintingOverride | UploadOverride;

/** In-memory view of the persisted overrides: normalized name → override. */
export type OverrideMap = Map<string, CardOverride>;

/** Type guard: a value is a well-formed persisted override. */
function isCardOverride(value: unknown): value is CardOverride {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (typeof v.imageUrl !== 'string' || v.imageUrl.length === 0) return false;
  if (v.kind === 'upload') return true;
  if (v.kind === 'printing') return typeof v.scryfallId === 'string';
  return false;
}

/** Load the overrides map from localStorage (empty on any failure). */
export function loadOverrides(): OverrideMap {
  const map: OverrideMap = new Map();
  try {
    const raw = globalThis.localStorage?.getItem(PROXY_OVERRIDES_STORAGE_KEY);
    if (!raw) return map;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return map;
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (isCardOverride(value)) map.set(key, value);
    }
  } catch {
    // Corrupt store → start clean rather than crash.
  }
  return map;
}

/**
 * Persist the overrides map to localStorage.
 *
 * NOT quiet, and this is the clearest example of why the swallow was wrong: an
 * uploaded data URL is easily large enough to blow the quota, the override goes
 * on working for the rest of the session, and the art the user hand-picked is
 * gone on reload with no word said. Returns `false` on failure as it always
 * did, so callers that check still work — but the user is told either way.
 */
export function saveOverrides(map: OverrideMap): boolean {
  const obj: Record<string, CardOverride> = {};
  for (const [key, value] of map) obj[key] = value;
  return writeStorage('proxy-overrides', PROXY_OVERRIDES_STORAGE_KEY, JSON.stringify(obj)).ok;
}

/**
 * Return a NEW map with `name`'s override set (immutable update so React state
 * transitions are clean). The map is keyed by normalized name.
 */
export function setOverride(
  map: OverrideMap,
  name: string,
  override: CardOverride,
): OverrideMap {
  const next = new Map(map);
  next.set(normalizeName(name), override);
  return next;
}

/** Return a NEW map with `name`'s override removed (reset to default art). */
export function clearOverride(map: OverrideMap, name: string): OverrideMap {
  const next = new Map(map);
  next.delete(normalizeName(name));
  return next;
}

/** Look up a card's override by (raw) name. */
export function getOverride(map: OverrideMap, name: string): CardOverride | undefined {
  return map.get(normalizeName(name));
}

/**
 * Fold overrides onto a resolved-card list: any card with an override has its
 * front (and, for printing overrides, back) image replaced by the override's.
 * Cards without an override pass through unchanged. Pure — the single source of
 * "resolved image = override if present, else default" used by preview + print.
 */
export function applyOverrides(
  resolved: readonly ResolvedProxyCard[],
  overrides: OverrideMap,
): ResolvedProxyCard[] {
  return resolved.map((card) => {
    const override = overrides.get(normalizeName(card.name));
    if (!override) return card;
    const next: ResolvedProxyCard = { name: card.name, imageUrl: override.imageUrl };
    if (card.set) next.set = card.set;
    if (override.kind === 'printing') {
      if (override.set) next.set = override.set;
      // A printing override may switch DFC-ness; only carry a back if it has one.
      if (override.backImageUrl) next.backImageUrl = override.backImageUrl;
    }
    // An upload override is a single flat image — it drops any DFC back.
    return next;
  });
}
