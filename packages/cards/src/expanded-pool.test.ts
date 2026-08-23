/**
 * "Does the ENGINE play these cards?" — integration tests for the compiled half
 * of the pool (`../data/expanded-pool.ts`).
 *
 * The compiler's own suite proves it *emits* the right data. That is not the bar
 * these cards have to clear. A card only earns a place in the pool if a real
 * game, driven through `createGame` + `applyAction` with this package's
 * registry, produces the state change the printed card promises: the land taps
 * for one mana of the colour you picked (not both), the ETB trigger actually
 * fires, the -4/-4 actually kills a 4/4, deathtouch + lifelink actually resolve
 * in combat. Everything here is seeded and deterministic.
 *
 * The last test is the widest net: a self-driving game plays every compiled card
 * that can be cast, and asserts the engine never once fell back to
 * `effectUnsupported` — the event that means "this card referenced a primitive
 * nobody implements", i.e. a card that would sit in a deck doing nothing.
 */

import { describe, expect, it } from 'vitest';
import type {
  CardDefinition,
  CardInstance,
  GameAction,
  GameEvent,
  GameState,
  InstanceId,
  PlayerId,
} from '@jonny-boi/core';
import {
  applyAction,
  createGame,
  defaultAnswerFor,
  DEFAULT_RULES,
  defaultAnswerFor,
  effectivePower,
  effectiveToughness,
  generateLegalActions,
  indexContinuous,
  legalTargetsFor,
  manaModesOf,
  NO_MOD,
  targetRestrictionOf,
} from '@jonny-boi/core';
import { buildRegistry } from './pool.js';
import { CARD_POOL } from '../data/pool.js';
import { EXPANDED_CARD_POOL } from '../data/expanded-pool.js';

type Registry = ReturnType<typeof buildRegistry>;

/** Seeds are fixed per test so a failure is always reproducible. */
const SEEDS = {
  guildgate: 101,
  refuge: 102,
  etbDraw: 103,
  tokens: 104,
  removal: 105,
  nighthawk: 106,
  helix: 107,
  kilnFiend: 108,
  pelakka: 109,
  modalRock: 110,
  freeArtifact: 111,
  wipe: 112,
  wholePool: 113,
} as const;

function getByName(name: string): CardDefinition {
  const card = CARD_POOL.find((entry) => entry.name === name);
  if (!card) throw new Error(`pool missing ${name}`);
  return card;
}

const FOREST = getByName('Forest');
const MOUNTAIN = getByName('Mountain');

function deck(def: CardDefinition, n = 40): { cards: CardDefinition[] } {
  return { cards: Array.from({ length: n }, () => def) };
}

function act(state: GameState, action: GameAction, reg: Registry): GameState {
  const result = applyAction(state, action, DEFAULT_RULES, reg);
  const rejected = result.events.find((e) => e.type === 'actionRejected');
  if (rejected) throw new Error(`unexpected rejection: ${(rejected as { reason: string }).reason}`);
  return result.state;
}

/**
 * Pass priority — or, when a turn-based action has parked a question (the cleanup
 * step's discard down to maximum hand size, CR 514.1), ANSWER it. A seat with a
 * question outstanding may do nothing else, so a helper that only ever passes
 * would wedge the moment any rule stops to ask something.
 */
function pass(state: GameState, reg: Registry): GameState {
  const question = state.pendingChoice;
  if (question) {
    return act(
      state,
      {
        kind: 'answerChoice',
        player: question.chooser,
        choiceId: question.id,
        answer: defaultAnswerFor(question),
      },
      reg,
    );
  }
  return act(state, { kind: 'passPriority', player: state.priorityPlayer }, reg);
}


/**
 * Turn-runners: they pass, ANSWERING anything the game asks on the way — a turn
 * now ends with the CR 514.1 discard question whenever a hand is over the
 * maximum, and while it stands every other action is refused. `pass` above already answers.
 */
function advanceToStep(state: GameState, step: string, reg: Registry, max = 400): GameState {
  let s = state;
  let guard = 0;
  while (s.step !== step && !s.gameOver && guard++ < max) s = pass(s, reg);
  return s;
}

function advanceUntilActive(state: GameState, player: PlayerId, reg: Registry, max = 800): GameState {
  let s = state;
  let guard = 0;
  while ((s.activePlayer !== player || s.step !== 'precombatMain') && !s.gameOver && guard++ < max) {
    s = pass(s, reg);
  }
  return s;
}

