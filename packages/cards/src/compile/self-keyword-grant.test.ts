/**
 * THE SELF KEYWORD GRANT — "~ gains KEYWORD until end of turn" and "~ gets
 * +X/+Y and gains KEYWORD until end of turn" as the body of an activated or a
 * triggered ability (DESIGN §3.171): Stromgald Crusader, Unyielding Krumar,
 * Stonehorn Chanter, Hopping Automaton, Fledgling Griffin. Measured on the
 * 32,341-card corpus (2026-09-19): 182 cards had nothing else blocking them.
 *
 * Also the HYBRID activation cost the family kept tripping over ("{U/R}:
 * Stream Hopper gains flying") — the cast path's closed component table, read
 * for an activation too — and the two symbols that must stay refused: a
 * Phyrexian one (no life option on an activation yet) and snow.
 *
 * What is pinned, at the compile level:
 *  - the grant carries NO target: the primitive falls back to its source;
 *  - a keyword LIST is one grant object with every flag;
 *  - a keyword the engine does not model, a printed CHOICE of keywords, and
 *    "protection from the color of your choice" all keep the line reported;
 *  - the same row serves a triggered body;
 *  - "{U/R}" compiles to `ManaCost.hybrid`, "{R/P}" and "{S}" do not compile.
 */

import { describe, expect, it } from 'vitest';
import { compileCard } from './compile.js';
import type { CompilableCard } from './types.js';

function creature(name: string, oracleText: string, subtypes: string[] = ['Human']): CompilableCard {
  return {
    id: `id:${name}`,
    name,
    manaCost: { generic: 1, W: 0, U: 0, B: 1, R: 0, G: 0, C: 0, other: [] },
    typeLine: { supertypes: [], types: ['Creature'], subtypes },
    power: 2,
    toughness: 1,
    keywords: [],
    oracleText,
  } as CompilableCard;
}

const complete = (card: CompilableCard) => {
  const result = compileCard(card);
  expect(result.status, `${card.name} missing: ${JSON.stringify(result.missing)}`).toBe('complete');
  return result.definition;
};

const reported = (card: CompilableCard, line: RegExp) => {
  const result = compileCard(card);
  expect(result.status, `${card.name} compiled whole — it should have reported`).not.toBe('complete');
  expect(result.missing.map((m) => m.text).join('\n')).toMatch(line);
};

describe('§3.171 — "~ gains KEYWORD until end of turn" (activated)', () => {
  it('Stromgald Crusader: "{B}: ~ gains flying" is a target-free grant of the flag', () => {
    const def = complete(
      creature(
        'Stromgald Crusader',
        'Protection from white\n' +
          '{B}: Stromgald Crusader gains flying until end of turn.\n' +
          '{B}{B}: Stromgald Crusader gets +1/+1 until end of turn.',
        ['Human', 'Knight'],
      ),
    );
    expect(def.activated).toHaveLength(2);
    const [gain, pump] = def.activated!;
    expect(gain!.cost.mana).toEqual({ B: 1 });
    expect(gain!.effects).toEqual([
      { primitive: 'grantKeywordUntilEndOfTurn', params: { keywords: { flying: true } } },
    ]);
    expect(pump!.effects).toEqual([
      { primitive: 'pumpUntilEndOfTurn', params: { power: 1, toughness: 1 } },
    ]);
  });

  it('Stonehorn Chanter: a keyword LIST is one grant carrying every flag', () => {
    const def = complete(
      creature(
        'Stonehorn Chanter',
        '{1}{W}: Stonehorn Chanter gains vigilance and lifelink until end of turn.',
        ['Rhino', 'Cleric'],
      ),
    );
    expect(def.activated![0]!.effects).toEqual([
      {
        primitive: 'grantKeywordUntilEndOfTurn',
        params: { keywords: { vigilance: true, lifelink: true } },
      },
    ]);
  });

  it('Keeper of Kookus: a payload keyword ("protection from red") rides the same row', () => {
    const def = complete(
      creature('Keeper of Kookus', '{R}: Keeper of Kookus gains protection from red until end of turn.', [
        'Goblin',
      ]),
    );
    const keywords = def.activated![0]!.effects[0]!.params!.keywords as {
      protectionFrom?: readonly unknown[];
    };
    expect(keywords.protectionFrom).toHaveLength(1);
  });

  it('Hopping Automaton: "gets -1/-1 and gains flying" is the pump and the grant, both target-free', () => {
    const def = complete(
      creature('Hopping Automaton', '{0}: Hopping Automaton gets -1/-1 and gains flying until end of turn.', [
        'Construct',
      ]),
    );
    expect(def.activated![0]!.effects).toEqual([
      { primitive: 'pumpUntilEndOfTurn', params: { power: -1, toughness: -1 } },
      { primitive: 'grantKeywordUntilEndOfTurn', params: { keywords: { flying: true } } },
    ]);
  });

  it('refuses a keyword the engine does not model, a printed CHOICE, and "the color of your choice"', () => {
    reported(
      creature('Marsh Lurker', '{B}: Marsh Lurker gains fear until end of turn.', ['Zombie']),
      /gains fear until end of turn/,
    );
    reported(
      creature(
        'Butcher of the Horde',
        '{1}{W}: Butcher of the Horde gains your choice of vigilance, lifelink, or haste until end of turn.',
        ['Demon'],
      ),
      /your choice of vigilance, lifelink, or haste/,
    );
    reported(
      creature(
        'Jareth, Leonine Titan',
        '{W}: Jareth, Leonine Titan gains protection from the color of your choice until end of turn.',
        ['Cat', 'Giant'],
      ),
      /protection from the color of your choice/,
    );
    // A conjunct that LOSES an ability is not a grant — Canopy Dragon.
    reported(
      creature('Canopy Dragon', '{1}{G}: Canopy Dragon gains flying and loses trample until end of turn.', [
        'Dragon',
      ]),
      /gains flying and loses trample/,
    );
  });
});

