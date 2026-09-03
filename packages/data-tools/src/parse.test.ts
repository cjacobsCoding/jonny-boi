import { describe, expect, it } from 'vitest';
import { parseManaCost, parseStat, parseTypeLine } from './parse.js';

describe('parseManaCost', () => {
  it('splits generic and colored pips: {2}{U}{U}', () => {
    const cost = parseManaCost('{2}{U}{U}');
    expect(cost.generic).toBe(2);
    expect(cost.U).toBe(2);
    expect(cost.W).toBe(0);
    expect(cost.other).toEqual([]);
  });

  it('counts a single colored pip: {R}', () => {
    const cost = parseManaCost('{R}');
    expect(cost.R).toBe(1);
    expect(cost.generic).toBe(0);
  });

  it('handles explicit colorless {C} separately from generic', () => {
    const cost = parseManaCost('{2}{C}');
    expect(cost.generic).toBe(2);
    expect(cost.C).toBe(1);
  });

  it('handles a multicolor cost: {1}{U}{R}', () => {
    const cost = parseManaCost('{1}{U}{R}');
    expect(cost.generic).toBe(1);
    expect(cost.U).toBe(1);
    expect(cost.R).toBe(1);
  });

  it('degrades hybrid symbols gracefully into `other`', () => {
    const cost = parseManaCost('{W/U}{2/R}');
    expect(cost.other).toContain('W/U');
    expect(cost.other).toContain('2/R');
    expect(cost.W).toBe(0);
    expect(cost.U).toBe(0);
  });

  it('degrades Phyrexian and X symbols gracefully', () => {
    const cost = parseManaCost('{X}{W/P}');
    expect(cost.other).toContain('X');
    expect(cost.other).toContain('W/P');
  });

  it('returns an all-zero cost MARKED ABSENT for empty / undefined input (lands, Ancestral Vision)', () => {
    for (const input of ['', undefined, null]) {
      const cost = parseManaCost(input);
      expect(cost).toEqual({ generic: 0, W: 0, U: 0, B: 0, R: 0, G: 0, C: 0, other: [], absent: true });
    }
  });

  it('a printed {0} is NOT absent — it is a cost that can be paid (CR 202.1b keeps the two apart)', () => {
    // §3.106: the same zeros, and the one bit that stops Ornithopter and
    // Profane Tutor being the same card to the engine.
    expect(parseManaCost('{0}')).toEqual({ generic: 0, W: 0, U: 0, B: 0, R: 0, G: 0, C: 0, other: [] });
  });

  it('handles large generic costs like {12}', () => {
    expect(parseManaCost('{12}').generic).toBe(12);
  });
});

describe('parseTypeLine', () => {
  it('splits supertype, type, and subtype: "Legendary Creature — Goblin Wizard"', () => {
    const parsed = parseTypeLine('Legendary Creature — Goblin Wizard');
    expect(parsed.supertypes).toEqual(['Legendary']);
    expect(parsed.types).toEqual(['Creature']);
    expect(parsed.subtypes).toEqual(['Goblin', 'Wizard']);
  });

  it('handles a plain type with no subtype: "Instant"', () => {
    const parsed = parseTypeLine('Instant');
    expect(parsed.supertypes).toEqual([]);
    expect(parsed.types).toEqual(['Instant']);
    expect(parsed.subtypes).toEqual([]);
  });

  it('handles basic lands: "Basic Land — Mountain"', () => {
    const parsed = parseTypeLine('Basic Land — Mountain');
    expect(parsed.supertypes).toEqual(['Basic']);
    expect(parsed.types).toEqual(['Land']);
    expect(parsed.subtypes).toEqual(['Mountain']);
  });

  it('handles multiple types: "Artifact Creature — Golem"', () => {
    const parsed = parseTypeLine('Artifact Creature — Golem');
    expect(parsed.types).toEqual(['Artifact', 'Creature']);
    expect(parsed.subtypes).toEqual(['Golem']);
  });

  it('returns empty parts for empty / undefined input', () => {
    expect(parseTypeLine('')).toEqual({ supertypes: [], types: [], subtypes: [] });
    expect(parseTypeLine(undefined)).toEqual({ supertypes: [], types: [], subtypes: [] });
  });

  // §3.64 — a combined double-faced line is TWO type lines. Every one of the
  // pool's 50 DFCs used to carry a literal "//" here, and the back face's words
  // landed under the front's.
  describe('a combined double-faced line describes the FRONT face', () => {
    it('never yields a literal "//" as a type or a subtype', () => {
      for (const line of ['Sorcery // Land', 'Land // Land', 'Creature — Minotaur Warrior // Land']) {
        const parsed = parseTypeLine(line);
        expect(parsed.types, line).not.toContain('//');
        expect(parsed.subtypes, line).not.toContain('//');
        expect(parsed.supertypes, line).not.toContain('//');
      }
    });

    it('does not file the back face type as a subtype of the front', () => {
      // The one that would fool any rule matching on subtypes: this creature is
      // not a Land, and its back face is not one of its creature types.
      const parsed = parseTypeLine('Creature — Minotaur Warrior // Land');
      expect(parsed.types).toEqual(['Creature']);
      expect(parsed.subtypes).toEqual(['Minotaur', 'Warrior']);
    });

    it('does not give the front face the card type of the back', () => {
      const parsed = parseTypeLine('Sorcery // Land');
      expect(parsed.types).toEqual(['Sorcery']);
    });

    it('keeps the front face whole when both halves are identical', () => {
      // "Assault // Battery" — the naive parse produced ['Sorcery','//','Sorcery'],
      // which looks harmless until something counts a card's types.
      expect(parseTypeLine('Sorcery // Sorcery').types).toEqual(['Sorcery']);
    });

    it('still parses a supertype on the front face of a DFC', () => {
      const parsed = parseTypeLine('Legendary Creature — Human // Legendary Land');
      expect(parsed.supertypes).toEqual(['Legendary']);
      expect(parsed.types).toEqual(['Creature']);
      expect(parsed.subtypes).toEqual(['Human']);
    });
  });
});

describe('parseStat', () => {
  it('parses an integer power/toughness', () => {
    expect(parseStat('3')).toBe(3);
    expect(parseStat('0')).toBe(0);
  });

  it('returns null for variable stats (*, 1+*, X)', () => {
    expect(parseStat('*')).toBeNull();
    expect(parseStat('1+*')).toBeNull();
    expect(parseStat('X')).toBeNull();
  });

  it('returns null for absent stats', () => {
    expect(parseStat(undefined)).toBeNull();
    expect(parseStat(null)).toBeNull();
    expect(parseStat('')).toBeNull();
  });
});
