/**
 * THE DEBUG BENCH IS ADOPTED (§3.143 wave 2, GAP-18).
 *
 * ## The gap this file exists for
 * Wave 1 shipped `CARD_FACE_BENCH_SAMPLES` — a table of aftermarket card-face
 * treatments, with a sentence per row saying what a viewer should SEE — fully
 * unit-tested, and imported by NOTHING. The stack panel (UX-1/2) and the
 * opponent spell hold (UX-16) had no bench either. Every test was green and the
 * systems reached no screen, which is CLAUDE.md rule 3 failing silently: "a
 * system isn't done until you can observe and drive it at runtime".
 *
 * ## Why a shape test would not have caught it
 * A test that asserts a module exports the right thing passes whether or not
 * anything mounts it. The only assertion that can see "it never reaches a
 * screen" is one about who imports whom, so that is what this file asserts —
 * against the source on disk, because the mount site is a `.tsx` no Node test
 * can render.
 *
 * Two guards, one general and one specific:
 *
 *  1. **No orphan bench fixture.** Every `*_BENCH_*` constant exported by
 *     `lib/play` must be referenced by some component. This is the CLASS: it
 *     reddens for the next fixture built and never mounted, not just for the one
 *     that was.
 *  2. **The §3.143 mount sites, as a CLOSED TABLE.** One row per system that owes
 *     a bench. A new system is a ROW, and a row whose symbol is not imported and
 *     used by `EffectsPreview.tsx` fails by name.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/** `apps/web/src`, found from this file rather than from the process cwd. */
const WEB_SRC = fileURLToPath(new URL('../../', import.meta.url));

/** Read a file under `apps/web/src`, newline-normalised (the CRLF trap). */
function readSrc(relative: string): string {
  return readFileSync(`${WEB_SRC}${relative}`, 'utf8').replace(/\r\n/gu, '\n');
}

/** Every file under `apps/web/src` matching `predicate`, as repo-relative paths. */
function srcFiles(predicate: (name: string) => boolean): readonly string[] {
  const out: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(`${dir}${entry.name}/`, `${prefix}${entry.name}/`);
      else if (predicate(entry.name)) out.push(`${prefix}${entry.name}`);
    }
  };
  walk(WEB_SRC, '');
  return out;
}

/** Whether `text` mentions `symbol` as a whole identifier. */
function mentions(text: string, symbol: string): boolean {
  return new RegExp(`\\b${symbol}\\b`, 'u').test(text);
}

/**
 * Source with comments removed.
 *
 * Load-bearing, not tidiness: every bench section in this overhaul names its
 * fixture in its own doc comment ("Lane P built {@link CARD_FACE_BENCH_SAMPLES}
 * … and nothing imported it"), so a guard that searched raw text would be
 * satisfied by the PROSE ABOUT the gap while the gap was still open. A symbol
 * counts as mounted only when it appears in code.
 */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//gu, ' ').replace(/(^|[^:])\/\/[^\n]*/gu, '$1');
}

/* -------------------------------------------------------------------------- */
/* 1. No orphan bench fixture                                                  */
/* -------------------------------------------------------------------------- */

/**
 * A SCREAMING_SNAKE export with `BENCH` as one of its underscore-separated
 * segments — `DAMAGE_BENCH_ROWS`, `COMBAT_ARC_BENCH_ARCS`,
 * `CARD_FACE_BENCH_SAMPLES`. Types (`CardFaceBenchSample`, `DamageBenchRow`)
 * are deliberately NOT matched: a type is a shape, and a shape nobody
 * instantiates costs a reader nothing. A DATA table nobody mounts is the thing
 * that lies about a feature existing.
 */
