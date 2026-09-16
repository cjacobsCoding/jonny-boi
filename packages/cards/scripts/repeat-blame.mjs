/**
 * REPEAT BLAME — is the gap the ITERATION, or the BODIES being iterated?
 *
 * `repeat this process` is an ITERATIVE effect: a printed instruction to run the
 * sentences before it again. Primal Surge is the acceptance card for it, and the
 * backlog files Primal Surge under *"a 'you may / choose' template"* — a row
 * whose name points at the half that already works (§8a item 2, and §7b item 2
 * names this card by name). So the row cannot be trusted in either direction and
 * this script measures the family by its own TEXT instead.
 *
 * ## The split, and why it is exactly two buckets
 *
 * An iterative clause is two things, and the compiler refuses the WHOLE clause
 * the moment either fails:
 *
 *   1. the ITERATION — the printed repeat sentence and the rule that decides how
 *      many times the body runs ("If you do…", "once", "until…", "any number of
 *      times", "for first strike, double strike, …");
 *   2. the BODY — every sentence before it, compiled exactly as it would be
 *      without the repeat.
 *
 * So each blocked clause has its repeat sentence DELETED from the card's own
 * printed text, and the card is recompiled:
 *
 *   ITERATION   the line compiles once the repeat sentence is gone. The body has
 *               rules; the loop is the whole gap. This is the only bucket that is
 *               iteration machinery.
 *   BODY        the line still refuses without the repeat sentence. The card sits
 *               in this family only because it prints the word "repeat"; the work
 *               lives in whatever family that sentence belongs to, and this bucket
 *               is ranked BY that family so it can be sent there.
 *   NOT-PROBEABLE  no repeat sentence in {@link REPEAT_FORMS} could be removed
 *               from the line. Reported by name, never bucketed on a guess.
 *
 * ## Three traps this script is written around
 *
 *  - **The probe must wear the card's own TYPE LINE AND PREFIX.** `modal-blame`
 *    was written around that trap and `xvalue-blame` was bitten by it. Deleting
 *    the sentence from the CARD's text and recompiling the CARD is how this one
 *    avoids it: the trigger condition, the activation cost, the loyalty cost and
 *    the Saga chapter all stay exactly where the printed card puts them, because
 *    nothing is rebuilt.
 *  - **`UNSUPPORTED_HINTS` IS FIRST-MATCH.** There is no "iteration" row at all,
 *    so every card in this family is filed under some other row — which rows, and
 *    how many, is printed below and is the number that says whether selecting by
 *    hint could ever have found this family. (It could not: the answer is 0.)
 *  - **A blame script can report a false ZERO and it looks like a finding**
 *    (§7c item 7). So the population is printed FIRST, from the text, before any
 *    bucket — a run that says "0 iteration gaps" over 0 cards is a broken script,
 *    and a run that says it over 44 is a result.
 *
 * Usage: node packages/cards/scripts/repeat-blame.mjs <corpus.json> [--top N]
 */
import { readFileSync } from 'node:fs';
import { normalizeCard } from '@jonny-boi/data-tools';
import { compileCard } from '@jonny-boi/cards';

const corpusPath = process.argv[2];
if (!corpusPath) {
  console.error('usage: node packages/cards/scripts/repeat-blame.mjs <corpus.json> [--top N]');
  process.exit(2);
}
const rest = process.argv.slice(3);
const topAt = rest.indexOf('--top');
const TOP = topAt >= 0 ? Number(rest[topAt + 1]) : 30;
const corpus = JSON.parse(readFileSync(corpusPath, 'utf8'));

/** Collapse a printed clause to its shape — numbers and card names vary, the template does not. */
const shapeOf = (t) =>
  t.replace(/\{[^}]*\}/g, '{}').replace(/\b\d+\b/g, 'N').replace(/\s+/g, ' ').trim();

/**
 * HOW THE POPULATION IS SELECTED — by TEXT, several ways, because a family
 * measured one way is a family measured by a regex (§8a item 3).
 *
 * The widest (`/\brepeat\b/i`) is the denominator every narrower row is checked
 * against: a narrow pattern that matches as many cards as the wide one has not
 * found a family, it has found the whole word.
 */
const TEXT_SELECTORS = Object.freeze([
  ['repeat this process', /repeat this process/i],
  ['repeat that process', /repeat that process/i],
  ['repeat the following process', /repeat the following process/i],
  ['repeat this|that (not "process")', /repeat (?:this|that)\b(?! process)/i],
  ['for each … repeat', /for each .{0,80}\brepeat\b/i],
  ['ANY "repeat" (the denominator)', /\brepeat\b/i],
]);

