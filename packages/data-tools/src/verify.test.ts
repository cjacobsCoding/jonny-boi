/**
 * Unit tests for the live-verification DIFF. The comparison itself is pure, so
 * it is tested here offline with hand-built pairs; the network half
 * (`verify-cli.ts`) only supplies data to it.
 */

import { describe, expect, it } from 'vitest';

import { diffCard, formatVerifyReport, scryfallLookupName, verifyCards } from './verify.js';
import type { NormalizedCard } from './types.js';

function card(overrides: Partial<NormalizedCard> = {}): NormalizedCard {
  return {
    id: 'oracle-1',
    name: 'Dismiss',
    manaCost: { generic: 3, W: 0, U: 2, B: 0, R: 0, G: 0, C: 0, other: [] },
    cmc: 5,
    typeLine: { supertypes: [], types: ['Instant'], subtypes: [] },
    rawTypeLine: 'Instant',
    oracleText: 'Counter target spell.\nDraw a card.',
    power: null,
    toughness: null,
    colors: ['U'],
    colorIdentity: ['U'],
    keywords: [],
    set: 'tmp',
    collectorNumber: '58',
    rarity: 'rare',
    imageUris: {},
    localImages: {},
    isDoubleFaced: false,
    faces: [],
    ...overrides,
  };
}

describe('scryfallLookupName', () => {
  it('passes a single-faced name through unchanged', () => {
    expect(scryfallLookupName(card())).toBe('Dismiss');
  });

  it('asks for the front face of a double-faced card (the combined name resolves to nothing)', () => {
    expect(scryfallLookupName(card({ name: 'Delver of Secrets // Insectile Aberration' }))).toBe(
      'Delver of Secrets',
    );
  });
});

describe('diffCard', () => {
  it('reports nothing when the records agree', () => {
    expect(diffCard(card(), card())).toEqual([]);
  });

  it('reports a changed mana cost in printed notation, as an oracle difference', () => {
    const corrupted = card({
      manaCost: { generic: 2, W: 0, U: 2, B: 0, R: 0, G: 0, C: 0, other: [] },
      cmc: 4,
    });
    const diffs = diffCard(corrupted, card());
    expect(diffs.map((diff) => [diff.field, diff.stored, diff.live, diff.kind])).toEqual([
      ['manaCost', '{2}{U}{U}', '{3}{U}{U}', 'oracle'],
      ['cmc', '4', '5', 'oracle'],
    ]);
  });

  it('reports an oracle-text change (an errata the index has not picked up)', () => {
    const stale = card({ oracleText: 'You may counter target spell.' });
    const diffs = diffCard(stale, card());
    expect(diffs).toHaveLength(1);
    expect(diffs[0]!.field).toBe('oracleText');
    expect(diffs[0]!.kind).toBe('oracle');
  });

  it('treats list order as insignificant', () => {
    const reordered = card({ colors: ['U'], keywords: ['Flying', 'Haste'] });
    const other = card({ keywords: ['Haste', 'Flying'] });
    expect(diffCard(reordered, other)).toEqual([]);
  });

  it('classifies a different printing as printing drift, not corruption', () => {
    const diffs = diffCard(card(), card({ set: 'cn2', collectorNumber: '108', rarity: 'uncommon' }));
    expect(diffs.map((diff) => diff.field)).toEqual(['set', 'collectorNumber', 'rarity']);
    expect(diffs.every((diff) => diff.kind === 'printing')).toBe(true);
  });
});

describe('verifyCards', () => {
  it('joins on id, falling back to name', () => {
    const stored = [card(), card({ id: 'oracle-2', name: 'Absorb' })];
    const live = [card({ id: 'renamed-id' }), card({ id: 'oracle-2', name: 'Absorb' })];
    const report = verifyCards(stored, live);
    expect(report.checked).toBe(2);
    expect(report.missing).toEqual([]);
    expect(report.diffs).toEqual([]);
  });

  it('reports stored cards that no longer resolve, and live cards not stored', () => {
    const report = verifyCards([card({ id: 'gone', name: 'Gone' })], [card()]);
    expect(report.missing).toEqual(['Gone']);
    expect(report.extra).toEqual(['Dismiss']);
    expect(report.checked).toBe(0);
  });

  it('formats a report that separates oracle differences from printing drift', () => {
    const report = verifyCards([card({ cmc: 4 })], [card({ set: 'cn2' })]);
    const text = formatVerifyReport(report);
    expect(text).toContain('ORACLE-LEVEL DIFFERENCES (the engine plays these): 1');
    expect(text).toContain('printing drift (expected; refresh to adopt): 1');
  });
});
