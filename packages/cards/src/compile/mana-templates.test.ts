/**
 * MANA ABILITIES — what the rule table can express, and what it must refuse.
 *
 * Core models a mana source as a fixed list of MODES (`producesOptions`): one tap
 * adds exactly one bundle of colours, off the stack, with no cost beyond the tap,
 * no rider effect, and no condition. Every printed wording that fits that shape is
 * a rule-table entry; every wording that does not is engine work on the mana model
 * itself, and the compiler has to say so by name.
 *
 * That distinction is the point of this file. The census that drove this branch
 * priced the whole mana family as cheap "template" data because the hint text said
 * so — while 83 sole-blocked cards in the most-played corpus actually need core's
 * mana model to grow. A gap named wrongly is worse than a gap named loudly: it
 * sends the next contributor to write data against machinery that is not there.
 */

import { describe, expect, it } from 'vitest';
import type { CardDefinition, GameAction, GameState, InstanceId } from '@jonny-boi/core';
import { applyAction, createGame, DEFAULT_RULES, generateLegalActions } from '@jonny-boi/core';
import { compileCard } from './compile.js';
import type { CompilableCard } from './types.js';
import { buildRegistry } from '../pool.js';
import { CARD_POOL } from '../../data/pool.js';

const DECK_SIZE = 40;
/** Fixed so any failure is reproducible. */
const SEED = 8801;

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

/** Gilded Lotus, as printed. */
const GILDED_LOTUS = makeCard({
  name: 'Gilded Lotus',
  typeLine: { supertypes: [], types: ['Artifact'], subtypes: [] },
  manaCost: { generic: 5, W: 0, U: 0, B: 0, R: 0, G: 0, C: 0, other: [] },
  oracleText: '{T}: Add three mana of any one color.',
});

describe('mana templates — "Add N mana of any one color"', () => {
  it('compiles Gilded Lotus completely, as five modes of THREE', () => {
    const result = compileCard(GILDED_LOTUS);
    expect(result.status, JSON.stringify(result.missing)).toBe('complete');
    // Five modes, not fifteen mana: one tap, one colour, three of it.
    expect(result.definition.producesOptions).toEqual([
      { W: 3 },
      { U: 3 },
      { B: 3 },
      { R: 3 },
      { G: 3 },
    ]);
    expect(result.definition.produces).toBeUndefined();
  });

  it('compiles the single-mana wording the same way', () => {
    const result = compileCard(
      makeCard({
        name: 'Test One Of Any One Color',
        typeLine: { supertypes: [], types: ['Artifact'], subtypes: [] },
        oracleText: '{T}: Add one mana of any one color.',
      }),
    );
    expect(result.status, JSON.stringify(result.missing)).toBe('complete');
    expect(result.definition.producesOptions).toEqual([
      { W: 1 },
      { U: 1 },
      { B: 1 },
      { R: 1 },
      { G: 1 },
    ]);
  });

  it('REFUSES a free per-mana colour choice — the mode list cannot express it', () => {
    // "Add three mana in any combination of colors" lets you mix, which five
    // one-colour modes do not reproduce. Flattening it would be an approximation.
    const result = compileCard(
      makeCard({
        name: 'Test Mixed Colors',
        typeLine: { supertypes: [], types: ['Artifact'], subtypes: [] },
        oracleText: '{T}: Add three mana in any combination of colors.',
      }),
    );
    expect(result.status).toBe('incomplete');
  });
});

