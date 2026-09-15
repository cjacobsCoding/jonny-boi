/**
 * PROTECT BLAME — which half of a blocked targeting-protection line the
 * compiler refuses.
 *
 * The backlog row *"a ward/protection template the compiler does not recognize
 * yet"* is selected by the first-match hint `/\bward\b|\bprotection from\b/`,
 * which cannot see `can't be the target of` at all and cannot see a card whose
 * text matched an earlier hint. §3.147–§3.150 each found that a row's NAME
 * points at the wrong half of its problem, so this asks the question for this
 * family before any rule is written.
 *
 * ## The split this script measures
 * Protection's targeting half has two independent vocabularies, and the row
 * name names neither:
 *
 *   - the **QUALITY vocabulary** — which colours, card types, subtypes and
 *     controller-scopes a restriction may NAME (`PROTECTION_QUALITY_WORDS`,
 *     `PROTECTION_SUBTYPE_WORDS`, the ward cost forms). A gap here is a ROW in
 *     a closed table.
 *   - the **SHAPE / enforcement** — which printed SENTENCE the compiler
 *     recognises as granting a targeting restriction at all. `protection from
 *     black` compiles; `hexproof from black` and `~ can't be the target of
 *     black spells your opponents control` are the same engine question written
 *     differently, and neither is read.
 *
 * Those are completely different amounts of work — a table row versus a new
 * keyword field threaded through the five keyword-merge homes — and the row
 * cannot tell you which, so every blocked family LINE is probed black-box
 * through `compileCard` alone:
 *
 *   0. CONTROL      the card's own type line, mana cost, P/T and printed
 *                   loyalty/defense with NO oracle text. A card whose control
 *                   probe does not compile is reported **NOT-PROBEABLE** rather
 *                   than bucketed — §8a's rule that a card you cannot test is
 *                   not evidence for any bucket.
 *   1. LINE         control + the printed family line, alone. A line that
 *                   compiles here while the card does not is **OTHER-CLAUSE**:
 *                   this family is not what blocks that card.
 *   2. REWRITES     the closed table below, each turning ONE printed spelling
 *                   into a spelling the compiler already reads. A line that
 *                   compiles after a rewrite is blamed on exactly what that
 *                   rewrite changed.
 *
 * ⚠️ **THE POPULATION IS THE TEXT, NOT THE ROW**, and that is the point.
 * `UNSUPPORTED_HINTS` is FIRST-MATCH, so a card printing `protection from red`
 * whose text ALSO says "sacrifice" is filed under sacrifice. Both populations
 * are printed side by side, with the leakage in each direction named, so
 * neither number can be quoted as the other.
 *
 * ⚠️ **Reminder text is not a printing.** 158 of the 219 corpus cards matching
 * `/can't be the target of/` are the parenthesised reminder for `hexproof` or
 * `shroud` — keywords the engine has enforced since before this family existed.
 * Counting them would report an implemented keyword as a gap, so the family
 * line detector ignores a match that occurs only inside parentheses.
 *
 * Usage: node packages/cards/scripts/protect-blame.mjs <corpus.json> [--top N]
 *
 * Offline and side-effect free.
 */
import { readFileSync } from 'node:fs';
import { normalizeCard } from '@jonny-boi/data-tools';
import { compileCard } from '@jonny-boi/cards';

const corpusPath = process.argv[2];
if (!corpusPath) {
  console.error('usage: node packages/cards/scripts/protect-blame.mjs <corpus.json> [--top N]');
  process.exit(2);
}
const rest = process.argv.slice(3);
const topAt = rest.indexOf('--top');
const TOP = topAt >= 0 ? Number(rest[topAt + 1]) : 40;
const corpus = JSON.parse(readFileSync(corpusPath, 'utf8'));

/** The row this family is named for, as `UNSUPPORTED_HINTS` spells it. */
const ROW = 'a ward/protection template the compiler does not recognize yet';

/**
 * The printed wordings that ask the engine's targeting question. A CLOSED list:
 * a wording outside it is not silently folded into the nearest member, it is
 * simply not this family.
 */
