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
 * The counter KINDS the corpus prints, as a CLOSED table. `statReadable` says
 * whether this engine's layer-7d stat pipeline reads the kind at all — the
 * +1/+1 and -1/-1 kinds change P/T, every other kind is inert instance state
 * until some printed rule reads it. A kind outside this table is reported by
 * its printed word under `other:<word>`, never folded into the nearest row.
 */
const COUNTER_KINDS = Object.freeze({
  '+1/+1': { statReadable: true },
  '-1/-1': { statReadable: true },
  '+1/+0': { statReadable: true },
  '+0/+1': { statReadable: true },
  '-0/-1': { statReadable: true },
  '-1/-0': { statReadable: true },
  loyalty: { statReadable: false },
  charge: { statReadable: false },
  quest: { statReadable: false },
  time: { statReadable: false },
  fade: { statReadable: false },
  age: { statReadable: false },
  poison: { statReadable: false },
  experience: { statReadable: false },
  energy: { statReadable: false },
  level: { statReadable: false },
  lore: { statReadable: false },
  defense: { statReadable: false },
  shield: { statReadable: false },
  stun: { statReadable: false },
  oil: { statReadable: false },
  blood: { statReadable: false },
  ki: { statReadable: false },
  spore: { statReadable: false },
  page: { statReadable: false },
  verse: { statReadable: false },
  brick: { statReadable: false },
  finality: { statReadable: false },
  flood: { statReadable: false },
  gold: { statReadable: false },
  hatchling: { statReadable: false },
  hoofprint: { statReadable: false },
  ice: { statReadable: false },
  incubation: { statReadable: false },
  keyword: { statReadable: false },
  lodestone: { statReadable: false },
  luck: { statReadable: false },
  matrix: { statReadable: false },
  music: { statReadable: false },
  pressure: { statReadable: false },
  rust: { statReadable: false },
  scream: { statReadable: false },
  storage: { statReadable: false },
  study: { statReadable: false },
  training: { statReadable: false },
  wish: { statReadable: false },
});

/** The stat-readable kinds, for the substitution probe. */
const SUBSTITUTE_KIND = '+1/+1';

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
  for (const kind of Object.keys(COUNTER_KINDS)) {
    const esc = kind.replace(/[+/-]/g, (c) => `\\${c}`);
    if (new RegExp(`${esc}\\s+counters?\\b`).test(lower)) found.add(kind);
  }
  // Anything of the form "<word> counter" the table does not know.
  for (const m of lower.matchAll(/\b([a-z+/-]+)\s+counters?\b/g)) {
    const word = m[1];
    if (Object.prototype.hasOwnProperty.call(COUNTER_KINDS, word)) continue;
    // Grammar words that precede "counter" without naming a kind.
    if (/^(?:a|an|the|those|these|that|this|any|each|all|many|more|other|another|new|two|three|four|of|with|no|one|first|additional|same|such|its|his|her|their|your|my)$/.test(word)) continue;
    found.add(`other:${word}`);
  }
  return [...found];
}

/** Which VERB row the clause falls under. */
function verbOf(text) {
  const lower = text.toLowerCase();
  for (const [name, re] of VERBS) if (re.test(lower)) return name;
  return 'other';
}

/** Rewrite every named counter kind in the clause to the stat-readable substitute. */
function substituteKinds(text) {
  let out = text;
  for (const kind of Object.keys(COUNTER_KINDS)) {
    if (kind === SUBSTITUTE_KIND) continue;
    const esc = kind.replace(/[+/-]/g, (c) => `\\${c}`);
    out = out.replace(new RegExp(`${esc}(\\s+counters?\\b)`, 'gi'), `${SUBSTITUTE_KIND}$1`);
  }
  out = out.replace(/\b([a-z+/-]+)(\s+counters?\b)/gi, (whole, word, tail) => {
    const w = String(word).toLowerCase();
    if (Object.prototype.hasOwnProperty.call(COUNTER_KINDS, w)) {
      return COUNTER_KINDS[w].statReadable ? whole : `${SUBSTITUTE_KIND}${tail}`;
    }
    if (/^(?:a|an|the|those|these|that|this|any|each|all|many|more|other|another|new|two|three|four|of|with|no|one|first|additional|same|such|its|his|her|their|your|my)$/.test(w)) return whole;
    return `${SUBSTITUTE_KIND}${tail}`;
  });
  return out;
}

const corpus = JSON.parse(readFileSync(corpusPath, 'utf8'));

const byVerb = new Map();
const kindOnly = new Map(); // compiles once the kind is substituted → the KIND is the only blocker
const templateGap = new Map(); // still refuses with a readable kind → a real template gap
const kindTally = new Map();
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
dump('TEMPLATE gaps (a rule genuinely missing)', templateGap, TOP);
