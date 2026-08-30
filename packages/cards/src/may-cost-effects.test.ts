/**
 * "YOU MAY <cost>. IF YOU DO, <payoff>" — the cost-gated option, all-or-nothing
 * (Springbloom Druid, Formidable Speaker).
 *
 * The fidelity edges:
 *  - UNPAYABLE means UNOFFERED: "you may sacrifice a land" with no land is not
 *    an option in paper. A wrapper that asked anyway and ran the payoff after a
 *    no-op cost would be a strictly better card than printed — the exact
 *    inflation the payability gate exists to stop.
 *  - all-or-nothing: a YES pays the cost AND takes the payoff; a NO does
 *    neither ("If you do" = "the may was taken").
 */

import { describe, expect, it } from 'vitest';
import type { CardDefinition, GameState, PlayerId } from '@jonny-boi/core';
import { compileCard } from './compile/compile.js';
import type { CompilableCard } from './compile/types.js';
import { buildRegistry } from './pool.js';

function makeCard(overrides: Partial<CompilableCard> & { name: string }): CompilableCard {
  return {
    id: `test:${overrides.name}`,
    manaCost: { generic: 0, W: 0, U: 0, B: 0, R: 0, G: 0, C: 0, other: [] },
    typeLine: { supertypes: [], types: [], subtypes: [] },
    oracleText: '',
    power: null,
    toughness: null,
    keywords: [],
    ...overrides,
  };
}

describe('compiling the cost-gated option', () => {
  it("compiles Springbloom Druid's ETB completely", () => {
    const result = compileCard(
      makeCard({
        name: 'Springbloom Druid',
        typeLine: { supertypes: [], types: ['Creature'], subtypes: ['Elf', 'Druid'] },
        manaCost: { generic: 2, W: 0, U: 0, B: 0, R: 0, G: 1, C: 0, other: [] },
        power: '1',
        toughness: '1',
        oracleText:
          'When this creature enters, you may sacrifice a land. If you do, search your library for up to two basic land cards, put them onto the battlefield tapped, then shuffle.',
      }),
    );
    expect(result.status, JSON.stringify(result.missing)).toBe('complete');
    const ref = result.definition.triggers?.[0]?.effects[0];
    expect(ref?.primitive).toBe('mayCostEffects');
    const params = ref?.params as { cost?: Array<{ primitive: string }>; effects?: Array<{ primitive: string }> };
    expect(params.cost?.[0]?.primitive).toBe('sacrificeChosen');
    expect(params.effects?.[0]?.primitive).toBe('searchLibrary');
  });

  it('compiles the discard-cost form (Formidable Speaker)', () => {
    const result = compileCard(
      makeCard({
        name: 'Formidable Speaker',
        typeLine: { supertypes: [], types: ['Creature'], subtypes: ['Human'] },
        power: '2',
        toughness: '2',
        oracleText:
          'When this creature enters, you may discard a card. If you do, search your library for a creature card, reveal it, put it into your hand, then shuffle.',
      }),
    );
    expect(result.status, JSON.stringify(result.missing)).toBe('complete');
    const ref = result.definition.triggers?.[0]?.effects[0];
    expect(ref?.primitive).toBe('mayCostEffects');
    const params = ref?.params as { cost?: Array<{ primitive: string; params?: { who?: string } }> };
    expect(params.cost?.[0]).toMatchObject({ primitive: 'discardCard', params: { who: 'controller' } });
  });

  it('still REFUSES a cost outside the closed alternation', () => {
    const result = compileCard(
      makeCard({
        name: 'Odd Cost',
        typeLine: { supertypes: [], types: ['Sorcery'], subtypes: [] },
        oracleText: 'You may exile a card from your graveyard. If you do, draw a card.',
      }),
    );
    expect(result.status).toBe('incomplete');
  });
});

