/**
 * THE ANCHOR-ADOPTION GUARD (§3.143 GAP-13).
 *
 * ## The gap this exists because of
 * Two overlays — the damage sequence and the combat arcs — were built, unit
 * tested and shipped aiming face damage and attacks-on-a-player at
 * `life:<seat>`. `SeatPanel` published no such element. Both readers had a
 * graceful fallback to `board:<seat>`, so nothing crashed, nothing logged and
 * every test stayed green: an attack declared on a PLAYER quietly pointed at
 * that player's creature row instead, which is the precise readability failure
 * the overhaul exists to fix.
 *
 * Neither side could see the defect on its own. A module test proves an overlay
 * *computes* the right anchor name; a component test proves a panel *publishes*
 * one. The bug lived in the SEAM, and the seam is the only place a test can
 * catch it — so this file is about the relationship between publishers and
 * readers, not about either one.
 *
 * ## The class, not the instance
 * "A reader aims at an anchor nobody publishes" has as many instances as there
 * are anchors, and the next one will be added by whichever lane needs it. So the
 * assertions are over the whole `SEAT_ANCHOR_NAMES` table and the whole play
 * surface: every name the table declares must be published by someone, and every
 * name any module reads must be one the table declares. Adding an anchor is a
 * ROW plus a publisher; getting either wrong reddens here.
 *
 * A SOURCE test: the thing being asserted is a relationship between declarations
 * in files that no unit test mounts, and the app has no DOM test harness.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SEAT_ANCHOR_NAMES, seatAnchor, type SeatAnchorKind } from './animations.js';

/** The play surface: every module that could publish or read an anchor. */
const SOURCE_DIRS = ['../../components/play', '.'] as const;

/** CRLF-normalized, comment-free source — a doc-comment naming an anchor is not a use. */
function readSources(): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  for (const dir of SOURCE_DIRS) {
    const base = fileURLToPath(new URL(`${dir}/`, import.meta.url));
    for (const name of readdirSync(base)) {
      if (!/\.tsx?$/.test(name) || name.includes('.test.')) continue;
      const text = readFileSync(base + name, 'utf8')
        .replace(/\r\n/g, '\n')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^[ \t]*\/\/.*$/gm, '');
      out.set(name, text);
    }
  }
  return out;
}

const SOURCES = readSources();

/** Every `data-anim-anchor={…}` / `="…"` attribute value, as written. */
const PUBLISH_ATTRIBUTE = /data-anim-anchor=(\{(?:[^{}]|\{[^{}]*\})*\}|"[^"]*")/g;

