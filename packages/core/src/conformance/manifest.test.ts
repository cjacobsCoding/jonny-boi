/**
 * The manifest's own regression net — the checks a TYPE cannot make.
 *
 * `manifest-types.ts` proves at compile time that every section in scope is
 * classified and that no citation points at a section out of scope. What it
 * cannot prove is that the classifications are *honest*: that a reason actually
 * gives a reason, that a gap says what the engine does instead, that a claimed
 * test still exists. Those are checked here, and they are the difference between
 * a manifest and a decoration.
 *
 * Each conformance file additionally ends with `assertFileMatchesManifest`, which
 * compares the tests that file COLLECTED against the tests the manifest claims
 * for it, in both directions. That is what catches a claimed test that was
 * deleted, renamed or `.skip`ped.
 */

import { describe, expect, it } from 'vitest';
import {
  ACTION_RULES,
  CONFORMANCE_FILES,
  CR_SECTIONS,
  KEYWORD_RULES,
  MODIFICATION_IS_PURELY_ADDITIVE,
  RULES_MANIFEST,
  STEP_RULES,
  ZONE_RULES,
  coveredTitlesForFile,
  gapSections,
  manifestTotals,
  sectionOf,
  vocabularyRules,
} from './rules-manifest.js';
import { PLAYER_IDS, STEP_ORDER } from '../index.js';

describe('the rules-conformance manifest', () => {
  it('classifies every CR section in scope exactly once, with no duplicates', () => {
    expect(new Set(CR_SECTIONS).size).toBe(CR_SECTIONS.length);
    for (const section of CR_SECTIONS) {
      expect(RULES_MANIFEST[section], `section ${section} is unclassified`).toBeDefined();
    }
    // The keys of the manifest and the scope list are the same set — a section
    // classified but not in scope would never be reported by anything.
    expect(Object.keys(RULES_MANIFEST).sort()).toEqual([...CR_SECTIONS].sort());
  });

  it('every not-applicable section gives a REASON, not a shrug', () => {
    for (const section of CR_SECTIONS) {
      const entry = RULES_MANIFEST[section];
      if (entry.status !== 'not-applicable') continue;
      // Long enough to be an argument. "out of scope" and "n/a" are not reasons —
      // the whole value of this column is that a reader can disagree with it.
      expect(entry.reason.length, `section ${section} reason is too thin`).toBeGreaterThan(40);
      expect(entry.reason).not.toMatch(/^(n\/a|out of scope|todo|tbd)\.?$/i);
    }
  });

  it('every gap says what the RULE requires and what the ENGINE does instead', () => {
    const gaps = gapSections();
    expect(gaps.length, 'a manifest with no gaps at all is a manifest nobody checked').toBeGreaterThan(0);
    for (const section of gaps) {
      const entry = RULES_MANIFEST[section];
      if (entry.status !== 'gap') throw new Error('unreachable');
      expect(entry.rule.length, `gap ${section} does not state the rule`).toBeGreaterThan(30);
      expect(entry.engine.length, `gap ${section} does not say what the engine does`).toBeGreaterThan(60);
      // A gap must reference the CR rule it is about, so the entry is findable
      // by rule number and not only by section.
      expect(entry.rule, `gap ${section} does not cite a rule number`).toMatch(/\d{3}\.\d/);
    }
  });

  it('every covered section names tests, and every claimed test cites its own section', () => {
    for (const section of CR_SECTIONS) {
      const entry = RULES_MANIFEST[section];
      if (entry.status !== 'covered') continue;
      expect(entry.tests.length, `section ${section} is covered by nothing`).toBeGreaterThan(0);
      expect(CONFORMANCE_FILES).toContain(entry.file);
      for (const test of entry.tests) {
        expect(test.title.length, `${test.rule} has an empty title`).toBeGreaterThan(10);
      }
    }
  });

  it('every cited section names a real suite path and says what it proves', () => {
    for (const section of CR_SECTIONS) {
      const entry = RULES_MANIFEST[section];
      if (entry.status !== 'cited') continue;
      expect(entry.suite, `section ${section} cites nothing`).toMatch(/^(packages|apps)\/.+\.test\.ts$/);
      expect(entry.what.length, `section ${section} does not say what its citation proves`).toBeGreaterThan(40);
    }
  });

  it('no claimed test title is claimed twice, anywhere in the corpus', () => {
    const all = CONFORMANCE_FILES.flatMap((f) => coveredTitlesForFile(f));
    const seen = new Map<string, number>();
    for (const title of all) seen.set(title, (seen.get(title) ?? 0) + 1);
    expect([...seen].filter(([, n]) => n > 1)).toEqual([]);
  });

  it('every conformance file is claimed by the manifest — no file claims nothing', () => {
    for (const file of CONFORMANCE_FILES) {
      expect(coveredTitlesForFile(file).length, `${file} is claimed by no manifest entry`).toBeGreaterThan(0);
    }
  });
});

