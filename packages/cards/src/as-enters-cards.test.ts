/**
 * **"As ~ enters, choose a…"** from printed Oracle text to the table.
 *
 * The compiler half plus the composition that would silently cheat if it were
 * missed: a permanent SPELL naming its value mid-resolution, before it is on the
 * battlefield, and then its own static reading that value back on the next turn.
 *
 * What is deliberately pinned here rather than left to a reviewer's eye:
 *  1. **A card that READS a chosen value but never NAMES one does not compile.**
 *     "Creatures you control of the chosen type get +1/+1" printed on a card
 *     with no "As ~ enters, choose…" line is an anthem over a value nothing ever
 *     writes: it would report `'complete'` and then do nothing. It reports.
 *  2. **A permanent spell asks on the way in**, and the answer is on the
 *     permanent when the spell finishes resolving — the same moment "enters with
 *     N +1/+1 counters" applies.
 *  3. **A lord that named a type IS that type**, so a second lord sees the
 *     first. That is the whole reason the subtype read is instance-aware.
 *  4. **A cast trigger narrowed by the named type fires on that type and no
 *     other** — the chosen value read by a THIRD kind of consumer.
 */

import { describe, expect, it } from 'vitest';
import type {
  CardDefinition,
  CardInstance,
  ChoiceAnswer,
  ChooseValueChoice,
  GameAction,
  GameState,
  PlayerId,
} from '@jonny-boi/core';
import {
  applyAction,
  createGame,
  DEFAULT_RULES,
  dumpState,
  effectivePower,
  indexContinuous,
} from '@jonny-boi/core';
import { compileCard } from './compile/compile.js';
import type { CompilableCard } from './compile/types.js';
import { buildRegistry } from './pool.js';
import { CARD_POOL } from '../data/pool.js';

type Registry = ReturnType<typeof buildRegistry>;

const SEED = 6142026;
const DECK_SIZE = 40;

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

/** Adaptive Automaton, with its real Oracle text. */
const ADAPTIVE_AUTOMATON_SCRYFALL = makeCard({
  name: 'Adaptive Automaton',
  manaCost: { generic: 3, W: 0, U: 0, B: 0, R: 0, G: 0, C: 0, other: [] },
  typeLine: { supertypes: [], types: ['Artifact', 'Creature'], subtypes: ['Construct'] },
  power: 2,
  toughness: 2,
  oracleText:
    'As this creature enters, choose a creature type.\nThis creature is the chosen type in addition to its other types.\nOther creatures you control of the chosen type get +1/+1.',
});

/** Coldsteel Heart — enters tapped, names a colour, taps for it. */
const COLDSTEEL_HEART_SCRYFALL = makeCard({
  name: 'Coldsteel Heart',
  manaCost: { generic: 2, W: 0, U: 0, B: 0, R: 0, G: 0, C: 0, other: [] },
  typeLine: { supertypes: [], types: ['Artifact'], subtypes: [] },
  oracleText:
    'This artifact enters tapped.\nAs this artifact enters, choose a color.\n{T}: Add one mana of the chosen color.',
});

/** Chronicle of Victory — an anthem AND a cast trigger, both narrowed by the naming. */
const CHRONICLE_SCRYFALL = makeCard({
  name: 'Chronicle of Victory',
  manaCost: { generic: 3, W: 1, U: 0, B: 0, R: 0, G: 0, C: 0, other: [] },
  typeLine: { supertypes: [], types: ['Enchantment'], subtypes: [] },
  oracleText:
    'As Chronicle of Victory enters, choose a creature type.\nCreatures you control of the chosen type get +2/+2 and have first strike and trample.\nWhenever you cast a spell of the chosen type, draw a card.',
});

