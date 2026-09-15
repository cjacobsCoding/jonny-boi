/**
 * THE ONE WRITE FUNNEL for Web Storage.
 *
 * ## Why every write goes through here
 *
 * Fifteen call sites used to own their own `try { setItem } catch { }`. Eleven
 * of them swallowed the error into a console line or into nothing at all, so a
 * full origin looked exactly like a successful save — which is how two imported
 * decks disappeared between a session and its reload.
 *
 * The shape of that defect is "the code that knows the write failed is not the
 * code that can tell anyone". So the funnel does three things no call site can
 * forget to do:
 *
 *  1. **Returns a result.** `{ ok: false, reason }` — never `void`. A caller
 *     that ignores it is visible in review; a caller that never had one was not.
 *  2. **Reports every failure itself**, to `failures.ts`, which the app shell
 *     renders. Reporting is structural, not a thing each author remembers.
 *  3. **Checks the budget first**, from the one table in `budget.ts`, so a
 *     feature cannot size itself against the whole origin and starve the decks.
 *
 * `persistence/no-silent-writes.test.ts` fails the suite if a new `setItem`
 * appears anywhere outside this file, which is what stops the class coming back
 * (CLAUDE.md rule 10: ship the guard with the fix).
 *
 * ## What is NOT here
 *
 * Reads. A read that fails or finds a corrupt blob is usually a correct,
 * harmless degradation ("no history" instead of a crash) and forcing it through
 * a result type would add noise without adding honesty. The one read where that
 * is NOT true — the saved decks — reports through this same registry from
 * `storage.ts`, because losing decks is never harmless.
 */
import {
  areaForKey,
  storageArea,
  writeBudgetChars,
  type StorageArea,
  type StorageAreaId,
} from './budget.js';
import {
  reportStorageNotice,
  severityOf,
  type StorageNoticeReason,
} from './failures.js';

/** The slice of the Web Storage API this module needs. */
export interface WritableStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** What a write did. Never `void` — that is the whole point of the module. */
export type StorageWriteResult =
  | { readonly ok: true; readonly chars: number }
  | { readonly ok: false; readonly reason: StorageNoticeReason; readonly chars: number };

/** Options a caller may need; all of them have safe defaults. */
export interface WriteOptions {
  /** Inject a storage for tests. `undefined` means "the browser's localStorage". */
  readonly storage?: WritableStorage | null;
  /**
   * Suppress the user-facing notice for this write.
   *
   * For writes whose failure genuinely costs the user nothing and which they can
   * do nothing about — a preference checkbox, a cache line that refetches. The
   * result is still returned, and the reason is still logged; only the banner is
   * skipped. Never pass this for anything the user authored.
   */
  readonly quiet?: boolean;
}

/** The browser's localStorage, or null where it is unavailable or blocked. */
export function browserLocalStorage(): WritableStorage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    // Some embedders throw on the ACCESSOR. That is "no storage", not a crash.
    return null;
  }
}

/** The browser's sessionStorage, or null. Separate quota from localStorage. */
export function browserSessionStorage(): WritableStorage | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * Names a browser uses when the origin is out of room.
 *
 * A table rather than a chain of `||`, so the next browser's spelling is a ROW.
 * `code` 22 is the DOM spec's `QUOTA_EXCEEDED_ERR`; 1014 is Firefox's legacy
 * `NS_ERROR_DOM_QUOTA_REACHED`.
 */
const QUOTA_ERROR_NAMES: readonly string[] = [
  'QuotaExceededError',
  'NS_ERROR_DOM_QUOTA_REACHED',
  'QUOTA_EXCEEDED_ERR',
];
const QUOTA_ERROR_CODES: readonly number[] = [22, 1014];

/**
 * Is this thrown value the browser saying "full"?
 *
 * Distinguished from any other failure because the two have different answers:
 * a full origin is something the user can act on from the storage readout, and
 * anything else is a bug they should not be asked to fix.
 */
