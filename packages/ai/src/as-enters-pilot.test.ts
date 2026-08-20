/**
 * The pilot NAMING a value — "As ~ enters, choose a creature type / a color".
 *
 * This is the test that decides whether a whole family of cards is worth
 * anything in an A/B verdict. The engine is happy with any legal answer, so a
 * pilot that named at random would still play legal Magic — it would just play a
 * Cavern of Souls that taps for nothing and an Adaptive Automaton that pumps
 * nobody, and the lab would then report "no measurable difference" about a card
 * that is in fact a lord. So what is pinned here is that the naming is DELIBERATE
 * and reads the chooser's own cards:
 *
 *  1. it names the deck's TRIBE, not the first option offered;
 *  2. it names the colour its own cards need most, counted in PIPS;
 *  3. it names the OPPONENT when the subject is a player (every printed card
 *     with that naming aims something unpleasant at them);
 *  4. it is DETERMINISTIC — the same state answers the same way, which is what a
 *     seeded sim's reproducibility rests on;
 *  5. it never names NOTHING while something is on offer.
 */

import { describe, expect, it } from 'vitest';
import type { CardDefinition, ChoiceRequest, GameState, PendingChoice } from '@jonny-boi/core';
import { NOTHING_CHOSEN, normalizeChoiceRequest } from '@jonny-boi/core';
import { answerChoiceHeuristically } from './choices.js';
import { DEFAULT_HEURISTIC_WEIGHTS } from './weights.js';
import { createGame } from '@jonny-boi/core';
import { creatureDef, giveHand, landDef, putOnBattlefield } from './test-support.js';

const WEIGHTS = DEFAULT_HEURISTIC_WEIGHTS;
const SOURCE = { id: 11, sourceInstanceId: 1, sourceName: 'Cavern of Souls' };

const GOBLIN: CardDefinition = { ...creatureDef('Goblin Piker', 2, 1), subtypes: ['goblin'] };
const ELF: CardDefinition = { ...creatureDef('Llanowar Elf', 1, 1), subtypes: ['elf'] };
const MOUNTAIN = landDef('Mountain', 'R');

/** A started game with an empty-ish board — the positions below are built by hand. */
function newGame() {
  return createGame({
    seed: 99,
    decks: {
      A: { cards: Array.from({ length: 30 }, () => MOUNTAIN) },
      B: { cards: Array.from({ length: 30 }, () => MOUNTAIN) },
    },
  });
}

function park(request: ChoiceRequest): PendingChoice {
  const choice = normalizeChoiceRequest(request, SOURCE);
  if (!choice) throw new Error('expected a normalised choice');
  return choice;
}

/** The value the heuristic names, unwrapped from the action it returns. */
function named(state: GameState, choice: PendingChoice): string {
  const action = answerChoiceHeuristically(state, choice, WEIGHTS);
  if (action.kind !== 'answerChoice' || action.answer.kind !== 'chooseValue') {
    throw new Error(`expected a chooseValue answer, got ${action.kind}`);
  }
  return action.answer.value;
}

const TYPE_REQUEST = {
  kind: 'chooseValue',
  chooser: 'A',
  prompt: 'Choose a creature type',
  subject: 'creatureType',
  // Elf FIRST on purpose: a pilot that took the head of the list would pass by
  // accident on any other ordering.
  options: [
    { value: 'elf', label: 'elf' },
    { value: 'goblin', label: 'goblin' },
  ],
} as const;

describe('naming a creature type', () => {
  it('names the deck TRIBE, not the first option offered', () => {
    const state = newGame().state;
    state.players.A.hand = [];
    state.players.A.library = [];
    giveHand(state, 'A', [GOBLIN, GOBLIN, GOBLIN, ELF]);
    expect(named(state, park(TYPE_REQUEST))).toBe('goblin');
  });

  it('follows the deck when the tribe changes — it is counting, not guessing', () => {
    const state = newGame().state;
    state.players.A.hand = [];
    state.players.A.library = [];
    giveHand(state, 'A', [ELF, ELF, ELF, GOBLIN]);
    expect(named(state, park(TYPE_REQUEST))).toBe('elf');
  });

  it('counts the BOARD as well as the deck', () => {
    const state = newGame().state;
    state.players.A.hand = [];
    state.players.A.library = [];
    putOnBattlefield(state, 'A', [GOBLIN, GOBLIN]);
    giveHand(state, 'A', [ELF]);
    expect(named(state, park(TYPE_REQUEST))).toBe('goblin');
  });

  it('does NOT count a land’s printed types as a tribe vote', () => {
    // A Goblin deck's manabase must not outvote its Goblins. With only lands and
    // one Elf around, the Elf wins.
    const state = newGame().state;
    state.players.A.hand = [];
    state.players.A.library = [];
    putOnBattlefield(state, 'A', [MOUNTAIN, MOUNTAIN, MOUNTAIN]);
    giveHand(state, 'A', [ELF]);
    expect(named(state, park(TYPE_REQUEST))).toBe('elf');
  });

  it('never names NOTHING while something is on offer', () => {
    // An empty deck offers no evidence at all — and the answer is still a real
    // value, because naming nothing is the engine's floor and never a move.
    const state = newGame().state;
    state.players.A.hand = [];
    state.players.A.library = [];
    expect(named(state, park(TYPE_REQUEST))).not.toBe(NOTHING_CHOSEN);
  });

  it('is deterministic — the same position answers the same way every time', () => {
    const state = newGame().state;
    state.players.A.hand = [];
    state.players.A.library = [];
    giveHand(state, 'A', [GOBLIN, ELF, GOBLIN, ELF]);
    const choice = park(TYPE_REQUEST);
    const answers = Array.from({ length: 5 }, () => named(state, choice));
    expect(new Set(answers).size).toBe(1);
  });
});

const COLOR_REQUEST = {
  kind: 'chooseValue',
  chooser: 'A',
  prompt: 'Choose a color',
  subject: 'color',
  options: [
    { value: 'W', label: 'white' },
    { value: 'U', label: 'blue' },
    { value: 'B', label: 'black' },
    { value: 'R', label: 'red' },
    { value: 'G', label: 'green' },
  ],
} as const;

function spell(id: string, cost: CardDefinition['cost']): CardDefinition {
  return { id, name: id, types: ['instant'], timing: 'instant', cost };
}

describe('naming a colour', () => {
  it('names the colour its own cards need most', () => {
    const state = newGame().state;
    state.players.A.hand = [];
    state.players.A.library = [];
    giveHand(state, 'A', [spell('Bolt', { R: 1 }), spell('Shock', { R: 1 }), spell('Counter', { U: 1 })]);
    expect(named(state, park(COLOR_REQUEST))).toBe('R');
  });

  it('counts PIPS, not cards — one triple-black bomb outweighs two cantrips', () => {
    const state = newGame().state;
    state.players.A.hand = [];
    state.players.A.library = [];
    giveHand(state, 'A', [
      spell('Bomb', { B: 3 }),
      spell('Cantrip', { U: 1 }),
      spell('Cantrip 2', { U: 1 }),
    ]);
    expect(named(state, park(COLOR_REQUEST))).toBe('B');
  });
});

describe('naming a player', () => {
  it('names the OPPONENT — every printed card with this naming aims at them', () => {
    const state = newGame().state;
    const choice = park({
      kind: 'chooseValue',
      chooser: 'A',
      prompt: 'Choose a player',
      subject: 'player',
      options: [
        { value: 'A', label: 'player A' },
        { value: 'B', label: 'player B' },
      ],
    });
    expect(named(state, choice)).toBe('B');
  });
});
