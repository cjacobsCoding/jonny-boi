/**
 * Delver of Secrets, un-stubbed — the whole card, played through the real
 * engine with the real registry.
 *
 * The compiler half: the real Scryfall record (a two-faced `transform` card)
 * must compile `'complete'` with BOTH faces implemented and linked, and the
 * layouts whose second face is CASTABLE (modal DFC / split) must keep
 * reporting — their gap is the cast-time face choice, which is a different
 * (in-progress) system, and compiling their front face alone would be a card
 * strictly weaker than printed.
 *
 * The gameplay half: the upkeep look/reveal is one top-of-library selection
 * whose valence follows the top card (reveal a matching instant → transform;
 * decline, or reveal a blank → stay), the transform swaps every characteristic
 * to Insectile Aberration, and a bounced Aberration is a Delver in hand again
 * (CR 712.8a).
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type {
  CardDefinition,
  CardInstance,
  GameAction,
  GameEvent,
  GameState,
  PlayerId,
} from '@jonny-boi/core';
import {
  applyAction,
  createGame,
  DEFAULT_RULES,
  defaultAnswerFor,
  generateLegalActions,
} from '@jonny-boi/core';
import { CARD_POOL } from '../data/pool.js';
import { buildRegistry } from './pool.js';
import { compileCard } from './compile/index.js';
import { BACK_FACE_ID_SUFFIX, SECOND_CASTABLE_FACE_GAP } from './compile/compile.js';
import type { CompilableCard } from './compile/index.js';

const SEED = 20260817;

const index = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../data-tools/data/card-index.json', import.meta.url)), 'utf8'),
) as { cards: readonly CompilableCard[] };

function poolCard(name: string): CardDefinition {
  const card = CARD_POOL.find((entry) => entry.name === name);
  if (!card) throw new Error(`pool missing ${name}`);
  return card;
}

const DELVER = poolCard('Delver of Secrets');
const BOLT = poolCard('Lightning Bolt');
const MOUNTAIN = poolCard('Mountain');

describe('the compiler plays both faces or reports the card', () => {
  it('compiles the real Delver record complete, with both faces linked', () => {
    const record = index.cards.find((card) => card.name === 'Delver of Secrets // Insectile Aberration');
    expect(record, 'Delver left the committed card index').toBeDefined();
    const result = compileCard(record!);

    expect(result.status, `missing: ${JSON.stringify(result.missing)}`).toBe('complete');
    const front = result.definition;
    expect(front.name).toBe('Delver of Secrets');
    expect(front.power).toBe(1);
    expect(front.toughness).toBe(1);
    expect(front.keywords).toBeUndefined(); // Flying is the BACK face's ability
    expect(front.triggers).toHaveLength(1);
    expect(front.triggers![0]!.condition).toEqual({ on: 'upkeep', who: 'you' });
    expect(front.triggers![0]!.effects).toEqual([
      { primitive: 'transformRevealTop', params: { filter: { anyOfTypes: ['instant', 'sorcery'] } } },
    ]);

    const back = front.backFace;
    expect(back).toBeDefined();
    expect(back!.isBackFace).toBe(true);
    expect(back!.id).toBe(`${front.id}${BACK_FACE_ID_SUFFIX}`);
    expect(back!.name).toBe('Insectile Aberration');
    expect(back!.power).toBe(3);
    expect(back!.toughness).toBe(2);
    expect(back!.keywords?.flying).toBe(true);
    expect(back!.cost).toBeUndefined(); // a back face has no mana cost
    expect(result.matchedRules).toContain('transforming-dfc');
  });

  it('the authored pool Delver matches what the compiler independently produces', () => {
    const record = index.cards.find((card) => card.id === DELVER.id);
    const compiled = compileCard(record!).definition;
    expect(compiled.triggers).toEqual(
      DELVER.triggers!.map((t) => ({ ...t, label: compiled.triggers![0]!.label })),
    );
    expect({ ...compiled.backFace, id: undefined }).toEqual({ ...DELVER.backFace, id: undefined });
    expect(compiled.backFace!.id).toBe(DELVER.backFace!.id);
  });

  it('a MODAL DFC compiles BOTH faces, with the back one marked castable', () => {
    const modal: CompilableCard = {
      id: 'modal-test',
      name: 'Malakir Rebirth // Malakir Mire',
      layout: 'modal_dfc',
      manaCost: { generic: 0, W: 0, U: 0, B: 1, R: 0, G: 0, C: 0, other: [] },
      typeLine: { supertypes: [], types: ['Instant'], subtypes: [] },
      oracleText: '',
      power: null,
      toughness: null,
      keywords: [],
      faces: [
        {
          name: 'Malakir Rebirth',
          manaCost: { generic: 0, W: 0, U: 0, B: 1, R: 0, G: 0, C: 0, other: [] },
          typeLine: { supertypes: [], types: ['Instant'], subtypes: [] },
          oracleText: 'Draw a card.',
          power: null,
          toughness: null,
        },
        {
          name: 'Malakir Mire',
          manaCost: { generic: 0, W: 0, U: 0, B: 0, R: 0, G: 0, C: 0, other: [] },
          typeLine: { supertypes: [], types: ['Land'], subtypes: [] },
          oracleText: 'Malakir Mire enters tapped.',
          power: null,
          toughness: null,
        },
      ],
    };
    const result = compileCard(modal);
    expect(result.status, `missing: ${JSON.stringify(result.missing)}`).toBe('complete');
    // The FRONT face is the definition; the back rides nested, marked both as a
    // back face AND as castable. That second flag is the whole difference from a
    // transforming DFC, whose back face is never cast (CR 712.8b).
    expect(result.definition.name).toBe('Malakir Rebirth');
    expect(result.definition.backFaceCastable).toBe(true);
    expect(result.definition.backFace!.name).toBe('Malakir Mire');
    expect(result.definition.backFace!.isBackFace).toBe(true);
    expect(result.definition.backFace!.types).toEqual(['land']);
    // Each face keeps its OWN cost — a modal DFC's back face is really cast (or
    // played), unlike a transforming back face, which has no cost at all.
    expect(result.definition.cost).toEqual({ B: 1 });
    expect(result.definition.backFace!.cost).toBeUndefined();
  });

  it('a SPLIT card with no per-face data still reports — there is nothing to compile', () => {
    const split: CompilableCard = {
      id: 'split-test',
      name: 'Fire // Ice',
      manaCost: { generic: 0, W: 0, U: 0, B: 0, R: 1, G: 0, C: 0, other: [] },
      typeLine: { supertypes: [], types: ['Instant'], subtypes: [] },
      oracleText: 'Fire deals 2 damage divided as you choose.',
      power: null,
      toughness: null,
      keywords: [],
    };
    // Split cards SHIP (see `compile/split-cards.test.ts`) — but only from a
    // record that carries `layout: 'split'` and its two faces. This one carries
    // the combined name and nothing else, so both halves would have to be
    // guessed, and the compiler reports rather than guessing.
    const result = compileCard(split);
    expect(result.status).toBe('incomplete');
    expect(result.missing.map((gap) => gap.missingEngineSystem)).toContain(SECOND_CASTABLE_FACE_GAP);
  });

  it('a transform DFC with an unrecognized transform instruction still reports it', () => {
    const werewolf: CompilableCard = {
      id: 'werewolf-test',
      name: 'Village Watch // Village Reavers',
      layout: 'transform',
      manaCost: { generic: 4, W: 0, U: 0, B: 0, R: 0, G: 1, C: 0, other: [] },
      typeLine: { supertypes: [], types: ['Creature'], subtypes: ['Human', 'Werewolf'] },
      oracleText: '',
      power: 4,
      toughness: 4,
      keywords: ['Daybound'],
      faces: [
        {
          name: 'Village Watch',
          manaCost: { generic: 4, W: 0, U: 0, B: 0, R: 0, G: 1, C: 0, other: [] },
          typeLine: { supertypes: [], types: ['Creature'], subtypes: ['Human', 'Werewolf'] },
          oracleText: 'Haste\nDaybound',
          power: 4,
          toughness: 4,
        },
        {
          name: 'Village Reavers',
          manaCost: { generic: 0, W: 0, U: 0, B: 0, R: 0, G: 0, C: 0, other: [] },
          typeLine: { supertypes: [], types: ['Creature'], subtypes: ['Werewolf'] },
          oracleText: 'Haste\nNightbound',
          power: 5,
          toughness: 5,
        },
      ],
    };
    const result = compileCard(werewolf);
    expect(result.status).toBe('incomplete');
    // The day/night tracker has no system; both faces' Daybound/Nightbound
    // lines must be reported, never dropped.
    expect(result.missing.length).toBeGreaterThan(0);
  });
});

// --- gameplay ---------------------------------------------------------------------

/** Fresh instances of `defs` REPLACING a player's library, defs[0] on top. */
function setLibrary(state: GameState, player: PlayerId, defs: readonly CardDefinition[]): void {
  state.players[player].library = defs.map((def) => ({
    instanceId: state.nextInstanceId++,
    def,
    controller: player,
    owner: player,
    zone: 'library',
    tapped: false,
    summoningSick: false,
    damageMarked: 0,
    markedByDeathtouch: false,
    counters: {},
  }));
}

