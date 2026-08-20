/**
 * COMPILING the four two-halved layouts — split, aftermath, adventurer, Siege —
 * from the shape Scryfall actually hands over.
 *
 * What is worth pinning here is not "does it compile" but the four judgements
 * that would each play a strictly different card if they went the other way:
 *
 *  1. **A split card's own definition is the CR 709.4 COMBINED object**: the
 *     full `A // B` name, the union of both type lines, and a cost that sums
 *     both halves (which is simultaneously the right mana value and the right
 *     colour set). Its halves hang off it, and it is not itself castable.
 *  2. **The layout is READ, never guessed.** A split card and a modal DFC both
 *     print two faces with two costs; only `layout` distinguishes them, and a
 *     record with a combined name but no per-face data reports rather than
 *     being played as its first half.
 *  3. **Two split-layout shapes are NOT split cards and say so**: a ROOM (CR
 *     714) and a FUSE card (CR 702.102), each with its own named gap.
 *  4. **An adventure is spotted by its SUBTYPE**, not by its reminder text -
 *     Scryfall omits the reminder on some printings, and a card whose adventure
 *     half compiled as an ordinary instant would never exile itself.
 */

import { describe, expect, it } from 'vitest';
import {
  compileCard,
  FUSE_GAP,
  ROOM_DOOR_GAP,
  SECOND_CASTABLE_FACE_GAP,
  type CompilableCard,
  type CompilableCardFace,
} from './index.js';

type Cost = CompilableCard['manaCost'];

const NO_COST: Cost = { generic: 0, W: 0, U: 0, B: 0, R: 0, G: 0, C: 0, other: [] };
const cost = (over: Partial<Cost>): Cost => ({ ...NO_COST, ...over });

function face(over: Partial<CompilableCardFace> & { name: string }): CompilableCardFace {
  return {
    manaCost: NO_COST,
    typeLine: { supertypes: [], types: ['Instant'], subtypes: [] },
    oracleText: '',
    power: null,
    toughness: null,
    ...over,
  };
}

function card(over: Partial<CompilableCard> & { id: string; name: string }): CompilableCard {
  return {
    manaCost: NO_COST,
    typeLine: { supertypes: [], types: ['Instant'], subtypes: [] },
    oracleText: '',
    power: null,
    toughness: null,
    keywords: [],
    ...over,
  };
}

/** "Wear // Tear" without the Fuse keyword — a plain two-half split card. */
const PLAIN_SPLIT = card({
  id: 'wear-tear',
  name: 'Wear // Tear',
  layout: 'split',
  typeLine: { supertypes: [], types: ['Instant'], subtypes: [] },
  faces: [
    face({
      name: 'Wear',
      manaCost: cost({ generic: 1, R: 1 }),
      oracleText: 'Destroy target artifact.',
    }),
    face({
      name: 'Tear',
      manaCost: cost({ W: 1 }),
      typeLine: { supertypes: [], types: ['Sorcery'], subtypes: [] },
      // The printed half is "Destroy target enchantment", which is blocked by
      // an unrelated rule-table gap; the claim under test is the SHAPE, so the
      // text is one the rule table already reads and the halves stay distinct.
      oracleText: 'Draw a card.',
    }),
  ],
});

