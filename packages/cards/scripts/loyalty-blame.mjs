/**
 * LOYALTY BLAME — which half of a blocked planeswalker line the compiler refuses.
 *
 * The backlog row *"a loyalty-ability template the compiler does not recognize
 * yet"* names ~300 cards. §3.147, §3.148 and §3.149 each found that a row's
 * NAME points at the wrong half of its problem, so this asks the question for
 * this row before any rule is written: is the gap the **loyalty COST /
 * activation machinery** (`+1:` / `−8:` — CR 606) or the **ability BODIES**,
 * which are ordinary effects that may already compile elsewhere?
 *
 * Those are completely different amounts of work and the row cannot tell you
 * which, so each blocked loyalty line is probed as three synthetic cards
 * through `compileCard` alone:
 *
 *   1. COST probe      `<COST>: Draw a card.`   on a PLANESWALKER
 *   2. WALKER-BODY     `+1: <BODY>`             on a PLANESWALKER
 *   3. ELSEWHERE       `<BODY>` as a SORCERY, and `{T}: <BODY>` on a creature
 *
 * A body that compiles at (3) but not at (2) is a LOYALTY-PATH gap — the
 * sentence is known and the walker route drops it. A body that compiles nowhere
 * is an EFFECT-TABLE gap and has nothing to do with loyalty.
 *
 * ⚠️ THE TRAP THIS SCRIPT EXISTS BECAUSE OF — **the probe must be a
 * PLANESWALKER with printed loyalty.** `compileLoyaltyAbility` refuses a `+1:`
 * line on anything that is not a planeswalker (on a creature a leading `+2:` is
 * not a loyalty cost), and a walker with no printed loyalty number reports a
 * `loyalty` gap of its own. Probing on the creature card `activated-blame.mjs`
 * uses would report EVERY loyalty line as a cost gap, which is the exact wrong
 * answer this script is here to avoid.
 *
 * ⚠️ THE POPULATION IS THE WALKERS, NOT THE ROW, and that is the second
 * finding. `UNSUPPORTED_HINTS` is FIRST-MATCH, and ~20 hints sit above the
 * loyalty one — `emblem`, `you may / choose`, `search your library`, `scry`,
 * `the chosen …`, `sacrifice`, `counters on`, `graveyard`. So a loyalty line
 * whose body says "you may" is filed under a DIFFERENT row, and the row's own
 * count is not the walker population. Jace, Architect of Thought is the worked
 * example: two of its three abilities land in the loyalty row and the ultimate
 * lands in "you may / choose". Sweeping by TYPE LINE is the only way to see the
 * whole card. Both numbers are printed, side by side, so neither can be quoted
 * as the other.
 *
 * Usage: node packages/cards/scripts/loyalty-blame.mjs <corpus.json> [--top N]
 *
 * Offline and side-effect free.
 */
import { readFileSync } from 'node:fs';
import { normalizeCard } from '@jonny-boi/data-tools';
import { compileCard } from '@jonny-boi/cards';

const corpusPath = process.argv[2];
if (!corpusPath) {
  console.error('usage: node packages/cards/scripts/loyalty-blame.mjs <corpus.json> [--top N]');
  process.exit(2);
}
const rest = process.argv.slice(3);
const topAt = rest.indexOf('--top');
const TOP = topAt >= 0 ? Number(rest[topAt + 1]) : 40;
const corpus = JSON.parse(readFileSync(corpusPath, 'utf8'));

/** The row this family is named for, as `UNSUPPORTED_HINTS` spells it. */
const ROW = 'loyalty-ability template';

const base = {
  manaCost: { generic: 2, W: 0, U: 1, B: 0, R: 0, G: 0, C: 0, other: [] },
  power: null,
  toughness: null,
  keywords: [],
};
/** A planeswalker probe — printed loyalty included, or the card reports a loyalty gap of its own. */
const walkerProbe = (name, oracleText) => ({
  ...base,
  id: `probe:pw:${name}`,
  typeLine: { supertypes: ['Legendary'], types: ['Planeswalker'], subtypes: ['Probe'] },
  loyalty: 4,
  name,
  oracleText,
});
/** A sorcery probe — asks whether the effect table knows the sentence at all. */
const sorceryProbe = (name, oracleText) => ({
  ...base,
  id: `probe:sc:${name}`,
  typeLine: { supertypes: [], types: ['Sorcery'], subtypes: [] },
  name,
  oracleText,
});
/** A creature probe — asks whether the sentence works as an ordinary activated body. */
const creatureProbe = (name, oracleText) => ({
  ...base,
  id: `probe:cr:${name}`,
  typeLine: { supertypes: [], types: ['Creature'], subtypes: ['Human'] },
  power: 2,
  toughness: 2,
  name,
  oracleText,
});

const compiles = (card) => {
  try {
    return compileCard(card).status === 'complete';
  } catch {
    return false;
  }
};
const memo = new Map();
const cached = (key, fn) => {
  if (!memo.has(key)) memo.set(key, fn());
  return memo.get(key);
};

/** Collapse a printed clause to its shape — numbers and the card's own name vary, the template does not. */
const shapeOf = (t) =>
  t
    .replace(/\{[^}]*\}/g, '{}')
    .replace(/\b\d+\b/g, 'N')
    .replace(/\s+/g, ' ')
    .trim();

/** A printed loyalty line: `+1: BODY`, `−2: BODY`, `0: BODY`. U+2212 is the printed minus. */
const LOYALTY_LINE = /^([+−-]?\d+):\s+(.+)$/s;