function resolveStack(state: GameState, reg: Registry, max = 50): GameState {
  let s = state;
  let guard = 0;
  while (s.stack.length > 0 && !s.gameOver && guard++ < max) s = pass(s, reg);
  return s;
}

function floodMana(state: GameState): void {
  state.players[state.activePlayer].manaPool = { W: 9, U: 9, B: 9, R: 9, G: 9, C: 9 };
}

/** Place a permanent that is already past summoning sickness; return its id. */
function place(state: GameState, def: CardDefinition, controller: PlayerId): InstanceId {
  const id = state.nextInstanceId++;
  state.battlefield.push({
    instanceId: id,
    def,
    controller,
    owner: controller,
    zone: 'battlefield',
    tapped: false,
    summoningSick: false,
    damageMarked: 0,
    markedByDeathtouch: false,
    counters: {},
  });
  return id;
}

function giveHand(state: GameState, player: PlayerId, def: CardDefinition): InstanceId {
  const inst: CardInstance = {
    instanceId: state.nextInstanceId++,
    def,
    controller: player,
    owner: player,
    zone: 'hand',
    tapped: false,
    summoningSick: false,
    damageMarked: 0,
    markedByDeathtouch: false,
    counters: {},
  };
  state.players[player].hand.push(inst);
  return inst.instanceId;
}

function pt(state: GameState, id: InstanceId): { power: number; toughness: number } {
  const inst = state.battlefield.find((c) => c.instanceId === id)!;
  const mod = indexContinuous(state).get(id) ?? NO_MOD;
  return { power: effectivePower(inst, mod), toughness: effectiveToughness(inst, mod) };
}

/** Total mana floating for a player — how much one tap was actually worth. */
function poolTotal(state: GameState, player: PlayerId): number {
  const pool = state.players[player].manaPool;
  return pool.W + pool.U + pool.B + pool.R + pool.G + pool.C;
}

// --- lands: enters tapped, and one tap is worth ONE mana of a CHOSEN colour -----

describe('Azorius Guildgate — a real tapped dual land', () => {
  it('arrives tapped, then taps for exactly one mana of the colour you choose', () => {
    const reg = buildRegistry();
    const { state } = createGame({
      seed: SEEDS.guildgate,
      decks: { A: deck(FOREST), B: deck(FOREST) },
      registry: reg,
    });
    let s = advanceToStep(state, 'precombatMain', reg);

    const gateId = giveHand(s, 'A', getByName('Azorius Guildgate'));
    s = act(s, { kind: 'playLand', player: 'A', instanceId: gateId }, reg);

    // Printed drawback: it enters tapped, so it produces nothing this turn.
    const gate = s.battlefield.find((c) => c.instanceId === gateId)!;
    expect(gate.tapped).toBe(true);
    expect(
      generateLegalActions(s, DEFAULT_RULES).some(
        (a) => a.kind === 'tapForMana' && a.instanceId === gateId,
      ),
    ).toBe(false);

    // Next turn (round the table and back) it untaps and offers ONE action per
    // colour — a choice, not a bundle.
    s = advanceUntilActive(s, 'B', reg);
    s = advanceUntilActive(s, 'A', reg);
    expect(s.battlefield.find((c) => c.instanceId === gateId)!.tapped).toBe(false);
    expect(manaModesOf(getByName('Azorius Guildgate'))).toEqual([{ W: 1 }, { U: 1 }]);

    const taps = generateLegalActions(s, DEFAULT_RULES).filter(
      (a): a is Extract<GameAction, { kind: 'tapForMana' }> =>
        a.kind === 'tapForMana' && a.instanceId === gateId,
    );
    expect(taps).toHaveLength(2);

    // Take the blue mode: exactly one {U} floats, and nothing else.
    const blueMode = manaModesOf(getByName('Azorius Guildgate')).findIndex((m) => m.U === 1);
    s = act(s, { kind: 'tapForMana', player: 'A', instanceId: gateId, mode: blueMode }, reg);
    expect(s.players.A.manaPool.U).toBe(1);
    expect(poolTotal(s, 'A')).toBe(1); // NOT a two-mana land
  });
});

