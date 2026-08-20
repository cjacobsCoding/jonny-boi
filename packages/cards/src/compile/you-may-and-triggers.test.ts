/**
 * TEMPLATE-GAP closures for the **"you may" and trigger-timing** families —
 * printed Oracle wordings the engine could already play (or can play with a
 * small, named addition) but the rule table did not recognize.
 *
 * Every closure here is proven twice, per the compiler contract:
 *
 *   1. a REAL card printing the wording compiles `'complete'`, with the emitted
 *      params PINNED so they cannot silently drift, and
 *   2. that compiled definition PLAYS correctly through `createGame` +
 *      `applyAction` — and for a "you may", **both answers are played**, because
 *      declining is the half that silently breaks. A "you may" that only works
 *      when you say yes is a different card from the printed one.
 *
 * Alongside each closure sit the REFUSALS that keep it honest: the neighbouring
 * wordings the engine still cannot play must stay `'incomplete'`.
 */

import { describe, expect, it } from 'vitest';
import type {
  CardDefinition,
  CardInstance,
  ChoiceAnswer,
  GameAction,
  GameState,
  PendingChoice,
  PlayerId,
} from '@jonny-boi/core';
import { applyAction, createGame, DEFAULT_RULES, dumpState, entersTapped } from '@jonny-boi/core';
import { compileCard } from './compile.js';
import type { CompilableCard } from './types.js';
import { buildRegistry } from '../pool.js';
import { BASIC_LAND_NAMES, CARD_POOL } from '../../data/pool.js';

type Registry = ReturnType<typeof buildRegistry>;

/** Seeds are fixed per test so any failure is reproducible. */
const SEEDS = Object.freeze({
  slowland: 401,
  battleland: 402,
  reclamationSage: 403,
  goblinMatron: 404,
  farhaven: 405,
  endStep: 406,
  eachUpkeep: 407,
  combatDamage: 408,
  creatureEtb: 409,
  drawStep: 410,
});

/** How many cards fill a test deck — enough that nobody decks out mid-test. */
const DECK_SIZE = 40;

/** A Scryfall-shaped record for the compiler. */
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

// --- the real cards, as printed --------------------------------------------------

/** A slowland (Deserted Beach), printed exactly as Scryfall has it. */
const DESERTED_BEACH = makeCard({
  name: 'Deserted Beach',
  typeLine: { supertypes: [], types: ['Land'], subtypes: [] },
  oracleText: 'This land enters tapped unless you control two or more other lands.\n{T}: Add {W} or {U}.',
});

/** A battleland (Prairie Stream) — the reminder line is its mana ability. */
const PRAIRIE_STREAM = makeCard({
  name: 'Prairie Stream',
  typeLine: { supertypes: [], types: ['Land'], subtypes: ['Plains', 'Island'] },
  oracleText: '({T}: Add {W} or {U}.)\nThis land enters tapped unless you control two or more basic lands.',
});

/** A basic land, to prove the compiler carries the Basic supertype through. */
const BASIC_PLAINS = makeCard({
  name: 'Plains',
  typeLine: { supertypes: ['Basic'], types: ['Land'], subtypes: ['Plains'] },
  oracleText: '({T}: Add {W}.)',
});

// --- compile: the enters-tapped wordings ------------------------------------------

describe('enters-tapped templates — the slowland and battleland cycles', () => {
  it('compiles Deserted Beach completely ("two or more other lands")', () => {
    const result = compileCard(DESERTED_BEACH);
    expect(result.status, JSON.stringify(result.missing)).toBe('complete');
    expect(result.definition.entersTappedUnless).toEqual({ minOtherLands: 2 });
    // It is NOT the unconditional tapland — that flag would make it always tapped.
    expect(result.definition.entersTapped).toBeUndefined();
  });

  it('compiles Prairie Stream completely ("two or more basic lands")', () => {
    const result = compileCard(PRAIRIE_STREAM);
    expect(result.status, JSON.stringify(result.missing)).toBe('complete');
    expect(result.definition.entersTappedUnless).toEqual({ minBasicLands: 2 });
  });

  it('carries the printed Basic supertype onto the definition', () => {
    // The battleland condition counts THIS flag. Without it a basic Plains and
    // a nonbasic dual printing "Plains" would be indistinguishable.
    const result = compileCard(BASIC_PLAINS);
    expect(result.definition.basic).toBe(true);
    expect(compileCard(PRAIRIE_STREAM).definition.basic).toBeUndefined();
  });

  it('REFUSES a count outside the closed number table rather than guessing', () => {
    const result = compileCard(
      makeCard({
        name: 'Test Slowland',
        typeLine: { supertypes: [], types: ['Land'], subtypes: [] },
        oracleText: 'This land enters tapped unless you control seventeen or more other lands.',
      }),
    );
    expect(result.status).toBe('incomplete');
  });

  it('COMPILES "unless you control two or more creatures" through the general condition', () => {
    // This case used to assert a refusal. The four fixed cycles above (fastland,
    // slowland, battleland, checkland) now sit alongside a GENERAL
    // `controlsMatching` condition built on the shared `CardFilter`, so any
    // "unless you control [N] [permanents]" wording it can express compiles —
    // which is what let the Lord of the Rings lands ("unless you control a
    // legendary creature") in. A noun outside the closed tables still reports.
    const result = compileCard(
      makeCard({
        name: 'Test Creatureland',
        typeLine: { supertypes: [], types: ['Land'], subtypes: [] },
        oracleText: 'This land enters tapped unless you control two or more creatures.',
      }),
    );
    expect(result.status).toBe('complete');
    expect(result.definition?.entersTappedUnless).toEqual({
      controlsMatching: { filter: { anyOfTypes: ['creature'] }, minimum: 2 },
    });
  });

  it('STILL refuses a noun outside the closed tables', () => {
    const result = compileCard(
      makeCard({
        name: 'Test Wizardland',
        typeLine: { supertypes: [], types: ['Land'], subtypes: [] },
        oracleText: 'This land enters tapped unless you control a Wizard.',
      }),
    );
    expect(result.status).toBe('incomplete');
  });
});

