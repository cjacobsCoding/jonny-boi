/**
 * MANA ABILITIES — what the compiler and the engine can express, and what they
 * must still refuse.
 *
 * Core used to model a mana source as a fixed list of MODES: one tap adds one
 * bundle of colours, off the stack, with no cost beyond the tap, no rider effect
 * and no condition. The census that drove this work found **83 sole-blocked
 * cards** in the most-played corpus that need more than that, in five named
 * shapes. Four of the five are now real (`CardDefinition.manaAbilities`):
 *
 *   - an ADDITIONAL COST on the ability   ("{T}, Pay 1 life:", the filter lands)
 *   - a RIDER on its resolution           (the pain lands, Ancient Tomb)
 *   - an ACTIVATION RESTRICTION           (the Verge cycle, Nimbus Maze, Mox Opal)
 *   - COLOURS DERIVED FROM THE BOARD      (Reflecting Pool, Exotic Orchard)
 *
 * The fifth — a SPEND RESTRICTION ("spend this mana only to cast…") — is now real
 * too, and it is the one that needed a different kind of work: it colours the
 * MANA rather than the source, so the POOL carries it (core's
 * spend-restriction.ts) and every payment path asks. Cavern of Souls still
 * reports, but for the RIGHT reason now — the creature type it remembers, chosen
 * as it enters, which is a separate system.
 *
 * That distinction is the point of this file. A gap named wrongly is worse than a
 * gap named loudly — it sends the next contributor to write rule-table data
 * against machinery that is not there — so the tests here assert both halves:
 * the shipped shapes compile with their printed data pinned, and the unshipped
 * one still reports the system it needs.
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

describe('the RICH mana abilities compile, with the printed data pinned', () => {
  /** The phrase the coverage audit reads to file a gap as cheap template data. */
  const CATCH_ALL = /does not recognize yet/;

  function compiled(card: CompilableCard) {
    const result = compileCard(card);
    expect(result.status, `${card.name}: ${JSON.stringify(result.missing)}`).toBe('complete');
    return result;
  }

  it('a pain land compiles its RIDER as damage on the coloured ability only', () => {
    // Shivan Reef. The damage belongs to the SECOND ability — tapping for {C} is
    // painless — which is exactly why a rider lives on the ability rather than on
    // the card.
    const result = compiled(
      makeCard({
        name: 'Shivan Reef',
        typeLine: { supertypes: [], types: ['Land'], subtypes: [] },
        oracleText: '{T}: Add {C}.\n{T}: Add {U} or {R}. This land deals 1 damage to you.',
      }),
    );
    expect(result.definition.manaAbilities).toEqual([
      { produces: [{ C: 1 }] },
      { produces: [{ U: 1 }, { R: 1 }], rider: { damageToController: 1 } },
    ]);
    // The shorthands are gone: `manaAbilities` supersedes them, and leaving one
    // behind would give core two lists to disagree about.
    expect(result.definition.produces).toBeUndefined();
    expect(result.definition.producesOptions).toBeUndefined();
  });

  it('a Verge land compiles its ACTIVATION RESTRICTION as the printed subtypes', () => {
    const result = compiled(
      makeCard({
        name: 'Blazemire Verge',
        typeLine: { supertypes: [], types: ['Land'], subtypes: [] },
        oracleText: '{T}: Add {B}.\n{T}: Add {R}. Activate only if you control a Swamp or a Mountain.',
      }),
    );
    expect(result.definition.manaAbilities).toEqual([
      { produces: [{ B: 1 }] },
      { produces: [{ R: 1 }], restriction: { controlsSubtype: ['swamp', 'mountain'] } },
    ]);
  });

  it('an "Activate only if you control a red permanent" restriction compiles as a COLOUR', () => {
    const result = compiled(
      makeCard({
        name: 'Test Color Verge',
        typeLine: { supertypes: [], types: ['Land'], subtypes: [] },
        oracleText: '{T}: Add {R}. Activate only if you control a red permanent.',
      }),
    );
    expect(result.definition.manaAbilities).toEqual([
      { produces: [{ R: 1 }], restriction: { controlsColor: ['R'] } },
    ]);
  });

  it('Mox Opal compiles past its ability-word label, as a counted threshold', () => {
    const result = compiled(
      makeCard({
        name: 'Mox Opal',
        typeLine: { supertypes: ['Legendary'], types: ['Artifact'], subtypes: [] },
        oracleText:
          'Metalcraft — {T}: Add one mana of any color. Activate only if you control three or more artifacts.',
        keywords: ['Metalcraft'],
      }),
    );
    expect(result.definition.manaAbilities).toEqual([
      {
        produces: [{ W: 1 }, { U: 1 }, { B: 1 }, { R: 1 }, { G: 1 }],
        restriction: { controlsTypeAtLeast: { type: 'artifact', count: 3 } },
      },
    ]);
  });

  it('a pay-life mana land compiles its ADDITIONAL COST as life', () => {
    const result = compiled(
      makeCard({
        name: 'Mana Confluence',
        typeLine: { supertypes: [], types: ['Land'], subtypes: [] },
        oracleText: '{T}, Pay 1 life: Add one mana of any color.',
      }),
    );
    expect(result.definition.manaAbilities).toEqual([
      { produces: [{ W: 1 }, { U: 1 }, { B: 1 }, { R: 1 }, { G: 1 }], cost: { life: 1 } },
    ]);
  });

  it('a filter land compiles its HYBRID input as a real mana cost', () => {
    const result = compiled(
      makeCard({
        name: 'Rugged Prairie',
        typeLine: { supertypes: [], types: ['Land'], subtypes: [] },
        oracleText: '{T}: Add {C}.\n{R/W}, {T}: Add {R}{R}, {R}{W}, or {W}{W}.',
      }),
    );
    expect(result.definition.manaAbilities).toEqual([
      { produces: [{ C: 1 }] },
      {
        produces: [{ R: 2 }, { R: 1, W: 1 }, { W: 2 }],
        cost: { mana: { hybrid: [['R', 'W']] } },
      },
    ]);
  });

  it('Reflecting Pool and Exotic Orchard differ by the one printed word', () => {
    const pool = compiled(
      makeCard({
        name: 'Reflecting Pool',
        typeLine: { supertypes: [], types: ['Land'], subtypes: [] },
        oracleText: '{T}: Add one mana of any type that a land you control could produce.',
      }),
    );
    // "any TYPE" reaches colourless.
    expect(pool.definition.manaAbilities).toEqual([
      { derivedColors: 'landsYouControl', derivedIncludesColorless: true },
    ]);

    const orchard = compiled(
      makeCard({
        name: 'Exotic Orchard',
        typeLine: { supertypes: [], types: ['Land'], subtypes: [] },
        oracleText: '{T}: Add one mana of any color that a land an opponent controls could produce.',
      }),
    );
    // "any COLOR", and the other side of the board.
    expect(orchard.definition.manaAbilities).toEqual([{ derivedColors: 'landsOpponentsControl' }]);
  });

  it('none of the shipped shapes is filed as cheap template data', () => {
    // Every wording here compiles, so nothing reaches a hint at all — this
    // asserts the RULES did the work rather than a hint quietly widening.
    const shapes = [
      '{T}: Add {U} or {R}. This land deals 1 damage to you.',
      '{T}, Pay 1 life: Add {W} or {B}.',
      '{T}: Add {W}. Activate only if you control an Island.',
    ];
    for (const oracle of shapes) {
      const result = compileCard(
        makeCard({
          name: `Test Land ${oracle}`,
          typeLine: { supertypes: [], types: ['Land'], subtypes: [] },
          oracleText: oracle,
        }),
      );
      expect(result.status, `${oracle}: ${JSON.stringify(result.missing)}`).toBe('complete');
      expect(result.missing.map((m) => m.missingEngineSystem).join(' ')).not.toMatch(CATCH_ALL);
    }
  });
});