describe('mana abilities the ENGINE cannot express are named as engine work', () => {
  /** The phrase the coverage audit reads to file a gap as cheap template data. */
  const CATCH_ALL = /does not recognize yet/;

  function gapsOf(card: CompilableCard): string {
    const result = compileCard(card);
    expect(result.status, `${card.name} unexpectedly compiled`).toBe('incomplete');
    return result.missing.map((m) => m.missingEngineSystem).join(' | ');
  }

  it('a pain land names the RIDER gap, not a template', () => {
    // Shivan Reef. The damage is part of the mana ability's own resolution.
    const gap = gapsOf(
      makeCard({
        name: 'Shivan Reef',
        typeLine: { supertypes: [], types: ['Land'], subtypes: [] },
        oracleText: '{T}: Add {C}.\n{T}: Add {U} or {R}. This land deals 1 damage to you.',
      }),
    );
    expect(gap).toContain('RIDER');
    expect(gap).not.toMatch(CATCH_ALL);
  });

  it('a Verge land names the ACTIVATION RESTRICTION gap, not a template', () => {
    const gap = gapsOf(
      makeCard({
        name: 'Blazemire Verge',
        typeLine: { supertypes: [], types: ['Land'], subtypes: [] },
        oracleText: '{T}: Add {B}.\n{T}: Add {R}. Activate only if you control a Swamp or a Mountain.',
      }),
    );
    expect(gap).toContain('ACTIVATION RESTRICTION');
    expect(gap).not.toMatch(CATCH_ALL);
  });

  it('a pay-life mana land names the ADDITIONAL COST gap, not a template', () => {
    const gap = gapsOf(
      makeCard({
        name: 'Mana Confluence',
        typeLine: { supertypes: [], types: ['Land'], subtypes: [] },
        oracleText: '{T}, Pay 1 life: Add one mana of any color.',
      }),
    );
    expect(gap).toContain('ADDITIONAL COST');
    expect(gap).not.toMatch(CATCH_ALL);
  });

  it('a filter land names the ADDITIONAL COST gap (its cost is mana, not just a tap)', () => {
    const gap = gapsOf(
      makeCard({
        name: 'Rugged Prairie',
        typeLine: { supertypes: [], types: ['Land'], subtypes: [] },
        oracleText: '{T}: Add {C}.\n{R/W}, {T}: Add {R}{R}, {R}{W}, or {W}{W}.',
      }),
    );
    expect(gap).toContain('ADDITIONAL COST');
    expect(gap).not.toMatch(CATCH_ALL);
  });

  it('Cavern of Souls names the SPEND RESTRICTION gap', () => {
    const gap = gapsOf(
      makeCard({
        name: 'Cavern of Souls',
        typeLine: { supertypes: [], types: ['Land'], subtypes: [] },
        oracleText:
          'As this land enters, choose a creature type.\n{T}: Add {C}.\n{T}: Add one mana of any color. Spend this mana only to cast a creature spell of the chosen type.',
      }),
    );
    expect(gap).toContain('SPEND RESTRICTION');
  });

  it('Reflecting Pool names the BOARD-DERIVED COLOURS gap', () => {
    const gap = gapsOf(
      makeCard({
        name: 'Reflecting Pool',
        typeLine: { supertypes: [], types: ['Land'], subtypes: [] },
        oracleText: '{T}: Add one mana of any type that a land you control could produce.',
      }),
    );
    expect(gap).toContain('BOARD STATE');
    expect(gap).not.toMatch(CATCH_ALL);
  });

  it('the wordings the rule table DOES handle still compile — no hint swallowed them', () => {
    // The guard against over-broad hints: a wording the rules handle must never
    // reach a hint at all.
    const handled = ['{T}: Add {U} or {R}.', '{T}: Add one mana of any color.', '{T}: Add {C}.'];
    for (const oracle of handled) {
      const result = compileCard(
        makeCard({
          name: `Test Land ${oracle}`,
          typeLine: { supertypes: [], types: ['Land'], subtypes: [] },
          oracleText: oracle,
        }),
      );
      expect(result.status, `${oracle}: ${JSON.stringify(result.missing)}`).toBe('complete');
    }
  });
});

describe('Gilded Lotus plays as printed', () => {
  const reg = buildRegistry(CARD_POOL);
  const ISLAND = CARD_POOL.find((c) => c.name === 'Island');
  if (!ISLAND) throw new Error('pool missing Island');

  function act(state: GameState, action: GameAction): GameState {
    const result = applyAction(state, action, DEFAULT_RULES, reg);
    const rejected = result.events.find((e) => e.type === 'actionRejected');
    if (rejected) throw new Error(`unexpected rejection: ${(rejected as { reason: string }).reason}`);
    return result.state;
  }

  function put(state: GameState, def: CardDefinition): InstanceId {
    const id = state.nextInstanceId++;
    state.battlefield.push({
      instanceId: id,
      def,
      controller: 'A',
      owner: 'A',
      zone: 'battlefield',
      tapped: false,
      summoningSick: false,
      damageMarked: 0,
      markedByDeathtouch: false,
      counters: {},
    });
    return id;
  }

  it('offers one tap per colour, and a single tap yields THREE of the chosen one', () => {
    const { state } = createGame({
      seed: SEED,
      startingPlayer: 'A',
      registry: reg,
      decks: {
        A: { cards: Array.from({ length: DECK_SIZE }, () => ISLAND) },
        B: { cards: Array.from({ length: DECK_SIZE }, () => ISLAND) },
      },
    });
    let s = state;
    let guard = 0;
    while (s.step !== 'precombatMain' && !s.gameOver && guard++ < 400) {
      s = act(s, { kind: 'passPriority', player: s.priorityPlayer });
    }
    const lotus = put(s, compileCard(GILDED_LOTUS).definition);

    const taps = generateLegalActions(s).filter(
      (a) => a.kind === 'tapForMana' && a.instanceId === lotus,
    );
    expect(taps, 'one offered activation per colour mode').toHaveLength(5);

    // Mode 2 is {B}: three black, and nothing else.
    s = act(s, { kind: 'tapForMana', player: 'A', instanceId: lotus, mode: 2 });
    expect(s.players.A.manaPool).toEqual({ W: 0, U: 0, B: 3, R: 0, G: 0, C: 0 });
    expect(s.battlefield.find((p) => p.instanceId === lotus)?.tapped).toBe(true);
  });
});
