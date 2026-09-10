/**
 * PLAYABLE SET — the NAMES the compiler calls `'complete'`, sorted, one per line.
 *
 * Why a set and not the count the coverage audit already prints: two runs can
 * agree on "670 playable" and disagree about WHICH 670. A rule that adds five
 * cards while silently dropping five reports as a wash, and that regression has
 * shipped here before. Diffing two runs of this file names the cards gained AND
 * the cards lost, so "zero regressions" is a claim with evidence behind it.
 *
 * Reads the SAME field the coverage audit and the probe read (`status`), for
 * the reason spelled out on the probe: a measurement that invents its own
 * verdict measures itself, not the compiler.
 *
 * usage: node packages/cards/scripts/playable-set.mjs <corpus.json> [--out <path>]
 *
 * Offline and side-effect free — safe to run before and after a change.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { normalizeCard } from '@jonny-boi/data-tools';
import { compileCard } from '@jonny-boi/cards';

const [, , corpusPath, ...rest] = process.argv;
if (!corpusPath) {
  console.error('usage: node packages/cards/scripts/playable-set.mjs <corpus.json> [--out <path>]');
  process.exit(2);
}
const outAt = rest.indexOf('--out');
const outPath = outAt >= 0 ? rest[outAt + 1] : null;

const corpus = JSON.parse(readFileSync(corpusPath, 'utf8'));
const names = [];
let threw = 0;
for (const raw of corpus) {
  let result;
  try {
    result = compileCard(normalizeCard(raw));
  } catch {
    // A THROW is not a verdict — counted separately rather than folded into
    // "not playable", so a crash cannot masquerade as an honest refusal.
    threw += 1;
    continue;
  }
  if (result.status === 'complete') names.push(raw.name);
}
names.sort();

const text = names.join('\n') + '\n';
if (outPath) writeFileSync(outPath, text);
else process.stdout.write(text);
console.error(`${names.length} complete / ${corpus.length} corpus${threw > 0 ? ` (${threw} threw)` : ''}`);
