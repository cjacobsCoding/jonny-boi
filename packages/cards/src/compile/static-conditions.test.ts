/**
 * §3.169 — "AS LONG AS …" ON A STATIC LINE, at the compiler.
 *
 * One pre-pass strips the printed condition, the ordinary static rules compile
 * the body, and the condition is attached to what came back. Pinned here, on
 * REAL printed texts (corpus 2026-09-19):
 *  - the tail form ("~ gets +7/+7 as long as …") and the prefix form ("As long
 *    as ~ is equipped, it gets +1/+1 and has flying"), on self-statics and on
 *    group statics alike;
 *  - every member of the closed condition table, from the words that print it;
 *  - the refusals: a body outside the static rules (Static Orb), an Aura whose
 *    "it" is the HOST (attachment modifications are never gated), a condition
 *    outside the table — each leaves the WHOLE line reporting, never a static
 *    that is silently always on.
 */
import { describe, expect, it } from 'vitest';
import { compileCard } from './compile.js';
import { staticConditionOf, stripStaticCondition } from './rules.js';
import type { CompilableCard } from './types.js';

function creature(name: string, oracleText: string, subtypes: string[] = []): CompilableCard {
  return {
    id: `test:${name}`,
    name,
    oracleText,
    manaCost: { generic: 2, W: 0, U: 0, B: 0, R: 0, G: 1, C: 0, other: [] },
    typeLine: { supertypes: [], types: ['Creature'], subtypes },
    power: 2,
    toughness: 2,
    keywords: [],
  } as CompilableCard;
}

const why = (c: CompilableCard): string =>
  compileCard(c)
    .missing.map((m) => `${m.text} -> ${m.missingEngineSystem}`)
    .join(' ; ');

describe('the tail form — "<body> as long as <condition>"', () => {
  it('Krosan Beast: threshold, a self pump', () => {
    const beast = creature(
      'Krosan Beast',
      'Threshold — Krosan Beast gets +7/+7 as long as seven or more cards are in your graveyard.',
      ['Beast'],
    );
    const result = compileCard(beast);
    expect(result.status, why(beast)).toBe('complete');
    expect(result.definition.statics).toEqual([
      expect.objectContaining({
        affects: { onlySource: true },
        power: 7,
        toughness: 7,
        activeWhile: { kind: 'countAtLeast', count: { countOf: 'cardsInYourGraveyard' }, min: 7 },
      }),
    ]);
  });

  it("Grim Flayer: delirium reads YOUR graveyard, a different count from Tarmogoyf's", () => {
    const flayer = creature(
      'Grim Flayer',
      'Trample\nDelirium — Grim Flayer gets +2/+2 as long as there are four or more card types among cards in your graveyard.',
      ['Human', 'Warrior'],
    );
    const result = compileCard(flayer);
    expect(result.status, why(flayer)).toBe('complete');
    expect(result.definition.statics?.[0]?.activeWhile).toEqual({
      kind: 'countAtLeast',
      count: { countOf: 'cardTypesInYourGraveyard' },
      min: 4,
    });
    expect(result.definition.keywords?.trample).toBe(true);
  });

  it('Kor Scythemaster: attacking; and "another Elf" excludes the source', () => {
    const scythe = creature(
      'Kor Scythemaster',
      "Kor Scythemaster gets +1/+0 as long as it's attacking.",
      ['Kor', 'Soldier'],
    );
    expect(compileCard(scythe).definition.statics?.[0]).toEqual(
      expect.objectContaining({ power: 1, activeWhile: { kind: 'sourceAttacking' } }),
    );
    const friend = creature(
      'Test Friend',
      'Test Friend gets +1/+1 as long as you control another Elf.',
      ['Elf'],
    );
    const result = compileCard(friend);
    expect(result.status, why(friend)).toBe('complete');
    expect(result.definition.statics?.[0]?.activeWhile).toEqual({
      kind: 'countAtLeast',
      count: { countOf: 'permanentsMatching', filter: { anyOfSubtypes: ['Elf'] }, scope: 'you' },
      min: 1,
      excludeSource: true,
    });
  });

  it('Indomitable Archangel: metalcraft on a GROUP static — the same pre-pass, the same table', () => {
    const angel = creature(
      'Indomitable Archangel',
      'Flying\nMetalcraft — Artifacts you control have shroud as long as you control three or more artifacts.',
      ['Angel'],
    );
    const result = compileCard(angel);
    expect(result.status, why(angel)).toBe('complete');
    expect(result.definition.statics?.[0]).toEqual(
      expect.objectContaining({
        affects: { anyOfTypes: ['artifact'], controller: 'you' },
        keywords: { shroud: true },
        activeWhile: {
          kind: 'countAtLeast',
          count: {
            countOf: 'permanentsMatching',
            filter: { anyOfTypes: ['artifact'] },
            scope: 'you',
          },
          min: 3,
        },
      }),
    );
  });
});

