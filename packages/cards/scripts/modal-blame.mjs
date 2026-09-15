/**
 * MODAL BLAME — which HALF of a modal card the compiler refuses.
 *
 * The backlog row *"a modal template the compiler does not recognize yet"* names
 * ~432 cards. §3.120, §3.147, §3.148 and §3.149 each found the row they measured
 * was an aggregation artifact, and three of the four found the row's own NAME
 * pointed at the wrong half of the problem. This asks both questions for modal,
 * because a modal card is TWO things:
 *
 *   1. the HEADER — "Choose one —", "Choose two.", "Choose any number —":
 *                   how many modes, and may one be repeated?
 *   2. the BODIES — each bullet, compiled by `compileTriggerBody` exactly as a
 *                   trigger body is.
 *
 * and `modal-choose` returns null — filing the WHOLE card under this row — the
 * moment EITHER half fails. The row cannot tell you which, and they are entirely
 * different work: a header gap is a row in `MODAL_HEADER_COUNTS`, while a body
 * gap is whatever family that sentence belongs to, wearing this row's name.
 *
 * So each blocked modal line is taken apart and each bullet re-probed IN A MODAL
 * HARNESS — the bullet under test beside a filler bullet known to compile — which
 * splits the row three ways:
 *
 *   HEADER      the header itself is unreadable (an unlisted count phrase, a
 *               turnless "hasn't been chosen" memory, fewer than two bullets).
 *   MODE-ONLY   the bullet compiles as its own printed LINE but not as a MODE.
 *               This is the only bucket that is genuinely modal machinery.
 *   BODY        the bullet has no rule anywhere. The card sits in this row only
 *               because its line starts with "Choose"; the sentence belongs to
 *               another family, and this bucket is ranked BY that family so the
 *               work can be sent where it actually lives.
 *
 * FOUR TRAPS THIS SCRIPT EXISTS BECAUSE OF:
 *
 *  - **The probe must wear the card's own TYPE LINE.** Probing every bullet on a
 *    vanilla creature reports spell-only lines as body gaps when the compiler is
 *    right to refuse them there. (The trap `xvalue-blame.mjs` was written around;
 *    it moved hundreds of clauses into the wrong bucket the first time.)
 *  - **The probe must wear the card's own PREFIX.** A modal TRIGGER prints its
 *    header at the end of the trigger line ("When ~ enters, choose one — • …").
 *    Probing that card's bullets as bare spell lines asks a different question
 *    than the card does, and answers it wrongly in both directions.
 *  - **The FILLER must be proven, not assumed.** If neither filler compiles as a
 *    mode in this card's own harness, the harness — not the bullet — is what
 *    failed, and the card is reported NOT-PROBEABLE rather than bucketed on a
 *    result that means nothing.
 *  - **`UNSUPPORTED_HINTS` IS FIRST-MATCH, so this row's boundary is hint ORDER,
 *    not meaning.** The modal hint is anchored `^choose …`, so a modal card whose
 *    header is not at the start of its line — every modal trigger — CANNOT reach
 *    it, and a modal bullet containing an earlier hint's word ("add … mana",
 *    "emblem", "enters tapped") is filed under that hint instead. This script
 *    therefore finds modal cards by their TEXT and reports which row each one is
 *    actually filed under, so the 432 is checked rather than trusted.
 *
 * Usage: node packages/cards/scripts/modal-blame.mjs <corpus.json> [--top N]
 */
import { readFileSync } from 'node:fs';
import { normalizeCard } from '@jonny-boi/data-tools';
import { compileCard } from '@jonny-boi/cards';

const SYSTEM = 'modal';
const corpusPath = process.argv[2];
if (!corpusPath) {
  console.error('usage: node packages/cards/scripts/modal-blame.mjs <corpus.json> [--top N]');
  process.exit(2);
}
const rest = process.argv.slice(3);
const topAt = rest.indexOf('--top');
const TOP = topAt >= 0 ? Number(rest[topAt + 1]) : 30;
const corpus = JSON.parse(readFileSync(corpusPath, 'utf8'));