describe('compiling the naming and its readers', () => {
  it('compiles Adaptive Automaton completely — the naming, the type line and the anthem', () => {
    const result = compileCard(ADAPTIVE_AUTOMATON_SCRYFALL);
    expect(result.status, JSON.stringify(result.missing)).toBe('complete');
    expect(result.definition.asEntersChoice).toEqual({ subject: 'creatureType' });
    expect(result.definition.isChosenSubtype).toBe(true);
    expect(result.definition.statics?.[0]?.affects).toMatchObject({
      ofChosenSubtype: true,
      excludeSource: true,
      controller: 'you',
    });
    // A non-land permanent asks during its own RESOLUTION, so the naming is the
    // first thing its script does.
    expect(result.definition.effects?.[0]?.primitive).toBe('chooseAsEnters');
  });

  it('compiles Coldsteel Heart, whose mana ability is the reader', () => {
    const result = compileCard(COLDSTEEL_HEART_SCRYFALL);
    expect(result.status, JSON.stringify(result.missing)).toBe('complete');
    expect(result.definition.entersTapped).toBe(true);
    expect(result.definition.manaAbilities).toEqual([
      { chosenColor: true, label: 'Add one mana of the chosen color' },
    ]);
  });

  it('compiles Chronicle of Victory, whose cast trigger is the reader', () => {
    const result = compileCard(CHRONICLE_SCRYFALL);
    expect(result.status, JSON.stringify(result.missing)).toBe('complete');
    expect(result.definition.triggers?.[0]?.condition).toMatchObject({
      on: 'castSpell',
      who: 'you',
      spellSubtypeIsChosen: true,
    });
  });

  it('a LAND names through the engine, so it gets NO resolution script', () => {
    // A land is played, never cast: its `effects` never run, and prepending the
    // primitive would be an ability nothing could ever reach.
    const result = compileCard(
      makeCard({
        name: 'Naming Land',
        typeLine: { supertypes: [], types: ['Land'], subtypes: [] },
        oracleText: 'As Naming Land enters, choose a color.\n{T}: Add one mana of the chosen color.',
      }),
    );
    expect(result.status, JSON.stringify(result.missing)).toBe('complete');
    expect(result.definition.asEntersChoice).toEqual({ subject: 'color' });
    expect(result.definition.effects).toBeUndefined();
  });

  it('REFUSES a reader with no naming — the half-card this contract exists to prevent', () => {
    const anthem = compileCard(
      makeCard({
        name: 'Orphan Lord',
        manaCost: { generic: 2, W: 0, U: 0, B: 0, R: 0, G: 0, C: 0, other: [] },
        typeLine: { supertypes: [], types: ['Enchantment'], subtypes: [] },
        oracleText: 'Creatures you control of the chosen type get +1/+1.',
      }),
    );
    expect(anthem.status).toBe('incomplete');
    expect(anthem.definition.statics ?? []).toEqual([]);

    const mana = compileCard(
      makeCard({
        name: 'Orphan Rock',
        typeLine: { supertypes: [], types: ['Artifact'], subtypes: [] },
        oracleText: '{T}: Add one mana of the chosen color.',
      }),
    );
    expect(mana.status).toBe('incomplete');
    expect(mana.definition.manaAbilities ?? []).toEqual([]);
  });

  it('reads "creatures OF THE CHOSEN COLOR" as the SYMMETRIC anthem it is printed as', () => {
    // Gauntlet of Power pumps the opponent's team too. Reading it as friendly
    // would be a strictly better card than the one printed.
    const result = compileCard(
      makeCard({
        name: 'Gauntleted',
        typeLine: { supertypes: [], types: ['Artifact'], subtypes: [] },
        oracleText:
          'As Gauntleted enters, choose a color.\nCreatures of the chosen color get +1/+1.',
      }),
    );
    expect(result.status, JSON.stringify(result.missing)).toBe('complete');
    expect(result.definition.statics?.[0]?.affects).toMatchObject({
      ofChosenColor: true,
      controller: 'any',
    });
  });
});

// --- the play composition -------------------------------------------------------------

const ADAPTIVE_AUTOMATON: CardDefinition = compileCard(ADAPTIVE_AUTOMATON_SCRYFALL).definition;
const CHRONICLE: CardDefinition = compileCard(CHRONICLE_SCRYFALL).definition;

function poolCard(name: string): CardDefinition {
  const card = CARD_POOL.find((c) => c.name === name);
  if (!card) throw new Error(`pool missing ${name}`);
  return card;
}

const PLAINS = poolCard('Plains');

/** A Goblin and a non-Goblin, so an anthem's reach can be told from its absence. */
const GOBLIN: CardDefinition = {
  id: 'test:Goblin Piker',
  name: 'Goblin Piker',
  types: ['creature'],
  subtypes: ['goblin'],
  power: 2,
  toughness: 1,
  cost: { generic: 2 },
};
const ELF: CardDefinition = { ...GOBLIN, id: 'test:Elf', name: 'Llanowar Elf', subtypes: ['elf'], power: 1 };

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

let syntheticId = 91_500;

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

function answer(state: GameState, reg: Registry, value: ChoiceAnswer): GameState {
  const choice = state.pendingChoice;
  if (!choice) throw new Error(`no choice pending:\n${dumpState(state)}`);
  return act(state, { kind: 'answerChoice', player: choice.chooser, choiceId: choice.id, answer: value }, reg);
}

/**
 * A game at A's first main phase, both hands emptied, with enough lands out to
 * cast.
 *
 * A's deck carries a few Goblins and Elves on purpose: the creature-type MENU is
 * derived from the chooser's own cards, so a deck of nothing but Plains offers
 * no creature type at all and the naming settles to "nothing" without ever
 * asking — which is correct behaviour and would make these tests pass for the
 * wrong reason.
 */
