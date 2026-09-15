/**
 * REPLACE BLAME — which half of a blocked CR 614 / CR 615 line the compiler refuses.
 *
 * The eighth blame tool, and it exists for the reason the other seven do: §8a
 * item 2 of `docs/ALL-CARDS-CAMPAIGN.md` measured that **the row's NAME pointed
 * at the wrong half in five of six lanes**, and twice it named a half that does
 * not exist at all. So this asks the question for the replacement/prevention
 * family BEFORE any rule is written.
 *
 * ## The split
 * Core's replacement layer (`core/src/replacement.ts`) is two closed
 * vocabularies bolted together, and a printed clause can fail on either:
 *
 *   1. **the EVENT KIND** — `ReplacementEventKind` is `damage | counters | draw
 *      | tokens`. A clause about anything else ("if you would GAIN LIFE", "if a
 *      creature would DIE", "if you would DISCARD") names an event the layer
 *      cannot watch. Adding one is a row in `REPLACEMENT_EVENT_KINDS`, a call
 *      site, and an answer in `affectedPlayerPrefersMore`.
 *   2. **the OUTCOME BODY** — `ReplacementOutcome` is `plus | times |
 *      preventAll | preventUpTo | preventHalfRoundedUp | winGame`. A clause
 *      that substitutes a DIFFERENT action or a DIFFERENT destination ("exile
 *      it instead", "that player skips that draw and you draw a card") is a
 *      whole other vocabulary, which `replacement.ts`'s own header says is
 *      deliberately NOT modelled.
 *
 * Those are completely different amounts of work and the row headline cannot
 * tell you which. Both numbers are printed side by side so neither can be
 * quoted as the other.
 *
 * ## Selection is by TEXT as well as by HINT, and that is load-bearing
 * ⚠️ `UNSUPPORTED_HINTS` is FIRST-MATCH. §7b of the campaign doc measured the
 * leakage on the copy family: selecting by clause TEXT found **691 cards against
 * 498 by hint — 193 cards of that shape sat in other rows**. A family selected
 * by hint alone is the wrong population in both directions, so this script
 * reports the hint population, the text population and their overlap.
 *
 * ## Every bucket is PROBED, never inferred
 * A clause is re-compiled ALONE on the card's OWN type line (a permanent stays
 * a permanent: `replacement-prevent-all-static` and `replacement-draw` both
 * refuse a non-permanent, so probing a static on a sorcery would report every
 * one of them as a gap that is not there). A clause that compiles alone but not
 * on its card is reported as PROBE PASSES — a contextual refusal — rather than
 * bucketed. A clause whose event kind no closed table recognises is reported as
 * NOT-PROBEABLE rather than being widened into the nearest bucket that exists.
 *
 * Usage: node packages/cards/scripts/replace-blame.mjs <corpus.json> [--top N]
 *
 * Offline and side-effect free. Reads the corpus; writes nothing.
 */
import { readFileSync } from 'node:fs';
import { normalizeCard } from '@jonny-boi/data-tools';
import { compileCard } from '@jonny-boi/cards';
import { REPLACEMENT_EVENT_KINDS } from '@jonny-boi/core';

const corpusPath = process.argv[2];
if (!corpusPath) {
  console.error('usage: node packages/cards/scripts/replace-blame.mjs <corpus.json> [--top N]');
  process.exit(2);
}
const rest = process.argv.slice(3);
const topAt = rest.indexOf('--top');
const TOP = topAt >= 0 ? Number(rest[topAt + 1]) : 30;
const corpus = JSON.parse(readFileSync(corpusPath, 'utf8'));

/** The kinds core's layer can watch right now, read from core so the two cannot drift. */
const SUPPORTED_KINDS = new Set(REPLACEMENT_EVENT_KINDS);

