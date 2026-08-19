/**
 * THE GUARD THAT MAKES THE DEFECT UNSPELLABLE.
 *
 * Core's stat accessors default their `AggregatedMod` to "nothing modifies this".
 * That default is a documented convenience for a caller that has already
 * established no modification can apply — and in `packages/ai` it was, for ~40
 * call sites, simply an omission. The pilots were reading PRINTED cards: a
 * Tarmogoyf evaluated as 0/0, every anthem was invisible, every Aura and every
 * Equipment was invisible, and granted keywords were read from `def.keywords` on
 * the AI path while the rules path read the granted set.
 *
 * Nothing about that was detectable from a green suite, because a bare call is
 * valid TypeScript that returns a plausible number. So this test reads the
 * package's own source and fails if a bare (single-argument) core stat accessor
 * reappears anywhere in it. The rule the repo already applies to mana payment and
 * effect primitives — make the wrong thing unspellable rather than remembering not
 * to spell it — applied to the one accessor that silently lies.
 *
 * WHAT IS ALLOWED: passing the aggregate explicitly (`effectivePower(perm, mod)`),
 * which `tactical.ts` does because it reads four stats off one lookup; and
 * `board-stats.ts` itself, which is the wrapper every other module goes through.
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = dirname(fileURLToPath(import.meta.url));

/**
 * The wrapper module — the one place the bare-defaulting accessors may be named —
 * plus this file, whose own fixtures spell the forbidden shape on purpose to prove
 * the detector detects it.
 */
const EXEMPT = new Set(['board-stats.ts', 'bare-stats.test.ts']);

/**
 * A call to a stat accessor whose argument list contains no comma and no nested
 * call — i.e. exactly one simple argument, i.e. no aggregate. `effectivePower(perm)`
 * and `effectivePower(perm as CardInstance)` both match; `effectivePower(perm, mod)`
 * does not.
 */
const BARE_CALL = /\b(effectivePower|effectiveToughness|effectiveKeywords|remainingToughness|hasKeyword)\(\s*[^(),]*\s*\)/g;

function sourceFiles(): string[] {
  return readdirSync(SRC).filter((f) => f.endsWith('.ts') && !EXEMPT.has(f));
}

describe('no bare continuous-blind stat reads in packages/ai', () => {
  it('never calls a core stat accessor without an aggregate', () => {
    const offences: string[] = [];
    for (const file of sourceFiles()) {
      const text = readFileSync(join(SRC, file), 'utf8');
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] as string;
        // Prose in a doc comment is not a call site.
        if (/^\s*(\*|\/\/)/.test(line)) continue;
        BARE_CALL.lastIndex = 0;
        const match = BARE_CALL.exec(line);
        if (match) offences.push(`${file}:${i + 1}  ${line.trim()}`);
      }
    }
    expect(
      offences,
      'A stat accessor called with no AggregatedMod answers the PRINTED card: a ' +
        'Tarmogoyf reads 0/0 and every anthem, Aura and Equipment is invisible. ' +
        "Use the helpers in './board-stats.js' (they require an index), or pass an " +
        'explicit aggregate.',
    ).toEqual([]);
  });

  it('actually detects the defect it exists to prevent', () => {
    // The guard is only worth its runtime if it fails on the shape it forbids —
    // the recurring repo failure is a check that reports something other than
    // "I did not check".
    BARE_CALL.lastIndex = 0;
    expect(BARE_CALL.test('const p = effectivePower(perm);')).toBe(true);
    BARE_CALL.lastIndex = 0;
    expect(BARE_CALL.test('const p = effectivePower(perm as CardInstance);')).toBe(true);
    BARE_CALL.lastIndex = 0;
    expect(BARE_CALL.test('const p = effectivePower(perm, mod);')).toBe(false);
    BARE_CALL.lastIndex = 0;
    expect(BARE_CALL.test('const k = effectiveKeywords(perm, index.get(id) ?? NO_MOD);')).toBe(false);
  });

  it('scans a non-empty set of files', () => {
    // A glob that silently matched nothing would make both assertions above pass
    // forever while checking nothing at all.
    expect(sourceFiles().length).toBeGreaterThan(10);
  });
});