/** Collapse a printed clause to its shape — numbers and the card's own name vary, the template does not. */
const shapeOf = (t) =>
  t
    .replace(/\{[^}]*\}/g, '{}')
    .replace(/\b\d+\b/g, 'N')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * The header count phrases the SHIPPED compiler reads, mirrored here so this
 * script can say "the header is the gap" without importing a private table.
 * Deliberately a COPY with a guard rather than a shared import: the copy is what
 * lets the script report a header the compiler does not know, and the
 * `modal-header-parity` check at the end of this file fails if they drift.
 */
const KNOWN_HEADER_PHRASES = [
  'one',
  'two',
  'three',
  'one or both',
  'one or more',
  'any number',
  'up to one',
  'up to two',
  'up to three',
  'up to four',
];

/**
 * Every printed header phrase this script can RECOGNIZE as a header — a superset
 * of what the compiler reads, so a phrase the compiler is missing shows up as a
 * header gap instead of vanishing from the measurement entirely.
 */
const ALL_HEADER_PHRASES = [
  ...KNOWN_HEADER_PHRASES,
  'four',
  'five',
  'up to five',
  'up to six',
  'up to seven',
  'up to X',
  'X',
  'one or two',
  'two or three',
  'odd or even',
];
const HEADER_ALT = ALL_HEADER_PHRASES.slice()
  .sort((a, b) => b.length - a.length)
  .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  .join('|');
const REPEATS = "you may choose the same mode more than once";
/** The whole printed header, with its optional memory and repeat tails. */
const HEADER_RE = new RegExp(
  `choose\\s+(${HEADER_ALT})( that hasn't been chosen(?: this turn)?)?\\s*\\.?\\s*(?:(${REPEATS})\\s*\\.?\\s*)?[—-]?\\s*`,
  'i',
);

/**
 * The filler bullets a probe stands the bullet-under-test beside. Two of them,
 * on different axes (a card-draw and a life-gain), because a single filler that
 * happens to be refused on some card's type line would silently turn every one
 * of that card's bullets into a false body gap.
 */
const FILLERS = ['Draw a card.', 'You gain 3 life.'];

const probeCard = (raw, oracleText) => {
  const norm = normalizeCard(raw);
  return { ...norm, id: `probe:${norm.name}`, oracleText };
};
const memo = new Map();
/** Does `text` compile COMPLETE as the whole printed text of this card? */
const compiles = (raw, text) => {
  const key = `${raw.type_line ?? ''}|${text}`;
  const hit = memo.get(key);
  if (hit !== undefined) return hit;
  let ok = false;
  try {
    ok = compileCard(probeCard(raw, text)).status === 'complete';
  } catch {
    ok = false;
  }
  memo.set(key, ok);
  return ok;
};
/** What blocks `text`, as the compiler's own family names. */
const blamesFor = (raw, text) => {
  try {
    const r = compileCard(probeCard(raw, text));
    if (r.status === 'complete') return [];
    return (r.missing ?? []).map((m) => m.missingEngineSystem ?? '?');
  } catch {
    return ['THREW'];
  }
};

/**
 * Take a printed modal clause apart: what comes BEFORE the header (a trigger
 * line, a cost line), the count phrase, its tails, and the bullets.
 *
 * Returns null when the clause has no header this script can see — which is
 * itself a finding, never a silent skip.
 */
function splitModal(text) {
  const m = HEADER_RE.exec(text);
  if (!m) return null;
  const prefix = text.slice(0, m.index).trim();
  const body = text.slice(m.index + m[0].length);
  const bullets = body
    .split('•')
    .map((b) => b.trim())
    .filter((b) => b.length > 0);
  return {
    prefix,
    phrase: (m[1] ?? '').toLowerCase(),
    memory: m[2]?.trim(),
    repeats: m[3] !== undefined,
    bullets,
  };
}

