/**
 * MASS-MODIFICATION BLAME — which HALF of a mass until-end-of-turn line the
 * compiler refuses, and how far outside its own backlog row the family lives.
 *
 * The acceptance card (Craterhoof Behemoth) was filed under the generic *"a rules
 * template"* catch-all while its nearest sibling (Overrun) sat in *"a static-buff
 * template"* — two different rows for one printed family, which is §8a item 3 and
 * §7c item 5 happening again. So this script does what `modal-blame.mjs` does:
 * it takes the population **by TEXT**, reports which rows those cards are actually
 * filed under, and only then asks what refuses.
 *
 * A mass modification is up to FOUR things, and the row can tell you none of them:
 *
 *   NOUN     "creatures|permanents|artifacts|… you control" — a row of
 *            `STATIC_NOUN_TYPES`. "Dinosaurs you control" (a subtype) and
 *            "OTHER/ATTACKING creatures you control" (a narrower set) are not,
 *            and must stay refused: reaching them is the STRONGER-than-printed
 *            direction §1a says nothing else guards.
 *   ORDER    "gain KW and get +P/+T" vs "get +P/+T and gain KW" vs either alone —
 *            a row of `MASS_EOT_MODIFICATIONS`.
 *   KEYWORD  a row of `KEYWORD_FLAGS` / a payload keyword.
 *   AMOUNT   a printed number, or an X bound by a "where X is …" clause whose
 *            phrase is a row of `DERIVED_COUNTS`.
 *
 * ⚠️ THREE TRAPS THIS SCRIPT IS WRITTEN AROUND
 *
 *  - **A blame script can report a false ZERO and it looks like a finding**
 *    (§7c item 7 — `protect-blame.mjs` read `result.unsupported` when the field is
 *    `result.missing`). So this one prints its DENOMINATORS first — corpus size,
 *    population by text, and the rows the population is filed under — and every
 *    bucket count is checked against a total that cannot be zero.
 *  - **The probe must wear the card's own TYPE LINE and its own PREFIX.** A mass
 *    line printed inside a trigger ("When ~ enters, creatures you control …") is a
 *    different question from the same line printed as a spell. This script never
 *    re-probes a fragment on a synthetic body: it reads what the REAL card
 *    refused, and only substitutes into the card's own refused clause.
 *  - **A substitution probe is worthless unless the FILLER is proven.** Before
 *    blaming an axis, the same clause with every axis replaced by a known-good
 *    value must COMPILE in this card's own harness. When it does not, the card is
 *    reported NOT-PROBEABLE rather than bucketed on a result that means nothing.
 *
 * Usage: node packages/cards/scripts/masspump-blame.mjs <corpus.json> [--examples N]
 */
import { readFileSync } from 'node:fs';
import { normalizeCard } from '@jonny-boi/data-tools';
import { compileCard, explainUnsupported } from '@jonny-boi/cards';

const corpusPath = process.argv[2];
if (!corpusPath) {
  console.error('usage: node packages/cards/scripts/masspump-blame.mjs <corpus.json> [--examples N]');
  process.exit(2);
}
const argv = process.argv.slice(3);
const exAt = argv.indexOf('--examples');
const EXAMPLES = exAt >= 0 ? Number(argv[exAt + 1]) : 6;

const corpus = JSON.parse(readFileSync(corpusPath, 'utf8'));

/**
 * The family BY TEXT. Deliberately wider than the compiler's own pattern — it
 * matches any noun, including the subtypes and the "other"/"attacking" narrowings
 * the compiler must refuse — because the question this script answers is *how big
 * is the printed family*, not *what do we already support*. Measuring with the
 * implementation's own regex would make the answer true by construction.
 */
const FAMILY =
  /\b(?:[a-z]+ )?[a-z]+s (?:you control|your opponents control) (?:get|gain)\b[^.]*?\buntil end of turn\b/i;

/** A line inside a card's printed text that matches {@link FAMILY}, or null. */
function familyLine(text) {
  for (const line of (text ?? '').split('\n')) {
    if (FAMILY.test(line)) return line;
  }
  return null;
}

// --- DENOMINATORS FIRST (§7c item 7 / §8a item 8) ----------------------------------