function board(reg: Registry, lands: number): GameState {
  const tribalDeck = [
    ...Array.from({ length: 4 }, () => GOBLIN),
    ...Array.from({ length: 4 }, () => ELF),
    ...Array.from({ length: DECK_SIZE - 8 }, () => PLAINS),
  ];
  const { state: created } = createGame({
    seed: SEED,
    startingPlayer: 'A',
    registry: reg,
    decks: {
      A: { cards: tribalDeck },
      B: { cards: Array.from({ length: DECK_SIZE }, () => PLAINS) },
    },
  });
  let state = created;
  let guard = 0;
  while (state.step !== 'precombatMain' && !state.gameOver && guard++ < 50) state = pass(state, reg);
  state.players.A.hand = [];
  state.players.B.hand = [];
  for (let i = 0; i < lands; i++) {
    const land = instance(PLAINS, 'A', 'battlefield');
    land.summoningSick = false;
    state.battlefield.push(land);
  }
  return state;
}

/** Tap every untapped Plains A controls, so a spell can be paid for. */
function tapAllLands(state: GameState, reg: Registry): GameState {
  let next = state;
  for (const land of [...next.battlefield]) {
    if (land.controller !== 'A' || land.tapped || !land.def.types.includes('land')) continue;
    next = act(next, { kind: 'tapForMana', player: 'A', instanceId: land.instanceId, mode: 0 }, reg);
  }
  return next;
}

/** Cast `def` from A's hand and let it resolve (both players pass). */
function castAndResolve(state: GameState, reg: Registry, def: CardDefinition): GameState {
  const spell = instance(def, 'A', 'hand');
  state.players.A.hand.push(spell);
  let next = tapAllLands(state, reg);
  next = act(next, { kind: 'castSpell', player: 'A', instanceId: spell.instanceId }, reg);
  // Both pass so the spell resolves; the naming is asked DURING that resolution.
  next = pass(next, reg);
  next = pass(next, reg);
  return next;
}

function powerOf(state: GameState, name: string): number {
  const perm = state.battlefield.find((c) => c.def.name === name);
  if (!perm) throw new Error(`${name} is not on the battlefield\n${dumpState(state)}`);
  return effectivePower(perm, indexContinuous(state).get(perm.instanceId));
}

describe('a permanent spell naming a value as it resolves', () => {
  it('asks mid-resolution, and the anthem reaches exactly the named type', () => {
    const reg = buildRegistry([...CARD_POOL, ADAPTIVE_AUTOMATON, GOBLIN, ELF]);
    let state = board(reg, 4);
    const goblin = instance(GOBLIN, 'A', 'battlefield');
    const elf = instance(ELF, 'A', 'battlefield');
    state.battlefield.push(goblin, elf);

    state = castAndResolve(state, reg, ADAPTIVE_AUTOMATON);
    const naming = state.pendingChoice as ChooseValueChoice | null;
    expect(naming?.kind).toBe('chooseValue');
    expect(naming?.subject).toBe('creatureType');
    // The menu is built from the game: both creature types on the board are on it.
    expect(naming?.options.map((o) => o.value.toLowerCase())).toEqual(
      expect.arrayContaining(['goblin', 'elf']),
    );

    state = answer(state, reg, { kind: 'chooseValue', value: 'goblin' });
    const lord = state.battlefield.find((c) => c.def.name === 'Adaptive Automaton');
    expect(lord?.chosenAsEntered).toBe('goblin');
    // The anthem reaches the Goblin and not the Elf…
    expect(powerOf(state, 'Goblin Piker')).toBe(3);
    expect(powerOf(state, 'Llanowar Elf')).toBe(1);
    // …and not the lord itself, because the card says "OTHER".
    expect(powerOf(state, 'Adaptive Automaton')).toBe(2);
  });

  it('a lord that named a type IS that type, so a second lord pumps the first', () => {
    const reg = buildRegistry([...CARD_POOL, ADAPTIVE_AUTOMATON, GOBLIN]);
    let state = board(reg, 8);
    state = castAndResolve(state, reg, ADAPTIVE_AUTOMATON);
    state = answer(state, reg, { kind: 'chooseValue', value: 'goblin' });
    const first = state.battlefield.find((c) => c.def.name === 'Adaptive Automaton');

    state = castAndResolve(state, reg, ADAPTIVE_AUTOMATON);
    state = answer(state, reg, { kind: 'chooseValue', value: 'goblin' });

    // The FIRST automaton is a Goblin (it named one), so the second's anthem —
    // which excludes only itself — reaches it.
    const index = indexContinuous(state);
    expect(effectivePower(first!, index.get(first!.instanceId))).toBe(3);
  });

  it('a cast trigger narrowed by the named type fires on that type and no other', () => {
    const reg = buildRegistry([...CARD_POOL, CHRONICLE, GOBLIN, ELF]);
    let state = board(reg, 12);
    state = castAndResolve(state, reg, CHRONICLE);
    state = answer(state, reg, { kind: 'chooseValue', value: 'goblin' });

    const before = state.players.A.hand.length;
    state = castAndResolve(state, reg, ELF);
    // Casting an Elf triggers nothing…
    expect(state.players.A.hand.length).toBe(before);

    state = castAndResolve(state, reg, GOBLIN);
    // …and casting a Goblin draws a card. (Resolving the draw needs the trigger
    // to go on the stack and resolve, which the two passes above cover.)
    expect(state.players.A.hand.length).toBe(before + 1);
  });
});
