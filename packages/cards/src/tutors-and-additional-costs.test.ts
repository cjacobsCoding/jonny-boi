/**
 * TUTORS + MANDATORY ADDITIONAL COSTS — the compiler rules, their refusals, and
 * the cards played end-to-end through the REAL engine with this package's
 * primitives.
 *
 * The engine half is the half that matters, and it is why this file exists
 * separately from `compile.test.ts`. A rule that fills in a `searchLibrary` ref
 * proves nothing about whether the tutor can actually FIND the card it names:
 * the filter is data, and a filter that matches nothing compiles exactly as
 * cleanly as one that matches the right card. So every closed template below is
 * cast in a real game against a real library, and the assertion is where the
 * cards ended up.
 *
 * Two shapes get extra attention because they are the ones that can silently
 * play a different card:
 *   - **Multi-destination search** (Cultivate): the answer's ORDER is the
 *     routing, and a library with fewer matches than the card asks for must
 *     still work rather than throwing or stalling.
 *   - **The mandatory additional cost** (Village Rites): CR 601.2h makes an
 *     unpayable cost an ILLEGAL CAST, so an empty board must make the spell
 *     un-offerable AND un-castable — not a free two-card draw.
 */

import { describe, expect, it } from 'vitest';
import type {
  CardDefinition,
  CardInstance,
  ChoiceAnswer,
  GameAction,
  GameState,
  InstanceId,
  PendingChoice,
  PlayerId,
} from '@jonny-boi/core';
import { applyAction, createGame, DEFAULT_RULES, dumpState, generateLegalActions } from '@jonny-boi/core';
import { compileCard, type CompilableCard } from './compile/index.js';
import { buildRegistry } from './pool.js';
import { CARD_POOL } from '../data/pool.js';

type Registry = ReturnType<typeof buildRegistry>;

/** Seeds are fixed per test so any failure is reproducible. */
const SEEDS = Object.freeze({
  tutor: 401,
  cultivate: 402,
  shortLibrary: 403,
  vegetation: 404,
  graveyard: 405,
  rites: 406,
  thrill: 407,
  landscape: 408,
  hart: 409,
  farseek: 410,
});

const DECK_SIZE = 40;

// --- the compiler half ------------------------------------------------------------

function cardRecord(overrides: Partial<CompilableCard> & Pick<CompilableCard, 'oracleText'>): CompilableCard {
  return {
    id: 'test-card',
    name: 'Test Card',
    manaCost: { generic: 1, W: 0, U: 0, B: 1, R: 0, G: 0, C: 0, other: [] },
    typeLine: { supertypes: [], types: ['Sorcery'], subtypes: [] },
    power: null,
    toughness: null,
    keywords: [],
    ...overrides,
  };
}

/** The first `searchLibrary` ref a compiled card runs, wherever it is authored. */
function searchParams(def: CardDefinition): Record<string, unknown> | undefined {
  const refs = [...(def.effects ?? []), ...(def.activated ?? []).flatMap((a) => a.effects)];
  return refs.find((ref) => ref.primitive === 'searchLibrary')?.params;
}

