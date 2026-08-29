/**
 * "YOU WIN THE GAME" / "YOU LOSE THE GAME" — the printed alt-win and alt-loss
 * sentences (CR 104.2a/104.3a), as effect refs on core's ONE pair of verbs.
 *
 * The fidelity edges:
 *  - the sentence compiles ONLY as a bare clause: every printed condition in
 *    front of it is a trigger intervening "if" (CR 603.4) checked twice by the
 *    engine, and an unreadable condition must refuse the whole line — "if you
 *    have 40 or more life, you win the game" must never become "you win the
 *    game".
 *  - Revel in Riches is the measured card: BOTH lines compile (the Treasure
 *    dies-trigger from the predefined-token table, the upkeep win through the
 *    controlCount intervening "if" counting the Treasure subtype).
 */

import { describe, expect, it } from 'vitest';
import type { GameState, PlayerId } from '@jonny-boi/core';
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

describe('compiling the printed win/lose sentences', () => {
  it('compiles Revel in Riches COMPLETELY — both lines', () => {
    const result = compileCard(
      makeCard({
        name: 'Revel in Riches',
        typeLine: { supertypes: [], types: ['Enchantment'], subtypes: [] },
        manaCost: { generic: 4, W: 0, U: 0, B: 1, R: 0, G: 0, C: 0, other: [] },
        oracleText:
          'Whenever a creature an opponent controls dies, create a Treasure token. (It\'s an artifact with "{T}, Sacrifice this token: Add one mana of any color.")\n' +
          'At the beginning of your upkeep, if you control ten or more Treasures, you win the game.',
      }),
    );
    expect(result.status, JSON.stringify(result.missing)).toBe('complete');
    const upkeep = result.definition.triggers?.find((t) =>
      t.effects.some((e) => e.primitive === 'winTheGame'),
    );
    expect(upkeep, 'the upkeep win trigger').toBeDefined();
    const intervening = upkeep?.condition.intervening as
      | { kind?: string; min?: number; filter?: { anyOfSubtypes?: string[] } }
      | undefined;
    expect(intervening?.kind).toBe('controlCount');
    expect(intervening?.min).toBe(10);
    expect(intervening?.filter?.anyOfSubtypes).toEqual(['treasure']);
  });

  it('still REFUSES a win behind a condition the engine cannot read', () => {
    const result = compileCard(
      makeCard({
        name: 'Odd Ascension',
        typeLine: { supertypes: [], types: ['Enchantment'], subtypes: [] },
        oracleText: 'At the beginning of your upkeep, if you have 40 or more life, you win the game.',
      }),
    );
    expect(result.status).toBe('incomplete');
    expect(result.definition.triggers ?? []).toHaveLength(0);
  });

  it("compiles Pact of Negation's loss sentence as a bare clause", () => {
    const result = compileCard(
      makeCard({
        name: 'Concession',
        typeLine: { supertypes: [], types: ['Sorcery'], subtypes: [] },
        oracleText: 'You lose the game.',
      }),
    );
    expect(result.status, JSON.stringify(result.missing)).toBe('complete');
    expect(result.definition.effects?.[0]?.primitive).toBe('loseTheGame');
  });
});

describe('the verbs, resolved through the real primitives', () => {
  it('winTheGame marks every OTHER player lost; loseTheGame marks the controller', () => {
    const registry = buildRegistry();
    const run = (primitiveId: string): GameState => {
      const seat = () => ({
        life: 20,
        exile: [],
        hand: [],
        graveyard: [],
        library: [],
        command: [],
        hasLost: false,
      });
      const state = {
        nextInstanceId: 100,
        battlefield: [],
        stack: [],
        continuous: [],
        players: { A: seat(), B: seat() },
      } as unknown as GameState;
      registry.get(primitiveId)!({
        state,
        source: { instanceId: 1, def: { id: 's', name: 'Source', types: ['enchantment'] } },
        controller: 'A' as PlayerId,
        targets: [],
        params: {},
        emit: () => {},
        ask: () => undefined,
      } as never);
      return state;
    };
    const won = run('winTheGame');
    expect(won.players.A.hasLost).toBe(false);
    expect(won.players.B.hasLost).toBe(true);
    const lost = run('loseTheGame');
    expect(lost.players.A.hasLost).toBe(true);
    expect(lost.players.B.hasLost).toBe(false);
  });
});
