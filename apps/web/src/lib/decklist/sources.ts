/**
 * Deck-hosting sites: recognizing their URLs and pulling a decklist out.
 *
 * Paste a Moxfield/Archidekt/MTGGoldfish/TappedOut/Deckstats link and we go get
 * the list rather than making you export it by hand. Each site is DATA in
 * {@link DECK_SOURCES} — adding another is a table entry, not new code paths.
 *
 * A REALITY WE DESIGN AROUND: these are third-party sites, and whether a browser
 * may read them depends on CORS headers we do not control (Moxfield in
 * particular sits behind bot protection that rejects browser calls). So the
 * fetch path is best-effort and every failure resolves to a *specific, useful*
 * instruction — "open this export link and paste the text" with the exact URL —
 * rather than a dead end (DESIGN §1.6: graceful fallbacks, never a silent
 * crash). Pasting text always works, so import is never blocked by a site's
 * policy.
 */

/** How a source's response should be read. */
export type SourcePayloadKind = 'json' | 'text';

/** One supported deck-hosting site. */
export interface DeckSource {
  readonly id: string;
  /** Human-facing name, shown as "Imported from …". */
  readonly label: string;
  /** Hostnames (without `www.`) this source owns. */
  readonly hosts: readonly string[];
  /** Pull the deck id out of a page URL; `null` when the URL isn't a deck. */
  deckIdFrom(url: URL): string | null;
  /** The machine-readable endpoint for a deck id. */
  endpointFor(deckId: string): string;
  readonly payloadKind: SourcePayloadKind;
  /** Convert the fetched payload into decklist text the parser understands. */
  toDecklistText(payload: unknown): string;
  /**
   * A URL the user can open themselves to get copyable text, used in the
   * fallback message when the browser is not allowed to fetch the deck.
   */
  manualExportUrl(deckId: string): string;
}

/** Read `{ [key]: … }` safely off an unknown payload. */
function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

/** Render `qty name` lines from collected pairs. */
function toLines(entries: ReadonlyArray<{ qty: number; name: string }>): string {
  return entries
    .filter((entry) => entry.name.length > 0 && entry.qty > 0)
    .map((entry) => `${entry.qty} ${entry.name}`)
    .join('\n');
}

/**
 * Moxfield's deck payload keys each board by card id:
 *   `{ mainboard: { <id>: { quantity, card: { name } } }, sideboard: {…} }`
 */
function moxfieldToText(payload: unknown): string {
  const sections: Array<{ key: string; header?: string }> = [
    { key: 'commanders', header: 'Commander' },
    { key: 'mainboard', header: 'Deck' },
    { key: 'sideboard', header: 'Sideboard' },
  ];
  const chunks: string[] = [];
  for (const section of sections) {
    const board = field(payload, section.key);
    if (typeof board !== 'object' || board === null) continue;
    const entries: Array<{ qty: number; name: string }> = [];
    for (const value of Object.values(board as Record<string, unknown>)) {
      const qty = Number(field(value, 'quantity') ?? 0);
      const name = String(field(field(value, 'card'), 'name') ?? '');
      entries.push({ qty, name });
    }
    const lines = toLines(entries);
    if (lines.length > 0) chunks.push(section.header ? `${section.header}\n${lines}` : lines);
  }
  return chunks.join('\n\n');
}

/**
 * Archidekt's deck payload is a flat card array:
 *   `{ name, cards: [ { quantity, categories: [...], card: { oracleCard: { name } } } ] }`
 * Cards in a "Sideboard"/"Maybeboard" category are emitted under that header.
 */
function archidektToText(payload: unknown): string {
  const cards = field(payload, 'cards');
  if (!Array.isArray(cards)) return '';
  const main: Array<{ qty: number; name: string }> = [];
  const sideboard: Array<{ qty: number; name: string }> = [];
  const maybeboard: Array<{ qty: number; name: string }> = [];

  for (const entry of cards) {
    const qty = Number(field(entry, 'quantity') ?? 0);
    const card = field(entry, 'card');
    const name = String(
      field(field(card, 'oracleCard'), 'name') ?? field(card, 'name') ?? '',
    );
    const categories = field(entry, 'categories');
    const labels = Array.isArray(categories) ? categories.map((c) => String(c).toLowerCase()) : [];
    if (labels.includes('sideboard')) sideboard.push({ qty, name });
    else if (labels.includes('maybeboard')) maybeboard.push({ qty, name });
    else main.push({ qty, name });
  }

  const chunks: string[] = [];
  const mainLines = toLines(main);
  if (mainLines) chunks.push(`Deck\n${mainLines}`);
  const sideLines = toLines(sideboard);
  if (sideLines) chunks.push(`Sideboard\n${sideLines}`);
  const maybeLines = toLines(maybeboard);
  if (maybeLines) chunks.push(`Maybeboard\n${maybeLines}`);
  return chunks.join('\n\n');
}

/** Match a path like `/decks/<id>` or `/decks/<id>/slug`, returning `<id>`. */
function segmentAfter(url: URL, segment: string): string | null {
  const parts = url.pathname.split('/').filter((part) => part.length > 0);
  const index = parts.indexOf(segment);
  if (index < 0) return null;
  const id = parts[index + 1];
  return id && id.length > 0 ? id : null;
}

