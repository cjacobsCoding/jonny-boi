/**
 * MODAL TRIGGER COMPILATION — "Whenever …, choose one — • A • B" (CR 603.3c).
 *
 * The engine half (the parked mode question, only the chosen mode resolving)
 * is pinned in core's modal-trigger.test.ts; this half pins the compiler:
 *  - the trigger line and its bullets are folded and read as ONE modal body;
 *  - every mode must itself compile, and V1 accepts only TARGET-FREE modes —
 *    a targeted mode refuses the whole card rather than offering a menu the
 *    stack object cannot aim.
 */

import { describe, expect, it } from 'vitest';
import { compileCard } from './compile/compile.js';
import type { CompilableCard } from './compile/types.js';

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

describe('compiling modal triggers', () => {
  it('compiles Felidar Retreat COMPLETELY — both modes, counters-then-vigilance included', () => {
    const result = compileCard(
      makeCard({
        name: 'Felidar Retreat',
        typeLine: { supertypes: [], types: ['Enchantment'], subtypes: [] },
        manaCost: { generic: 3, W: 1, U: 0, B: 0, R: 0, G: 0, C: 0, other: [] },
        keywords: ['Landfall'],
        oracleText:
          'Landfall — Whenever a land you control enters, choose one —\n' +
          '• Create a 2/2 white Cat Beast creature token.\n' +
          '• Put a +1/+1 counter on each creature you control. Those creatures gain vigilance until end of turn.',
      }),
    );
    expect(result.status, JSON.stringify(result.missing)).toBe('complete');
    const trigger = result.definition.triggers?.[0];
    expect(trigger?.condition.on).toBe('permanentEnters');
    expect(trigger?.effects).toEqual([]);
    const spec = trigger?.modal;
    expect(spec?.min).toBe(1);
    expect(spec?.max).toBe(1);
    expect(spec?.modes.map((mode) => mode.effects[0]?.primitive)).toEqual(['makeToken', 'addCounters']);
    // Mode 2 carries BOTH sentences: the counters and the vigilance grant.
    expect(spec?.modes[1]?.effects.map((ref) => ref.primitive)).toEqual([
      'addCounters',
      'grantKeywordToYoursUntilEndOfTurn',
    ]);
  });

  it('compiles a combat-damage modal trigger with target-free modes', () => {
    const result = compileCard(
      makeCard({
        name: 'Modal Blade',
        typeLine: { supertypes: [], types: ['Creature'], subtypes: ['Human'] },
        power: '2',
        toughness: '2',
        oracleText:
          'Whenever this creature deals combat damage to a player, choose one —\n• Draw a card.\n• You gain 2 life.',
      }),
    );
    expect(result.status, JSON.stringify(result.missing)).toBe('complete');
    expect(result.definition.triggers?.[0]?.modal?.modes).toHaveLength(2);
  });

  it('compiles a CHOOSE-ONE modal trigger with a targeted mode (Glissa/Aether Channeler shape)', () => {
    const result = compileCard(
      makeCard({
        name: 'Aimed Modal',
        typeLine: { supertypes: [], types: ['Creature'], subtypes: ['Human'] },
        power: '2',
        toughness: '2',
        oracleText:
          'Whenever this creature deals combat damage to a player, choose one —\n• Draw a card.\n• Destroy target enchantment.',
      }),
    );
    expect(result.status, JSON.stringify(result.missing)).toBe('complete');
    expect(result.definition.triggers?.[0]?.modal?.modes[1]?.targets).toBe('enchantment');
  });

  it('still REFUSES a targeted mode on a wider-than-one spec (per-pick aims do not exist)', () => {
    const result = compileCard(
      makeCard({
        name: 'Wide Aimed Modal',
        typeLine: { supertypes: [], types: ['Creature'], subtypes: ['Human'] },
        power: '2',
        toughness: '2',
        oracleText:
          'Whenever this creature deals combat damage to a player, choose any number —\n• Draw a card.\n• Destroy target enchantment.',
      }),
    );
    expect(result.status).toBe('incomplete');
  });
});
