/**
 * EVERY TEST FILE ON DISK IS ACTUALLY COLLECTED (§3.143 wave 2, GAP-17).
 *
 * ## Why this lives in `conformance/`
 * This directory exists to make the invisibly-absent impossible: a rule nothing
 * tests, a keyword no rule indexes. A test file the RUNNER never collects is the
 * most invisibly-absent thing there is — the file is written, the assertions are
 * real, and the summary still says "0 failed". It belongs with the other
 * absence guards, not beside any one feature.
 *
 * ## The gap
 * The root config's `include` was `{packages,apps}/*\/src/**\/*.test.ts`. No
 * `.test.tsx` existed, so nothing was skipped — but this overhaul added React
 * components, `.test.tsx` is what a component test would be called, and the
 * failure would have been silent: a green run over a file nobody ran. That is
 * the same false-green this repo has already been bitten by (a dead worker
 * exiting 9 mid-suite), arriving through the config instead.
 *
 * ## What it asserts
 * Not "the glob contains tsx" — that is a restatement of the fix. It asserts the
 * PROPERTY: every file on disk that looks like a test is matched by at least one
 * of the config's own include patterns. The patterns are read from the real
 * config object, so there is one answer to "what does the suite collect" and
 * this file is not a second copy of it.
 *
 * The glob matcher below is deliberately TINY and CLOSED: it understands `*`,
 * `**` and `{a,b}`, and THROWS on anything else rather than approximating. A
 * pattern this file cannot read must be taught to it, because a matcher that
 * quietly mis-reads a pattern would hand back exactly the false green it is
 * here to prevent.
 */

import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import rootConfig from '../../../../vitest.config.js';

/** The repo root, found from this file rather than from the process cwd. */
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

/**
 * Directories the suite could never collect from, skipped so the walk stays a
 * fraction of a second. `node_modules` alone holds ~2,000 files whose names end
 * in `.test.js`, none of them this repo's.
 */
const NOT_OURS: ReadonlySet<string> = new Set([
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.git',
  '.testmebro',
  '.vite',
  // Agent scaffolding, and — the reason it is named here rather than assumed —
  // `.claude/worktrees/<name>/` holds FULL SEPARATE CHECKOUTS of this repo
  // (DESIGN §6 parallel development). Their tests are real, and are collected by
  // that worktree's own `vitest run`; counting them here would make this guard
  // fail on any machine that happens to have a worktree open, which is a guard
  // nobody would keep.
  '.claude',
]);

/** Anything a human would call a test file, whatever extension it wears. */
const LOOKS_LIKE_A_TEST = /\.test\.[cm]?[jt]sx?$/u;

/** Every test-shaped file in the repo, as POSIX-style repo-relative paths. */
function testFilesOnDisk(): readonly string[] {
  const out: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (NOT_OURS.has(entry.name)) continue;
        walk(`${dir}${entry.name}/`, `${prefix}${entry.name}/`);
      } else if (LOOKS_LIKE_A_TEST.test(entry.name)) {
        out.push(`${prefix}${entry.name}`);
      }
    }
  };
  walk(REPO_ROOT, '');
  return out;
}

/** Characters that mean something in a glob but that this matcher does not implement. */
const UNSUPPORTED_GLOB_SYNTAX = /[?[\]()!+@]/u;

/**
 * The four constructs the repo's include patterns actually use, and nothing
 * else. An unsupported character REPORTS (throws, naming the pattern) rather
 * than being dropped — silent approximation here would be a matcher that says
 * "collected" about a file the runner never sees.
 */
function globToRegExp(pattern: string): RegExp {
  let source = '^';
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i] as string;
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        if (pattern[i + 2] === '/') {
          // `**/` — any number of directory levels, including none.
          source += '(?:[^/]+/)*';
          i += 2;
        } else {
          source += '.*';
          i += 1;
        }
      } else {
        source += '[^/]*';
      }
      continue;
    }
    if (ch === '{') {
      const close = pattern.indexOf('}', i);
      if (close === -1) throw new Error(`unterminated brace in glob: ${pattern}`);
      const alternatives = pattern.slice(i + 1, close).split(',');
      for (const alternative of alternatives) {
        if (/[*{}]/u.test(alternative)) {
          throw new Error(`nested glob syntax inside braces is not supported: ${pattern}`);
        }
      }
      source += `(?:${alternatives.map(escapeLiteral).join('|')})`;
      i = close;
      continue;
    }
    if (UNSUPPORTED_GLOB_SYNTAX.test(ch)) {
      throw new Error(`unsupported glob syntax '${ch}' in ${pattern} — teach the matcher first`);
    }
    source += escapeLiteral(ch);
  }
  return new RegExp(`${source}$`, 'u');
}

function escapeLiteral(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/** The include patterns the SUITE runs on — read from the config, never retyped. */
function includePatterns(): readonly string[] {
  const configured = rootConfig.test?.include;
  expect(configured, 'vitest.config.ts declares no test.include').toBeDefined();
  return configured as readonly string[];
}

describe('the glob matcher itself', () => {
  // It is the only piece of NEW logic here, so it is pinned before it is trusted.
  it('reads the constructs the repo uses', () => {
    const re = globToRegExp('{packages,apps}/*/src/**/*.test.{ts,tsx}');
    expect(re.test('packages/core/src/statics.test.ts')).toBe(true);
    expect(re.test('apps/web/src/components/play/x.test.tsx')).toBe(true);
    expect(re.test('apps/server/src/choice-flow.test.ts')).toBe(true);
    expect(re.test('packages/core/bench/x.test.ts')).toBe(false);
    expect(re.test('packages/core/src/statics.ts')).toBe(false);
    expect(re.test('scripts/x.test.ts')).toBe(false);
  });

  it('REFUSES a pattern it cannot read, rather than guessing', () => {
    expect(() => globToRegExp('src/**/[abc].test.ts')).toThrow(/unsupported glob syntax/u);
  });
});

describe('GAP-17 — nothing that looks like a test is left uncollected', () => {
  const onDisk = testFilesOnDisk();
  const matchers = includePatterns().map(globToRegExp);

  it('the walk found the suite (never vacuously green)', () => {
    // 400+ test files on the 2026-09-11 tree. The floor only has to prove the
    // walk reached the workspaces at all.
    expect(onDisk.length).toBeGreaterThan(100);
  });

  it('every one of them matches an include pattern', () => {
    const uncollected = onDisk.filter((path) => !matchers.some((re) => re.test(path)));
    // A name here is a file full of assertions that NEVER RUN, while the summary
    // still reports "0 failed". Either widen `test.include` in vitest.config.ts
    // or move the file under a workspace's `src/`.
    expect(uncollected).toEqual([]);
  });

  it('a `.test.tsx` would be collected today — the specific hole GAP-17 closed', () => {
    // Zero exist right now, which is exactly why nothing could see the hole. This
    // asserts the config is ready for the first one instead of waiting for it.
    expect(matchers.some((re) => re.test('apps/web/src/components/play/CardFace.test.tsx'))).toBe(
      true,
    );
  });
});