/** The supported sites, in match order. */
export const DECK_SOURCES: readonly DeckSource[] = Object.freeze([
  {
    id: 'moxfield',
    label: 'Moxfield',
    hosts: ['moxfield.com'],
    deckIdFrom: (url) => segmentAfter(url, 'decks'),
    endpointFor: (deckId) => `https://api.moxfield.com/v2/decks/all/${deckId}`,
    payloadKind: 'json',
    toDecklistText: moxfieldToText,
    manualExportUrl: (deckId) => `https://moxfield.com/decks/${deckId}`,
  },
  {
    id: 'archidekt',
    label: 'Archidekt',
    hosts: ['archidekt.com'],
    deckIdFrom: (url) => {
      const id = segmentAfter(url, 'decks');
      // Archidekt deck ids are numeric; the trailing slug is not.
      return id && /^\d+$/.test(id) ? id : null;
    },
    endpointFor: (deckId) => `https://archidekt.com/api/decks/${deckId}/`,
    payloadKind: 'json',
    toDecklistText: archidektToText,
    manualExportUrl: (deckId) => `https://archidekt.com/api/decks/${deckId}/`,
  },
  {
    id: 'mtggoldfish',
    label: 'MTGGoldfish',
    hosts: ['mtggoldfish.com'],
    deckIdFrom: (url) => segmentAfter(url, 'deck'),
    endpointFor: (deckId) => `https://www.mtggoldfish.com/deck/download/${deckId}`,
    payloadKind: 'text',
    toDecklistText: (payload) => String(payload ?? ''),
    manualExportUrl: (deckId) => `https://www.mtggoldfish.com/deck/download/${deckId}`,
  },
  {
    id: 'tappedout',
    label: 'TappedOut',
    hosts: ['tappedout.net'],
    deckIdFrom: (url) => segmentAfter(url, 'mtg-decks'),
    endpointFor: (deckId) => `https://tappedout.net/mtg-decks/${deckId}/?fmt=txt`,
    payloadKind: 'text',
    toDecklistText: (payload) => String(payload ?? ''),
    manualExportUrl: (deckId) => `https://tappedout.net/mtg-decks/${deckId}/?fmt=txt`,
  },
]);

/** A recognized deck URL. */
export interface DetectedSource {
  readonly source: DeckSource;
  readonly deckId: string;
}

/** Recognize a deck URL. Returns `null` for anything we don't host support for. */
export function detectSource(input: string): DetectedSource | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^www\./, '').toLowerCase();
  for (const source of DECK_SOURCES) {
    if (!source.hosts.includes(host)) continue;
    const deckId = source.deckIdFrom(url);
    if (deckId) return { source, deckId };
  }
  return null;
}

/** True when the text looks like a URL rather than a decklist. */
export function looksLikeUrl(text: string): boolean {
  const trimmed = text.trim();
  return !trimmed.includes('\n') && /^https?:\/\/\S+$/i.test(trimmed);
}

/** What a URL import produced. */
export type UrlImportResult =
  | { readonly ok: true; readonly text: string; readonly sourceLabel: string }
  | { readonly ok: false; readonly reason: string; readonly manualUrl?: string };

/** The `fetch` surface a URL import needs (GET, no body). */
export type UrlFetchLike = (
  url: string,
  init: { headers: Record<string, string> },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

/**
 * Fetch a decklist from a supported site.
 *
 * On any failure — unsupported site, blocked by the site's CORS policy, an
 * error status, an empty deck — this resolves (never rejects) with a reason and,
 * where possible, the URL the user can open to copy the list manually.
 */
export async function fetchDecklistFromUrl(
  input: string,
  fetchImpl: UrlFetchLike,
): Promise<UrlImportResult> {
  const detected = detectSource(input);
  if (!detected) {
    return {
      ok: false,
      reason:
        'That link is not from a deck site we can read automatically. Open the deck, copy its list as text, and paste it here.',
    };
  }

  const { source, deckId } = detected;
  const manualUrl = source.manualExportUrl(deckId);

  try {
    const response = await fetchImpl(source.endpointFor(deckId), {
      headers: { Accept: source.payloadKind === 'json' ? 'application/json' : 'text/plain' },
    });
    if (!response.ok) {
      return {
        ok: false,
        reason: `${source.label} refused the request (HTTP ${response.status}).`,
        manualUrl,
      };
    }
    const body = await response.text();
    const payload: unknown = source.payloadKind === 'json' ? JSON.parse(body) : body;
    const text = source.toDecklistText(payload);
    if (text.trim().length === 0) {
      return { ok: false, reason: `That ${source.label} deck came back empty.`, manualUrl };
    }
    return { ok: true, text, sourceLabel: source.label };
  } catch {
    // Overwhelmingly this is the browser blocking a cross-origin read, which no
    // amount of retrying fixes — so point at the manual route instead.
    return {
      ok: false,
      reason: `Your browser was not allowed to read that deck from ${source.label} directly.`,
      manualUrl,
    };
  }
}