const FAMILY_PATTERN = /can't be the target of|\bprotection from\b|hexproof from|\bward\b/i;

/** Strip every parenthesised span — reminder text is not a printed ability. */
const withoutReminders = (text) => text.replace(/\([^()]*\)/g, ' ');

/** A line belongs to the family only if it says so OUTSIDE its reminder text. */
const isFamilyLine = (line) => FAMILY_PATTERN.test(withoutReminders(line));

/**
 * The closed REWRITE table — each row turns ONE printed spelling of a targeting
 * restriction into a spelling the compiler already reads, so a line that
 * compiles after the rewrite is blamed on exactly what the rewrite changed.
 * Adding the next distinguishable spelling is a ROW, not a branch.
 *
 * `blame` is what the rewrite PROVES when it flips a refusal into a compile:
 *   SHAPE  — the quality words were already understood; the SENTENCE was not.
 *   VOCAB  — the sentence was already understood; the quality WORD was not.
 */
const REWRITES = Object.freeze([
  {
    id: 'hexproof-from→protection-from',
    blame: 'SHAPE',
    note: '"hexproof from X" is protection\'s quality vocabulary with only the targeting half',
    apply: (line) => {
      const out = line.replace(/hexproof from /gi, 'protection from ');
      return out === line ? null : out;
    },
  },
  {
    id: "can't-be-target-of-Q→protection-from-Q",
    blame: 'SHAPE',
    note: 'the long printed sentence is the same engine question as the keyword',
    apply: (line) => {
      const m = /can't be the target of ([^.]+?) (?:spells|spells or abilities)\b[^.]*\./i.exec(
        withoutReminders(line),
      );
      if (!m) return null;
      const qualities = (m[1] ?? '').replace(/\bor\b/g, 'and from');
      return `Protection from ${qualities}.`;
    },
  },
  {
    id: 'ward-cost→ward-{2}',
    blame: 'VOCAB',
    note: 'the ward SHAPE compiles; only this printed COST is outside the table',
    apply: (line) => {
      const out = line.replace(/ward\s*[—-][^.,;]*/gi, 'ward {2}').replace(/ward \{x\}/gi, 'ward {2}');
      return out === line ? null : out;
    },
  },
  {
    id: 'protection-quality→black',
    blame: 'VOCAB',
    note: 'the protection SHAPE compiles; only this printed QUALITY is outside the closed table',
    apply: (line) => {
      const out = line.replace(/protection from [^.,;]+/gi, 'protection from black');
      return out === line ? null : out;
    },
  },
]);

/**
 * ⚠️ **The probe must clear Scryfall's `keywords` array, and that is the trap
 * this comment exists for.** The compiler reads the printed oracle LINE *and*
 * Scryfall's bare keyword list, and the bare list is just the word: a card
 * whose list says `["Protection"]` or `["Ward"]` reports `the "Protection"
 * keyword ability` **with empty oracle text**. Leaving it on failed the control
 * probe for 334 of the 487 blocked cards — every card in the family, because
 * the family is exactly the cards Scryfall stamps those keywords on — and would
 * have reported the whole population as untestable. Both probes clear it, so
 * the ONLY variable between control and line is the line.
 */
const base = (raw, oracleText) => ({ ...normalizeCard(raw), oracleText, keywords: [] });

const compiles = (raw, oracleText) => {
  try {
    return compileCard(base(raw, oracleText)).status === 'complete';
  } catch {
    return false;
  }
};

