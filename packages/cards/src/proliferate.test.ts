/**
 * PROLIFERATE (CR 701.27) — one more counter of EACH kind already there, on
 * any number of chosen permanents.
 *
 * The fidelity edges:
 *  - permanents-ONLY is EXACT in this engine (players have no counter record,
 *    and every poison/energy card reports) — asserted by the primitive's own
 *    doc, pinned here by the menu offering only countered permanents;
 *  - EACH KIND grows: a permanent wearing a +1/+1 and a charge counter gains
 *    one of both, and the kinds are snapshot first so nothing counts itself;
 *  - a counterless permanent is never offered, and a counterless board asks
 *    nothing at all.
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

describe('compiling proliferate', () => {
  it('compiles the bare keyword action and the combat-damage trigger form', () => {
    const bare = compileCard(
      makeCard({
        name: 'Simple Spread',
        typeLine: { supertypes: [], types: ['Instant'], subtypes: [] },
        oracleText: 'Proliferate.',
      }),
    );
    expect(bare.status, JSON.stringify(bare.missing)).toBe('complete');
    expect(bare.definition.effects?.[0]?.primitive).toBe('proliferate');

    const triggered = compileCard(
      makeCard({
        name: 'Spread Blade',
        typeLine: { supertypes: [], types: ['Creature'], subtypes: ['Phyrexian'] },
        power: '2',
        toughness: '2',
        oracleText: 'Whenever this creature deals combat damage to a player, proliferate.',
      }),
    );
    expect(triggered.status, JSON.stringify(triggered.missing)).toBe('complete');
    expect(triggered.definition.triggers?.[0]?.effects[0]?.primitive).toBe('proliferate');
  });
});

describe('the primitive, resolved for real', () => {
  function instance(id: number, counters: Record<string, number>, controller: PlayerId): Record<string, unknown> {
    return {
      instanceId: id,
      controller,
      owner: controller,
      zone: 'battlefield',
      tapped: false,
      summoningSick: false,
      damageMarked: 0,
      markedByDeathtouch: false,
      counters,
      def: { id: `p${id}`, name: `Perm ${id}`, types: ['creature'] } as CardDefinition,
    };
  }

  it('offers only countered permanents; each chosen one grows EVERY kind by one', () => {
    const registry = buildRegistry();
    const primitive = registry.get('proliferate');
    expect(primitive).toBeDefined();
    const mixed = instance(1, { '+1/+1': 2, charge: 1 }, 'A');
    const bare = instance(2, {}, 'A');
    const theirs = instance(3, { '-1/-1': 1 }, 'B');
    const state = {
      nextInstanceId: 100,
      battlefield: [mixed, bare, theirs],
      stack: [],
      continuous: [],
      players: {
        A: { exile: [], hand: [], graveyard: [], library: [], command: [] },
        B: { exile: [], hand: [], graveyard: [], library: [], command: [] },
      },
    } as unknown as GameState;
    let offered: number[] = [];
    primitive!({
      state,
      source: { instanceId: 50, def: { id: 's', name: 'Spread', types: ['instant'] } },
      controller: 'A' as PlayerId,
      targets: [],
      params: {},
      emit: () => {},
      ask: () => undefined,
      chooseCards(request: { candidates: Array<{ instanceId: number }> }) {
        offered = request.candidates.map((c) => c.instanceId);
        return offered; // take everything on offer
      },
    } as never);
    // The counterless permanent was never on the menu.
    expect(offered).toEqual([1, 3]);
    // Each kind grew by exactly one — the added counter did not count itself.
    expect(mixed.counters).toEqual({ '+1/+1': 3, charge: 2 });
    expect(theirs.counters).toEqual({ '-1/-1': 2 });
    expect(bare.counters).toEqual({});
  });

  it('a counterless board asks nothing at all', () => {
    const registry = buildRegistry();
    const primitive = registry.get('proliferate');
    let asked = false;
    primitive!({
      state: {
        nextInstanceId: 100,
        battlefield: [instance(1, {}, 'A')],
        stack: [],
        continuous: [],
        players: {
          A: { exile: [], hand: [], graveyard: [], library: [], command: [] },
          B: { exile: [], hand: [], graveyard: [], library: [], command: [] },
        },
      } as unknown as GameState,
      source: { instanceId: 50, def: { id: 's', name: 'Spread', types: ['instant'] } },
      controller: 'A' as PlayerId,
      targets: [],
      params: {},
      emit: () => {},
      ask: () => undefined,
      chooseCards() {
        asked = true;
        return [];
      },
    } as never);
    expect(asked).toBe(false);
  });
});