describe('Tranquil Cove — the tapped dual that also gains you a life', () => {
  it('fires its enters-the-battlefield trigger for exactly 1 life', () => {
    const reg = buildRegistry();
    const { state } = createGame({
      seed: SEEDS.refuge,
      decks: { A: deck(FOREST), B: deck(FOREST) },
      registry: reg,
    });
    let s = advanceToStep(state, 'precombatMain', reg);
    const lifeBefore = s.players.A.life;

    const coveId = giveHand(s, 'A', getByName('Tranquil Cove'));
    s = act(s, { kind: 'playLand', player: 'A', instanceId: coveId }, reg);
    s = resolveStack(s, reg);

    expect(s.players.A.life).toBe(lifeBefore + 1);
    expect(s.battlefield.find((c) => c.instanceId === coveId)!.tapped).toBe(true);
  });
});

// --- ETB triggers on creatures --------------------------------------------------

describe('Wall of Omens — an enters-the-battlefield draw', () => {
  it('casting it draws exactly one card and leaves a 0/4 defender behind', () => {
    const reg = buildRegistry();
    const { state } = createGame({
      seed: SEEDS.etbDraw,
      decks: { A: deck(FOREST), B: deck(FOREST) },
      registry: reg,
    });
    let s = advanceToStep(state, 'precombatMain', reg);
    floodMana(s);

    const handBefore = s.players.A.hand.length;
    const wallId = giveHand(s, 'A', getByName('Wall of Omens'));
    s = act(s, { kind: 'castSpell', player: 'A', instanceId: wallId, targets: [] }, reg);
    s = resolveStack(s, reg);

    const wall = s.battlefield.find((c) => c.instanceId === wallId);
    expect(wall).toBeDefined();
    expect(wall!.def.keywords?.defender).toBe(true);
    expect(pt(s, wallId)).toEqual({ power: 0, toughness: 4 });
    // The Wall was added to hand after `handBefore` and then left it to be cast,
    // so the net +1 is the ETB draw and nothing else.
    expect(s.players.A.hand.length).toBe(handBefore + 1);
  });
});

describe('token makers — Attended Knight and Beetleback Chief', () => {
  it('put the printed number of 1/1 tokens onto the battlefield', () => {
    const reg = buildRegistry();
    const { state } = createGame({
      seed: SEEDS.tokens,
      decks: { A: deck(FOREST), B: deck(FOREST) },
      registry: reg,
    });
    let s = advanceToStep(state, 'precombatMain', reg);
    floodMana(s);

    const knightId = giveHand(s, 'A', getByName('Attended Knight'));
    s = act(s, { kind: 'castSpell', player: 'A', instanceId: knightId, targets: [] }, reg);
    s = resolveStack(s, reg);
    const soldiers = s.battlefield.filter((c) => c.def.name === 'Soldier');
    expect(soldiers).toHaveLength(1);
    expect(soldiers[0]!.controller).toBe('A');
    expect([soldiers[0]!.def.power, soldiers[0]!.def.toughness]).toEqual([1, 1]);
    expect(s.battlefield.find((c) => c.instanceId === knightId)!.def.keywords?.firstStrike).toBe(true);

    floodMana(s);
    const chiefId = giveHand(s, 'A', getByName('Beetleback Chief'));
    s = act(s, { kind: 'castSpell', player: 'A', instanceId: chiefId, targets: [] }, reg);
    s = resolveStack(s, reg);
    expect(s.battlefield.filter((c) => c.def.name === 'Goblin')).toHaveLength(2);
  });
});

// --- removal --------------------------------------------------------------------