describe('compiling library searches', () => {
  it('compiles the UNRESTRICTED tutor with no filter at all (Diabolic Tutor)', () => {
    const result = compileCard(
      cardRecord({
        name: 'Diabolic Tutor',
        oracleText: 'Search your library for a card, put that card into your hand, then shuffle.',
      }),
    );
    expect(result.missing).toEqual([]);
    expect(result.status).toBe('complete');
    expect(searchParams(result.definition)).toEqual({ who: 'controller', count: 1, destination: 'hand' });
  });

  it('compiles a FOUR-type land search by SUBTYPE, so it finds a dual (Farseek)', () => {
    const result = compileCard(
      cardRecord({
        name: 'Farseek',
        oracleText:
          'Search your library for a Plains, Island, Swamp, or Mountain card, put it onto the battlefield tapped, then shuffle.',
      }),
    );
    expect(result.status).toBe('complete');
    expect(searchParams(result.definition)).toMatchObject({
      filter: { anyOfTypes: ['land'], anyOfSubtypes: ['plains', 'island', 'swamp', 'mountain'] },
      destination: 'battlefield',
      tapped: true,
    });
  });

  it('compiles "a BASIC Swamp, Forest, or Island card" by NAME — the printed word "basic" changes the card', () => {
    const result = compileCard(
      cardRecord({
        name: 'Test Basic Types',
        oracleText:
          'Search your library for a basic Swamp, Forest, or Island card, put it onto the battlefield tapped, then shuffle.',
      }),
    );
    expect(result.status).toBe('complete');
    // BY NAME (the five basics are named data), and only the three printed ones.
    expect(searchParams(result.definition)).toMatchObject({
      nameAnyOf: ['Swamp', 'Forest', 'Island'],
      destination: 'battlefield',
      tapped: true,
    });
    // …and NOT by subtype, which would also find a dual land the card cannot get.
    expect(searchParams(result.definition)?.filter).toEqual({ anyOfTypes: ['land'] });
  });

  it('compiles the SPLIT-DESTINATION search as an ordered route (Cultivate)', () => {
    const result = compileCard(
      cardRecord({
        name: 'Cultivate',
        oracleText:
          'Search your library for up to two basic land cards, reveal those cards, put one onto the battlefield tapped and the other into your hand, then shuffle.',
      }),
    );
    expect(result.status).toBe('complete');
    expect(searchParams(result.definition)).toMatchObject({
      count: 2,
      route: [{ destination: 'battlefield', tapped: true }, { destination: 'hand' }],
    });
  });

  it('compiles "up to two basic land cards … onto the battlefield tapped" (Explosive Vegetation)', () => {
    const result = compileCard(
      cardRecord({
        name: 'Explosive Vegetation',
        oracleText:
          'Search your library for up to two basic land cards, put them onto the battlefield tapped, then shuffle.',
      }),
    );
    expect(result.status).toBe('complete');
    expect(searchParams(result.definition)).toMatchObject({ count: 2, destination: 'battlefield', tapped: true });
  });

  it('compiles a search whose destination is the GRAVEYARD (Buried Alive)', () => {
    const result = compileCard(
      cardRecord({
        name: 'Buried Alive',
        oracleText: 'Search your library for up to three creature cards, put them into your graveyard, then shuffle.',
      }),
    );
    expect(result.status).toBe('complete');
    expect(searchParams(result.definition)).toMatchObject({
      count: 3,
      destination: 'graveyard',
      filter: { anyOfTypes: ['creature'] },
    });
  });

  it('compiles a COLOUR-restricted tutor (Merchant Scroll)', () => {
    const result = compileCard(
      cardRecord({
        name: 'Merchant Scroll',
        oracleText: 'Search your library for a blue instant card, reveal that card, put it into your hand, then shuffle.',
      }),
    );
    expect(result.status).toBe('complete');
    expect(searchParams(result.definition)?.filter).toEqual({ anyOfColors: ['U'], anyOfTypes: ['instant'] });
  });

  it('compiles a TYPE UNION and a SUBTYPE UNION, and refuses a MIXED one', () => {
    const types = compileCard(
      cardRecord({
        name: 'Solve the Equation',
        oracleText: 'Search your library for an instant or sorcery card, reveal it, put it into your hand, then shuffle.',
      }),
    );
    expect(types.status).toBe('complete');
    expect(searchParams(types.definition)?.filter).toEqual({ anyOfTypes: ['instant', 'sorcery'] });

    const subtypes = compileCard(
      cardRecord({
        name: 'Open the Armory',
        oracleText: 'Search your library for an Aura or Equipment card, reveal it, put it into your hand, then shuffle.',
      }),
    );
    expect(subtypes.status).toBe('complete');
    expect(searchParams(subtypes.definition)?.filter).toEqual({ anyOfSubtypes: ['aura', 'equipment'] });

    // MIXED: `CardFilter` ANDs types with subtypes, so this would compile into a
    // search for something that is BOTH an artifact AND a Goblin — a tutor that
    // can never find. It must report instead.
    const mixed = compileCard(
      cardRecord({
        name: 'Test Mixed Union',
        oracleText: 'Search your library for an artifact or Goblin card, put it into your hand, then shuffle.',
      }),
    );
    expect(mixed.status).toBe('incomplete');
  });

  it('compiles a SACRIFICE-OUTLET tutor as an activated ability that sacrifices itself (Burnished Hart)', () => {
    const result = compileCard(
      cardRecord({
        name: 'Burnished Hart',
        typeLine: { supertypes: [], types: ['Artifact', 'Creature'], subtypes: ['Elk'] },
        power: 2,
        toughness: 2,
        oracleText:
          '{3}, Sacrifice this creature: Search your library for up to two basic land cards, put them onto the battlefield tapped, then shuffle.',
      }),
    );
    expect(result.status).toBe('complete');
    expect(result.definition.activated?.[0]?.cost).toEqual({ mana: { generic: 3 }, sacrificeSelf: true });
    expect(searchParams(result.definition)).toMatchObject({ count: 2, destination: 'battlefield', tapped: true });
  });

  it('REFUSES a subtype outside the closed table — a tutor that can never find is worse than a reported card', () => {
    const result = compileCard(
      cardRecord({
        name: 'Test Contraption Tutor',
        oracleText: 'Search your library for a Contraption card, reveal it, put it into your hand, then shuffle.',
      }),
    );
    expect(result.status).toBe('incomplete');
    expect(searchParams(result.definition)).toBeUndefined();
  });

  it('REFUSES a colour word that is not a colour', () => {
    const result = compileCard(
      cardRecord({
        name: 'Test Colourless Tutor',
        oracleText: 'Search your library for a colorless creature card, put it into your hand, then shuffle.',
      }),
    );
    expect(result.status).toBe('incomplete');
  });

  it('REFUSES a land-type list containing a word that is not a land type', () => {
    const result = compileCard(
      cardRecord({
        name: 'Test Gate Search',
        oracleText: 'Search your library for a basic Swamp, Forest, or Gate card, put it onto the battlefield, then shuffle.',
      }),
    );
    expect(result.status).toBe('incomplete');
  });
});

