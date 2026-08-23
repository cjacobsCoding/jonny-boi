/**
 * REPLACEMENT AND PREVENTION EFFECTS — the printed cards, compiled from their
 * real Oracle text and then PLAYED.
 *
 * Core's own `replacement.test.ts` pins the layer's rules (CR 614.5 once per
 * event, CR 616.1 ordering, shields being consumed, inertness). This file pins
 * the other half, which is where this repo has shipped lies before: that the
 * printed line actually reaches that layer, with the right filter, and that the
 * board really changes in a game the engine played.
 *
 * Every card here is therefore proven three ways:
 *   1. it compiles `'complete'` — no clause reported, no keyword double-reported;
 *   2. the compiled `replacements` entry carries EXACTLY the printed filter (a
 *      "red source you control" that quietly widened to "any source" would still
 *      pass a damage test);
 *   3. the effect changes a real game — combat damage doubled, counters
 *      multiplied, a fog turning a lethal swing into nothing.
 */

import { describe, expect, it } from 'vitest';
import {
  applyAction,
  createGame,
  createRng,
  DEFAULT_RULES,
  generateLegalActions,
  PLUS_ONE_COUNTER,
  indexReplacements,
  replaceCounters,
  replaceDamage,
  type CardDefinition,
  type CardInstance,
  type GameEvent,
  type GameState,
  type PlayerId,
} from '@jonny-boi/core';
import { createHeuristicPilot } from '@jonny-boi/ai';
import { buildRegistry } from './pool.js';
import { compileCard } from './compile/compile.js';
import type { CompilableCard } from './compile/types.js';

const NO_MANA = { generic: 0, W: 0, U: 0, B: 0, R: 0, G: 0, C: 0, other: [] as readonly string[] };

function scryfall(parts: {
  name: string;
  cost?: Partial<typeof NO_MANA>;
  types: readonly string[];
  supertypes?: readonly string[];
  subtypes?: readonly string[];
  oracleText: string;
  keywords?: readonly string[];
  power?: number | null;
  toughness?: number | null;
}): CompilableCard {
  return {
    id: `replacement:${parts.name}`,
    name: parts.name,
    manaCost: { ...NO_MANA, ...parts.cost },
    typeLine: { supertypes: parts.supertypes ?? [], types: parts.types, subtypes: parts.subtypes ?? [] },
    oracleText: parts.oracleText,
    power: parts.power ?? null,
    toughness: parts.toughness ?? null,
    keywords: parts.keywords ?? [],
  };
}

/** Compile insisting the card be fully playable — the importer's own bar. */
function playable(card: CompilableCard): CardDefinition {
  const result = compileCard(card);
  expect(result.status, `${card.name}: ${JSON.stringify(result.missing)}`).toBe('complete');
  return result.definition;
}

// --- the printed cards, verbatim -------------------------------------------------

const HARDENED_SCALES = scryfall({
  name: 'Hardened Scales',
  cost: { G: 1 },
  types: ['Enchantment'],
  oracleText:
    'If one or more +1/+1 counters would be put on a creature you control, that many plus one +1/+1 counters are put on it instead.',
});

const CORPSEJACK_MENACE = scryfall({
  name: 'Corpsejack Menace',
  cost: { generic: 2, B: 1, G: 1 },
  types: ['Creature'],
  subtypes: ['Fungus'],
  power: 4,
  toughness: 4,
  oracleText:
    'If one or more +1/+1 counters would be put on a creature you control, twice that many +1/+1 counters are put on it instead.',
});

const TORBRAN = scryfall({
  name: 'Torbran, Thane of Red Fell',
  cost: { generic: 1, R: 3 },
  types: ['Creature'],
  supertypes: ['Legendary'],
  subtypes: ['Dwarf', 'Noble'],
  power: 2,
  toughness: 4,
  oracleText:
    'If a red source you control would deal damage to an opponent or a permanent an opponent controls, it deals that much damage plus 2 instead.',
});

const GRATUITOUS_VIOLENCE = scryfall({
  name: 'Gratuitous Violence',
  cost: { generic: 2, R: 3 },
  types: ['Enchantment'],
  oracleText:
    'If a creature you control would deal damage to a permanent or player, it deals double that damage instead.',
});

