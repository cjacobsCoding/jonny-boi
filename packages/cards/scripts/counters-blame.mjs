/**
 * COUNTERS BLAME — does "a counters template the compiler does not recognize
 * yet" name ONE problem, or several wearing one label?
 *
 * §3.147 established the question for the activated-ability row: the row's NAME
 * pointed at the wrong half (95% of its failures were the effect body, not the
 * cost), and `activated-blame.mjs` is the script that showed it. The counters
 * row carries the same risk — placement, removal, proliferate, "enters with",
 * and the readers that merely COUNT counters are different engine problems, and
 * a brief written from the 2,480-card headline builds whichever one it guessed.
 *
 * Two orthogonal splits, both black-box through `compileCard`:
 *
 *  1. THE VERB — what the clause DOES with a counter, from a CLOSED table. A
 *     clause matching no row is reported as `other`, with its text, rather than
 *     being filed under the nearest row that happens to exist.
 *
 *  2. THE KIND — which counter it names. Then the discriminating probe: rewrite
 *     every named kind to `+1/+1` and compile again. A clause that compiles
 *     only after the rewrite is blocked SOLELY by the counter kind — the stat
 *     layer cannot read a quest/charge/time counter — and not by its template
 *     at all. That is a different (and much cheaper) piece of work from a
 *     template gap, and the headline hides the difference completely.
 *
 * Usage: node packages/cards/scripts/counters-blame.mjs <corpus.json> [--top N] [--cards]
 */
import { readFileSync } from 'node:fs';
import { normalizeCard } from '@jonny-boi/data-tools';
import { compileCard } from '@jonny-boi/cards';

const corpusPath = process.argv[2];
if (!corpusPath) {
  console.error('usage: node packages/cards/scripts/counters-blame.mjs <corpus.json> [--top N] [--cards]');
  process.exit(2);
}
const topAt = process.argv.indexOf('--top');
const TOP = topAt > 0 ? Number(process.argv[topAt + 1]) : 30;
const SHOW_CARDS = process.argv.includes('--cards');

/** The backlog row this script exists to take apart. */
const SYSTEM = 'counters template';

/**
 * The counter KINDS the corpus prints, as a CLOSED table with the one column
 * that decides whether a "put a <kind> counter on ~" line can be implemented
 * HONESTLY:
 *
 *  - `stat`  — the layer-7d stat pipeline reads it (+1/+1 and its siblings).
 *              Already real; a clause naming only these is never a kind gap.
 *  - `rules` — the COMPREHENSIVE RULES attach behaviour to the counter itself
 *              (CR 122.1): a shield counter eats a destruction, a stun counter
 *              eats an untap, time/fade/age drive suspend/fading/cumulative
 *              upkeep, loyalty/defense/level/lore drive whole card types.
 *              Storing one as inert state would be a card playing WEAKER than
 *              printed, so these stay REPORTED however cheap they look.
 *  - `inert` — the counter has no rule of its own; only the card's OWN other
 *              printed lines give it meaning (charge, quest, spore, oil …).
 *              Putting one on is faithful: if a line that READS it does not
 *              compile, the card still reports and never enters the pool.
 *
 * A kind outside this table surfaces by its printed word as `other:<word>` and
 * is counted as UNCLASSIFIED — never folded into the nearest row that happens
 * to exist, and never assumed inert.
 */
