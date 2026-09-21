/**
 * DESIGN §3.179, item 2 acceptance 2 — THE GUARD.
 *
 * > "A test enumerates the call sites of `decideVerdict` and fails if one renders
 * > the verdict without the reason — the guard that fails if this class comes
 * > back."
 *
 * `decideVerdict` is the ONE funnel every A/B surface in the repo reads: Suggest,
 * the trim, the manabase sweep, the joint search, the pilot A/B and the web
 * merge. That is why a seven-line change there reached every surface at once —
 * and it is also why a NEW surface can quietly reintroduce the defect by
 * consuming the verdict and dropping the reason on the floor. Prose does not
 * hold on this repo; this is that rule in executable form.
 *
 * It scans SOURCE, not exports, because the failure it guards is a rendering
 * omission rather than a type error: a panel that prints `verdict` and never
 * mentions `verdictReason` compiles perfectly.
 *
 * Idiom borrowed from `apps/web/src/retired-ui-vocabulary.test.ts` — a recursive
 * walk, CRLF normalised, comments stripped (so a reason MENTIONED IN PROSE can
 * never satisfy an assertion), and an explicit anti-vacuity suite, because a
 * source-scanning guard that walks the wrong directory passes silently.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/** Where a verdict can be decided or drawn. */
const SCANNED_ROOTS = ['packages/sim/src', 'apps/web/src'] as const;

interface SourceFile {
  readonly path: string;
  /** Comment-free, LF-normalised text. */
  readonly code: string;
}

/**
 * ⚠️ THIS GUARD'S OWN FIRST RED. The first version stripped only FULL-LINE
 * `//` comments, so a TRAILING `// verdictReason` would have satisfied every
 * assertion below — a guard that can be silenced by a comment is exactly the
 * can't-fail check this file exists to prevent. This is
 * `retired-ui-vocabulary.test.ts`'s stripper, verbatim; its `(^|[^:])` guard is
 * what keeps it from eating the `//` inside an `https://` URL.
 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//gu, ' ').replace(/(^|[^:])\/\/[^\n]*/gu, '$1');
}

function sources(): readonly SourceFile[] {
  const out: SourceFile[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.tsx?$/u.test(entry.name)) continue;
      // A test may legitimately assert on a verdict without rendering a reason.
      if (/\.test\.tsx?$/u.test(entry.name)) continue;
      const raw = readFileSync(full, 'utf8').replace(/\r\n/gu, '\n');
      out.push({ path: relative(REPO_ROOT, full).replace(/\\/gu, '/'), code: stripComments(raw) });
    }
  };
  for (const root of SCANNED_ROOTS) walk(join(REPO_ROOT, root));
  return out;
}

const FILES = sources();

/** Files that CALL the funnel (the export line in `index.ts` has no parenthesis). */
const CALL_SITES = FILES.filter((f) => /\bdecideVerdict\s*\(/u.test(f.code));

/** Files that DRAW a verdict for a human: the web's one display funnel. */
const RENDER_SITES = FILES.filter((f) => /\bverdictDisplay\s*\(/u.test(f.code));

/** Any mention of the reason vocabulary that is not a comment. */
const MENTIONS_REASON = /verdictReason|SWAP_VERDICT_REASON|verdictReasonDisplay|\breason\b/u;

describe('§3.179 — the guard is not vacuous', () => {
  it('actually walked the source tree', () => {
    expect(FILES.length, 'the walker found no sources — wrong root?').toBeGreaterThan(100);
    for (const root of SCANNED_ROOTS) {
      expect(FILES.some((f) => f.path.startsWith(root)), `nothing scanned under ${root}`).toBe(true);
    }
  });

  it('found the call sites the plan measured', () => {
    // The plan names six: swap.ts, manabase-reliability.ts x2 (one file),
    // pilot-ab.ts, suggest-report.ts and the web merge. Five FILES.
    expect(CALL_SITES.length, 'decideVerdict call sites vanished — did the funnel move?').toBeGreaterThanOrEqual(5);
    for (const expected of [
      'packages/sim/src/swap.ts',
      'packages/sim/src/manabase-reliability.ts',
      'packages/sim/src/pilot-ab.ts',
      'packages/sim/src/suggest-report.ts',
      'apps/web/src/lib/sim/merge.ts',
    ]) {
      expect(
        CALL_SITES.map((f) => f.path),
        `${expected} no longer calls decideVerdict — if that is deliberate, update this list`,
      ).toContain(expected);
    }
  });

  it('found the render sites', () => {
    expect(RENDER_SITES.length, 'no verdict render sites found').toBeGreaterThanOrEqual(4);
  });

  it('comments cannot satisfy an assertion', () => {
    const withComment = stripComments('const a = 1; // verdictReason\n/* verdictReason */\nconst b = 2;');
    expect(withComment).not.toMatch(/verdictReason/u);
  });
});

describe('§3.179 acceptance 2 — every decideVerdict call site carries the reason', () => {
  it.each(CALL_SITES.map((f) => f.path))('%s does not drop the reason on the floor', (path) => {
    const file = CALL_SITES.find((f) => f.path === path) as SourceFile;
    expect(
      MENTIONS_REASON.test(file.code),
      `${path} calls decideVerdict but never mentions the reason. The funnel that decides is the `
        + `funnel that explains — carry \`decision.reason\` through instead of taking only \`.verdict\`.`,
    ).toBe(true);
  });

  it.each(CALL_SITES.map((f) => f.path))('%s does not treat the decision as a bare verdict', (path) => {
    const file = CALL_SITES.find((f) => f.path === path) as SourceFile;
    // `decideVerdict(...)` returns an object now. A site that compares it to a
    // verdict string is reading the old shape and would be a type error — but a
    // site that spreads it into a `verdict:` field would NOT be, and that is the
    // silent regression this catches.
    expect(
      /decideVerdict\s*\([^;]*\)\s*===/u.test(file.code),
      `${path} compares decideVerdict's result to a value — it returns { verdict, reason }.`,
    ).toBe(false);
  });
});

describe('§3.179 — every surface that draws a verdict also draws its reason', () => {
  it.each(RENDER_SITES.map((f) => f.path))('%s renders the reason beside the verdict', (path) => {
    const file = RENDER_SITES.find((f) => f.path === path) as SourceFile;
    expect(
      MENTIONS_REASON.test(file.code),
      `${path} renders a verdict through verdictDisplay() but never renders its reason. `
        + `INCONCLUSIVE alone is three different answers wearing one word (DESIGN §3.179) — `
        + `use verdictReasonDisplay(evaluation.verdictReason, reasonContextOf(row, report.notes.stats)).`,
    ).toBe(true);
  });
});

describe('§3.179 — nothing re-derives the reason', () => {
  it('no file outside the funnel reconstructs the reason from p-values and counts', () => {
    const offenders = FILES.filter(
      (f) =>
        f.path !== 'packages/sim/src/swap.ts' &&
        /['"]tooFewGames['"]|['"]notSignificant['"]|['"]deadHeat['"]/u.test(f.code),
    );
    expect(
      offenders.map((f) => f.path),
      'a reason literal outside swap.ts means a second place is deciding WHY — read the '
        + 'reason off the evaluation instead, or the two will eventually disagree and the bug '
        + 'will be blamed on neither.',
    ).toEqual([]);
  });
});
