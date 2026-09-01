/**
 * Probe: compile named cards from a corpus and print exactly what blocks them.
 *
 * Reads the SAME fields the coverage audit and the gap report read
 * (`status` + `missing[].text`) on purpose — a probe that invents its own
 * field names will happily report COMPLETE for a card nothing can compile,
 * which is worse than no probe at all.
 *
 * usage: node packages/cards/scripts/probe.mjs <corpus.json> "Card Name" ...
 *        node packages/cards/scripts/probe.mjs <corpus.json> --keyword Enchant --limit 12
 */
import { readFileSync } from 'node:fs';
import { normalizeCard } from '@jonny-boi/data-tools';
import { compileCard } from '@jonny-boi/cards';

const corpus = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const argv = process.argv.slice(3);
const kwAt = argv.indexOf('--keyword');
const limitAt = argv.indexOf('--limit');
const LIMIT = limitAt >= 0 ? Number(argv[limitAt + 1]) : 12;

function report(raw) {
  let r;
  try {
    r = compileCard(normalizeCard(raw));
  } catch (e) {
    console.log(`!! ${raw.name}: THREW ${e.message}`);
    return;
  }
  console.log(`\n=== ${raw.name} — ${raw.type_line}`);
  console.log(`    text: ${JSON.stringify(raw.oracle_text ?? '')}`);
  if (r.status === 'complete') console.log('    COMPLETE');
  else for (const m of r.missing ?? []) console.log(`    BLOCKED [${m.missingEngineSystem ?? '?'}]: ${JSON.stringify(m.text)}`);
}

if (kwAt >= 0) {
  const keyword = argv[kwAt + 1];
  let shown = 0;
  for (const raw of corpus) {
    if (!(raw.keywords ?? []).includes(keyword)) continue;
    let r;
    try { r = compileCard(normalizeCard(raw)); } catch { continue; }
    if (r.status === 'complete') continue;
    const missing = r.missing ?? [];
    if (missing.length !== 1) continue;
    if (!missing[0].text.toLowerCase().includes(keyword.toLowerCase())) continue;
    report(raw);
    if (++shown >= LIMIT) break;
  }
  console.log(`\n(${shown} sole-blocked ${keyword} cards shown)`);
} else {
  const byName = new Map(corpus.map((c) => [c.name.toLowerCase(), c]));
  for (const n of argv) {
    const raw = byName.get(n.toLowerCase());
    if (!raw) { console.log(`?? ${n}: NOT IN CORPUS`); continue; }
    report(raw);
  }
}
