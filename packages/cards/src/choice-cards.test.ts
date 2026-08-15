/**
 * "Does the ENGINE play these cards?" — the choice-driven half of the pool, proved
 * through REAL GAMES.
 *
 * Every test below drives `createGame` + `applyAction` with this package's own
 * registry, casts the actual pool card, answers the questions it actually asks,
 * and asserts the state the printed card promises: the exact library order
 * Brainstorm was told to make, the exact card Thoughtseize took, the exact
 * graveyard card Eternal Witness brought back, both of Cryptic Command's chosen
 * modes, and both branches of Path to Exile's optional search.
 *
 * That bar matters more than a unit test of the primitives: these cards used to be
 * approximations, and an approximation is exactly the kind of thing that passes a
 * primitive test and still plays the wrong card. Everything here is seeded and
 * deterministic.
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
import { applyAction, createGame, createRng, DEFAULT_RULES, dumpState, generateLegalActions } from '@jonny-boi/core';
import { buildRegistry } from './pool.js';
import { CARD_POOL } from '../data/pool.js';

type Registry = ReturnType<typeof buildRegistry>;

/** Seeds are fixed per test so any failure is reproducible. */
const SEEDS = Object.freeze({
  brainstorm: 201,
  ponder: 202,
  thoughtseize: 203,
  witness: 204,
  cryptic: 205,
  path: 206,
  wholeGame: 207,
});

/** How many cards fill a test deck — enough that nobody decks out mid-test. */
const DECK_SIZE = 40;

function getByName(name: string): CardDefinition {
  const card = CARD_POOL.find((c) => c.name === name);
  if (!card) throw new Error(`pool missing ${name}`);
  return card;
}

const PLAINS = getByName('Plains');
const ISLAND = getByName('Island');
const SWAMP = getByName('Swamp');
const FOREST = getByName('Forest');
const BOLT = getByName('Lightning Bolt');
const WRATH = getByName('Wrath of God');
const SERRA = getByName('Serra Angel');

function deck(def: CardDefinition, n = DECK_SIZE): { cards: CardDefinition[] } {
  return { cards: Array.from({ length: n }, () => def) };
}

// --- harness --------------------------------------------------------------------

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

/** Advance (by passing) until the named step, or until a question is parked. */
function advanceToStep(state: GameState, step: GameState['step'], reg: Registry, max = 400): GameState {
  let s = state;
  let guard = 0;
  while (s.step !== step && !s.gameOver && !s.pendingChoice && guard++ < max) s = pass(s, reg);
  return s;
}

/** Fill a player's pool so cost payment is never what a test is measuring. */
function floodMana(state: GameState, player: PlayerId): void {
  const plenty = DECK_SIZE; // more than any pool card costs, by construction
  state.players[player].manaPool = { W: plenty, U: plenty, B: plenty, R: plenty, G: plenty, C: plenty };
}

let syntheticId = 90_000;

/** A fresh instance of `def` in a zone, with an id that cannot collide. */
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

/** Replace a player's library with exactly these cards, top first. */
function setLibrary(state: GameState, player: PlayerId, defs: readonly CardDefinition[]): CardInstance[] {
  const cards = defs.map((def) => instance(def, player, 'library'));
  state.players[player].library = cards;
  return cards;
}

/** Replace a player's hand with exactly these cards; returns the instances. */
function setHand(state: GameState, player: PlayerId, defs: readonly CardDefinition[]): CardInstance[] {
  const cards = defs.map((def) => instance(def, player, 'hand'));
  state.players[player].hand = cards;
  return cards;
}

/** Put a permanent onto the battlefield, ready to act. */
function place(state: GameState, def: CardDefinition, controller: PlayerId): CardInstance {
  const card = instance(def, controller, 'battlefield');
  state.battlefield.push(card);
  return card;
}

/** A game sitting in the starting player's first main phase, hands cleared. */
function gameAtMain(reg: Registry, seed: number, decks: { A: CardDefinition; B: CardDefinition }): GameState {
  const { state } = createGame({
    seed,
    registry: reg,
    decks: { A: deck(decks.A), B: deck(decks.B) },
  });
  const s = advanceToStep(state, 'precombatMain', reg);
  s.players.A.hand = [];
  s.players.B.hand = [];
  return s;
}

