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

/** A slowland: enters tapped unless you control two or more OTHER lands. */
const SLOWLAND: CardDefinition = {
  id: 'slowland',
  name: 'Deserted Beach',
  types: ['land'],
  entersTappedUnless: { minOtherLands: 2 },
  producesOptions: [{ W: 1 }, { U: 1 }],
};

/** A battleland: enters tapped unless you control two or more BASIC lands. */
const BATTLELAND: CardDefinition = {
  id: 'battleland',
  name: 'Prairie Stream',
  types: ['land'],
  entersTappedUnless: { minBasicLands: 2 },
  producesOptions: [{ W: 1 }, { U: 1 }],
};

/** A nonbasic dual printing the same land subtypes two basics would. */
const NONBASIC_DUAL: CardDefinition = {
  id: 'tundra',
  name: 'Hallowed Fountain',
  types: ['land'],
  subtypes: ['plains', 'island'],
  producesOptions: [{ W: 1 }, { U: 1 }],
};

/** A basic Plains — carries the printed Basic supertype. */
const PLAINS: CardDefinition = {
  id: 'plains',
  name: 'Plains',
  types: ['land'],
  basic: true,
  subtypes: ['plains'],
  produces: ['W'],
};

describe('entersTapped — slowland ("two or more other lands")', () => {
  it('enters TAPPED on an empty board — the drawback the printed card leads with', () => {
    expect(entersTapped(SLOWLAND, { controller: 'A', battlefield: [] })).toBe(true);
  });

  it('enters tapped one land short of the printed count', () => {
    expect(entersTapped(SLOWLAND, { controller: 'A', battlefield: board(MOUNTAIN, 1) })).toBe(true);
  });

  it('enters UNTAPPED at exactly the printed count', () => {
    expect(entersTapped(SLOWLAND, { controller: 'A', battlefield: board(MOUNTAIN, 2) })).toBe(false);
  });

  it('does not count itself, so it is not a turn-two untapped land', () => {
    // Two lands in play, one of which IS the slowland: only one is "other", so
    // it enters tapped. Counting itself would make the whole cycle a turn faster.
    const self = { controller: 'A', def: SLOWLAND };
    expect(
      entersTapped(SLOWLAND, { controller: 'A', battlefield: [...board(MOUNTAIN, 1), self], self }),
    ).toBe(true);
  });

  it("ignores the opponent's lands", () => {
    const theirs = [
      { controller: 'B', def: MOUNTAIN },
      { controller: 'B', def: MOUNTAIN },
    ];
    expect(entersTapped(SLOWLAND, { controller: 'A', battlefield: theirs })).toBe(true);
  });

  it('counts only lands, not other permanents', () => {
    expect(entersTapped(SLOWLAND, { controller: 'A', battlefield: board(BEAR, 5) })).toBe(true);
  });
});

describe('entersTapped — battleland ("two or more basic lands")', () => {
  it('enters TAPPED with no basics', () => {
    expect(entersTapped(BATTLELAND, { controller: 'A', battlefield: [] })).toBe(true);
  });

  it('enters UNTAPPED at exactly two basics', () => {
    expect(entersTapped(BATTLELAND, { controller: 'A', battlefield: board(PLAINS, 2) })).toBe(false);
  });

  it('counts BASIC lands only — a nonbasic dual with the same subtypes does not count', () => {
    // The whole reason `CardDefinition.basic` exists. Two Hallowed Fountains
    // print "Plains Island" between them; neither is basic, so a battleland
    // played over them still enters tapped exactly as it really does.
    expect(
      entersTapped(BATTLELAND, { controller: 'A', battlefield: board(NONBASIC_DUAL, 2) }),
    ).toBe(true);
  });

  it("ignores the opponent's basics", () => {
    const theirs = [
      { controller: 'B', def: PLAINS },
      { controller: 'B', def: PLAINS },
    ];
    expect(entersTapped(BATTLELAND, { controller: 'A', battlefield: theirs })).toBe(true);
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
