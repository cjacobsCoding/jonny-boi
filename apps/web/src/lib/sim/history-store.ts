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
 * Four rules it obeys, all of them the boring kind that matter later:
 *
 *  - **Keyed by the deck's CONTENT.** The storage key carries the sim's own
 *    `deckFingerprint`, so tuning two decks (or the same deck before and after a
 *    swap) keeps two independent records instead of one polluted one.
 *  - **Keyed by the PILOT too — see below.**
 *  - **Validated on the way in, not trusted.** A record whose `version`,
 *    `deckFingerprint` or `pilotId` does not match is REJECTED with a reason the
 *    UI shows. Silently reusing evidence gathered under different conditions would
 *    steer a search with numbers that no longer mean anything.
 *  - **Never fatal.** Unavailable storage (private browsing, a quota, a corrupt
 *    entry) degrades to "no history" with a reason. A tuning record is a nice
 *    optimisation, never a prerequisite for running the Lab.
 *
 * ## Why the pilot partitions the record, and why nothing is deleted
 *
 * The record is not a cache of results — it is **accumulated evidence that steers
 * the next search**, and two fields make pooling across pilots statistically
 * invalid rather than merely untidy:
 *
 *  1. `candidates[].settled` / `provenNotBetter` retire a swap from future runs.
 *     "Not better" is a claim about a level of play: the hybrid pilot moved
 *     Mono-Red Aggro's gauntlet win rate from 32.9% to 19.0% by blocking better,
 *     and a card whose value is punishing bad blocks is settled-as-useless under
 *     one pilot and a real improvement under another. A pooled record would hide
 *     the candidate that a pilot change had just made good.
 *  2. `candidates.length` is the **Holm–Bonferroni family size** — the correction
 *     covers every candidate ever tested on this deck. Pooling two pilots' runs
 *     into one family both inflates the family (making every verdict more
 *     conservative than the evidence warrants) and, worse, mixes tests of two
 *     different hypotheses into one correction. The correction would no longer
 *     control the error rate of anything a user could name.
 *
 * So the pilot is part of the **storage key**, and each pilot keeps its own record
 * side by side. **Nothing is discarded**: switching the picker to `hybrid` starts a
 * fresh search under `hybrid` and leaves the `heuristic` search exactly where it
 * was, ready to be resumed by switching back. Invalidating on change was the other
 * candidate design and was rejected — a user's accumulated evidence can represent
 * hours of compute, and "you changed a dropdown, so your afternoon is gone" is not
 * a trade this app gets to make on their behalf.
 *
 * Records written before the pilot was selectable carry no pilot. They were all
 * produced by `DEFAULT_PILOT_ID` — there was no way to run anything else — so they
 * are ADOPTED into that pilot's slot on first read rather than dropped.
 */
import {
  SUGGESTION_HISTORY_VERSION,
  deckFingerprint,
  type Deck,
  type SuggestionHistory,
} from '@jonny-boi/sim';
import { SELECTABLE_PILOT_IDS } from '@jonny-boi/ai';
import { DEFAULT_PILOT_ID } from './pilots.js';

/** Namespace for every stored tuning record. The pilot + fingerprint follow it. */
export const SUGGESTION_HISTORY_KEY_PREFIX = 'jonny-boi.suggest-history';

/** The storage key for one deck's record under one pilot. */
export function suggestionHistoryKey(fingerprint: string, pilotId: string): string {
  return `${SUGGESTION_HISTORY_KEY_PREFIX}.v${SUGGESTION_HISTORY_VERSION}.${pilotId}.${fingerprint}`;
}

/**
 * The key used before records were partitioned by pilot. Read (and migrated) once,
 * never written. Everything filed under it was played by {@link DEFAULT_PILOT_ID}.
 */
export function legacySuggestionHistoryKey(fingerprint: string): string {
  return `${SUGGESTION_HISTORY_KEY_PREFIX}.v${SUGGESTION_HISTORY_VERSION}.${fingerprint}`;
}

/**
 * Why a stored record was not used. `'version'` and `'deck-changed'` are the
 * sim's own rejection reasons; `'pilot-changed'` and `'unreadable'` are this
 * layer's (a record filed under one pilot found while another is selected, or
 * storage refused / the entry was not the JSON we wrote).
 */
