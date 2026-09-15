/**
 * COPYSEL BLAME — which HALF of a copy-creating line the compiler refuses.
 *
 * The backlog row *"a copy-creating template outside the compiler's closed
 * tables"* names ~299 cards, and `docs/ALL-CARDS-CAMPAIGN.md` §3 files it as a
 * NEAR-MISS: "the copy system, token copies and delayed sacrifice tails are ALL
 * implemented; three named selectors remain". That annotation is a claim about
 * WHICH HALF is missing, and the row itself cannot check it.
 *
 * §3.147 established that a row's NAME can point at the wrong half, and §3.148
 * that a clause failing in more than one place needs each place probed
 * SEPARATELY or a brief spends itself on the smaller half. A copy-creating
 * sentence is three things:
 *
 *   1. the VERB      — "create a token that's a copy of", "have ~ enter as a
 *                      copy of", "copy target …", "becomes a copy of"
 *   2. the SELECTOR  — WHAT is copied: "target creature", "a creature token you
 *                      control", "another target nonland permanent you control"
 *   3. the TAIL      — how the copy DIFFERS or what happens to it after:
 *                      ", except it has haste", ". It gains haste.",
 *                      ". Sacrifice it at the beginning of the next end step"
 *
 * and the row cannot tell you which one has no rule. So each blocked clause is
 * re-probed three ways through `compileCard`, black-box, with a CLOSED table of
 * rewrites:
 *
 *   SELECTOR-NEUTRAL — the printed selector swapped for one the compiler's own
 *                      closed table already carries, tails kept. Compiles ⇒ the
 *                      SELECTOR is the whole gap. That is "selection".
 *   TAIL-NEUTRAL     — every trailing tail stripped, the printed selector kept.
 *                      Compiles ⇒ the TAIL is the whole gap. That is "copy
 *                      fidelity" — what the copy is, not what it points at.
 *   BOTH-NEUTRAL     — known selector AND no tails. Still fails ⇒ the SENTENCE
 *                      itself has no rule and the card is in this row only
 *                      because its text contains the word "copy"; widening the
 *                      selector vocabulary would not move it.
 *
 * THREE TRAPS THIS SCRIPT IS WRITTEN AROUND, inherited from `xvalue-blame.mjs`
 * which paid for the first two:
 *
 *  - **The probe must wear the CARD'S OWN TYPE LINE.** A spell line probed on a
 *    vanilla creature is refused for a reason the real card does not have.
 *  - **A rewrite must SUBSTITUTE, never delete, the part under test.** Deleting
 *    the selector leaves "create a token that's a copy of." — a sentence with no
 *    object at all, which fails for its own reason.
 *  - **The tail strip must be ANCHORED TO THE END and longest-first**, in the
 *    same order `buildTokenCopy` parses them, or a selector containing a comma
 *    is mistaken for an "except" clause. Anything the table cannot take apart is
 *    reported `NOT-REWRITABLE` rather than guessed at (rule 2, closed tables):
 *    a bad rewrite silently moves a card between the buckets this script exists
 *    to keep apart.
 *
 * ⚠️ **`UNSUPPORTED_HINTS` IS FIRST-MATCH, so a row's membership is hint ORDER,
 * not meaning.** Pass `--scan` to ignore the row entirely and select clauses by
 * their own TEXT (any clause of any blocked card that mentions copying), which
 * is the only way to see the cards of this shape that other rows have claimed.
 * Populate is exactly such a card: its copy words live in reminder text, which
 * `stripReminderText` removes before any hint is tried.
 *
 * Usage: node packages/cards/scripts/copysel-blame.mjs <corpus.json> [--top N] [--scan]
 */
import { readFileSync } from 'node:fs';
import { normalizeCard } from '@jonny-boi/data-tools';
import { compileCard } from '@jonny-boi/cards';