const population = corpus.filter((c) => familyLine(c.oracle_text) !== null);
console.log(`corpus                        ${corpus.length}`);
console.log(`family BY TEXT                ${population.length}`);
if (population.length === 0) {
  console.error('\n!! EMPTY POPULATION — the family regex matched nothing. Every bucket below');
  console.error('   would read 0 for that reason alone. Fix the regex before believing anything.');
  process.exit(1);
}

const compiled = new Map();
for (const raw of population) {
  try {
    compiled.set(raw.name, compileCard(normalizeCard(raw)));
  } catch (e) {
    compiled.set(raw.name, { status: 'threw', missing: [], error: String(e && e.message) });
  }
}

const complete = population.filter((c) => compiled.get(c.name)?.status === 'complete');
const threw = population.filter((c) => compiled.get(c.name)?.status === 'threw');
console.log(`  of those, COMPLETE today    ${complete.length}`);
console.log(`  of those, THREW             ${threw.length}`);
console.log(`  of those, still BLOCKED     ${population.length - complete.length - threw.length}`);

// --- which backlog ROWS is the family filed under? (§7c item 5) --------------------
//
// The second number is the one that says whether the row is a family at all: if
// the population is scattered across a dozen rows, selecting by hint would have
// measured the wrong set in both directions.