/**
 * WHICH EVENT a printed clause watches, as a CLOSED table keyed by the printed
 * phrase. Adding an event family is a ROW here, and a clause matching no row
 * REPORTS (`NOT-PROBEABLE`) instead of being bucketed into the nearest kind
 * that happens to exist — rule 2, closed tables over open guessing.
 *
 * Order matters only where one phrase is a prefix of another; the first match
 * wins, so the more specific phrase is listed first and that is noted inline.
 */
const EVENT_KIND_PHRASES = Object.freeze([
  // --- damage. "damage that would be dealt", "would deal damage", "would be dealt damage".
  [/\bdamage that would be dealt\b/, 'damage'],
  [/\bwould (?:deal|be dealt) (?:\S+ )?damage\b/, 'damage'],
  [/\bprevent (?:all|the next|that|half|any)\b[^.]*\bdamage\b/, 'damage'],
  // --- counters. Listed BEFORE the generic "would be put", whose phrase it contains.
  [/\bcounters? would be put\b/, 'counters'],
  [/\bwould (?:put|get) (?:one or more )?(?:[+\-−]?\d|[a-z]+ )?[+\-−][\d/+\-−]*\s*counters?\b/, 'counters'],
  [/\bwould be put on\b[^.]*\bcounters?\b/, 'counters'],
  // --- draws.
  [/\bwould draw\b/, 'draw'],
  // --- tokens.
  [/\bwould create\b[^.]*\btokens?\b/, 'tokens'],
  [/\btokens? would be created\b/, 'tokens'],
  // --- LIFE. Not in core's vocabulary today; this is what Rhox Faithmender needs.
  [/\bwould gain\b[^.]*\blife\b/, 'lifegain'],
  [/\bwould lose\b[^.]*\blife\b/, 'lifeloss'],
  // --- zone changes: the "exile it instead" / "die" family core's header
  //     explicitly excludes (a DESTINATION change, not a quantity).
  [/\bwould die\b/, 'dies'],
  [/\bwould be (?:put into|placed into)\b[^.]*\bgraveyard\b/, 'zoneToGraveyard'],
  [/\bwould be put into\b[^.]*\b(?:hand|library|exile)\b/, 'zoneOther'],
  [/\bwould (?:be exiled|exile)\b/, 'zoneExile'],
  [/\bwould (?:enter|be put onto the battlefield)\b/, 'entersBattlefield'],
  [/\bwould leave\b/, 'leavesBattlefield'],
  // --- everything else a printed "would" clause can name.
  [/\bwould (?:be )?discard\w*\b/, 'discard'],
  [/\bwould mill\b/, 'mill'],
  [/\bwould (?:be countered|counter)\b/, 'countered'],
  [/\bwould (?:be )?(?:untap|tap)\w*\b/, 'untapTap'],
  [/\bwould search\b/, 'search'],
  [/\bwould (?:be )?sacrific\w*\b/, 'sacrifice'],
  [/\bwould (?:be )?destroy\w*\b/, 'destroy'],
  [/\bwould (?:be )?(?:shuffle|reveal|scry|surveil)\w*\b/, 'libraryOther'],
  [/\bwould (?:be )?(?:copy|copied)\b/, 'copy'],
  [/\bwould (?:begin|skip|lose|win) the\b/, 'turnStructure'],
  [/\bwould (?:be )?attack\w*\b/, 'combatStructure'],
  [/\bwould pay\b/, 'payment'],
  [/\bwould (?:be )?(?:cast|put onto the stack)\b/, 'cast'],
  [/\bpoison counters?\b/, 'poison'],
]);

/**
 * WHAT the printed clause does to the event, as a CLOSED table. `supported`
 * says whether `ReplacementOutcome` can express it at all — the second half of
 * the split.
 */