/** A template-literal anchor: `` `library:${seat}` `` → "library". */
const TEMPLATE_NAME = /`([a-z][a-z-]*):\$\{/g;

/** A fully literal anchor: `"board:A"` → "board". */
const LITERAL_NAME = /"([a-z][a-z-]*):[A-Za-z]"/g;

/** A table-spelled anchor: `seatAnchor('life', …)` → the table's row. */
const TABLE_NAME = /seatAnchor\(\s*'([A-Za-z]+)'/g;

/**
 * WHERE AN ANCHOR IS READ. Anchor-shaped text is everywhere in a React tree
 * (`key={`p:${id}`}` is not an anchor), so a read is recognised by its CONTEXT
 * rather than by its shape — and each context is a general rule, not a file:
 *  1. the argument list of an `anchorRect(…)` measurement;
 *  2. a `[data-anim-anchor="…"]` selector;
 *  3. the body of a helper whose NAME says it names anchors (`flightAnchors`);
 *  4. a declared list of anchor KINDS, recognised by its `SeatAnchorKind[]`
 *     type — the type is what makes this a rule rather than a hard-coded
 *     variable name.
 * A read spelled some fifth way is simply not seen by this scan; it is not
 * approximated into one of these.
 */
const READ_CONTEXTS: readonly RegExp[] = [
  /anchorRect\([^)]*\)/g,
  /\[data-anim-anchor="[^\]]*\]/g,
  /function\s+[A-Za-z]*[Aa]nchors[A-Za-z]*\s*\([\s\S]*?\n\}/g,
];

/** Context 4: `const X: readonly SeatAnchorKind[] = ['life', 'board']`. */
const KIND_LIST = /readonly SeatAnchorKind\[\]\s*=\s*\[([^\]]*)\]/g;

/** One `'kind'` inside a {@link KIND_LIST}. */
const QUOTED_KIND = /'([A-Za-z]+)'/g;

/** `` `${SEAT_LIFE_ANCHOR}:${…}` `` — resolved from the same file's own constant. */
const INDIRECT_NAME = /`\$\{([A-Z_][A-Z0-9_]*)\}:\$\{/g;

/** What a scan found: the anchor names it could resolve, and what it could not. */
interface Scan {
  readonly names: Set<string>;
  readonly unresolved: string[];
}

/**
 * Pull every anchor NAME out of one chunk of source.
 *
 * Unresolvable spellings are collected rather than guessed at — they surface in
 * the failure message so a human can see what the scan could not read, but they
 * never silently widen or narrow an assertion.
 */
function scan(text: string, file: string, wholeFile: string): Scan {
  const names = new Set<string>();
  const unresolved: string[] = [];
  for (const [, name] of text.matchAll(TEMPLATE_NAME)) names.add(name as string);
  for (const [, name] of text.matchAll(LITERAL_NAME)) names.add(name as string);
  for (const [, kind] of text.matchAll(TABLE_NAME)) {
    const resolved = SEAT_ANCHOR_NAMES[kind as SeatAnchorKind];
    if (resolved === undefined) unresolved.push(`${file}: seatAnchor('${kind}') — not a row of the table`);
    else names.add(resolved);
  }
  for (const [, ident] of text.matchAll(INDIRECT_NAME)) {
    const declared = new RegExp(`const ${ident as string} = '([^']+)'`).exec(wholeFile);
    if (declared === null) unresolved.push(`${file}: \${${ident as string}} — no local const to resolve it from`);
    else names.add(declared[1] as string);
  }
  return { names, unresolved };
}

/** Split one file into what it PUBLISHES and what it READS. */
function publishedAndRead(file: string, text: string): { published: Scan; read: Scan } {
  const attributes = [...text.matchAll(PUBLISH_ATTRIBUTE)].map((m) => m[0] as string);
  // Publishing attributes are removed before the read contexts are cut, so an
  // attribute is never counted as both ends of the contract.
  let remainder = text;
  for (const attribute of attributes) remainder = remainder.replace(attribute, '');
  const readSnippets = READ_CONTEXTS.flatMap((pattern) => [...remainder.matchAll(pattern)].map((m) => m[0] as string));
  const read = scan(readSnippets.join('\n'), file, text);
  // Context 4: a declared list of anchor KINDS is a read of every kind in it.
  for (const [, list] of remainder.matchAll(KIND_LIST)) {
    for (const [, kind] of (list as string).matchAll(QUOTED_KIND)) {
      const resolved = SEAT_ANCHOR_NAMES[kind as SeatAnchorKind];
      if (resolved === undefined) read.unresolved.push(`${file}: SeatAnchorKind list names '${kind}', not a row`);
      else read.names.add(resolved);
    }
  }
  return { published: scan(attributes.join('\n'), file, text), read };
}

const SCANS = [...SOURCES].map(([file, text]) => ({ file, ...publishedAndRead(file, text) }));

/** Every anchor name the play surface publishes, with the file that publishes it. */
const PUBLISHED = new Map<string, string[]>();
/** Every anchor name the play surface reads, with the file that reads it. */
const READ = new Map<string, string[]>();
const UNRESOLVED: string[] = [];
for (const { file, published, read } of SCANS) {
  for (const name of published.names) PUBLISHED.set(name, [...(PUBLISHED.get(name) ?? []), file]);
  for (const name of read.names) READ.set(name, [...(READ.get(name) ?? []), file]);
  UNRESOLVED.push(...published.unresolved, ...read.unresolved);
}

/** Context appended to a failure so the reader is not left grepping. */
const DIAGNOSTIC =
  `\npublished: ${JSON.stringify([...PUBLISHED.keys()].sort())}` +
  `\nread: ${JSON.stringify([...READ.keys()].sort())}` +
  (UNRESOLVED.length > 0 ? `\nunresolved spellings: ${JSON.stringify(UNRESOLVED)}` : '');

describe('the scan itself is working (a guard that reads nothing guards nothing)', () => {
  it('found the play sources and at least one publisher and one reader', () => {
    expect(SOURCES.has('SeatPanel.tsx')).toBe(true);
    expect(SOURCES.has('CombatLines.tsx')).toBe(true);
    expect(PUBLISHED.size, DIAGNOSTIC).toBeGreaterThan(0);
    expect(READ.size, DIAGNOSTIC).toBeGreaterThan(0);
  });
});

describe('GAP-13 — an attack on a player points at that player', () => {
  it('SeatPanel publishes the LIFE anchor, spelled through the table', () => {
    // The instance. It is one attribute, it was missing, and both overlays that
    // wanted it silently aimed somewhere else.
    const seatPanel = SOURCES.get('SeatPanel.tsx') ?? '';
    expect(seatPanel).toMatch(/data-anim-anchor=\{seatAnchor\('life',/);
  });

  it('the life anchor is what the arcs and the damage sequence actually measure', () => {
    // …and it is PREFERRED over the creature row, not merely present: an arc
    // that fell back to `board:` while `life:` existed would look identical to
    // the bug this closes.
    expect(SOURCES.get('CombatLines.tsx') ?? '').toMatch(/SEAT_ANCHOR_ORDER[^=]*=\s*\[\s*'life'/);
    expect(READ.get('life'), `the life anchor is published but nothing reads it${DIAGNOSTIC}`).toBeDefined();
  });
});

describe('the class: publishers and readers cannot drift apart', () => {
  it('every anchor the table declares is published by someone', () => {
    for (const [kind, name] of Object.entries(SEAT_ANCHOR_NAMES)) {
      expect(PUBLISHED.get(name), `no component publishes "${name}" (SEAT_ANCHOR_NAMES.${kind})${DIAGNOSTIC}`).toBeDefined();
    }
  });

  it('every anchor any module READS is a row of the table', () => {
    // The direction that would have caught GAP-13 on its own: an overlay aiming
    // at a name the table does not know is aiming at nothing, and its graceful
    // fallback makes that invisible at runtime.
    const known = new Set<string>(Object.values(SEAT_ANCHOR_NAMES));
    for (const [name, files] of READ) {
      expect(known.has(name), `"${name}" is read by ${files.join(', ')} but is not in SEAT_ANCHOR_NAMES${DIAGNOSTIC}`).toBe(true);
    }
  });

  it('every anchor any module READS is published by someone', () => {
    for (const [name, files] of READ) {
      expect(PUBLISHED.get(name), `"${name}" is read by ${files.join(', ')} but nothing publishes it${DIAGNOSTIC}`).toBeDefined();
    }
  });

  it('the table has no duplicate spellings (two kinds would fight over one element)', () => {
    const names = Object.values(SEAT_ANCHOR_NAMES);
    expect(new Set(names).size).toBe(names.length);
  });

  it('seatAnchor is the one spelling: kind + seat, joined by a colon', () => {
    expect(seatAnchor('life', 'A')).toBe('life:A');
    expect(seatAnchor('handCount', 'B')).toBe('hand-count:B');
  });
});
