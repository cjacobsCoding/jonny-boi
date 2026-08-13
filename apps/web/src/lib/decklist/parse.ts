/**
 * The single decklist parser for the whole app — "paste anything and it works".
 *
 * Every mainstream MTG site exports a slightly different flavour of the same
 * text format, so rather than one parser per site we normalize the *line*
 * shapes they all draw from. A line is a quantity, a name, and any combination
 * of optional decorations that exporters staple on:
 *
 *   4 Lightning Bolt                       plain / MTGGoldfish / MTGO
 *   4x Lightning Bolt                      TappedOut, many blogs
 *   4 Lightning Bolt (M10) 146             MTG Arena, Moxfield
 *   4 Lightning Bolt (m10) 146 *F*         Moxfield with foil markers
 *   1 Sol Ring [Artifacts]                 Archidekt category suffix
 *   SB: 2 Fatal Push                       Deckstats / TappedOut sideboard
 *   4,Lightning Bolt                       CSV exports (Deckbox, Delver Lens)
 *
 * Sections ("Deck", "Sideboard", "Commander", …) are tracked rather than merely
 * skipped, because a maindeck and a sideboard mean different things to an
 * importer. Anything genuinely unparseable is reported with its line number —
 * never thrown, never silently dropped (DESIGN §1.6).
 *
 * Pure and dependency-free, so it is trivially unit-tested.
 */

/** Which part of a decklist an entry belongs to. */
export type DeckSection = 'main' | 'sideboard' | 'commander' | 'maybeboard';

/** The exporter flavour we detected, for display ("Detected: MTG Arena export"). */
export type DecklistFormat = 'arena' | 'csv' | 'plain';

/** One parsed decklist line, with every decoration the exporter supplied. */
export interface DeckLineEntry {
  /** Card name, trimmed and whitespace-collapsed. */
  readonly name: string;
  /** Number of copies requested. */
  readonly qty: number;
  /** Set code (lowercased) when the line carried one. */
  readonly set?: string;
  /** Collector number when the line carried one (Arena/Moxfield exports). */
  readonly collectorNumber?: string;
  /** Which section of the list this line appeared in. */
  readonly section: DeckSection;
}

/** A line we couldn't make sense of, with context for the user. */
export interface ParseError {
  readonly line: number;
  readonly text: string;
  readonly reason: string;
}

/** The full result of parsing a decklist. */
export interface DeckParseResult {
  readonly entries: readonly DeckLineEntry[];
  readonly errors: readonly ParseError[];
  readonly format: DecklistFormat;
  /** A deck name if the list declared one (Arena's `Name ...` header). */
  readonly deckName?: string;
}

/**
 * Section headers exporters emit, mapped to the section they open. Matching is
 * case-insensitive and tolerates a trailing count ("Sideboard (15)") and the
 * leading `//` some exporters use.
 */
const SECTION_HEADERS: Readonly<Record<string, DeckSection>> = Object.freeze({
  deck: 'main',
  maindeck: 'main',
  main: 'main',
  mainboard: 'main',
  creatures: 'main',
  spells: 'main',
  lands: 'main',
  sideboard: 'sideboard',
  commander: 'commander',
  companion: 'sideboard',
  maybeboard: 'maybeboard',
  considering: 'maybeboard',
  tokens: 'maybeboard',
});

/** Lines that are metadata, not cards, and carry no section meaning. */
const IGNORED_HEADERS: readonly string[] = ['about', 'layout'];

/** `SB:`-style prefixes marking a single sideboard line (Deckstats, TappedOut). */
const SIDEBOARD_LINE_PREFIX = /^sb:\s*/i;

/**
 * The core line shape. Groups:
 *   1 quantity (optional, may be followed by `x`)
 *   2 name
 *   3 set code (optional, in parens or square brackets)
 *   4 collector number (optional — only meaningful *after* a set code)
 *
 * The name is lazy so the optional trailing decorations win. The collector
 * number is nested inside the set-code group and restricted to digits with an
 * optional suffix letter, because an unrestricted trailing word would swallow
 * the last word of every plain "4 Lightning Bolt" line.
 *
 * A trailing `*F*`/`*E*` foil-or-etched marker and an `[Category]` suffix are
 * stripped before matching (see {@link stripDecorations}).
 */
const LINE_PATTERN =
  /^(?:(\d+)\s*[xX]?\s+)?(.+?)(?:\s+[([]([A-Za-z0-9_]{2,6})[)\]](?:\s+(\d+[A-Za-z★]?))?)?\s*$/;