const FIERY_EMANCIPATION = scryfall({
  name: 'Fiery Emancipation',
  cost: { generic: 3, R: 3 },
  types: ['Enchantment'],
  keywords: ['Triple'],
  oracleText:
    'If a source you control would deal damage to a permanent or player, it deals triple that damage to that permanent or player instead.',
});

const GISELA = scryfall({
  name: 'Gisela, Blade of Goldnight',
  cost: { generic: 4, R: 1, W: 2 },
  types: ['Creature'],
  supertypes: ['Legendary'],
  subtypes: ['Angel'],
  power: 5,
  toughness: 5,
  keywords: ['Flying', 'First strike', 'Double'],
  oracleText:
    'Flying, first strike\nIf a source would deal damage to an opponent or a permanent an opponent controls, that source deals double that damage to that player or permanent instead.\nIf a source would deal damage to you or a permanent you control, prevent half that damage, rounded up.',
});

const DOLMEN_GATE = scryfall({
  name: 'Dolmen Gate',
  cost: { generic: 2 },
  types: ['Artifact'],
  oracleText: 'Prevent all combat damage that would be dealt to attacking creatures you control.',
});

const FOG = scryfall({
  name: 'Fog',
  cost: { G: 1 },
  types: ['Instant'],
  oracleText: 'Prevent all combat damage that would be dealt this turn.',
});

const LABORATORY_MANIAC = scryfall({
  name: 'Laboratory Maniac',
  cost: { generic: 2, U: 1 },
  types: ['Creature'],
  subtypes: ['Human', 'Wizard'],
  power: 2,
  toughness: 2,
  oracleText: 'If you would draw a card while your library has no cards in it, you win the game instead.',
});

const TEFERIS_AGELESS_INSIGHT = scryfall({
  name: "Teferi's Ageless Insight",
  cost: { generic: 2, U: 2 },
  types: ['Enchantment'],
  supertypes: ['Legendary'],
  oracleText:
    'If you would draw a card except the first one you draw in each of your draw steps, draw two cards instead.',
});

