/**
 * Decklist parsing for the Proxies feature.
 *
 * The implementation now lives in `../decklist/parse.ts` — the single parser the
 * whole app shares, so a format the deck importer learns to read (Arena exports,
 * Archidekt categories, CSV, sideboard markers, …) is immediately printable as
 * proxies too. This module is the Proxies view's stable import path; the shape
 * it re-exports is unchanged (DESIGN §1.3: one mechanism per concept).
 */

export type { ParsedCard, ParseError, ParseResult } from '../decklist/parse.js';
export { parseDecklist, formatDecklist } from '../decklist/parse.js';