describe('§3.171 — the same rows as a TRIGGERED body', () => {
  it("Fledgling Griffin's landfall grants the source flying with no target to choose", () => {
    const def = complete(
      creature(
        'Fledgling Griffin',
        'Landfall — Whenever a land you control enters, Fledgling Griffin gains flying until end of turn.',
        ['Griffin'],
      ),
    );
    expect(def.triggers).toHaveLength(1);
    expect(def.triggers![0]!.effects).toEqual([
      { primitive: 'grantKeywordUntilEndOfTurn', params: { keywords: { flying: true } } },
    ]);
    expect((def.triggers![0] as { targets?: unknown }).targets).toBeUndefined();
  });

  it("Kruin Striker: 'gets +1/+0 and gains trample' inside a trigger", () => {
    const def = complete(
      creature(
        'Kruin Striker',
        'Whenever another creature you control enters, Kruin Striker gets +1/+0 and gains trample until end of turn.',
        ['Human', 'Warrior'],
      ),
    );
    expect(def.triggers![0]!.effects).toEqual([
      { primitive: 'pumpUntilEndOfTurn', params: { power: 1, toughness: 0 } },
      { primitive: 'grantKeywordUntilEndOfTurn', params: { keywords: { trample: true } } },
    ]);
  });
});

describe('§3.171 — hybrid mana in an ACTIVATION cost', () => {
  it('Stream Hopper: "{U/R}:" compiles to a hybrid symbol the payment funnel already searches', () => {
    const def = complete(
      creature('Stream Hopper', '{U/R}: Stream Hopper gains flying until end of turn.', ['Frog']),
    );
    expect(def.activated![0]!.cost.mana).toEqual({ hybrid: [['U', 'R']] });
  });

  it('Rune-Cervin Rider: two hybrid symbols beside a plain one keep both readings', () => {
    const def = complete(
      creature(
        'Rune-Cervin Rider',
        'Flying\n{1}{G/W}{G/W}: Rune-Cervin Rider gets +1/+1 until end of turn.',
        ['Elf', 'Knight'],
      ),
    );
    expect(def.activated![0]!.cost.mana).toEqual({
      generic: 1,
      hybrid: [
        ['G', 'W'],
        ['G', 'W'],
      ],
    });
  });

  it('a Phyrexian symbol and a snow symbol still report — neither is payable as printed on an activation', () => {
    reported(
      creature('Moltensteel Dragon', 'Flying\n{R/P}: Moltensteel Dragon gets +1/+0 until end of turn.', [
        'Dragon',
      ]),
      /\{R\/P\}: ~ gets \+1\/\+0/i,
    );
    reported(
      creature('Chilling Shade', 'Flying\n{S}: Chilling Shade gets +1/+1 until end of turn.', ['Shade']),
      /\{S\}: ~ gets \+1\/\+1/i,
    );
  });
});