/**
 * THE PRINTED ITERATION VOCABULARY — a CLOSED table of the repeat sentences this
 * script can recognize and remove, each with the iteration KIND it prints.
 *
 * Closed on purpose (project rule 2): a printed repeat form outside this table
 * is reported as NOT-PROBEABLE by its own shape rather than being widened into
 * the nearest row that happens to exist. That is also what makes the table a
 * measurement of the vocabulary: the `kind` column ranked over the corpus is
 * exactly the list of iteration rules a compiler would need, in size order.
 *
 * Ordered longest-context-first: "If you do, repeat this process." must be
 * removed WITH its condition, not leave a dangling "If you do," behind.
 */
const REPEAT_FORMS = Object.freeze([
  // --- the iteration carries its own condition ------------------------------
  { kind: 'conditional', re: /\s*(?:then\s+)?if [^.]*?,\s*(?:you may\s+)?repeat this process(?: once| \w+ more times)?\./gi },
  { kind: 'conditional', re: /\s*,?\s*(?:and|then)\s+repeat this process(?: once| \w+ more times)?\./gi },
  // --- a bounded count ------------------------------------------------------
  { kind: 'fixed-count', re: /\s*(?:then\s+)?repeat this process (?:once|twice|\w+ more times?|x more times?)\./gi },
  { kind: 'prefix-count', re: /^repeat the following process (?:x|\w+) times?\.\s*/gi },
  // --- a stopping condition -------------------------------------------------
  { kind: 'until', re: /\s*repeat this process until [^.]*\./gi },
  // --- the player decides how many times ------------------------------------
  { kind: 'optional-any', re: /\s*(?:that (?:opponent|player)|you) may repeat this process (?:any number of times|as many times as (?:they|you) choose)\./gi },
  // --- the repeat names a LIST to run the body over -------------------------
  { kind: 'list', re: /\s*(?:then\s+)?repeat this process for [^.]*\./gi },
  // --- the bare sentence, last: everything above is a narrowing of it -------
  { kind: 'bare', re: /\s*(?:then\s+)?repeat this process\./gi },
]);

/** Does this printed text print an iteration at all? Asked of the CARD, not of a row. */
const looksIterative = (t) => /\brepeat\b/i.test(t);

/**
 * Delete the repeat sentence from `text`, or `null` when no form in the closed
 * table matched. Returns the KIND too, so the vocabulary can be ranked.
 */
function stripRepeat(text) {
  for (const { kind, re } of REPEAT_FORMS) {
    re.lastIndex = 0;
    if (!re.test(text)) continue;
    re.lastIndex = 0;
    const stripped = text.replace(re, ' ').replace(/\s+/g, ' ').replace(/\s+\./g, '.').trim();
    if (stripped.length === 0 || stripped === text.trim()) continue;
    return { kind, stripped };
  }
  return null;
}

const probeCard = (raw, oracleText) => {
  const norm = normalizeCard(raw);
  return { ...norm, id: `probe:${norm.name}`, oracleText };
};

/** Compile `text` as this card's whole printed text. Never throws. */
function compileAs(raw, text) {
  try {
    return compileCard(probeCard(raw, text));
  } catch {
    return null;
  }
}

const bump = (map, key, sole, name) => {
  const e = map.get(key) ?? { sole: 0, also: 0, names: [] };
  if (sole) e.sole += 1;
  else e.also += 1;
  if (e.names.length < 6) e.names.push(name);
  map.set(key, e);
};

// --- the buckets ------------------------------------------------------------
const iterationGap = new Map(); // the body compiles; the LOOP is the gap
const bodyGap = new Map(); // the body has no rule — another family wearing this row
const bodyGapFamily = new Map(); // body gaps ranked BY the family that owns them
const notProbeable = new Map(); // no closed-table repeat form matched; never guessed
const iterationKinds = new Map(); // the printed iteration vocabulary, ranked
const filedUnder = new Map(); // which UNSUPPORTED_HINTS row each card lands in
const cardShapes = new Map(); // the §3.120 artifact check
/** Cards the whole of which compiles once the repeat sentence is removed. */
const wouldUnblock = [];
/** Cards blocked ONLY by their repeat line, which still need other work. */
const iterationSoleLine = [];

const byText = new Map(TEXT_SELECTORS.map(([k]) => [k, 0]));
let blockedIterative = 0;
let clauses = 0;

