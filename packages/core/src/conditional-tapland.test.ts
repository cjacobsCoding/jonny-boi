/**
 * Conditional enters-tapped: the "unless" half of the common dual lands.
 *
 * These lands are the backbone of real constructed manabases, and getting the
 * condition wrong is not cosmetic — a land that enters untapped when it should
 * not lets a deck curve out a turn early, which flatters every win rate the lab
 * reports for it. The two cases that matter most are the boundary (exactly the
 * printed count) and self-exclusion (the land must not count itself).
 */

import { describe, expect, it } from 'vitest';
import { entersTapped } from './card.js';
import type { CardDefinition } from './card.js';

/** A basic land, used to populate the board. */
const MOUNTAIN: CardDefinition = {
  id: 'mountain',
  name: 'Mountain',
  types: ['land'],
  subtypes: ['mountain'],
  produces: ['R'],
};

/** A creature, so "other lands" can be shown to count lands only. */
const BEAR: CardDefinition = {
  id: 'bear',
  name: 'Bear',
  types: ['creature'],
  power: 2,
  toughness: 2,
};

/** A fastland: enters tapped unless you control two or fewer OTHER lands. */
const FASTLAND: CardDefinition = {
  id: 'fastland',
  name: 'Inspiring Vantage',
  types: ['land'],
  entersTappedUnless: { maxOtherLands: 2 },
  producesOptions: [{ R: 1 }, { W: 1 }],
};

/** A checkland: enters tapped unless you control a Mountain or a Plains. */
const CHECKLAND: CardDefinition = {
  id: 'checkland',
  name: 'Clifftop Retreat',
  types: ['land'],
  entersTappedUnless: { controlsSubtype: ['mountain', 'plains'] },
  producesOptions: [{ R: 1 }, { W: 1 }],
};

/** Build a board of `count` permanents of `def` controlled by A. */
function board(def: CardDefinition, count: number): Array<{ controller: string; def: CardDefinition }> {
  return Array.from({ length: count }, () => ({ controller: 'A', def }));
}

describe('entersTapped — fastland ("two or fewer other lands")', () => {
  it('enters UNTAPPED on an empty board', () => {
    expect(entersTapped(FASTLAND, { controller: 'A', battlefield: [] })).toBe(false);
  });

  it('enters untapped at exactly the printed count', () => {
    expect(
      entersTapped(FASTLAND, { controller: 'A', battlefield: board(MOUNTAIN, 2) }),
    ).toBe(false);
  });

  it('enters TAPPED one land past the printed count', () => {
    expect(
      entersTapped(FASTLAND, { controller: 'A', battlefield: board(MOUNTAIN, 3) }),
    ).toBe(true);
  });

  it('does not count itself among the other lands', () => {
    // Three lands on the battlefield, but one of them IS the entering land —
    // so only two are "other" and it enters untapped. Without self-exclusion
    // every fastland would enter tapped one land too early.
    const self = { controller: 'A', def: FASTLAND };
    const battlefield = [...board(MOUNTAIN, 2), self];
    expect(entersTapped(FASTLAND, { controller: 'A', battlefield, self })).toBe(false);
  });

  it('counts only lands, not other permanents', () => {
    const battlefield = [...board(MOUNTAIN, 2), ...board(BEAR, 5)];
    expect(entersTapped(FASTLAND, { controller: 'A', battlefield })).toBe(false);
  });

  it("ignores the opponent's lands", () => {
    const battlefield = Array.from({ length: 5 }, () => ({ controller: 'B', def: MOUNTAIN }));
    expect(entersTapped(FASTLAND, { controller: 'A', battlefield })).toBe(false);
  });
});

describe('entersTapped — checkland ("unless you control a Mountain or a Plains")', () => {
  it('enters TAPPED with no matching land', () => {
    expect(entersTapped(CHECKLAND, { controller: 'A', battlefield: [] })).toBe(true);
  });

  it('enters untapped when a matching subtype is on the board', () => {
    expect(
      entersTapped(CHECKLAND, { controller: 'A', battlefield: board(MOUNTAIN, 1) }),
    ).toBe(false);
  });

  it("does not count the opponent's matching land", () => {
    const battlefield = [{ controller: 'B', def: MOUNTAIN }];
    expect(entersTapped(CHECKLAND, { controller: 'A', battlefield })).toBe(true);
  });
});

describe('entersTapped — the unconditional forms still hold', () => {
  it('a plain land enters untapped', () => {
    expect(entersTapped(MOUNTAIN, { controller: 'A', battlefield: [] })).toBe(false);
  });

  it('an always-tapped land enters tapped', () => {
    const guildgate: CardDefinition = { ...MOUNTAIN, id: 'gate', entersTapped: true };
    expect(entersTapped(guildgate, { controller: 'A', battlefield: [] })).toBe(true);
  });

  it('answers TAPPED for a conditional land when no board is supplied', () => {
    // "Enters tapped" is the printed default and the "unless" is the exception,
    // so with nothing to evaluate against, the conservative answer is the rule.
    expect(entersTapped(FASTLAND)).toBe(true);
  });
});