const COUNTER_KINDS = Object.freeze({
  '+1/+1': 'stat',
  '-1/-1': 'stat',
  '+1/+0': 'stat',
  '+0/+1': 'stat',
  '-0/-1': 'stat',
  '-1/-0': 'stat',
  '+2/+2': 'stat',
  '-2/-2': 'stat',
  '+0/+2': 'stat',
  // CR 122.1 gives these counters their own behaviour — see the doc above.
  loyalty: 'rules',
  defense: 'rules',
  level: 'rules',
  lore: 'rules',
  shield: 'rules',
  stun: 'rules',
  time: 'rules',
  fade: 'rules',
  age: 'rules',
  poison: 'rules',
  energy: 'rules',
  experience: 'rules',
  incubation: 'rules',
  keyword: 'rules',
  // Pure bookkeeping: inert until one of the card's own lines reads it.
  charge: 'inert',
  quest: 'inert',
  spore: 'inert',
  oil: 'inert',
  page: 'inert',
  verse: 'inert',
  storage: 'inert',
  wish: 'inert',
  study: 'inert',
  music: 'inert',
  pressure: 'inert',
  growth: 'inert',
  tide: 'inert',
  divinity: 'inert',
  soul: 'inert',
  depletion: 'inert',
  plague: 'inert',
  slime: 'inert',
  net: 'inert',
  intervention: 'inert',
  healing: 'inert',
  hoofprint: 'inert',
  ice: 'inert',
  gold: 'inert',
  brick: 'inert',
  finality: 'inert',
  flood: 'inert',
  hatchling: 'inert',
  lodestone: 'inert',
  luck: 'inert',
  matrix: 'inert',
  rust: 'inert',
  scream: 'inert',
  training: 'inert',
  bounty: 'inert',
  blood: 'inert',
  ki: 'inert',
  plan: 'inert',
  strike: 'inert',
});

/** The stat-readable kind every probe rewrites TO. */
const SUBSTITUTE_KIND = '+1/+1';

/** Grammar words that sit before "counter" without naming a kind. */
const NOT_A_KIND =
  /^(?:a|an|the|those|these|that|this|any|each|all|many|more|other|another|new|one|two|three|four|five|six|seven|of|with|no|first|additional|same|such|its|his|her|their|your|my|and|or|counter|counters|x|n)$/;

/**
 * What the clause DOES with a counter — a CLOSED table, first match wins, order
 * significant (the most specific verb first). `other` is a real answer.
 */
const VERBS = Object.freeze([
  ['proliferate', /\bproliferate\b/],
  ['double', /\bdouble the number of .{0,40}counters?\b|\btwice that many\b/],
  ['enters-with', /\benters? (?:the battlefield )?with\b[^.]*\bcounters?\b/],
  ['remove', /\bremove\b[^.]{0,60}\bcounters?\b/],
  ['move', /\bmove\b[^.]{0,60}\bcounters?\b/],
  ['distribute', /\bdistributed?\b[^.]{0,60}\bcounters?\b/],
  ['put', /\b(?:put|place)\b[^.]{0,80}\bcounters?\b/],
  ['read-for-each', /\bfor each\b[^.]{0,60}\bcounters?\b/],
  ['read-has', /\b(?:has|have|with|without|had)\b[^.]{0,40}\bcounters?\b/],
  ['read-number-of', /\bnumber of\b[^.]{0,40}\bcounters?\b/],
]);

const probeCard = (name, oracleText, types = ['Creature']) => ({
  id: `probe:${name}`,
  manaCost: { generic: 2, W: 0, U: 0, B: 0, R: 0, G: 0, C: 0, other: [] },
  typeLine: { supertypes: [], types, subtypes: types[0] === 'Creature' ? ['Human'] : [] },
  power: types[0] === 'Creature' ? 2 : null,
  toughness: types[0] === 'Creature' ? 2 : null,
  keywords: [],
  name,
  oracleText,
});

const compiles = (name, text) => {
  try {
    return compileCard(probeCard(name, text)).status === 'complete';
  } catch {
    return false;
  }
};

const memo = new Map();
const cached = (key, fn) => {
  if (!memo.has(key)) memo.set(key, fn());
  return memo.get(key);
};

/** Collapse a clause to its SHAPE: numbers and the card's own name vary, the template does not. */
const shapeOf = (t) =>
  t
    .replace(/\{[^}]*\}/g, '{}')
    .replace(/\b\d+\b/g, 'N')
    .replace(/\s+/g, ' ')
    .trim();

