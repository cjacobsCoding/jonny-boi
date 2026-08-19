import { readFileSync } from 'node:fs';
import { normalizeCard } from '@jonny-boi/data-tools';
import { compileCard } from '@jonny-boi/cards';
const corpus = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const cards = Array.isArray(corpus) ? corpus : corpus.cards ?? corpus.data;
const names = process.argv.slice(3);
for (const name of names) {
  const raw = cards.find((c) => c.name.toLowerCase() === name.toLowerCase());
  if (!raw) { console.log(`-- ${name}: NOT IN CORPUS`); continue; }
  const r = compileCard(normalizeCard(raw));
  console.log(`-- ${name}: ${r.status}  rules=[${r.matchedRules.join(',')}]`);
  console.log(`   oracle: ${JSON.stringify(raw.oracle_text)}`);
  for (const m of r.missing) console.log(`   MISSING: ${m.missingEngineSystem} || ${m.text}`);
  if (r.status === 'complete') console.log('   defMana: ' + JSON.stringify(r.definition.manaAbilities ?? r.definition.producesOptions ?? r.definition.produces));
}
