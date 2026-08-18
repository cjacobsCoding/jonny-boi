/**
 * SHOCKLANDS from printed text to the table — the compiler half, and the one
 * composition that would silently cheat if it were missed: a FETCHLAND finding a
 * shockland mid-resolution.
 *
 * The fetch path matters because it does not go through `applyPlayLand`: the
 * land is put onto the battlefield by an effect, inside a resolution frame. The
 * shock question is asked there through the ordinary `ctx` channel, and the
 * definition's own `entersTapped` answer is the unpaid default — so a fetch that
 * forgot to ask would put the land in TAPPED, never untapped-for-free. These
 * tests pin both directions.
 */

import { describe, expect, it } from 'vitest';
import type {
  CardDefinition,
  CardInstance,
  ChoiceAnswer,
  GameAction,
  GameState,
  PayLifeChoice,
  PlayerId,
} from '@jonny-boi/core';
import { applyAction, createGame, DEFAULT_RULES, dumpState } from '@jonny-boi/core';
import { compileCard } from './compile/compile.js';
import type { CompilableCard } from './compile/types.js';
import { buildRegistry } from './pool.js';
import { CARD_POOL } from '../data/pool.js';

type Registry = ReturnType<typeof buildRegistry>;

const SEED = 2026;
const DECK_SIZE = 40;
const SHOCK_LIFE = 2;

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

/** Blood Crypt with its real modern Oracle text. */
const BLOOD_CRYPT_SCRYFALL = makeCard({
  name: 'Blood Crypt',
  typeLine: { supertypes: [], types: ['Land'], subtypes: ['Swamp', 'Mountain'] },
  oracleText:
    '({T}: Add {B} or {R}.)\nAs this land enters, you may pay 2 life. If you don’t, it enters tapped.',
});

describe('compiling a shockland', () => {
  it('compiles Blood Crypt completely, with the printed life price', () => {
    const result = compileCard(BLOOD_CRYPT_SCRYFALL);
    expect(result.status, JSON.stringify(result.missing)).toBe('complete');
    expect(result.definition.entersTappedUnlessLifePaid).toBe(SHOCK_LIFE);
    // The dual mana halves survive alongside it.
    expect(result.definition.producesOptions).toEqual([{ B: 1 }, { R: 1 }]);
  });

  it('compiles the older long templating too', () => {
    const result = compileCard(
      makeCard({
        name: 'Sacred Foundry',
        typeLine: { supertypes: [], types: ['Land'], subtypes: ['Mountain', 'Plains'] },
        oracleText:
          '({T}: Add {R} or {W}.)\nAs Sacred Foundry enters the battlefield, you may pay 2 life. If you don’t, Sacred Foundry enters the battlefield tapped.',
      }),
    );
    expect(result.status, JSON.stringify(result.missing)).toBe('complete');
    expect(result.definition.entersTappedUnlessLifePaid).toBe(SHOCK_LIFE);
  });

  it('REFUSES a pay-price entry that is not life', () => {
    // "you may pay {1}" or a discard-to-enter-untapped is a different mechanic;
    // half-reading it as a life payment would charge the wrong price.
    const result = compileCard(
      makeCard({
        name: 'Odd Land',
        typeLine: { supertypes: [], types: ['Land'], subtypes: [] },
        oracleText: 'As Odd Land enters, you may discard a card. If you don’t, it enters tapped.',
      }),
    );
    expect(result.status).toBe('incomplete');
    expect(result.definition.entersTappedUnlessLifePaid).toBeUndefined();
  });
});

// --- the fetch composition -----------------------------------------------------------------

const BLOOD_CRYPT: CardDefinition = compileCard(BLOOD_CRYPT_SCRYFALL).definition;

/** A fetchland-tail effect: search for a land, put it onto the battlefield. */
const FETCH_EFFECT: CardDefinition = {
  id: 'test:Fetch Ritual',
  name: 'Fetch Ritual',
  types: ['sorcery'],
  timing: 'sorcery',
  effects: [
    {
      primitive: 'searchLibrary',
      params: { destination: 'battlefield', filter: { anyOfTypes: ['land'] } },
    },
  ],
};

function poolCard(name: string): CardDefinition {
  const card = CARD_POOL.find((c) => c.name === name);
  if (!card) throw new Error(`pool missing ${name}`);
  return card;
}

const ISLAND = poolCard('Island');

function act(state: GameState, action: GameAction, reg: Registry): GameState {
  const result = applyAction(state, action, DEFAULT_RULES, reg);
  const rejected = result.events.find((e) => e.type === 'actionRejected');
  if (rejected) throw new Error(`unexpected rejection: ${(rejected as { reason: string }).reason}\n${dumpState(state)}`);
  return result.state;
}

function pass(state: GameState, reg: Registry): GameState {
  return act(state, { kind: 'passPriority', player: state.priorityPlayer }, reg);
}

let syntheticId = 90_500;

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
 * Cast the fetch effect with a shockland on top of the library, answer the
 * search by taking it, and return the state parked on the shock question.
 */
function fetchShock(): { state: GameState; reg: Registry; crypt: CardInstance } {
  const reg = buildRegistry(CARD_POOL);
  const { state: created } = createGame({
    seed: SEED,
    startingPlayer: 'A',
    registry: reg,
    decks: {
      A: { cards: Array.from({ length: DECK_SIZE }, () => ISLAND) },
      B: { cards: Array.from({ length: DECK_SIZE }, () => ISLAND) },
    },
  });
  let state = created;
  let guard = 0;
  while (state.step !== 'precombatMain' && !state.gameOver && guard++ < 50) state = pass(state, reg);

  const spell = instance(FETCH_EFFECT, 'A', 'hand');
  const crypt = instance(BLOOD_CRYPT, 'A', 'library');
  state.players.A.hand = [spell];
  state.players.A.library = [crypt, ...state.players.A.library];

  state = act(state, { kind: 'castSpell', player: 'A', instanceId: spell.instanceId }, reg);
  state = pass(state, reg);
  state = pass(state, reg); // resolves → the search question parks

  expect(state.pendingChoice?.kind).toBe('selectCards');
  state = answer(state, reg, { kind: 'selectCards', instanceIds: [crypt.instanceId] });
  return { state, reg, crypt };
}

describe('a fetched shockland (the mid-resolution ask)', () => {
  it('asks the shock question inside the resolution, after the search', () => {
    const { state } = fetchShock();
    const choice = state.pendingChoice as PayLifeChoice | null;
    expect(choice?.kind).toBe('payLife');
    expect(choice?.amount).toBe(SHOCK_LIFE);
    expect(choice?.chooser).toBe('A');
  });

  it('pay: the life is charged once and the land enters UNTAPPED', () => {
    const { state, reg, crypt } = fetchShock();
    const done = answer(state, reg, { kind: 'payLife', pay: true });

    expect(done.players.A.life).toBe(DEFAULT_RULES.startingLife - SHOCK_LIFE);
    const land = done.battlefield.find((c) => c.instanceId === crypt.instanceId);
    expect(land?.tapped).toBe(false);
    expect(done.pendingChoice ?? null).toBeNull();
    expect(done.resolution ?? null).toBeNull();
  });

  it('decline: nothing is charged and the land enters TAPPED', () => {
    const { state, reg, crypt } = fetchShock();
    const done = answer(state, reg, { kind: 'payLife', pay: false });

    expect(done.players.A.life).toBe(DEFAULT_RULES.startingLife);
    const land = done.battlefield.find((c) => c.instanceId === crypt.instanceId);
    expect(land?.tapped).toBe(true);
  });
});