describe('removal — Murder, Grasp of Darkness, Day of Judgment', () => {
  it('Murder destroys the creature it targets', () => {
    const reg = buildRegistry();
    const { state } = createGame({
      seed: SEEDS.removal,
      decks: { A: deck(FOREST), B: deck(FOREST) },
      registry: reg,
    });
    let s = advanceToStep(state, 'precombatMain', reg);
    floodMana(s);
    const victimId = place(s, getByName('Craw Wurm'), 'B'); // a 6/4 damage can't reach

    const murderId = giveHand(s, 'A', getByName('Murder'));
    s = act(s, { kind: 'castSpell', player: 'A', instanceId: murderId, targets: [victimId] }, reg);
    s = resolveStack(s, reg);

    expect(s.battlefield.find((c) => c.instanceId === victimId)).toBeUndefined();
    expect(s.players.B.graveyard.some((c) => c.def.name === 'Craw Wurm')).toBe(true);
  });

  it('Grasp of Darkness shrinks a creature to death via state-based actions', () => {
    const reg = buildRegistry();
    const { state } = createGame({
      seed: SEEDS.removal,
      decks: { A: deck(FOREST), B: deck(FOREST) },
      registry: reg,
    });
    let s = advanceToStep(state, 'precombatMain', reg);
    floodMana(s);
    const bigId = place(s, getByName('Leatherback Baloth'), 'B'); // 4/5 — survives
    const smallId = place(s, getByName('Kalonian Tusker'), 'B'); // 3/3 — dies to -4/-4

    const grasp1 = giveHand(s, 'A', getByName('Grasp of Darkness'));
    s = act(s, { kind: 'castSpell', player: 'A', instanceId: grasp1, targets: [smallId] }, reg);
    s = resolveStack(s, reg);
    expect(s.battlefield.find((c) => c.instanceId === smallId)).toBeUndefined();

    floodMana(s);
    const grasp2 = giveHand(s, 'A', getByName('Grasp of Darkness'));
    s = act(s, { kind: 'castSpell', player: 'A', instanceId: grasp2, targets: [bigId] }, reg);
    s = resolveStack(s, reg);
    // 4/5 → 0/1: still alive, and visibly shrunk through the continuous layer.
    expect(pt(s, bigId)).toEqual({ power: 0, toughness: 1 });
  });

  it('Day of Judgment wipes every creature on both sides', () => {
    const reg = buildRegistry();
    const { state } = createGame({
      seed: SEEDS.wipe,
      decks: { A: deck(FOREST), B: deck(FOREST) },
      registry: reg,
    });
    let s = advanceToStep(state, 'precombatMain', reg);
    floodMana(s);
    place(s, getByName('Grizzly Bears'), 'A');
    place(s, getByName('Air Elemental'), 'B');
    place(s, getByName('Vampire Nighthawk'), 'B');

    const wipeId = giveHand(s, 'A', getByName('Day of Judgment'));
    s = act(s, { kind: 'castSpell', player: 'A', instanceId: wipeId, targets: [] }, reg);
    s = resolveStack(s, reg);

    expect(s.battlefield.filter((c) => c.def.types.includes('creature'))).toHaveLength(0);
  });
});

// --- combat keywords ------------------------------------------------------------

describe('Vampire Nighthawk — flying + deathtouch + lifelink in real combat', () => {
  it('kills a much bigger blocker with one damage and gains its controller life', () => {
    const reg = buildRegistry();
    const { state } = createGame({
      seed: SEEDS.nighthawk,
      decks: { A: deck(FOREST), B: deck(FOREST) },
      registry: reg,
    });
    let s = advanceToStep(state, 'precombatMain', reg);
    const hawkId = place(s, getByName('Vampire Nighthawk'), 'A'); // 2/3 flyer
    // It flies, so only a flyer can block it — and this one hits back hard enough
    // to kill it, which is exactly the trade the printed card makes.
    const blockerId = place(s, getByName('Air Elemental'), 'B'); // 4/4 flying
    const lifeBefore = s.players.A.life;

    s = advanceToStep(s, 'declareAttackers', reg);
    s = act(s, { kind: 'declareAttackers', player: 'A', attackers: [hawkId] }, reg);
    s = advanceToStep(s, 'declareBlockers', reg);
    s = act(
      s,
      { kind: 'declareBlockers', player: 'B', blocks: [{ blocker: blockerId, attacker: hawkId }] },
      reg,
    );

    // Step through the damage step collecting events, so lifelink can be checked
    // against the damage the engine actually assigned rather than a guess.
    const events: GameEvent[] = [];
    let guard = 0;
    while (s.step !== 'end' && !s.gameOver && guard++ < 100) {
      const result = applyAction(s, { kind: 'passPriority', player: s.priorityPlayer }, DEFAULT_RULES, reg);
      events.push(...result.events);
      s = result.state;
    }

    // Deathtouch: whatever damage the Nighthawk assigned was lethal to a 4/4.
    expect(s.battlefield.find((c) => c.instanceId === blockerId)).toBeUndefined();
    // Lifelink: its controller gained exactly the damage it dealt.
    const dealt = events
      .filter(
        (e): e is Extract<GameEvent, { type: 'damageDealt' }> =>
          e.type === 'damageDealt' && e.source === hawkId,
      )
      .reduce((sum, e) => sum + e.amount, 0);
    expect(dealt).toBeGreaterThan(0);
    expect(s.players.A.life).toBe(lifeBefore + dealt);
    // …and the Nighthawk itself died to the 4 damage back, as printed.
    expect(s.battlefield.find((c) => c.instanceId === hawkId)).toBeUndefined();
  });
});