/** Submit an answer to whatever is parked, asserting the engine accepts it. */
function answer(state: GameState, reg: Registry, value: ChoiceAnswer): GameState {
  const choice = state.pendingChoice;
  if (!choice) throw new Error(`no choice pending:\n${dumpState(state)}`);
  return act(state, { kind: 'answerChoice', player: choice.chooser, choiceId: choice.id, answer: value }, reg);
}

/**
 * Play the game forward until nothing is on the stack and nothing is being asked,
 * answering each question with `reply`. This is the shape every test uses: cast,
 * settle, assert.
 */
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

/** Cast a card from hand (mana is flooded first) and settle the resolution. */
function castAndSettle(
  state: GameState,
  reg: Registry,
  caster: PlayerId,
  card: CardInstance,
  reply: (choice: PendingChoice, state: GameState) => ChoiceAnswer,
  targets: ReadonlyArray<InstanceId | PlayerId> = [],
): GameState {
  floodMana(state, caster);
  const cast = act(state, { kind: 'castSpell', player: caster, instanceId: card.instanceId, targets }, reg);
  return settle(cast, reg, reply);
}

/** The candidate ids of a parked card selection, by card name. */
function candidateNamed(choice: PendingChoice, name: string): InstanceId {
  if (choice.kind !== 'selectCards') throw new Error(`not a card selection: ${choice.kind}`);
  const found = choice.candidates.find((c) => c.name === name);
  if (!found) throw new Error(`no candidate named ${name} in [${choice.candidates.map((c) => c.name).join(', ')}]`);
  return found.instanceId;
}

function names(cards: readonly CardInstance[]): string[] {
  return cards.map((c) => c.def.name);
}

/** Distinguishable stand-in cards, so "which card / what order" is observable. */
function marker(name: string): CardDefinition {
  return { id: `marker:${name}`, name, types: ['instant'], cost: { generic: 9 } };
}

// --- Brainstorm -------------------------------------------------------------------

describe('Brainstorm — draw three, put two back on top in the chosen order', () => {
  function game(): { state: GameState; reg: Registry; spell: CardInstance } {
    const reg = buildRegistry();
    const state = gameAtMain(reg, SEEDS.brainstorm, { A: ISLAND, B: ISLAND });
    setLibrary(state, 'A', [marker('Top1'), marker('Top2'), marker('Top3'), ...Array.from({ length: 10 }, () => ISLAND)]);
    const [spell] = setHand(state, 'A', [getByName('Brainstorm')]);
    return { state, reg, spell: spell! };
  }

  it('asks its controller for an ORDERED pick of two cards from the three it drew', () => {
    const { state, reg, spell } = game();
    floodMana(state, 'A');
    let s = act(state, { kind: 'castSpell', player: 'A', instanceId: spell.instanceId }, reg);
    s = pass(s, reg);
    s = pass(s, reg); // resolves → draws 3 → parks

    const choice = s.pendingChoice!;
    expect(choice.chooser).toBe('A');
    expect(choice.kind === 'selectCards' && choice.ordered).toBe(true);
    expect([choice.min, choice.max]).toEqual([2, 2]);
    expect(choice.kind === 'selectCards' && choice.candidates.map((c) => c.name).sort()).toEqual([
      'Top1',
      'Top2',
      'Top3',
    ]);
    // Answering is the only thing the game will accept while it is parked.
    expect(generateLegalActions(s).every((a) => a.kind === 'answerChoice')).toBe(true);
  });

  it('puts them back in exactly the chosen order — first choice on top', () => {
    const { state, reg, spell } = game();
    const done = castAndSettle(state, reg, 'A', spell, (choice) => ({
      kind: 'selectCards',
      instanceIds: [candidateNamed(choice, 'Top3'), candidateNamed(choice, 'Top1')],
    }));

    expect(names(done.players.A.library).slice(0, 2)).toEqual(['Top3', 'Top1']);
    expect(names(done.players.A.hand)).toEqual(['Top2']); // drew 3, put 2 back → net +1
    expect(names(done.players.A.graveyard)).toContain('Brainstorm');
    expect(done.pendingChoice ?? null).toBeNull();
  });

  it('reversing the answer reverses the library — the order really is the answer', () => {
    const { state, reg, spell } = game();
    const done = castAndSettle(state, reg, 'A', spell, (choice) => ({
      kind: 'selectCards',
      instanceIds: [candidateNamed(choice, 'Top1'), candidateNamed(choice, 'Top3')],
    }));

    expect(names(done.players.A.library).slice(0, 2)).toEqual(['Top1', 'Top3']);
    expect(names(done.players.A.hand)).toEqual(['Top2']);
  });
});

