/**
 * ACCEPTED COUNT — how many cards of a corpus the compiler accepts, right now.
 *
 * The campaign's deliverable is a DELTA (`docs/ALL-CARDS-CAMPAIGN.md` §5), and a
 * delta needs the same measurement taken twice: once with a branch's compiler
 * and once with it reverted, over ONE fixed corpus. `build-expansion.ts` answers
 * a bigger question (it also writes the pool, the report and the art list) and
 * writing generated files is exactly what a measurement must not do — a branch
 * that measures its delta by regenerating the pool has committed the pool.
 *
 * So this is the measurement alone: compile every card, count `'complete'`, and
 * print the denominator next to it (rule 11 — a number without its denominator
 * is not a measurement).
 *
 * Usage: node packages/cards/scripts/accepted-count.mjs <corpus.json> [--names <out.txt>]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { normalizeCard } from '@jonny-boi/data-tools';
import { compileCard } from '@jonny-boi/cards';

const corpusPath = process.argv[2];
if (!corpusPath) {
  console.error('usage: node packages/cards/scripts/accepted-count.mjs <corpus.json> [--names <out.txt>]');
  process.exit(2);
}
const namesAt = process.argv.indexOf('--names');
const NAMES_OUT = namesAt > 0 ? process.argv[namesAt + 1] : undefined;

const corpus = JSON.parse(readFileSync(corpusPath, 'utf8'));
let accepted = 0;
let threw = 0;
const names = [];
for (const raw of corpus) {
  let result;
  try {
    result = compileCard(normalizeCard(raw));
  } catch {
    threw += 1;
    continue;
  }
  if (result.status !== 'complete') continue;
  accepted += 1;
  names.push(raw.name);
}

console.log(`corpus ${corpus.length} · accepted ${accepted} · threw ${threw} · source ${corpusPath}`);
if (NAMES_OUT) {
  names.sort();
  writeFileSync(NAMES_OUT, `${names.join('\n')}\n`, 'utf8');
  console.log(`wrote ${names.length} accepted names to ${NAMES_OUT}`);
}