describe('compiling mandatory additional costs', () => {
  it('compiles "sacrifice a creature" (Village Rites)', () => {
    const result = compileCard(
      cardRecord({
        name: 'Village Rites',
        typeLine: { supertypes: [], types: ['Instant'], subtypes: [] },
        oracleText: 'As an additional cost to cast this spell, sacrifice a creature.\nDraw two cards.',
      }),
    );
    expect(result.missing).toEqual([]);
    expect(result.status).toBe('complete');
    expect(result.definition.additionalCost).toEqual({
      kind: 'sacrifice',
      filter: { anyOfTypes: ['creature'] },
      label: 'Sacrifice a creature',
    });
  });

  it('compiles the two-type union "sacrifice an artifact or creature" as ONE filter', () => {
    const result = compileCard(
      cardRecord({
        name: 'Test Dispute',
        typeLine: { supertypes: [], types: ['Instant'], subtypes: [] },
        oracleText: 'As an additional cost to cast this spell, sacrifice an artifact or creature.\nDraw two cards.',
      }),
    );
    expect(result.status).toBe('complete');
    expect(result.definition.additionalCost?.filter).toEqual({ anyOfTypes: ['artifact', 'creature'] });
  });

  it('compiles "discard a card" with NO filter (Thrill of Possibility)', () => {
    const result = compileCard(
      cardRecord({
        name: 'Thrill of Possibility',
        typeLine: { supertypes: [], types: ['Instant'], subtypes: [] },
        oracleText: 'As an additional cost to cast this spell, discard a card.\nDraw two cards.',
      }),
    );
    expect(result.status).toBe('complete');
    expect(result.definition.additionalCost).toEqual({ kind: 'discard', label: 'Discard a card' });
  });

  it('compiles a sacrifice cost in front of a SEARCH body (Diabolic Intent)', () => {
    const result = compileCard(
      cardRecord({
        name: 'Diabolic Intent',
        oracleText:
          'As an additional cost to cast this spell, sacrifice a creature.\nSearch your library for a card, put that card into your hand, then shuffle.',
      }),
    );
    expect(result.status).toBe('complete');
    expect(result.definition.additionalCost?.kind).toBe('sacrifice');
    expect(searchParams(result.definition)).toMatchObject({ destination: 'hand' });
  });

  it('REFUSES an additional cost the engine cannot perform (exile, pay life, "one or more")', () => {
    for (const text of [
      'As an additional cost to cast this spell, exile a creature card from your graveyard.',
      'As an additional cost to cast this spell, pay 3 life.',
      'As an additional cost to cast this spell, you may sacrifice one or more creatures.',
      'As an additional cost to cast this spell, sacrifice a Clue.',
    ]) {
      const result = compileCard(cardRecord({ name: 'Test Refusal', oracleText: `${text}\nDraw two cards.` }));
      expect(result.status, text).toBe('incomplete');
      expect(result.definition.additionalCost, text).toBeUndefined();
    }
  });
});

// --- the engine half --------------------------------------------------------------

function getByName(name: string): CardDefinition {
  const card = CARD_POOL.find((c) => c.name === name);
  if (!card) throw new Error(`pool missing ${name}`);
  return card;
}