describe('the printed lines compile with EXACTLY their printed filter', () => {
  it('Hardened Scales — +1, creatures you control, +1/+1 counters only', () => {
    const definition = playable(HARDENED_SCALES);
    expect(definition.replacements).toHaveLength(1);
    expect(definition.replacements?.[0]).toMatchObject({
      event: 'counters',
      applies: {
        recipientController: 'you',
        recipientFilter: { anyOfTypes: ['creature'] },
        counterKind: PLUS_ONE_COUNTER,
      },
      outcome: { plus: 1 },
    });
  });

  it('Corpsejack Menace — the SAME filter with a multiplier, not an addend', () => {
    expect(playable(CORPSEJACK_MENACE).replacements?.[0]?.outcome).toEqual({ times: 2 });
  });

  it('Torbran — "a RED source YOU control" to "an OPPONENT" is three restrictions, all kept', () => {
    const definition = playable(TORBRAN);
    expect(definition.replacements?.[0]).toMatchObject({
      event: 'damage',
      applies: {
        sourceController: 'you',
        sourceFilter: { anyOfColors: ['R'] },
        recipientController: 'opponent',
      },
      outcome: { plus: 2 },
    });
    // Not a multiplier: Torbran adds, and reading "plus 2" as "times 2" would be
    // a different card that happens to look right on a 2-damage source.
    expect(definition.replacements?.[0]?.outcome.times).toBeUndefined();
  });

  it('Gratuitous Violence — "a CREATURE you control" narrows the source by TYPE', () => {
    expect(playable(GRATUITOUS_VIOLENCE).replacements?.[0]).toMatchObject({
      applies: { sourceController: 'you', sourceFilter: { anyOfTypes: ['creature'] } },
      outcome: { times: 2 },
    });
  });

  it('Fiery Emancipation — triple, and the "Triple" keyword is not reported twice', () => {
    const result = compileCard(FIERY_EMANCIPATION);
    expect(result.status, JSON.stringify(result.missing)).toBe('complete');
    expect(result.definition.replacements?.[0]?.outcome).toEqual({ times: 3 });
  });

  it('Gisela — two clauses, one doubling outward and one halving inward', () => {
    const definition = playable(GISELA);
    expect(definition.replacements).toHaveLength(2);
    expect(definition.replacements?.[0]).toMatchObject({
      applies: { recipientController: 'opponent' },
      outcome: { times: 2 },
    });
    expect(definition.replacements?.[1]).toMatchObject({
      applies: { recipientController: 'you' },
      outcome: { preventHalfRoundedUp: true },
    });
    // Neither clause says "a source YOU control" — Gisela is symmetric about
    // whose source it is and asymmetric about who is hit.
    expect(definition.replacements?.[0]?.applies.sourceController).toBeUndefined();
  });

  it('Dolmen Gate — a STATIC prevention, combat only, attacking creatures only', () => {
    expect(playable(DOLMEN_GATE).replacements?.[0]).toMatchObject({
      event: 'damage',
      applies: {
        combat: true,
        recipientController: 'you',
        recipientKind: 'permanent',
        recipientAttacking: true,
      },
      outcome: { preventAll: true },
    });
  });

  it('Fog — a ONE-SHOT, so it is a spell effect and NOT a static', () => {
    const definition = playable(FOG);
    expect(definition.replacements).toBeUndefined();
    expect(definition.effects?.[0]).toMatchObject({
      primitive: 'preventDamage',
      params: { combat: true },
    });
  });

  it('Laboratory Maniac / Teferi’s Ageless Insight — the draw family', () => {
    expect(playable(LABORATORY_MANIAC).replacements?.[0]).toMatchObject({
      event: 'draw',
      applies: { recipientController: 'you', requiresEmptyLibrary: true },
      outcome: { winGame: true },
    });
    expect(playable(TEFERIS_AGELESS_INSIGHT).replacements?.[0]).toMatchObject({
      event: 'draw',
      applies: { recipientController: 'you', exceptFirstDrawEachDrawStep: true },
      outcome: { times: 2 },
    });
  });
});

describe('the compiler refuses what it cannot build, by name', () => {
  it('compiles the TOKEN doubler alongside the counter doubler — Doubling Season whole', () => {
    // This test used to pin the refusal; the token-count replacement exists now
    // (feat/token-doublers), so what it pins instead is the pairing: BOTH
    // printed halves compile, each to its own event kind.
    const doublingSeason = compileCard(
      scryfall({
        name: 'Doubling Season',
        cost: { generic: 4, G: 1 },
        types: ['Enchantment'],
        oracleText:
          'If an effect would create one or more tokens under your control, it creates twice that many of those tokens instead.\nIf an effect would put one or more counters on a permanent you control, it puts twice that many of those counters on that permanent instead.',
      }),
    );
    expect(doublingSeason.status, JSON.stringify(doublingSeason.missing)).toBe('complete');
    expect(doublingSeason.definition.replacements?.map((r) => [r.event, r.outcome.times])).toEqual([
      ['tokens', 2],
      ['counters', 2],
    ]);
  });

  it('does not compile a fog printed on an INSTANT as a permanent static', () => {
    // Same sentence, no "this turn", on an instant: neither rule may claim it.
    const bogus = compileCard(
      scryfall({
        name: 'Not A Gate',
        cost: { W: 1 },
        types: ['Instant'],
        oracleText: 'Prevent all combat damage that would be dealt to attacking creatures you control.',
      }),
    );
    expect(bogus.status).toBe('incomplete');
    expect(bogus.definition.replacements).toBeUndefined();
  });

  it('does not read a static prevention printed on a permanent as a one-shot', () => {
    const gate = playable(DOLMEN_GATE);
    expect(gate.effects).toBeUndefined();
  });
});

// --- played, not merely compiled -------------------------------------------------

const FOREST: CardDefinition = { id: 'r-forest', name: 'Forest', types: ['land'], produces: ['G'] };