const BENCH_CONSTANT = /^export const ([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*)\b/gmu;

function isBenchName(name: string): boolean {
  return name.split('_').includes('BENCH');
}

describe('every bench fixture in lib/play is mounted by a component', () => {
  const libPlay = srcFiles((name) => name.endsWith('.ts') && !name.endsWith('.test.ts')).filter(
    (path) => path.startsWith('lib/play/'),
  );
  const fixtures = libPlay.flatMap((path) => {
    const text = readSrc(path);
    return [...text.matchAll(BENCH_CONSTANT)]
      .map((match) => match[1] as string)
      .filter(isBenchName)
      .map((symbol) => ({ symbol, path }));
  });

  const components = srcFiles((name) => name.endsWith('.tsx') && !name.endsWith('.test.tsx')).map(
    (path) => code(readSrc(path)),
  );

  it('the sweep finds fixtures to check (never vacuously green)', () => {
    // Measured on the 2026-09-11 tree: DAMAGE_BENCH_* (5), COMBAT_ARC_BENCH_* (2)
    // and CARD_FACE_BENCH_SAMPLES. The floor only has to prove the walker works.
    expect(fixtures.map((f) => f.symbol)).toContain('CARD_FACE_BENCH_SAMPLES');
    expect(fixtures.length).toBeGreaterThan(5);
  });

  it('none of them is an orphan', () => {
    const orphans = fixtures
      .filter(({ symbol }) => !components.some((text) => mentions(text, symbol)))
      .map(({ symbol, path }) => `${symbol} (${path})`);
    // An orphan is a fixture that was built, tested, and shown to nobody — the
    // exact wave-1 failure. Mount it in `EffectsPreview.tsx` (or wherever its
    // system lives), or delete it; do not leave it as evidence of a feature that
    // reaches no screen.
    expect(orphans).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* 2. The §3.143 mount sites                                                   */
/* -------------------------------------------------------------------------- */

/** One system that owes a bench, and the symbol that proves it has one. */
interface BenchRow {
  /** The UX item from `docs/MTGA-UX-OVERHAUL.md` §1. */
  readonly item: string;
  /** The symbol `EffectsPreview.tsx` must import and use. */
  readonly symbol: string;
  /** The module it must come from — so a local re-declaration cannot satisfy this. */
  readonly from: string;
}

/**
 * CLOSED. A new §3.143 system is a ROW here and a section in the bench; a system
 * that has neither is a system nobody can drive at runtime.
 */
const BENCH_ROWS: readonly BenchRow[] = [
  { item: 'UX-9 / UX-11 tabletop', symbol: 'BOARD_3D_CONFIG', from: '../../lib/play/play-config.js' },
  {
    item: 'UX-14 combat arcs',
    symbol: 'COMBAT_ARC_BENCH_ARCS',
    from: '../../lib/play/combat-lines.js',
  },
  { item: 'UX-15 damage distribution', symbol: 'DamageBench', from: './AnimationLayer.js' },
  { item: 'UX-1 / UX-2 the stack', symbol: 'StackPanel', from: './StackPanel.js' },
  { item: 'UX-16 opponent spell hold', symbol: 'spellHoldDecision', from: '../../lib/play/spell-hold.js' },
  {
    item: 'UX-17 aftermarket card faces',
    symbol: 'CARD_FACE_BENCH_SAMPLES',
    from: '../../lib/play/provenance-view.js',
  },
  { item: 'UX-17 the card renderer itself', symbol: 'CardFace', from: './CardFace.js' },
];

describe('EffectsPreview registers every §3.143 system (CLAUDE.md rule 3)', () => {
  const bench = readSrc('components/play/EffectsPreview.tsx');
  /**
   * Everything after the import block, comments stripped — where a symbol has to
   * be USED, not merely imported and then talked about in a doc comment.
   */
  const body = code(bench.slice(bench.lastIndexOf("import './effects-bench.css';")));

  it.each(BENCH_ROWS.map((row) => [row.item, row] as const))('%s', (_item, row) => {
    expect(
      mentions(bench, row.symbol),
      `${row.symbol} is not imported by EffectsPreview.tsx — ${row.item} has no bench`,
    ).toBe(true);
    expect(
      bench.includes(row.from),
      `${row.symbol} must come from ${row.from}, not from a local re-declaration`,
    ).toBe(true);
    expect(
      mentions(body, row.symbol),
      `${row.symbol} is imported but never used — an import is not a mount`,
    ).toBe(true);
  });

  it('the body slice really is the body (the guard above cannot pass on the import block)', () => {
    expect(body.length).toBeGreaterThan(1000);
    expect(body.length).toBeLessThan(bench.length);
  });
});
