/**
 * THE OUT-OF-SCOPE SET — how many printed cards this engine will never play, and why.
 *
 * Every other measurement in this repo counts what the compiler CAN do and ranks the
 * gap. This one bounds the other end: the cards that are not gaps at all, because they
 * depend on an object a 60-card, 1v1, deterministic, no-sideboard engine does not model.
 * Without it, "all mechanics functional" has no finish line — 100% is not the target and
 * pretending it is makes every progress report dishonest.
 *
 * ⚠️ IT REPORTS AN UPPER BOUND, ON PURPOSE. This is a text-pattern count, and it
 * over-counts in a direction that does NOT flatter the project: some matched cards are
 * already implemented exactly (myriad matches the multiplayer pattern, and CR 702.116
 * with one opponent means the ability does nothing — which §3.107 compiles as the printed
 * rule, not as an approximation), and others are merely deferred rather than refused.
 * So the real never-list is SMALLER than the number printed here. Read it as "at most N
 * cards are out of scope", never as "N cards are impossible".
 *
 * The categories are a CLOSED table: a card falls in the first one it matches and is
 * counted once, so the totals add up and adding a category cannot double-count.
 *
 * Usage: node packages/cards/scripts/out-of-scope-report.mjs <corpus.json> [--list <category>]
 */
import { readFileSync } from 'node:fs';

const corpusPath = process.argv[2];
if (!corpusPath) {
  console.error('usage: node packages/cards/scripts/out-of-scope-report.mjs <corpus.json> [--list <category>]');
  process.exit(2);
}
const listAt = process.argv.indexOf('--list');
const LIST = listAt >= 0 ? (process.argv[listAt + 1] ?? '').toLowerCase() : undefined;
const corpus = JSON.parse(readFileSync(corpusPath, 'utf8'));

/**
 * Why each category is out of scope, stated on the row rather than in a comment, so a
 * reader of the output gets the reason with the number.
 */
const CATEGORIES = [
  {
    name: 'commander / colour identity / partner',
    why: 'reads a commander — an object a 60-card 1v1 engine has no concept of',
    pattern: /\bcommander\b|color identity|\bpartner\b|choose a Background|doctor's companion/i,
  },
  {
    name: 'multiplayer-only',
    why: 'monarch, the initiative, dungeons, teammates, "each other player" — there is no third seat',
    pattern: /\bmonarch\b|\bthe initiative\b|venture into the dungeon|\bteammate\b|each other player|two or more opponents|\bmelee\b|\bmyriad\b/i,
  },
  {
    name: 'dice',
    why: 'a second RNG stream, against an engine whose whole value is comparable A/B runs',
    pattern: /roll (a|an|two|\d+|that many) (six-sided )?(dice|die|d\d)|\bd20\b|planar die/i,
  },
  { name: 'coin flips', why: 'same reasoning as dice', pattern: /flip a coin|flip (two|three|\d+) coins|won the flip/i },
  {
    name: 'outside the game / sideboard / wishes',
    why: 'needs a sideboard model AND a tournament rule for "outside the game"',
    pattern: /outside the game|from your sideboard|\bwish\b/i,
  },
];

const hits = new Map(CATEGORIES.map((c) => [c.name, []]));
for (const card of corpus) {
  const faces = (card.card_faces ?? []).map((f) => f.oracle_text ?? '');
  const all = [card.oracle_text ?? '', ...faces, (card.keywords ?? []).join(' ')].join('\n');
  for (const category of CATEGORIES) {
    if (category.pattern.test(all)) {
      hits.get(category.name).push(card.name);
      break;
    }
  }
}

if (LIST !== undefined) {
  const match = CATEGORIES.find((c) => c.name.toLowerCase().includes(LIST));
  if (!match) {
    console.error(`no category matching "${LIST}"; try one of:\n  ${CATEGORIES.map((c) => c.name).join('\n  ')}`);
    process.exit(2);
  }
  for (const name of hits.get(match.name)) console.log(name);
  process.exit(0);
}

console.log(`${corpus.length} cards in the corpus\n`);
console.log('  cards  category');
let total = 0;
for (const category of CATEGORIES) {
  const names = hits.get(category.name);
  total += names.length;
  console.log(`${String(names.length).padStart(7)}  ${category.name} — ${category.why}`);
  console.log(`           e.g. ${names.slice(0, 4).join(', ')}`);
}
const share = ((total / corpus.length) * 100).toFixed(1);
console.log(`\n${String(total).padStart(7)}  AT MOST out of scope (${share}% of the corpus)`);
console.log(`${String(corpus.length - total).padStart(7)}  the finish line — cards this engine should eventually play in full`);
console.log('\nUpper bound, not a never-list: see the header comment for why it over-counts.');