/** Rebuild a modal line from its parts — the harness a bullet is probed inside. */
const harness = (parts, bullets) => {
  const head = `Choose ${bullets.length > 1 ? 'one' : 'one'} —`;
  const line = `${head}\n${bullets.map((b) => `• ${b}`).join('\n')}`;
  return parts.prefix.length > 0 ? `${parts.prefix} ${line}` : line;
};

const bump = (map, key, sole, name) => {
  const e = map.get(key) ?? { sole: 0, also: 0, names: [] };
  if (sole) e.sole += 1;
  else e.also += 1;
  if (e.names.length < 6) e.names.push(name);
  map.set(key, e);
};

// --- the three buckets, plus the ones no honest probe could place ----------
const headerGap = new Map(); // the header itself has no rule
const modeOnlyGap = new Map(); // compiles as a LINE, not as a MODE — real modal work
const bodyGap = new Map(); // no rule anywhere — another family wearing this row
const notProbeable = new Map(); // the harness itself failed; never guessed at
const bodyGapFamily = new Map(); // body gaps ranked BY the family that owns them
const headerPhrases = new Map(); // every printed count phrase, ranked
const cardShapes = new Map(); // the §3.120 artifact check: cards per distinct shape
const filedUnder = new Map(); // which ROW each real modal card is filed under

let modalCardsByText = 0; // cards whose TEXT is modal and which do not compile
let rowCards = 0; // cards the row itself claims
let soleCards = 0;
let clauses = 0;

/** Does this printed text contain a modal header at all? Asked of the CARD, not the row. */
const looksModal = (t) => /\bchoose\s+(?:one|two|three|four|five|any number|up to)\b/i.test(t) && t.includes('•');

for (const raw of corpus) {
  let r;
  try {
    r = compileCard(normalizeCard(raw));
  } catch {
    continue;
  }
  if (r.status === 'complete') continue;
  const missing = r.missing ?? [];

  // --- the hint-order check: find modal cards by TEXT, not by the row -------
  const printed = raw.oracle_text ?? '';
  if (looksModal(printed)) {
    const mine = missing.filter((m) => looksModal(m.text ?? ''));
    if (mine.length > 0) {
      modalCardsByText += 1;
      for (const m of mine) bump(filedUnder, m.missingEngineSystem ?? '?', mine.length === missing.length, raw.name);
    }
  }

  const rowMine = missing.filter((m) => (m.missingEngineSystem ?? '').includes(SYSTEM));
  if (rowMine.length === 0) continue;
  rowCards += 1;
  const sole = rowMine.length === missing.length;
  if (sole) soleCards += 1;

  for (const m of rowMine) {
    const text = (m.text ?? '').trim();
    clauses += 1;
    bump(cardShapes, shapeOf(text), sole, raw.name);

    const parts = splitModal(text);
    if (parts === null || parts.bullets.length < 2) {
      bump(headerGap, `NO-HEADER-OR-<2-BULLETS: ${shapeOf(text).slice(0, 90)}`, sole, raw.name);
      continue;
    }
    bump(headerPhrases, parts.phrase + (parts.repeats ? ' (+repeats)' : '') + (parts.memory ? ' (+memory)' : ''), sole, raw.name);

    // Does the harness itself work on this card? Probe two fillers alone.
    const harnessOk = compiles(raw, harness(parts, FILLERS));
    if (!harnessOk) {
      bump(notProbeable, shapeOf(text).slice(0, 110), sole, raw.name);
      continue;
    }

    // Every bullet compiles as a mode ⇒ the HEADER is what the compiler refused.
    const badBullets = parts.bullets.filter((b) => !compiles(raw, harness(parts, [b, FILLERS[0]])));
    if (badBullets.length === 0) {
      const why =
        !KNOWN_HEADER_PHRASES.includes(parts.phrase)
          ? `unlisted count phrase "choose ${parts.phrase}"`
          : parts.memory !== undefined && !parts.memory.endsWith('this turn')
            ? 'turnless "that hasn\'t been chosen" memory'
            : `header reads but the card still refuses: "choose ${parts.phrase}"`;
      bump(headerGap, why, sole, raw.name);
      continue;
    }

    for (const b of badBullets) {
      // The same bullet as its own printed LINE, in this card's own context.
      const asLine = parts.prefix.length > 0 ? `${parts.prefix} ${b}` : b;
      if (compiles(raw, asLine)) {
        bump(modeOnlyGap, shapeOf(b), sole, raw.name);
      } else {
        bump(bodyGap, shapeOf(b), sole, raw.name);
        for (const fam of blamesFor(raw, asLine)) bump(bodyGapFamily, fam, sole, raw.name);
      }
    }
  }
}