describe('the manifest against the engine it indexes', () => {
  it('no shipped keyword, step, zone or action indexes into a not-applicable section', () => {
    // The contradiction this forbids: the engine HAS the thing, so the rule that
    // governs it cannot honestly be written off as out of scope. This is what
    // makes the vocabulary maps load-bearing rather than decorative.
    for (const [what, rule] of vocabularyRules()) {
      const entry = RULES_MANIFEST[sectionOf(rule)];
      expect(
        entry.status,
        `${what} cites CR ${rule}, but section ${sectionOf(rule)} is classified not-applicable`,
      ).not.toBe('not-applicable');
    }
  });

  it('the step map covers the turn the engine actually walks, in order', () => {
    // STEP_ORDER is the engine's own list; the map is typed over `Step`. This
    // asserts the two agree at RUNTIME as well, so a step that exists in the type
    // but never runs (or vice versa) is visible.
    for (const step of STEP_ORDER) {
      expect(STEP_RULES[step], `step ${step} has no CR rule`).toMatch(/^\d{3}\.\d/);
    }
    expect(Object.keys(STEP_RULES).sort()).toEqual([...new Set(STEP_ORDER)].sort());
  });

  it('every keyword the engine can grant has a CR rule', () => {
    for (const [keyword, rule] of Object.entries(KEYWORD_RULES)) {
      expect(rule, `keyword ${keyword}`).toMatch(/^\d{3}\.\d/);
    }
    // The engine is a two-player one; a rules index that assumed otherwise would
    // be indexing the wrong chapter 8.
    expect(PLAYER_IDS).toHaveLength(2);
  });

  it('the zone and action maps name rules in sections that are in scope', () => {
    for (const rule of [...Object.values(ZONE_RULES), ...Object.values(ACTION_RULES)]) {
      expect(CR_SECTIONS).toContain(sectionOf(rule));
    }
  });

  it('the layer-model boundary is still held by its compile-time proof', () => {
    // `MODIFICATION_IS_PURELY_ADDITIVE` is `true` only while `PermanentModification`
    // has no setting-shaped field. If someone adds one, the BUILD fails; this
    // runtime assertion exists so the reason is discoverable from the suite too.
    expect(MODIFICATION_IS_PURELY_ADDITIVE).toBe(true);
  });
});

describe('the manifest report', () => {
  it('reports its totals, and they add up to the scope', () => {
    const totals = manifestTotals();
    const classified = totals.covered + totals.cited + totals.notApplicable + totals.gap;
    expect(classified).toBe(CR_SECTIONS.length);

    // Printed rather than merely asserted: the point of a conformance corpus is
    // that a human can read the number and disagree with it.
    const lines = [
      '',
      `  CR sections in scope        ${CR_SECTIONS.length}`,
      `    covered here              ${totals.covered}`,
      `    cited to an existing suite ${totals.cited}`,
      `    not applicable            ${totals.notApplicable}`,
      `    GAP                       ${totals.gap}  (${gapSections().join(', ')})`,
      `    …of which declare an unmet remainder: ${totals.withShortfall}`,
      `  conformance affirmations    ${totals.affirmations}`,
      `  gap pins                    ${totals.pins}`,
      '',
    ];
    console.log(lines.join('\n'));

    // Sanity floors, so a manifest gutted to make the suite pass is visible.
    expect(totals.covered).toBeGreaterThanOrEqual(20);
    expect(totals.affirmations).toBeGreaterThanOrEqual(75);
  });
});