const byRow = new Map();
for (const raw of population) {
  const result = compiled.get(raw.name);
  if (!result || result.status === 'complete' || result.status === 'threw') continue;
  const line = familyLine(raw.oracle_text);
  // The row this card's FAMILY clause is filed under — not the card's first
  // refusal, which may belong to an entirely different sentence.
  const own = (result.missing ?? []).find((m) => FAMILY.test(m.text ?? ''));
  const row = own?.missingEngineSystem ?? (line === null ? '(no family line)' : '(no family refusal — blocked elsewhere)');
  byRow.set(row, (byRow.get(row) ?? 0) + 1);
}
console.log('\n=== the rows the STILL-BLOCKED half is filed under ===');
for (const [row, n] of [...byRow.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(5)}  ${row}`);
}

// --- BLAME the blocked ones -------------------------------------------------------

/**
 * Rewrite one axis of a printed mass line to a value known to be supported, so the
 * clause can be re-asked with exactly one unknown removed.
 *
 * Every substitution stays inside the card's OWN clause and the card is then
 * recompiled WHOLE — its real type line, its real trigger prefix, its real other
 * sentences. Nothing is probed on a synthetic body.
 */
const SUBSTITUTIONS = Object.freeze({
  // "Dinosaurs you control" / "Other creatures you control" → the plain noun.
  NOUN: (line) => line.replace(/^\s*•?\s*(?:[A-Za-z]+ )*?([A-Za-z]+)s you control\b/i, 'Creatures you control'),
  // any keyword list → trample, which is a row of KEYWORD_FLAGS.
  KEYWORD: (line) => line.replace(/\bgains? [^.]*?(?= and get| until end of turn)/i, 'gain trample'),
  // any pump amount, derived or not, → a printed +1/+1, and drop a "where X is".
  AMOUNT: (line) =>
    line
      .replace(/[+-](?:\d+|[Xx])\/[+-](?:\d+|[Xx])/, '+1/+1')
      .replace(/,? where [Xx] is [^.]*/i, ''),
});

/** All three at once — the FILLER. If this does not compile, the harness failed. */
function fullyKnown(line) {
  return SUBSTITUTIONS.AMOUNT(SUBSTITUTIONS.KEYWORD(SUBSTITUTIONS.NOUN(line)));
}

/** Recompile `raw` with its family line replaced by `line`; true when nothing refuses it. */
function familyClauseCompiles(raw, line) {
  const original = familyLine(raw.oracle_text);
  if (original === null) return false;
  const patched = { ...raw, oracle_text: (raw.oracle_text ?? '').replace(original, line) };
  let result;
  try {
    result = compileCard(normalizeCard(patched));
  } catch {
    return false;
  }
  // Only this clause's fate matters: a card blocked by an unrelated sentence is
  // still evidence about THIS one.
  return !(result.missing ?? []).some((m) => FAMILY.test(m.text ?? ''));
}

const buckets = { NOUN: [], KEYWORD: [], AMOUNT: [], 'ORDER-or-SENTENCE': [], 'NOT-PROBEABLE': [] };
let soleBlocked = 0;

for (const raw of population) {
  const result = compiled.get(raw.name);
  if (!result || result.status === 'complete' || result.status === 'threw') continue;
  const line = familyLine(raw.oracle_text);
  const own = (result.missing ?? []).find((m) => FAMILY.test(m.text ?? ''));
  if (!own) continue; // this card's family clause already compiles; something else blocks it
  if ((result.missing ?? []).length === 1) soleBlocked += 1;

  // THE FILLER CHECK — prove the harness before trusting any axis.
  if (!familyClauseCompiles(raw, fullyKnown(line))) {
    buckets['NOT-PROBEABLE'].push(raw.name);
    continue;
  }
  let blamed = null;
  for (const axis of ['NOUN', 'KEYWORD', 'AMOUNT']) {
    // Replace ONLY this axis. If the clause now compiles, this axis was the blocker.
    if (familyClauseCompiles(raw, SUBSTITUTIONS[axis](line))) {
      blamed = axis;
      break;
    }
  }
  buckets[blamed ?? 'ORDER-or-SENTENCE'].push(raw.name);
}

console.log(`\nstill-blocked cards whose FAMILY clause refuses   ${Object.values(buckets).reduce((n, b) => n + b.length, 0)}`);
console.log(`  of those, SOLE-blocked (nothing else refuses)  ${soleBlocked}`);
console.log('\n=== WHICH HALF REFUSES ===');
for (const [name, list] of Object.entries(buckets)) {
  console.log(`\n${name}: ${list.length}`);
  for (const n of list.slice(0, EXAMPLES)) {
    const raw = population.find((c) => c.name === n);
    console.log(`    - ${n}: ${JSON.stringify(familyLine(raw?.oracle_text) ?? '')}`);
  }
}

/**
 * NOT-PROBEABLE is the biggest bucket and it must not stay opaque, or the next
 * lane reads it as "344 cards of mass-modification work left" when most of it is
 * not this family at all.
 *
 * A card lands here when the line carrying its mass clause ALSO refuses for a
 * reason that has nothing to do with the mass clause — an ability word, a modal
 * bullet, a "for each …" quantifier, a kicked condition. The mass half may well
 * be understood; the harness simply cannot ask, because probing the clause on its
 * own would answer a question the card does not print (the trap `modal-blame.mjs`
 * names). So instead of guessing, this counts the WRAPPERS by their printed
 * markers: each count is a pointer at the family that actually owns those cards.
 *
 * ⚠️ These are printed MARKERS, not verdicts, and they overlap — one line can
 * carry a bullet and an ability word. The total is deliberately not made to add up.
 */
const WRAPPER_MARKERS = Object.freeze({
  'modal bullet (•)': /^\s*•/,
  'ability word (— prefix)': /^[^.•]{3,40} — /,
  'a trigger prefix': /^(?:when|whenever|at the beginning)\b/i,
  'a "for each …" quantifier': /\bfor each\b/i,
  'a kicked / conditional prefix': /\bif (?:this spell was kicked|you|an opponent)\b/i,
  'an activation cost prefix': /^[^.]*?:\s/,
  'a second subject ("X and Y you control")': /\b(?:you|[a-z]+s) and [a-z]+s you control\b/i,
});
console.log('\n=== inside NOT-PROBEABLE: what ELSE is on that line ===');
console.log(`  (${buckets['NOT-PROBEABLE'].length} cards; markers overlap, so these do not sum)`);
for (const [label, re] of Object.entries(WRAPPER_MARKERS)) {
  const n = buckets['NOT-PROBEABLE'].filter((name) => {
    const raw = population.find((c) => c.name === name);
    return re.test((familyLine(raw?.oracle_text) ?? '').trim());
  }).length;
  console.log(`  ${String(n).padStart(5)}  ${label}`);
}

// `explainUnsupported` is imported so a future reader can print the row text for a
// hint id without re-deriving the mapping; referenced here so the import is live.
void explainUnsupported;