/** Every counter kind the clause names, by the closed table; unknown words surface as `other:<word>`. */
function kindsIn(text) {
  const lower = text.toLowerCase();
  const found = new Set();
  // The P/T kinds first — they carry digits, so the word scan below cannot see them.
  for (const kind of Object.keys(COUNTER_KINDS)) {
    if (!/\d/.test(kind)) continue;
    const esc = kind.replace(/[+/-]/g, (c) => `\\${c}`);
    if (new RegExp(`${esc}\\s+counters?\\b`).test(lower)) found.add(kind);
  }
  for (const m of lower.matchAll(/\b([a-z]+)\s+counters?\b/g)) {
    const word = m[1];
    if (NOT_A_KIND.test(word)) continue;
    found.add(Object.prototype.hasOwnProperty.call(COUNTER_KINDS, word) ? word : `other:${word}`);
  }
  return [...found];
}

/** The strictest classification among the kinds a clause names — `rules` beats `inert` beats `stat`. */
function kindClassOf(kinds) {
  if (kinds.length === 0) return 'none';
  let sawInert = false;
  let sawUnknown = false;
  for (const k of kinds) {
    if (k.startsWith('other:')) { sawUnknown = true; continue; }
    const cls = COUNTER_KINDS[k];
    if (cls === 'rules') return 'rules';
    if (cls === 'inert') sawInert = true;
  }
  if (sawUnknown) return 'unclassified';
  if (sawInert) return 'inert';
  return 'stat';
}

/** Which VERB row the clause falls under. */
function verbOf(text) {
  const lower = text.toLowerCase();
  for (const [name, re] of VERBS) if (re.test(lower)) return name;
  return 'other';
}

/**
 * Rewrite every NON-stat counter kind in the clause to `+1/+1`.
 *
 * ⚠️ Stat kinds are left alone on purpose. Rewriting `-1/-1` to `+1/+1` — which
 * an earlier draft of this script did — makes a clause look like a KIND gap
 * when the stat layer already reads `-1/-1` perfectly well and the real blocker
 * is the template around it. That inflated "kind-only" with work that does not
 * exist; the probe is only a discriminator while the thing it varies is the
 * thing being tested.
 */
function substituteKinds(text) {
  return text.replace(/\b([a-z]+)(\s+counters?\b)/gi, (whole, word, tail) => {
    const w = String(word).toLowerCase();
    if (NOT_A_KIND.test(w)) return whole;
    if (COUNTER_KINDS[w] === 'stat') return whole;
    return `${SUBSTITUTE_KIND}${tail}`;
  });
}

const corpus = JSON.parse(readFileSync(corpusPath, 'utf8'));

const byVerb = new Map();
const kindOnly = new Map(); // compiles once the kind is substituted → the KIND is the only blocker
const templateGap = new Map(); // still refuses with a readable kind → a real template gap
const kindTally = new Map();
/** kind-only clauses split by whether the kind may HONESTLY be stored as inert state. */
const kindOnlyByClass = new Map();
const kindOnlyInertShapes = new Map();
let cards = 0;
let soleCards = 0;
let clauses = 0;
const soleNamesByShape = new Map();