function freshState(): GameState {
  const registry = buildRegistry();
  return createGame({
    seed: 5,
    decks: {
      A: { cards: Array.from({ length: 40 }, () => FOREST) },
      B: { cards: Array.from({ length: 40 }, () => FOREST) },
    },
    registry,
  }).state;
}

function put(state: GameState, def: CardDefinition, controller: PlayerId): CardInstance {
  const inst: CardInstance = {
    instanceId: state.nextInstanceId++,
    def,
    controller,
    owner: controller,
    zone: 'battlefield',
    tapped: false,
    summoningSick: false,
    damageMarked: 0,
    markedByDeathtouch: false,
    counters: {},
    attachedTo: null,
  };
  state.battlefield.push(inst);
  return inst;
}

const RED_BEAR: CardDefinition = {
  id: 'r-red-bear',
  name: 'Red Bear',
  types: ['creature'],
  power: 2,
  toughness: 2,
  cost: { R: 1 },
};

const GREEN_BEAR: CardDefinition = {
  id: 'r-green-bear',
  name: 'Green Bear',
  types: ['creature'],
  power: 2,
  toughness: 2,
  cost: { G: 1 },
};

describe('the shipped definitions really change a board', () => {
  it('Hardened Scales turns one counter into two, on the real counter path', () => {
    const state = freshState();
    put(state, playable(HARDENED_SCALES), 'A');
    const creature = put(state, GREEN_BEAR, 'A');
    expect(
      replaceCounters(state, indexReplacements(state), undefined, creature, PLUS_ONE_COUNTER, 1, () => {}),
    ).toBe(2);
  });

  it('Hardened Scales + Corpsejack Menace is FOUR, the order their controller wants', () => {
    const state = freshState();
    put(state, playable(HARDENED_SCALES), 'A');
    put(state, playable(CORPSEJACK_MENACE), 'A');
    const creature = put(state, GREEN_BEAR, 'A');
    expect(
      replaceCounters(state, indexReplacements(state), undefined, creature, PLUS_ONE_COUNTER, 1, () => {}),
    ).toBe(4);
  });

  it('Torbran reads COLOUR off the source: a red creature gets +2, a green one does not', () => {
    const state = freshState();
    put(state, playable(TORBRAN), 'A');
    const red = put(state, RED_BEAR, 'A');
    const green = put(state, GREEN_BEAR, 'A');
    const index = indexReplacements(state);
    expect(replaceDamage(state, index, red, 'A', undefined, 'B', 2, true, () => {}).amount).toBe(4);
    expect(replaceDamage(state, index, green, 'A', undefined, 'B', 2, true, () => {}).amount).toBe(2);
    // …and it does not help the OPPONENT's red source, nor damage aimed at its
    // own controller.
    const theirRed = put(state, RED_BEAR, 'B');
    const after = indexReplacements(state);
    expect(replaceDamage(state, after, theirRed, 'B', undefined, 'A', 2, true, () => {}).amount).toBe(2);
    expect(replaceDamage(state, after, red, 'A', undefined, 'A', 2, true, () => {}).amount).toBe(2);
  });

  it('Gisela doubles outgoing damage and halves incoming, rounded UP', () => {
    const state = freshState();
    const gisela = put(state, playable(GISELA), 'A');
    const theirs = put(state, GREEN_BEAR, 'B');
    const index = indexReplacements(state);
    // Outgoing: 5 to the opponent becomes 10.
    expect(replaceDamage(state, index, gisela, 'A', undefined, 'B', 5, true, () => {}).amount).toBe(10);
    // Incoming: 5 at Gisela's controller has 3 (half, rounded up) prevented.
    expect(replaceDamage(state, index, theirs, 'B', undefined, 'A', 5, true, () => {})).toEqual({
      amount: 2,
      prevented: 3,
    });
  });
});

// --- whole games ------------------------------------------------------------------

