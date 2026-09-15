/**
 * XVALUE BLAME — which HALF of an {X}/derived-value line the compiler refuses.
 *
 * The backlog row *"an {X} or derived-value template the compiler does not
 * recognize yet"* names ~954 cards, and `gap-clauses.mjs` immediately gives the
 * §3.120 answer: 880 distinct shapes, 1.08 cards per shape. Another bucket.
 *
 * But §3.147 established that a row's NAME can point at the wrong half of the
 * problem, and that ranking the survivors on a SEMANTIC axis finds the family
 * the shape histogram hides. This asks that question for this row, because an
 * amount-bearing sentence is TWO things:
 *
 *   1. the SENTENCE  — "~ deals <AMOUNT> damage to any target"
 *   2. the AMOUNT    — "X", or "equal to its power"
 *
 * and the row cannot tell you which one has no rule. So each blocked clause is
 * re-probed with its amount REWRITTEN TO A PLAIN NUMBER through a closed table
 * of rewrites (`AMOUNT_REWRITES`). If the rewritten clause compiles, the
 * sentence was always known and only the AMOUNT vocabulary is missing — that is
 * this family's real work. If it still fails, the sentence itself has no rule
 * and the card sits in this row only because its text contains "equal to";
 * widening the amount vocabulary would not move it.
 *
 * TWO TRAPS THIS SCRIPT EXISTS BECAUSE OF, both of which produced a wrong
 * answer the first time it was run:
 *
 *  - **The probe must wear the CARD'S OWN TYPE LINE.** Probing every clause on
 *    a vanilla creature reports "Draw 3 cards." and "~ deals 3 damage to target
 *    creature." as sentence gaps — they are not, they are SPELL lines and the
 *    compiler is right to refuse them on a creature. That one mistake moved
 *    hundreds of clauses into the wrong bucket.
 *  - **A rewrite must INSERT a number, never delete the amount.** Stripping
 *    "equal to the number of snow permanents you control" off Skred leaves
 *    "~ deals damage to target creature." — a sentence with no amount at all,
 *    which fails for a reason the real card does not have.
 *
 * The rewrite table is CLOSED (rule 2): a clause no row can rewrite is reported
 * as `NOT-REWRITABLE`, never guessed at, because a bad rewrite silently moves a
 * card between the two buckets this script exists to keep apart.
 *
 * Usage: node packages/cards/scripts/xvalue-blame.mjs <corpus.json> [--top N]
 */
import { readFileSync } from 'node:fs';
import { normalizeCard } from '@jonny-boi/data-tools';
import { compileCard } from '@jonny-boi/cards';

const SYSTEM = '{X} or derived-value';
const corpusPath = process.argv[2];
if (!corpusPath) {
  console.error('usage: node packages/cards/scripts/xvalue-blame.mjs <corpus.json> [--top N]');
  process.exit(2);
}
const rest = process.argv.slice(3);
const topAt = rest.indexOf('--top');
const TOP = topAt >= 0 ? Number(rest[topAt + 1]) : 40;
const corpus = JSON.parse(readFileSync(corpusPath, 'utf8'));

/** Collapse a printed clause to its shape — numbers and the card's own name vary, the template does not. */
const shapeOf = (t) => t.replace(/\{[^}]*\}/g, '{}').replace(/\b\d+\b/g, 'N').replace(/\s+/g, ' ').trim();

/** The amount phrase a row consumes: up to the end of the clause, never across one. */
const NP = '[^.,;:]+';

/**
 * The closed rewrite table: each row turns ONE printed way of spelling a
 * variable amount into the plain number 3, so the SENTENCE can be probed on its
 * own. Every row INSERTS the number where the printed amount stood. Order
 * matters — the "where X is" binding is stripped before the X slots are filled,
 * so "deals X damage …, where X is the number of …" is rewritten once, whole.
 */
