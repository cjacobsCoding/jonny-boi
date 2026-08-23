/**
 * ALTERNATIVE COSTS at the cards level: the compiler's cycling / typecycling /
 * buyback / madness rules, their refusals (the compiler never approximates), and
 * the mechanics played end-to-end through the REAL engine with this package's
 * primitives.
 *
 * The end-to-end half is the half that matters. A rule that fills in
 * `CardDefinition.cycling` proves nothing on its own — what proves the mechanic
 * is a real cycling land drawing a real card off the real `drawCards` primitive,
 * a real typecycling card finding a real Island, and a discarded madness card
 * being exiled by the CARDS-side discard funnel (`moveOwnedCard`), which is a
 * different funnel from core's own and would silently disagree with it.
 */

import { describe, expect, it } from 'vitest';
import type { CardDefinition, GameAction, GameState } from '@jonny-boi/core';
import { applyAction, createGame, DEFAULT_RULES, generateLegalActions } from '@jonny-boi/core';
import { compileCard, type CompilableCard } from './compile/index.js';
import { buildRegistry } from './pool.js';
import { CARD_POOL } from '../data/pool.js';

// --- the compiler half ----------------------------------------------------------

function cardRecord(
  overrides: Partial<CompilableCard> & Pick<CompilableCard, 'oracleText'>,
): CompilableCard {
  return {
    id: 'test-card',
    name: 'Test Card',
    manaCost: { generic: 1, W: 0, U: 1, B: 0, R: 0, G: 0, C: 0, other: [] },
    typeLine: { supertypes: [], types: ['Instant'], subtypes: [] },
    power: null,
    toughness: null,
    keywords: [],
    ...overrides,
  };
}

describe('compiling cycling', () => {
  it('compiles "Cycling {2}" COMPLETE, as a hand-zone ability that draws', () => {
    const result = compileCard(
      cardRecord({
        name: 'Barren Moor',
        typeLine: { supertypes: [], types: ['Land'], subtypes: [] },
        oracleText:
          'This land enters tapped.\n{T}: Add {B}.\nCycling {B} ({B}, Discard this card: Draw a card.)',
        keywords: ['Cycling'],
      }),
    );
    expect(result.missing).toEqual([]);
    expect(result.status).toBe('complete');
    expect(result.definition.cycling).toEqual([
      {
        cost: { B: 1 },
        effects: [{ primitive: 'drawCards', params: { count: 1 } }],
        label: 'Cycling {B}',
      },
    ]);
    expect(result.matchedRules).toContain('cycling-cost');
  });

  it('compiles TYPECYCLING as the same mechanism with a search instead of a draw', () => {
    const result = compileCard(
      cardRecord({
        name: 'Lorien Revealed',
        typeLine: { supertypes: [], types: ['Sorcery'], subtypes: [] },
        oracleText: 'Draw three cards.\nIslandcycling {1}',
        keywords: ['Typecycling', 'Islandcycling'],
      }),
    );
    expect(result.status).toBe('complete');
    const [ability] = result.definition.cycling ?? [];
    expect(ability?.cost).toEqual({ generic: 1 });
    expect(ability?.effects[0]?.primitive).toBe('searchLibrary');
    expect(ability?.effects[0]?.params).toMatchObject({
      destination: 'hand',
      filter: { anyOfSubtypes: ['island'] },
    });
    // The Scryfall keyword sweep must not report the printed word a second time.
    expect(result.missing).toEqual([]);
  });

  it('compiles LANDCYCLING through the same rule, filtered by card TYPE', () => {
    const result = compileCard(
      cardRecord({
        name: 'Test Landcycler',
        typeLine: { supertypes: [], types: ['Creature'], subtypes: ['Beast'] },
        power: 3,
        toughness: 3,
        oracleText: 'Landcycling {2}',
        keywords: ['Landcycling'],
      }),
    );
    expect(result.status).toBe('complete');
    expect(result.definition.cycling?.[0]?.effects[0]?.params).toMatchObject({
      filter: { anyOfTypes: ['land'] },
    });
  });

  it('refuses an {X} cycling cost — an activation cost has no place to ask for X', () => {
    const result = compileCard(
      cardRecord({
        name: 'Shark Typhoon',
        typeLine: { supertypes: [], types: ['Enchantment'], subtypes: [] },
        oracleText: 'Cycling {X}{1}{U}',
        keywords: ['Cycling'],
      }),
    );
    expect(result.status).toBe('incomplete');
    expect(result.definition.cycling).toBeUndefined();
    expect(result.missing.some((m) => /cycling/i.test(m.text))).toBe(true);
  });

  it('refuses a cycling word it cannot express as a filter, rather than searching for the wrong card', () => {
    const result = compileCard(
      cardRecord({
        name: 'Test Slivercycler',
        typeLine: { supertypes: [], types: ['Creature'], subtypes: ['Sliver'] },
        power: 2,
        toughness: 2,
        oracleText: 'Slivercycling {3}',
        keywords: ['Typecycling'],
      }),
    );
    expect(result.status).toBe('incomplete');
    expect(result.definition.cycling).toBeUndefined();
  });
});