/** Put a fresh Delver onto A's battlefield of an already-running game. */
function placeDelver(state: GameState): CardInstance {
  const inst: CardInstance = {
    instanceId: state.nextInstanceId++,
    def: DELVER,
    controller: 'A',
    owner: 'A',
    zone: 'battlefield',
    tapped: false,
    summoningSick: false,
    damageMarked: 0,
    markedByDeathtouch: false,
    counters: {},
  };
  state.battlefield.push(inst);
  return inst;
}

/**
 * Drive a game (both seats passing) until A's upkeep trigger has resolved far
 * enough to ask its reveal question, then answer it. Returns the final state
 * and every event, so a test can assert both the play and the log.
 */
function playThroughUpkeep(
  topOfLibrary: CardDefinition,
  answer: 'reveal' | 'decline',
): { state: GameState; events: GameEvent[]; delverId: number } {
  const registry = buildRegistry();
  const { state: initial } = createGame({
    seed: SEED,
    decks: { A: { cards: Array.from({ length: 30 }, () => MOUNTAIN) }, B: { cards: Array.from({ length: 30 }, () => MOUNTAIN) } },
    registry,
  });
  let state = initial;
  const events: GameEvent[] = [];
  const delver = placeDelver(state);
  setLibrary(state, 'A', [topOfLibrary, MOUNTAIN, MOUNTAIN, MOUNTAIN, MOUNTAIN]);

  const drive = (action: Parameters<typeof applyAction>[1]): void => {
    const result = applyAction(state, action, DEFAULT_RULES, registry);
    events.push(...result.events);
    state = result.state;
  };

  // Pass until the reveal question is parked (it is asked when the upkeep
  // trigger RESOLVES, at A's next upkeep). The cap is generous but hard: a
  // wedged game fails the test rather than hanging the suite.
  //
  // The cleanup step's discard down to maximum hand size (CR 514.1) parks its own
  // question on the way, and it is answered and stepped past here rather than
  // mistaken for the reveal — this test is about the Delver's question, not about
  // whichever question happens to be first.
  let guard = 0;
  while (!isDelverReveal(state) && guard++ < 400) {
    const parked = state.pendingChoice;
    drive(
      parked
        ? {
            kind: 'answerChoice',
            player: parked.chooser,
            choiceId: parked.id,
            answer: defaultAnswerFor(parked),
          }
        : { kind: 'passPriority', player: state.priorityPlayer },
    );
  }
  expect(state.pendingChoice, 'the reveal question was never asked').toBeTruthy();
  const choice = state.pendingChoice!;
  expect(choice.kind).toBe('selectCards');
  if (choice.kind === 'selectCards') {
    // The look IS the offer: the single candidate is the top card, shown to
    // the chooser only (the public event carries just a count).
    expect(choice.candidates).toHaveLength(1);
    expect(choice.candidates[0]!.name).toBe(topOfLibrary.name);
    drive({
      kind: 'answerChoice',
      player: choice.chooser,
      choiceId: choice.id,
      answer: {
        kind: 'selectCards',
        instanceIds: answer === 'reveal' ? [choice.candidates[0]!.instanceId] : [],
      },
    });
  }
  return { state, events, delverId: delver.instanceId };
}