const PLAINS = getByName('Plains');
const ISLAND = getByName('Island');
const SWAMP = getByName('Swamp');
const FOREST = getByName('Forest');
const SERRA = getByName('Serra Angel');

function act(state: GameState, action: GameAction, reg: Registry): GameState {
  const result = applyAction(state, action, DEFAULT_RULES, reg);
  const rejected = result.events.find((e) => e.type === 'actionRejected');
  if (rejected) {
    throw new Error(`unexpected rejection: ${(rejected as { reason: string }).reason}\n${dumpState(state)}`);
  }
  return result.state;
}

function pass(state: GameState, reg: Registry): GameState {
  return act(state, { kind: 'passPriority', player: state.priorityPlayer }, reg);
}

function deck(def: CardDefinition, n = DECK_SIZE): { cards: CardDefinition[] } {
  return { cards: Array.from({ length: n }, () => def) };
}

function gameAtMain(reg: Registry, seed: number, back: CardDefinition = ISLAND): GameState {
  const { state } = createGame({ seed, registry: reg, decks: { A: deck(back), B: deck(back) } });
  let s = state;
  let guard = 0;
  while (s.step !== 'precombatMain' && !s.gameOver && !s.pendingChoice && guard++ < 400) s = pass(s, reg);
  s.players.A.hand = [];
  s.players.B.hand = [];
  return s;
}

let syntheticId = 70_000;

function instance(def: CardDefinition, player: PlayerId, zone: CardInstance['zone']): CardInstance {
  return {
    instanceId: syntheticId++ as InstanceId,
    def,
    controller: player,
    owner: player,
    zone,
    tapped: false,
    summoningSick: false,
    damageMarked: 0,
    markedByDeathtouch: false,
    counters: {},
  };
}

function setLibrary(state: GameState, player: PlayerId, defs: readonly CardDefinition[]): CardInstance[] {
  const cards = defs.map((def) => instance(def, player, 'library'));
  state.players[player].library = cards;
  return cards;
}

function setHand(state: GameState, player: PlayerId, defs: readonly CardDefinition[]): CardInstance[] {
  const cards = defs.map((def) => instance(def, player, 'hand'));
  state.players[player].hand = cards;
  return cards;
}

function place(state: GameState, def: CardDefinition, controller: PlayerId): CardInstance {
  const card = instance(def, controller, 'battlefield');
  state.battlefield.push(card);
  return card;
}

function floodMana(state: GameState, player: PlayerId): void {
  const plenty = DECK_SIZE;
  state.players[player].manaPool = { W: plenty, U: plenty, B: plenty, R: plenty, G: plenty, C: plenty };
}

function answer(state: GameState, reg: Registry, value: ChoiceAnswer): GameState {
  const choice = state.pendingChoice;
  if (!choice) throw new Error(`no choice pending:\n${dumpState(state)}`);
  return act(state, { kind: 'answerChoice', player: choice.chooser, choiceId: choice.id, answer: value }, reg);
}

function settle(
  state: GameState,
  reg: Registry,
  reply: (choice: PendingChoice, state: GameState) => ChoiceAnswer,
  max = 40,
): GameState {
  let s = state;
  let guard = 0;
  while ((s.stack.length > 0 || s.pendingChoice) && !s.gameOver && guard++ < max) {
    s = s.pendingChoice ? answer(s, reg, reply(s.pendingChoice, s)) : pass(s, reg);
  }
  if (guard >= max) throw new Error(`resolution did not settle:\n${dumpState(s)}`);
  return s;
}

function castAndSettle(
  state: GameState,
  reg: Registry,
  caster: PlayerId,
  card: CardInstance,
  reply: (choice: PendingChoice, state: GameState) => ChoiceAnswer,
): GameState {
  floodMana(state, caster);
  const cast = act(state, { kind: 'castSpell', player: caster, instanceId: card.instanceId }, reg);
  return settle(cast, reg, reply);
}

function candidateNamed(choice: PendingChoice, name: string): InstanceId {
  if (choice.kind !== 'selectCards') throw new Error(`not a card selection: ${choice.kind}`);
  const found = choice.candidates.find((c) => c.name === name);
  if (!found) throw new Error(`no candidate named ${name} in [${choice.candidates.map((c) => c.name).join(', ')}]`);
  return found.instanceId;
}

function names(cards: readonly CardInstance[]): string[] {
  return cards.map((c) => c.def.name);
}

