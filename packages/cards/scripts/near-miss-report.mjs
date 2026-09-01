/**
 * NEAR-MISS REPORT — which cards are ONE clause away from playable, clustered
 * by the shape of the clause that blocks them.
 *
 * The coverage audit ranks by "how many cards does this SYSTEM block", which is
 * the right question for deciding what to build next. This asks the other,
 * cheaper question: which cards would compile if exactly one more clause did?
 * A card blocked by one clause is a rule-table edit away from playable; a card
 * blocked by five is a project. Ranking the one-clause cards by CLAUSE SHAPE
 * turns the long tail into a work queue ordered by cards-per-edit.
 *
 * Shapes are derived from the clause text itself — numbers, quoted names and
 * card names collapse to placeholders — so "create a 1/1 white Soldier" and
 * "create a 2/2 black Zombie" cluster as one shape, and the count is the number
 * of cards one rule would unblock.
 *
 * Usage: node packages/cards/scripts/near-miss-report.mjs <corpus.json> [--top N]
 */
import { readFileSync } from 'node:fs';
import { normalizeCard } from '@jonny-boi/data-tools';
import { compileCard } from '@jonny-boi/cards';

const corpusPath = process.argv[2];
const topArg = process.argv.indexOf('--top');
const TOP = topArg > 0 ? Number(process.argv[topArg + 1]) : 20;
if (!corpusPath) {
  console.error('usage: node packages/cards/scripts/near-miss-report.mjs <corpus.json> [--top N]');
  process.exit(2);
}
const corpus = JSON.parse(readFileSync(corpusPath, 'utf8'));

/** Collapse a clause to its SHAPE: the parts a rule would parameterize. */
function shapeOf(text) {
  return text
    .toLowerCase()
    .replace(/\{[^}]*\}/g, '{M}')
    .replace(/\d+\/\d+/g, 'N/N')
    .replace(/\b\d+\b/g, 'N')
    .replace(/"[^"]*"/g, '"…"')
    .replace(/\s+/g, ' ')
    .trim();
}

const oneClause = [];
let incomplete = 0;
for (const raw of corpus) {
  let result;
  try {
    result = compileCard(normalizeCard(raw));
  } catch {
    continue;
  }
  if (result.status === 'complete') continue;
  incomplete += 1;
  if ((result.missing ?? []).length !== 1) continue;
  const only = result.missing[0];
  oneClause.push({ card: raw.name, text: only.text, system: only.missingEngineSystem, shape: shapeOf(only.text) });
}

const byShape = new Map();
for (const entry of oneClause) {
  const bucket = byShape.get(entry.shape) ?? { count: 0, cards: [], example: entry.text, system: entry.system };
  bucket.count += 1;
  bucket.cards.push(entry.card);
  byShape.set(entry.shape, bucket);
}
const ranked = [...byShape.entries()].sort((a, b) => b[1].count - a[1].count);

console.log(`${corpus.length} cards · ${incomplete} incomplete · ${oneClause.length} blocked by EXACTLY ONE clause`);
console.log(`\nTop ${Math.min(TOP, ranked.length)} one-clause shapes (cards a single rule would unblock):\n`);
for (const [, bucket] of ranked.slice(0, TOP)) {
  console.log(`  ${String(bucket.count).padStart(3)}  ${bucket.example.slice(0, 96)}`);
  console.log(`       cards: ${bucket.cards.slice(0, 4).join(', ')}${bucket.cards.length > 4 ? `, +${bucket.cards.length - 4} more` : ''}`);
}