describe('compiling buyback and madness', () => {
  it('compiles "Buyback {3}" COMPLETE on an instant', () => {
    const result = compileCard(
      cardRecord({
        name: 'Test Buyback',
        oracleText:
          'Buyback {3} (You may pay an additional {3} as you cast this spell. If you do, put this card into your hand as it resolves.)\nDraw a card.',
        keywords: ['Buyback'],
      }),
    );
    expect(result.status).toBe('complete');
    expect(result.definition.buyback).toEqual({ generic: 3 });
  });

  it('refuses buyback on a PERMANENT spell — "return it to hand as it resolves" means nothing there', () => {
    const result = compileCard(
      cardRecord({
        name: 'Test Buyback Creature',
        typeLine: { supertypes: [], types: ['Creature'], subtypes: ['Bear'] },
        power: 2,
        toughness: 2,
        oracleText: 'Buyback {3}',
        keywords: ['Buyback'],
      }),
    );
    expect(result.status).toBe('incomplete');
    expect(result.definition.buyback).toBeUndefined();
  });

  it('compiles "Madness {1}{U}" COMPLETE, and refuses the cost printed in WORDS', () => {
    const plain = compileCard(
      cardRecord({
        name: 'Test Madness',
        typeLine: { supertypes: [], types: ['Creature'], subtypes: ['Lizard'] },
        power: 1,
        toughness: 1,
        oracleText: 'Madness {1}{U}',
        keywords: ['Madness'],
      }),
    );
    expect(plain.status).toBe('complete');
    expect(plain.definition.madness).toEqual({ generic: 1, U: 1 });

    const inWords = compileCard(
      cardRecord({
        name: 'Emrakul, the World Anew',
        typeLine: { supertypes: ['Legendary'], types: ['Creature'], subtypes: ['Eldrazi'] },
        power: 9,
        toughness: 9,
        oracleText: 'Madness—Pay six {C}.',
        keywords: ['Madness'],
      }),
    );
    expect(inWords.status).toBe('incomplete');
    expect(inWords.definition.madness).toBeUndefined();
  });
});

// --- the engine half, with this package's real primitives ------------------------

const CYCLING_LAND: CardDefinition = {
  id: 'test-cycling-land',
  name: 'Lonely Sandbar',
  types: ['land'],
  entersTapped: true,
  produces: ['U'],
  cycling: [{ cost: { U: 1 }, effects: [{ primitive: 'drawCards', params: { count: 1 } }], label: 'Cycling {U}' }],
};

const ISLANDCYCLER: CardDefinition = {
  id: 'test-islandcycler',
  name: 'Lorien Revealed',
  types: ['sorcery'],
  cost: { generic: 3, U: 1 },
  cycling: [
    {
      cost: { generic: 1 },
      effects: [
        {
          primitive: 'searchLibrary',
          params: { who: 'controller', count: 1, destination: 'hand', filter: { anyOfSubtypes: ['island'] } },
        },
      ],
      label: 'Islandcycling {1}',
    },
  ],
};

const MADNESS_CREATURE: CardDefinition = {
  id: 'test-madness',
  name: 'Basking Rootwalla',
  types: ['creature'],
  power: 1,
  toughness: 1,
  cost: { generic: 4, G: 1 },
  madness: { generic: 1, G: 1 },
};

/** A spell whose script makes its controller discard — the CARDS-side funnel. */
const SELF_DISCARD: CardDefinition = {
  id: 'test-self-discard',
  name: 'Tormenting Voice',
  types: ['sorcery'],
  cost: { generic: 1 },
  effects: [{ primitive: 'discardCard', params: { who: 'controller' } }],
};

function getByName(name: string): CardDefinition {
  const found = CARD_POOL.find((c) => c.name === name);
  if (!found) throw new Error(`pool missing ${name}`);
  return found;
}

function deck(def: CardDefinition, n = 40): { cards: CardDefinition[] } {
  return { cards: Array.from({ length: n }, () => def) };
}

function act(state: GameState, action: GameAction, reg: ReturnType<typeof buildRegistry>): GameState {
  const result = applyAction(state, action, DEFAULT_RULES, reg);
  const rejected = result.events.find((e) => e.type === 'actionRejected');
  if (rejected) throw new Error(`unexpected rejection: ${(rejected as { reason: string }).reason}`);
  return result.state;
}

function pass(state: GameState, reg: ReturnType<typeof buildRegistry>): GameState {
  return act(state, { kind: 'passPriority', player: state.priorityPlayer }, reg);
}

