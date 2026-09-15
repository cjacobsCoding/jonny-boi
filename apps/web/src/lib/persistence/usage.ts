/**
 * WHAT IS ACTUALLY IN STORAGE — the readout that turns an invisible quota into
 * something a person can act on.
 *
 * An origin filling up had no surface at all: no number, no warning, no page.
 * The first time anyone learned the budget existed was when two decks did not
 * come back. So this module measures what is stored, attributes every byte to a
 * row of the budget table, and — importantly — reports what it CANNOT attribute
 * rather than quietly folding it into a total that then looks healthy.
 */
import {
  ORIGIN_STORAGE_BUDGET_CHARS,
  STORAGE_AREAS,
  areaForKey,
  storageArea,
  writeBudgetChars,
  type StorageArea,
  type StorageAreaId,
} from './budget.js';

/** Web Storage plus the enumeration this module needs and writes do not. */
export interface EnumerableStorage {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  removeItem(key: string): void;
}

/** One row of the readout. */
export interface AreaUsage {
  readonly area: StorageArea;
  /** Characters stored, key names included — that is what a browser counts. */
  readonly chars: number;
  /** This area's share of the origin budget, in characters. */
  readonly budget: number;
  /** How many keys make it up (more than one only for prefixed families). */
  readonly keys: number;
}

/** The whole picture. */
export interface StorageUsage {
  readonly areas: readonly AreaUsage[];
  /**
   * Keys on this origin that NO budget row claims, with their size.
   *
   * Reported rather than ignored: something occupying the origin that the app
   * does not know about is exactly the kind of thing that made this failure a
   * mystery, and a total that silently excluded it would be a lie of the same
   * shape as the one being fixed.
   */
  readonly unattributed: { readonly chars: number; readonly keys: readonly string[] };
  /** Every character on the origin, attributed or not. */
  readonly totalChars: number;
  /** What we assume the origin allows. See `budget.ts` for why it is pessimistic. */
  readonly originBudget: number;
}

/** The browser's localStorage as an enumerable, or null where blocked. */
export function browserEnumerableStorage(): EnumerableStorage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** Every key currently in `storage`, defensively (a throwing accessor reads as empty). */
function keysOf(storage: EnumerableStorage): string[] {
  const keys: string[] = [];
  try {
    for (let i = 0; i < storage.length; i += 1) {
      const key = storage.key(i);
      if (key !== null) keys.push(key);
    }
  } catch {
    // A storage that refuses to be enumerated reports what it managed, not a
    // crash — and the caller sees a small total rather than a fabricated one.
  }
  return keys;
}

/** Characters one entry occupies: the key AND the value, which is what counts. */
function entryChars(storage: EnumerableStorage, key: string): number {
  try {
    return key.length + (storage.getItem(key)?.length ?? 0);
  } catch {
    return 0;
  }
}

/** Measure the origin. Areas are returned largest-first — what to clear is the question. */
export function measureStorage(
  storage: EnumerableStorage | null = browserEnumerableStorage(),
): StorageUsage {
  const empty = { chars: 0, keys: 0 };
  const byArea = new Map<string, { chars: number; keys: number }>(
    STORAGE_AREAS.map((a) => [a.id, { ...empty }]),
  );
  const unattributedKeys: string[] = [];
  let unattributedChars = 0;
  let total = 0;

  if (storage) {
    for (const key of keysOf(storage)) {
      const chars = entryChars(storage, key);
      total += chars;
      const area = areaForKey(key);
      if (area === null) {
        unattributedKeys.push(key);
        unattributedChars += chars;
        continue;
      }
      const row = byArea.get(area.id)!;
      byArea.set(area.id, { chars: row.chars + chars, keys: row.keys + 1 });
    }
  }

  const areas = STORAGE_AREAS.filter((a) => a.scope === 'local')
    .map((area) => {
      const row = byArea.get(area.id) ?? empty;
      return {
        area,
        chars: row.chars,
        keys: row.keys,
        budget: writeBudgetChars(area.id as StorageAreaId),
      };
    })
    .sort((a, b) => b.chars - a.chars);

  return {
    areas,
    unattributed: { chars: unattributedChars, keys: unattributedKeys },
    totalChars: total,
    originBudget: ORIGIN_STORAGE_BUDGET_CHARS,
  };
}

/**
 * Delete everything in one area. Returns how many keys went.
 *
 * Only ever called from the storage readout, on a row the table marks
 * `clearable`. The check is here rather than only in the UI so a second caller
 * cannot wipe the saved decks by passing the wrong id — `clearable: false` is a
 * property of the data, not of the button.
 */
export function clearStorageArea(
  id: StorageAreaId,
  storage: EnumerableStorage | null = browserEnumerableStorage(),
): number {
  const area = storageArea(id);
  if (!storage || area === null || !area.clearable) return 0;
  const doomed = keysOf(storage).filter((key) => areaForKey(key)?.id === id);
  let removed = 0;
  for (const key of doomed) {
    try {
      storage.removeItem(key);
      removed += 1;
    } catch {
      // A key that refuses to go is reported by the count, not by a lie.
    }
  }
  return removed;
}

/** "1.2 MB" / "840 KB" / "512 characters" — one formatter, every consumer. */
export function formatChars(chars: number): string {
  if (chars >= 1_000_000) return `${(chars / 1_000_000).toFixed(1)} MB`;
  if (chars >= 1_000) return `${Math.round(chars / 1_000)} KB`;
  return `${chars} characters`;
}
