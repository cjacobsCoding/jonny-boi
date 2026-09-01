/**
 * DEAD-RULE SWEEP — which compiler rules never FIRE on any real card, and of
 * those, which were written for a card that IS in the corpus.
 *
 * The Gatecreeper Vine bug class (§3.57): a rule whose pattern was written from
 * a remembered wording rather than the printed text matches nothing, covers
 * zero cards, and the coverage audit blames a missing engine SYSTEM instead of
 * the rule. Ground truth here is what the compiler actually matched
 * (`CompileResult.matchedRules`) over `normalizeCard`'d corpus records — the
 * same adapter the coverage audit uses, so a rule that only ever fires inside a
 * trigger body or a modal bullet still counts as live.
 *
 * A rule that never fires is only a SUSPECT: it may cover a card outside this
 * corpus. The report therefore ranks by the strongest signal available — the
 * rule's own description names the cards it was written for, so a rule that
 * never fires while one of its named cards sits in the corpus is a rule bug.
 *
 * Usage: node packages/cards/scripts/dead-rule-sweep.mjs <corpus.json>
 */
import { readFileSync } from 'node:fs';
import { normalizeCard } from '@jonny-boi/data-tools';
import { EFFECT_RULES, compileCard } from '@jonny-boi/cards';

const corpusPath = process.argv[2];
if (!corpusPath) {
  console.error('usage: node packages/cards/scripts/dead-rule-sweep.mjs <corpus.json>');
  process.exit(2);
}
const corpus = JSON.parse(readFileSync(corpusPath, 'utf8'));

const fired = new Set();
const inCorpus = new Set();
for (const raw of corpus) {
  inCorpus.add(raw.name);
  let result;
  try {
    result = compileCard(normalizeCard(raw));
  } catch {
    continue;
  }
  for (const id of result.matchedRules ?? []) fired.add(id);
}

const dead = EFFECT_RULES.filter((rule) => !fired.has(rule.id));
const suspects = [];
for (const rule of dead) {
  const cited = [...String(rule.description).matchAll(/\(([^)]+)\)/g)]
    .flatMap((match) => match[1].split(/[,;]/))
    .map((name) => name.replace(/—.*$/, '').replace(/'s\b.*$/, '').trim())
    .filter((name) => inCorpus.has(name));
  if (cited.length > 0) suspects.push({ id: rule.id, cited: [...new Set(cited)] });
}

console.log(`${EFFECT_RULES.length} rules · ${fired.size} fired · ${dead.length} never fired on ${corpus.length} cards`);
console.log(`\nNEVER FIRED although a card its description names is in the corpus (${suspects.length}):`);
for (const suspect of suspects) console.log(`  ${suspect.id}  ->  ${suspect.cited.join(', ')}`);