/** Compile a printed card and take the definition, failing loudly if it reported. */
function printed(record: Partial<CompilableCard> & Pick<CompilableCard, 'oracleText' | 'name'>): CardDefinition {
  const result = compileCard(cardRecord(record));
  if (result.status !== 'complete') {
    throw new Error(`${record.name} did not compile: ${JSON.stringify(result.missing)}`);
  }
  return result.definition;
}

const DIABOLIC_TUTOR = printed({
  name: 'Diabolic Tutor',
  oracleText: 'Search your library for a card, put that card into your hand, then shuffle.',
});

const CULTIVATE = printed({
  name: 'Cultivate',
  oracleText:
    'Search your library for up to two basic land cards, reveal those cards, put one onto the battlefield tapped and the other into your hand, then shuffle.',
});

const EXPLOSIVE_VEGETATION = printed({
  name: 'Explosive Vegetation',
  oracleText: 'Search your library for up to two basic land cards, put them onto the battlefield tapped, then shuffle.',
});

const BURIED_ALIVE = printed({
  name: 'Buried Alive',
  oracleText: 'Search your library for up to three creature cards, put them into your graveyard, then shuffle.',
});

const FARSEEK = printed({
  name: 'Farseek',
  oracleText:
    'Search your library for a Plains, Island, Swamp, or Mountain card, put it onto the battlefield tapped, then shuffle.',
});

const VILLAGE_RITES = printed({
  name: 'Village Rites',
  typeLine: { supertypes: [], types: ['Instant'], subtypes: [] },
  oracleText: 'As an additional cost to cast this spell, sacrifice a creature.\nDraw two cards.',
});

const THRILL_OF_POSSIBILITY = printed({
  name: 'Thrill of Possibility',
  typeLine: { supertypes: [], types: ['Instant'], subtypes: [] },
  oracleText: 'As an additional cost to cast this spell, discard a card.\nDraw two cards.',
});

const FOREBODING_LANDSCAPE = printed({
  name: 'Foreboding Landscape',
  typeLine: { supertypes: [], types: ['Land'], subtypes: [] },
  oracleText:
    '{T}: Add {C}.\n{T}, Sacrifice this land: Search your library for a basic Swamp, Forest, or Island card, put it onto the battlefield tapped, then shuffle.',
});

const BURNISHED_HART = printed({
  name: 'Burnished Hart',
  typeLine: { supertypes: [], types: ['Artifact', 'Creature'], subtypes: ['Elk'] },
  power: 2,
  toughness: 2,
  oracleText:
    '{3}, Sacrifice this creature: Search your library for up to two basic land cards, put them onto the battlefield tapped, then shuffle.',
});

/** A cheap distinguishable creature, so "which one did the pilot give up" is visible. */
function bear(name: string, power: number): CardDefinition {
  return { id: `bear:${name}`, name, types: ['creature'], cost: { generic: 1, G: 1 }, power, toughness: power };
}

/** A madness card, to prove the additional-cost discard uses the real discard funnel. */
const MADNESS_CARD: CardDefinition = {
  id: 'test-madness-rootwalla',
  name: 'Basking Rootwalla',
  types: ['creature'],
  power: 1,
  toughness: 1,
  cost: { generic: 4, G: 1 },
  madness: { generic: 1, G: 1 },
};