// --- play helpers ----------------------------------------------------------------

function getByName(name: string): CardDefinition {
  const card = CARD_POOL.find((c) => c.name === name);
  if (!card) throw new Error(`pool missing ${name}`);
  return card;
}

const ISLAND = getByName('Island');
const PLAINS = getByName('Plains');
const FOREST = getByName('Forest');
const BOLT = getByName('Lightning Bolt');

function deck(def: CardDefinition, n = DECK_SIZE): { cards: CardDefinition[] } {
  return { cards: Array.from({ length: n }, () => def) };
}

function act(state: GameState, action: GameAction, reg: Registry): GameState {
  const result = applyAction(state, action, DEFAULT_RULES, reg);
  const rejected = result.events.find((e) => e.type === 'actionRejected');
  if (rejected) {
    throw new Error(
      `unexpected rejection: ${(rejected as { reason: string }).reason}\n${dumpState(state)}`,
    );
  }
  return result.state;
}

function pass(state: GameState, reg: Registry): GameState {
  return act(state, { kind: 'passPriority', player: state.priorityPlayer }, reg);
}

/** Advance (by passing) until the named step, or until a question is parked. */
function advanceToStep(
  state: GameState,
  step: GameState['step'],
  reg: Registry,
  max = 400,
): GameState {
  let s = state;
  let guard = 0;
  while (s.step !== step && !s.gameOver && !s.pendingChoice && guard++ < max) s = pass(s, reg);
  return s;
}

/** Fill a player's pool so cost payment is never what a test is measuring. */
function floodMana(state: GameState, player: PlayerId): void {
  const plenty = DECK_SIZE;
  state.players[player].manaPool = {
    W: plenty,
    U: plenty,
    B: plenty,
    R: plenty,
    G: plenty,
    C: plenty,
  };
}

let syntheticId = 93_000;