describe('what the mana model still does NOT have is reported by name', () => {
  function gapsOf(card: CompilableCard): string {
    const result = compileCard(card);
    expect(result.status, `${card.name} unexpectedly compiled`).toBe('incomplete');
    return result.missing.map((m) => m.missingEngineSystem).join(' | ');
  }

  it('Cavern of Souls names the CHOSEN TYPE — the pool carries the restriction now', () => {
    // The spend restriction itself is implemented (core's spend-restriction.ts and
    // `spend-restriction.test.ts`). What Cavern still needs is a creature type
    // REMEMBERED on the permanent, chosen as it enters — a different system, and
    // the hint has to say so rather than sending the next contributor to rebuild
    // a pool that already carries restrictions.
    const gap = gapsOf(
      makeCard({
        name: 'Cavern of Souls',
        typeLine: { supertypes: [], types: ['Land'], subtypes: [] },
        oracleText:
          'As this land enters, choose a creature type.\n{T}: Add {C}.\n{T}: Add one mana of any color. Spend this mana only to cast a creature spell of the chosen type.',
      }),
    );
    expect(gap).toContain('CHOSEN AS THE PERMANENT ENTERS');
    expect(gap).not.toContain('a SPEND RESTRICTION on produced mana');
  });

  it('Gwenna names a spend-restriction WORDING gap, not a missing system', () => {
    // "Add two mana in any combination of colors" is a production payload no rule
    // reads yet. The restriction half is fine, so claiming "the pool cannot carry
    // a restriction" here would be a lie about the engine.
    const gap = gapsOf(
      makeCard({
        name: 'Gwenna, Eyes of Gaea',
        typeLine: { supertypes: ['Legendary'], types: ['Creature'], subtypes: ['Elf'] },
        oracleText:
          '{T}: Add two mana in any combination of colors. Spend this mana only to cast creature spells or activate abilities of creature sources.',
      }),
    );
    expect(gap).toContain('restricted mana itself is implemented');
  });

  it('Springleaf Drum names the cost component that is missing, not a vague template', () => {
    // The cost model carries life and mana. "Tap an untapped creature you
    // control" is a third component AND a choice of which creature, so the card
    // reports rather than compiling a cheaper drum.
    const gap = gapsOf(
      makeCard({
        name: 'Springleaf Drum',
        typeLine: { supertypes: [], types: ['Artifact'], subtypes: [] },
        oracleText: '{T}, Tap an untapped creature you control: Add one mana of any color.',
      }),
    );
    expect(gap).toContain('TAPS ANOTHER PERMANENT');
  });

  it('a colour derivation the board cannot answer still reports', () => {
    const gap = gapsOf(
      makeCard({
        name: 'Command Tower',
        typeLine: { supertypes: [], types: ['Land'], subtypes: [] },
        oracleText: "{T}: Add one mana of any color in your commander's color identity.",
      }),
    );
    expect(gap).toContain('commander');
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

describe('a real pain land, compiled from its printed text, plays as printed', () => {
  // The end-to-end claim: the ORACLE TEXT of a card people actually play goes in,
  // and a permanent that really costs a life to use comes out. A compile-only
  // assertion cannot catch a definition that is shaped right and inert.
  const reg = buildRegistry(CARD_POOL);
  const ISLAND = CARD_POOL.find((c) => c.name === 'Island');
  if (!ISLAND) throw new Error('pool missing Island');

  const ADARKAR_WASTES = makeCard({
    name: 'Adarkar Wastes',
    typeLine: { supertypes: [], types: ['Land'], subtypes: [] },
    oracleText: '{T}: Add {C}.\n{T}: Add {W} or {U}. This land deals 1 damage to you.',
  });

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

  it('hurts when tapped for colour, and does not when tapped for colorless', () => {
    const compiledLand = compileCard(ADARKAR_WASTES);
    expect(compiledLand.status, JSON.stringify(compiledLand.missing)).toBe('complete');

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
    const painless = put(s, compiledLand.definition);
    const painful = put(s, compiledLand.definition);
    const startingLife = s.players.A.life;

    // Mode 0 is the colourless ability: no damage.
    s = act(s, { kind: 'tapForMana', player: 'A', instanceId: painless, mode: 0 });
    expect(s.players.A.manaPool.C).toBe(1);
    expect(s.players.A.life).toBe(startingLife);

    // Mode 2 is {U} on the painful ability: one mana, one damage.
    s = act(s, { kind: 'tapForMana', player: 'A', instanceId: painful, mode: 2 });
    expect(s.players.A.manaPool.U).toBe(1);
    expect(s.players.A.life).toBe(startingLife - 1);
    // A mana ability never uses the stack, whatever else it prints (CR 605.3a).
    expect(s.stack).toHaveLength(0);
  });
});