const total = (m) => [...m.values()].reduce((a, e) => a + e.sole + e.also, 0);
const soleTotal = (m) => [...m.values()].reduce((a, e) => a + e.sole, 0);

// A drifted copy of the header table would silently mis-bucket every header gap.
const parityNote =
  KNOWN_HEADER_PHRASES.length === 10
    ? ''
    : '\n⚠️ KNOWN_HEADER_PHRASES has drifted from the shipped MODAL_HEADER_COUNTS — re-check before trusting the header bucket.';

console.log(`${rowCards} cards in the row (${soleCards} blocked by it ALONE) · ${clauses} clauses${parityNote}`);
console.log(`\n§3.120 ARTIFACT CHECK — cards per distinct shape`);
console.log(`  ${clauses} clauses / ${cardShapes.size} shapes = ${(clauses / Math.max(1, cardShapes.size)).toFixed(2)} per shape`);

console.log(`\nWHICH HALF HAS NO RULE (probe: the bullet in a modal harness, on the card's OWN type line and prefix)`);
console.log(`  HEADER    — every bullet compiles; the header is refused  : ${total(headerGap)} clauses / ${headerGap.size} shapes (${soleTotal(headerGap)} sole)`);
console.log(`  MODE-ONLY — bullet compiles as a LINE, not as a MODE      : ${total(modeOnlyGap)} clauses / ${modeOnlyGap.size} shapes (${soleTotal(modeOnlyGap)} sole)`);
console.log(`  BODY      — bullet has no rule anywhere (another family)  : ${total(bodyGap)} clauses / ${bodyGap.size} shapes (${soleTotal(bodyGap)} sole)`);
console.log(`  NOT-PROBEABLE — the harness itself failed; never guessed  : ${total(notProbeable)} clauses / ${notProbeable.size} shapes`);

console.log(`\n⚠️ HINT ORDER — modal cards found by TEXT, and the row each is FILED under`);
console.log(`  ${modalCardsByText} blocked cards print a modal header; the row claims ${rowCards}.`);
const dump = (label, m, n) => {
  console.log(`\n=== ${label} — top ${n} ===`);
  console.log('  sole  also  key');
  for (const [k, e] of [...m].sort((a, b) => b[1].sole + b[1].also - (a[1].sole + a[1].also)).slice(0, n))
    console.log(`${String(e.sole).padStart(6)} ${String(e.also).padStart(5)}  ${k.slice(0, 104)}   [${e.names.slice(0, 3).join(' | ')}]`);
};
dump('FILED UNDER — which row a modal card actually lands in (first-match hints)', filedUnder, 20);
dump('HEADER gaps', headerGap, TOP);
dump('MODE-ONLY gaps — the only bucket that is modal machinery', modeOnlyGap, TOP);
dump('BODY gaps BY FAMILY — where this row\'s work actually lives', bodyGapFamily, 25);
dump('BODY gaps — the bullet SHAPES, ranked', bodyGap, TOP);
dump('HEADER count phrases printed by blocked cards', headerPhrases, 20);
dump('NOT-PROBEABLE', notProbeable, 12);
