/**
 * §3.137 — what kind of deck this is, and what it is missing.
 *
 * The load-bearing test is the first one: classifying the bundled decks BY SHAPE
 * must reproduce the family each of them declares in its own archetype tag. The
 * thresholds were read off these decks, so this is what stops them from being
 * one person's taste — if a future deck breaks it, the thresholds are wrong.
 */
import { describe, expect, it } from 'vitest';
import { loadCardPool } from '@jonny-boi/cards';
import { SAMPLE_DECKS } from '../data/decks/index.js';
import {
  ANSWER_ROLES,
  countRoles,
  describeGap,
  detectFamily,
  familyFromTag,
  familyOf,
  findRoleGaps,
  referenceProfile,
  shapeOf,
  MIN_COHORT,
} from './deck-shape.js';

const pool = loadCardPool({ onWarn: () => {} });
const deck = (name: string) => {
  const found = SAMPLE_DECKS.find((d) => d.name === name);
  if (!found) throw new Error(`no bundled deck named "${name}"`);
  return found;
};

describe('familyFromTag — a deck that says what it is is not guessed at', () => {
  it('reads the family off the tag', () => {
    expect(familyFromTag('Aggro (burn)')).toBe('aggro');
    expect(familyFromTag('Midrange (ramp + creatures)')).toBe('midrange');
    expect(familyFromTag('Control (removal + counters)')).toBe('control');
    expect(familyFromTag('Tempo (spell payoffs)')).toBe('tempo');
  });

  it('an unrecognised or empty tag is honestly unknown, not a nearest guess', () => {
    expect(familyFromTag('')).toBe('unknown');
    expect(familyFromTag('Brewed at midnight')).toBe('unknown');
  });
});

describe('detectFamily — shape alone reproduces every bundled deck’s own tag', () => {
  for (const d of SAMPLE_DECKS) {
    it(`${d.name} reads as ${familyFromTag(d.archetype)}`, () => {
      expect(detectFamily(shapeOf(d, pool))).toBe(familyFromTag(d.archetype));
    });
  }

  it('a deck with no spells at all is unknown rather than mislabelled', () => {
    expect(detectFamily({ lands: 60, spells: 0, avgSpellMv: 0, roles: new Map() })).toBe('unknown');
  });
});

describe('the field, measured', () => {
  it('seven of the nine bundled decks run 12–16 answers; two run none', () => {
    // The finding the gap report leans on, pinned so it cannot rot silently.
    const answers = SAMPLE_DECKS.map((d) => countRoles(shapeOf(d, pool), ANSWER_ROLES));
    expect(answers.filter((n) => n === 0)).toHaveLength(2);
    expect(answers.filter((n) => n >= 12 && n <= 16)).toHaveLength(7);
  });
});

describe('referenceProfile — the norm comes from real decks, with its sample size', () => {
  it('a well-populated family uses its own cohort', () => {
    const midrange = referenceProfile('midrange', SAMPLE_DECKS, pool);
    expect(midrange.fellBackToField).toBe(false);
    expect(midrange.sampleSize).toBeGreaterThanOrEqual(MIN_COHORT);
    expect(midrange.family).toBe('midrange');
  });

  it('a thin family falls back to the whole field AND says so', () => {
    // Control is a single deck in this repo — a norm from n=1 is not a norm.
    const control = referenceProfile('control', SAMPLE_DECKS, pool);
    expect(control.fellBackToField).toBe(true);
    expect(control.family, 'it stops claiming to describe control').toBe('unknown');
    expect(control.sampleSize).toBe(SAMPLE_DECKS.length);
  });

  it('a deck is excluded from its OWN reference, so it cannot hide its own gap', () => {
    const withSelf = referenceProfile('midrange', SAMPLE_DECKS, pool);
    const withoutSelf = referenceProfile('midrange', SAMPLE_DECKS, pool, 'Selesnya Blink');
    expect(withoutSelf.sampleSize).toBe(withSelf.sampleSize - 1);
  });
});

describe('findRoleGaps — "this deck has no removal, that seems bad"', () => {
  it('Selesnya Blink is reported as having NO answers, against a field that runs them', () => {
    const blink = deck('Selesnya Blink');
    const shape = shapeOf(blink, pool);
    const reference = referenceProfile(familyOf(blink, shape), SAMPLE_DECKS, pool, blink.name);
    const gaps = findRoleGaps(shape, reference);
    const missingRoles = gaps.filter((g) => g.kind === 'missing').map((g) => g.role);
    expect(countRoles(shape, ANSWER_ROLES), 'it really does run zero answers').toBe(0);
    expect(missingRoles, 'and the report says so').toContain('removal');
  });

  it('the loudest gap comes first, and reads as a sentence', () => {
    const blink = deck('Selesnya Blink');
    const shape = shapeOf(blink, pool);
    const reference = referenceProfile(familyOf(blink, shape), SAMPLE_DECKS, pool, blink.name);
    const gaps = findRoleGaps(shape, reference);
    expect(gaps[0]!.kind).toBe('missing');
    expect(describeGap(gaps[0]!)).toMatch(/^no \w+ cards at all — decks like this run about \d/);
  });

  it('a deck that matches its field has nothing to report', () => {
    // Compared against itself alone, every role sits exactly on the median.
    const golgari = deck('Golgari Midrange');
    const shape = shapeOf(golgari, pool);
    const selfReference = referenceProfile('midrange', [golgari, golgari, golgari], pool);
    expect(findRoleGaps(shape, selfReference)).toEqual([]);
  });

  it('lands are never reported — a mana base is its own question', () => {
    const blink = deck('Selesnya Blink');
    const shape = shapeOf(blink, pool);
    const reference = referenceProfile('midrange', SAMPLE_DECKS, pool, blink.name);
    expect(findRoleGaps(shape, reference).some((g) => g.role === 'land')).toBe(false);
  });
});
