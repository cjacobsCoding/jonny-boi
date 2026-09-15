/**
 * Candidate SUB-FAMILIES inside the {X}/derived-value backlog, ranked by CARDS
 * a rule would make playable — not by clauses, which over-counts a card that
 * prints three blocked lines, and not by printed SHAPE, which
 * (`gap-clauses.mjs`: 880 shapes over 954 cards) says only "long tail".
 *
 * The axis here is the AMOUNT VOCABULARY — WHICH WAY the card spells its
 * variable number — because that is the axis a closed table is written on:
 *
 *   x-in-activation-cost   "{X}{R}{G}, {T}: … gets +X/+0 …"    (Kessig Wolf Run)
 *   where-X-is             "… deals X damage …, where X is …"
 *   object-characteristic  "… equal to ITS power / THAT CREATURE'S toughness"
 *   board-count            "… equal to the number of Mountains you control"
 *   event-amount           "… equal to the life lost this way"
 *   other-equal-to         everything else, kept visible rather than dropped
 *
 * A card is counted for a family ONLY when every clause blocking it belongs to
 * that family AND the same sentence compiles once the amount is a plain number
 * (`xvalue-blame.mjs` explains that probe, and the two type-line/rewrite traps
 * that made its first run wrong). So these counts are what the family is
 * WORTH — a card needing both a new amount and a new sentence is not claimed.
 *
 * Usage: node packages/cards/scripts/xvalue-families.mjs <corpus.json> [--cards]
 */
import { readFileSync } from 'node:fs';
import { normalizeCard } from '@jonny-boi/data-tools';
import { compileCard } from '@jonny-boi/cards';

const SYSTEM = '{X} or derived-value';
const corpusPath = process.argv[2];
if (!corpusPath) {
  console.error('usage: node packages/cards/scripts/xvalue-families.mjs <corpus.json> [--cards]');
  process.exit(2);
}
const SHOW_CARDS = process.argv.includes('--cards');
const corpus = JSON.parse(readFileSync(corpusPath, 'utf8'));

/** The characteristic-of-an-object spellings, as printed. */
const OBJECT_CHARACTERISTIC =
  /\bequal to (?:its|that creature's|that card's|that spell's|the sacrificed (?:creature|permanent)'s|~'s|the exiled card's) (?:power|toughness|mana value|mana cost)\b/i;
/** "…this way" — an amount carried by the event that just happened. */
const EVENT_AMOUNT = /\bequal to the (?:life lost|damage dealt|damage prevented|life gained)(?: to \w+)? this way\b/i;
const BOARD_COUNT = /\bequal to the number of\b/i;
const WHERE_X_IS = /,?\s*where X is\b/i;
/** `{X}` inside an ACTIVATION cost — the symbol before the colon of an activated line. */
const X_IN_ACTIVATION = /^[^:]*\{X\}[^:]*:/;

const FAMILIES = [
  { key: 'x-in-activation-cost', test: (t) => X_IN_ACTIVATION.test(t) },
  { key: 'where-X-is', test: (t) => WHERE_X_IS.test(t) },
  { key: 'object-characteristic', test: (t) => OBJECT_CHARACTERISTIC.test(t) },
  { key: 'event-amount', test: (t) => EVENT_AMOUNT.test(t) },
  { key: 'board-count', test: (t) => BOARD_COUNT.test(t) },
  { key: 'other-equal-to', test: (t) => /\bequal to\b/i.test(t) },
  { key: 'other-X', test: (t) => /\bX\b/.test(t) },
];
const familyOf = (text) => FAMILIES.find((f) => f.test(text))?.key ?? 'unclassified';