export type StoredHistoryRejection = 'version' | 'deck-changed' | 'pilot-changed' | 'unreadable';

/** What `readSuggestionHistory` found — at most one of the two fields is set. */
export interface StoredHistory {
  /** The record to hand to the next run, when one applies. */
  readonly history?: SuggestionHistory;
  /** Why a stored record was ignored. Absent when there simply wasn't one. */
  readonly rejected?: StoredHistoryRejection;
}

/**
 * What is stored under one key: the sim's record plus the pilot that produced it.
 *
 * The pilot is in the VALUE as well as the key for the same reason the deck
 * fingerprint is — a key can be mis-derived by a future refactor, and a record
 * that carries its own provenance can say "this is not mine" instead of being
 * quietly adopted. `SuggestionHistory` is `@jonny-boi/sim`'s type and this branch
 * does not own that package, so the pilot rides in an envelope around it rather
 * than as a field inside it.
 */
export interface StoredHistoryRecord {
  readonly pilotId: string;
  readonly history: SuggestionHistory;
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
 * Read the record stored for `deck` under `pilotId`, validating it before handing
 * it back.
 *
 * A mismatched fingerprint or pilot is possible even though the key contains both:
 * a user can import a record, or a future version can change how keys are derived.
 * Checking the record's own fields as well as the key costs nothing and is the
 * difference between "rejected, here is why" and "silently wrong".
 */
export function readSuggestionHistory(
  deck: Deck,
  pilotId: string,
  storage: HistoryStorage | null = browserHistoryStorage(),
): StoredHistory {
  if (!storage) return {};
  const fingerprint = deckFingerprint(deck);

  const raw = readRaw(storage, suggestionHistoryKey(fingerprint, pilotId));
  if (raw.failed) return { rejected: 'unreadable' };
  if (raw.value === null) return adoptLegacy(storage, fingerprint, pilotId);

  const stored = parseRecord(raw.value);
  if (!stored) return { rejected: 'unreadable' };
  if (stored.pilotId !== pilotId) return { rejected: 'pilot-changed' };
  return validate(stored.history, fingerprint);
}

/**
 * Persist the record a finished run returned. Keyed by the record's OWN
 * fingerprint and the pilot that played it, so a record can only ever be filed
 * under the deck AND the level of play it describes.
 */
export function writeSuggestionHistory(
  history: SuggestionHistory,
  pilotId: string,
  storage: HistoryStorage | null = browserHistoryStorage(),
): void {
  if (!storage) return;
  writeRecord(storage, { pilotId, history });
}

/** Store one envelope; `false` when storage refused (quota, private browsing). */
function writeRecord(storage: HistoryStorage, record: StoredHistoryRecord): boolean {
  try {
    storage.setItem(
      suggestionHistoryKey(record.history.deckFingerprint, record.pilotId),
      JSON.stringify(record),
    );
    return true;
  } catch (error) {
    // A quota failure loses the memory of one run, not the run's result.
    console.warn('Could not save the tuning history for this deck.', error);
    return false;
  }
}

/**
 * Forget what THIS pilot learned about `deck` — the UI's "start over" button.
 *
 * Scoped to one pilot on purpose: the button sits next to a banner describing this
 * pilot's search, so it must not silently take another pilot's evidence with it.
 * The pre-partition record is cleared alongside the default pilot's, since that is
 * the slot it would otherwise be adopted into on the next read.
 */
export function clearSuggestionHistory(
  deck: Deck,
  pilotId: string,
  storage: HistoryStorage | null = browserHistoryStorage(),
): void {
  if (!storage) return;
  const fingerprint = deckFingerprint(deck);
  try {
    storage.removeItem(suggestionHistoryKey(fingerprint, pilotId));
    if (pilotId === DEFAULT_PILOT_ID) storage.removeItem(legacySuggestionHistoryKey(fingerprint));
  } catch (error) {
    console.warn('Could not clear the tuning history for this deck.', error);
  }
}

/** A saved search belonging to some OTHER pilot, summarised for the UI. */
export interface OtherPilotHistory {
  readonly pilotId: string;
  readonly runsCompleted: number;
  readonly candidateCount: number;
}

/**
 * The searches this deck has saved under pilots OTHER than `pilotId`.
 *
 * This exists so the UI can PROVE the partition is not a deletion: switching the
 * picker shows "your Heuristic search (3 runs, 26 candidates) is still there".
 * Without it, a partition is indistinguishable from losing the record, and a user
 * who believes they lost it will hit Reset and actually lose it.
 *
 * Probes the known pilot ids rather than enumerating storage, because
 * {@link HistoryStorage} is deliberately the three-method subset that a test can
 * fake — and because a fixed, short probe list cannot wander into another app's
 * keys.
 */
export function otherPilotHistories(
  deck: Deck,
  pilotId: string,
  storage: HistoryStorage | null = browserHistoryStorage(),
): readonly OtherPilotHistory[] {
  if (!storage) return [];
  const fingerprint = deckFingerprint(deck);
  const found: OtherPilotHistory[] = [];
  for (const other of SELECTABLE_PILOT_IDS) {
    if (other === pilotId) continue;
    const raw = readRaw(storage, suggestionHistoryKey(fingerprint, other));
    const stored = raw.value === null ? null : parseRecord(raw.value);
    const history =
      stored && stored.pilotId === other ? validate(stored.history, fingerprint).history : undefined;
    if (!history || history.runsCompleted === 0) continue;
    found.push({
      pilotId: other,
      runsCompleted: history.runsCompleted,
      candidateCount: history.candidates.length,
    });
  }
  return found;
}

/** A human sentence for why a stored record was not used. */
export function historyRejectionText(reason: StoredHistoryRejection): string {
  switch (reason) {
    case 'deck-changed':
      return 'the saved search was gathered on a different decklist, so it was discarded — a swap’s measured effect belongs to the deck it was measured in';
    case 'pilot-changed':
      return 'the saved search was gathered with a different AI pilot, so it was set aside — a swap’s measured effect belongs to the level of play it was measured at';
    case 'version':
      return 'the saved search was written by an older version of the engine and was discarded';
    case 'unreadable':
      return 'the saved search could not be read and was discarded';
  }
}

// --- internals -----------------------------------------------------------------

/** `getItem`, distinguishing "storage refused" from "nothing stored". */
function readRaw(
  storage: HistoryStorage,
  key: string,
): { readonly value: string | null; readonly failed: boolean } {
  try {
    return { value: storage.getItem(key), failed: false };
  } catch {
    return { value: null, failed: true };
  }
}

/** Parse a stored envelope, or `null` if it is not the JSON this module writes. */
function parseRecord(raw: string): StoredHistoryRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  if (typeof record.pilotId !== 'string') return null;
  if (!isHistoryLike(record.history)) return null;
  return { pilotId: record.pilotId, history: record.history };
}

