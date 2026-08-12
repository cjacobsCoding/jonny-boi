/**
 * Pure decklist parser. Turns a pasted list of the standard MTG text format into
 * a structured `{ cards, errors }` result. Deliberately dependency-free and
 * side-effect-free so it is trivially unit-testable (CLAUDE.md: pure-core).
 *
 * Accepted line shapes (quantity is optional; defaults to 1):
 *   `4 Lightning Bolt`
 *   `4x Lightning Bolt`      (an `x`/`X` may follow the count)
 *   `1 Sol Ring`
 *   `2 Fatal Push (mh2)`     (a trailing set code in parens is captured)
 *   `Lightning Bolt`         (no count → 1)
 *
 * Ignored gracefully (never an error):
 *   - blank / whitespace-only lines
 *   - comment lines starting with `#` or `//`
 *   - section headers like `Sideboard`, `Deck`, `Commander`, `Maybeboard`
 *
 * A line we can't make sense of (e.g. just a stray number) is reported in
 * `errors` with its line number so the UI can surface it — it never throws.
 */

/** One parsed decklist entry. */
export interface ParsedCard {
  /** Card name, trimmed (set code and quantity stripped off). */
  name: string;
  /** Number of copies requested. */
  qty: number;
  /** Optional set code (lowercased) if the line included one in parens. */
  set?: string;
}

/** A line we couldn't parse, with context for the user. */
export interface ParseError {
  line: number;
  text: string;
  reason: string;
}

/** Result of parsing a decklist: the resolved entries plus any bad lines. */
export interface ParseResult {
  cards: ParsedCard[];
  errors: ParseError[];
}

/** Section-header words that mark a list boundary rather than a card. */
const SECTION_HEADERS = new Set([
  'deck',
  'sideboard',
  'commander',
  'maybeboard',
  'companion',
  'tokens',
]);

/**
 * Matches an optional leading quantity (with an optional `x`), the card name,
 * and an optional trailing `(set)` code.
 *
 * Groups: 1 = quantity (may be undefined), 2 = name, 3 = set code (may be undefined).
 */
const LINE_PATTERN = /^(?:(\d+)\s*[xX]?\s+)?(.+?)(?:\s+\(([^)]+)\))?\s*$/;

/** Strip a trailing collector-number that some exports append, e.g. `123`. */
function cleanName(name: string): string {
  return name.trim().replace(/\s+/g, ' ');
}

/** Parse a decklist string into structured cards + a list of bad lines. */
export function parseDecklist(text: string): ParseResult {
  const cards: ParsedCard[] = [];
  const errors: ParseError[] = [];

  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i]!;
    const trimmed = raw.trim();

    // Blank lines and comments are skipped silently.
    if (trimmed.length === 0) continue;
    if (trimmed.startsWith('#') || trimmed.startsWith('//')) continue;

    // A bare section header ("Sideboard", "Deck", …) is a boundary, not a card.
    if (SECTION_HEADERS.has(trimmed.toLowerCase())) continue;

    const match = LINE_PATTERN.exec(trimmed);
    if (!match) {
      errors.push({ line: i + 1, text: trimmed, reason: 'Unrecognized line format.' });
      continue;
    }

    const [, qtyStr, nameRaw, setRaw] = match;
    const name = cleanName(nameRaw ?? '');
    if (name.length === 0) {
      errors.push({ line: i + 1, text: trimmed, reason: 'No card name found.' });
      continue;
    }

    // A line that is only a number (e.g. "4") parses with an empty name → guard.
    if (/^\d+$/.test(name)) {
      errors.push({ line: i + 1, text: trimmed, reason: 'Missing a card name.' });
      continue;
    }

    const qty = qtyStr ? Number.parseInt(qtyStr, 10) : 1;
    if (!Number.isFinite(qty) || qty <= 0) {
      errors.push({ line: i + 1, text: trimmed, reason: 'Invalid quantity.' });
      continue;
    }

    const entry: ParsedCard = { name, qty };
    if (setRaw && setRaw.trim().length > 0) entry.set = setRaw.trim().toLowerCase();
    cards.push(entry);
  }

  return { cards, errors };
}

/** Serialize parsed cards back to a canonical decklist string (for round-trips). */
export function formatDecklist(cards: readonly ParsedCard[]): string {
  return cards
    .map((c) => `${c.qty} ${c.name}${c.set ? ` (${c.set})` : ''}`)
    .join('\n');
}