describe('the payability gate, resolved through the real primitive', () => {
  function run(withLand: boolean): { asked: boolean; enqueued: string[] } {
    const registry = buildRegistry();
    const primitive = registry.get('mayCostEffects');
    expect(primitive).toBeDefined();
    const land: Record<string, unknown> = {
      instanceId: 5,
      controller: 'A',
      owner: 'A',
      zone: 'battlefield',
      tapped: false,
      summoningSick: false,
      damageMarked: 0,
      markedByDeathtouch: false,
      counters: {},
      def: { id: 'l', name: 'Forest', types: ['land'] } as CardDefinition,
    };
    const state = {
      nextInstanceId: 100,
      battlefield: withLand ? [land] : [],
      stack: [],
      continuous: [],
      players: {
        A: { exile: [], hand: [], graveyard: [], library: [], command: [] },
        B: { exile: [], hand: [], graveyard: [], library: [], command: [] },
      },
    } as unknown as GameState;
    let asked = false;
    const enqueued: string[] = [];
    primitive!({
      state,
      source: { instanceId: 1, def: { id: 's', name: 'Druid', types: ['creature'] } },
      controller: 'A' as PlayerId,
      targets: [],
      params: {
        cost: [{ primitive: 'sacrificeChosen', params: { who: 'controller', filter: { anyOfTypes: ['land'] } } }],
        effects: [{ primitive: 'drawCards', params: { count: 1 } }],
      },
      emit: () => {},
      ask: () => undefined,
      confirm: () => {
        asked = true;
        return true;
      },
      enqueueEffects: (refs: Array<{ primitive: string }>) => {
        for (const ref of refs) enqueued.push(ref.primitive);
      },
    } as never);
    return { asked, enqueued };
  }

  it('with a land: asks, then runs cost THEN payoff; without: never even asks', () => {
    expect(run(true)).toEqual({ asked: true, enqueued: ['sacrificeChosen', 'drawCards'] });
    expect(run(false)).toEqual({ asked: false, enqueued: [] });
  });
});

describe('the targeted graveyard move (Mortuary Mire family)', () => {
  it('compiles both printed destinations', () => {
    const top = compileCard(
      makeCard({
        name: 'Mire Land',
        typeLine: { supertypes: [], types: ['Land'], subtypes: [] },
        oracleText:
          'When this land enters, you may put target creature card from your graveyard on top of your library.',
      }),
    );
    expect(top.status, JSON.stringify(top.missing)).toBe('complete');
    const trigger = top.definition.triggers?.[0];
    expect(trigger?.targets).toBe('creatureCardInYourGraveyard');
    // "…to your hand" (Raise Dead) stays on `returnFromGraveyard` — the whole
    // pool pins that shape; this rule owns only the top-of-library form.
    const hand = compileCard(
      makeCard({
        name: 'Small Unearth',
        typeLine: { supertypes: [], types: ['Sorcery'], subtypes: [] },
        oracleText: 'Return target creature card from your graveyard to your hand.',
      }),
    );
    expect(hand.definition.effects?.[0]?.primitive).not.toBe('moveTargetFromGraveyard');
  });

  it('the primitive moves the aimed card to the top of the library, and fizzles on a gone card', () => {
    const registry = buildRegistry();
    const primitive = registry.get('moveTargetFromGraveyard');
    const dead: Record<string, unknown> = {
      instanceId: 9,
      controller: 'A',
      owner: 'A',
      zone: 'graveyard',
      tapped: false,
      summoningSick: false,
      damageMarked: 0,
      markedByDeathtouch: false,
      counters: {},
      def: { id: 'd9', name: 'Dead Bear', types: ['creature'] } as CardDefinition,
    };
    const state = {
      nextInstanceId: 100,
      battlefield: [],
      stack: [],
      continuous: [],
      players: {
        A: { exile: [], hand: [], graveyard: [dead], library: [], command: [] },
        B: { exile: [], hand: [], graveyard: [], library: [], command: [] },
      },
    } as unknown as GameState;
    const ctx = {
      state,
      source: { instanceId: 1, def: { id: 's', name: 'Mire', types: ['land'] } },
      controller: 'A' as PlayerId,
      targets: [9],
      params: { targets: 'creatureCardInYourGraveyard', to: 'libraryTop' },
      emit: () => {},
      ask: () => undefined,
    };
    primitive!(ctx as never);
    expect(state.players.A.graveyard).toHaveLength(0);
    expect(state.players.A.library[0]?.instanceId).toBe(9);
    // Aimed at a card no longer there: a clean fizzle, nothing moves twice.
    primitive!(ctx as never);
    expect(state.players.A.library).toHaveLength(1);
  });
});

describe('the reanimate form (to the battlefield)', () => {
  it('compiles both printed wordings to the battlefield destination', () => {
    for (const text of [
      'Return target creature card from your graveyard to the battlefield.',
      'Put target creature card from your graveyard onto the battlefield.',
    ]) {
      const result = compileCard(
        makeCard({ name: 'Test Reanimate', typeLine: { supertypes: [], types: ['Sorcery'], subtypes: [] }, oracleText: text }),
      );
      expect(result.status, JSON.stringify(result.missing)).toBe('complete');
      expect(result.definition.effects?.[0]?.params?.to).toBe('battlefield');
    }
  });
});