const SYSTEM = 'copy';
const corpusPath = process.argv[2];
if (!corpusPath) {
  console.error('usage: node packages/cards/scripts/copysel-blame.mjs <corpus.json> [--top N] [--scan]');
  process.exit(2);
}
const rest = process.argv.slice(3);
const topAt = rest.indexOf('--top');
const TOP = topAt >= 0 ? Number(rest[topAt + 1]) : 40;
/** Select clauses by their own TEXT rather than by which hint row claimed them. */
const SCAN = rest.includes('--scan');
const corpus = JSON.parse(readFileSync(corpusPath, 'utf8'));

/** Collapse a printed clause to its shape — numbers and the card's own name vary, the template does not. */
const shapeOf = (t) =>
  t
    .replace(/\{[^}]*\}/g, '{}')
    .replace(/\b\d+\b/g, 'N')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * The printed COPY VERBS, each with the substitute SELECTOR the compiler's own
 * closed table is known to carry for that verb. A CLOSED table: a copy verb no
 * row names is `NOT-REWRITABLE`, never approximated onto a neighbouring verb,
 * because "copy target creature" and "copy target spell" are answered by two
 * different rules and swapping one for the other reports the wrong half.
 *
 * `re` captures the selector and everything after it; `known` is the selector
 * substituted in. Each `known` is verified against the live compiler by
 * `assertKnownSelectorsCompile` below — a substitute the compiler has since
 * stopped accepting would file every clause as a SENTENCE gap, silently.
 */
