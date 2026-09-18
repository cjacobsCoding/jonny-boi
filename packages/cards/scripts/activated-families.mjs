/**
 * Candidate SUB-FAMILIES inside the activated-ability backlog, ranked by CARDS
 * a rule would make playable — not by clauses, which over-counts a card that
 * prints three blocked abilities.
 *
 * Grouping is by the BODY's leading verb phrase, because that is the axis a
 * rule table is written on, plus two WRAPPER families measured separately:
 * the trailing "Activate only …" restriction and "Any player may activate",
 * which block bodies the effect rules already implement.
 */
import { readFileSync } from 'node:fs';
import { normalizeCard } from '@jonny-boi/data-tools';
import { compileCard } from '@jonny-boi/cards';

const corpus = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const SYSTEM = 'activated-ability template';
const RESTRICTION = /\.\s*(activate only[^.]*|any player may activate this ability)\.?$/i;

const probe = (name, oracleText) => ({
  id: `probe:${name}`,
  manaCost: { generic: 2, W: 0, U: 0, B: 0, R: 0, G: 0, C: 0, other: [] },
  typeLine: { supertypes: [], types: ['Creature'], subtypes: ['Human'] },
  power: 2, toughness: 2, keywords: [], name, oracleText,
});
const memo = new Map();
const bodyOk = (name, body) => {
  const key = `${name}|${body}`;
  if (!memo.has(key)) {
    let v = false;
    try { v = compileCard(probe(name, `{T}: ${body}`)).status === 'complete'; } catch { v = false; }
    memo.set(key, v);
  }
  return memo.get(key);
};

/** The leading verb phrase a rule would key on — first few words, numbers collapsed. */
function verbKey(body) {
  const t = body.replace(/\b\d+\b/g, 'N').replace(/\{[^}]*\}/g, '{}').toLowerCase();
  const words = t.split(/\s+/).slice(0, 3).join(' ');
  return words.replace(/[.,]$/, '');
}

const families = new Map();   // verb key -> { cards:Set, clauses }
const restrictionOnly = new Set();  // cards whose ONLY blocker is the trailing restriction
const restrictionShapes = new Map();
let considered = 0;

for (const raw of corpus) {
  let r;
  try { r = compileCard(normalizeCard(raw)); } catch { continue; }
  if (r.status === 'complete') continue;
  const missing = r.missing ?? [];
  const mine = missing.filter((m) => (m.missingEngineSystem ?? '').includes(SYSTEM));
  if (mine.length === 0 || mine.length !== missing.length) continue;  // SOLE blocker only
  considered += 1;

  const bodies = [];
  let parseable = true;
  for (const m of mine) {
    const text = (m.text ?? '').trim();
    const colon = text.indexOf(':');
    if (colon <= 0) { parseable = false; break; }
    bodies.push({ cost: text.slice(0, colon).trim(), body: text.slice(colon + 1).trim() });
  }
  if (!parseable) continue;

  // WRAPPER family: every blocked body compiles once the trailing restriction
  // sentence is removed -> the only missing thing is the restriction itself.
  const stripped = bodies.map(({ body }) => {
    const m = RESTRICTION.exec(body);
    return m ? { core: body.slice(0, m.index).trim(), suffix: m[1].toLowerCase() } : null;
  });
  if (stripped.every((s) => s !== null) && stripped.every((s) => bodyOk(raw.name, s.core))) {
    restrictionOnly.add(raw.name);
    for (const s of stripped) {
      const k = s.suffix.replace(/\b\d+\b/g, 'N');
      const e = restrictionShapes.get(k) ?? { cards: new Set() };
      e.cards.add(raw.name);
      restrictionShapes.set(k, e);
    }
    continue;
  }

  // Otherwise attribute the card to the verb family of EVERY body it still
  // needs: a card is only unblocked when all of them land, so it counts once
  // per family and the numbers below are an UPPER bound per family.
  for (const { body } of bodies) {
    if (bodyOk(raw.name, body)) continue;
    const k = verbKey(body);
    const e = families.get(k) ?? { cards: new Set(), sample: [] };
    e.cards.add(raw.name);
    if (e.sample.length < 3) e.sample.push(`${raw.name}: ${body.slice(0, 70)}`);
    families.set(k, e);
  }
}

console.log(`${considered} cards whose ONLY blocker is this system\n`);
console.log(`=== WRAPPER family: the trailing "Activate only …" / "Any player may activate" restriction ===`);
console.log(`  ${restrictionOnly.size} cards are blocked by NOTHING ELSE — every body already compiles.`);
for (const [k, e] of [...restrictionShapes].sort((a, b) => b[1].cards.size - a[1].cards.size))
  console.log(`  ${String(e.cards.size).padStart(4)}  "${k}"   [${[...e.cards].slice(0, 3).join(' | ')}]`);

console.log(`\n=== BODY verb families (upper bound: a card needs ALL its bodies) ===`);
console.log('  cards  verb phrase');
for (const [k, e] of [...families].sort((a, b) => b[1].cards.size - a[1].cards.size).slice(0, 45))
  console.log(`  ${String(e.cards.size).padStart(5)}  ${k}\n           ${e.sample[0] ?? ''}`);