describe('tutors played through the real engine', () => {
  it('an unrestricted tutor really finds the named card, and really shuffles', () => {
    const reg = buildRegistry();
    const state = gameAtMain(reg, SEEDS.tutor);
    setLibrary(state, 'A', [ISLAND, SERRA, ISLAND, ISLAND, ISLAND]);
    const [spell] = setHand(state, 'A', [DIABOLIC_TUTOR]);

    const done = castAndSettle(state, reg, 'A', spell as CardInstance, (choice) => ({
      kind: 'selectCards',
      instanceIds: [candidateNamed(choice, 'Serra Angel')],
    }));

    expect(names(done.players.A.hand)).toEqual(['Serra Angel']);
    expect(done.players.A.library).toHaveLength(4);
    expect(names(done.players.A.library)).not.toContain('Serra Angel');
  });

  it('a search may FAIL TO FIND — the floor is zero, and the library is still shuffled', () => {
    const reg = buildRegistry();
    const state = gameAtMain(reg, SEEDS.tutor);
    setLibrary(state, 'A', [ISLAND, ISLAND, ISLAND]);
    const [spell] = setHand(state, 'A', [DIABOLIC_TUTOR]);

    const done = castAndSettle(state, reg, 'A', spell as CardInstance, () => ({
      kind: 'selectCards',
      instanceIds: [],
    }));
    expect(done.players.A.hand).toHaveLength(0);
    expect(done.players.A.library).toHaveLength(3);
  });

  it('Farseek finds a NONBASIC with the printed land type — the subtype search is not a basic search', () => {
    const reg = buildRegistry();
    const state = gameAtMain(reg, SEEDS.farseek);
    // A "Swamp"-typed nonbasic: exactly what separates Farseek from Rampant Growth.
    const dual: CardDefinition = {
      id: 'test-watery-grave',
      name: 'Watery Grave',
      types: ['land'],
      subtypes: ['Island', 'Swamp'],
      produces: ['U'],
    };
    setLibrary(state, 'A', [FOREST, dual, FOREST]);
    const [spell] = setHand(state, 'A', [FARSEEK]);

    const done = castAndSettle(state, reg, 'A', spell as CardInstance, (choice) => ({
      kind: 'selectCards',
      instanceIds: [candidateNamed(choice, 'Watery Grave')],
    }));
    const found = done.battlefield.find((c) => c.def.name === 'Watery Grave');
    expect(found).toBeDefined();
    expect(found?.tapped).toBe(true);
    // The Forests were NOT candidates — Farseek cannot fetch a Forest.
    expect(names(done.players.A.library).sort()).toEqual(['Forest', 'Forest']);
  });

  it('Cultivate ROUTES its two finds: the first chosen enters tapped, the second goes to hand', () => {
    const reg = buildRegistry();
    const state = gameAtMain(reg, SEEDS.cultivate);
    setLibrary(state, 'A', [PLAINS, SWAMP, ISLAND, ISLAND]);
    const [spell] = setHand(state, 'A', [CULTIVATE]);

    const done = castAndSettle(state, reg, 'A', spell as CardInstance, (choice) => ({
      kind: 'selectCards',
      // Plains FIRST → the battlefield step; Swamp second → the hand step.
      instanceIds: [candidateNamed(choice, 'Plains'), candidateNamed(choice, 'Swamp')],
    }));

    const onBoard = done.battlefield.filter((c) => c.controller === 'A');
    expect(names(onBoard)).toEqual(['Plains']);
    expect(onBoard[0]?.tapped).toBe(true);
    expect(names(done.players.A.hand)).toEqual(['Swamp']);
    expect(done.players.A.library).toHaveLength(2);
  });

  it('…and the ROUTE is really the answer ORDER — swapping the two swaps the destinations', () => {
    const reg = buildRegistry();
    const state = gameAtMain(reg, SEEDS.cultivate);
    setLibrary(state, 'A', [PLAINS, SWAMP, ISLAND, ISLAND]);
    const [spell] = setHand(state, 'A', [CULTIVATE]);

    const done = castAndSettle(state, reg, 'A', spell as CardInstance, (choice) => ({
      kind: 'selectCards',
      instanceIds: [candidateNamed(choice, 'Swamp'), candidateNamed(choice, 'Plains')],
    }));
    expect(names(done.battlefield.filter((c) => c.controller === 'A'))).toEqual(['Swamp']);
    expect(names(done.players.A.hand)).toEqual(['Plains']);
  });

  it('a routed search with FEWER matches than steps still works — the trailing step is unused', () => {
    const reg = buildRegistry();
    const state = gameAtMain(reg, SEEDS.shortLibrary);
    // Exactly ONE basic in the whole library; "up to two" is a maximum.
    setLibrary(state, 'A', [SERRA, PLAINS, SERRA]);
    const [spell] = setHand(state, 'A', [CULTIVATE]);

    const done = castAndSettle(state, reg, 'A', spell as CardInstance, (choice) => ({
      kind: 'selectCards',
      instanceIds: [candidateNamed(choice, 'Plains')],
    }));
    expect(names(done.battlefield.filter((c) => c.controller === 'A'))).toEqual(['Plains']);
    expect(done.players.A.hand).toHaveLength(0);
    expect(done.players.A.library).toHaveLength(2);
  });

  it('a routed search with NO matches resolves cleanly and moves nothing', () => {
    const reg = buildRegistry();
    const state = gameAtMain(reg, SEEDS.shortLibrary);
    setLibrary(state, 'A', [SERRA, SERRA]);
    const [spell] = setHand(state, 'A', [CULTIVATE]);
    // No candidates at all: the engine settles the trivial choice itself.
    const done = castAndSettle(state, reg, 'A', spell as CardInstance, () => ({
      kind: 'selectCards',
      instanceIds: [],
    }));
    expect(done.battlefield.filter((c) => c.controller === 'A')).toHaveLength(0);
    expect(done.players.A.hand).toHaveLength(0);
    expect(done.players.A.library).toHaveLength(2);
  });

  it('Explosive Vegetation puts BOTH finds onto the battlefield tapped', () => {
    const reg = buildRegistry();
    const state = gameAtMain(reg, SEEDS.vegetation);
    setLibrary(state, 'A', [PLAINS, FOREST, SERRA]);
    const [spell] = setHand(state, 'A', [EXPLOSIVE_VEGETATION]);

    const done = castAndSettle(state, reg, 'A', spell as CardInstance, (choice) => ({
      kind: 'selectCards',
      instanceIds: [candidateNamed(choice, 'Plains'), candidateNamed(choice, 'Forest')],
    }));
    const mine = done.battlefield.filter((c) => c.controller === 'A');
    expect(names(mine).sort()).toEqual(['Forest', 'Plains']);
    expect(mine.every((c) => c.tapped)).toBe(true);
    expect(done.players.A.hand).toHaveLength(0);
  });

  it('Buried Alive really puts the found creatures into the GRAVEYARD', () => {
    const reg = buildRegistry();
    const state = gameAtMain(reg, SEEDS.graveyard);
    setLibrary(state, 'A', [SERRA, ISLAND, SERRA, SERRA]);
    const [spell] = setHand(state, 'A', [BURIED_ALIVE]);

    const done = castAndSettle(state, reg, 'A', spell as CardInstance, (choice) => {
      if (choice.kind !== 'selectCards') throw new Error('expected a card selection');
      return { kind: 'selectCards', instanceIds: choice.candidates.map((c) => c.instanceId) };
    });
    // Three Serras found; the spell itself is also in the graveyard.
    expect(names(done.players.A.graveyard).filter((n) => n === 'Serra Angel')).toHaveLength(3);
    expect(names(done.players.A.library)).toEqual(['Island']);
  });

  it('a Landscape land really sacrifices itself and really fetches one of its three basics', () => {
    const reg = buildRegistry();
    const state = gameAtMain(reg, SEEDS.landscape);
    setLibrary(state, 'A', [PLAINS, SWAMP, ISLAND]);
    const land = place(state, FOREBODING_LANDSCAPE, 'A');
    land.summoningSick = false;
    floodMana(state, 'A');

    const activation = generateLegalActions(state, DEFAULT_RULES).find(
      (a): a is Extract<GameAction, { kind: 'activateAbility' }> =>
        a.kind === 'activateAbility' && a.instanceId === land.instanceId && a.abilityIndex === 0,
    );
    expect(activation).toBeDefined();
    const activated = act(state, activation as GameAction, reg);
    // The sacrifice is a COST: the land is already in the graveyard.
    expect(names(activated.players.A.graveyard)).toContain('Foreboding Landscape');

    const done = settle(activated, reg, (choice) => ({
      kind: 'selectCards',
      instanceIds: [candidateNamed(choice, 'Swamp')],
    }));
    const fetched = done.battlefield.find((c) => c.def.name === 'Swamp');
    expect(fetched).toBeDefined();
    expect(fetched?.tapped).toBe(true);
    // Plains was in the library but is NOT one of the three printed types.
    expect(names(done.players.A.library).sort()).toEqual(['Island', 'Plains']);
  });

  it('Burnished Hart fetches TWO basics off one sacrifice', () => {
    const reg = buildRegistry();
    const state = gameAtMain(reg, SEEDS.hart);
    setLibrary(state, 'A', [PLAINS, FOREST, SERRA]);
    const hart = place(state, BURNISHED_HART, 'A');
    hart.summoningSick = false;
    floodMana(state, 'A');

    const activation = generateLegalActions(state, DEFAULT_RULES).find(
      (a): a is Extract<GameAction, { kind: 'activateAbility' }> =>
        a.kind === 'activateAbility' && a.instanceId === hart.instanceId,
    );
    const done = settle(act(state, activation as GameAction, reg), reg, (choice) => {
      if (choice.kind !== 'selectCards') throw new Error('expected a card selection');
      return { kind: 'selectCards', instanceIds: choice.candidates.map((c) => c.instanceId) };
    });
    expect(names(done.battlefield.filter((c) => c.controller === 'A')).sort()).toEqual(['Forest', 'Plains']);
    expect(names(done.players.A.graveyard)).toContain('Burnished Hart');
  });
});

