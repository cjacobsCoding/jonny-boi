/**
 * ACCEPTED COUNT — how many corpus cards compile COMPLETELY, right now.
 *
 * The one number every family lane has to report as a DELTA (ALL-CARDS-CAMPAIGN
 * §5: "the delta is the deliverable"), and it deserves a committed script rather
 * than a one-off count for the reason rule 11 gives: the next lane should be
 * able to reproduce the measurement exactly instead of inventing its own.
 *
 * It deliberately does NOT write the pool. `build-expansion.ts` regenerates
 * `expanded-pool.ts` and `expansion-report.json`, and those generated files are
 * 20+ sections behind the compiler on main — regenerating them here would drag a
 * known masking defect (§3.147) into a measurement that only needs a count.
 *
 * To measure a DELTA, run it once with the branch's sources built, then again
 * with the sources restored to the base commit, and subtract. `--names <file>`
 * writes the accepted card names so the two runs can be diffed to see exactly
 * WHICH cards moved, which is the half a bare count cannot show.
 *
 * Usage: node packages/cards/scripts/accepted-count.mjs <corpus.json> [--names out.txt]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { normalizeCard } from '@jonny-boi/data-tools';
import { compileCard } from '@jonny-boi/cards';

const corpusPath = process.argv[2];
if (!corpusPath) {
  console.error('usage: node packages/cards/scripts/accepted-count.mjs <corpus.json> [--names out.txt]');
  process.exit(2);
}
const namesAt = process.argv.indexOf('--names');
const namesOut = namesAt > 0 ? process.argv[namesAt + 1] : undefined;

const corpus = JSON.parse(readFileSync(corpusPath, 'utf8'));
const accepted = [];
let threw = 0;
for (const raw of corpus) {
  let result;
  try {
    result = compileCard(normalizeCard(raw));
  } catch {
    threw += 1;
    continue;
  }
  if (result.status === 'complete') accepted.push(raw.name);
}

accepted.sort();
// The denominator and its source, printed every time — a count without them is
// the metric §ALL warns about (rule 11: print the denominator AND where it came from).
console.log(`corpus      ${corpus.length}  (${corpusPath})`);
console.log(`accepted    ${accepted.length}`);
console.log(`rejected    ${corpus.length - accepted.length}`);
console.log(`threw       ${threw}`);
console.log(`acceptance  ${((accepted.length / corpus.length) * 100).toFixed(2)}%`);
if (namesOut) {
  writeFileSync(namesOut, accepted.join('\n') + '\n', 'utf8');
  console.log(`names       -> ${namesOut}`);
}
