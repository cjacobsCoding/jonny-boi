/**
 * GAP CLAUSES — the printed SHAPES behind one backlog entry, ranked by cards.
 *
 * `coverage-audit.mjs` ranks missing SYSTEMS by cards blocked and prints ONE
 * example clause per system. When a system is a wide net — "a block restriction
 * whose SELECTOR compares creatures…" catches 730 cards — one example says
 * nothing about which printed sentences make up the 730, and a brief written
 * from it builds the wrong shape first. `near-miss-report.mjs` ranks exact
 * clauses across ALL systems, which buries a single system's long tail.
 *
 * This asks the middle question: for every card whose missing clauses include
 * one attributed to the named system, what are the clause SHAPES (numbers → N,
 * the card's own name → ~) and how many cards print each, split into cards this
 * system ALONE blocks (implement the shape and the card is playable) and cards
 * that also wait on something else.
 *
 * Usage: node packages/cards/scripts/gap-clauses.mjs <corpus.json> "<system substring>" [--top N] [--cards]
 */
import { readFileSync } from 'node:fs';
import { normalizeCard } from '@jonny-boi/data-tools';
import { compileCard } from '@jonny-boi/cards';

const [corpusPath, needle, ...rest] = process.argv.slice(2);
if (!corpusPath || !needle) {
  console.error('usage: node packages/cards/scripts/gap-clauses.mjs <corpus.json> "<system substring>" [--top N] [--cards]');
  process.exit(2);
}
const topAt = rest.indexOf('--top');
const TOP = topAt >= 0 ? Number(rest[topAt + 1]) : 40;
const SHOW_CARDS = rest.includes('--cards');
const corpus = JSON.parse(readFileSync(corpusPath, 'utf8'));
const wanted = needle.toLowerCase();

/** Collapse a printed clause to its shape: numbers and the card's own name vary, the template does not. */
const shapeOf = (text) => text.replace(/\{[^}]*\}/g, '{}').replace(/\b\d+\b/g, 'N').replace(/\s+/g, ' ').trim();

const shapes = new Map();
let cards = 0;
for (const raw of corpus) {
  let result;
  try {
    result = compileCard(normalizeCard(raw));
  } catch {
    continue;
  }
  if (result.status === 'complete') continue;
  const missing = result.missing ?? [];
  const mine = missing.filter((m) => (m.missingEngineSystem ?? '').toLowerCase().includes(wanted));
  if (mine.length === 0) continue;
  cards += 1;
  const sole = missing.length === mine.length;
  for (const m of mine) {
    const shape = shapeOf(m.text ?? '');
    const entry = shapes.get(shape) ?? { sole: 0, also: 0, names: [] };
    if (sole) entry.sole += 1;
    else entry.also += 1;
    if (entry.names.length < 6) entry.names.push(raw.name);
    shapes.set(shape, entry);
  }
}

const ranked = [...shapes].sort((a, b) => b[1].sole + b[1].also - (a[1].sole + a[1].also));
console.log(`${cards} cards carry a clause attributed to "${needle}" · ${ranked.length} distinct shapes\n`);
console.log('  sole  also  shape');
for (const [shape, { sole, also, names }] of ranked.slice(0, TOP)) {
  console.log(`${String(sole).padStart(6)} ${String(also).padStart(5)}  ${shape}`);
  if (SHOW_CARDS) console.log(`             cards: ${names.join(', ')}`);
}