/**
 * Whether the parked question is DELVER'S reveal, as opposed to some other rule's
 * (the cleanup step's discard down to maximum hand size asks one too). Keyed on
 * the source name, which is the card that asked.
 */
function isDelverReveal(state: GameState): boolean {
  const parked = state.pendingChoice;
  return parked !== null && parked !== undefined && parked.sourceName === DELVER.name;
}

describe('Delver of Secrets plays exactly as printed', () => {
  it('revealing an instant on upkeep transforms it into a 3/2 flying Aberration', () => {
    const { state, events, delverId } = playThroughUpkeep(BOLT, 'reveal');
    const perm = state.battlefield.find((c) => c.instanceId === delverId);
    expect(perm).toBeDefined();
    expect(perm!.def.name).toBe('Insectile Aberration');
    expect(perm!.def.power).toBe(3);
    expect(perm!.def.toughness).toBe(2);
    expect(perm!.def.keywords?.flying).toBe(true);
    expect(perm!.printedDef).toBe(DELVER);
    expect(events.some((e) => e.type === 'transformed' && e.toName === 'Insectile Aberration')).toBe(true);
    // CR 712: not a zone change — the permanent never left the battlefield.
    expect(
      events.some((e) => e.type === 'zoneChange' && e.instanceId === delverId && e.from === 'battlefield'),
    ).toBe(false);
    // The reveal card itself did not move: still on top of the library.
    expect(state.players.A.library[0]!.def.name).toBe('Lightning Bolt');
  });

  it('declining the reveal leaves it a 1/1 Delver, and the top card stays hidden in place', () => {
    const { state, events, delverId } = playThroughUpkeep(BOLT, 'decline');
    const perm = state.battlefield.find((c) => c.instanceId === delverId);
    expect(perm!.def.name).toBe('Delver of Secrets');
    expect(perm!.def.power).toBe(1);
    expect(events.some((e) => e.type === 'transformed')).toBe(false);
    expect(state.players.A.library[0]!.def.name).toBe('Lightning Bolt');
  });

  it('revealing a LAND does nothing — the filter is real, not decorative', () => {
    const { state, events } = playThroughUpkeep(MOUNTAIN, 'reveal');
    expect(events.some((e) => e.type === 'transformed')).toBe(false);
    expect(state.battlefield.some((c) => c.def.name === 'Delver of Secrets')).toBe(true);
  });

  it('the reveal valence follows the top card, so a pilot reveals exactly when it should', () => {
    const bolt = playThroughUpkeep(BOLT, 'decline');
    const land = playThroughUpkeep(MOUNTAIN, 'decline');
    const boltAsk = bolt.events.find((e) => e.type === 'choiceAsked');
    const landAsk = land.events.find((e) => e.type === 'choiceAsked');
    // The PUBLIC log must not leak whether the top card matched: identical
    // prompt, identical option count, in both worlds.
    expect(boltAsk && landAsk).toBeTruthy();
    if (boltAsk?.type === 'choiceAsked' && landAsk?.type === 'choiceAsked') {
      expect(boltAsk.prompt).toBe(landAsk.prompt);
      expect(boltAsk.optionCount).toBe(landAsk.optionCount);
    }
  });

  it('a bounced Aberration returns to hand as a front-face Delver (CR 712.8a)', () => {
    const { state: transformed, delverId } = playThroughUpkeep(BOLT, 'reveal');
    const registry = buildRegistry();
    // Bounce it through the real primitive: a Boomerang-shaped spell.
    const bounce: CardDefinition = {
      id: 'test-bounce',
      name: 'Test Bounce',
      types: ['instant'],
      timing: 'instant',
      cost: { generic: 1 },
      effects: [{ primitive: 'returnToHand', params: {} }],
    };
    const state = transformed;
    state.players.A.manaPool = { W: 2, U: 2, B: 2, R: 2, G: 2, C: 2 };
    const spell: CardInstance = {
      instanceId: state.nextInstanceId++,
      def: bounce,
      controller: 'A',
      owner: 'A',
      zone: 'hand',
      tapped: false,
      summoningSick: false,
      damageMarked: 0,
      markedByDeathtouch: false,
      counters: {},
    };
    state.players.A.hand.push(spell);

    let s = state;
    const drive = (action: Parameters<typeof applyAction>[1]): void => {
      s = applyAction(s, action, DEFAULT_RULES, registry).state;
    };
    drive({ kind: 'castSpell', player: s.priorityPlayer, instanceId: spell.instanceId, targets: [delverId] });
    let guard = 0;
    while (s.stack.length > 0 && guard++ < 20) {
      drive({ kind: 'passPriority', player: s.priorityPlayer });
    }

    const inHand = s.players.A.hand.find((c) => c.instanceId === delverId);
    expect(inHand).toBeDefined();
    expect(inHand!.def).toBe(DELVER);
    expect(inHand!.def.name).toBe('Delver of Secrets');
    expect(inHand!.printedDef ?? null).toBeNull();
    // …and from hand it is offered as a castable FRONT face like any creature.
    s.priorityPlayer = 'A';
    s.activePlayer = 'A';
    s.step = 'precombatMain';
    s.stack = [];
    s.players.A.manaPool = { W: 2, U: 2, B: 2, R: 2, G: 2, C: 2 };
    const offers = generateLegalActions(s, DEFAULT_RULES).filter(
      (a) => a.kind === 'castSpell' && a.instanceId === delverId,
    );
    expect(offers.length).toBeGreaterThan(0);
  });

  it('an empty library asks nothing and hangs nothing', () => {
    const registry = buildRegistry();
    const { state: initial } = createGame({
      seed: SEED,
      decks: { A: { cards: Array.from({ length: 30 }, () => MOUNTAIN) }, B: { cards: Array.from({ length: 30 }, () => MOUNTAIN) } },
      registry,
    });
    let state = initial;
    placeDelver(state);
    // Nearly empty: the draw step must still find a card, so leave exactly the
    // cards the run will draw and none for the reveal to look at.
    setLibrary(state, 'A', []);
    let guard = 0;
    while (!state.gameOver && guard++ < 60 && !isDelverReveal(state)) {
      const parked = state.pendingChoice;
      const action: GameAction = parked
        ? {
            kind: 'answerChoice',
            player: parked.chooser,
            choiceId: parked.id,
            answer: defaultAnswerFor(parked),
          }
        : { kind: 'passPriority', player: state.priorityPlayer };
      state = applyAction(state, action, DEFAULT_RULES, registry).state;
    }
    // The game ended by decking (empty library) or ran on — either way, the
    // trigger never parked an unanswerable question. Other rules' questions (the
    // cleanup discard) are answered by the loop above and are not what is asserted.
    expect(isDelverReveal(state)).toBe(false);
  });
});