// --- Ponder -------------------------------------------------------------------------

describe('Ponder — reorder the top three, maybe shuffle, then draw', () => {
  const TOP = ['Alpha', 'Beta', 'Gamma'];

  function game(): { state: GameState; reg: Registry; spell: CardInstance } {
    const reg = buildRegistry();
    const state = gameAtMain(reg, SEEDS.ponder, { A: ISLAND, B: ISLAND });
    setLibrary(state, 'A', [
      ...TOP.map(marker),
      ...['Delta', 'Epsilon', 'Zeta'].map(marker),
      ...Array.from({ length: 6 }, () => ISLAND),
    ]);
    const [spell] = setHand(state, 'A', [getByName('Ponder')]);
    return { state, reg, spell: spell! };
  }

  /** Answer the reorder with `order`, then decline (or accept) the shuffle. */
  function replyWith(order: readonly string[], shuffle: boolean) {
    return (choice: PendingChoice): ChoiceAnswer =>
      choice.kind === 'confirm'
        ? { kind: 'confirm', yes: shuffle }
        : { kind: 'selectCards', instanceIds: order.map((n) => candidateNamed(choice, n)) };
  }

  it('offers exactly the top three as one ordered pick, then a real yes/no shuffle', () => {
    const { state, reg, spell } = game();
    const asked: PendingChoice[] = [];
    castAndSettle(state, reg, 'A', spell, (choice) => {
      asked.push(choice);
      return replyWith(['Gamma', 'Alpha', 'Beta'], false)(choice);
    });

    expect(asked.map((c) => c.kind)).toEqual(['selectCards', 'confirm']);
    const reorder = asked[0]!;
    expect(reorder.kind === 'selectCards' && reorder.candidates.map((c) => c.name)).toEqual(TOP);
    expect(reorder.kind === 'selectCards' && reorder.ordered).toBe(true);
  });

  it('draws the card the player put on top, and leaves the rest in the chosen order', () => {
    const { state, reg, spell } = game();
    const done = castAndSettle(state, reg, 'A', spell, replyWith(['Gamma', 'Alpha', 'Beta'], false));

    expect(names(done.players.A.hand)).toEqual(['Gamma']); // the chosen top card
    expect(names(done.players.A.library).slice(0, 2)).toEqual(['Alpha', 'Beta']);
    expect(names(done.players.A.graveyard)).toContain('Ponder');
  });

  it('shuffling instead really shuffles — and is reproducible under a fixed seed', () => {
    const run = (): string[] => {
      const { state, reg, spell } = game();
      const done = castAndSettle(state, reg, 'A', spell, replyWith(['Gamma', 'Alpha', 'Beta'], true));
      return names(done.players.A.library);
    };

    const first = run();
    expect(run()).toEqual(first); // same seed ⇒ same shuffle
    // It really shuffled: the deliberate order did not survive.
    expect(first.slice(0, 2)).not.toEqual(['Alpha', 'Beta']);
  });
});

// --- Thoughtseize ---------------------------------------------------------------------