/** The printed lines of a single-faced card; a DFC is reported, never guessed at. */
function linesOf(raw) {
  if (Array.isArray(raw.card_faces) && raw.card_faces.length > 0) return null;
  const text = raw.oracle_text ?? '';
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

// ---------------------------------------------------------------------------
// 1. The two populations, side by side — TEXT and ROW — and the leakage.
// ---------------------------------------------------------------------------
const byText = [];
const byRow = [];
/** Which rows the TEXT population is actually filed under — the leakage, named. */
const rowCensus = new Map();
let complete = 0;
let threw = 0;

for (const raw of corpus) {
  const allText = `${raw.oracle_text ?? ''}\n${(raw.card_faces ?? []).map((f) => f.oracle_text ?? '').join('\n')}`;
  const textHit = FAMILY_PATTERN.test(withoutReminders(allText));
  let result;
  try {
    result = compileCard(normalizeCard(raw));
  } catch {
    threw += 1;
    continue;
  }
  if (result.status === 'complete') {
    if (textHit) complete += 1;
    continue;
  }
  // ⚠️ The field is `missing`, not `unsupported` (`CompileResult.missing`).
  // Reading the wrong name is a check that cannot fail: it reported the row as
  // EMPTY — 0 cards — which is exactly the shape of a real §3.120 finding and
  // would have been believed.
  const reasons = result.missing ?? [];
  const rowHit = reasons.some((u) => u.missingEngineSystem === ROW);
  for (const u of reasons) rowCensus.set(u.missingEngineSystem, (rowCensus.get(u.missingEngineSystem) ?? 0) + (textHit ? 1 : 0));
  if (textHit) byText.push(raw);
  if (rowHit) byRow.push(raw);
}

const textNames = new Set(byText.map((c) => c.name));
const rowNames = new Set(byRow.map((c) => c.name));
const onlyText = [...textNames].filter((n) => !rowNames.has(n));
const onlyRow = [...rowNames].filter((n) => !textNames.has(n));

console.log('=== POPULATIONS (blocked cards only) ===========================');
console.log(`corpus                                   ${corpus.length}`);
console.log(`threw (not a verdict)                    ${threw}`);
console.log(`family TEXT, already COMPLETE            ${complete}`);
console.log(`blocked, by family TEXT                  ${textNames.size}`);
console.log(`blocked, by the ROW hint                 ${rowNames.size}`);
console.log(`  TEXT but filed elsewhere (leak in)     ${onlyText.length}`);
console.log(`  ROW but no family text (leak out)      ${onlyRow.length}`);
if (onlyRow.length > 0) console.log(`  e.g. ${onlyRow.slice(0, 6).join(' · ')}`);

console.log('');
console.log('--- where the family TEXT population is actually filed (clause counts) ---');
for (const [row, n] of [...rowCensus.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
  console.log(`  ${String(n).padStart(5)}  ${row}`);
}

// ---------------------------------------------------------------------------
// 2. Blame each blocked TEXT card, line by line.
// ---------------------------------------------------------------------------
const buckets = new Map();
const put = (key, name, detail) => {
  if (!buckets.has(key)) buckets.set(key, []);
  buckets.get(key).push(detail ? `${name} — ${detail}` : name);
};

for (const raw of byText) {
  const lines = linesOf(raw);
  if (lines === null) {
    put('NOT-PROBEABLE (double-faced)', raw.name);
    continue;
  }
  if (!compiles(raw, '')) {
    put('NOT-PROBEABLE (control probe refuses the bare type line)', raw.name);
    continue;
  }
  const familyLines = lines.filter(isFamilyLine);
  if (familyLines.length === 0) {
    put('NOT-PROBEABLE (family text is only in reminder text)', raw.name);
    continue;
  }
  let blamedHere = false;
  for (const line of familyLines) {
    if (compiles(raw, line)) continue; // this line is fine; the card is blocked elsewhere
    blamedHere = true;
    const hit = REWRITES.find((rw) => {
      const rewritten = rw.apply(line);
      return rewritten !== null && compiles(raw, rewritten);
    });
    if (hit) put(`${hit.blame}: ${hit.id}`, raw.name, line.slice(0, 90));
    else put('UNSPLIT (no rewrite in the closed table compiles it)', raw.name, line.slice(0, 90));
  }
  if (!blamedHere) put('OTHER-CLAUSE (every family line compiles alone)', raw.name);
}

console.log('\n=== BLAME ======================================================');
const ordered = [...buckets.entries()].sort((a, b) => b[1].length - a[1].length);
for (const [key, names] of ordered) {
  console.log(`\n${String(names.length).padStart(5)}  ${key}`);
  for (const n of names.slice(0, TOP)) console.log(`         ${n}`);
  if (names.length > TOP) console.log(`         … and ${names.length - TOP} more`);
}
