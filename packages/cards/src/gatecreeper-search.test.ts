/**
 * GATECREEPER VINE — "search your library for a basic land card **or Gate
 * card**" (CR 701.19), the two-branch tutor.
 *
 * Two fidelity edges, and the card was blocked on the first for as long as the
 * rule existed:
 *
 *  1. ORACLE PRINTS NO ARTICLE before the second noun ("or Gate card"). The
 *     rule demanded "or a Gate card", so it matched a wording no card prints
 *     and Gatecreeper Vine reported as an unknown template. Pinned here with
 *     the EXACT printed text.
 *  2. The two branches are a genuine OR: a basic land is not a Gate and a Gate
 *     is not basic, so an intersected filter finds NOTHING. The menu must offer
 *     both kinds — asserted against the real primitive, not the ref shape.
 */

import { describe, expect, it } from 'vitest';
import type { CardDefinition, CardInstance, GameState, PlayerId } from '@jonny-boi/core';
import { compileCard } from './compile/compile.js';
import type { CompilableCard } from './compile/types.js';
import { buildRegistry } from './pool.js';

const PRINTED_ORACLE =
  'Defender\n' +
  'When this creature enters, you may search your library for a basic land card or Gate card, ' +
  'reveal it, put it into your hand, then shuffle.';

function gatecreeperRecord(): CompilableCard {
  return {
    id: 'gatecreeper-vine',
    name: 'Gatecreeper Vine',
    manaCost: { generic: 1, W: 0, U: 0, B: 0, R: 0, G: 1, C: 0, other: [] },
    typeLine: { supertypes: [], types: ['Creature'], subtypes: ['Plant', 'Wall'] },
    oracleText: PRINTED_ORACLE,
    power: '0',
    toughness: '5',
    keywords: ['Defender'],
  };
}

describe('Gatecreeper Vine compiles from its PRINTED text', () => {
  it('compiles complete — article-free "or Gate card" included', () => {
    const result = compileCard(gatecreeperRecord());
    expect(result.status, JSON.stringify(result.missing)).toBe('complete');
    const may = result.definition.triggers?.[0]?.effects[0];
    expect(may?.primitive).toBe('mayEffects');
    const inner = (may?.params?.effects as Array<{ primitive: string; params?: Record<string, unknown> }>)[0];
    expect(inner?.primitive).toBe('searchLibrary');
    // A true OR, not an intersection that can never find.
    expect(inner?.params?.filter).toEqual({
      anyOf: [{ anyOfTypes: ['land'], basic: true }, { anyOfSubtypes: ['gate'] }],
    });
    expect(result.definition.keywords?.defender).toBe(true);
  });

  it('still compiles the article-ed printing ("or a Gate card")', () => {
    const withArticle = compileCard({
      ...gatecreeperRecord(),
      oracleText: PRINTED_ORACLE.replace('or Gate card', 'or a Gate card'),
    });
    expect(withArticle.status, JSON.stringify(withArticle.missing)).toBe('complete');
  });
});

describe('the search itself offers BOTH branches', () => {
  it('a basic land and a Gate are both on the menu; an unrelated card is not', () => {
    const registry = buildRegistry();
    const primitive = registry.get('searchLibrary');
    expect(primitive).toBeDefined();

    const defs: readonly CardDefinition[] = [
      { id: 'forest', name: 'Forest', types: ['land'], subtypes: ['Forest'], basic: true } as CardDefinition,
      { id: 'gate', name: 'Gateway Plaza', types: ['land'], subtypes: ['Gate'] } as CardDefinition,
      { id: 'bear', name: 'Grizzly Bears', types: ['creature'], power: 2, toughness: 2 } as CardDefinition,
    ];
    const library: CardInstance[] = defs.map(
      (def, i) =>
        ({
          instanceId: 40 + i,
          def,
          controller: 'A',
          owner: 'A',
          zone: 'library',
          tapped: false,
          summoningSick: false,
          damageMarked: 0,
          markedByDeathtouch: false,
          counters: {},
        }) as CardInstance,
    );
    const state = {
      nextInstanceId: 100,
      battlefield: [],
      stack: [],
      continuous: [],
      players: {
        A: { hand: [], library, graveyard: [], exile: [], command: [] },
        B: { hand: [], library: [], graveyard: [], exile: [], command: [] },
      },
    } as unknown as GameState;

    let offered: string[] = [];
    primitive!({
      state,
      source: { instanceId: 1, def: { id: 's', name: 'Gatecreeper Vine', types: ['creature'] } },
      controller: 'A' as PlayerId,
      targets: [],
      params: {
        who: 'controller',
        count: 1,
        filter: { anyOf: [{ anyOfTypes: ['land'], basic: true }, { anyOfSubtypes: ['gate'] }] },
        destination: 'hand',
        reveal: true,
      },
      emit: () => {},
      ask: () => undefined,
      shuffleLibrary: () => {},
      chooseCards(request: { candidates: Array<{ name: string }> }) {
        offered = request.candidates.map((c) => c.name);
        return [];
      },
    } as never);

    expect(offered).toContain('Forest');
    expect(offered).toContain('Gateway Plaza');
    expect(offered).not.toContain('Grizzly Bears');
  });
});