for (const raw of corpus) {
  const printed = raw.oracle_text ?? '';
  if (!looksIterative(printed)) continue;
  for (const [k, re] of TEXT_SELECTORS) if (re.test(printed)) byText.set(k, byText.get(k) + 1);

  const base = compileAs(raw, printed);
  if (base === null || base.status === 'complete') continue;
  blockedIterative += 1;
  const missing = base.missing ?? [];
  const mine = missing.filter((m) => looksIterative(m.text ?? ''));
  const sole = mine.length > 0 && mine.length === missing.length;
  for (const m of mine) bump(filedUnder, m.missingEngineSystem ?? '?', sole, raw.name);
  if (mine.length === 0) {
    // The word "repeat" is on the card but not in any REFUSED clause — the
    // iteration compiled, or it sits in reminder text the compiler strips.
    bump(notProbeable, 'the word "repeat" is not in any refused clause', sole, raw.name);
    continue;
  }

  const strip = stripRepeat(printed);
  if (strip === null) {
    bump(notProbeable, `no closed-table repeat form: ${shapeOf(mine[0].text).slice(0, 100)}`, sole, raw.name);
    continue;
  }
  bump(iterationKinds, strip.kind, sole, raw.name);

  const without = compileAs(raw, strip.stripped);
  if (without === null) {
    bump(notProbeable, 'the card THREW without its repeat sentence', sole, raw.name);
    continue;
  }
  if (without.status === 'complete') wouldUnblock.push(raw.name);

  for (const m of mine) {
    clauses += 1;
    bump(cardShapes, shapeOf(m.text), sole, raw.name);
    // Is the SAME printed line still refused with the repeat sentence gone?
    const stillBlocked = (without.missing ?? []).find(
      (w) => shapeOf(stripRepeat(w.text)?.stripped ?? w.text) === shapeOf(stripRepeat(m.text)?.stripped ?? m.text),
    );
    if (stillBlocked === undefined) {
      bump(iterationGap, `${strip.kind}: ${shapeOf(m.text).slice(0, 96)}`, sole, raw.name);
      if (sole && without.status !== 'complete') iterationSoleLine.push(raw.name);
    } else {
      bump(bodyGap, shapeOf(stillBlocked.text).slice(0, 110), sole, raw.name);
      bump(bodyGapFamily, stillBlocked.missingEngineSystem ?? '?', sole, raw.name);
    }
  }
}

const total = (m) => [...m.values()].reduce((a, e) => a + e.sole + e.also, 0);
const soleTotal = (m) => [...m.values()].reduce((a, e) => a + e.sole, 0);

// ⚠️ THE POPULATION FIRST (§7c item 7) — a zero below is only a finding if these
// are not zero too.
console.log(`corpus ${corpus.length} cards`);
console.log(`\nPOPULATION BY TEXT — there is no "iteration" hint row, so this is the only honest selector`);
for (const [k] of TEXT_SELECTORS) console.log(`  ${String(byText.get(k)).padStart(5)}  ${k}`);
console.log(`  ${String(blockedIterative).padStart(5)}  …of which BLOCKED (the denominator every bucket below divides)`);

console.log(`\n§3.120 ARTIFACT CHECK — cards per distinct shape`);
console.log(`  ${clauses} clauses / ${cardShapes.size} shapes = ${(clauses / Math.max(1, cardShapes.size)).toFixed(2)} per shape`);

console.log(`\nWHICH HALF HAS NO RULE (probe: the card's OWN text with its repeat sentence deleted)`);
console.log(`  ITERATION     — the body compiles; the LOOP is the gap  : ${total(iterationGap)} clauses / ${iterationGap.size} shapes (${soleTotal(iterationGap)} sole)`);
console.log(`  BODY          — still refused without the repeat         : ${total(bodyGap)} clauses / ${bodyGap.size} shapes (${soleTotal(bodyGap)} sole)`);
console.log(`  NOT-PROBEABLE — no closed-table form; never guessed at   : ${total(notProbeable)} clauses / ${notProbeable.size} shapes`);

console.log(`\n⭐ WOULD COMPLETE WITH ITERATION ALONE — ${wouldUnblock.length} card(s)`);
console.log(`   (the whole card compiles once the repeat sentence is removed; this is the`);
console.log(`    honest ceiling on what iteration machinery ALONE can deliver)`);
for (const n of wouldUnblock) console.log(`   + ${n}`);

const dump = (label, m, n) => {
  console.log(`\n=== ${label} — top ${n} ===`);
  console.log('  sole  also  key');
  for (const [k, e] of [...m].sort((a, b) => b[1].sole + b[1].also - (a[1].sole + a[1].also)).slice(0, n))
    console.log(`${String(e.sole).padStart(6)} ${String(e.also).padStart(5)}  ${k.slice(0, 104)}   [${e.names.slice(0, 3).join(' | ')}]`);
};
dump('FILED UNDER — the rows this family is scattered across (first-match hints)', filedUnder, 20);
dump('PRINTED ITERATION VOCABULARY — what a closed iteration table would need', iterationKinds, 20);
dump('ITERATION gaps — the only bucket that is iteration machinery', iterationGap, TOP);
dump("BODY gaps BY FAMILY — where this family's work actually lives", bodyGapFamily, 25);
dump('BODY gaps — the refused SHAPES once the repeat is gone', bodyGap, TOP);
dump('NOT-PROBEABLE', notProbeable, 12);