const OUTCOME_PHRASES = Object.freeze([
  [/\bprevent (?:the next|up to)\b/, 'preventUpTo', true],
  [/\bprevent half\b/, 'preventHalfRoundedUp', true],
  [/\bprevent (?:all|that|any|the)\b/, 'preventAll', true],
  [/\bis(?:n't| not) prevented\b/, 'cannotBePrevented', false],
  [/\bwin the game instead\b/, 'winGame', true],
  [/\b(?:twice|double|triple|three times) that (?:much|many)\b/, 'times', true],
  [/\bthat (?:much|many) plus \w+\b/, 'plus', true],
  [/\bplus \w+ (?:instead|more)\b/, 'plus', true],
  [/\binstead\b/, 'otherInstead', false],
]);

/** The first table row whose phrase appears in the clause, or undefined. */
const firstMatch = (table, text) => {
  for (const row of table) if (row[0].test(text)) return row;
  return undefined;
};

/**
 * Collapse a printed clause to its SHAPE — numbers, mana symbols and the card's
 * own name vary, the template does not. The same normaliser every blame tool
 * uses, so their shape counts are comparable.
 */
const shapeOf = (t) =>
  t
    .replace(/\{[^}]*\}/g, '{}')
    .replace(/\b\d+\b/g, 'N')
    .replace(/\s+/g, ' ')
    .trim();

const base = {
  manaCost: { generic: 2, W: 0, U: 0, B: 0, R: 0, G: 0, C: 0, other: [] },
  keywords: [],
};

/**
 * A probe carrying ONE clause on the REAL card's type line.
 *
 * ⚠️ The type line is not cosmetic and this is the trap the script exists
 * because of: `replacement-prevent-all-static` and `replacement-draw` both call
 * `cardIsPermanent(ctx)` and return null on an instant or a sorcery. Probing
 * every clause on a generic creature (or on a sorcery) would report a whole
 * half of the family as a gap that is not there — the same defect
 * `loyalty-blame.mjs` documents for planeswalker probes.
 */
const clauseProbe = (raw, clause) => {
  const normalized = normalizeCard(raw);
  return {
    ...base,
    ...normalized,
    id: `probe:${raw.name}`,
    name: raw.name,
    oracleText: clause,
  };
};

const compiles = (card) => {
  try {
    return compileCard(card).status === 'complete';
  } catch {
    return false;
  }
};

const buckets = {
  kindGap: new Map(), // the EVENT KIND is outside core's closed vocabulary
  bodyGap: new Map(), // the kind is supported; the OUTCOME is not expressible
  sentenceGap: new Map(), // both halves are in the vocabulary — only the wording is missing
  notProbeable: new Map(), // no closed table recognises the event this clause watches
  probePasses: new Map(), // the clause compiles ALONE on this type line; the card fails elsewhere
};
const add = (bucket, key, name, sole) => {
  const e = bucket.get(key) ?? { sole: 0, also: 0, names: [], soleNames: [] };
  if (sole) {
    e.sole += 1;
    if (e.soleNames.length < 8) e.soleNames.push(name);
  } else e.also += 1;
  if (e.names.length < 8) e.names.push(name);
  bucket.set(key, e);
};

/** The hint row this family is named for, as `UNSUPPORTED_HINTS` spells it. */
const ROW_WORDS = /replacement|prevent/i;

/**
 * Selection by TEXT — the union the brief mandates, widened to the full CR
 * 614/615 shape. "if X would Y, Z instead" is the replacement template and
 * "prevent ..." is the prevention template; a clause is in the family when it
 * is one of those, regardless of which hint row first-match filed it under.
 */
const inFamilyByText = (t) =>
  (/\bwould\b/i.test(t) && /\binstead\b/i.test(t)) ||
  /\bprevent\b/i.test(t) ||
  /\bwould (?:be dealt|gain|lose|draw)\b/i.test(t);

let cardsBlocked = 0;
let familyCards = 0; // cards with >= 1 family clause
let familyCardsSole = 0; // cards blocked ONLY by family clauses — the winnable population
let familyClauses = 0;
let byHintCards = 0;
let byTextCards = 0;
let bothCards = 0;
let hintOnlyCards = 0;
let textOnlyCards = 0;
/** Which hint rows the TEXT-selected population actually lands in. */
const rowsHit = new Map();
/** Cards whose only blocker is one family clause, per EVENT KIND. */
const soleByKind = new Map();

for (const raw of corpus) {
  let result;
  try {
    result = compileCard(normalizeCard(raw));
  } catch {
    continue;
  }
  if (result.status === 'complete') continue;
  cardsBlocked += 1;
  const missing = result.missing ?? [];

  const byHint = missing.filter((m) => ROW_WORDS.test(m.missingEngineSystem ?? ''));
  const byText = missing.filter((m) => inFamilyByText(m.text ?? ''));
  if (byHint.length > 0) byHintCards += 1;
  if (byText.length > 0) byTextCards += 1;
  if (byHint.length > 0 && byText.length > 0) bothCards += 1;
  else if (byHint.length > 0) hintOnlyCards += 1;
  else if (byText.length > 0) textOnlyCards += 1;
  if (byText.length === 0) continue;

  familyCards += 1;
  // SOLE: every clause blocking this card is one of ours, so implementing the
  // family really would unblock the card. This is the cards-per-work number and
  // it is always smaller than the clause count — report the smaller one.
  const sole = byText.length === missing.length;
  if (sole) familyCardsSole += 1;

  for (const m of byText) {
    const text = (m.text ?? '').trim();
    const lower = text.toLowerCase();
    familyClauses += 1;
    const row = m.missingEngineSystem ?? '(none)';
    rowsHit.set(row, (rowsHit.get(row) ?? 0) + 1);

    const kindRow = firstMatch(EVENT_KIND_PHRASES, lower);
    if (kindRow === undefined) {
      add(buckets.notProbeable, shapeOf(text), raw.name, sole);
      continue;
    }
    const kind = kindRow[1];
    if (sole) soleByKind.set(kind, (soleByKind.get(kind) ?? 0) + 1);

    // The clause ALONE on this card's own type line. If it compiles here, the
    // real card's refusal is contextual and this clause is not the blocker.
    if (compiles(clauseProbe(raw, text))) {
      add(buckets.probePasses, shapeOf(text), raw.name, sole);
      continue;
    }

    const outcomeRow = firstMatch(OUTCOME_PHRASES, lower);
    const bodySupported = outcomeRow !== undefined && outcomeRow[2] === true;
    const kindSupported = SUPPORTED_KINDS.has(kind);

    if (!kindSupported) add(buckets.kindGap, kind, raw.name, sole);
    else if (!bodySupported) add(buckets.bodyGap, outcomeRow === undefined ? '(no outcome phrase)' : outcomeRow[1], raw.name, sole);
    else add(buckets.sentenceGap, shapeOf(text), raw.name, sole);
  }
}

const total = (m) => [...m.values()].reduce((a, e) => a + e.sole + e.also, 0);
const soleTotal = (m) => [...m.values()].reduce((a, e) => a + e.sole, 0);

console.log(`corpus: ${corpus.length} cards · ${cardsBlocked} blocked`);
console.log('');
console.log('=== SELECTION: by HINT vs by TEXT (UNSUPPORTED_HINTS is FIRST-MATCH) ===');
console.log(`  by HINT row (/replacement|prevent/) : ${byHintCards} cards`);
console.log(`  by TEXT (CR 614/615 shape)          : ${byTextCards} cards`);
console.log(`  in BOTH                             : ${bothCards}`);
console.log(`  HINT only (text does not look 614/615): ${hintOnlyCards}`);
console.log(`  TEXT only (filed under another row)   : ${textOnlyCards}   <-- the leakage`);
console.log('');
console.log(`FAMILY by text: ${familyCards} cards · ${familyClauses} clauses`);
console.log(`  of those, SOLE-blocked (this family is the card's ONLY blocker): ${familyCardsSole}`);
console.log('    ^ the honest cards-per-work number; every other card needs another lane too.');
console.log('');
console.log('=== THE SPLIT: event KINDS the layer cannot watch vs outcome BODIES it cannot do ===');
console.log(`  core watches: ${[...SUPPORTED_KINDS].join(', ')}`);
console.log(
  `  KIND gap  (event outside the closed 4) : ${total(buckets.kindGap)} clauses / ${buckets.kindGap.size} kinds · ${soleTotal(buckets.kindGap)} sole`,
);
console.log(
  `  BODY gap  (kind ok, outcome not expressible) : ${total(buckets.bodyGap)} clauses / ${buckets.bodyGap.size} shapes · ${soleTotal(buckets.bodyGap)} sole`,
);
console.log(
  `  SENTENCE gap (both halves ok, only the wording missing) : ${total(buckets.sentenceGap)} clauses / ${buckets.sentenceGap.size} shapes · ${soleTotal(buckets.sentenceGap)} sole`,
);
console.log(
  `  NOT-PROBEABLE (no closed row names this event) : ${total(buckets.notProbeable)} clauses / ${buckets.notProbeable.size} shapes`,
);
console.log(
  `  PROBE PASSES (clause compiles alone; card fails elsewhere) : ${total(buckets.probePasses)} clauses / ${buckets.probePasses.size} shapes`,
);

console.log('\n=== SOLE-BLOCKED CARDS BY EVENT KIND — what adding each kind would actually buy ===');
for (const [kind, n] of [...soleByKind].sort((a, b) => b[1] - a[1])) {
  console.log(`${String(n).padStart(5)}  ${kind}${SUPPORTED_KINDS.has(kind) ? '   (already watched)' : ''}`);
}

console.log('\n=== which HINT ROWS the TEXT-selected population lands in ===');
for (const [row, n] of [...rowsHit].sort((a, b) => b[1] - a[1]).slice(0, 20)) {
  console.log(`${String(n).padStart(5)}  ${row}`);
}

const dump = (label, m, n) => {
  console.log(`\n=== ${label} — top ${n} by clauses (${m.size} shapes) ===`);
  for (const [s, e] of [...m].sort((a, b) => b[1].sole + b[1].also - (a[1].sole + a[1].also)).slice(0, n)) {
    console.log(
      `${String(e.sole + e.also).padStart(5)} (${String(e.sole).padStart(4)} sole)  ${s.slice(0, 140)}   [${e.names.slice(0, 3).join(' | ')}]`,
    );
  }
};
dump('KIND gaps — the event kinds core cannot watch', buckets.kindGap, 30);
dump('BODY gaps — outcomes ReplacementOutcome cannot express', buckets.bodyGap, 20);
dump('SENTENCE gaps — CHEAPEST work: both halves exist, the wording does not', buckets.sentenceGap, TOP);
dump('NOT-PROBEABLE — reported, not bucketed', buckets.notProbeable, 20);
dump('PROBE PASSES — the clause is not this card\'s blocker', buckets.probePasses, 12);

// The two acceptance cards, named, so the script answers the question it was written for.
console.log('\n=== ACCEPTANCE CARDS ===');
for (const name of ['Rhox Faithmender', 'Fog Bank']) {
  const raw = corpus.find((c) => c.name === name);
  if (!raw) {
    console.log(`${name}: NOT IN THIS CORPUS`);
    continue;
  }
  let result;
  try {
    result = compileCard(normalizeCard(raw));
  } catch (err) {
    console.log(`${name}: THREW ${err}`);
    continue;
  }
  console.log(`${name}: ${result.status}`);
  for (const m of result.missing ?? []) {
    console.log(`   refused: ${JSON.stringify(m.text)}`);
    console.log(`   row    : ${m.missingEngineSystem}`);
  }
  // The printed text, so a partially-blocked card cannot read as done: a card
  // is ✅ only when EVERY printed ability compiles, and the refusals above are
  // meaningless without the sentences they are a subset of.
  console.log(`   printed: ${JSON.stringify(raw.oracle_text ?? '')}`);
}
