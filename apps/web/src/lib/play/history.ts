/**
 * THE GAME LIBRARY — every game played, kept, reviewable, and forkable.
 *
 * §3.58 taught the app to save ONE game in progress. This is the same idea with
 * the "one" removed: every game gets an entry, finished games stay for review,
 * and any entry can be replayed to a point and PLAYED ON FROM THERE.
 *
 * ## Why an entry wraps a `PlayRecord` rather than replacing it
 * A `PlayRecord` is already the exact, complete input to a game — resolved
 * decklists, base seed, starting player, the mulligan transcript, and the
 * accepted-action script — and `rebuildFromRecord` already replays one back to
 * a live session. A history entry therefore adds only what a LIBRARY needs and
 * a single save slot did not: identity, outcome, and lineage. One record shape,
 * one replay path, no second codec to drift from the first.
 *
 * ## What a fork actually is
 * Nothing but this record with its action log cut short. The engine is
 * deterministic in (seed, decklists, actions), so "play on from turn 6" is
 * literally the same setup with `actions.slice(0, k)` — which is why a fork
 * SHARES ITS PARENT'S SEED as a matter of construction rather than as a feature
 * that had to be built. Two forks of one game are the same shuffle explored two
 * ways, and that is the whole point of forking in a deck-tuning lab.
 *
 * ## Storage discipline (inherited from §3.58)
 * Best-effort in both directions: quota, private mode, corrupt or alien blobs
 * all degrade to "no history" rather than a crash, and a payload too big to
 * decode is never written in the first place. History is a convenience; losing
 * it must never cost you the game you are playing.
 */
import type { PlayRecord } from './persist.js';
import { decodeRecord, encodeRecord, type PlayStorage } from './persist.js';
import { PLAY_HISTORY_STORAGE_KEY, PLAY_HISTORY_LIMIT, PLAY_HISTORY_MAX_CHARS } from '../config.js';

/** Schema version for the library as a whole (entries carry the record's own). */
export const HISTORY_VERSION = 1;

/** How a game ended, as the library remembers it. */
export type HistoryOutcome =
  | { readonly kind: 'unfinished' }
  | { readonly kind: 'win'; readonly winner: 'A' | 'B'; readonly reason: string }
  | { readonly kind: 'draw'; readonly reason: string };

/** One game in the library. */
export interface HistoryEntry {
  /** Stable identity, minted once and never reused (forks get their own). */
  readonly id: string;
  /** The game's complete inputs — see `PlayRecord`. */
  readonly record: PlayRecord;
  readonly outcome: HistoryOutcome;
  /** Epoch ms the entry was first created. */
  readonly createdAt: number;
  /** Epoch ms of the most recent save. */
  readonly updatedAt: number;
  /**
   * The entry this one was forked from, if any. Together with `forkedAt` this
   * is the whole lineage graph — a parent pointer per node, nothing else.
   */
  readonly parentId?: string;
  /**
   * How many of the parent's actions this fork inherited: the point on the
   * parent's timeline where the two playthroughs diverge.
   */
  readonly forkedAt?: number;
}

/** True when this game can still be played on. */
export function isUnfinished(entry: HistoryEntry): boolean {
  return entry.outcome.kind === 'unfinished';
}

// --- codec -----------------------------------------------------------------------