describe('split cards', () => {
  it('carries the CR 709.4 combined characteristics, with both halves attached', () => {
    const result = compileCard(PLAIN_SPLIT);
    expect(result.status).toBe('complete');
    const def = result.definition;
    expect(def.name).toBe('Wear // Tear');
    // The union of the type lines — an instant half and a sorcery half.
    expect([...def.types].sort()).toEqual(['instant', 'sorcery']);
    // The SUM of the two costs: {1}{R} + {W} = {1}{R}{W}, mana value 3.
    expect(def.cost).toEqual({ generic: 1, R: 1, W: 1 });
    expect(def.frontFace?.name).toBe('Wear');
    expect(def.frontFace?.cost).toEqual({ generic: 1, R: 1 });
    expect(def.backFace?.name).toBe('Tear');
    expect(def.backFace?.cost).toEqual({ W: 1 });
    expect(def.backFace?.isBackFace).toBe(true);
    expect(def.backFaceCastable).toBe(true);
    // No zone restriction: both halves are cast from hand.
    expect(def.backFaceCastZones).toBeUndefined();
  });

  it('reports FUSE by name rather than playing the left half', () => {
    const fused = {
      ...PLAIN_SPLIT,
      keywords: ['Fuse'],
      faces: (PLAIN_SPLIT.faces ?? []).map((f) => ({
        ...f,
        oracleText: `${f.oracleText}\nFuse (You may cast one or both halves of this card from your hand.)`,
      })),
    };
    const result = compileCard(fused);
    expect(result.status).toBe('incomplete');
    expect(result.missing.map((m) => m.missingEngineSystem)).toContain(FUSE_GAP);
    // …and the word "Fuse" is not additionally reported as an unknown ability:
    // the layout keyword is machinery, and reporting it twice would be noise.
    expect(result.missing.filter((m) => m.missingEngineSystem === FUSE_GAP)).toHaveLength(1);
  });

  it('reports a ROOM as its own system — it shares the layout and nothing else', () => {
    const room = card({
      id: 'walk-in-closet',
      name: 'Walk-In Closet // Forgotten Cellar',
      layout: 'split',
      faces: [
        face({
          name: 'Walk-In Closet',
          manaCost: cost({ generic: 2, G: 1 }),
          typeLine: { supertypes: [], types: ['Enchantment'], subtypes: ['Room'] },
          oracleText: 'You may play lands from your graveyard.',
        }),
        face({
          name: 'Forgotten Cellar',
          manaCost: cost({ generic: 3, G: 2 }),
          typeLine: { supertypes: [], types: ['Enchantment'], subtypes: ['Room'] },
          oracleText: 'You may play lands from your graveyard.',
        }),
      ],
    });
    const result = compileCard(room);
    expect(result.status).toBe('incomplete');
    expect(result.missing.map((m) => m.missingEngineSystem)).toContain(ROOM_DOOR_GAP);
  });

  it('a record with the combined NAME but no per-face data still reports', () => {
    // The residual `SECOND_CASTABLE_FACE_GAP` now names: nothing to compile the
    // halves from, so playing the record as its first half would be a guess.
    const result = compileCard(
      card({ id: 'nameless-split', name: 'Fire // Ice', oracleText: 'Fire deals 2 damage.' }),
    );
    expect(result.status).toBe('incomplete');
    expect(result.missing.map((m) => m.missingEngineSystem)).toContain(SECOND_CASTABLE_FACE_GAP);
  });
});

describe('aftermath', () => {
  const DUSK_DAWN = card({
    id: 'dusk-dawn',
    name: 'Dusk // Dawn',
    layout: 'split',
    keywords: ['Aftermath'],
    typeLine: { supertypes: [], types: ['Sorcery'], subtypes: [] },
    faces: [
      face({
        name: 'Dusk',
        manaCost: cost({ generic: 2, W: 2 }),
        typeLine: { supertypes: [], types: ['Sorcery'], subtypes: [] },
        oracleText: 'Destroy all creatures with power 3 or greater.',
      }),
      face({
        name: 'Dawn',
        manaCost: cost({ generic: 3, W: 2 }),
        typeLine: { supertypes: [], types: ['Sorcery'], subtypes: [] },
        oracleText:
          'Aftermath (Cast this spell only from your graveyard. Then exile it.)\nReturn all creature cards with power 2 or less from your graveyard to your hand.',
      }),
    ],
  });

  it('restricts the second half to the graveyard, and does not report the layout word', () => {
    const result = compileCard(DUSK_DAWN);
    const def = result.definition;
    expect(def.backFaceCastZones).toEqual(['graveyard']);
    expect(def.backFaceCastable).toBe(true);
    // The bare word "Aftermath" left behind once its parenthesised reminder is
    // stripped is layout machinery, not an ability: it must not surface as an
    // unrecognised template, or every aftermath card reports its own layout.
    expect(result.missing.some((m) => /aftermath/i.test(m.text))).toBe(false);
  });
});