describe('a fog cast in a real game really stops combat damage', () => {
  it('is cast at declare-blockers, prevents the swing, and wears off in cleanup', () => {
    const registry = buildRegistry();
    const state = freshState();
    const attacker = put(state, { ...GREEN_BEAR, id: 'fog-ogre', name: 'Ogre', power: 6, toughness: 6 }, 'A');
    put(state, FOREST, 'B');
    const fogCard: CardInstance = {
      instanceId: state.nextInstanceId++,
      def: playable(FOG),
      controller: 'B',
      owner: 'B',
      zone: 'hand',
      tapped: false,
      summoningSick: false,
      damageMarked: 0,
      markedByDeathtouch: false,
      counters: {},
      attachedTo: null,
    };
    state.players.B.hand.push(fogCard);
    state.players.B.life = 20;

    state.step = 'declareAttackers';
    state.activePlayer = 'A';
    state.priorityPlayer = 'A';
    state.combat = { attackers: [], blocks: {}, attackersDeclared: false, blockersDeclared: false };

    let current = applyAction(
      state,
      { kind: 'declareAttackers', player: 'A', attackers: [attacker.instanceId] },
      DEFAULT_RULES,
      registry,
    ).state;

    // Drive the real engine with the real pilot from here: it must find the Fog
    // on its own, in the window where the Fog is worth casting.
    const pilot = createHeuristicPilot();
    const rng = createRng(17);
    const events: GameEvent[] = [];
    for (let i = 0; i < 60 && current.step !== 'postcombatMain' && !current.gameOver; i++) {
      const legal = generateLegalActions(current, DEFAULT_RULES);
      if (legal.length === 0) break;
      const chosen = pilot.chooseAction({ view: current, legalActions: legal, rng, registry });
      const result = applyAction(current, chosen, DEFAULT_RULES, registry);
      current = result.state;
      events.push(...result.events);
    }

    // PRECONDITION: the pilot really cast it. Without this the life assertion
    // below would also pass on a build where the Fog was never castable at all.
    expect(
      events.some((e) => e.type === 'spellCast' && e.name === 'Fog'),
      'the pilot never cast the Fog',
    ).toBe(true);
    // The swing did nothing, and the log says why.
    expect(current.players.B.life).toBe(20);
    expect(events.filter((e) => e.type === 'damagePrevented' && e.combat).length).toBeGreaterThan(0);
    expect(events.filter((e) => e.type === 'damageDealt' && e.combat).length).toBe(0);
    // The prevention effect is REAL state while it stands…
    expect((current.replacements ?? []).length).toBe(1);
    // …and wears off in cleanup.
    let cleaned = current;
    for (let i = 0; i < 200 && cleaned.turnNumber === current.turnNumber && !cleaned.gameOver; i++) {
      const legal = generateLegalActions(cleaned, DEFAULT_RULES);
      if (legal.length === 0) break;
      const chosen = pilot.chooseAction({ view: cleaned, legalActions: legal, rng, registry });
      cleaned = applyAction(cleaned, chosen, DEFAULT_RULES, registry).state;
    }
    expect(cleaned.replacements ?? []).toHaveLength(0);
  });
});

describe('a damage doubler in a real game', () => {
  it('doubles COMBAT damage through the combat step, not just through a spell', () => {
    const state = freshState();
    put(state, playable(GRATUITOUS_VIOLENCE), 'A');
    const attacker = put(state, GREEN_BEAR, 'A');
    // Drive the real combat damage step by hand: declare, then let the engine
    // resolve. This is the path a doubler is most likely to miss, because it
    // does not go anywhere near an effect primitive.
    state.step = 'declareAttackers';
    state.activePlayer = 'A';
    state.priorityPlayer = 'A';
    state.combat = { attackers: [], blocks: {}, attackersDeclared: false, blockersDeclared: false };
    const registry = buildRegistry();
    let current = state;
    const before = current.players.B.life;
    current = applyAction(
      current,
      { kind: 'declareAttackers', player: 'A', attackers: [attacker.instanceId] },
      DEFAULT_RULES,
      registry,
    ).state;
    for (let i = 0; i < 40 && current.step !== 'endCombat' && !current.gameOver; i++) {
      const legal = generateLegalActions(current, DEFAULT_RULES);
      const pass = legal.find((a) => a.kind === 'passPriority');
      if (!pass) break;
      current = applyAction(current, pass, DEFAULT_RULES, registry).state;
    }
    expect(before - current.players.B.life).toBe(4);
  });
});