// --- spells with two halves -----------------------------------------------------

describe('Lightning Helix — damage AND lifegain, from one printed sentence', () => {
  it('deals 3 to the opponent and gains 3, in the same resolution', () => {
    const reg = buildRegistry();
    const { state } = createGame({
      seed: SEEDS.helix,
      decks: { A: deck(MOUNTAIN), B: deck(MOUNTAIN) },
      registry: reg,
    });
    let s = advanceToStep(state, 'precombatMain', reg);
    floodMana(s);
    const myLife = s.players.A.life;
    const theirLife = s.players.B.life;

    const helixId = giveHand(s, 'A', getByName('Lightning Helix'));
    s = act(s, { kind: 'castSpell', player: 'A', instanceId: helixId, targets: ['B'] }, reg);
    s = resolveStack(s, reg);

    expect(s.players.B.life).toBe(theirLife - 3);
    expect(s.players.A.life).toBe(myLife + 3);
  });
});

describe('Kiln Fiend — a cast trigger that pumps itself', () => {
  it('grows +3/+0 when an instant is cast, and is back to 1/2 next turn', () => {
    const reg = buildRegistry();
    const { state } = createGame({
      seed: SEEDS.kilnFiend,
      decks: { A: deck(MOUNTAIN), B: deck(MOUNTAIN) },
      registry: reg,
    });
    let s = advanceToStep(state, 'precombatMain', reg);
    const fiendId = place(s, getByName('Kiln Fiend'), 'A');
    floodMana(s);
    expect(pt(s, fiendId)).toEqual({ power: 1, toughness: 2 });

    const shockId = giveHand(s, 'A', getByName('Shock'));
    s = act(s, { kind: 'castSpell', player: 'A', instanceId: shockId, targets: ['B'] }, reg);
    s = resolveStack(s, reg);
    expect(pt(s, fiendId)).toEqual({ power: 4, toughness: 2 });

    s = advanceUntilActive(s, 'B', reg);
    expect(pt(s, fiendId)).toEqual({ power: 1, toughness: 2 });
  });
});

describe('Pelakka Wurm — an enters trigger AND a dies trigger on one card', () => {
  it('gains 7 life on arrival and draws a card when it dies', () => {
    const reg = buildRegistry();
    const { state } = createGame({
      seed: SEEDS.pelakka,
      decks: { A: deck(FOREST), B: deck(FOREST) },
      registry: reg,
    });
    let s = advanceToStep(state, 'precombatMain', reg);
    floodMana(s);
    const lifeBefore = s.players.A.life;

    const wurmId = giveHand(s, 'A', getByName('Pelakka Wurm'));
    s = act(s, { kind: 'castSpell', player: 'A', instanceId: wurmId, targets: [] }, reg);
    s = resolveStack(s, reg);
    expect(s.players.A.life).toBe(lifeBefore + 7);

    const handBefore = s.players.A.hand.length;
    floodMana(s);
    const murderId = giveHand(s, 'A', getByName('Murder'));
    s = act(s, { kind: 'castSpell', player: 'A', instanceId: murderId, targets: [wurmId] }, reg);
    s = resolveStack(s, reg);

    expect(s.battlefield.find((c) => c.instanceId === wurmId)).toBeUndefined();
    // The Murder was added after `handBefore` and left the hand to be cast, so
    // the net +1 is the card the dies trigger drew.
    expect(s.players.A.hand.length).toBe(handBefore + 1);
  });
});

// --- artifacts ------------------------------------------------------------------

describe('Manalith — an any-colour rock is FIVE modes, not five mana', () => {
  it('offers one tap action per colour and adds exactly one mana', () => {
    const reg = buildRegistry();
    const { state } = createGame({
      seed: SEEDS.modalRock,
      decks: { A: deck(FOREST), B: deck(FOREST) },
      registry: reg,
    });
    let s = advanceToStep(state, 'precombatMain', reg);
    const rockId = place(s, getByName('Manalith'), 'A');

    const modes = manaModesOf(getByName('Manalith'));
    expect(modes).toEqual([{ W: 1 }, { U: 1 }, { B: 1 }, { R: 1 }, { G: 1 }]);

    const blackMode = modes.findIndex((m) => m.B === 1);
    s = act(s, { kind: 'tapForMana', player: 'A', instanceId: rockId, mode: blackMode }, reg);
    expect(s.players.A.manaPool.B).toBe(1);
    expect(poolTotal(s, 'A')).toBe(1);
  });
});

