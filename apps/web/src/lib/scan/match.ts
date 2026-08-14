/**
 * Correcting OCR output into a real card name.
 *
 * THIS IS WHY OCR IS GOOD ENOUGH. Raw OCR of a phone photo makes plenty of
 * mistakes — "Llghtnlng Bolt", "Serra Ange1", a stray border character. But card
 * names are a CLOSED VOCABULARY of about thirty thousand strings, so we never
 * have to trust the raw text: we only have to find the nearest real name. That
 * turns a hard recognition problem into a cheap spelling-correction one, and it
 * is what lets a modest on-device engine produce a usable decklist.
 *
 * Pure and dependency-free; the vocabulary is passed in.
 */

import { MATCH_CANDIDATES, MIN_MATCH_SCORE } from './config.js';

/** One candidate name for a scanned card, with how well it matched. */
export interface NameMatch {
  readonly name: string;
  /** Similarity in 0–1, where 1 is an exact match after normalization. */
  readonly score: number;
}

/**
 * Reduce a string to its comparable core: lowercase, accents folded, and
 * everything that is not a letter, digit or space removed.
 *
 * OCR routinely invents punctuation from frame edges and mistakes apostrophes,
 * and real card names are full of commas, apostrophes and hyphens. Dropping all
 * of it from both sides means "Jaces Ingenuity" still matches "Jace's
 * Ingenuity" instead of being penalised for a character the user cannot control.
 */
export function normalizeForMatch(text: string): string {
  return (
    text
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      // Apostrophes are DELETED rather than spaced, because they sit inside a
      // word: "Jace's" must become "jaces", not "jace s".
      .replace(/['’`]/g, '')
      .replace(/[^a-z0-9 ]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

/**
 * Levenshtein edit distance with a ceiling. Rows are reused between calls' inner
 * loops and the function bails out as soon as every cell in a row exceeds
 * `maxDistance`, because across a 30k-name vocabulary the vast majority of
 * comparisons are hopeless and should cost as little as possible.
 */
export function editDistance(a: string, b: string, maxDistance = Number.POSITIVE_INFINITY): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > maxDistance) return maxDistance + 1;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let previous = new Array<number>(b.length + 1);
  let current = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j += 1) previous[j] = j;

  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    let rowBest = current[0]!;
    const aChar = a.charCodeAt(i - 1);
    for (let j = 1; j <= b.length; j += 1) {
      const substitution = (previous[j - 1] ?? 0) + (aChar === b.charCodeAt(j - 1) ? 0 : 1);
      const deletion = (previous[j] ?? 0) + 1;
      const insertion = (current[j - 1] ?? 0) + 1;
      const best = Math.min(substitution, deletion, insertion);
      current[j] = best;
      if (best < rowBest) rowBest = best;
    }
    // Nothing in this row is within budget, so no completed path can be either.
    if (rowBest > maxDistance) return maxDistance + 1;
    const swap = previous;
    previous = current;
    current = swap;
  }
  return previous[b.length] ?? 0;
}

/** Similarity in 0–1 derived from edit distance over the longer string. */
export function similarity(a: string, b: string): number {
  const longest = Math.max(a.length, b.length);
  if (longest === 0) return 1;
  const distance = editDistance(a, b, longest);
  return 1 - Math.min(distance, longest) / longest;
}

/**
 * An index over the card-name vocabulary. Built once per scan and reused for
 * every detected card: rebuilding normalized forms for 30k names on each of 60
 * lookups would dominate the whole scan's runtime.
 */
export interface NameIndex {
  readonly entries: ReadonlyArray<{ readonly name: string; readonly normalized: string }>;
}

/** Build the lookup index from a list of card names. */
export function buildNameIndex(names: readonly string[]): NameIndex {
  return {
    entries: names.map((name) => ({ name, normalized: normalizeForMatch(name) })),
  };
}

/**
 * Find the best card names for a piece of OCR text, best first.
 *
 * Two cheap filters run before the expensive distance: names whose length is
 * wildly different cannot be within the distance budget, and a name that
 * literally contains the OCR text (or vice versa) is promoted — that is the
 * common case where OCR clipped a word off the end of a long name.
 */
export function matchCardName(
  ocrText: string,
  index: NameIndex,
  limit = MATCH_CANDIDATES,
): NameMatch[] {
  const query = normalizeForMatch(ocrText);
  if (query.length === 0) return [];

  const matches: NameMatch[] = [];
  // A name can differ from the query by at most this many edits and still clear
  // the score floor, which lets us skip most of the vocabulary outright.
  const budget = Math.ceil(query.length * (1 - MIN_MATCH_SCORE)) + 1;

  for (const entry of index.entries) {
    const candidate = entry.normalized;
    if (candidate.length === 0) continue;
    if (Math.abs(candidate.length - query.length) > budget) continue;

    const distance = editDistance(query, candidate, budget);
    // Past the budget `editDistance` returns a LOWER BOUND, not the real
    // distance, so it must not be scored — treating the sentinel as exact once
    // let "zzzz qqqq xxxx" match a long card name.
    if (distance > budget) continue;

    const longest = Math.max(query.length, candidate.length);
    let score = 1 - Math.min(distance, longest) / longest;

    // OCR that read only part of a long name is a prefix, not a typo — score it
    // on what was actually read rather than punishing the missing tail.
    if (score < 1 && (candidate.startsWith(query) || query.startsWith(candidate))) {
      const shared = Math.min(candidate.length, query.length);
      score = Math.max(score, shared / longest);
    }

    if (score >= MIN_MATCH_SCORE) matches.push({ name: entry.name, score });
  }

  matches.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return matches.slice(0, limit);
}