describe('the prefix form — "As long as <condition>, <body>"', () => {
  it('Skyhunter Cub: "it" is the source, and the body keeps both halves', () => {
    const cub = creature(
      'Skyhunter Cub',
      'As long as Skyhunter Cub is equipped, it gets +1/+1 and has flying.',
      ['Cat', 'Knight'],
    );
    const result = compileCard(cub);
    expect(result.status, why(cub)).toBe('complete');
    expect(result.definition.statics?.[0]).toEqual(
      expect.objectContaining({
        affects: { onlySource: true },
        power: 1,
        toughness: 1,
        keywords: { flying: true },
        activeWhile: { kind: 'sourceAttached', by: 'Equipment' },
      }),
    );
  });

  it('Gavony Ironwright: fateful hour on OTHER creatures you control', () => {
    const wright = creature(
      'Gavony Ironwright',
      'Fateful hour — As long as you have 5 or less life, other creatures you control get +1/+4.',
      ['Human', 'Soldier'],
    );
    const result = compileCard(wright);
    expect(result.status, why(wright)).toBe('complete');
    expect(result.definition.statics?.[0]).toEqual(
      expect.objectContaining({
        affects: expect.objectContaining({
          anyOfTypes: ['creature'],
          controller: 'you',
          excludeSource: true,
        }),
        power: 1,
        toughness: 4,
        activeWhile: { kind: 'lifeAtMost', max: 5 },
      }),
    );
  });
});

describe('what stays reported, and why', () => {
  it('a body the static rules do not have (Static Orb) — the condition alone compiles nothing', () => {
    const orb: CompilableCard = {
      ...creature(
        'Static Orb',
        "As long as Static Orb is untapped, players can't untap more than two permanents during their untap steps.",
      ),
      typeLine: { supertypes: [], types: ['Artifact'], subtypes: [] },
      power: null,
      toughness: null,
    } as CompilableCard;
    const result = compileCard(orb);
    expect(result.status).toBe('incomplete');
    expect(result.definition.statics ?? []).toHaveLength(0);
  });

  it("an Aura's condition is about the HOST — an attachment modification is never gated", () => {
    const aura: CompilableCard = {
      ...creature(
        'Test Aura',
        "Enchant creature\nEnchanted creature gets +2/+2 as long as it's untapped.",
      ),
      typeLine: { supertypes: [], types: ['Enchantment'], subtypes: ['Aura'] },
      power: null,
      toughness: null,
    } as CompilableCard;
    const result = compileCard(aura);
    expect(result.status).toBe('incomplete');
    // Neither a gated static nor an ungated attachment pump was invented.
    expect(result.definition.statics ?? []).toHaveLength(0);
    expect(result.definition.attachment?.modifies?.power ?? 0).toBe(0);
  });

  it('a condition outside the table leaves the whole line reporting', () => {
    for (const cond of [
      "it's your turn",
      'you control a Gate',
      'an opponent has 10 or less life',
      'seven or more cards are in all graveyards',
    ]) {
      const c = creature('Test Cond', `Test Cond gets +2/+2 as long as ${cond}.`);
      expect(compileCard(c).status, cond).toBe('incomplete');
      expect(staticConditionOf(cond), cond).toBeNull();
    }
  });

  it('stripStaticCondition returns the body and the member, or null', () => {
    expect(
      stripStaticCondition('~ gets +7/+7 as long as seven or more cards are in your graveyard'),
    ).toEqual({
      clause: '~ gets +7/+7',
      condition: { kind: 'countAtLeast', count: { countOf: 'cardsInYourGraveyard' }, min: 7 },
    });
    expect(stripStaticCondition('as long as ~ is equipped, it gets +1/+1 and has flying')).toEqual({
      clause: '~ gets +1/+1 and has flying',
      condition: { kind: 'sourceAttached', by: 'Equipment' },
    });
    expect(stripStaticCondition('~ gets +2/+2')).toBeNull();
    expect(stripStaticCondition("~ gets +2/+2 as long as it's your turn")).toBeNull();
  });
});
