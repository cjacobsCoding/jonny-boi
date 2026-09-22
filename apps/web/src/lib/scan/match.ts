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

import { MATCH_CANDIDATES, MIN_MATCH_SCORE, MIN_QUERY_LENGTH } from './config.js';

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
  // OCR of a title crop can return more than one line — a tilted pile puts a
  // sliver of the neighbouring copy's title into the crop, and the engine reads
  // it as its own line of junk. The real name is ONE of the lines, so each line
  // competes separately (plus the whole, for names OCR broke across lines) and
  // the best result per candidate name wins.
  //
  // Within a line, the name is often FLANKED by junk words — a frame edge read
  // as "f", a mana symbol read as "od" — which whole-line distance punishes
  // enough to lose the match ("Hend Hunter od" landed on the wrong card until
  // "hend hunter" alone could compete). So every contiguous run of words is a
  // query too; the runs are few and the distance scan is budget-limited, so
  // this stays cheap.
  const lines = ocrText
    .split('\n')
    .map((line) => normalizeForMatch(line))
    .filter((line) => line.length > 0);
  const whole = normalizeForMatch(ocrText);
  const candidates = new Set<string>(whole.length > 0 ? [whole, ...lines] : lines);
  for (const line of lines) {
    const words = line.split(' ');
    for (let from = 0; from < words.length; from += 1) {
      for (let to = from + 1; to <= words.length; to += 1) {
        const run = words.slice(from, to).join(' ');
        if (run.length >= MIN_QUERY_LENGTH) candidates.add(run);
      }
    }
  }
  const queries = [...candidates];

  // A name's best score, remembering how LONG the query that earned it was:
  // when two names tie, the one matched from more characters of evidence wins
  // ("her Priest" naming Banisher Priest must not lose a tie to a short junk
  // word's coincidental match).
  const byName = new Map<string, { match: NameMatch; queryLength: number }>();
  for (const query of queries) {
    for (const match of matchOneQuery(query, index)) {
      const existing = byName.get(match.name);
      if (
        !existing ||
        match.score > existing.match.score ||
        (match.score === existing.match.score && query.length > existing.queryLength)
      ) {
        byName.set(match.name, { match, queryLength: query.length });
      }
    }
  }

  return [...byName.values()]
    .sort(
      (a, b) =>
        b.match.score - a.match.score ||
        b.queryLength - a.queryLength ||
        a.match.name.localeCompare(b.match.name),
    )
    .map((entry) => entry.match)
    .slice(0, limit);
}

/**
 * Match one normalized query string against the vocabulary.
 *
 * ## ⚠️ THIS IS THE APP'S ONE FUZZY NAME MATCHER (§3.181)
 *
 * It has two callers, and that is the point. {@link matchCardName} drives it
 * once per OCR candidate string; the Lab's card picker drives it once per typed
 * term. Before §3.181 the app had THREE implementations of "find me the card I
 * mean" — this one, Scryfall's fuzzy endpoint behind the deck builder's Add
 * dialog, and the Lab picker's own substring ranking — and the Lab's, on the
 * surface where a user is most likely to be hunting one specific card, was the
 * only one that could not survive a typo. Promoting this to shared rather than
 * writing a fourth is rule 12 and Caleb's fuzzy request in one edit.
 *
 * Scryfall's could not be the shared one: it is a network call at call time,
 * and the pure units forbid `fetch` there.
 *
 * `minScore` is a PARAMETER rather than a constant read from scan's config,
 * because OCR and a human typist are not the same problem — OCR's floor is
 * tuned for a camera's mistakes — and a picker that inherited the camera's
 * tuning would be tuned by accident. The default keeps every existing scan call
 * byte-identical.
 */
export function matchOneQuery(
  query: string,
  index: NameIndex,
  minScore: number = MIN_MATCH_SCORE,
): NameMatch[] {
  if (query.length === 0) return [];

  const matches: NameMatch[] = [];
  // A name can differ from the query by at most this many edits and still clear
  // the score floor, which lets us skip most of the vocabulary outright.
  const budget = Math.ceil(query.length * (1 - minScore)) + 1;

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

    if (score >= minScore) matches.push({ name: entry.name, score });
  }
  return matches;
}