/** Rewrite every variable amount to the plain number 3 — see `xvalue-blame.mjs`. */
const NP = '[^.,;:]+';
const REWRITES = [
  [/,?\s*where X is [^.]*/gi, ''],
  [/([+-])X\/([+-])X/g, '$13/$23'],
  [/([+-])X\/([+-])(\d+)/g, '$13/$2$3'],
  [/([+-])(\d+)\/([+-])X/g, '$1$2/$33'],
  [/\{X\}/g, '{3}'],
  [/\bX\b/g, '3'],
  [new RegExp(`\\bdeals damage equal to ${NP} to\\b`, 'gi'), 'deals 3 damage to'],
  [new RegExp(`\\bdeals damage to (${NP}) equal to ${NP}`, 'gi'), 'deals 3 damage to $1'],
  [new RegExp(`\\bdeals damage to itself equal to ${NP}`, 'gi'), 'deals 3 damage to itself'],
  [new RegExp(`\\bgains? life equal to ${NP}`, 'gi'), 'gain 3 life'],
  [new RegExp(`\\bloses? life equal to ${NP}`, 'gi'), 'lose 3 life'],
  [new RegExp(`\\bdraws? (?:a number of )?cards equal to ${NP}`, 'gi'), 'draw 3 cards'],
  [new RegExp(`\\bmills? (?:a number of )?cards equal to ${NP}`, 'gi'), 'mill 3 cards'],
  [new RegExp(`\\ba number of (${NP}) tokens equal to ${NP}`, 'gi'), '3 $1 tokens'],
  [new RegExp(`\\ba number of (${NP}) counters (on ${NP} )?equal to ${NP}`, 'gi'), '3 $1 counters $2'],
  [new RegExp(`\\bAdd an amount of (\\{[^}]*\\}) equal to ${NP}`, 'gi'), 'Add $1$1$1'],
];
const rewrite = (text) => {
  let out = text;
  for (const [re, to] of REWRITES) out = out.replace(re, to);
  out = out.replace(/\s+/g, ' ').replace(/\s+([.,;])/g, '$1').trim();
  return { out, clean: !/\bequal to\b/i.test(out) && !/\bX\b/.test(out) };
};

const memo = new Map();
const sentenceCompiles = (raw, text) => {
  const key = `${raw.type_line ?? ''}|${text}`;
  if (memo.has(key)) return memo.get(key);
  let ok = false;
  try {
    const norm = normalizeCard(raw);
    ok = compileCard({ ...norm, id: `probe:${norm.name}`, oracleText: text }).status === 'complete';
  } catch {
    ok = false;
  }
  memo.set(key, ok);
  return ok;
};

/** cards whose WHOLE blocked set is one family and whose sentences already work. */
const winnable = new Map();
/** cards in the family whose sentence ALSO needs work — the family alone will not free them. */
const alsoNeedsSentence = new Map();
let soleCards = 0;

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
  if (mine.length === 0 || mine.length !== missing.length) continue; // SOLE blocker only
  soleCards += 1;

  const fams = new Set();
  let allSentencesOk = true;
  for (const m of mine) {
    const text = (m.text ?? '').trim();
    fams.add(familyOf(text));
    const { out, clean } = rewrite(text);
    if (!clean || !sentenceCompiles(raw, out)) allSentencesOk = false;
  }
  if (fams.size !== 1) continue; // a card needing two families is claimed by neither
  const key = [...fams][0];
  const bucket = allSentencesOk ? winnable : alsoNeedsSentence;
  const e = bucket.get(key) ?? { cards: [] };
  e.cards.push(raw.name);
  bucket.set(key, e);
}

console.log(`${soleCards} cards are blocked by "${SYSTEM}" ALONE\n`);
console.log('=== CARDS UNBLOCKED BY THE AMOUNT VOCABULARY ALONE (the sentence already compiles) ===');
console.log('  cards  family');
for (const [k, e] of [...winnable].sort((a, b) => b[1].cards.length - a[1].cards.length)) {
  console.log(`  ${String(e.cards.length).padStart(5)}  ${k}   [${e.cards.slice(0, 4).join(' | ')}]`);
  if (SHOW_CARDS) for (const n of e.cards) console.log(`           ${n}`);
}
console.log('\n=== SAME FAMILY, BUT THE SENTENCE ALSO HAS NO RULE (not freed by the amount alone) ===');
console.log('  cards  family');
for (const [k, e] of [...alsoNeedsSentence].sort((a, b) => b[1].cards.length - a[1].cards.length))
  console.log(`  ${String(e.cards.length).padStart(5)}  ${k}   [${e.cards.slice(0, 4).join(' | ')}]`);
