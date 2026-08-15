/**
 * Activated-ability compilation: the `COST: EFFECT` line.
 *
 * The headline case is the fetchland, which is why this exists — three of them
 * in a real Modern Burn list were 11 copies the engine could not play, and
 * fetchlands are in a large share of constructed decks.
 *
 * The cost half is the part that must never be approximated: an ability that
 * quietly loses its "Pay 1 life, Sacrifice ~" plays strictly better than the
 * printed card, which is exactly the corruption the compiler exists to prevent.
 */

import { describe, expect, it } from 'vitest';
import { compileCard } from './compile.js';
import type { CompilableCard } from './types.js';

/** A Scryfall-shaped record for the compiler. */
function card(overrides: Partial<CompilableCard> & { name: string; oracleText: string }): CompilableCard {
  return {
    id: `id:${overrides.name}`,
    manaCost: { generic: 0, W: 0, U: 0, B: 0, R: 0, G: 0, C: 0, other: [] },
    typeLine: { supertypes: [], types: ['Land'], subtypes: [] },
    power: null,
    toughness: null,
    keywords: [],
    ...overrides,
  } as CompilableCard;
}

/** Arid Mesa, as printed. */
const ARID_MESA = card({
  name: 'Arid Mesa',
  oracleText:
    '{T}, Pay 1 life, Sacrifice Arid Mesa: Search your library for a Mountain or Plains card, put it onto the battlefield, then shuffle.',
});

describe('activated abilities — the fetchland', () => {
  it('compiles Arid Mesa completely', () => {
    const result = compileCard(ARID_MESA);
    expect(result.status, `missing: ${JSON.stringify(result.missing)}`).toBe('complete');
    expect(result.definition.activated).toHaveLength(1);
  });

  it('keeps every component of the printed cost', () => {
    const [ability] = compileCard(ARID_MESA).definition.activated!;
    expect(ability!.cost.tap).toBe(true);
    expect(ability!.cost.life).toBe(1);
    expect(ability!.cost.sacrificeSelf).toBe(true);
  });

  it('searches by LAND SUBTYPE, so it finds a dual land and not only a basic', () => {
    const [ability] = compileCard(ARID_MESA).definition.activated!;
    const search = ability!.effects.find((ref) => ref.primitive === 'searchLibrary');
    expect(search).toBeDefined();
    const filter = search!.params!.filter as { anyOfSubtypes?: string[] };
    expect(filter.anyOfSubtypes).toEqual(['mountain', 'plains']);
    expect(search!.params!.destination).toBe('battlefield');
    // Arid Mesa's land arrives UNTAPPED — only the printed "tapped" variants do.
    expect(search!.params!.tapped).toBeUndefined();
  });

  it('records the printed subtypes on the definition', () => {
    const shock = compileCard(
      card({
        name: 'Sacred Foundry',
        oracleText: '',
        typeLine: { supertypes: [], types: ['Land'], subtypes: ['Mountain', 'Plains'] },
      }),
    );
    expect(shock.definition.subtypes).toEqual(['mountain', 'plains']);
  });

  it('refuses an ability whose cost it cannot pay faithfully', () => {
    // "Sacrifice a creature" is a cost over OTHER permanents, which the engine
    // has no way to pay — reported rather than silently dropped.
    const result = compileCard(
      card({
        name: 'Test Outlet',
        typeLine: { supertypes: [], types: ['Artifact'], subtypes: [] },
        oracleText: 'Sacrifice a creature: Draw a card.',
      }),
    );
    expect(result.status).toBe('incomplete');
    expect(result.definition.activated ?? []).toHaveLength(0);
  });

  it('does not mistake a planeswalker loyalty ability for an activated one', () => {
    const result = compileCard(
      card({
        name: 'Test Walker',
        typeLine: { supertypes: [], types: ['Planeswalker'], subtypes: [] },
        oracleText: '+1: Draw a card.',
      }),
    );
    expect(result.status).toBe('incomplete');
    expect(result.definition.activated ?? []).toHaveLength(0);
  });
});

describe('conditional enters-tapped — the real dual-land cycles', () => {
  /** A land record with the given printed text. */
  function land(name: string, oracleText: string, subtypes: string[] = []): CompilableCard {
    return card({
      name,
      oracleText,
      typeLine: { supertypes: [], types: ['Land'], subtypes },
    });
  }

  it('compiles a fastland to a board condition, not a flat "enters tapped"', () => {
    const result = compileCard(
      land(
        'Inspiring Vantage',
        'Inspiring Vantage enters the battlefield tapped unless you control two or fewer other lands.\n{T}: Add {R} or {W}.',
      ),
    );
    expect(result.status, `missing: ${JSON.stringify(result.missing)}`).toBe('complete');
    expect(result.definition.entersTappedUnless).toEqual({ maxOtherLands: 2 });
    // Crucially NOT the unconditional flag — that would make it always tapped.
    expect(result.definition.entersTapped).toBeUndefined();
  });

  it('compiles a checkland to its land-subtype condition', () => {
    const result = compileCard(
      land(
        'Clifftop Retreat',
        'Clifftop Retreat enters the battlefield tapped unless you control a Mountain or a Plains.\n{T}: Add {R} or {W}.',
      ),
    );
    expect(result.status, `missing: ${JSON.stringify(result.missing)}`).toBe('complete');
    expect(result.definition.entersTappedUnless).toEqual({
      controlsSubtype: ['mountain', 'plains'],
    });
  });

  it('still reports a SHOCKLAND, whose condition is a price rather than a board state', () => {
    // "You may pay 2 life" asks the controller a question at land-play time,
    // which nothing in the engine can do yet. Guessing either way misprices the
    // card, so it stays honestly unsupported.
    const result = compileCard(
      land(
        'Sacred Foundry',
        'As Sacred Foundry enters the battlefield, you may pay 2 life. If you don\u2019t, it enters the battlefield tapped.\n{T}: Add {R} or {W}.',
        ['Mountain', 'Plains'],
      ),
    );
    expect(result.status).toBe('incomplete');
    expect(result.definition.entersTappedUnless).toBeUndefined();
    expect(result.definition.entersTapped).toBeUndefined();
  });

  it('leaves an unconditional tapland exactly as it was', () => {
    const result = compileCard(
      land('Boros Guildgate', 'Boros Guildgate enters the battlefield tapped.\n{T}: Add {R} or {W}.'),
    );
    expect(result.status).toBe('complete');
    expect(result.definition.entersTapped).toBe(true);
    expect(result.definition.entersTappedUnless).toBeUndefined();
  });
});