function gameAtMain(reg: ReturnType<typeof buildRegistry>, deckCard = getByName('Island')): GameState {
  const created = createGame({
    seed: 0xa17c,
    startingPlayer: 'A',
    registry: reg,
    decks: { A: deck(deckCard), B: deck(deckCard) },
  });
  let state = created.state;
  let guard = 0;
  while (state.step !== 'precombatMain' && !state.gameOver && guard++ < 50) state = pass(state, reg);
  state.players.A.hand = [];
  state.players.B.hand = [];
  return state;
}

function place(state: GameState, player: 'A' | 'B', zone: 'hand' | 'graveyard', def: CardDefinition): number {
  const instanceId = state.nextInstanceId++;
  state.players[player][zone].push({
    instanceId,
    def,
    controller: player,
    owner: player,
    zone,
    tapped: false,
    summoningSick: false,
    damageMarked: 0,
    markedByDeathtouch: false,
    attachedTo: null,
    counters: {},
  });
  return instanceId;
}

describe('cycling played through the real engine + primitives', () => {
  it('a cycling land really draws a card and really goes to the graveyard', () => {
    const reg = buildRegistry();
    let state = gameAtMain(reg);
    const sandbar = place(state, 'A', 'hand', CYCLING_LAND);
    state.players.A.manaPool = { W: 0, U: 1, B: 0, R: 0, G: 0, C: 0 };
    const librarySize = state.players.A.library.length;

    const offer = generateLegalActions(state, DEFAULT_RULES).find(
      (a): a is Extract<GameAction, { kind: 'cycleCard' }> => a.kind === 'cycleCard',
    );
    expect(offer, 'the engine should offer the cycling action').toBeDefined();
    state = act(state, offer!, reg);
    state = pass(pass(state, reg), reg); // resolve the cycling ability

    expect(state.players.A.library.length).toBe(librarySize - 1);
    expect(state.players.A.hand).toHaveLength(1);
    expect(state.players.A.hand[0]!.instanceId).not.toBe(sandbar);
    expect(state.players.A.graveyard.map((c) => c.instanceId)).toEqual([sandbar]);
  });

  it('islandcycling finds an Island in the library and puts it in hand', () => {
    const reg = buildRegistry();
    let state = gameAtMain(reg);
    const cycler = place(state, 'A', 'hand', ISLANDCYCLER);
    state.players.A.manaPool = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 1 };

    state = act(state, { kind: 'cycleCard', player: 'A', instanceId: cycler }, reg);
    state = pass(pass(state, reg), reg);

    // The search parks a card choice; the pilot-free path answers it as the
    // engine's single-legal-answer settlement or leaves it pending. Either way
    // the card must not still be in hand, and once any choice is settled an
    // Island must have been found.
    let guard = 0;
    while (state.pendingChoice && guard++ < 5) {
      const choice = state.pendingChoice;
      const answerable = generateLegalActions(state, DEFAULT_RULES).find((a) => a.kind === 'answerChoice');
      expect(answerable, `no way to answer choice ${choice.kind}`).toBeDefined();
      state = act(state, answerable!, reg);
    }
    expect(state.players.A.graveyard.map((c) => c.instanceId)).toEqual([cycler]);
    expect(state.players.A.hand.every((c) => c.def.name === 'Island')).toBe(true);
  });
});

describe('madness through the CARDS-side discard funnel', () => {
  it('a card discarded by an EFFECT is exiled and offered, not buried', () => {
    const reg = buildRegistry();
    let state = gameAtMain(reg);
    const rootwalla = place(state, 'A', 'hand', MADNESS_CREATURE);
    const voice = place(state, 'A', 'hand', SELF_DISCARD);
    state.players.A.manaPool = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 1 };

    state = act(state, { kind: 'castSpell', player: 'A', instanceId: voice }, reg);
    state = pass(pass(state, reg), reg);
    // The discard is a chosen one; with a single card in hand the engine settles
    // it, but answer anything still open so the test does not depend on that.
    let guard = 0;
    while (state.pendingChoice && guard++ < 5) {
      const answerable = generateLegalActions(state, DEFAULT_RULES).find((a) => a.kind === 'answerChoice');
      if (!answerable) break;
      state = act(state, answerable, reg);
    }

    expect(state.players.A.exile.map((c) => c.instanceId)).toEqual([rootwalla]);
    expect(state.players.A.graveyard.some((c) => c.instanceId === rootwalla)).toBe(false);
    expect(state.madnessWindow?.instanceId).toBe(rootwalla);

    // Cast it for the MADNESS cost — {1}{G}, not the printed {4}{G}.
    state.players.A.manaPool = { W: 0, U: 0, B: 0, R: 0, G: 1, C: 1 };
    const offers = generateLegalActions(state, DEFAULT_RULES);
    const madnessCast = offers.find(
      (a): a is Extract<GameAction, { kind: 'castSpell' }> => a.kind === 'castSpell' && a.fromZone === 'exile',
    );
    expect(madnessCast).toBeDefined();
    state = act(state, madnessCast!, reg);
    state = pass(pass(state, reg), reg);
    expect(state.battlefield.some((c) => c.instanceId === rootwalla)).toBe(true);
  });
});
