/**
 * RESOLVE THE CONFLICTS THAT ARE PURE ADDITIONS — and refuse every other kind.
 *
 * Every keyword-family branch adds to the same files: a DESIGN.md section at the
 * same anchor, a row in one of `rules.ts`'s tables, a `TRIGGER_BACKED_KEYWORDS`
 * entry, a price in `effect-value.ts`, a classification in
 * `paired-arms-config.ts`, a `KEYWORD_RULES` row in the conformance manifest.
 * Two branches that each append at the same place conflict on every merge, and
 * the resolution is always the same: KEEP BOTH SIDES, in branch order. The
 * integrator did that by hand five times on 2026-09-03 (§3.105–§3.108, §3.118),
 * which was five chances to drop a row by accident.
 *
 * ⚠️ WHAT IT REFUSES, AND WHY THAT IS THE POINT. "Keep both sides" is right for
 * an ADDITION and catastrophic for a real disagreement — two branches editing
 * one function, or one deleting what the other changed. So a hunk is resolved
 * only when the two sides share no meaningful line: if any content line appears
 * on both sides, that is two branches touching the same code, and the file is
 * left conflicted with a non-zero exit. Read those by hand.
 *
 * Two real cases from today that a naive version would have broken:
 *
 *   1. INTERLEAVED HUNKS. `rules.ts` came back with two conflict hunks separated
 *      by shared context, ours being A1…A2 and theirs B1…B2. Concatenating each
 *      hunk independently yields `A1 B1 <context> A2 B2` — syntactically broken,
 *      because A1's opening brace ends up closed by B2. The correct composition
 *      is `A1 <context> A2` then `B1 <context> B2`, which no per-hunk rule can
 *      see. This script therefore refuses a CODE file with more than one hunk
 *      and says why.
 *   2. A STRAY BRACE. Resolving that one by hand left an orphan `{` that only
 *      `tsc` caught. Nothing here ever writes a line neither side had.
 *
 * Usage, after `git merge` reports conflicts:
 *   node scripts/resolve-additive-conflicts.mjs            # report only
 *   node scripts/resolve-additive-conflicts.mjs --write    # resolve what it can
 *
 * It deliberately never runs `git add`: the merge stays unstaged so the build
 * and the suite get to decide, which is the order the gate has to happen in.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const WRITE = process.argv.includes('--write');

/** Files whose conflicts are additions by construction — a table, or a log. */
const ADDITIVE = new Set([
  'DESIGN.md',
  'COORDINATION.md',
  'packages/cards/src/compile/rules.ts',
  'packages/cards/src/compile/compile.ts',
  'packages/cards/src/compile/types.ts',
  'packages/cards/src/primitives.ts',
  'packages/core/src/card.ts',
  'packages/core/src/events.ts',
  'packages/core/src/index.ts',
  'packages/core/src/instance-ids.ts',
  'packages/core/src/internal/continuous.ts',
  'packages/core/src/conformance/rules-manifest.ts',
  'packages/ai/src/effect-value.ts',
  'packages/sim/src/paired-arms-config.ts',
  'packages/sim/src/soak-config.ts',
]);

const conflicted = execFileSync('git', ['diff', '--name-only', '--diff-filter=U'], { encoding: 'utf8' })
  .split('\n')
  .map((line) => line.trim())
  .filter(Boolean);

if (conflicted.length === 0) {
  console.log('no conflicted files.');
  process.exit(0);
}

const HUNK = /^<<<<<<< [^\r\n]*\r?\n([\s\S]*?)^=======\r?\n([\s\S]*?)^>>>>>>> [^\r\n]*\r?\n/gm;

/**
 * The lines of a side that carry CONTENT. Blank lines and brace-only lines are
 * shared punctuation, not evidence that two branches edited the same thing.
 */
function meaningful(side) {
  return side
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !/^[{}(),;[\]]+$/.test(line));
}

let refused = 0;
let resolved = 0;

for (const file of conflicted) {
  const text = readFileSync(file, 'utf8');
  const hunks = [...text.matchAll(HUNK)];
  const why = [];

  if (!ADDITIVE.has(file)) why.push('not in the additive list — read it by hand');
  if (hunks.length === 0) why.push('conflict markers are not in the standard three-part shape');
  for (const [, ours, theirs] of hunks) {
    const theirLines = new Set(meaningful(theirs));
    const shared = meaningful(ours).find((line) => theirLines.has(line));
    if (shared !== undefined) {
      why.push(`both sides contain ${JSON.stringify(shared.slice(0, 60))} — a real disagreement`);
      break;
    }
  }
  if (hunks.length > 1 && !file.endsWith('.md')) {
    why.push(`${hunks.length} hunks in a code file — the sides may interleave, so compose by hand`);
  }

  if (why.length > 0) {
    console.log(`REFUSED  ${file}`);
    for (const reason of why) console.log(`         ${reason}`);
    refused += 1;
    continue;
  }

  if (WRITE) {
    writeFileSync(file, text.replace(HUNK, (_match, ours, theirs) => ours + theirs));
    console.log(`resolved ${file}  (${hunks.length} hunk(s), both sides kept)`);
  } else {
    console.log(`would resolve ${file}  (${hunks.length} hunk(s), both sides kept)`);
  }
  resolved += 1;
}

console.log(
  `\n${resolved} file(s) ${WRITE ? 'resolved' : 'resolvable'}, ${refused} refused.` +
    (WRITE
      ? '\nNothing was staged. Build and run the suite before committing the merge.'
      : '\nRe-run with --write to apply.'),
);
if (refused > 0) process.exit(1);
