import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ORIGIN_STORAGE_BUDGET_CHARS,
  STORAGE_AREAS,
  STORAGE_BUDGET_HEADROOM_SHARE,
  allocatedLocalShare,
  areaForKey,
  writeBudgetChars,
} from './budget.js';

/**
 * THE CLASS GUARD.
 *
 * Two imported decks were lost because `saveDecks` swallowed a quota error into
 * a `console.warn`. Fixing that one function would have been a patch on one
 * symptom: fourteen other modules had the same `try { setItem } catch { }`, and
 * the next feature would have written a fifteenth.
 *
 * So the fix was a funnel — `persistence/write.ts` — and this is the test that
 * makes the funnel mandatory. It reads the web app's own source and fails if a
 * `setItem` appears anywhere else, or if a storage key is written that no budget
 * row claims. A NEW swallowing write cannot pass the suite, which is the only
 * form of this rule that has ever held (CLAUDE.md rule 10).
 */

const SRC_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

/**
 * Files allowed to call `setItem` directly, and why.
 *
 * A CLOSED table: a new entry is a deliberate, reviewed decision with a stated
 * reason, not something a call site can assume. If this list ever needs a real
 * exception, the reason column is what a future reader will be judged against.
 */
const DIRECT_SETITEM_ALLOWED: ReadonlyArray<{ readonly file: string; readonly why: string }> = [
  {
    file: join('lib', 'persistence', 'write.ts'),
    why: 'It IS the funnel. Exactly one place performs the write and reports its result.',
  },
];

/** Recursively list every .ts/.tsx file under the web app source. */
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      sourceFiles(full, out);
    } else if (/\.tsx?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * A `.setItem(` CALL, not an interface member.
 *
 * The injectable storage seams (`PlayStorage`, `FlagStorage`, `WritableStorage`)
 * declare `setItem(key: string, value: string): void;` as a TYPE, which is not a
 * write and must not fail this guard. A call is preceded by a `.` or a `?.`.
 */
const SETITEM_CALL = /[?.]\s*setItem\s*\(/;

/** Test files are excluded: a test may legitimately stub and drive a storage. */
function isTestFile(file: string): boolean {
  return /\.test\.tsx?$/.test(file);
}

describe('no write to Web Storage may bypass the funnel', () => {
  const files = sourceFiles(SRC_ROOT).filter((f) => !isTestFile(f));

  it('finds the app source at all (a guard that scans nothing always passes)', () => {
    // The failure mode this test exists to avoid in ITSELF: a wrong root, an
    // empty list, and a green result that means nothing. Pin the population.
    expect(files.length).toBeGreaterThan(100);
    expect(files.some((f) => f.endsWith(join('lib', 'storage.ts')))).toBe(true);
    expect(files.some((f) => f.endsWith(join('lib', 'play', 'persist.ts')))).toBe(true);
    expect(files.some((f) => f.endsWith(join('lib', 'play', 'history.ts')))).toBe(true);
  });

  it('calls setItem from the funnel and nowhere else', () => {
    const allowed = new Set(DIRECT_SETITEM_ALLOWED.map((row) => row.file));
    const offenders: string[] = [];
    for (const file of files) {
      const rel = relative(SRC_ROOT, file);
      if (allowed.has(rel)) continue;
      const text = readFileSync(file, 'utf8');
      for (const [index, line] of text.split(/\r?\n/).entries()) {
        if (SETITEM_CALL.test(line)) offenders.push(`${rel.split(sep).join('/')}:${index + 1}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  /**
   * The other half of the class. A write can also go silent by routing through
   * the funnel and then dropping the result on the floor inside a `try/catch`
   * that does nothing. The three modules named in the bug report are pinned
   * against ever growing an empty catch around a write again.
   */
  it('leaves no empty catch in the modules that lost the decks', () => {
    const PINNED = [
      join('lib', 'storage.ts'),
      join('lib', 'play', 'persist.ts'),
      join('lib', 'play', 'history.ts'),
    ];
    const offenders: string[] = [];
    for (const rel of PINNED) {
      const text = readFileSync(join(SRC_ROOT, rel), 'utf8');
      // `catch { }` / `catch (e) { }` with nothing but whitespace inside. A
      // catch that only comments is NOT flagged: the reads in these modules
      // degrade on purpose and say so, and forcing them to fake a statement
      // would be worse than the thing being guarded.
      for (const match of text.matchAll(/catch\s*(?:\([^)]*\))?\s*\{\s*\}/g)) {
        const line = text.slice(0, match.index).split(/\r?\n/).length;
        offenders.push(`${rel.split(sep).join('/')}:${line}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('the storage budget is owned in one place and adds up', () => {
  it('does not commit more of the origin than the origin has', () => {
    // A budget whose rows sum to 100% is not a budget: the last consumer to
    // write still fails, which is the failure being fixed.
    expect(allocatedLocalShare() + STORAGE_BUDGET_HEADROOM_SHARE).toBeLessThanOrEqual(1);
  });

  it('keeps the game library from being able to starve the saved decks', () => {
    // The specific regression: PLAY_HISTORY_MAX_CHARS was 4,000,000 against an
    // origin that is 2,500,000 characters on the most conservative browsers.
    const history = writeBudgetChars('play-history');
    const decks = writeBudgetChars('decks');
    expect(history).toBeLessThan(ORIGIN_STORAGE_BUDGET_CHARS);
    expect(history + decks).toBeLessThan(ORIGIN_STORAGE_BUDGET_CHARS);
  });

  it('gives every area a positive budget and a distinct id', () => {
    const ids = STORAGE_AREAS.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const area of STORAGE_AREAS) {
      expect(writeBudgetChars(area.id as never)).toBeGreaterThan(0);
      expect(area.why.length).toBeGreaterThan(0);
    }
  });

  it('claims every key it writes, and refuses one it does not', () => {
    for (const area of STORAGE_AREAS) {
      const sample =
        area.match.kind === 'exact' ? area.match.key : `${area.match.prefix}.v1.pilot.abc`;
      expect(areaForKey(sample)?.id).toBe(area.id);
    }
    // A closed table REPORTS a miss rather than widening to the nearest row.
    expect(areaForKey('some.other.apps.key')).toBeNull();
  });
});