const AMOUNT_REWRITES = [
  // --- the {X} spellings -------------------------------------------------
  { name: 'where-X-is', re: /,?\s*where X is [^.]*/gi, to: '' },
  { name: 'X-slot-pt', re: /([+-])X\/([+-])X/g, to: '$13/$23' },
  { name: 'X-slot-pt', re: /([+-])X\/([+-])(\d+)/g, to: '$13/$2$3' },
  { name: 'X-slot-pt', re: /([+-])(\d+)\/([+-])X/g, to: '$1$2/$33' },
  { name: 'X-slot', re: /\{X\}/g, to: '{3}' },
  { name: 'X-slot', re: /\bX\b/g, to: '3' },
  // --- "deals <AMOUNT> damage to <RECIPIENT>", both printed orders -------
  { name: 'deals-damage-equal-to', re: new RegExp(`\\bdeals damage equal to ${NP} to\\b`, 'gi'), to: 'deals 3 damage to' },
  { name: 'deals-damage-to-R-equal-to', re: new RegExp(`\\bdeals damage to (${NP}) equal to ${NP}`, 'gi'), to: 'deals 3 damage to $1' },
  { name: 'deals-damage-to-itself', re: new RegExp(`\\bdeals damage to itself equal to ${NP}`, 'gi'), to: 'deals 3 damage to itself' },
  // --- life -------------------------------------------------------------
  { name: 'gain-life-equal-to', re: new RegExp(`\\bgains? life equal to ${NP}`, 'gi'), to: 'gain 3 life' },
  { name: 'lose-life-equal-to', re: new RegExp(`\\bloses? life equal to ${NP}`, 'gi'), to: 'lose 3 life' },
  // --- cards ------------------------------------------------------------
  { name: 'draw-equal-to', re: new RegExp(`\\bdraws? (?:a number of )?cards equal to ${NP}`, 'gi'), to: 'draw 3 cards' },
  { name: 'mill-equal-to', re: new RegExp(`\\bmills? (?:a number of )?cards equal to ${NP}`, 'gi'), to: 'mill 3 cards' },
  // --- tokens & counters ------------------------------------------------
  { name: 'tokens-equal-to', re: new RegExp(`\\ba number of (${NP}) tokens equal to ${NP}`, 'gi'), to: '3 $1 tokens' },
  { name: 'counters-equal-to', re: new RegExp(`\\ba number of (${NP}) counters (on ${NP} )?equal to ${NP}`, 'gi'), to: '3 $1 counters $2' },
  // --- mana -------------------------------------------------------------
  { name: 'mana-amount-equal-to', re: new RegExp(`\\bAdd an amount of (\\{[^}]*\\}) equal to ${NP}`, 'gi'), to: 'Add $1$1$1' },
];

/** Apply the table; report which rows fired, so "no row matched" stays visible. */
const rewriteAmount = (text) => {
  let out = text;
  const fired = [];
  for (const row of AMOUNT_REWRITES) {
    const next = out.replace(row.re, row.to);
    if (next !== out) fired.push(row.name);
    out = next;
  }
  out = out.replace(/\s+/g, ' ').replace(/\s+([.,;])/g, '$1').trim();
  // A leftover "equal to" means no row understood this amount — say so rather
  // than probe a sentence that still carries the thing under test.
  return { out, fired, leftover: /\bequal to\b/i.test(out) || /\bX\b/.test(out) };
};

const probeCard = (raw, oracleText) => {
  const norm = normalizeCard(raw);
  return { ...norm, id: `probe:${norm.name}`, oracleText };
};
const memo = new Map();
const compiles = (raw, text, typeKey) => {
  const key = `${typeKey}|${text}`;
  if (memo.has(key)) return memo.get(key);
  let ok = false;
  try {
    ok = compileCard(probeCard(raw, text)).status === 'complete';
  } catch {
    ok = false;
  }
  memo.set(key, ok);
  return ok;
};

/** Which spelling of a variable amount does this clause use? Cards can use both. */
const flavourOf = (text) => {
  const hasX = /\bX\b/.test(text);
  const hasEqual = /\bequal to\b/i.test(text);
  if (hasX && hasEqual) return 'both';
  if (hasX) return 'X';
  if (hasEqual) return 'equal-to';
  return 'neither';
};

/** The AMOUNT PHRASE itself — the vocabulary axis. "equal to its power" → "its power". */
const amountPhrases = (text) => {
  const out = [];
  for (const m of text.matchAll(/\bequal to ([^.,;]+)/gi)) out.push(m[1].trim().toLowerCase());
  const where = text.match(/\bwhere X is ([^.]+)/i);
  if (where) out.push(`(where X is) ${where[1].trim().toLowerCase()}`);
  return out;
};