interface StoredHistory {
  readonly version: number;
  readonly entries: readonly HistoryEntry[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isOutcome(value: unknown): value is HistoryOutcome {
  if (!isObject(value)) return false;
  if (value.kind === 'unfinished') return true;
  if (value.kind === 'draw') return typeof value.reason === 'string';
  if (value.kind === 'win') return (value.winner === 'A' || value.winner === 'B') && typeof value.reason === 'string';
  return false;
}

/**
 * Validate one entry. The nested `PlayRecord` is validated by the SAME decoder
 * the single-slot save uses — re-implementing that check here is exactly how the
 * two would eventually disagree about what a valid record is.
 */
function decodeEntry(value: unknown): HistoryEntry | null {
  if (!isObject(value)) return null;
  if (typeof value.id !== 'string' || value.id === '') return null;
  if (typeof value.createdAt !== 'number' || typeof value.updatedAt !== 'number') return null;
  if (!isOutcome(value.outcome)) return null;
  if (value.parentId !== undefined && typeof value.parentId !== 'string') return null;
  if (value.forkedAt !== undefined && typeof value.forkedAt !== 'number') return null;
  const record = decodeRecord(JSON.stringify(value.record));
  if (record === null) return null;
  const entry: HistoryEntry = {
    id: value.id,
    record,
    outcome: value.outcome,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    ...(typeof value.parentId === 'string' ? { parentId: value.parentId } : {}),
    ...(typeof value.forkedAt === 'number' ? { forkedAt: value.forkedAt } : {}),
  };
  return entry;
}

/** Serialize the library. */
export function encodeHistory(entries: readonly HistoryEntry[]): string {
  const stored: StoredHistory = { version: HISTORY_VERSION, entries };
  return JSON.stringify(stored);
}

/**
 * Parse the library, dropping any entry that does not validate rather than
 * failing the whole read. One corrupt game must not cost you the other forty —
 * the opposite trade from the single save slot, where a bad record means there
 * is no game to resume and failing whole is the honest answer.
 */
export function decodeHistory(raw: string): readonly HistoryEntry[] {
  if (raw.length > PLAY_HISTORY_MAX_CHARS) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!isObject(parsed) || parsed.version !== HISTORY_VERSION) return [];
  if (!Array.isArray(parsed.entries)) return [];
  const out: HistoryEntry[] = [];
  for (const candidate of parsed.entries) {
    const entry = decodeEntry(candidate);
    if (entry) out.push(entry);
  }
  return out;
}

// --- pure list operations ----------------------------------------------------------

/** Newest first — the order the library is read in. */
export function sortByRecency(entries: readonly HistoryEntry[]): readonly HistoryEntry[] {
  return [...entries].sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * Add or replace an entry, keeping the library newest-first and within its cap.
 *
 * ⚠️ Pruning never drops an UNFINISHED game. The cap exists to stop a browser
 * quota filling with old finished games; a game you could still return to is
 * the one thing the library must not decide to forget for you.
 */
export function upsertEntry(
  entries: readonly HistoryEntry[],
  entry: HistoryEntry,
  limit: number = PLAY_HISTORY_LIMIT,
): readonly HistoryEntry[] {
  const without = entries.filter((e) => e.id !== entry.id);
  const merged = sortByRecency([entry, ...without]);
  if (merged.length <= limit) return merged;
  const keep: HistoryEntry[] = [];
  const finished: HistoryEntry[] = [];
  for (const candidate of merged) {
    if (isUnfinished(candidate)) keep.push(candidate);
    else finished.push(candidate);
  }
  const room = Math.max(0, limit - keep.length);
  return sortByRecency([...keep, ...finished.slice(0, room)]);
}

/** Remove one game. */
export function deleteEntry(entries: readonly HistoryEntry[], id: string): readonly HistoryEntry[] {
  return entries.filter((e) => e.id !== id);
}

/** Look one up. */
export function findEntry(entries: readonly HistoryEntry[], id: string): HistoryEntry | null {
  return entries.find((e) => e.id === id) ?? null;
}

// --- lineage -----------------------------------------------------------------------

/**
 * Walk parent pointers to the original playthrough. Tolerates a missing parent
 * (its entry was deleted) and a cycle (corrupt data) by stopping — a lineage
 * walk must not be able to hang the UI that draws it.
 */
export function rootOf(entries: readonly HistoryEntry[], id: string): string {
  const seen = new Set<string>([id]);
  let current = findEntry(entries, id);
  while (current?.parentId) {
    const parent = findEntry(entries, current.parentId);
    if (!parent || seen.has(parent.id)) break;
    seen.add(parent.id);
    current = parent;
  }
  return current?.id ?? id;
}

/**
 * Every entry sharing a root, oldest first — one playthrough and all of its
 * forks, which is the group the UI draws as connected.
 */
export function lineageOf(entries: readonly HistoryEntry[], id: string): readonly HistoryEntry[] {
  const root = rootOf(entries, id);
  return entries
    .filter((e) => rootOf(entries, e.id) === root)
    .sort((a, b) => a.createdAt - b.createdAt);
}

/** The direct forks of one entry, oldest first. */
export function childrenOf(entries: readonly HistoryEntry[], id: string): readonly HistoryEntry[] {
  return entries.filter((e) => e.parentId === id).sort((a, b) => a.createdAt - b.createdAt);
}

// --- forking -----------------------------------------------------------------------

/**
 * Build the fork: the parent's setup with its action log cut at `atAction`.
 *
 * The seed is not copied so much as UNTOUCHED — the setup is the parent's, so
 * the shuffle, the opening hands and every draw are identical up to the point
 * of divergence. That is the property that makes a fork worth having: what
 * changed is the decision, not the luck.
 *
 * `atAction` is clamped into range, so a scrubber that hands over an index from
 * a stale render forks at a real point instead of throwing.
 */
export function forkEntry(
  parent: HistoryEntry,
  atAction: number,
  id: string,
  now: number = Date.now(),
): HistoryEntry {
  const cut = Math.max(0, Math.min(Math.floor(atAction), parent.record.actions.length));
  return {
    id,
    record: { ...parent.record, savedAt: now, actions: parent.record.actions.slice(0, cut) },
    // A fork always starts unfinished: it exists to be played on.
    outcome: { kind: 'unfinished' },
    createdAt: now,
    updatedAt: now,
    parentId: parent.id,
    forkedAt: cut,
  };
}

// --- storage -----------------------------------------------------------------------

function defaultStorage(): PlayStorage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** Read the library. Never throws; unreadable storage reads as empty. */
export function readHistory(storage: PlayStorage | null = defaultStorage()): readonly HistoryEntry[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(PLAY_HISTORY_STORAGE_KEY);
    return raw === null ? [] : decodeHistory(raw);
  } catch {
    return [];
  }
}

/**
 * Write the library. Best-effort, and never writes what {@link decodeHistory}
 * would refuse: if the payload is over the cap, the OLDEST FINISHED games are
 * dropped until it fits, so a long history degrades by forgetting old finished
 * games rather than by silently saving nothing.
 */
export function writeHistory(
  entries: readonly HistoryEntry[],
  storage: PlayStorage | null = defaultStorage(),
): void {
  if (!storage) return;
  let candidate = sortByRecency(entries);
  try {
    while (candidate.length > 0 && encodeHistory(candidate).length > PLAY_HISTORY_MAX_CHARS) {
      const oldestFinished = [...candidate].reverse().find((e) => !isUnfinished(e));
      if (!oldestFinished) break;
      candidate = deleteEntry(candidate, oldestFinished.id);
    }
    const encoded = encodeHistory(candidate);
    if (encoded.length > PLAY_HISTORY_MAX_CHARS) return;
    storage.setItem(PLAY_HISTORY_STORAGE_KEY, encoded);
  } catch {
    // Quota / privacy mode: the library is a convenience, the game is not.
  }
}

/** Read, apply a pure change, write back. The one funnel every mutation uses. */
export function updateHistory(
  change: (entries: readonly HistoryEntry[]) => readonly HistoryEntry[],
  storage: PlayStorage | null = defaultStorage(),
): readonly HistoryEntry[] {
  const next = change(readHistory(storage));
  writeHistory(next, storage);
  return next;
}

/** Encoding helper kept next to its readers so the two cannot drift. */
export { encodeRecord };
