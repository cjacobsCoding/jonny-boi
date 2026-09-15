/**
 * THE PERSISTENCE NOTICE REGISTRY — where a failed or degraded write goes so a
 * human finds out.
 *
 * A fallback that fires silently is how a broken pipeline looks healthy for a
 * week. The deck-loss bug was exactly that: `saveDecks` caught its quota error,
 * wrote a `console.warn` nobody was reading, and the deck lived on in React
 * state until the page reloaded. It LOOKED saved for the whole session.
 *
 * So reporting is not left to call sites. `writeStorage` publishes here on
 * every non-OK result, the app shell subscribes once, and a write path added
 * next year is visible to the user without its author having to remember to
 * wire up a banner. The registry knows nothing about React — it is a plain
 * subscribable store, so it is unit-testable in Node and usable from
 * `useSyncExternalStore` without an adapter.
 */
import type { StorageAreaId } from './budget.js';

/**
 * Why a write did not land, or landed only partly. Closed (rule 2): a new cause
 * adds a member here and a sentence in `describeNotice`, rather than a free
 * string that no UI knows how to phrase.
 */
export type StorageNoticeReason =
  /** The browser refused: quota exhausted. The origin is full. */
  | 'quota'
  /** No Web Storage at all — private mode, or an embedder that blocks it. */
  | 'unavailable'
  /** The payload exceeded this area's share of the budget. Never attempted. */
  | 'over-budget'
  /** `setItem` threw something that is not a recognised quota error. */
  | 'refused'
  /** The write reached the funnel under a key no budget row claims — a wiring bug. */
  | 'unbudgeted-key'
  /** The write landed, but only after older content in the area was dropped. */
  | 'shed';

/** How loudly the UI should say it. */
export type StorageNoticeSeverity = 'error' | 'notice';

/** One thing that happened to a write, kept until the user acknowledges it. */
export interface StorageNotice {
  readonly areaId: StorageAreaId | 'unknown';
  /** The area's human label, resolved at publish time so the UI needs no lookup. */
  readonly label: string;
  readonly reason: StorageNoticeReason;
  readonly severity: StorageNoticeSeverity;
  /** Characters the write was trying to store (0 when not applicable). */
  readonly chars: number;
  /** Epoch ms. */
  readonly at: number;
  /** Extra detail for the reason, e.g. how many library entries were dropped. */
  readonly detail?: string;
}

/** `shed` is a degradation the user should know about; the rest are failures. */
const SEVERITY_BY_REASON: Readonly<Record<StorageNoticeReason, StorageNoticeSeverity>> = {
  quota: 'error',
  unavailable: 'error',
  'over-budget': 'error',
  refused: 'error',
  'unbudgeted-key': 'error',
  shed: 'notice',
};

/** The severity this reason carries. Exported so the funnel never invents one. */
export function severityOf(reason: StorageNoticeReason): StorageNoticeSeverity {
  return SEVERITY_BY_REASON[reason];
}

/**
 * One line per reason, in the user's words, with what it actually costs them.
 *
 * Written to be read by someone who has just lost two decks: it says what did
 * not save, and never implies that something gone can be brought back.
 */
export function describeNotice(notice: StorageNotice): string {
  switch (notice.reason) {
    case 'quota':
      return `${notice.label} could not be saved — this browser's storage for jonny-boi is full. Anything you changed since the last successful save will be gone when you reload.`;
    case 'unavailable':
      return `${notice.label} could not be saved — this browser is not allowing jonny-boi to store anything (private browsing blocks it). Nothing will survive a reload.`;
    case 'over-budget':
      return `${notice.label} is too large to store (${notice.chars.toLocaleString()} characters). It was not saved, and will be gone when you reload.`;
    case 'refused':
      return `${notice.label} could not be saved — the browser refused the write. It will be gone when you reload.`;
    case 'unbudgeted-key':
      return `${notice.label} was written to storage that has no budget entry, so its size is not being tracked. This is a bug in jonny-boi, not something you did.`;
    case 'shed':
      return `${notice.label} filled its share of storage, so the oldest entries were dropped to make room${notice.detail ? ` (${notice.detail})` : ''}.`;
  }
}

/**
 * Notices are keyed by area+reason so a debounced save that fails sixty times
 * in a row is one banner, not sixty. The newest occurrence wins, which keeps
 * `chars` and `at` describing the most recent attempt.
 */
function noticeKey(notice: StorageNotice): string {
  return `${notice.areaId}:${notice.reason}`;
}

let notices: readonly StorageNotice[] = [];
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/** Record a notice. Called by the write funnel; call sites do not call this. */
export function reportStorageNotice(notice: StorageNotice): void {
  const key = noticeKey(notice);
  notices = [...notices.filter((n) => noticeKey(n) !== key), notice];
  emit();
}

/**
 * The current notices, newest last. Identity-stable between changes, which is
 * what `useSyncExternalStore` requires to avoid an infinite render loop.
 */
export function storageNotices(): readonly StorageNotice[] {
  return notices;
}

/** Subscribe to changes; returns the unsubscribe. */
export function subscribeToStorageNotices(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/** The user has read it. Clears one area+reason pair. */
export function dismissStorageNotice(areaId: string, reason: StorageNoticeReason): void {
  const key = `${areaId}:${reason}`;
  const next = notices.filter((n) => noticeKey(n) !== key);
  if (next.length === notices.length) return;
  notices = next;
  emit();
}

/** Clear everything — used by tests and by "I have made room, try again". */
export function clearStorageNotices(): void {
  if (notices.length === 0) return;
  notices = [];
  emit();
}