for (const raw of corpus) {
  let result;
  try {
    result = compileCard(normalizeCard(raw));
  } catch {
    continue;
  }
  if (result.status === 'complete') continue;
  const missing = result.missing ?? [];
  const mine = missing.filter((m) => (m.missingEngineSystem ?? '').includes(SYSTEM));
  if (mine.length === 0) continue;
  cards += 1;
  const sole = mine.length === missing.length;
  if (sole) soleCards += 1;

  for (const m of mine) {
    const text = (m.text ?? '').trim();
    clauses += 1;
    const shape = shapeOf(text);
    const verb = verbOf(text);
    const kinds = kindsIn(text);
    for (const k of kinds) kindTally.set(k, (kindTally.get(k) ?? 0) + 1);

    const bump = (map, key) => {
      const e = map.get(key) ?? { sole: 0, also: 0, names: [] };
      if (sole) e.sole += 1;
      else e.also += 1;
      if (e.names.length < 6) e.names.push(raw.name);
      map.set(key, e);
    };
    bump(byVerb, verb);

    // The discriminating probe: does this clause compile once every counter
    // kind it names is one the stat layer reads?
    const rewritten = substituteKinds(text);
    if (rewritten !== text) {
      const nowOk = cached(`s|${rewritten}`, () => compiles('Probe', rewritten));
      bump(nowOk ? kindOnly : templateGap, shape);
      if (nowOk) {
        const cls = kindClassOf(kinds);
        kindOnlyByClass.set(cls, (kindOnlyByClass.get(cls) ?? 0) + 1);
        if (cls === 'inert') bump(kindOnlyInertShapes, shape);
      }
    } else {
      bump(templateGap, shape);
    }
    if (sole) {
      const list = soleNamesByShape.get(shape) ?? [];
      if (list.length < 8) list.push(raw.name);
      soleNamesByShape.set(shape, list);
    }
  }
}

const total = (m) => [...m.values()].reduce((a, e) => a + e.sole + e.also, 0);
console.log(`corpus ${corpus.length} cards`);
console.log(`"${SYSTEM}" blocks ${cards} cards (${soleCards} blocked by it ALONE) · ${clauses} clauses`);
console.log('');
console.log('=== SPLIT 1 — what the clause DOES with a counter (closed table) ===');
console.log('  sole  also  verb');
for (const [v, e] of [...byVerb].sort((a, b) => b[1].sole + b[1].also - (a[1].sole + a[1].also)))
  console.log(`${String(e.sole).padStart(6)} ${String(e.also).padStart(5)}  ${v}`);

console.log('');
console.log('=== SPLIT 2 — is the COUNTER KIND the only blocker? ===');
console.log(`  kind-only (compiles once the kind is +1/+1) : ${total(kindOnly)} clauses / ${kindOnly.size} shapes`);
console.log(`  real TEMPLATE gap (refuses even at +1/+1)   : ${total(templateGap)} clauses / ${templateGap.size} shapes`);
console.log('');
console.log('  …and of the kind-only clauses, which kinds may be stored HONESTLY as inert state:');
for (const cls of ['inert', 'rules', 'unclassified', 'stat', 'none'])
  if (kindOnlyByClass.has(cls))
    console.log(`    ${cls.padEnd(13)} ${String(kindOnlyByClass.get(cls)).padStart(5)} clauses`);
console.log('    (only `inert` is implementable without a card playing weaker than printed)');

console.log('');
console.log('=== counter KINDS named in blocked clauses ===');
for (const [k, n] of [...kindTally].sort((a, b) => b[1] - a[1]).slice(0, 40))
  console.log(`${String(n).padStart(6)}  ${k}`);

const dump = (label, m, n) => {
  console.log(`\n=== ${label} — top ${n} by clauses ===`);
  console.log('  sole  also  shape');
  for (const [s, e] of [...m].sort((a, b) => b[1].sole + b[1].also - (a[1].sole + a[1].also)).slice(0, n)) {
    console.log(`${String(e.sole).padStart(6)} ${String(e.also).padStart(5)}  ${s.slice(0, 150)}`);
    if (SHOW_CARDS) console.log(`                [${(soleNamesByShape.get(s) ?? e.names).slice(0, 6).join(' | ')}]`);
  }
};
dump('KIND-ONLY blockers (the template already exists)', kindOnly, TOP);
dump('KIND-ONLY and the kind is INERT — the implementable subset', kindOnlyInertShapes, TOP);
dump('TEMPLATE gaps (a rule genuinely missing)', templateGap, TOP);