describe('Thoughtseize — the CASTER picks the victim nonland card', () => {
  function game(victimHand: readonly CardDefinition[]): {
    state: GameState;
    reg: Registry;
    spell: CardInstance;
  } {
    const reg = buildRegistry();
    const state = gameAtMain(reg, SEEDS.thoughtseize, { A: SWAMP, B: ISLAND });
    setHand(state, 'B', victimHand);
    const [spell] = setHand(state, 'A', [getByName('Thoughtseize')]);
    return { state, reg, spell: spell! };
  }

  it('addresses the choice to the caster and offers only the victim nonland cards', () => {
    const { state, reg, spell } = game([SERRA, BOLT, ISLAND]);
    floodMana(state, 'A');
    let s = act(state, { kind: 'castSpell', player: 'A', instanceId: spell.instanceId, targets: ['B'] }, reg);
    s = pass(s, reg);
    s = pass(s, reg);

    const choice = s.pendingChoice!;
    expect(choice.chooser).toBe('A'); // the caster chooses — this is not a discard
    expect(choice.valence).toBe('gain');
    expect(choice.kind === 'selectCards' && choice.candidates.map((c) => c.name).sort()).toEqual([
      'Lightning Bolt',
      'Serra Angel',
    ]);
    // The victim cannot answer for the caster.
    const usurped = applyAction(
      s,
      {
        kind: 'answerChoice',
        player: 'B',
        choiceId: choice.id,
        answer: { kind: 'selectCards', instanceIds: [candidateNamed(choice, 'Serra Angel')] },
      },
      DEFAULT_RULES,
      reg,
    );
    expect(usurped.events.some((e) => e.type === 'actionRejected')).toBe(true);
    expect(usurped.state.players.B.hand).toHaveLength(3);
  });

  it('takes exactly the card the caster named, and costs the caster 2 life', () => {
    const { state, reg, spell } = game([SERRA, BOLT, ISLAND]);
    const lifeBefore = state.players.A.life;

    const done = castAndSettle(
      state,
      reg,
      'A',
      spell,
      (choice) => ({ kind: 'selectCards', instanceIds: [candidateNamed(choice, 'Serra Angel')] }),
      ['B'],
    );

    expect(names(done.players.B.graveyard)).toEqual(['Serra Angel']);
    expect(names(done.players.B.hand).sort()).toEqual(['Island', 'Lightning Bolt']);
    expect(done.players.A.life).toBe(lifeBefore - 2);
  });

  it('handles a hand of nothing but lands: nothing is taken, the life is still paid', () => {
    const { state, reg, spell } = game([ISLAND, ISLAND]);
    const lifeBefore = state.players.A.life;

    const done = castAndSettle(state, reg, 'A', spell, () => {
      throw new Error('no question should be asked when there is nothing to take');
    }, ['B']);

    expect(done.players.B.hand).toHaveLength(2);
    expect(done.players.B.graveyard).toHaveLength(0);
    expect(done.players.A.life).toBe(lifeBefore - 2);
    expect(names(done.players.A.graveyard)).toContain('Thoughtseize');
  });
});

// --- Eternal Witness --------------------------------------------------------------------

describe('Eternal Witness — its ETB returns the CHOSEN graveyard card', () => {
  function game(): { state: GameState; reg: Registry; witness: CardInstance } {
    const reg = buildRegistry();
    const state = gameAtMain(reg, SEEDS.witness, { A: FOREST, B: FOREST });
    state.players.A.graveyard = [instance(BOLT, 'A', 'graveyard'), instance(WRATH, 'A', 'graveyard')];
    const [witness] = setHand(state, 'A', [getByName('Eternal Witness')]);
    return { state, reg, witness: witness! };
  }

  it('offers the whole graveyard and returns exactly the named card', () => {
    const { state, reg, witness } = game();
    const asked: PendingChoice[] = [];

    const done = castAndSettle(state, reg, 'A', witness, (choice) => {
      asked.push(choice);
      return { kind: 'selectCards', instanceIds: [candidateNamed(choice, 'Wrath of God')] };
    });

    expect(asked[0]!.valence).toBe('gain');
    expect(asked[0]!.kind === 'selectCards' && asked[0]!.candidates.map((c) => c.name).sort()).toEqual([
      'Lightning Bolt',
      'Wrath of God',
    ]);
    expect(names(done.players.A.hand)).toEqual(['Wrath of God']);
    expect(names(done.players.A.graveyard)).toEqual(['Lightning Bolt']);
    // And the body itself arrived: a 2/1 on the battlefield.
    const body = done.battlefield.find((c) => c.def.name === 'Eternal Witness');
    expect(body).toBeDefined();
    expect([body!.def.power, body!.def.toughness]).toEqual([2, 1]);
  });

  it('is a "you may": returning nothing is a legal answer', () => {
    const { state, reg, witness } = game();
    const done = castAndSettle(state, reg, 'A', witness, () => ({ kind: 'selectCards', instanceIds: [] }));

    expect(done.players.A.hand).toHaveLength(0);
    expect(done.players.A.graveyard).toHaveLength(2);
  });

  it('never offers the Witness itself, and asks nothing with an empty graveyard', () => {
    const reg = buildRegistry();
    const state = gameAtMain(reg, SEEDS.witness, { A: FOREST, B: FOREST });
    state.players.A.graveyard = [];
    const [witness] = setHand(state, 'A', [getByName('Eternal Witness')]);

    const done = castAndSettle(state, reg, 'A', witness!, () => {
      throw new Error('an empty graveyard has nothing to ask about');
    });

    expect(done.players.A.hand).toHaveLength(0);
    expect(done.battlefield.some((c) => c.def.name === 'Eternal Witness')).toBe(true);
  });
});