describe('adventurer cards', () => {
  const BONECRUSHER = card({
    id: 'bonecrusher',
    name: 'Bonecrusher Giant // Stomp',
    layout: 'adventure',
    keywords: [],
    typeLine: { supertypes: [], types: ['Creature'], subtypes: ['Giant'] },
    power: 4,
    toughness: 3,
    faces: [
      face({
        name: 'Bonecrusher Giant',
        manaCost: cost({ generic: 2, R: 1 }),
        typeLine: { supertypes: [], types: ['Creature'], subtypes: ['Giant'] },
        oracleText: '',
        power: 4,
        toughness: 3,
      }),
      face({
        name: 'Stomp',
        manaCost: cost({ generic: 1, R: 1 }),
        typeLine: { supertypes: [], types: ['Instant'], subtypes: ['Adventure'] },
        oracleText: 'Stomp deals 2 damage to any target.',
      }),
    ],
  });

  it("compiles as the CREATURE, with the adventure as a castable, exiling back half", () => {
    const result = compileCard(BONECRUSHER);
    expect(result.status).toBe('complete');
    const def = result.definition;
    // CR 715.2: an adventurer card in every zone but the stack is just the
    // creature — so unlike a split card, its own definition IS the main half.
    expect(def.name).toBe('Bonecrusher Giant');
    expect(def.types).toEqual(['creature']);
    expect(def.frontFace).toBeUndefined();
    expect(def.cost).toEqual({ generic: 2, R: 1 });
    expect(def.backFaceCastable).toBe(true);
    expect(def.backFace?.name).toBe('Stomp');
    expect(def.backFace?.adventure).toBe(true);
    expect(def.backFace?.cost).toEqual({ generic: 1, R: 1 });
  });

  it('is spotted by the Adventure SUBTYPE, not by the reminder text', () => {
    // Some printings carry no "(Then exile this card…)" reminder at all. A
    // detector keyed on that text would compile those halves as ordinary
    // instants that never exile themselves — a card that quietly loses you the
    // creature every time you cast the adventure.
    const noReminder = {
      ...BONECRUSHER,
      id: 'virtue',
      faces: (BONECRUSHER.faces ?? []).map((f, i) =>
        i === 1 ? { ...f, oracleText: 'Target creature gets -3/-3 until end of turn.' } : f,
      ),
    };
    expect(compileCard(noReminder).definition.backFace?.adventure).toBe(true);
  });
});

describe('Sieges', () => {
  const SIEGE = card({
    id: 'invasion',
    name: 'Invasion of Gobakhan // Lightshield Array',
    layout: 'transform',
    keywords: ['Transform'],
    defense: 3,
    typeLine: { supertypes: [], types: ['Battle'], subtypes: ['Siege'] },
    faces: [
      face({
        name: 'Invasion of Gobakhan',
        manaCost: cost({ generic: 1, W: 1 }),
        typeLine: { supertypes: [], types: ['Battle'], subtypes: ['Siege'] },
        oracleText:
          "(As this Siege enters, choose an opponent to protect it. You and others can attack it. When it's defeated, exile it, then cast it transformed.)",
      }),
      face({
        name: 'Lightshield Array',
        typeLine: { supertypes: [], types: ['Enchantment'], subtypes: [] },
        oracleText: '',
      }),
    ],
  });

  it('carries the reward as a FREE cast from exile, and keeps its printed defense', () => {
    const result = compileCard(SIEGE);
    expect(result.status).toBe('complete');
    const def = result.definition;
    expect(def.types).toEqual(['battle']);
    // The defense lives at the CARD level on Scryfall; without handing it down
    // the battle face compiles as a battle with no number and reports.
    expect(def.defense).toBe(3);
    expect(def.backFaceCastable).toBe(true);
    expect(def.backFaceCastZones).toEqual(['exile']);
    expect(def.backFaceFreeCast).toBe(true);
    expect(def.backFace?.name).toBe('Lightshield Array');
  });

  it('does not swallow an ordinary transforming DFC — the Siege subtype is the test', () => {
    const werewolf = {
      ...SIEGE,
      id: 'werewolf',
      name: 'Village Watch // Village Reavers',
      defense: undefined,
      typeLine: { supertypes: [], types: ['Creature'], subtypes: ['Human', 'Werewolf'] },
      faces: (SIEGE.faces ?? []).map((f, i) => ({
        ...f,
        typeLine: { supertypes: [], types: ['Creature'], subtypes: [i === 0 ? 'Human' : 'Werewolf'] },
        oracleText: '',
        power: 4,
        toughness: 4,
      })),
    };
    const def = compileCard(werewolf).definition;
    expect(def.backFaceCastable).toBeUndefined();
    expect(def.backFace?.isBackFace).toBe(true);
  });
});