const buckets = {
  costGap: new Map(), // the SIGNED COST half has no rule
  loyaltyPath: new Map(), // body compiles elsewhere but not behind a loyalty cost
  bodyGap: new Map(), // body compiles nowhere — an effect-table gap
  notALoyaltyLine: new Map(), // a static/triggered/other line printed on a walker
  probePasses: new Map(), // both probes compile yet the real card does not
};
const add = (bucket, key, name, sole) => {
  const e = bucket.get(key) ?? { sole: 0, also: 0, names: [] };
  if (sole) e.sole += 1;
  else e.also += 1;
  if (e.names.length < 6) e.names.push(name);
  bucket.set(key, e);
};

let walkerCards = 0;
let walkerBlocked = 0;
let walkerClauses = 0;
/** Cards the ROW names, and how many of them are not planeswalkers at all. */
let rowCards = 0;
let rowNonWalker = 0;
/** Walkers blocked ONLY by clauses the row does NOT claim — invisible from the row. */
let walkerInvisibleToRow = 0;
/** Which rows the walker population's blocked clauses actually land in. */
const rowsHit = new Map();

for (const raw of corpus) {
  let result;
  try {
    result = compileCard(normalizeCard(raw));
  } catch {
    continue;
  }
  const missing = result.missing ?? [];
  const inRow = missing.filter((m) => (m.missingEngineSystem ?? '').includes(ROW));
  const isWalker = /\bPlaneswalker\b/.test(raw.type_line ?? raw.rawTypeLine ?? '');
  if (inRow.length > 0) {
    rowCards += 1;
    if (!isWalker) rowNonWalker += 1;
  }
  if (!isWalker) continue;
  walkerCards += 1;
  if (result.status === 'complete') continue;
  walkerBlocked += 1;
  if (inRow.length === 0) walkerInvisibleToRow += 1;

  const sole = false; // a walker is almost never blocked by one clause; reported per clause instead
  for (const m of missing) {
    const text = (m.text ?? '').trim();
    walkerClauses += 1;
    const row = m.missingEngineSystem ?? '(none)';
    rowsHit.set(row, (rowsHit.get(row) ?? 0) + 1);

    const line = LOYALTY_LINE.exec(text);
    if (!line) {
      add(buckets.notALoyaltyLine, shapeOf(text), raw.name, sole);
      continue;
    }
    const cost = line[1];
    const body = line[2].trim();
    const costOk = cached(`c|${cost}`, () => compiles(walkerProbe('Probe', `${cost}: Draw a card.`)));
    const walkerOk = cached(`w|${body}`, () => compiles(walkerProbe(raw.name, `+1: ${body}`)));
    const elsewhereOk = cached(
      `e|${body}`,
      () => compiles(sorceryProbe(raw.name, body)) || compiles(creatureProbe(raw.name, `{T}: ${body}`)),
    );

    if (!costOk) add(buckets.costGap, shapeOf(cost), raw.name, sole);
    else if (walkerOk) add(buckets.probePasses, shapeOf(text), raw.name, sole);
    else if (elsewhereOk) add(buckets.loyaltyPath, shapeOf(body), raw.name, sole);
    else add(buckets.bodyGap, shapeOf(body), raw.name, sole);
  }
}

const total = (m) => [...m.values()].reduce((a, e) => a + e.sole + e.also, 0);
console.log(`ROW "${ROW}": ${rowCards} cards, of which ${rowNonWalker} are NOT planeswalkers`);
console.log(
  `PLANESWALKERS in corpus: ${walkerCards} · blocked ${walkerBlocked} · ${walkerClauses} blocked clauses`,
);
console.log(
  `  of the blocked walkers, ${walkerInvisibleToRow} have NO clause in the row at all (first-match hints filed them elsewhere)`,
);
console.log('');
console.log(`  COST half unknown (the signed cost) : ${total(buckets.costGap)} clauses / ${buckets.costGap.size} shapes`);
console.log(`  LOYALTY-PATH gap (body compiles elsewhere, not behind a loyalty cost)`);
console.log(`                                     : ${total(buckets.loyaltyPath)} clauses / ${buckets.loyaltyPath.size} shapes`);
console.log(`  BODY gap (no effect rule anywhere)  : ${total(buckets.bodyGap)} clauses / ${buckets.bodyGap.size} shapes`);
console.log(`  NOT a loyalty line (static/trigger) : ${total(buckets.notALoyaltyLine)} clauses / ${buckets.notALoyaltyLine.size} shapes`);
console.log(`  PROBE PASSES but the card does not  : ${total(buckets.probePasses)} clauses / ${buckets.probePasses.size} shapes`);

console.log('\n=== which ROWS the walker population actually lands in ===');
for (const [row, n] of [...rowsHit].sort((a, b) => b[1] - a[1]).slice(0, 20)) {
  console.log(`${String(n).padStart(5)}  ${row}`);
}

const dump = (label, m, n) => {
  console.log(`\n=== ${label} — top ${n} by clauses (${m.size} shapes) ===`);
  for (const [s, e] of [...m].sort((a, b) => b[1].sole + b[1].also - (a[1].sole + a[1].also)).slice(0, n)) {
    console.log(`${String(e.sole + e.also).padStart(5)}  ${s.slice(0, 150)}   [${e.names.slice(0, 3).join(' | ')}]`);
  }
};
dump('COST shapes refused', buckets.costGap, 20);
dump('LOYALTY-PATH gaps (cheapest work if non-empty)', buckets.loyaltyPath, TOP);
dump('BODY gaps — the effect table has no sentence', buckets.bodyGap, TOP);
dump('NOT loyalty lines — statics/triggers on walkers', buckets.notALoyaltyLine, 25);
dump('PROBE PASSES — investigate, the probe disagrees with the card', buckets.probePasses, 15);