// --- Cryptic Command -----------------------------------------------------------------

describe('Cryptic Command — choose two, and both chosen modes happen', () => {
  function game(): { state: GameState; reg: Registry; spell: CardInstance } {
    const reg = buildRegistry();
    const state = gameAtMain(reg, SEEDS.cryptic, { A: ISLAND, B: ISLAND });
    const [spell] = setHand(state, 'A', [getByName('Cryptic Command')]);
    return { state, reg, spell: spell! };
  }

  it('with no targets, only the two target-free modes exist — so both of them run', () => {
    const { state, reg, spell } = game();
    const theirs = place(state, SERRA, 'B');
    const asked: PendingChoice[] = [];

    const done = castAndSettle(state, reg, 'A', spell, (choice) => {
      asked.push(choice);
      return { kind: 'chooseModes', modeIds: ['tapAll', 'draw'] };
    });

    // "Choose two" of exactly two available modes has ONE legal answer, so the
    // engine takes it rather than stopping the game to collect the only reply —
    // and the card still does both halves.
    expect(asked).toEqual([]);
    expect(done.battlefield.find((c) => c.instanceId === theirs.instanceId)!.tapped).toBe(true);
    expect(done.players.A.hand).toHaveLength(1); // drew a card
  });

  it('a legal bounce target puts a third mode on the menu, and the pick is a real question', () => {
    const { state, reg, spell } = game();
    const theirs = place(state, SERRA, 'B');
    const asked: PendingChoice[] = [];

    const done = castAndSettle(
      state,
      reg,
      'A',
      spell,
      (choice) => {
        asked.push(choice);
        return { kind: 'chooseModes', modeIds: ['tapAll', 'draw'] };
      },
      [theirs.instanceId],
    );

    const choice = asked[0]!;
    expect(choice.kind === 'chooseModes' && choice.modes.map((m) => m.id)).toEqual(['bounce', 'tapAll', 'draw']);
    expect([choice.min, choice.max]).toEqual([2, 2]);
    // The modes NOT chosen did not happen: the creature is still there, tapped.
    const stillThere = done.battlefield.find((c) => c.instanceId === theirs.instanceId);
    expect(stillThere).toBeDefined();
    expect(stillThere!.tapped).toBe(true);
    expect(done.players.A.hand).toHaveLength(1);
  });

  it('bounce + draw: the targeted permanent goes back to its owner hand AND a card is drawn', () => {
    const { state, reg, spell } = game();
    const theirs = place(state, SERRA, 'B');

    const done = castAndSettle(
      state,
      reg,
      'A',
      spell,
      () => ({ kind: 'chooseModes', modeIds: ['bounce', 'draw'] }),
      [theirs.instanceId],
    );

    expect(done.battlefield.some((c) => c.instanceId === theirs.instanceId)).toBe(false);
    expect(names(done.players.B.hand)).toEqual(['Serra Angel']);
    expect(done.players.A.hand).toHaveLength(1);
  });

  it('counter + draw: the targeted spell is countered on the stack and a card is drawn', () => {
    const { state, reg, spell } = game();
    const [theirCreature] = setHand(state, 'B', [SERRA]);
    // B casts at instant speed in A's main phase is not legal for a creature, so
    // let B take the turn: A passes down to B's main phase.
    let s = state;
    let guard = 0;
    while (!(s.activePlayer === 'B' && s.step === 'precombatMain') && guard++ < 200) s = pass(s, reg);
    floodMana(s, 'B');
    s = act(s, { kind: 'castSpell', player: 'B', instanceId: theirCreature!.instanceId }, reg);
    // The caster keeps priority after casting; B passes it to A, who responds with
    // Cryptic targeting the creature spell still on the stack.
    s = pass(s, reg);
    floodMana(s, 'A');
    s = act(s, { kind: 'castSpell', player: 'A', instanceId: spell.instanceId, targets: [theirCreature!.instanceId] }, reg);

    const done = settle(s, reg, (choice) => {
      expect(choice.kind === 'chooseModes' && choice.modes.map((m) => m.id)).toEqual(['counter', 'tapAll', 'draw']);
      return { kind: 'chooseModes', modeIds: ['counter', 'draw'] };
    });

    expect(done.battlefield.some((c) => c.def.name === 'Serra Angel')).toBe(false);
    expect(names(done.players.B.graveyard)).toContain('Serra Angel');
    expect(done.players.A.hand).toHaveLength(1);
  });
});

