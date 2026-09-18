/**
 * Split the blame for a blocked activated-ability line between its COST half
 * and its BODY half, black-box, through compileCard only.
 *
 *  - cost probe:  "<COST>: Draw a card."      on a creature
 *  - body probe:  "{T}: <BODY>"               on a creature
 *
 * A clause where the cost probe compiles and the body probe does not is a BODY
 * gap; the reverse is a COST gap; neither compiling is both.
 */
import { readFileSync } from 'node:fs';
import { normalizeCard } from '@jonny-boi/data-tools';
import { compileCard } from '@jonny-boi/cards';

const corpus = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const SYSTEM = 'activated-ability template';

const probeCard = (name, oracleText) => ({
  id: `probe:${name}`,
  manaCost: { generic: 2, W: 0, U: 0, B: 0, R: 0, G: 0, C: 0, other: [] },
  typeLine: { supertypes: [], types: ['Creature'], subtypes: ['Human'] },
  power: 2, toughness: 2, keywords: [], name, oracleText,
});
const ok = (name, text) => {
  try { return compileCard(probeCard(name, text)).status === 'complete'; } catch { return false; }
};
const memo = new Map();
const cached = (key, fn) => { if (!memo.has(key)) memo.set(key, fn()); return memo.get(key); };

const shapeOf = (t) => t.replace(/\{[^}]*\}/g, '{}').replace(/\b\d+\b/g, 'N').replace(/\s+/g, ' ').trim();

const costGap = new Map(), bodyGap = new Map(), bothGap = new Map(), neither = new Map();
let clauses = 0, cards = 0, soleCards = 0;

for (const raw of corpus) {
  let r;
  try { r = compileCard(normalizeCard(raw)); } catch { continue; }
  if (r.status === 'complete') continue;
  const missing = r.missing ?? [];
  const mine = missing.filter((m) => (m.missingEngineSystem ?? '').includes(SYSTEM));
  if (mine.length === 0) continue;
  cards += 1;
  const sole = mine.length === missing.length;
  if (sole) soleCards += 1;
  for (const m of mine) {
    const text = (m.text ?? '').trim();
    const colon = text.indexOf(':');
    clauses += 1;
    let bucket, key;
    if (colon <= 0) { bucket = neither; key = shapeOf(text); }
    else {
      const cost = text.slice(0, colon).trim();
      const body = text.slice(colon + 1).trim();
      const costOk = cached(`c|${cost}`, () => ok('Probe', `${cost}: Draw a card.`));
      const bodyOk = cached(`b|${body}`, () => ok(raw.name, `{T}: ${body}`));
      bucket = costOk && bodyOk ? neither : costOk ? bodyGap : bodyOk ? costGap : bothGap;
      key = bucket === costGap ? shapeOf(cost) : bucket === bodyGap ? shapeOf(body) : shapeOf(text);
    }
    const e = bucket.get(key) ?? { sole: 0, also: 0, names: [] };
    if (sole) e.sole += 1; else e.also += 1;
    if (e.names.length < 5) e.names.push(raw.name);
    bucket.set(key, e);
  }
}

const total = (m) => [...m.values()].reduce((a, e) => a + e.sole + e.also, 0);
console.log(`${cards} cards (${soleCards} blocked by this system ALONE) · ${clauses} clauses`);
console.log(`  COST half unknown, body OK : ${total(costGap)} clauses / ${costGap.size} shapes`);
console.log(`  BODY half unknown, cost OK : ${total(bodyGap)} clauses / ${bodyGap.size} shapes`);
console.log(`  BOTH halves unknown        : ${total(bothGap)} clauses / ${bothGap.size} shapes`);
console.log(`  NEITHER (probe compiles!)  : ${total(neither)} clauses / ${neither.size} shapes`);

const dump = (label, m, n) => {
  console.log(`\n=== ${label} — top ${n} by clauses ===`);
  console.log('  sole  also  shape');
  for (const [s, e] of [...m].sort((a, b) => b[1].sole + b[1].also - (a[1].sole + a[1].also)).slice(0, n))
    console.log(`${String(e.sole).padStart(6)} ${String(e.also).padStart(5)}  ${s.slice(0, 120)}   [${e.names.slice(0,3).join(' | ')}]`);
};
dump('COST shapes the parser refuses', costGap, 40);
dump('BODY shapes the effect rules refuse', bodyGap, 60);
dump('BOTH halves unknown', bothGap, 25);
dump('NEITHER — probes pass but the real card does not', neither, 25);
