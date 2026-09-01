/**
 * KEYWORD GAP REPORT — which named MTG mechanics the engine still lacks, ranked
 * by how many real cards each one blocks.
 *
 * The coverage audit ranks by missing SYSTEM and the near-miss report ranks by
 * clause SHAPE; neither names a mechanic, because a keyword can be blocked in
 * several different-looking ways ("Convoke" as a bare line, "Regenerate ~" as an
 * ability, "Crew 2" as a cost). This asks the question the goal is phrased in:
 * of every keyword printed on a real card, which are unimplemented, and how much
 * of the pool is behind each?
 *
 * ⚠️ THE ATTRIBUTION IS THE WHOLE VALUE OF THIS TOOL, and three earlier versions
 * got it wrong in three different directions. All three are worth keeping
 * written down, because each is the natural thing to reach for:
 *
 *   1. SUBSTRING against Scryfall's keyword list — credited "Enchant" for every
 *      Aura whose grant BODY was unsupported ("Enchanted creature can't attack
 *      or block"), because that clause contains the word. It read 412 cards deep
 *      and would have sent an agent to build Auras, which have existed for ages.
 *   2. EXACT EQUALITY with the compiler's keyword-sweep reason — the opposite
 *      error. The sweep only fires for keywords Scryfall tagged that the text
 *      never explained; a printed keyword LINE no rule matches is reported by
 *      the ordinary clause scan instead. Whole mechanics vanished and the tool
 *      claimed the pool had just 12 keyword-blocked cards.
 *   3. Ranking by the compiler's own wording — same blind spot as (2), plus it
 *      split one mechanic across a row per parameter.
 *
 * What is true of every real case, and false for every false positive: THE
 * BLOCKING CLAUSE IS THE KEYWORD'S OWN PRINTED LINE. So a card counts for
 * keyword K when its single missing clause STARTS WITH K at a word boundary —
 * "Soulshift 4", "Echo {1}{G}", "Affinity for artifacts", "Islandwalk". Scryfall
 * says which words are keywords (`card.keywords`), so the vocabulary is data and
 * not a list maintained here. "Enchanted creature …" starts with `enchanted`,
 * which is not the word `enchant`, so case (1) can no longer creep back in. The
 * keyword-sweep reason is still honoured as a second path, for keywords whose
 * line was never printed at all.
 *
 * `mechanic` collapses the PARAMETER — "Soulshift 4" and "Soulshift 2" are one
 * thing to implement, and ranking them apart is how a real backlog hides.
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

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The compiler's keyword sweep writes exactly this when a TAGGED keyword was never explained. */
const KEYWORD_ABILITY_REASON = /^the "(.+)" keyword ability$/;

/**
 * A keyword's PARAMETER is not part of the mechanic. Everything after the name —
 * a number ("Soulshift 4"), a cost ("Echo {1}{G}", "Suspend 5—{G}"), or a chosen
 * quality ("Affinity for artifacts", "Protection from red") — varies card to
 * card while the thing to implement stays one thing.
 */
const KEYWORD_PARAMETER = /\s+(?:\d.*|\{.*|for\s+.*|from\s+.*|—.*)$/i;
const mechanicOf = (printed) => printed.replace(KEYWORD_PARAMETER, '').trim().toLowerCase();

const stats = new Map();
let cards = 0;
let complete = 0;
for (const raw of corpus) {
  let result;
  try {
    result = compileCard(normalizeCard(raw));
  } catch {
    continue;
  }
  cards += 1;
  if (result.status === 'complete') {
    complete += 1;
    continue;
  }
  const missing = result.missing ?? [];
  const tags = Array.isArray(raw.keywords) ? raw.keywords : [];
  // Every keyword this card waits on, so a card blocked by two is counted
  // honestly against both and lands in neither `sole` column.
  const gaps = new Map();
  for (const entry of missing) {
    const swept = KEYWORD_ABILITY_REASON.exec(entry.missingEngineSystem ?? '');
    if (swept) {
      gaps.set(mechanicOf(swept[1]), swept[1]);
      continue;
    }
    const clause = (entry.text ?? '').toLowerCase();
    for (const tag of tags) {
      const word = tag.toLowerCase();
      if (new RegExp(`^${escapeRegExp(word)}\\b`).test(clause)) gaps.set(mechanicOf(tag), tag);
    }
  }
  for (const [mechanic, printed] of gaps) {
    const bucket = stats.get(mechanic) ?? { blocked: 0, sole: 0, printed: new Set(), examples: [] };
    bucket.blocked += 1;
    bucket.printed.add(printed);
    if (missing.length === 1) {
      bucket.sole += 1;
      if (bucket.examples.length < 4) bucket.examples.push(raw.name);
    }
    stats.set(mechanic, bucket);
  }
}

const ranked = [...stats.entries()].sort(
  (a, b) => b[1].sole - a[1].sole || b[1].blocked - a[1].blocked,
);

console.log(`${cards} cards compiled · ${complete} complete · ${cards - complete} incomplete`);
console.log(`
KEYWORD ABILITIES THIS COMPILER DOES NOT IMPLEMENT, ranked by cards each ALONE blocks.

  sole    = the card's ONE missing clause is this keyword's printed line.
            Implement the keyword and the card becomes playable.
            THIS IS THE WORK-PICKING COLUMN.
  blocked = cards carrying the keyword that also need something else. They come
            along for free once their other gap closes.
`);
console.log('  sole  blocked  keyword');
for (const [mechanic, b] of ranked.slice(0, TOP)) {
  console.log(
    `  ${String(b.sole).padStart(4)}  ${String(b.blocked).padStart(7)}  ${mechanic}` +
      (b.examples.length ? `   (${b.examples.slice(0, 3).join(', ')})` : ''),
  );
}
const soleTotal = ranked.reduce((sum, [, b]) => sum + b.sole, 0);
console.log(
  `\n${ranked.length} keyword abilities are unimplemented; ${soleTotal} cards are blocked by one ALONE.`,
);