describe('Ornithopter — a genuinely free artifact creature', () => {
  it('can be cast with an empty mana pool and enters as a 0/2 flyer', () => {
    const reg = buildRegistry();
    const { state } = createGame({
      seed: SEEDS.freeArtifact,
      decks: { A: deck(FOREST), B: deck(FOREST) },
      registry: reg,
    });
    let s = advanceToStep(state, 'precombatMain', reg);
    expect(poolTotal(s, 'A')).toBe(0);

    const thopterId = giveHand(s, 'A', getByName('Ornithopter'));
    s = act(s, { kind: 'castSpell', player: 'A', instanceId: thopterId, targets: [] }, reg);
    s = resolveStack(s, reg);

    const thopter = s.battlefield.find((c) => c.instanceId === thopterId);
    expect(thopter).toBeDefined();
    expect(thopter!.def.keywords?.flying).toBe(true);
    expect(pt(s, thopterId)).toEqual({ power: 0, toughness: 2 });
  });
});

// --- the wide net: play EVERY compiled card in a real game ----------------------

describe('every compiled card resolves in a real game', () => {
  /**
   * Cast or play each compiled card in turn against a live game and collect every
   * event. `effectUnsupported` is the failure we are hunting: it is what core
   * emits when a card names a primitive nothing implements, which is exactly the
   * "in the pool but does nothing" card the compiler is supposed to make
   * impossible.
   */
  it('never emits effectUnsupported and always leaves the game in a legal state', () => {
    const reg = buildRegistry();
    const { state } = createGame({
      seed: SEEDS.wholePool,
      decks: { A: deck(FOREST, 200), B: deck(FOREST, 200) },
      registry: reg,
    });
    let s = advanceToStep(state, 'precombatMain', reg);

    const events: GameEvent[] = [];
    const drive = (action: GameAction): void => {
      const result = applyAction(s, action, DEFAULT_RULES, reg);
      events.push(...result.events);
      s = result.state;
    };
    // Resolve the stack, ANSWERING any question a resolution asks along the way.
    // Modal spells ask which modes at cast, an {X} spell asks for X, a kicker
    // asks whether to pay — all of them park a `pendingChoice` that blocks every
    // later action until it is answered. The answer is taken from
    // `generateLegalActions`, so this stays data-driven: no card is special-cased
    // here, and a new question kind is answered the day it is added.
    const settle = (max = 200): void => {
      let guard = 0;
      while ((s.stack.length > 0 || s.pendingChoice != null) && !s.gameOver && guard++ < max) {
        const answer = s.pendingChoice
          ? generateLegalActions(s).find((a) => a.kind === 'answerChoice')
          : undefined;
        drive(answer ?? { kind: 'passPriority', player: s.priorityPlayer });
      }
    };

    // A punching bag so targeted spells always have something legal to hit, and
    // a fat one so a board wipe has work to do.
    let dummyId = place(s, { id: 'dummy', name: 'Dummy', types: ['creature'], power: 1, toughness: 9 }, 'B');

    let cast = 0;
    for (const card of EXPANDED_CARD_POOL) {
      if (s.gameOver) break;
      if (!s.battlefield.some((c) => c.instanceId === dummyId)) {
        dummyId = place(s, { id: 'dummy', name: 'Dummy', types: ['creature'], power: 1, toughness: 9 }, 'B');
      }
      const id = giveHand(s, 'A', card);
      if (card.types.includes('land')) {
        // One land per turn — drop this one straight onto the battlefield instead
        // of fighting the land-drop rule; the point here is that it RESOLVES.
        s.players.A.hand = s.players.A.hand.filter((c) => c.instanceId !== id);
        const inst: CardInstance = {
          instanceId: id,
          def: card,
          controller: 'A',
          owner: 'A',
          zone: 'battlefield',
          tapped: card.entersTapped === true,
          summoningSick: false,
          damageMarked: 0,
          markedByDeathtouch: false,
          counters: {},
        };
        s.battlefield.push(inst);
        continue;
      }
      floodMana(s);
      // Targets come from the card's own data, exactly as the game UI derives
      // them — never from a per-card special case.
      // A card that declares a printed target restriction is targeted THROUGH the
      // engine's own legality seam — the same one `generateLegalActions` and
      // `applyCastSpell` use — so this test cannot drift from what the engine
      // considers legal. Only the unrestricted leftovers fall back to reading
      // primitive ids.
      const refs = [...(card.effects ?? [])];
      const restriction = targetRestrictionOf(card);
      const wantsPlayer = refs.some(
        (ref) => ref.primitive === 'dealDamage' || ref.primitive === 'loseLife',
      );
      const wantsPermanent = refs.some((ref) =>
        ['destroyTarget', 'exileTarget', 'tapTarget', 'pumpUntilEndOfTurn', 'grantKeywordUntilEndOfTurn'].includes(
          ref.primitive,
        ),
      );
      const legal = restriction === undefined ? [] : legalTargetsFor(s, restriction);
      // A restricted spell with no legal target cannot be cast at all (a
      // counterspell with an empty stack) — skip it rather than assert a
      // rejection the engine is right to make.
      if (restriction !== undefined && legal.length === 0) continue;
      // The punching bag when it is legal, and otherwise whatever the ENGINE
      // says is legal — "destroy target artifact" has to be pointed at an
      // artifact, and falling back to the creature dummy would assert a
      // rejection the engine is right to make.
      const targets: Array<InstanceId | PlayerId> =
        restriction !== undefined
          ? [legal.find((t) => t === dummyId || t === 'B') ?? legal[0]!]
          : wantsPermanent
            ? [dummyId]
            : wantsPlayer
              ? ['B']
              : [];
      drive({ kind: 'castSpell', player: 'A', instanceId: id, targets });
      settle();
      cast += 1;
    }

    expect(cast).toBeGreaterThan(0);
    expect(events.map((e) => e.type)).not.toContain('effectUnsupported');
    expect(events.some((e) => e.type === 'actionRejected')).toBe(false);
  });

  /**
   * The end-to-end proof: two decks built ONLY from compiled cards play a whole
   * game against each other, driven by a tiny greedy policy over the engine's own
   * `generateLegalActions`. Nothing is hand-placed and nothing is hand-resolved —
   * if these cards could not be cast, tapped for, attacked with or resolved, the
   * game would stall out instead of reaching a winner.
   */
  it('two decks made only of compiled cards play a full game to a winner', () => {
    const reg = buildRegistry();
    const byName = (name: string): CardDefinition => {
      const card = EXPANDED_CARD_POOL.find((entry) => entry.name === name);
      if (!card) throw new Error(`expanded pool missing ${name}`);
      return card;
    };
    /** Build a deck as counts of compiled cards (data, not a per-card branch). */
    const build = (recipe: ReadonlyArray<readonly [string, number]>): { cards: CardDefinition[] } => ({
      cards: recipe.flatMap(([name, count]) =>
        Array.from({ length: count }, () => (name === 'Mountain' || name === 'Plains' || name === 'Swamp'
          ? getByName(name)
          : byName(name))),
      ),
    });

    // Boros beatdown vs Dimir removal — two real archetypes, all-compiled.
    const boros = build([
      ['Mountain', 10],
      ['Plains', 8],
      ['Boros Guildgate', 4],
      ['Savannah Lions', 4],
      ['Goblin Piker', 4],
      ['Skyknight Legionnaire', 4],
      ['Shock', 4],
      ['Lightning Helix', 4],
      ['Attended Knight', 4],
    ]);
    const dimir = build([
      ['Swamp', 12],
      ['Dimir Guildgate', 4],
      ['Vampire Nighthawk', 4],
      ['Child of Night', 4],
      ['Murder', 4],
      ['Last Gasp', 4],
      ['Wind Drake', 4],
      ['Divination', 4],
    ]);

    const { state } = createGame({ seed: SEEDS.wholePool, decks: { A: boros, B: dimir }, registry: reg });
    let s = state;
    const events: GameEvent[] = [];

    // Greedy policy: take the first non-pass action offered, else pass. Crude on
    // purpose — this test is about the CARDS working, not about playing well.
    const MAX_ACTIONS = 20_000;
    let steps = 0;
    while (!s.gameOver && steps++ < MAX_ACTIONS) {
      const legal = generateLegalActions(s, DEFAULT_RULES);
      // "First castSpell offered" is no longer crude-but-harmless: the engine now
      // offers a restricted spell once per LEGAL target, and your own creatures are
      // legal targets for removal. A policy that took the first offer would Murder
      // its own board every time, so it prefers a cast aimed at the other side —
      // still the dumbest policy that plays the cards, just not a suicidal one.
      const castsAtOpponent = legal.filter((a) => a.kind === 'castSpell' && !aimedAtOwnSide(s, a));
      const choice =
        legal.find((a) => a.kind === 'playLand') ??
        legal.find((a) => a.kind === 'tapForMana') ??
        castsAtOpponent[0] ??
        legal.find((a) => a.kind === 'castSpell') ??
        legal.find((a) => a.kind === 'declareAttackers' && a.attackers.length > 0) ??
        legal[0];
      if (!choice) break;
      const result = applyAction(s, choice, DEFAULT_RULES, reg);
      events.push(...result.events);
      s = result.state;
    }

    expect(s.gameOver, `game did not finish in ${MAX_ACTIONS} actions`).toBe(true);
    expect(s.winner === 'A' || s.winner === 'B').toBe(true);
    expect(events.map((e) => e.type)).not.toContain('effectUnsupported');
    // Every family of card in these two decks did its job in this one game:
    // spells resolved, damage landed, life moved, and REMOVAL genuinely killed
    // things. That last one is the assertion that would have failed before target
    // legality existed: a bare `castSpell` of Murder or Last Gasp carried no
    // target, so the spell resolved into nothing and the removal half of the Dimir
    // deck was blank. Now it kills — which is also why this game is a grind rather
    // than a race, and why the winner is no longer required to win on damage.
    const loser = s.winner === 'A' ? 'B' : 'A';
    const startingLife = s.players[loser].life;
    expect(events.filter((e) => e.type === 'spellCast').length).toBeGreaterThan(0);
    expect(events.filter((e) => e.type === 'damageDealt').length).toBeGreaterThan(0);
    expect(events.filter((e) => e.type === 'creatureDied').length).toBeGreaterThan(0);
    expect(startingLife).toBeLessThan(DEFAULT_RULES.startingLife);
  });

  it('every compiled mana source is worth exactly one activation of its best mode', () => {
    // A mana source that "taps for five" is the classic silent pool bug (it used
    // to be how an any-colour source had to be authored). Assert the shape data
    // directly: no compiled source may add more than the printed maximum.
    const PRINTED_MAX_PER_TAP = 2; // Sol Ring / Palladium Myr style {C}{C}
    // The exceptions are BY NAME rather than a raised ceiling, because raising
    // the number to fit the biggest rock would retire the guard: "taps for
    // three" has to stay a failure for every card that does not print it.
    const PRINTS_THREE = new Map<string, number>([
      ['Gilded Lotus', 3], // "{T}: Add three mana of any one color."
      ['Thran Dynamo', 3], // "{T}: Add {C}{C}{C}."
    ]);
    for (const card of EXPANDED_CARD_POOL) {
      const modes = manaModesOf(card);
      if (modes.length === 0) continue;
      const cap = PRINTS_THREE.get(card.name) ?? PRINTED_MAX_PER_TAP;
      for (const mode of modes) {
        const total = Object.values(mode).reduce((sum, n) => sum + (n ?? 0), 0);
        expect(total, `${card.name} mode adds ${total} mana`).toBeLessThanOrEqual(cap);
        expect(total, `${card.name} has an empty mana mode`).toBeGreaterThan(0);
      }
    }
    // And the allowlist is not allowed to rot: a name that leaves the pool has
    // to leave the list with it, or the next big rock inherits its exemption.
    const poolNames = new Set(EXPANDED_CARD_POOL.map((card) => card.name));
    expect([...PRINTS_THREE.keys()].filter((name) => !poolNames.has(name))).toEqual([]);
  });
});

/**
 * Whether a cast aims at something the caster controls (their own creature, or
 * their own face). Used only by the self-driving game's policy — see the comment
 * at its call site.
 */
function aimedAtOwnSide(state: GameState, action: GameAction): boolean {
  if (action.kind !== 'castSpell') return false;
  return (action.targets ?? []).some(
    (target) =>
      target === action.player ||
      state.battlefield.some((c) => c.instanceId === target && c.controller === action.player),
  );
}
