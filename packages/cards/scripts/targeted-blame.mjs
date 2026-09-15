/**
 * TARGETED-TRIGGER BLAME — split one backlog row three ways, because its NAME
 * points at only one of them.
 *
 * `gap-clauses.mjs` says *"884 cards, 748 shapes"* for the row *"a
 * targeted-trigger template the compiler does not recognize yet"* — the §3.120
 * artifact answer, true and useless on its own. The row's name blames the
 * TRIGGER, but a clause `When <EVENT>, <BODY>` can fail in three different
 * places and only one of them is the trigger:
 *
 *   1. the TRIGGER CONDITION  — no rule reads this printed event;
 *   2. the TARGET SELECTOR    — the printed noun after "target" is not a row in
 *                               `TARGET_NOUN_RESTRICTIONS`, so no verb can aim
 *                               at it however well the verb itself is written;
 *   3. the BODY TEMPLATE      — the event and the noun are both known and the
 *                               sentence still has no rule.
 *
 * §3.147 established that a row's name can point at the wrong half (its "cost"
 * row was 95% BODY), so the split is measured rather than assumed. Halves are
 * probed black-box through `compileCard` alone, exactly as `activated-blame.mjs`
 * does, and the selector half is answered by a TABLE LOOKUP rather than a probe
 * — asking the compiler's own closed noun table whether it knows the printed
 * noun is a direct answer where a probe would be a guess.
 *
 * Usage: node packages/cards/scripts/targeted-blame.mjs <corpus.json> [--top N]
 */
import { readFileSync } from 'node:fs';
import { normalizeCard } from '@jonny-boi/data-tools';
import { compileCard } from '@jonny-boi/cards';
// The noun table is not on the package's public surface, and this reads the ONE
// table the compiler itself reads rather than keeping a second copy here — a
// second list would drift the moment a noun is added and quietly mis-blame.
import { TARGET_NOUN_RESTRICTIONS } from '../dist/src/compile/rules.js';

const corpusPath = process.argv[2];
if (!corpusPath) {
  console.error('usage: node packages/cards/scripts/targeted-blame.mjs <corpus.json> [--top N]');
  process.exit(2);
}
const topAt = process.argv.indexOf('--top');
const TOP = topAt > 0 ? Number(process.argv[topAt + 1]) : 30;
const corpus = JSON.parse(readFileSync(corpusPath, 'utf8'));

const SYSTEM = 'targeted-trigger template';
/** A trigger event every rule table already reads, used as the KNOWN half of a probe. */
const KNOWN_TRIGGER = 'when ~ enters';
/** A body every rule table already reads, used as the KNOWN half of a probe. */
const KNOWN_BODY = 'draw a card';

/** The compiler's own noun vocabulary, longest first so "creature" cannot truncate a pair. */
const KNOWN_NOUNS = Object.keys(TARGET_NOUN_RESTRICTIONS).sort((a, b) => b.length - a.length);

const probeCard = (name, oracleText) => ({
  id: `probe:${name}`,
  manaCost: { generic: 2, W: 0, U: 0, B: 0, R: 0, G: 0, C: 0, other: [] },
  typeLine: { supertypes: [], types: ['Creature'], subtypes: ['Human'] },
  power: 2,
  toughness: 2,
  keywords: [],
  name,
  oracleText,
});

const memo = new Map();
/** Does this ONE printed sentence compile on its own, with `~` spelled as a real name? */
function compiles(sentence) {
  if (memo.has(sentence)) return memo.get(sentence);
  let value = false;
  try {
    // The clause arrives canonicalised (`~` for the card's own name). The probe
    // card is named `Probe`, so the self-reference has to be spelled back out or
    // the normalizer would leave a `~` no pattern expects.
    const text = `${sentence.replace(/~/g, 'Probe')}.`;
    value = compileCard(probeCard('Probe', text)).status === 'complete';
  } catch {
    value = false;
  }
  memo.set(sentence, value);
  return value;
}

/** Collapse a clause to its shape: numbers vary, the template does not. */
const shapeOf = (text) =>
  text.replace(/\{[^}]*\}/g, '{}').replace(/\b\d+\b/g, 'N').replace(/\s+/g, ' ').trim();

/**
 * The printed noun phrase this body aims at, and whether the noun table knows it.
 *
 * Returns `null` when the body names no target at all (those exist in this row:
 * a clause lands here because SOME clause on the card mentions "target", not
 * necessarily this one).
 */
