/**
 * NO SOURCE FILE MAY HARD-CODE THE SIZE OF THE POOL.
 *
 * ## The bug this exists for
 * The pool is GENERATED data. It went 191 → 357 → 5,651 → 6,914 over the life of
 * this repo, and every one of those regenerations silently falsified any comment
 * or string that had written the number down. When this guard was added, FIVE
 * live sites still claimed the pool held 357 cards — one of them inside a string
 * the conformance manifest prints to a user:
 *
 *     `No card in the shipped pool (357 cards, …) is a ${what}.`
 *
 * …against a pool of 6,914. That is an order of magnitude, in output presented
 * as fact.
 *
 * ## Why this is the guard and not "update the number"
 * CLAUDE.md is explicit that a stale comment is a bug with a blast radius, and
 * names the precedent: three comments claimed a 32-card index long after it
 * became 156, and an agent filed and WORKED a headline defect that did not
 * exist. Updating 357 to 6,914 buys exactly one regeneration before the same
 * bug returns, so the fix for the CLASS (rule 10) is to forbid the number
 * outright. A count that is not written down cannot go stale.
 *
 * Derive it (`CARD_POOL.length`) or leave it out — the sentences these appeared
 * in never needed it.
 *
 * ## What is still allowed
 * HISTORY. "the pool went 191 → 357 cards AT THE TIME" explains why the soak was
 * written and is true forever, so a line marked with one of {@link HISTORICAL}
 * is skipped. The marker is deliberately explicit: an author who wants to keep a
 * number has to say out loud that it is historical.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CARD_POOL } from '../data/pool.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** Source roots that ship. Generated data is excluded — it carries real counts. */
const ROOTS = ['packages', 'apps'] as const;
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mjs'] as const;
/** Never swept: build output, dependencies, and this guard's own explanation. */
const SKIP_DIRS = new Set(['node_modules', 'dist', 'dist-bundle', 'data-cache', 'verify-out']);
const SELF = 'pool-size-claims.test.ts';

/**
 * A line saying so is stating history, not a current fact, and is exempt.
 * Upper-case on purpose: it has to be a deliberate act, not a turn of phrase.
 */
const HISTORICAL = ['AT THE TIME', '(historical)', 'HISTORICAL'] as const;

/**
 * The phrasings that assert a CURRENT pool size.
 *
 * Narrow by design: this forbids claims about the pool's size, not every number
 * near the word "pool". A deck list of 60 or a mana curve of 24 is none of its
 * business.
 */
const CLAIM_PATTERNS: readonly RegExp[] = [
  /(\d[\d,]*)[- ]card pool\b/i,
  /\bpool \((\d[\d,]*) cards?\b/i,
  /\bpool of (\d[\d,]*) cards?\b/i,
  /\bshipped pool (?:is|holds|has) (\d[\d,]*)\b/i,
];

interface Claim {
  readonly file: string;
  readonly line: number;
  readonly text: string;
  readonly claimed: string;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (SOURCE_EXTENSIONS.some((e) => entry.endsWith(e)) && entry !== SELF) out.push(full);
  }
  return out;
}

/** Every stale-able pool-size claim in one file's text. */
function claimsIn(file: string, source: string): Claim[] {
  const found: Claim[] = [];
  source.split(/\r?\n/).forEach((text, index) => {
    if (HISTORICAL.some((marker) => text.includes(marker))) return;
    for (const pattern of CLAIM_PATTERNS) {
      const hit = pattern.exec(text);
      if (hit) {
        found.push({
          file: file.slice(REPO_ROOT.length + 1).replace(/\\/g, '/'),
          line: index + 1,
          text: text.trim().slice(0, 120),
          claimed: hit[1] ?? '?',
        });
        break;
      }
    }
  });
  return found;
}

const FILES = ROOTS.flatMap((root) => walk(resolve(REPO_ROOT, root)));

describe('no source file hard-codes the pool size', () => {
  it('the sweep is not vacuous — it reads the real source tree', () => {
    // A guard whose file list silently went empty would pass forever. Pin both
    // that it found a lot of files and that it found specific ones that exist.
    expect(FILES.length).toBeGreaterThan(300);
    const relative = FILES.map((f) => f.slice(REPO_ROOT.length + 1).replace(/\\/g, '/'));
    expect(relative).toContain('packages/sim/src/soak.ts');
    expect(relative).toContain('packages/core/src/conformance/rules-manifest.ts');
  });

  it('the matcher actually catches the wording that caused the bug', () => {
    // Watch it go RED on demand: the exact strings that were live in the repo,
    // plus the historical form that must NOT trip it. Without this, a matcher
    // broken into never matching anything would report a clean sweep.
    const caught = claimsIn('x.ts', 'THE FULL-POOL SOAK — across the whole 357-card pool,');
    expect(caught).toHaveLength(1);
    expect(caught[0]?.claimed).toBe('357');

    expect(claimsIn('x.ts', 'No card in the shipped pool (357 cards, `x`) is a Vanguard.')).toHaveLength(1);
    expect(claimsIn('x.ts', 'it walks a pool of 6,914 cards and serializes each')).toHaveLength(1);

    // History is exempt, and the exemption must be the marked kind only.
    expect(claimsIn('x.ts', 'the pool went 191 → 357 cards AT THE TIME')).toHaveLength(0);
    expect(claimsIn('x.ts', 'a 60-card deck and a 24-land mana base')).toHaveLength(0);
  });

  it('no shipped source claims a pool size', () => {
    const claims = FILES.flatMap((file) => claimsIn(file, readFileSync(file, 'utf8')));
    expect(
      claims.map((c) => `${c.file}:${c.line} claims ${c.claimed} — ${c.text}`),
      `The pool is GENERATED data and is currently ${CARD_POOL.length} cards. A count written ` +
        'into a comment or a string is false the next time it is regenerated, and this repo has ' +
        'already lost an agent-day to exactly that (CLAUDE.md: three comments claimed a 32-card ' +
        'index long after it became 156). Derive it from CARD_POOL.length, or drop it — these ' +
        'sentences do not need the number. If it is genuinely HISTORY, say so on the line with ' +
        `one of: ${HISTORICAL.join(', ')}.`,
    ).toEqual([]);
  });
});
