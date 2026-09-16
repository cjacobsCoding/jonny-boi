/**
 * WALKER-BLAME (DESIGN §3.153) — the eighth blame tool, after `activated-`,
 * `targeted-`, `counters-`, `xvalue-`, `loyalty-`, `modal-`, `copysel-` and
 * `protect-`.
 *
 *   node packages/cards/scripts/walker-blame.mjs [path/to/expansion-report.json]
 *
 * ## What it measures, and why these five families
 * §3.150 left five residues pinned by name on the two walkers in
 * `docs/decks/tamiyo-jace-surge.txt`. This prints the corpus population behind
 * each one, so the next lane picks from data rather than from the residue's
 * description — which in four of five cases named something smaller or different
 * from what it turned out to be (§3.153).
 *
 * ## It reads `result.missing`, and that field name is the point
 * §7c item 7: `protect-blame.mjs` read `result.unsupported`, a field that does
 * not exist, and `undefined ?? []` reported the row as holding ZERO cards — the
 * same shape as a genuine "this half does not exist" finding, which is what made
 * it dangerous. So this script:
 *   - reads the same `missing[].text` the coverage audit and the probe read;
 *   - PRINTS THE DENOMINATOR FIRST (how many rejected cards it scanned), so a
 *     zero row can be told apart from an empty scan;
 *   - refuses to run at all on a report with no `cards` array, rather than
 *     printing five confident zeroes.
 *
 * ## SOLE-blocked is the number to quote
 * "Clauses" counts every printing of a shape; "sole-blocked" counts the cards
 * for which this clause is the ONLY thing standing between them and the pool.
 * The second is the honest ceiling on a lane that implements the family
 * perfectly, and it is always the smaller number (rule 11).
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const DEFAULT_REPORT = fileURLToPath(new URL('../data/expansion-report.json', import.meta.url));
const reportPath = process.argv[2] ?? DEFAULT_REPORT;

const report = JSON.parse(readFileSync(reportPath, 'utf8'));
const cards = report.cards;
if (!Array.isArray(cards)) {
  console.error(
    `walker-blame: ${reportPath} has no \`cards\` array — refusing to print zeroes for a report it cannot read.`,
  );
  process.exit(2);
}

/**
 * The five families, each a printed SHAPE rather than an `UNSUPPORTED_HINTS`
 * row — §8a item 3: every row in that table is first-match and leaks, so a
 * family selected by hint measures the wrong population in both directions.
 */
const FAMILIES = [
  ['for each tapped creature', /for each tapped creature/i],
  ['card -> a graveyard FROM ANYWHERE (trigger)', /whenever .{0,60}is put into (your|a) graveyard from anywhere/i],
  ['pile separation', /separates? (those cards|them|the .{0,30}) into two piles|into two piles/i],
  ['per-ATTACKER attack trigger', /^whenever (a|another) creature( (you control|an opponent controls|your opponents control))? attacks[,.]/i],
  ['"until your next turn"', /until your next turn/i],
  ['cast without paying its/their mana cost', /without paying (its|their) mana cost/i],
];

console.log(`walker-blame — ${cards.length} REJECTED cards scanned from ${reportPath}`);
console.log(`(report: ${report.candidates} candidates, ${report.accepted} accepted, ${report.rejected} rejected)\n`);

// The denominator is printed BEFORE any family, so a zero below is a measurement
// rather than an empty scan (§8a item 8).
if (cards.length === 0) {
  console.error('walker-blame: the report holds ZERO rejected cards — every number below would be vacuous.');
  process.exit(2);
}

const rows = [];
for (const [label, pattern] of FAMILIES) {
  const shapes = new Map();
  let clauses = 0;
  let sole = 0;
  const soleNames = [];
  for (const card of cards) {
    const missing = card.missing ?? [];
    const hits = missing.filter((m) => pattern.test(m.text ?? ''));
    if (hits.length === 0) continue;
    clauses += hits.length;
    if (missing.length === hits.length) {
      sole += 1;
      if (soleNames.length < 8) soleNames.push(card.name);
    }
    for (const hit of hits) shapes.set(hit.text, (shapes.get(hit.text) ?? 0) + 1);
  }
  rows.push({ label, clauses, shapes: shapes.size, sole, soleNames, shapeMap: shapes });
}

const pad = (s, n) => String(s).padEnd(n);
const num = (s, n) => String(s).padStart(n);
console.log(`${pad('family', 44)} ${num('clauses', 8)} ${num('shapes', 7)} ${num('SOLE', 6)} ${num('per-shape', 10)}`);
console.log('-'.repeat(80));
for (const row of rows) {
  const perShape = row.shapes === 0 ? '—' : (row.clauses / row.shapes).toFixed(2);
  console.log(`${pad(row.label, 44)} ${num(row.clauses, 8)} ${num(row.shapes, 7)} ${num(row.sole, 6)} ${num(perShape, 10)}`);
}

console.log('\nSOLE-blocked examples (the honest ceiling per family):');
for (const row of rows) {
  console.log(`  ${row.label}: ${row.soleNames.length === 0 ? '(none)' : row.soleNames.join(' | ')}`);
}

// The largest shapes, because a family that CONCENTRATES is worth more per unit
// work than one at 1.00 cards per shape — which is what §2 keeps re-proving.
console.log('\nLargest single shape per family:');
for (const row of rows) {
  const top = [...row.shapeMap.entries()].sort((a, b) => b[1] - a[1])[0];
  console.log(`  ${row.label}: ${top === undefined ? '(none)' : `${top[1]}x ${JSON.stringify(top[0]).slice(0, 110)}`}`);
}