/** Strip exporter decorations that never belong to the card name. */
function stripDecorations(line: string): string {
  return (
    line
      // Moxfield foil / etched markers: "*F*", "*E*".
      .replace(/\s+\*[A-Za-z]\*/g, '')
      // Archidekt category suffix: "[Artifacts]" / "[Ramp{top}]" at end of line.
      // A set code in brackets is 2-6 alphanumerics, so require a longer or
      // non-alphanumeric payload to treat brackets as a category.
      .replace(/\s+\[[^\]]{7,}\]\s*$/g, '')
      .replace(/\s+\^[^^]*\^/g, '')
      .trim()
  );
}

/** Normalize whitespace inside a card name. */
function cleanName(name: string): string {
  return name.trim().replace(/\s+/g, ' ');
}

/**
 * Recognize a section header line. Returns the section it opens, or `null` when
 * the line is not a header. Tolerates "Sideboard (15)", "// Sideboard", and
 * "Deck:".
 */
function sectionHeaderFor(trimmed: string): DeckSection | null {
  const cleaned = trimmed
    .replace(/^\/\/\s*/, '')
    .replace(/\s*\(\d+\)\s*$/, '')
    .replace(/:$/, '')
    .trim()
    .toLowerCase();
  return SECTION_HEADERS[cleaned] ?? null;
}

/** True when a CSV header row is present (Deckbox / Delver Lens exports). */
function isCsvHeader(line: string): boolean {
  const lower = line.toLowerCase();
  return (
    lower.includes(',') &&
    lower.includes('name') &&
    (lower.includes('count') || lower.includes('quantity') || lower.includes('qty'))
  );
}

/** Column indexes we need out of a CSV header row. */
interface CsvColumns {
  readonly qty: number;
  readonly name: number;
  readonly set: number;
}

