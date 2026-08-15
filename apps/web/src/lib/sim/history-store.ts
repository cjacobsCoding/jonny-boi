/**
 * **The Lab's memory of a deck's tuning runs**, kept in `localStorage`.
 *
 * The suggestion engine is deliberately storage-free: a run RETURNS its record as
 * plain JSON and the caller hands it back next time. Without a caller that keeps
 * it, the engine has amnesia and re-derives the same shortlist every run — which
 * is exactly what the user hit: *"I ran it again, hoping it would find a better
 * card, and it just started comparing to Eternal Witness AGAIN."* This module is
 * the missing caller for the web app.
 *
 * Three rules it obeys, all of them the boring kind that matter later:
 *
 *  - **Keyed by the deck's CONTENT.** The storage key carries the sim's own
 *    `deckFingerprint`, so tuning two decks (or the same deck before and after a
 *    swap) keeps two independent records instead of one polluted one.
 *  - **Validated on the way in, not trusted.** A record whose `version` or
 *    `deckFingerprint` does not match is REJECTED with a reason the UI shows.
 *    Silently reusing evidence gathered on a different decklist would steer a
 *    search with numbers that no longer mean anything — a swap's measured effect
 *    is a property of the deck it was measured in.
 *  - **Never fatal.** Unavailable storage (private browsing, a quota, a corrupt
 *    entry) degrades to "no history" with a reason. A tuning record is a nice
 *    optimisation, never a prerequisite for running the Lab.
 */
import {
  SUGGESTION_HISTORY_VERSION,
  deckFingerprint,
  type Deck,
  type SuggestionHistory,
} from '@jonny-boi/sim';

/** Namespace for every stored tuning record. The fingerprint follows it. */
export const SUGGESTION_HISTORY_KEY_PREFIX = 'jonny-boi.suggest-history';

/** The storage key for one deck's record. */
export function suggestionHistoryKey(fingerprint: string): string {
  return `${SUGGESTION_HISTORY_KEY_PREFIX}.v${SUGGESTION_HISTORY_VERSION}.${fingerprint}`;
}

/**
 * Why a stored record was not used. `'version'` and `'deck-changed'` are the
 * sim's own rejection reasons; `'unreadable'` is this layer's (storage refused, or
 * the entry was not the JSON we wrote).
 */
export type StoredHistoryRejection = 'version' | 'deck-changed' | 'unreadable';

/** What `readSuggestionHistory` found — at most one of the two fields is set. */
export interface StoredHistory {
  /** The record to hand to the next run, when one applies. */
  readonly history?: SuggestionHistory;
  /** Why a stored record was ignored. Absent when there simply wasn't one. */
  readonly rejected?: StoredHistoryRejection;
}

/**
 * The storage this module reads and writes. Injected so the tests can drive every
 * failure mode — a full quota, a corrupt entry, storage that throws outright —
 * none of which a real `localStorage` will do on cue.
 */
export type HistoryStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** The browser's `localStorage`, or `null` where it is unavailable. */
export function browserHistoryStorage(): HistoryStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    // Some embedders throw on merely TOUCHING localStorage (blocked cookies).
    return null;
  }
}

/**
 * Read the record stored for `deck`, validating it before handing it back.
 *
 * A mismatched fingerprint is possible even though the key contains one: a user
 * can import a record, or a future version can change how fingerprints are
 * computed. Checking the record's own field as well as the key costs nothing and
 * is the difference between "rejected, here is why" and "silently wrong".
 */
export function readSuggestionHistory(
  deck: Deck,
  storage: HistoryStorage | null = browserHistoryStorage(),
): StoredHistory {
  if (!storage) return {};
  const fingerprint = deckFingerprint(deck);
  let raw: string | null;
  try {
    raw = storage.getItem(suggestionHistoryKey(fingerprint));
  } catch {
    return { rejected: 'unreadable' };
  }
  if (raw === null) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { rejected: 'unreadable' };
  }
  if (!isHistoryLike(parsed)) return { rejected: 'unreadable' };
  if (parsed.version !== SUGGESTION_HISTORY_VERSION) return { rejected: 'version' };
  if (parsed.deckFingerprint !== fingerprint) return { rejected: 'deck-changed' };
  return { history: parsed };
}

/**
 * Persist the record a finished run returned. Keyed by the record's OWN
 * fingerprint, so a record can only ever be filed under the deck it describes.
 */
export function writeSuggestionHistory(
  history: SuggestionHistory,
  storage: HistoryStorage | null = browserHistoryStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(suggestionHistoryKey(history.deckFingerprint), JSON.stringify(history));
  } catch (error) {
    // A quota failure loses the memory of one run, not the run's result.
    console.warn('Could not save the tuning history for this deck.', error);
  }
}

/** Forget everything learned about `deck` — the UI's "start over" button. */
export function clearSuggestionHistory(
  deck: Deck,
  storage: HistoryStorage | null = browserHistoryStorage(),
): void {
  if (!storage) return;
  try {
    storage.removeItem(suggestionHistoryKey(deckFingerprint(deck)));
  } catch (error) {
    console.warn('Could not clear the tuning history for this deck.', error);
  }
}

/** Structural check that a parsed value is the record shape we wrote. */
function isHistoryLike(value: unknown): value is SuggestionHistory {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.version === 'number' &&
    typeof record.deckFingerprint === 'string' &&
    typeof record.runsCompleted === 'number' &&
    Array.isArray(record.candidates)
  );
}

/** A human sentence for why a stored record was not used. */
export function historyRejectionText(reason: StoredHistoryRejection): string {
  switch (reason) {
    case 'deck-changed':
      return 'the saved search was gathered on a different decklist, so it was discarded — a swap’s measured effect belongs to the deck it was measured in';
    case 'version':
      return 'the saved search was written by an older version of the engine and was discarded';
    case 'unreadable':
      return 'the saved search could not be read and was discarded';
  }
}