export function isQuotaError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const e = error as { name?: unknown; code?: unknown };
  if (typeof e.name === 'string' && QUOTA_ERROR_NAMES.includes(e.name)) return true;
  return typeof e.code === 'number' && QUOTA_ERROR_CODES.includes(e.code);
}

function fail(
  area: StorageArea | null,
  areaId: StorageAreaId | 'unknown',
  reason: StorageNoticeReason,
  chars: number,
  quiet: boolean,
  detail?: string,
): StorageWriteResult {
  if (!quiet) {
    reportStorageNotice({
      areaId,
      label: area?.label ?? 'Some app data',
      reason,
      severity: severityOf(reason),
      chars,
      at: Date.now(),
      ...(detail === undefined ? {} : { detail }),
    });
  }
  // Still logged even when quiet: the console is for us, the banner is for the
  // user. Skipped entirely outside a browser, where "no storage" is the normal
  // condition of every Node test run rather than anything a developer wants to
  // read — a log line that fires thousands of times is a log line nobody reads.
  if (typeof globalThis.window !== 'undefined') {
    console.warn(`[storage] ${areaId}: write failed (${reason}), ${chars} chars`);
  }
  return { ok: false, reason, chars };
}

/**
 * Write one value, honestly.
 *
 * `areaId` is not derived from the key: passing it explicitly means a call site
 * that writes under the wrong key is caught by the mismatch check below instead
 * of silently borrowing another feature's budget.
 */
export function writeStorage(
  areaId: StorageAreaId,
  key: string,
  value: string,
  options: WriteOptions = {},
): StorageWriteResult {
  const quiet = options.quiet === true;
  const chars = value.length;
  const keyArea = areaForKey(key);

  if (keyArea === null || keyArea.id !== areaId) {
    // A key nothing claims, or one claimed by a DIFFERENT row. Either way the
    // budget cannot be trusted for this write, and saying so is the only honest
    // move — a closed table reports the miss instead of widening to fit it.
    return fail(keyArea, areaId, 'unbudgeted-key', chars, quiet, `key "${key}"`);
  }

  const storage =
    options.storage !== undefined
      ? options.storage
      : keyArea.scope === 'session'
        ? browserSessionStorage()
        : browserLocalStorage();
  if (!storage) return fail(keyArea, areaId, 'unavailable', chars, quiet);

  const budget = writeBudgetChars(areaId);
  if (chars > budget) {
    return fail(keyArea, areaId, 'over-budget', chars, quiet, `budget ${budget} characters`);
  }

  try {
    storage.setItem(key, value);
    return { ok: true, chars };
  } catch (error) {
    return fail(keyArea, areaId, isQuotaError(error) ? 'quota' : 'refused', chars, quiet);
  }
}

/**
 * Remove one value.
 *
 * A failed remove is genuinely harmless — every reader validates what it finds,
 * so a key that refused to disappear is re-read and re-rejected — and there is
 * nothing the user could do about it. It returns a boolean rather than nothing
 * so a caller that DOES care (a "clear this to make room" button) can tell.
 */
export function removeStorage(
  areaId: StorageAreaId,
  key: string,
  options: WriteOptions = {},
): boolean {
  const storage =
    options.storage !== undefined
      ? options.storage
      : storageArea(areaId)?.scope === 'session'
        ? browserSessionStorage()
        : browserLocalStorage();
  if (!storage) return false;
  try {
    storage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

/**
 * Report a degradation that is not a write failure — the game library shedding
 * old finished games to stay inside its budget, for instance.
 *
 * Lives here rather than being called straight into the registry so that every
 * "storage did something to your data" path is still one import away from the
 * funnel that owns them.
 */
export function reportStorageShed(areaId: StorageAreaId, detail: string): void {
  reportStorageNotice({
    areaId,
    label: storageLabel(areaId),
    reason: 'shed',
    severity: severityOf('shed'),
    chars: 0,
    at: Date.now(),
    detail,
  });
}

/** An area's label by id, without handing callers the whole row. */
export function storageLabel(areaId: StorageAreaId): string {
  return storageArea(areaId)?.label ?? 'Some app data';
}