/** Split one CSV row, honoring double-quoted fields (names contain commas). */
function splitCsvRow(row: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < row.length; i += 1) {
    const char = row[i]!;
    if (char === '"') {
      // A doubled quote inside a quoted field is a literal quote.
      if (inQuotes && row[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (char === ',' && !inQuotes) {
      fields.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  fields.push(current);
  return fields.map((field) => field.trim());
}

/** Locate the quantity/name/set columns in a CSV header row. */
function csvColumns(headerRow: string): CsvColumns {
  const headers = splitCsvRow(headerRow).map((header) => header.toLowerCase());
  const find = (...candidates: string[]): number =>
    headers.findIndex((header) => candidates.some((candidate) => header === candidate));
  return {
    qty: find('count', 'quantity', 'qty'),
    name: find('name', 'card', 'card name'),
    set: find('edition', 'set', 'set code'),
  };
}

/** Parse a CSV export (a header row plus one row per card stack). */
function parseCsv(lines: readonly string[]): DeckParseResult {
  const entries: DeckLineEntry[] = [];
  const errors: ParseError[] = [];
  const columns = csvColumns(lines[0] ?? '');

  for (let i = 1; i < lines.length; i += 1) {
    const raw = lines[i]!;
    if (raw.trim().length === 0) continue;
    const fields = splitCsvRow(raw);
    const name = cleanName(fields[columns.name] ?? '');
    if (name.length === 0) {
      errors.push({ line: i + 1, text: raw.trim(), reason: 'No card name in this row.' });
      continue;
    }
    const qtyText = columns.qty >= 0 ? (fields[columns.qty] ?? '') : '';
    const qty = qtyText.length > 0 ? Number.parseInt(qtyText, 10) : 1;
    if (!Number.isFinite(qty) || qty <= 0) {
      errors.push({ line: i + 1, text: raw.trim(), reason: 'Invalid quantity.' });
      continue;
    }
    const setCode = columns.set >= 0 ? (fields[columns.set] ?? '').trim().toLowerCase() : '';
    entries.push({
      name,
      qty,
      section: 'main',
      ...(setCode.length > 0 && setCode.length <= 6 ? { set: setCode } : {}),
    });
  }

  return { entries, errors, format: 'csv' };
}

/**
 * Parse a decklist in any of the supported text flavours. Never throws: every
 * unrecognized line lands in `errors` with its line number and a reason.
 */
export function parseDeckText(text: string): DeckParseResult {
  const lines = text.split(/\r?\n/);
  if (lines.length > 0 && isCsvHeader(lines[0] ?? '')) return parseCsv(lines);

  const entries: DeckLineEntry[] = [];
  const errors: ParseError[] = [];
  let section: DeckSection = 'main';
  let deckName: string | undefined;
  let sawSetAndNumber = false;

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i]!;
    const trimmed = raw.trim();

    if (trimmed.length === 0) continue;
    // `#` is always a comment. `//` is a comment ONLY when it opens the line and
    // is not a section header — a card name may legitimately contain " // "
    // (double-faced cards such as "Delver of Secrets // Insectile Aberration").
    if (trimmed.startsWith('#')) continue;

    const header = sectionHeaderFor(trimmed);
    if (header) {
      section = header;
      continue;
    }
    if (trimmed.startsWith('//')) continue;

    const lowerFirstWord = trimmed.split(/\s+/)[0]?.toLowerCase().replace(':', '') ?? '';
    if (IGNORED_HEADERS.includes(lowerFirstWord)) continue;
    // MTG Arena writes the deck's name as a `Name <deck name>` header.
    if (lowerFirstWord === 'name' && !/^\d/.test(trimmed)) {
      deckName = trimmed.slice(trimmed.indexOf(' ') + 1).trim() || undefined;
      continue;
    }

    // A per-line sideboard marker overrides the current section for this line.
    const isSideboardLine = SIDEBOARD_LINE_PREFIX.test(trimmed);
    const body = stripDecorations(trimmed.replace(SIDEBOARD_LINE_PREFIX, ''));

    const match = LINE_PATTERN.exec(body);
    if (!match) {
      errors.push({ line: i + 1, text: trimmed, reason: 'Unrecognized line format.' });
      continue;
    }

    const [, qtyText, nameRaw, setRaw, collectorRaw] = match;
    const name = cleanName(nameRaw ?? '');
    if (name.length === 0 || /^\d+$/.test(name)) {
      errors.push({ line: i + 1, text: trimmed, reason: 'Missing a card name.' });
      continue;
    }

    const qty = qtyText ? Number.parseInt(qtyText, 10) : 1;
    if (!Number.isFinite(qty) || qty <= 0) {
      errors.push({ line: i + 1, text: trimmed, reason: 'Invalid quantity.' });
      continue;
    }

    if (setRaw && collectorRaw) sawSetAndNumber = true;
    entries.push({
      name,
      qty,
      section: isSideboardLine ? 'sideboard' : section,
      ...(setRaw ? { set: setRaw.toLowerCase() } : {}),
      ...(collectorRaw ? { collectorNumber: collectorRaw } : {}),
    });
  }

  return {
    entries,
    errors,
    // "Set code + collector number on the same line" is the Arena/Moxfield
    // signature; everything else reads as a plain list.
    format: sawSetAndNumber ? 'arena' : 'plain',
    ...(deckName ? { deckName } : {}),
  };
}

/** Total copies across a set of entries (what "60 cards" means). */
export function totalCards(entries: readonly DeckLineEntry[]): number {
  return entries.reduce((sum, entry) => sum + entry.qty, 0);
}

/** Filter entries down to one section. */
export function entriesInSection(
  entries: readonly DeckLineEntry[],
  section: DeckSection,
): DeckLineEntry[] {
  return entries.filter((entry) => entry.section === section);
}

// --- compatibility surface ------------------------------------------------------
// The Proxies feature (apps/web/src/lib/proxy) predates this module and consumes
// a simpler shape. It keeps that API; this is the one implementation behind it,
// so a parsing improvement lands in both places at once (DESIGN §1.3, DRY).

/** One parsed decklist entry in the simpler shape the Proxies view consumes. */
export interface ParsedCard {
  readonly name: string;
  readonly qty: number;
  readonly set?: string;
}

/** Result of parsing a decklist in the simpler shape. */
export interface ParseResult {
  readonly cards: ParsedCard[];
  readonly errors: ParseError[];
}

/** Parse a decklist, flattened to `{ name, qty, set? }` entries. */
export function parseDecklist(text: string): ParseResult {
  const { entries, errors } = parseDeckText(text);
  return {
    cards: entries.map((entry) => ({
      name: entry.name,
      qty: entry.qty,
      ...(entry.set ? { set: entry.set } : {}),
    })),
    errors: [...errors],
  };
}

/** Serialize parsed cards back to a canonical decklist string. */
export function formatDecklist(cards: readonly ParsedCard[]): string {
  return cards.map((card) => `${card.qty} ${card.name}${card.set ? ` (${card.set})` : ''}`).join('\n');
}