const bump = (map, key, sole, name) => {
  const e = map.get(key) ?? { sole: 0, also: 0, names: [] };
  if (sole) e.sole += 1;
  else e.also += 1;
  if (e.names.length < 5) e.names.push(name);
  map.set(key, e);
};

const amountOnly = new Map(); // sentence compiles once the amount is a number
const sentenceGap = new Map(); // still fails with a plain number — not this family's work
const notRewritable = new Map(); // no rewrite row matched — reported, never guessed
const phrases = new Map(); // the amount vocabulary, ranked
const amountOnlyPhrases = new Map(); // the vocabulary, restricted to cards ONLY the amount blocks
const byFlavour = { X: 0, 'equal-to': 0, both: 0, neither: 0 };
let cards = 0;
let soleCards = 0;
let clauses = 0;

for (const raw of corpus) {
  let r;
  try {
    r = compileCard(normalizeCard(raw));
  } catch {
    continue;
  }
  if (r.status === 'complete') continue;
  const missing = r.missing ?? [];
  const mine = missing.filter((m) => (m.missingEngineSystem ?? '').includes(SYSTEM));
  if (mine.length === 0) continue;
  cards += 1;
  const sole = mine.length === missing.length;
  if (sole) soleCards += 1;
  const typeKey = raw.type_line ?? '';
  for (const m of mine) {
    const text = (m.text ?? '').trim();
    clauses += 1;
    byFlavour[flavourOf(text)] += 1;
    const found = amountPhrases(text);
    for (const p of found) bump(phrases, p, sole, raw.name);
    const { out, fired, leftover } = rewriteAmount(text);
    if (fired.length === 0 || leftover) bump(notRewritable, shapeOf(text), sole, raw.name);
    else if (compiles(raw, out, typeKey)) {
      bump(amountOnly, shapeOf(text), sole, raw.name);
      for (const p of found) bump(amountOnlyPhrases, p, sole, raw.name);
    } else bump(sentenceGap, shapeOf(out), sole, raw.name);
  }
}

const total = (m) => [...m.values()].reduce((a, e) => a + e.sole + e.also, 0);
const soleTotal = (m) => [...m.values()].reduce((a, e) => a + e.sole, 0);
console.log(`${cards} cards (${soleCards} blocked by this system ALONE) · ${clauses} clauses`);
console.log(`\nHOW THE AMOUNT IS SPELLED`);
for (const [k, v] of Object.entries(byFlavour)) console.log(`  ${k.padEnd(10)} ${String(v).padStart(5)} clauses`);
console.log(`\nWHICH HALF HAS NO RULE (probe: same sentence on the CARD'S OWN type line, amount rewritten to a plain number)`);
console.log(`  AMOUNT only — sentence compiles with a number : ${total(amountOnly)} clauses / ${amountOnly.size} shapes (${soleTotal(amountOnly)} on sole-blocked cards)`);
console.log(`  SENTENCE gap — still fails with a number      : ${total(sentenceGap)} clauses / ${sentenceGap.size} shapes (${soleTotal(sentenceGap)} on sole-blocked cards)`);
console.log(`  NOT-REWRITABLE — no rewrite row matched       : ${total(notRewritable)} clauses / ${notRewritable.size} shapes`);

const dump = (label, m, n) => {
  console.log(`\n=== ${label} — top ${n} ===`);
  console.log('  sole  also  key');
  for (const [k, e] of [...m].sort((a, b) => b[1].sole + b[1].also - (a[1].sole + a[1].also)).slice(0, n))
    console.log(`${String(e.sole).padStart(6)} ${String(e.also).padStart(5)}  ${k.slice(0, 110)}   [${e.names.slice(0, 3).join(' | ')}]`);
};
dump('AMOUNT VOCABULARY (all clauses) — the phrase after "equal to" / "where X is"', phrases, TOP);
dump('AMOUNT VOCABULARY on AMOUNT-ONLY clauses — implement the phrase and the sentence already works', amountOnlyPhrases, TOP);
dump('SENTENCE gaps — a different family wearing this row', sentenceGap, 25);
dump('NOT-REWRITABLE', notRewritable, 25);