// --- Path to Exile --------------------------------------------------------------------

describe('Path to Exile — exile, then the creature controller MAY fetch a basic land', () => {
  /** B's library: distinguishable spells plus a couple of basics to find. */
  const VICTIM_LIBRARY: readonly CardDefinition[] = [
    marker('Spell1'),
    PLAINS,
    marker('Spell2'),
    PLAINS,
    marker('Spell3'),
    marker('Spell4'),
  ];

  function game(): { state: GameState; reg: Registry; path: CardInstance; victim: CardInstance } {
    const reg = buildRegistry();
    const state = gameAtMain(reg, SEEDS.path, { A: PLAINS, B: PLAINS });
    setLibrary(state, 'B', VICTIM_LIBRARY);
    const victim = place(state, SERRA, 'B');
    const [path] = setHand(state, 'A', [getByName('Path to Exile')]);
    return { state, reg, path: path!, victim };
  }

  it('exiles the creature and asks its CONTROLLER (not the caster) whether to search', () => {
    const { state, reg, path, victim } = game();
    floodMana(state, 'A');
    let s = act(state, { kind: 'castSpell', player: 'A', instanceId: path.instanceId, targets: [victim.instanceId] }, reg);
    s = pass(s, reg);
    s = pass(s, reg);

    const choice = s.pendingChoice!;
    expect(choice.kind).toBe('confirm');
    expect(choice.chooser).toBe('B');
    expect(choice.valence).toBe('gain');
    expect(s.players.B.exile.some((c) => c.instanceId === victim.instanceId)).toBe(true);
  });

  it('declining leaves the library exactly as it was — no card, no shuffle', () => {
    const { state, reg, path, victim } = game();
    const before = state.players.B.library.map((c) => c.instanceId);

    const done = castAndSettle(state, reg, 'A', path, () => ({ kind: 'confirm', yes: false }), [victim.instanceId]);

    expect(done.players.B.library.map((c) => c.instanceId)).toEqual(before);
    expect(done.battlefield.some((c) => c.instanceId === victim.instanceId)).toBe(false);
  });

  it('accepting offers only BASIC LANDS, puts the chosen one onto the battlefield TAPPED, and shuffles', () => {
    const { state, reg, path, victim } = game();
    const before = state.players.B.library.map((c) => c.instanceId);
    const asked: PendingChoice[] = [];

    const done = castAndSettle(
      state,
      reg,
      'A',
      path,
      (choice) => {
        asked.push(choice);
        if (choice.kind === 'confirm') return { kind: 'confirm', yes: true };
        return { kind: 'selectCards', instanceIds: [candidateNamed(choice, 'Plains')] };
      },
      [victim.instanceId],
    );

    const search = asked[1]!;
    expect(search.kind === 'selectCards' && search.candidates.map((c) => c.name)).toEqual(['Plains', 'Plains']);
    const fetched = done.battlefield.find((c) => c.def.name === 'Plains' && c.controller === 'B');
    expect(fetched).toBeDefined();
    expect(fetched!.tapped).toBe(true);
    expect(done.players.B.library).toHaveLength(before.length - 1);
    // It shuffled: the remaining cards are the same set in a different order.
    const after = done.players.B.library.map((c) => c.instanceId);
    expect([...after].sort()).toEqual(before.filter((id) => id !== fetched!.instanceId).sort());
    expect(after).not.toEqual(before.filter((id) => id !== fetched!.instanceId));
  });
});

// --- Goblin Guide -----------------------------------------------------------------------

