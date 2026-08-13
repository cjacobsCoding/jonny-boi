/**
 * React state for the deck importer: text in, a reviewed plan out.
 *
 * The hook owns only orchestration and UI state — all the real work lives in the
 * pure modules it calls (`parse` → `resolve` → `buildDeck`), so the logic is
 * unit-tested without React and this file stays boring on purpose.
 */

import { useCallback, useRef, useState } from 'react';
import { fromExport } from '../deck.js';
import type { Deck } from '../deck.js';
import type { CollectionProgress, FetchLike } from '../scryfall/collection.js';
import { parseDeckText, type DeckParseResult } from './parse.js';
import { resolveDecklist, type ImportPlan } from './resolve.js';
import { buildDeckFromPlan, type BuildResult } from './buildDeck.js';
import { fetchDecklistFromUrl, looksLikeUrl, type UrlFetchLike } from './sources.js';

/** Where the import flow currently is. */
export type ImportPhase = 'idle' | 'fetching' | 'review' | 'error';

/** The importer's state + actions. */
export interface DeckImportApi {
  readonly phase: ImportPhase;
  /** Parse-time diagnostics for the pasted text (bad lines). */
  readonly parsed: DeckParseResult | null;
  /** The resolved plan, once cards have been looked up. */
  readonly plan: ImportPlan | null;
  /** Scryfall lookup progress while `phase` is `'fetching'`. */
  readonly progress: CollectionProgress | null;
  /** A user-facing error message when `phase` is `'error'`. */
  readonly error: string | null;
  /** A link the user can open when we were not allowed to fetch a deck URL. */
  readonly manualUrl: string | null;
  /** Where the list came from, e.g. "Moxfield" (for the review header). */
  readonly sourceLabel: string | null;
  /** Resolve pasted text (a decklist, a deck URL, or exported deck JSON). */
  resolve: (input: string) => Promise<void>;
  /** Commit the reviewed plan to a deck. */
  commit: (name?: string) => BuildResult | null;
  /** A deck parsed directly from the app's own JSON export, if that's what was pasted. */
  readonly jsonDeck: Deck | null;
  reset: () => void;
}

/** Browser `fetch` adapted to the POST shape the collection client expects. */
const browserPostFetch: FetchLike = (url, init) =>
  fetch(url, { method: init.method, headers: init.headers, body: init.body });

/** Browser `fetch` adapted to the GET shape the URL importer expects. */
const browserGetFetch: UrlFetchLike = (url, init) => fetch(url, { headers: init.headers });

/**
 * Detect the app's own deck-export JSON so the legacy import path keeps working
 * from the same box — one place to paste anything deck-shaped.
 */
function tryParseDeckJson(input: string): Deck | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    return fromExport(JSON.parse(trimmed));
  } catch {
    return null;
  }
}

export function useDeckImport(
  fetchImpl: FetchLike = browserPostFetch,
  urlFetchImpl: UrlFetchLike = browserGetFetch,
): DeckImportApi {
  const [phase, setPhase] = useState<ImportPhase>('idle');
  const [parsed, setParsed] = useState<DeckParseResult | null>(null);
  const [plan, setPlan] = useState<ImportPlan | null>(null);
  const [progress, setProgress] = useState<CollectionProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [manualUrl, setManualUrl] = useState<string | null>(null);
  const [sourceLabel, setSourceLabel] = useState<string | null>(null);
  const [jsonDeck, setJsonDeck] = useState<Deck | null>(null);

  // Guards against a slow first request overwriting a newer one's results.
  const runId = useRef(0);

  const reset = useCallback(() => {
    runId.current += 1;
    setPhase('idle');
    setParsed(null);
    setPlan(null);
    setProgress(null);
    setError(null);
    setManualUrl(null);
    setSourceLabel(null);
    setJsonDeck(null);
  }, []);

  const resolve = useCallback(
    async (input: string): Promise<void> => {
      const run = ++runId.current;
      setError(null);
      setManualUrl(null);
      setJsonDeck(null);
      setPlan(null);
      setProgress(null);

      // 1. The app's own export JSON — no lookups needed.
      const asJson = tryParseDeckJson(input);
      if (asJson) {
        setJsonDeck(asJson);
        setSourceLabel('jonny-boi deck JSON');
        setPhase('review');
        return;
      }

      // 2. A deck URL — fetch the list, then treat it as pasted text.
      let text = input;
      let label: string | null = null;
      if (looksLikeUrl(input)) {
        setPhase('fetching');
        const result = await fetchDecklistFromUrl(input, urlFetchImpl);
        if (run !== runId.current) return;
        if (!result.ok) {
          setError(result.reason);
          setManualUrl(result.manualUrl ?? null);
          setPhase('error');
          return;
        }
        text = result.text;
        label = result.sourceLabel;
      }
      setSourceLabel(label);

      // 3. Parse, then look every card up.
      const parseResult = parseDeckText(text);
      setParsed(parseResult);
      if (parseResult.entries.length === 0) {
        setError(
          parseResult.errors.length > 0
            ? 'None of those lines looked like cards. Paste a decklist such as "4 Lightning Bolt".'
            : 'That looks empty — paste a decklist, a deck URL, or drop an exported file.',
        );
        setPhase('error');
        return;
      }

      setPhase('fetching');
      const resolved = await resolveDecklist(parseResult.entries, fetchImpl, {
        onProgress: (value) => {
          if (run === runId.current) setProgress(value);
        },
        ...(parseResult.deckName ? { deckName: parseResult.deckName } : {}),
      });
      if (run !== runId.current) return;

      setPlan(resolved);
      setPhase('review');
    },
    [fetchImpl, urlFetchImpl],
  );

  const commit = useCallback(
    (name?: string): BuildResult | null => {
      if (!plan) return null;
      return buildDeckFromPlan(plan, name);
    },
    [plan],
  );

  return {
    phase,
    parsed,
    plan,
    progress,
    error,
    manualUrl,
    sourceLabel,
    resolve,
    commit,
    jsonDeck,
    reset,
  };
}
