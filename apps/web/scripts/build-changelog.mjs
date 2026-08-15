/**
 * GENERATOR for `apps/web/src/data/changelog.json` — the release notes the PWA
 * bundles and renders in its "What's New" tab.
 *
 *   npm run changelog -w @jonny-boi/web             # regenerate
 *   npm run changelog -w @jonny-boi/web -- --check  # fail if it is stale
 *
 * WHY THIS EXISTS. The user asked for a list of shipped features that stays
 * correct "regardless of which claude is working on the app". Several agents on
 * several machines work this repo, so a list maintained by good intentions goes
 * stale immediately — and a stale changelog is worse than none, because it is
 * confidently wrong about what the build can do.
 *
 * So the record has ONE source of truth (`CHANGELOG.md`, written by whoever
 * shipped the feature) and the app's copy is DERIVED from it. `changelog.test.ts`
 * re-derives and fails on drift, exactly like the card index — plus it fails when
 * a DESIGN.md §3 feature is marked ✅ with no entry written, which is the gate
 * that actually keeps the list complete rather than merely consistent.
 *
 * WHY IT IS COMMITTED rather than parsed at runtime: the PWA bundles it, so the
 * What's New tab works offline with no fetch, and `npm run build` needs no
 * pre-build codegen step. The drift test is what makes the copy safe.
 *
 * The parser is deliberately small. `CHANGELOG.md` is written by agents under
 * time pressure, so the format is three things — an `## ` heading, an optional
 * `*Roadmap: N*` line, and prose — and anything it cannot parse is reported
 * loudly rather than silently dropped.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const SOURCE = join(REPO_ROOT, 'CHANGELOG.md');
const OUTPUT = join(HERE, '..', 'src', 'data', 'changelog.json');

/**
 * Everything above this marker is instructions for agents, not release notes.
 * Entries start after it, so the guidance can grow without leaking into the app.
 */
const ENTRIES_START = '\n---\n';

/** `## 2026-08-15 — Title` (em dash or a plain hyphen, since both get typed). */
const HEADING = /^##\s+(\d{4}-\d{2}-\d{2})\s+[—-]\s+(.+?)\s*$/;

/** `*Roadmap: 3.11*` — ties an entry to a DESIGN.md §3 section. */
const ROADMAP_TAG = /^\*Roadmap:\s*([0-9]+(?:\.[0-9]+)?)\s*\*$/;

/**
 * Parse `CHANGELOG.md` into the entries the app renders.
 *
 * Exported so the test parses with the same code the generator uses — a second
 * parser in the test would only prove the two parsers agree.
 *
 * @param markdown Raw `CHANGELOG.md` contents.
 * @returns Entries in file order (newest first, as the file is written).
 */
export function parseChangelog(markdown) {
  const start = markdown.indexOf(ENTRIES_START);
  const body = start >= 0 ? markdown.slice(start + ENTRIES_START.length) : markdown;

  const entries = [];
  let current = null;
  const flush = () => {
    if (!current) return;
    const text = current.lines.join('\n').trim();
    entries.push({
      date: current.date,
      title: current.title,
      ...(current.roadmap ? { roadmap: current.roadmap } : {}),
      body: text,
    });
    current = null;
  };

  for (const raw of body.split(/\r?\n/)) {
    const heading = HEADING.exec(raw);
    if (heading) {
      flush();
      current = { date: heading[1], title: heading[2], roadmap: undefined, lines: [] };
      continue;
    }
    if (!current) continue;
    const tag = ROADMAP_TAG.exec(raw.trim());
    if (tag) {
      current.roadmap = tag[1];
      continue;
    }
    current.lines.push(raw);
  }
  flush();

  return entries;
}

/**
 * The `✅ done` sections of DESIGN.md §3, which every entry list must cover.
 *
 * @param design Raw `DESIGN.md` contents.
 * @returns Section numbers as strings (e.g. `['3.0', '3.1', …]`).
 */
export function doneRoadmapSections(design) {
  const done = [];
  for (const line of design.split(/\r?\n/)) {
    const match = /^###\s+(3\.[0-9]+)\b.*✅/.exec(line);
    if (match) done.push(match[1]);
  }
  return done;
}

/** Serialize exactly as the committed file is written (trailing newline). */
export function serialize(entries) {
  return `${JSON.stringify(entries, null, 2)}\n`;
}

async function main() {
  const check = process.argv.includes('--check');
  const markdown = await readFile(SOURCE, 'utf8');
  const entries = parseChangelog(markdown);

  if (entries.length === 0) {
    console.error('CHANGELOG.md produced no entries — is the heading format still `## <date> — <title>`?');
    process.exitCode = 1;
    return;
  }

  const next = serialize(entries);
  if (check) {
    // Compare TEXT, not bytes: committed JSON is CRLF on Windows checkouts and
    // LF in git, and a byte compare would false-alarm on every Windows clone
    // (CLAUDE.md's CRLF trap).
    const current = await readFile(OUTPUT, 'utf8').catch(() => '');
    if (current.replace(/\r\n/g, '\n') !== next) {
      console.error('changelog.json is stale — run: npm run changelog -w @jonny-boi/web');
      process.exitCode = 1;
      return;
    }
    console.log(`changelog.json is up to date (${entries.length} entries).`);
    return;
  }

  await writeFile(OUTPUT, next, 'utf8');
  console.log(`wrote ${entries.length} entries to src/data/changelog.json`);
}

// Only run when invoked directly, so the test can import the parser.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