const COPY_VERBS = [
  {
    name: 'create-token-copy',
    re: /\b((?:creates?|create) (?:a|an|one|two|three|four|five) (?:tapped |tapped and attacking )?(?:tokens? that'?s a copy|tokens that are copies) of )(.+)$/i,
    known: 'target creature',
    probe: "Create a token that's a copy of target creature.",
  },
  {
    name: 'enter-as-copy',
    re: /\b((?:you may have )?~ enters?(?: tapped)? as a copy of )(.+)$/i,
    known: 'any creature on the battlefield',
    probe: 'You may have ~ enter as a copy of any creature on the battlefield.',
  },
  {
    name: 'becomes-a-copy',
    re: /\b(.+ becomes? a copy of )(.+)$/i,
    known: 'target creature',
    probe: null, // no rule exists for this verb at all; see BECOMES_A_COPY below
  },
  {
    name: 'copy-spell',
    re: /\b(copy )((?:target|that) .+)$/i,
    known: 'target instant or sorcery spell',
    probe: 'Copy target instant or sorcery spell. You may choose new targets for the copy.',
  },
];

/**
 * The printed TAILS, anchored to the END and stripped LONGEST-ANCHORED FIRST in
 * the same order `buildTokenCopy` parses them. Each row names the tail it
 * removes so "no tail was present" stays distinguishable from "a tail was
 * removed and it changed nothing".
 */
const COPY_TAILS = [
  { name: 'delayed-removal', re: /\. (?:sacrifice|exile) (?:it|them|that token|those tokens|this token) at the beginning of the next end step$/i },
  { name: 'grant-sentence', re: /\. (?:it|they|that token|those tokens) gains? [a-z' ]+?(?: until end of turn)?$/i },
  { name: 'kicked-count', re: /\. if this spell was kicked, create (?:a|an|one|two|three|four|five) of those tokens instead$/i },
  { name: 'new-targets', re: /\. you may choose new targets for the copy$/i },
  { name: 'except', re: /, except .+$/i },
];

/** Strip every trailing tail the table knows, reporting which fired. */
const stripTails = (text) => {
  let out = text.trim();
  const fired = [];
  let moved = true;
  while (moved) {
    moved = false;
    for (const tail of COPY_TAILS) {
      const next = out.replace(tail.re, '');
      if (next !== out) {
        fired.push(tail.name);
        out = next.trim();
        moved = true;
      }
    }
  }
  return { out: out.replace(/[.,;]\s*$/, '').trim(), fired };
};

/** Which copy verb does this clause print? `null` when none of the closed rows match. */
const verbOf = (text) => {
  for (const verb of COPY_VERBS) {
    const m = text.match(verb.re);
    if (m) return { verb, head: m[1], selector: m[2] };
  }
  return null;
};

/** Does this clause talk about copying at all? The `--scan` membership test. */
const MENTIONS_COPY = /\bcop(?:y|ies|ied)\b|\bpopulate\b/i;

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

const bump = (map, key, sole, name) => {
  const e = map.get(key) ?? { sole: 0, also: 0, names: [] };
  if (sole) e.sole += 1;
  else e.also += 1;
  if (e.names.length < 6) e.names.push(name);
  map.set(key, e);
};

const selectorGap = new Map(); // known selector ⇒ compiles. SELECTION is the whole gap.
const tailGap = new Map(); // tails stripped ⇒ compiles. COPY FIDELITY is the whole gap.
const bothGap = new Map(); // needs both. Selection AND fidelity.
const sentenceGap = new Map(); // neither helps — the sentence has no rule.
const notRewritable = new Map(); // no verb row matched — reported, never guessed.
const selectorVocab = new Map(); // the SELECTOR phrases, ranked — the selection axis.
const selectorOnlyVocab = new Map(); // ...restricted to clauses only the selector blocks.
const tailVocab = new Map(); // the TAIL kinds present on tail-blocked clauses.
const byVerb = new Map();
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
  const mine = SCAN
    ? missing.filter((m) => MENTIONS_COPY.test(m.text ?? ''))
    : missing.filter((m) => (m.missingEngineSystem ?? '').toLowerCase().includes(SYSTEM));
  if (mine.length === 0) continue;
  cards += 1;
  const sole = mine.length === missing.length;
  if (sole) soleCards += 1;
  const typeKey = raw.type_line ?? '';
  for (const m of mine) {
    const text = (m.text ?? '').trim();
    clauses += 1;
    const parsed = verbOf(text);
    if (parsed === null) {
      bump(notRewritable, shapeOf(text), sole, raw.name);
      continue;
    }
    byVerb.set(parsed.verb.name, (byVerb.get(parsed.verb.name) ?? 0) + 1);
    // The SELECTOR phrase, with its own tails stripped so the vocabulary axis
    // ranks "a creature token you control", not "…, except it has haste".
    const bareSelector = stripTails(parsed.selector).out.toLowerCase();
    bump(selectorVocab, bareSelector, sole, raw.name);

    // Probe 1 — SELECTOR-NEUTRAL: known selector, tails kept.
    const selectorNeutral = `${parsed.head}${parsed.selector.replace(stripTails(parsed.selector).out, parsed.verb.known)}`;
    const okSelector = compiles(raw, selectorNeutral, typeKey);
    // Probe 2 — TAIL-NEUTRAL: printed selector, tails stripped.
    const stripped = stripTails(parsed.selector);
    const tailNeutral = `${parsed.head}${stripped.out}`;
    const okTail = stripped.fired.length > 0 && compiles(raw, tailNeutral, typeKey);
    // Probe 3 — BOTH-NEUTRAL: known selector AND no tails.
    const bothNeutral = `${parsed.head}${parsed.verb.known}`;
    const okBoth = compiles(raw, bothNeutral, typeKey);

    if (okSelector) {
      bump(selectorGap, shapeOf(text), sole, raw.name);
      bump(selectorOnlyVocab, bareSelector, sole, raw.name);
    } else if (okTail) {
      bump(tailGap, shapeOf(text), sole, raw.name);
      for (const t of stripped.fired) bump(tailVocab, t, sole, raw.name);
    } else if (okBoth) {
      bump(bothGap, shapeOf(text), sole, raw.name);
      bump(selectorOnlyVocab, bareSelector, sole, raw.name);
      for (const t of stripped.fired) bump(tailVocab, t, sole, raw.name);
    } else {
      bump(sentenceGap, shapeOf(text), sole, raw.name);
    }
  }
}

/**
 * The substitute selectors are only meaningful if the compiler actually accepts
 * them. Checked against a real card from the corpus rather than asserted, so a
 * table that has drifted says so instead of filing every clause as a SENTENCE
 * gap — the failure mode `10-verification.md` calls a check that cannot fail.
 */
const vanilla = corpus.find((c) => c.name === 'Grizzly Bears') ?? corpus.find((c) => (c.type_line ?? '').startsWith('Creature'));
const instant = corpus.find((c) => (c.type_line ?? '').startsWith('Instant'));
console.log('SUBSTITUTE-SELECTOR SELF-CHECK (a probe the compiler refuses would file every clause as a SENTENCE gap)');
for (const verb of COPY_VERBS) {
  if (verb.probe === null) {
    console.log(`  ${verb.name.padEnd(20)} (no probe — no rule exists for this verb at all)`);
    continue;
  }
  const host = verb.name === 'copy-spell' ? instant : vanilla;
  const ok = host ? compiles(host, verb.probe, host.type_line ?? '') : false;
  console.log(`  ${verb.name.padEnd(20)} ${ok ? 'OK  ' : 'FAIL'}  ${verb.probe}`);
}

const total = (m) => [...m.values()].reduce((a, e) => a + e.sole + e.also, 0);
const soleTotal = (m) => [...m.values()].reduce((a, e) => a + e.sole, 0);
console.log(`\n${cards} cards (${soleCards} blocked by this system ALONE) · ${clauses} clauses · selection by ${SCAN ? 'CLAUSE TEXT (--scan)' : 'HINT ROW'}`);
console.log(`\nWHICH COPY VERB`);
for (const [k, v] of [...byVerb].sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(20)} ${String(v).padStart(5)} clauses`);
console.log(`\nWHICH HALF HAS NO RULE (probe: same sentence on the CARD'S OWN type line)`);
console.log(`  SELECTION  — known selector, tails kept ⇒ compiles : ${total(selectorGap)} clauses / ${selectorGap.size} shapes (${soleTotal(selectorGap)} sole)`);
console.log(`  FIDELITY   — printed selector, tails stripped ⇒ ok  : ${total(tailGap)} clauses / ${tailGap.size} shapes (${soleTotal(tailGap)} sole)`);
console.log(`  BOTH       — needs a known selector AND no tails    : ${total(bothGap)} clauses / ${bothGap.size} shapes (${soleTotal(bothGap)} sole)`);
console.log(`  SENTENCE   — neither helps; no rule for the verb    : ${total(sentenceGap)} clauses / ${sentenceGap.size} shapes (${soleTotal(sentenceGap)} sole)`);
console.log(`  NOT-REWRITABLE — no copy-verb row matched           : ${total(notRewritable)} clauses / ${notRewritable.size} shapes`);

const dump = (label, m, n) => {
  console.log(`\n=== ${label} — top ${n} ===`);
  console.log('  sole  also  key');
  for (const [k, e] of [...m].sort((a, b) => b[1].sole + b[1].also - (a[1].sole + a[1].also)).slice(0, n))
    console.log(`${String(e.sole).padStart(6)} ${String(e.also).padStart(5)}  ${k.slice(0, 108)}   [${e.names.slice(0, 3).join(' | ')}]`);
};
dump('SELECTOR VOCABULARY (all clauses) — what the copy points at', selectorVocab, TOP);
dump('SELECTOR VOCABULARY on SELECTION-ONLY clauses — add the row and the sentence already works', selectorOnlyVocab, TOP);
dump('TAIL KINDS on fidelity-blocked clauses', tailVocab, 12);
dump('FIDELITY gaps — the printed selector is known, a tail is not', tailGap, 20);
dump('SENTENCE gaps — a different family wearing this row', sentenceGap, 20);
dump('NOT-REWRITABLE', notRewritable, 20);