function instance(def: CardDefinition, player: PlayerId, zone: CardInstance['zone']): CardInstance {
  return {
    instanceId: syntheticId++,
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

/** A game sitting in the starting player's first main phase, hands cleared. */
function gameAtMain(reg: Registry, seed: number): GameState {
  const { state } = createGame({
    seed,
    startingPlayer: 'A',
    registry: reg,
    decks: { A: deck(ISLAND), B: deck(ISLAND) },
  });
  const s = advanceToStep(state, 'precombatMain', reg);
  s.players.A.hand = [];
  s.players.B.hand = [];
  return s;
}

function answer(state: GameState, reg: Registry, value: ChoiceAnswer): GameState {
  const choice = state.pendingChoice;
  if (!choice) throw new Error(`no choice pending:\n${dumpState(state)}`);
  return act(
    state,
    { kind: 'answerChoice', player: choice.chooser, choiceId: choice.id, answer: value },
    reg,
  );
}

/** Resolve the stack, answering each parked question with `reply`. */
function settle(
  state: GameState,
  reg: Registry,
  reply: (choice: PendingChoice, state: GameState) => ChoiceAnswer,
  max = 60,
): GameState {
  let s = state;
  let guard = 0;
  while ((s.stack.length > 0 || s.pendingChoice) && !s.gameOver && guard++ < max) {
    s = s.pendingChoice ? answer(s, reg, reply(s.pendingChoice, s)) : pass(s, reg);
  }
  if (guard >= max) throw new Error(`resolution did not settle:\n${dumpState(s)}`);
  return s;
}

/** Put `def` on the battlefield under `player`, already resolved. */
function putOnBattlefield(state: GameState, def: CardDefinition, player: PlayerId): CardInstance {
  const card = instance(def, player, 'battlefield');
  state.battlefield.push(card);
  return card;
}

/** Play `def` as a land from `player`'s hand and hand back the new permanent. */
function playLand(
  state: GameState,
  def: CardDefinition,
  player: PlayerId,
  reg: Registry,
): { state: GameState; land: CardInstance } {
  const card = instance(def, player, 'hand');
  state.players[player].hand.push(card);
  state.players[player].landsPlayedThisTurn = 0;
  const next = act(state, { kind: 'playLand', player, instanceId: card.instanceId }, reg);
  const land = next.battlefield.find((c) => c.instanceId === card.instanceId);
  if (!land) throw new Error(`land never reached the battlefield:\n${dumpState(next)}`);
  return { state: next, land };
}

// --- play: the enters-tapped cycles behave as printed -----------------------------

describe('enters-tapped templates — played in a real game', () => {
  it('a slowland enters TAPPED with one other land and UNTAPPED with two', () => {
    const reg = buildRegistry();
    const beach = compileCard(DESERTED_BEACH).definition;

    const early = gameAtMain(reg, SEEDS.slowland);
    putOnBattlefield(early, ISLAND, 'A');
    expect(playLand(early, beach, 'A', reg).land.tapped).toBe(true);

    const late = gameAtMain(reg, SEEDS.slowland);
    putOnBattlefield(late, ISLAND, 'A');
    putOnBattlefield(late, ISLAND, 'A');
    expect(playLand(late, beach, 'A', reg).land.tapped).toBe(false);
  });

  it("a slowland does not count the OPPONENT's lands", () => {
    const reg = buildRegistry();
    const beach = compileCard(DESERTED_BEACH).definition;
    const state = gameAtMain(reg, SEEDS.slowland);
    putOnBattlefield(state, ISLAND, 'B');
    putOnBattlefield(state, ISLAND, 'B');
    expect(playLand(state, beach, 'A', reg).land.tapped).toBe(true);
  });

  it('a battleland counts BASIC lands only — two nonbasic duals leave it tapped', () => {
    const reg = buildRegistry();
    const stream = compileCard(PRAIRIE_STREAM).definition;

    const withBasics = gameAtMain(reg, SEEDS.battleland);
    putOnBattlefield(withBasics, PLAINS, 'A');
    putOnBattlefield(withBasics, ISLAND, 'A');
    expect(playLand(withBasics, stream, 'A', reg).land.tapped).toBe(false);

    // Two more battlelands are lands with the same printed SUBTYPES and no
    // Basic supertype. The printed card does not count them, and neither do we.
    const withDuals = gameAtMain(reg, SEEDS.battleland);
    putOnBattlefield(withDuals, stream, 'A');
    putOnBattlefield(withDuals, stream, 'A');
    expect(playLand(withDuals, stream, 'A', reg).land.tapped).toBe(true);
  });

  it('a slowland that entered untapped taps for the mana it prints', () => {
    const reg = buildRegistry();
    const beach = compileCard(DESERTED_BEACH).definition;
    const state = gameAtMain(reg, SEEDS.slowland);
    putOnBattlefield(state, ISLAND, 'A');
    putOnBattlefield(state, ISLAND, 'A');
    const played = playLand(state, beach, 'A', reg);
    const after = act(
      played.state,
      { kind: 'tapForMana', player: 'A', instanceId: played.land.instanceId, mode: 0 },
      reg,
    );
    expect(after.players.A.manaPool.W).toBe(1);
    expect(after.players.A.manaPool.U).toBe(0);
  });
});

// --- "When ~ enters, you may ..." -------------------------------------------------

/** Farhaven Elf - an optional ETB whose body is a basic-land search. */
const FARHAVEN_ELF = makeCard({
  name: 'Farhaven Elf',
  typeLine: { supertypes: [], types: ['Creature'], subtypes: ['Elf', 'Druid'] },
  manaCost: { generic: 2, W: 0, U: 0, B: 0, R: 0, G: 1, C: 0, other: [] },
  power: 1,
  toughness: 1,
  oracleText:
    'When this creature enters, you may search your library for a basic land card, put it onto the battlefield tapped, then shuffle.',
});

/** Trinket Mage - the optional ETB plus a mana-value-bounded tutor to hand. */
const TRINKET_MAGE = makeCard({
  name: 'Trinket Mage',
  typeLine: { supertypes: [], types: ['Creature'], subtypes: ['Human', 'Wizard'] },
  manaCost: { generic: 2, W: 0, U: 1, B: 0, R: 0, G: 0, C: 0, other: [] },
  power: 2,
  toughness: 2,
  oracleText:
    'When this creature enters, you may search your library for an artifact card with mana value 1 or less, reveal that card, put it into your hand, then shuffle.',
});

/** Recruiter of the Guard - the same shape, bounded by printed TOUGHNESS. */
const RECRUITER_OF_THE_GUARD = makeCard({
  name: 'Recruiter of the Guard',
  typeLine: { supertypes: [], types: ['Creature'], subtypes: ['Human', 'Soldier'] },
  manaCost: { generic: 2, W: 1, U: 0, B: 0, R: 0, G: 0, C: 0, other: [] },
  power: 1,
  toughness: 1,
  oracleText:
    'When this creature enters, you may search your library for a creature card with toughness 2 or less, reveal it, put it into your hand, then shuffle.',
});

/** Goblin Matron - the same shape, narrowed by a printed SUBTYPE. */
const GOBLIN_MATRON = makeCard({
  name: 'Goblin Matron',
  typeLine: { supertypes: [], types: ['Creature'], subtypes: ['Goblin'] },
  manaCost: { generic: 2, W: 0, U: 0, B: 1, R: 0, G: 0, C: 0, other: [] },
  power: 1,
  toughness: 1,
  oracleText:
    'When this creature enters, you may search your library for a Goblin card, reveal that card, put it into your hand, then shuffle.',
});

describe('"When ~ enters, you may ..." - the optional ETB trigger', () => {
  it('compiles Farhaven Elf completely, with the search wrapped in a real question', () => {
    const result = compileCard(FARHAVEN_ELF);
    expect(result.status, JSON.stringify(result.missing)).toBe('complete');
    expect(result.definition.triggers).toHaveLength(1);
    const [trigger] = result.definition.triggers!;
    expect(trigger!.condition).toEqual({ on: 'etb' });
    expect(trigger!.effects).toEqual([
      {
        primitive: 'mayEffects',
        params: {
          prompt:
            'You may search your library for a basic land card, put it onto the battlefield tapped, then shuffle',
          valence: 'gain',
          effects: [
            {
              primitive: 'searchLibrary',
              params: {
                who: 'controller',
                count: 1,
                filter: { anyOfTypes: ['land'] },
                nameAnyOf: BASIC_LAND_NAMES,
                destination: 'battlefield',
                tapped: true,
              },
            },
          ],
        },
      },
    ]);
  });

  it('compiles Trinket Mage completely, keeping the printed mana-value bound', () => {
    const result = compileCard(TRINKET_MAGE);
    expect(result.status, JSON.stringify(result.missing)).toBe('complete');
    const inner = (result.definition.triggers![0]!.effects[0]!.params as { effects: unknown[] })
      .effects;
    expect(inner).toEqual([
      {
        primitive: 'searchLibrary',
        params: {
          who: 'controller',
          count: 1,
          filter: { anyOfTypes: ['artifact'], maxManaValue: 1 },
          destination: 'hand',
        },
      },
    ]);
  });

  it('compiles Recruiter of the Guard with a printed-TOUGHNESS bound', () => {
    const result = compileCard(RECRUITER_OF_THE_GUARD);
    expect(result.status, JSON.stringify(result.missing)).toBe('complete');
    const inner = (result.definition.triggers![0]!.effects[0]!.params as { effects: unknown[] })
      .effects as Array<{ params: { filter: unknown } }>;
    expect(inner[0]!.params.filter).toEqual({ anyOfTypes: ['creature'], maxToughness: 2 });
  });

  it('compiles Goblin Matron with the printed SUBTYPE, not a card type', () => {
    const result = compileCard(GOBLIN_MATRON);
    expect(result.status, JSON.stringify(result.missing)).toBe('complete');
    const inner = (result.definition.triggers![0]!.effects[0]!.params as { effects: unknown[] })
      .effects as Array<{ params: { filter: unknown } }>;
    expect(inner[0]!.params.filter).toEqual({ anyOfSubtypes: ['goblin'] });
  });

  it('leaves a body that implements its OWN "you may" on that rule (Eternal Witness)', () => {
    // The ordering invariant, pinned. "You may return target card from your
    // graveyard to your hand" is one question either way; compiling it as the
    // wrapper around a FORCED return would be two questions or a different card,
    // so the body rule that knows about `optional` must keep winning.
    const result = compileCard(
      makeCard({
        name: 'Eternal Witness',
        typeLine: { supertypes: [], types: ['Creature'], subtypes: ['Human', 'Shaman'] },
        manaCost: { generic: 1, W: 0, U: 0, B: 0, R: 0, G: 2, C: 0, other: [] },
        power: 2,
        toughness: 1,
        oracleText: 'When this creature enters, you may return target card from your graveyard to your hand.',
      }),
    );
    expect(result.status, JSON.stringify(result.missing)).toBe('complete');
    expect(result.definition.triggers![0]!.effects).toEqual([
      { primitive: 'returnFromGraveyard', params: { count: 1, optional: true } },
    ]);
  });

  it('REFUSES an optional ETB whose body it cannot implement', () => {
    const result = compileCard(
      makeCard({
        name: 'Test Mystery',
        typeLine: { supertypes: [], types: ['Creature'], subtypes: [] },
        power: 1,
        toughness: 1,
        oracleText: 'When this creature enters, you may proliferate twice.',
      }),
    );
    expect(result.status).toBe('incomplete');
    expect(result.definition.triggers).toBeUndefined();
  });

  it('REFUSES a tutor whose subtype is outside the closed table (never a tutor that finds nothing)', () => {
    const result = compileCard(
      makeCard({
        name: 'Test Zombie Matron',
        typeLine: { supertypes: [], types: ['Creature'], subtypes: [] },
        power: 1,
        toughness: 1,
        oracleText:
          'When this creature enters, you may search your library for a Zombie card, reveal that card, put it into your hand, then shuffle.',
      }),
    );
    expect(result.status).toBe('incomplete');
  });

  it('REFUSES a tutor whose numeric restriction it cannot express', () => {
    const result = compileCard(
      makeCard({
        name: 'Test Loyal Tutor',
        typeLine: { supertypes: [], types: ['Creature'], subtypes: [] },
        power: 1,
        toughness: 1,
        oracleText:
          'When this creature enters, you may search your library for a creature card with loyalty 3 or less, reveal it, put it into your hand, then shuffle.',
      }),
    );
    expect(result.status).toBe('incomplete');
  });
});

// --- play: the optional ETB, answered BOTH ways ----------------------------------

/** Cast `def` from A's hand with mana already flooded, and hand back the state. */
function castFromHand(
  state: GameState,
  def: CardDefinition,
  reg: Registry,
): { state: GameState; instanceId: number } {
  const card = instance(def, 'A', 'hand');
  state.players.A.hand.push(card);
  floodMana(state, 'A');
  const next = act(state, { kind: 'castSpell', player: 'A', instanceId: card.instanceId }, reg);
  return { state: next, instanceId: card.instanceId };
}

describe('"When ~ enters, you may ..." - played in a real game, both answers', () => {
  it('Farhaven Elf: saying YES puts a basic land onto the battlefield TAPPED', () => {
    const reg = buildRegistry();
    const elf = compileCard(FARHAVEN_ELF).definition;
    const state = gameAtMain(reg, SEEDS.farhaven);
    const cast = castFromHand(state, elf, reg);

    const settled = settle(cast.state, reg, (choice) =>
      choice.kind === 'confirm'
        ? { kind: 'confirm', yes: true }
        : { kind: 'selectCards', instanceIds: [(choice as { candidates: Array<{ instanceId: number; name: string }> }).candidates[0]!.instanceId] },
    );

    const lands = settled.battlefield.filter(
      (c) => c.controller === 'A' && c.def.types.includes('land'),
    );
    expect(lands).toHaveLength(1);
    expect(lands[0]!.tapped).toBe(true);
  });

  it('Farhaven Elf: saying NO puts NOTHING onto the battlefield - the elf still resolves', () => {
    // The half that silently breaks. A declined "you may" must leave the board
    // exactly as it was, and must not leave the trigger half-resolved.
    const reg = buildRegistry();
    const elf = compileCard(FARHAVEN_ELF).definition;
    const state = gameAtMain(reg, SEEDS.farhaven);
    const before = state.players.A.library.length;
    const cast = castFromHand(state, elf, reg);

    const settled = settle(cast.state, reg, () => ({ kind: 'confirm', yes: false }));

    expect(
      settled.battlefield.filter((c) => c.controller === 'A' && c.def.types.includes('land')),
    ).toHaveLength(0);
    // The creature itself is unaffected by the answer.
    expect(
      settled.battlefield.some((c) => c.controller === 'A' && c.def.name === 'Farhaven Elf'),
    ).toBe(true);
    // Declining searches nothing, so the library is untouched.
    expect(settled.players.A.library).toHaveLength(before);
    expect(settled.pendingChoice ?? undefined).toBeUndefined();
    expect(settled.stack).toHaveLength(0);
  });

  it('Trinket Mage: the search is offered only the cards the printed bound allows', () => {
    const reg = buildRegistry();
    const mage = compileCard(TRINKET_MAGE).definition;
    const state = gameAtMain(reg, SEEDS.creatureEtb);

    // A library holding one legal find and two illegal ones: a 3-mana artifact
    // (too expensive) and a 1-mana creature (not an artifact).
    const trinket: CardDefinition = {
      id: 'trinket',
      name: 'Test Trinket',
      types: ['artifact'],
      cost: { generic: 1 },
    };
    const bigArtifact: CardDefinition = {
      id: 'big',
      name: 'Test Big Artifact',
      types: ['artifact'],
      cost: { generic: 3 },
    };
    const cheapCreature: CardDefinition = {
      id: 'bear',
      name: 'Test Bear',
      types: ['creature'],
      cost: { G: 1 },
      power: 2,
      toughness: 2,
    };
    state.players.A.library = [
      instance(trinket, 'A', 'library'),
      instance(bigArtifact, 'A', 'library'),
      instance(cheapCreature, 'A', 'library'),
    ];

    const cast = castFromHand(state, mage, reg);
    let offered: readonly string[] = [];
    const settled = settle(cast.state, reg, (choice) => {
      if (choice.kind === 'confirm') return { kind: 'confirm', yes: true };
      offered = (choice as { candidates: Array<{ instanceId: number; name: string }> }).candidates.map((o) => o.name);
      return { kind: 'selectCards', instanceIds: [(choice as { candidates: Array<{ instanceId: number; name: string }> }).candidates[0]!.instanceId] };
    });

    expect(offered).toEqual(['Test Trinket']);
    expect(settled.players.A.hand.map((c) => c.def.name)).toContain('Test Trinket');
  });

  it('Recruiter of the Guard: the printed TOUGHNESS bound is what the search offers', () => {
    const reg = buildRegistry();
    const recruiter = compileCard(RECRUITER_OF_THE_GUARD).definition;
    const state = gameAtMain(reg, SEEDS.goblinMatron);

    const small: CardDefinition = {
      id: 'small',
      name: 'Test Small',
      types: ['creature'],
      cost: { W: 1 },
      power: 3,
      toughness: 2,
    };
    const big: CardDefinition = {
      id: 'bigcreature',
      name: 'Test Big',
      types: ['creature'],
      cost: { W: 1 },
      power: 1,
      toughness: 3,
    };
    // A card with no printed toughness box at all must not sneak in as a zero.
    const artifact: CardDefinition = {
      id: 'artifact',
      name: 'Test Artifact',
      types: ['artifact'],
      cost: { generic: 1 },
    };
    state.players.A.library = [
      instance(small, 'A', 'library'),
      instance(big, 'A', 'library'),
      instance(artifact, 'A', 'library'),
    ];

    const cast = castFromHand(state, recruiter, reg);
    let offered: readonly string[] = [];
    settle(cast.state, reg, (choice) => {
      if (choice.kind === 'confirm') return { kind: 'confirm', yes: true };
      offered = (choice as { candidates: Array<{ instanceId: number; name: string }> }).candidates.map((o) => o.name);
      return { kind: 'selectCards', instanceIds: [] };
    });

    expect(offered).toEqual(['Test Small']);
  });

  it('Goblin Matron: the SUBTYPE filter finds a Goblin and nothing else', () => {
    const reg = buildRegistry();
    const matron = compileCard(GOBLIN_MATRON).definition;
    const state = gameAtMain(reg, SEEDS.goblinMatron);

    const goblin: CardDefinition = {
      id: 'goblin',
      name: 'Test Goblin',
      types: ['creature'],
      subtypes: ['goblin'],
      cost: { R: 1 },
      power: 1,
      toughness: 1,
    };
    const elf: CardDefinition = {
      id: 'elf',
      name: 'Test Elf',
      types: ['creature'],
      subtypes: ['elf'],
      cost: { G: 1 },
      power: 1,
      toughness: 1,
    };
    state.players.A.library = [instance(goblin, 'A', 'library'), instance(elf, 'A', 'library')];

    const cast = castFromHand(state, matron, reg);
    let offered: readonly string[] = [];
    settle(cast.state, reg, (choice) => {
      if (choice.kind === 'confirm') return { kind: 'confirm', yes: true };
      offered = (choice as { candidates: Array<{ instanceId: number; name: string }> }).candidates.map((o) => o.name);
      return { kind: 'selectCards', instanceIds: [] };
    });

    expect(offered).toEqual(['Test Goblin']);
  });
});

// --- the reveal-land cycle, answered BOTH ways -----------------------------------

/** Port Town, printed exactly as Scryfall has it. */
const PORT_TOWN = makeCard({
  name: 'Port Town',
  typeLine: { supertypes: [], types: ['Land'], subtypes: [] },
  oracleText:
    "As this land enters, you may reveal a Plains or Island card from your hand. If you don't, this land enters tapped.\n{T}: Add {W} or {U}.",
});

describe('"As ~ enters, you may reveal ..." - the reveal-land cycle', () => {
  it('compiles Port Town completely, as a decision and not a board condition', () => {
    const result = compileCard(PORT_TOWN);
    expect(result.status, JSON.stringify(result.missing)).toBe('complete');
    expect(result.definition.entersTappedUnlessRevealed).toEqual({
      anyOfSubtypes: ['plains', 'island'],
    });
    // Not a board read: holding the card does not untap the land, showing it does.
    expect(result.definition.entersTappedUnless).toBeUndefined();
    expect(result.definition.entersTapped).toBeUndefined();
  });

  it('REFUSES a reveal of something that is not a land type', () => {
    const result = compileCard(
      makeCard({
        name: 'Test Reveal Land',
        typeLine: { supertypes: [], types: ['Land'], subtypes: [] },
        oracleText:
          "As this land enters, you may reveal a creature or artifact card from your hand. If you don't, this land enters tapped.",
      }),
    );
    expect(result.status).toBe('incomplete');
  });

  it('enters TAPPED on any path that cannot ask - the printed "if you don\'t"', () => {
    // The engine-level default. A path with no question (a token, a fixture with
    // no board) must get the unpaid outcome, never a free untapped land.
    const town = compileCard(PORT_TOWN).definition;
    expect(entersTapped(town)).toBe(true);
    expect(entersTapped(town, { controller: 'A', battlefield: [] })).toBe(true);
  });

  it('revealing (YES) leaves the land UNTAPPED and ready to tap for mana', () => {
    const reg = buildRegistry();
    const town = compileCard(PORT_TOWN).definition;
    const state = gameAtMain(reg, SEEDS.endStep);
    // A Plains in hand is what makes the question legal to ask at all.
    state.players.A.hand.push(instance(PLAINS, 'A', 'hand'));

    const played = playLand(state, town, 'A', reg);
    expect(played.state.pendingChoice?.kind).toBe('confirm');

    const answered = answer(played.state, reg, { kind: 'confirm', yes: true });
    const land = answered.battlefield.find((c) => c.instanceId === played.land.instanceId);
    expect(land!.tapped).toBe(false);
    // The reveal shows a card; it never moves one.
    expect(answered.players.A.hand).toHaveLength(1);

    const tapped = act(
      answered,
      { kind: 'tapForMana', player: 'A', instanceId: played.land.instanceId, mode: 0 },
      reg,
    );
    expect(tapped.players.A.manaPool.W).toBe(1);
  });

  it('DECLINING taps the land - the half that silently breaks', () => {
    const reg = buildRegistry();
    const town = compileCard(PORT_TOWN).definition;
    const state = gameAtMain(reg, SEEDS.endStep);
    state.players.A.hand.push(instance(PLAINS, 'A', 'hand'));

    const played = playLand(state, town, 'A', reg);
    const answered = answer(played.state, reg, { kind: 'confirm', yes: false });
    const land = answered.battlefield.find((c) => c.instanceId === played.land.instanceId);
    expect(land!.tapped).toBe(true);
    expect(answered.pendingChoice ?? undefined).toBeUndefined();
    // The land play never surrendered priority, so its player still has it.
    expect(answered.priorityPlayer).toBe('A');
  });

  it('a controller with nothing to reveal is NOT asked, and the land enters tapped', () => {
    // The question would have exactly one possible outcome, so raising it would
    // stop the game for an answer that cannot matter.
    const reg = buildRegistry();
    const town = compileCard(PORT_TOWN).definition;
    const state = gameAtMain(reg, SEEDS.endStep);
    state.players.A.hand.push(instance(FOREST, 'A', 'hand'));

    const played = playLand(state, town, 'A', reg);
    expect(played.state.pendingChoice ?? undefined).toBeUndefined();
    expect(played.land.tapped).toBe(true);
  });

  it('accepts a DUAL land as the reveal, exactly as the printed subtypes say', () => {
    // "Reveal a Plains or Island card" means a card with that land TYPE - a dual
    // printing Plains qualifies. Matching by name would have missed it.
    const reg = buildRegistry();
    const town = compileCard(PORT_TOWN).definition;
    const dual: CardDefinition = {
      id: 'dual',
      name: 'Test Hallowed Fountain',
      types: ['land'],
      subtypes: ['plains', 'island'],
      producesOptions: [{ W: 1 }, { U: 1 }],
    };
    const state = gameAtMain(reg, SEEDS.endStep);
    state.players.A.hand.push(instance(dual, 'A', 'hand'));

    const played = playLand(state, town, 'A', reg);
    expect(played.state.pendingChoice?.kind).toBe('confirm');
  });
});

// --- "At the beginning of your <step>" -------------------------------------------

/** Wilderness Reclamation - an end-step trigger that untaps a whole type. */
const WILDERNESS_RECLAMATION = makeCard({
  name: 'Wilderness Reclamation',
  typeLine: { supertypes: [], types: ['Enchantment'], subtypes: [] },
  manaCost: { generic: 3, W: 0, U: 0, B: 0, R: 0, G: 1, C: 0, other: [] },
  oracleText: 'At the beginning of your end step, untap all lands you control.',
});

/** Unstoppable Plan - the same trigger, the NONLAND permanents. */
const UNSTOPPABLE_PLAN = makeCard({
  name: 'Unstoppable Plan',
  typeLine: { supertypes: [], types: ['Enchantment'], subtypes: [] },
  manaCost: { generic: 3, W: 0, U: 1, B: 0, R: 0, G: 0, other: [], C: 0 },
  oracleText: 'At the beginning of your end step, untap all nonland permanents you control.',
});

/** Hulking Raptor - a first-main-phase trigger that adds mana. */
const HULKING_RAPTOR = makeCard({
  name: 'Hulking Raptor',
  typeLine: { supertypes: [], types: ['Creature'], subtypes: ['Dinosaur'] },
  manaCost: { generic: 3, W: 0, U: 0, B: 0, R: 0, G: 1, C: 0, other: [] },
  power: 4,
  toughness: 5,
  oracleText: 'Ward {2}\nAt the beginning of your first main phase, add {G}{G}.',
});

describe('"At the beginning of your <step>" - the step-trigger family', () => {
  it('compiles Wilderness Reclamation completely, on an END STEP trigger', () => {
    const result = compileCard(WILDERNESS_RECLAMATION);
    expect(result.status, JSON.stringify(result.missing)).toBe('complete');
    expect(result.definition.triggers).toHaveLength(1);
    expect(result.definition.triggers![0]!.condition).toEqual({ on: 'endStep', who: 'you' });
    expect(result.definition.triggers![0]!.effects).toEqual([
      { primitive: 'tapPermanents', params: { who: 'controller', untap: true, types: ['land'] } },
    ]);
  });

  it('compiles Unstoppable Plan with "nonland" written as an EXCLUSION', () => {
    const result = compileCard(UNSTOPPABLE_PLAN);
    expect(result.status, JSON.stringify(result.missing)).toBe('complete');
    expect(result.definition.triggers![0]!.effects[0]!.params).toEqual({
      who: 'controller',
      untap: true,
      types: ['land', 'creature', 'artifact', 'enchantment', 'planeswalker', 'battle'],
      excludeTypes: ['land'],
    });
  });

  it('compiles Hulking Raptor on a FIRST MAIN PHASE trigger', () => {
    const result = compileCard(HULKING_RAPTOR);
    expect(result.status, JSON.stringify(result.missing)).toBe('complete');
    expect(result.definition.triggers![0]!.condition).toEqual({
      on: 'precombatMain',
      who: 'you',
    });
  });

  it('compiles "each player\'s" and aims the body at the TRIGGERING player', () => {
    // This used to be a refusal. A `who: 'any'` trigger fires on both turns but
    // resolves under the SOURCE's controller, so "that player draws an
    // additional card" drew for the wrong seat half the time — a different card,
    // so the rule reported instead. The triggering player now rides the stack
    // object into `EffectContext.triggeringPlayer`, and the body says so with
    // `whichPlayer: 'triggering'`; the play test in `step-trigger-templates`
    // proves both seats really draw on their own turns.
    const result = compileCard(
      makeCard({
        name: 'Kami of the Crescent Moon',
        typeLine: { supertypes: [], types: ['Creature'], subtypes: ['Spirit'] },
        power: 1,
        toughness: 3,
        oracleText: "At the beginning of each player's draw step, that player draws an additional card.",
      }),
    );
    expect(result.status, JSON.stringify(result.missing)).toBe('complete');
    expect(result.definition.triggers![0]!.condition).toEqual({ on: 'drawStep', who: 'any' });
    expect(result.definition.triggers![0]!.effects).toEqual([
      { primitive: 'drawCards', params: { count: 1, whichPlayer: 'triggering' } },
    ]);
  });

  it('REFUSES a step the engine has no trigger for', () => {
    const result = compileCard(
      makeCard({
        name: 'Test Untapper',
        typeLine: { supertypes: [], types: ['Enchantment'], subtypes: [] },
        oracleText: 'At the beginning of your untap step, untap all lands you control.',
      }),
    );
    expect(result.status).toBe('incomplete');
  });

  it('untaps at the END STEP in a real game, and only the controller\'s lands', () => {
    const reg = buildRegistry();
    const reclamation = compileCard(WILDERNESS_RECLAMATION).definition;
    const state = gameAtMain(reg, SEEDS.endStep);

    putOnBattlefield(state, reclamation, 'A');
    const mine = putOnBattlefield(state, ISLAND, 'A');
    const theirs = putOnBattlefield(state, ISLAND, 'B');
    const myCreature = putOnBattlefield(state, FOREST, 'A');
    mine.tapped = true;
    theirs.tapped = true;
    myCreature.tapped = true;

    const atEnd = settle(advanceToStep(state, 'end', reg), reg, () => ({
      kind: 'confirm',
      yes: true,
    }));

    const after = (id: number): boolean =>
      atEnd.battlefield.find((c) => c.instanceId === id)!.tapped;
    expect(after(mine.instanceId)).toBe(false);
    expect(after(myCreature.instanceId)).toBe(false);
    // The printed line says "you control" - the opponent's land is untouched.
    expect(after(theirs.instanceId)).toBe(true);
  });
});

// --- "Whenever a creature you control enters / dies" ------------------------------

/** Ajani's Welcome - the plainest board-watching trigger there is. */
const AJANIS_WELCOME = makeCard({
  name: "Ajani's Welcome",
  typeLine: { supertypes: [], types: ['Enchantment'], subtypes: [] },
  manaCost: { generic: 0, W: 1, U: 0, B: 0, R: 0, G: 0, C: 0, other: [] },
  oracleText: 'Whenever a creature you control enters, you gain 1 life.',
});

/** Elemental Bond - the same trigger with a printed POWER restriction. */
const ELEMENTAL_BOND = makeCard({
  name: 'Elemental Bond',
  typeLine: { supertypes: [], types: ['Enchantment'], subtypes: [] },
  manaCost: { generic: 2, W: 0, U: 0, B: 0, R: 0, G: 1, C: 0, other: [] },
  oracleText: 'Whenever a creature you control with power 3 or greater enters, draw a card.',
});

describe('"Whenever a creature you control enters/dies" - board-watching triggers', () => {
  it("compiles Ajani's Welcome completely", () => {
    const result = compileCard(AJANIS_WELCOME);
    expect(result.status, JSON.stringify(result.missing)).toBe('complete');
    expect(result.definition.triggers![0]!.condition).toEqual({
      on: 'permanentEnters',
      who: 'you',
      permanentFilter: { anyOfTypes: ['creature'] },
    });
  });

  it('compiles Elemental Bond with the printed POWER bound on the trigger', () => {
    const result = compileCard(ELEMENTAL_BOND);
    expect(result.status, JSON.stringify(result.missing)).toBe('complete');
    expect(result.definition.triggers![0]!.condition).toEqual({
      on: 'permanentEnters',
      who: 'you',
      permanentFilter: { anyOfTypes: ['creature'], minPower: 3 },
    });
  });

  it('compiles "ANOTHER creature you control" with the self-exclusion flag', () => {
    // This line used to report, because the condition had no way to say "not
    // me" and a source triggering off its own entry is a different card. The
    // counters branch added `excludeSelf` for exactly that word, so the printed
    // restriction is now carried rather than refused.
    const result = compileCard(
      makeCard({
        name: 'Test Another Watcher',
        typeLine: { supertypes: [], types: ['Creature'], subtypes: [] },
        power: 2,
        toughness: 2,
        oracleText: 'Whenever another creature you control enters, you gain 1 life.',
      }),
    );
    expect(result.status, JSON.stringify(result.missing)).toBe('complete');
    expect(result.definition.triggers![0]!.condition).toEqual({
      on: 'permanentEnters',
      who: 'you',
      permanentFilter: { anyOfTypes: ['creature'] },
      excludeSelf: true,
    });
  });

  it("Ajani's Welcome gains life for YOUR creature and not the opponent's", () => {
    const reg = buildRegistry();
    const welcome = compileCard(AJANIS_WELCOME).definition;
    const bear: CardDefinition = {
      id: 'plainbear',
      name: 'Test Bear',
      types: ['creature'],
      cost: { G: 1 },
      power: 2,
      toughness: 2,
    };

    const state = gameAtMain(reg, SEEDS.creatureEtb);
    putOnBattlefield(state, welcome, 'A');
    const before = state.players.A.life;

    const mine = instance(bear, 'A', 'hand');
    state.players.A.hand.push(mine);
    floodMana(state, 'A');
    const afterMine = settle(
      act(state, { kind: 'castSpell', player: 'A', instanceId: mine.instanceId }, reg),
      reg,
      () => ({ kind: 'confirm', yes: true }),
    );
    expect(afterMine.players.A.life).toBe(before + 1);

    // The opponent's creature entering is not "a creature you control".
    const theirs = instance(bear, 'B', 'battlefield');
    afterMine.battlefield.push(theirs);
    const lifeAfterTheirs = settle(afterMine, reg, () => ({ kind: 'confirm', yes: true }));
    expect(lifeAfterTheirs.players.A.life).toBe(before + 1);
  });

  it('Elemental Bond fires only for a creature big enough, exactly as printed', () => {
    const reg = buildRegistry();
    const bond = compileCard(ELEMENTAL_BOND).definition;
    const small: CardDefinition = {
      id: 'smallbear',
      name: 'Test Small',
      types: ['creature'],
      cost: { G: 1 },
      power: 2,
      toughness: 2,
    };
    const big: CardDefinition = {
      id: 'bigbear',
      name: 'Test Big',
      types: ['creature'],
      cost: { G: 1 },
      power: 3,
      toughness: 3,
    };

    const play = (def: CardDefinition): number => {
      const state = gameAtMain(reg, SEEDS.drawStep);
      putOnBattlefield(state, bond, 'A');
      const before = state.players.A.hand.length;
      const card = instance(def, 'A', 'hand');
      state.players.A.hand.push(card);
      floodMana(state, 'A');
      const settled = settle(
        act(state, { kind: 'castSpell', player: 'A', instanceId: card.instanceId }, reg),
        reg,
        () => ({ kind: 'confirm', yes: true }),
      );
      return settled.players.A.hand.length - before;
    };

    expect(play(small)).toBe(0);
    expect(play(big)).toBe(1);
  });
});

// --- the death-trigger bodies -----------------------------------------------------

/** Kill `victim` with a real Lightning Bolt cast by A, so the death is genuine. */
function bolt(state: GameState, victim: number, reg: Registry): GameState {
  const card = instance(BOLT, 'A', 'hand');
  state.players.A.hand.push(card);
  floodMana(state, 'A');
  return act(
    state,
    { kind: 'castSpell', player: 'A', instanceId: card.instanceId, targets: [victim] },
    reg,
  );
}

/** Dictate of Erebos - an untargeted edict on every creature death you suffer. */
const DICTATE_OF_EREBOS = makeCard({
  name: 'Dictate of Erebos',
  typeLine: { supertypes: [], types: ['Enchantment'], subtypes: [] },
  manaCost: { generic: 3, W: 0, U: 0, B: 2, R: 0, G: 0, C: 0, other: [] },
  oracleText:
    'Flash\nWhenever a creature you control dies, each opponent sacrifices a creature of their choice.',
});

/** Moldervine Reclamation - the compound body one sentence cannot be split into. */
const MOLDERVINE_RECLAMATION = makeCard({
  name: 'Moldervine Reclamation',
  typeLine: { supertypes: [], types: ['Enchantment'], subtypes: [] },
  manaCost: { generic: 2, W: 0, U: 0, B: 1, R: 0, G: 1, C: 0, other: [] },
  oracleText: 'Whenever a creature you control dies, you gain 1 life and draw a card.',
});

describe('death triggers - the bodies they print', () => {
  it('compiles Dictate of Erebos completely, as an UNTARGETED sacrifice', () => {
    const result = compileCard(DICTATE_OF_EREBOS);
    expect(result.status, JSON.stringify(result.missing)).toBe('complete');
    expect(result.definition.triggers![0]!.condition.on).toBe('permanentDies');
    expect(result.definition.triggers![0]!.effects).toEqual([
      {
        primitive: 'sacrificeChosen',
        params: { who: 'opponent', filter: { anyOfTypes: ['creature'] } },
      },
    ]);
    // Untargeted: a trigger body has no chosen target to read.
    expect(result.definition.triggers![0]!.targets).toBeUndefined();
  });

  it('compiles Moldervine Reclamation completely (gain life AND draw)', () => {
    const result = compileCard(MOLDERVINE_RECLAMATION);
    expect(result.status, JSON.stringify(result.missing)).toBe('complete');
    expect(result.definition.triggers![0]!.effects).toEqual([
      { primitive: 'gainLife', params: { amount: 1 } },
      { primitive: 'drawCards', params: { count: 1 } },
    ]);
  });

  it('a creature DEATH fires it, and an exile does not', () => {
    const reg = buildRegistry();
    const reclamation = compileCard(MOLDERVINE_RECLAMATION).definition;
    const bear: CardDefinition = {
      id: 'dyingbear',
      name: 'Test Bear',
      types: ['creature'],
      cost: { G: 1 },
      power: 2,
      toughness: 2,
    };

    const state = gameAtMain(reg, SEEDS.combatDamage);
    putOnBattlefield(state, reclamation, 'A');
    const victim = putOnBattlefield(state, bear, 'A');
    const life = state.players.A.life;
    const hand = state.players.A.hand.length;

    // Killed by a real removal spell, so the death arrives through the same
    // path a game produces: damage, state-based actions, the move to the yard.
    const settled = settle(bolt(state, victim.instanceId, reg), reg, () => ({
      kind: 'confirm',
      yes: true,
    }));
    expect(settled.players.A.life).toBe(life + 1);
    // One card drawn by the trigger; the Bolt itself came from nowhere.
    expect(settled.players.A.hand).toHaveLength(hand + 1);
  });

  it("does NOT fire on the opponent's creature dying", () => {
    const reg = buildRegistry();
    const reclamation = compileCard(MOLDERVINE_RECLAMATION).definition;
    const bear: CardDefinition = {
      id: 'theirbear',
      name: 'Test Bear',
      types: ['creature'],
      cost: { G: 1 },
      power: 2,
      toughness: 2,
    };

    const state = gameAtMain(reg, SEEDS.combatDamage);
    putOnBattlefield(state, reclamation, 'A');
    const victim = putOnBattlefield(state, bear, 'B');
    const life = state.players.A.life;

    const settled = settle(bolt(state, victim.instanceId, reg), reg, () => ({
      kind: 'confirm',
      yes: true,
    }));
    expect(settled.players.A.life).toBe(life);
  });
});
