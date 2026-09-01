/**
 * KEYWORD GAP REPORT — which named MTG mechanics the engine still lacks, ranked
 * by how many real cards each one blocks.
 *
 * The coverage audit ranks by missing SYSTEM and the near-miss report ranks by
 * clause SHAPE; neither names a mechanic, because a keyword can be blocked in
 * several different-looking ways ("Convoke" as a bare line, "Regenerate ~" as an
 * ability, "Crew 2" as a cost). This asks the question the goal is phrased in:
 * of every keyword Scryfall tags cards with, which are unimplemented, and how
 * much of the pool is behind each?
 *
 * A keyword counts as BLOCKING a card when the card carries it and does not
 * compile. `soleBlocker` is the stricter, more useful number: the card is one
 * clause from playable AND that clause mentions the keyword — so implementing
 * this one mechanic alone makes the card playable.
 *
 * Usage: node packages/cards/scripts/keyword-gap-report.mjs <corpus.json> [--top N]
 */
import { readFileSync } from 'node:fs';
import { normalizeCard } from '@jonny-boi/data-tools';
import { compileCard } from '@jonny-boi/cards';

const corpusPath = process.argv[2];
const topArg = process.argv.indexOf('--top');
const TOP = topArg > 0 ? Number(process.argv[topArg + 1]) : 30;
if (!corpusPath) {
  console.error('usage: node packages/cards/scripts/keyword-gap-report.mjs <corpus.json> [--top N]');
  process.exit(2);
}
const corpus = JSON.parse(readFileSync(corpusPath, 'utf8'));

const stats = new Map();
for (const raw of corpus) {
  const keywords = Array.isArray(raw.keywords) ? raw.keywords : [];
  let result;
  try {
    result = compileCard(normalizeCard(raw));
  } catch {
    continue;
  }
  const ok = result.status === 'complete';
  const missing = result.missing ?? [];
  const soleClause = missing.length === 1 ? missing[0].text.toLowerCase() : null;
  for (const keyword of keywords) {
    const bucket = stats.get(keyword) ?? { printed: 0, playable: 0, blocked: 0, sole: 0, examples: [] };
    bucket.printed += 1;
    if (ok) {
      bucket.playable += 1;
    } else {
      bucket.blocked += 1;
      if (soleClause !== null && soleClause.includes(keyword.toLowerCase())) {
        bucket.sole += 1;
        if (bucket.examples.length < 4) bucket.examples.push(raw.name);
      }
    }
    stats.set(keyword, bucket);
  }
}

const ranked = [...stats.entries()]
  .filter(([, b]) => b.blocked > 0)
  .sort((a, b) => b[1].sole - a[1].sole || b[1].blocked - a[1].blocked);

console.log(`${corpus.length} cards · ${stats.size} distinct keywords printed on them`);
console.log(`\nUNIMPLEMENTED KEYWORDS, ranked by cards this mechanic ALONE blocks:\n`);
console.log('  sole  blocked  printed  keyword');
for (const [keyword, b] of ranked.slice(0, TOP)) {
  console.log(
    `  ${String(b.sole).padStart(4)}  ${String(b.blocked).padStart(7)}  ${String(b.printed).padStart(7)}  ${keyword}` +
      (b.examples.length ? `   (${b.examples.slice(0, 3).join(', ')})` : ''),
  );
}
const soleTotal = ranked.reduce((sum, [, b]) => sum + b.sole, 0);
console.log(`\n${ranked.length} keywords still block at least one card; ${soleTotal} cards are blocked by a keyword ALONE.`);
