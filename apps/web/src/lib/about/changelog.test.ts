/**
 * THE CHANGELOG IS A CLAIM ABOUT THE ROADMAP AND THE POOL, AND CLAIMS ROT.
 *
 * Three things keep it honest, and each is checked here:
 *  1. every entry's section is a real `### 3.N` heading in DESIGN.md marked
 *     ✅ done — nothing is announced before it shipped;
 *  2. every ✅ section from the floor onward HAS an entry — nothing ships
 *     without being announced (the test names the section you forgot);
 *  3. every card an entry names is in the shipped pool, and a `mechanic`
 *     entry's witness still resolves — "Heliod plays now" cannot outlive Heliod.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CHANGELOG_FLOOR_SECTION,
  CHANGELOG_KIND_LABELS,
  CHANGELOG_VISIBLE_ENTRIES,
  MECHANICS_CHANGELOG,
  sectionHeadingPrefix,
  splitChangelog,
  type ChangelogEntry,
} from './changelog.js';
import { resolveWitness } from './mechanics.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..');
const DESIGN = readFileSync(resolve(REPO_ROOT, 'DESIGN.md'), 'utf8').replace(/\r\n/g, '\n');

/** Every `### 3.N …` heading in DESIGN.md, with whether it is marked ✅. */
function roadmapHeadings(): { section: string; number: number; done: boolean; line: string }[] {
  const out: { section: string; number: number; done: boolean; line: string }[] = [];
  for (const line of DESIGN.split('\n')) {
    const match = /^### (3\.(\d+)) /.exec(line);
    if (!match) continue;
    out.push({ section: match[1]!, number: Number(match[2]), done: line.includes('✅'), line });
  }
  return out;
}

describe('every changelog entry reports a shipped roadmap section', () => {
  for (const entry of MECHANICS_CHANGELOG) {
    it(`§${entry.section} "${entry.title}" is a ✅ heading in DESIGN.md`, () => {
      const headings = roadmapHeadings().filter((h) =>
        h.line.startsWith(sectionHeadingPrefix(entry)),
      );
      expect(headings.length, `no "### ${entry.section} " heading in DESIGN.md`).toBeGreaterThan(0);
      expect(
        headings.some((h) => h.done),
        `§${entry.section} is in DESIGN.md but not marked ✅ — a changelog cannot announce it yet`,
      ).toBe(true);
    });
  }
});

describe('every shipped section from the floor onward is announced', () => {
  it('names the section a lane forgot to add a row for', () => {
    const announced = new Set(MECHANICS_CHANGELOG.map((e) => e.section));
    const missing = roadmapHeadings()
      .filter((h) => h.done && h.number >= CHANGELOG_FLOOR_SECTION && !announced.has(h.section))
      .map((h) => h.line);
    expect(
      missing,
      'A ✅ roadmap section has no changelog row. Add one to MECHANICS_CHANGELOG (newest first) — ' +
        'in his words: what he can now do, which cards it brought online.',
    ).toEqual([]);
  });

  it('the floor itself is a real, announced section (a floor above every heading would silence the guard)', () => {
    const floor = roadmapHeadings().filter((h) => h.number === CHANGELOG_FLOOR_SECTION && h.done);
    expect(floor.length).toBeGreaterThan(0);
    expect(MECHANICS_CHANGELOG.some((e) => e.section === `3.${CHANGELOG_FLOOR_SECTION}`)).toBe(
      true,
    );
  });
});

describe('every entry proves what it claims', () => {
  for (const entry of MECHANICS_CHANGELOG) {
    for (const name of entry.cards ?? []) {
      it(`§${entry.section} — "${name}" is in the shipped pool`, () => {
        expect(resolveWitness({ kind: 'card', name })).toBe(true);
      });
    }
    if (entry.witness) {
      it(`§${entry.section} — its ${entry.witness.kind} witness still resolves`, () => {
        expect(resolveWitness(entry.witness!)).toBe(true);
      });
    }
  }

  it('a mechanic entry always carries a witness, and every entry has words for him', () => {
    for (const entry of MECHANICS_CHANGELOG) {
      if (entry.kind === 'mechanic')
        expect(entry.witness, `§${entry.section} is a mechanic with no witness`).toBeDefined();
      expect(entry.title.length).toBeGreaterThan(0);
      expect(entry.summary.length).toBeGreaterThan(40);
      expect(entry.kind in CHANGELOG_KIND_LABELS).toBe(true);
      expect(entry.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});

describe('the list is newest first, one row per section', () => {
  it('dates never go up as you read down, and no section is announced twice', () => {
    const dates = MECHANICS_CHANGELOG.map((e) => e.date);
    for (let i = 1; i < dates.length; i++)
      expect(dates[i]! <= dates[i - 1]!, `${dates[i]} after ${dates[i - 1]}`).toBe(true);
    const sections = MECHANICS_CHANGELOG.map((e) => e.section);
    expect(new Set(sections).size).toBe(sections.length);
  });

  it('splits into what the page shows first and what it folds', () => {
    const many: ChangelogEntry[] = Array.from(
      { length: CHANGELOG_VISIBLE_ENTRIES + 3 },
      (_, i) => ({
        section: `3.${900 + i}`,
        date: '2026-01-01',
        kind: 'app',
        title: `t${i}`,
        summary: 'a summary long enough to count as words for him, which is the test above',
      }),
    );
    const { recent, earlier } = splitChangelog(many);
    expect(recent).toHaveLength(CHANGELOG_VISIBLE_ENTRIES);
    expect(earlier).toHaveLength(3);
    expect(splitChangelog([]).recent).toEqual([]);
  });
});