describe('Goblin Guide — the defender reveals the top card and keeps it only if it is a land', () => {
  function attackWith(topOfDefenderLibrary: CardDefinition): GameState {
    const reg = buildRegistry();
    const state = gameAtMain(reg, SEEDS.wholeGame, { A: getByName('Mountain'), B: ISLAND });
    const guide = place(state, getByName('Goblin Guide'), 'A');
    let s = advanceToStep(state, 'declareAttackers', reg);
    // Seed the defender's library right before the trigger looks at it.
    setLibrary(s, 'B', [topOfDefenderLibrary, marker('Second'), marker('Third')]);
    s = act(s, { kind: 'declareAttackers', player: 'A', attackers: [guide.instanceId] }, reg);
    return settle(s, reg, () => {
      throw new Error('the reveal asks nobody anything — it is not a choice');
    });
  }

  it('a land on top goes to the defender hand', () => {
    const done = attackWith(ISLAND);
    expect(names(done.players.B.hand)).toContain('Island');
    expect(names(done.players.B.library)).toEqual(['Second', 'Third']);
  });

  it('a nonland on top stays exactly where it was', () => {
    const done = attackWith(BOLT);
    expect(names(done.players.B.hand)).not.toContain('Lightning Bolt');
    expect(names(done.players.B.library)).toEqual(['Lightning Bolt', 'Second', 'Third']);
  });
});

// --- a whole game full of these cards ----------------------------------------------------

describe('a game full of choice cards', () => {
  /**
   * A self-driving game: both seats pick a legal action with a seeded RNG, which
   * means every answer to every question is a pure function of the seed. It is the
   * headless-sim contract in miniature — the same one the AI pilots rely on.
   */
  function playOut(seed: number): { turns: number; winner: PlayerId | null; log: string } {
    const reg = buildRegistry();
    const { state } = createGame({
      seed,
      registry: reg,
      decks: {
        A: {
          cards: [
            ...Array.from({ length: 4 }, () => getByName('Brainstorm')),
            ...Array.from({ length: 4 }, () => getByName('Ponder')),
            ...Array.from({ length: 4 }, () => getByName('Cryptic Command')),
            ...Array.from({ length: 4 }, () => getByName('Path to Exile')),
            ...Array.from({ length: 4 }, () => SERRA),
            ...Array.from({ length: 20 }, () => ISLAND),
          ],
        },
        B: {
          cards: [
            ...Array.from({ length: 4 }, () => getByName('Thoughtseize')),
            ...Array.from({ length: 4 }, () => getByName('Eternal Witness')),
            ...Array.from({ length: 4 }, () => getByName('Goblin Guide')),
            ...Array.from({ length: 4 }, () => BOLT),
            ...Array.from({ length: 24 }, () => SWAMP),
          ],
        },
      },
    });

    let s = state;
    const rng = createRng(seed);
    const kinds: string[] = [];
    const MAX_ACTIONS = 6000;
    for (let i = 0; i < MAX_ACTIONS && !s.gameOver; i++) {
      const legal = generateLegalActions(s);
      // The invariant that makes hanging impossible: there is ALWAYS a move —
      // including while a question is parked, where answering is the only move.
      expect(legal.length).toBeGreaterThan(0);
      const chosen = legal[rng.nextInt(legal.length)] as GameAction;
      kinds.push(chosen.kind);
      s = applyAction(s, chosen, DEFAULT_RULES, reg).state;
    }
    return { turns: s.turnNumber, winner: s.winner, log: kinds.join(',') };
  }

  it('completes without ever wedging on a choice, and the same seed replays identically', () => {
    const first = playOut(SEEDS.wholeGame);
    expect(first.log).toContain('answerChoice'); // the cards really were asked
    expect(playOut(SEEDS.wholeGame)).toEqual(first);
    expect(playOut(SEEDS.wholeGame + 1).log).not.toBe(first.log);
  });

  it('never falls back to an unsupported primitive or an abandoned choice', () => {
    const reg = buildRegistry();
    const { state } = createGame({
      seed: SEEDS.wholeGame,
      registry: reg,
      decks: {
        A: { cards: [...Array.from({ length: 12 }, () => getByName('Brainstorm')), ...Array.from({ length: 28 }, () => ISLAND)] },
        B: { cards: [...Array.from({ length: 12 }, () => getByName('Thoughtseize')), ...Array.from({ length: 28 }, () => SWAMP)] },
      },
    });
    let s = state;
    const rng = createRng(SEEDS.wholeGame);
    const bad: string[] = [];
    for (let i = 0; i < 3000 && !s.gameOver; i++) {
      const legal = generateLegalActions(s);
      if (legal.length === 0) break;
      const result = applyAction(s, legal[rng.nextInt(legal.length)] as GameAction, DEFAULT_RULES, reg);
      for (const e of result.events) {
        if (e.type === 'effectUnsupported' || e.type === 'choiceAbandoned') bad.push(e.type);
      }
      s = result.state;
    }
    expect(bad).toEqual([]);
  });
});