describe('mandatory additional costs played through the real engine', () => {
  it('is NOT OFFERED and is REJECTED when the cost cannot be paid (CR 601.2h)', () => {
    const reg = buildRegistry();
    const state = gameAtMain(reg, SEEDS.rites);
    const [spell] = setHand(state, 'A', [VILLAGE_RITES]);
    floodMana(state, 'A');

    const offered = generateLegalActions(state, DEFAULT_RULES).filter(
      (a) => a.kind === 'castSpell' && a.instanceId === (spell as CardInstance).instanceId,
    );
    expect(offered).toEqual([]);

    const result = applyAction(
      state,
      { kind: 'castSpell', player: 'A', instanceId: (spell as CardInstance).instanceId },
      DEFAULT_RULES,
      reg,
    );
    const rejected = result.events.find((e) => e.type === 'actionRejected');
    expect(rejected).toBeDefined();
    // …and nothing was half-paid: the card is still in hand.
    expect(names(result.state.players.A.hand)).toEqual(['Village Rites']);
  });

  it('really SACRIFICES the chosen creature as part of casting, and the spell then resolves', () => {
    const reg = buildRegistry();
    const state = gameAtMain(reg, SEEDS.rites);
    setLibrary(state, 'A', [ISLAND, ISLAND, ISLAND, ISLAND]);
    place(state, bear('Runt', 1), 'A');
    place(state, bear('Bruiser', 5), 'A');
    const [spell] = setHand(state, 'A', [VILLAGE_RITES]);

    const done = castAndSettle(state, reg, 'A', spell as CardInstance, (choice) => ({
      kind: 'selectCards',
      instanceIds: [candidateNamed(choice, 'Runt')],
    }));

    expect(names(done.battlefield.filter((c) => c.controller === 'A'))).toEqual(['Bruiser']);
    expect(names(done.players.A.graveyard)).toContain('Runt');
    expect(done.players.A.hand).toHaveLength(2); // the two cards drawn
  });

  it('pays itself with the ONLY legal payer without stopping the game', () => {
    const reg = buildRegistry();
    const state = gameAtMain(reg, SEEDS.rites);
    setLibrary(state, 'A', [ISLAND, ISLAND, ISLAND]);
    place(state, bear('Only', 2), 'A');
    const [spell] = setHand(state, 'A', [VILLAGE_RITES]);
    floodMana(state, 'A');

    const cast = act(state, { kind: 'castSpell', player: 'A', instanceId: (spell as CardInstance).instanceId }, reg);
    // One legal way to pay is not a decision: nothing is parked, and the bear is
    // already gone by the time the spell is on the stack.
    expect(cast.pendingChoice ?? null).toBeNull();
    expect(names(cast.players.A.graveyard)).toContain('Only');
    const done = settle(cast, reg, () => ({ kind: 'confirm', yes: true }));
    expect(done.players.A.hand).toHaveLength(2);
  });

  it('a DISCARD cost goes through the real discard funnel — a madness card is EXILED, not buried', () => {
    const reg = buildRegistry();
    const state = gameAtMain(reg, SEEDS.thrill);
    setLibrary(state, 'A', [ISLAND, ISLAND, ISLAND]);
    const [spell] = setHand(state, 'A', [THRILL_OF_POSSIBILITY, MADNESS_CARD]);
    floodMana(state, 'A');

    // The only other card in hand is the madness card, so the cost has exactly
    // one legal payer and the engine settles it as the spell is cast.
    const cast = act(state, { kind: 'castSpell', player: 'A', instanceId: (spell as CardInstance).instanceId }, reg);
    expect(names(cast.players.A.exile)).toContain('Basking Rootwalla');
    expect(names(cast.players.A.graveyard)).not.toContain('Basking Rootwalla');
    expect(cast.madnessWindow?.controller).toBe('A');
  });

  it('the spell cannot pay its own additional cost with itself', () => {
    const reg = buildRegistry();
    const state = gameAtMain(reg, SEEDS.thrill);
    const [spell] = setHand(state, 'A', [THRILL_OF_POSSIBILITY]);
    floodMana(state, 'A');
    // A hand of exactly the spell: the discard has no payer, so no cast is offered.
    expect(
      generateLegalActions(state, DEFAULT_RULES).filter(
        (a) => a.kind === 'castSpell' && a.instanceId === (spell as CardInstance).instanceId,
      ),
    ).toEqual([]);
  });
});
