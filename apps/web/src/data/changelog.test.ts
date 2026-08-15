/**
 * THE GUARD THAT KEEPS THE SHIPPED-FEATURE LIST HONEST.
 *
 * The user asked for a list of what has actually shipped that stays correct
 * "regardless of which claude is working on the app". Several agents on several
 * machines work this repo, so a list kept up to date by remembering to do it
 * will not be — and a stale changelog is worse than none, because it is
 * confidently wrong about what the build can do.
 *
 * Two gates, because the two ways this rots are different:
 *
 *  1. COMPLETE — a feature marked `✅ done` in DESIGN.md §3 with no entry
 *     written. This is the common one: flipping the roadmap marker is already
 *     part of the definition of done, so an agent finishing a feature reliably
 *     touches §3 and can forget the changelog. Tying one to the other means the
 *     suite catches it and names the section that was skipped.
 *
 *  2. CONSISTENT — the bundled `changelog.json` drifting from `CHANGELOG.md`.
 *     Same failure mode the card index had: a derived file nobody re-derives.
 *
 * Both messages say exactly how to fix the failure, because whoever trips this
 * is mid-feature and thinking about something else.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  doneRoadmapSections,
  parseChangelog,
  serialize,
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore -- plain-JS build script; typed by use, not by a .d.ts.
} from '../../scripts/build-changelog.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const readRoot = (name: string): string => readFileSync(join(REPO_ROOT, name), 'utf8');

/** How to fix a drift failure — repeated in the message so it is unmissable. */
const REGENERATE_HINT =
  'Run `npm run changelog -w @jonny-boi/web` to regenerate apps/web/src/data/changelog.json. ' +
  'Never hand-edit it: it is derived from CHANGELOG.md.';

interface ChangelogEntry {
  readonly date: string;
  readonly title: string;
  readonly roadmap?: string;
  readonly body: string;
}

const markdown = readRoot('CHANGELOG.md');
const entries = parseChangelog(markdown) as ChangelogEntry[];

describe('CHANGELOG.md parses into real entries', () => {
  it('finds entries at all', () => {
    // A format change that silently matched nothing would empty the app's
    // What's New tab while every other assertion here still passed.
    expect(entries.length, 'CHANGELOG.md produced no entries').toBeGreaterThan(0);
  });

  it('gives every entry a date, a title and a body', () => {
    for (const entry of entries) {
      expect(entry.date, `entry "${entry.title}" has no date`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(entry.title.length, 'an entry has an empty title').toBeGreaterThan(0);
      expect(entry.body.length, `entry "${entry.title}" has an empty body`).toBeGreaterThan(0);
    }
  });

  it('keeps entries newest-first, the order the app renders them in', () => {
    const dates = entries.map((e) => e.date);
    expect(dates, 'CHANGELOG.md entries are out of order').toEqual([...dates].sort().reverse());
  });

  it('does not treat the agent instructions above the --- marker as release notes', () => {
    // The guidance block contains a fenced ENTRY FORMAT example with a heading
    // in it. Parsing that as a release note would ship "<short title...>" to users.
    expect(entries.some((e) => e.title.includes('<'))).toBe(false);
  });
});

describe('every shipped roadmap feature is written up', () => {
  it('has a changelog entry for each ✅ done section of DESIGN.md §3', () => {
    const done = doneRoadmapSections(readRoot('DESIGN.md')) as string[];
    // Guard the guard: if the §3 heading format changes, `done` silently empties
    // and this test passes while checking nothing.
    expect(done.length, 'no ✅ sections found in DESIGN.md §3 — has the heading format changed?')
      .toBeGreaterThan(0);

    const covered = new Set(entries.map((e) => e.roadmap).filter(Boolean));
    const missing = done.filter((section) => !covered.has(section));

    expect(
      missing,
      `DESIGN.md §3 marks ${missing.join(', ')} as ✅ done, but CHANGELOG.md has no entry for ` +
        `${missing.length === 1 ? 'it' : 'them'}. Add one tagged "*Roadmap: <section>*" — ` +
        'writing the entry is part of the definition of done (DESIGN.md §7).',
    ).toEqual([]);
  });

  it('does not tag entries with roadmap sections that do not exist', () => {
    const design = readRoot('DESIGN.md');
    const tagged = entries.map((e) => e.roadmap).filter((r): r is string => Boolean(r));
    for (const section of new Set(tagged)) {
      expect(
        new RegExp(`^###\\s+${section.replace('.', '\\.')}\\b`, 'm').test(design),
        `CHANGELOG.md tags roadmap ${section}, which is not a section in DESIGN.md §3`,
      ).toBe(true);
    }
  });
});

describe('the bundled copy matches CHANGELOG.md', () => {
  it('re-derives byte-for-byte', async () => {
    const committed = readFileSync(
      join(REPO_ROOT, 'apps', 'web', 'src', 'data', 'changelog.json'),
      'utf8',
    );
    // Normalize newlines: committed JSON is CRLF on a Windows checkout and LF in
    // git, so a raw compare false-alarms on every Windows clone (CLAUDE.md).
    expect(committed.replace(/\r\n/g, '\n'), REGENERATE_HINT).toBe(serialize(entries));
  });
});