/** The sim's own acceptance rules, applied before a record leaves this module. */
function validate(history: SuggestionHistory, fingerprint: string): StoredHistory {
  if (history.version !== SUGGESTION_HISTORY_VERSION) return { rejected: 'version' };
  if (history.deckFingerprint !== fingerprint) return { rejected: 'deck-changed' };
  return { history };
}

/**
 * Take over a pre-partition record for the default pilot, moving it under the new
 * key so this only ever happens once. A migration that fails to WRITE still
 * returns the record: the user keeps their evidence and simply pays the migration
 * again next time, which is strictly better than dropping it because storage was
 * momentarily full.
 */
function adoptLegacy(
  storage: HistoryStorage,
  fingerprint: string,
  pilotId: string,
): StoredHistory {
  if (pilotId !== DEFAULT_PILOT_ID) return {};
  const raw = readRaw(storage, legacySuggestionHistoryKey(fingerprint));
  if (raw.failed) return { rejected: 'unreadable' };
  if (raw.value === null) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.value);
  } catch {
    return { rejected: 'unreadable' };
  }
  if (!isHistoryLike(parsed)) return { rejected: 'unreadable' };

  const accepted = validate(parsed, fingerprint);
  // Only forget the old key once the new one definitely holds the record. A
  // migration is the one moment where a storage failure could destroy evidence
  // rather than merely fail to add to it.
  const rehomed = accepted.history
    ? writeRecord(storage, { pilotId, history: accepted.history })
    : true;
  if (rehomed) {
    try {
      storage.removeItem(legacySuggestionHistoryKey(fingerprint));
    } catch {
      // Leaving the old key behind is harmless: the new key now wins every read.
    }
  }
  return accepted;
}

/** Structural check that a parsed value is the sim's record shape. */
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
