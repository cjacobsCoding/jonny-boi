/**
 * "CHOOSE ONE OR MORE —" + the three single-type destroys (Casualties of War).
 *
 * Two small additions with one card as their meeting point: the modal header
 * whose maximum is the whole menu, and `enchantment` / `land` / `planeswalker`
 * as target restrictions of their own. The cast-time mode/aim pipeline is
 * pinned by `modal-casting.test.ts`; what is asserted here is the part that is
 * new — the announced counts, and that each restriction reaches exactly the
 * permanents its printed word names.
 */

import { describe, expect, it } from 'vitest';
import type { CardDefinition, CardInstance, GameState, PlayerId } from '@jonny-boi/core';
import { legalTargetsFor } from '@jonny-boi/core';
import { compileCard } from './compile/compile.js';
import type { CompilableCard } from './compile/types.js';

function makeCard(overrides: Partial<CompilableCard> & { name: string }): CompilableCard {
  return {
    id: `test:${overrides.name}`,
    manaCost: { generic: 2, W: 0, U: 0, B: 2, R: 0, G: 2, C: 0, other: [] },
    typeLine: { supertypes: [], types: ['Sorcery'], subtypes: [] },
    oracleText: '',
    power: null,
    toughness: null,
    keywords: [],
    ...overrides,
  };
}

describe('compiling "Choose one or more —"', () => {
  it('compiles Casualties of War: five modes, min 1, max = the whole menu', () => {
    const result = compileCard(
      makeCard({
        name: 'Casualties of War',
        oracleText:
          'Choose one or more —\n• Destroy target artifact.\n• Destroy target creature.\n• Destroy target enchantment.\n• Destroy target land.\n• Destroy target planeswalker.',
      }),
    );
    expect(result.status, JSON.stringify(result.missing)).toBe('complete');
    expect(result.definition.modal?.modes).toHaveLength(5);
    expect(result.definition.modal?.min).toBe(1);
    // Clamped to the menu, not left at the unbounded ceiling the table carries.
    expect(result.definition.modal?.max).toBe(5);
    // Every aimed mode declares its own restriction — the pipeline aims each.
    expect(result.definition.modal?.modes.map((m) => m.targets)).toEqual([
      'artifact',
      'creature',
      'enchantment',
      'land',
      'planeswalker',
    ]);
  });
});

describe('the three new permanent restrictions', () => {
  let nextId = 98_000;
  function permanent(types: readonly CardDefinition['types'][number][], controller: PlayerId): CardInstance {
    const instanceId = nextId++;
    return {
      instanceId,
      def: { id: `p${instanceId}`, name: `P${instanceId}`, types: [...types] },
      controller,
      owner: controller,
      zone: 'battlefield',
      tapped: false,
      summoningSick: false,
      damageMarked: 0,
      markedByDeathtouch: false,
      counters: {},
    };
  }

  function board(): { state: GameState; byKind: Record<string, number> } {
    const enchantment = permanent(['enchantment'], 'B');
    const land = permanent(['land'], 'B');
    const walker = permanent(['planeswalker'], 'B');
    const creature = permanent(['creature'], 'B');
    const state = {
      nextInstanceId: nextId,
      battlefield: [enchantment, land, walker, creature],
      stack: [],
      continuous: [],
      players: {
        A: { exile: [], hand: [], graveyard: [], library: [], command: [] },
        B: { exile: [], hand: [], graveyard: [], library: [], command: [] },
      },
    } as unknown as GameState;
    return {
      state,
      byKind: {
        enchantment: enchantment.instanceId,
        land: land.instanceId,
        planeswalker: walker.instanceId,
        creature: creature.instanceId,
      },
    };
  }

  it.each(['enchantment', 'land', 'planeswalker'] as const)(
    '"target %s" reaches exactly the %s and nothing else',
    (kind) => {
      const { state, byKind } = board();
      expect(legalTargetsFor(state, kind, 'A')).toEqual([byKind[kind]]);
    },
  );
});
