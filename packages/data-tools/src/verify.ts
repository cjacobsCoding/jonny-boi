/**
 * Field-by-field comparison of a stored card record against a freshly fetched
 * one — the pure half of the LIVE accuracy check.
 *
 * `invariants.ts` proves the index is internally consistent; it cannot prove it
 * matches reality, because a cost that is wrong in a self-consistent way (a
 * generic pip promoted to a coloured pip of a colour the card already is) breaks
 * no structural rule. Only a re-fetch catches that, and a re-fetch cannot run in
 * `npm test`. So the comparison lives here, pure and unit-tested, and
 * `verify-cli.ts` supplies it with live data on demand.
 *
 * Only the fields the ENGINE depends on are compared by default. Printing-level
 * data (set, collector number, image URLs, rarity) legitimately changes when
 * Scryfall picks a different default printing for a name, so it is reported
 * separately rather than as a data error.
 */

import { formatManaCost } from './invariants.js';
import type { NormalizedCard } from './types.js';

/** Scryfall joins the two halves of a double-faced card's name with this. */
const FACE_NAME_SEPARATOR = ' // ';

/**
 * The half of a multi-faced card's name that Scryfall's `/cards/collection`
 * endpoint actually resolves.
 *
 * MEASURED, not assumed: posting `{ name: 'Fire // Ice' }` comes back in
 * `not_found`, while `{ name: 'Fire' }` returns the whole `Fire // Ice` record.
 * That is true of every two-faced layout — transform, modal DFC, split,
 * aftermath, adventure — so ANY path that turns a stored/committed card name
 * back into a Scryfall request has to come through here. The card index stores
 * the combined name (it is the card's real name); the starter list and every
 * lookup carry the front half.
 */
export function frontFaceName(name: string): string {
  return name.split(FACE_NAME_SEPARATOR)[0]!;
}

/**
 * The name to ask Scryfall for when re-fetching a stored card.
 *
 * A double-faced card is stored under its combined name ("Delver of Secrets //
 * Insectile Aberration"), which the collection endpoint does not resolve — it
 * wants a face name. The front face is what the curated starter list carries
 * too, so both paths ask for the same thing.
 */
export function scryfallLookupName(card: NormalizedCard): string {
  return frontFaceName(card.name);
}

/** One field that differs between the stored record and the fetched one. */
export interface FieldDiff {
  readonly card: string;
  readonly field: string;
  readonly stored: string;
  readonly live: string;
  /**
   * `'oracle'` — a property of the card itself (cost, text, P/T…). A difference
   * here means the index is wrong (or the card was errata'd) and the engine is
   * playing something that does not exist.
   *
   * `'printing'` — a property of the particular printing the index happens to
   * carry. A difference is expected drift, not corruption.
   */
  readonly kind: 'oracle' | 'printing';
}

/** Fields that describe the card, independent of which printing you own. */
const ORACLE_FIELDS = [
  'name',
  'manaCost',
  'cmc',
  'rawTypeLine',
  'typeLine',
  'oracleText',
  'power',
  'toughness',
  'colors',
  'colorIdentity',
  'keywords',
  'isDoubleFaced',
] as const;

/** Fields that describe the printing the index happens to carry. */
const PRINTING_FIELDS = ['set', 'collectorNumber', 'rarity'] as const;

/** Stable rendering of a field value, so unordered lists compare equal. */
function render(field: string, value: unknown): string {
  if (field === 'manaCost') return formatManaCost(value as Parameters<typeof formatManaCost>[0]);
  if (Array.isArray(value)) return `[${[...(value as string[])].map(String).sort().join(', ')}]`;
  if (value !== null && typeof value === 'object') return JSON.stringify(value);
  return JSON.stringify(value);
}

/**
 * Compare one stored card against its freshly fetched counterpart. Returns
 * every field that differs; an empty array means the record is exactly what
 * Scryfall serves today.
 */
export function diffCard(stored: NormalizedCard, live: NormalizedCard): FieldDiff[] {
  const diffs: FieldDiff[] = [];
  const compare = (field: string, kind: FieldDiff['kind']): void => {
    const a = render(field, (stored as unknown as Record<string, unknown>)[field]);
    const b = render(field, (live as unknown as Record<string, unknown>)[field]);
    if (a !== b) diffs.push({ card: stored.name, field, stored: a, live: b, kind });
  };
  for (const field of ORACLE_FIELDS) compare(field, 'oracle');
  for (const field of PRINTING_FIELDS) compare(field, 'printing');
  return diffs;
}

/** The outcome of verifying a whole index against a freshly fetched set. */
export interface VerifyReport {
  readonly checked: number;
  /** Stored cards with no live counterpart (an id/name that no longer resolves). */
  readonly missing: readonly string[];
  /** Live cards with no stored counterpart (the index is short of the pool). */
  readonly extra: readonly string[];
  readonly diffs: readonly FieldDiff[];
}

/**
 * Verify a stored card list against freshly fetched cards, joining on Scryfall
 * id and falling back to name (the index is unique by both).
 */
export function verifyCards(
  stored: readonly NormalizedCard[],
  live: readonly NormalizedCard[],
): VerifyReport {
  const liveById = new Map(live.map((card) => [card.id, card]));
  const liveByName = new Map(live.map((card) => [card.name, card]));
  const matched = new Set<string>();

  const diffs: FieldDiff[] = [];
  const missing: string[] = [];
  for (const card of stored) {
    const match = liveById.get(card.id) ?? liveByName.get(card.name);
    if (!match) {
      missing.push(card.name);
      continue;
    }
    matched.add(match.id);
    diffs.push(...diffCard(card, match));
  }

  const extra = live.filter((card) => !matched.has(card.id)).map((card) => card.name);
  return { checked: stored.length - missing.length, missing, extra, diffs };
}

/** A human-readable report, used by the CLI. */
export function formatVerifyReport(report: VerifyReport): string {
  const lines: string[] = [];
  const oracle = report.diffs.filter((diff) => diff.kind === 'oracle');
  const printing = report.diffs.filter((diff) => diff.kind === 'printing');

  lines.push(`checked ${report.checked} cards against live Scryfall`);
  if (report.missing.length > 0) lines.push(`NOT FOUND live: ${report.missing.join(', ')}`);
  if (report.extra.length > 0) lines.push(`fetched but not in the index: ${report.extra.join(', ')}`);

  lines.push('');
  lines.push(`ORACLE-LEVEL DIFFERENCES (the engine plays these): ${oracle.length}`);
  for (const diff of oracle) {
    lines.push(`  ${diff.card} · ${diff.field}: stored ${diff.stored} · live ${diff.live}`);
  }
  lines.push('');
  lines.push(`printing drift (expected; refresh to adopt): ${printing.length}`);
  for (const diff of printing) {
    lines.push(`  ${diff.card} · ${diff.field}: stored ${diff.stored} · live ${diff.live}`);
  }
  return lines.join('\n');
}