function aim(body) {
  const at = body.indexOf('target ');
  if (at < 0) return null;
  const after = body.slice(at + 'target '.length);
  for (const noun of KNOWN_NOUNS) {
    // Word-boundary check: "creature" must not match inside "creature card".
    if (after === noun || after.startsWith(`${noun} `) || after.startsWith(`${noun}.`) || after.startsWith(`${noun},`)) {
      return { noun, known: true };
    }
  }
  // Unknown: report the printed words as the SHAPE of the selector that is missing.
  return { noun: after.split(/[.,]/)[0].split(/\s+/).slice(0, 5).join(' '), known: false };
}

const buckets = {
  trigger: new Map(),
  selector: new Map(),
  body: new Map(),
  both: new Map(),
  neither: new Map(),
  unsplittable: new Map(),
};
const cardsIn = { trigger: new Set(), selector: new Set(), body: new Set(), both: new Set(), neither: new Set(), unsplittable: new Set() };
const soleCardsIn = { trigger: new Set(), selector: new Set(), body: new Set(), both: new Set(), neither: new Set(), unsplittable: new Set() };

let cards = 0;
let soleCards = 0;
let clauses = 0;

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
    clauses += 1;
    const text = (m.text ?? '').trim();
    const split = /^(when|whenever)\s+(.+?),\s+(.+)$/s.exec(text);
    let name, key;
    if (!split) {
      name = 'unsplittable';
      key = shapeOf(text);
    } else {
      const [, when, condition, body] = split;
      const triggerOk = compiles(`${when} ${condition}, ${KNOWN_BODY}`);
      const bodyOk = compiles(`${KNOWN_TRIGGER}, ${body}`);
      if (triggerOk && bodyOk) {
        // Both halves compile alone — the FULL sentence still has no rule.
        name = 'neither';
        key = shapeOf(text);
      } else if (!triggerOk && !bodyOk) {
        name = 'both';
        key = shapeOf(text);
      } else if (!triggerOk) {
        name = 'trigger';
        key = shapeOf(`${when} ${condition}`);
      } else {
        // Body half. Ask the closed noun table whether it can even aim there.
        const target = aim(body);
        if (target && !target.known) {
          name = 'selector';
          key = `target ${shapeOf(target.noun)}`;
        } else {
          name = 'body';
          key = shapeOf(body);
        }
      }
    }
    const bucket = buckets[name];
    const entry = bucket.get(key) ?? { sole: 0, also: 0, names: [] };
    if (sole) entry.sole += 1;
    else entry.also += 1;
    if (entry.names.length < 5) entry.names.push(raw.name);
    bucket.set(key, entry);
    cardsIn[name].add(raw.name);
    if (sole) soleCardsIn[name].add(raw.name);
  }
}

const clauseTotal = (m) => [...m.values()].reduce((a, e) => a + e.sole + e.also, 0);
console.log(`${cards} cards carry a "${SYSTEM}" clause (${soleCards} blocked by this row ALONE) · ${clauses} clauses\n`);
console.log('  bucket                        clauses  shapes  cards  cards-blocked-by-this-row-alone');
for (const name of ['trigger', 'selector', 'body', 'neither', 'both', 'unsplittable']) {
  console.log(
    `  ${name.padEnd(28)}${String(clauseTotal(buckets[name])).padStart(7)}${String(buckets[name].size).padStart(8)}` +
      `${String(cardsIn[name].size).padStart(7)}${String(soleCardsIn[name].size).padStart(8)}`,
  );
}

const dump = (label, map, n) => {
  console.log(`\n=== ${label} — top ${n} by clauses ===`);
  console.log('  sole  also  shape');
  for (const [shape, entry] of [...map].sort((a, b) => b[1].sole + b[1].also - (a[1].sole + a[1].also)).slice(0, n)) {
    console.log(
      `${String(entry.sole).padStart(6)} ${String(entry.also).padStart(5)}  ${shape.slice(0, 110)}   [${entry.names.slice(0, 3).join(' | ')}]`,
    );
  }
};
dump('TRIGGER conditions no rule reads', buckets.trigger, TOP);
dump('TARGET SELECTORS the noun table cannot say', buckets.selector, TOP);
dump('BODY templates (trigger known, noun known)', buckets.body, TOP);
dump('NEITHER — both halves compile alone, the whole sentence does not', buckets.neither, TOP);
dump('BOTH halves unknown', buckets.both, TOP);
dump('UNSPLITTABLE (no "when X, Y" shape)', buckets.unsplittable, 10);
