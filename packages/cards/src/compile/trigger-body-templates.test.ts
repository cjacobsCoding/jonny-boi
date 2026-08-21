/**
 * TEMPLATE-GAP closures for TRIGGER **BODIES** — the half the "At the beginning
 * of…" family left behind.
 *
 * The triggers themselves all fire already: every printed scope, the "you may"
 * wrapper, the intervening "if", and the triggering player a body points at
 * (§3.21, §3.27). What kept a large corpus cluster reporting was the SENTENCE
 * AFTER THE COMMA — a body no rule in the table could read. These are the
 * bodies.
 *
 * Every closure is proven twice, per the compiler contract:
 *
 *   1. a REAL card printing the wording compiles `'complete'`, with the emitted
 *      params PINNED so they cannot silently drift, and
 *   2. that compiled definition PLAYS correctly in a real seeded game.
 *
 * The second half is not ceremony. This repo shipped "gains protection from red
 * until end of turn" doing NOTHING for weeks because its test asserted the
 * compiled effect refs and never played the card (§3.27). So every test below
 * puts the card on a battlefield, drives a real engine turn, answers the real
 * questions, and reads the RESULT — a permanent that moved zones, a land drop
 * the engine accepted or refused, a life total that changed.
 *
 * Alongside them sit the REFUSALS that keep it honest: the one-shot and the
 * permanent additional-land grants are four printed words apart and have
 * completely different lifetimes, so a test pins that neither compiles as the
 * other.
 */

import { describe, expect, it } from 'vitest';
import type {
  CardDefinition,
  CardInstance,
  ChoiceAnswer,
  GameState,
  PendingChoice,
  PlayerId,
  RulesConfig,
} from '@jonny-boi/core';
import {
  applyAction,
  createGame,
  DEFAULT_RULES,
  dumpState,
  generateLegalActions,
  maxLandPlaysFor,
} from '@jonny-boi/core';
import { compileCard } from './compile.js';
import type { CompilableCard } from './types.js';
import { buildRegistry } from '../pool.js';

type Registry = ReturnType<typeof buildRegistry>;

/** Seeds are fixed per test so any failure is reproducible. */
const SEEDS = Object.freeze({
  karooBounce: 720,
  karooOnlyLand: 721,
  fleshbag: 722,
  accursed: 723,
  azusa: 724,
  azusaDies: 728,
  azusaStack: 729,
  explore: 725,
  ritesOfFlourishing: 726,
  vensersJournal: 727,
});

const DECK_SIZE = 40;

const FOREST: CardDefinition = { id: 'Forest', name: 'Forest', types: ['land'], produces: ['G'] };
const ISLAND: CardDefinition = { id: 'Island', name: 'Island', types: ['land'], produces: ['U'] };
const BEAR: CardDefinition = {
  id: 'bear',
  name: 'Grizzly Bears',
  types: ['creature'],
  power: 2,
  toughness: 2,
  cost: { generic: 2 },
};
/**
 * A second, DISTINCT creature — needed because core auto-answers a choice with
 * exactly one legal answer (`isTrivialChoice`). A seat holding a single creature
 * is never ASKED which one to sacrifice; it simply loses it. So proving that
 * both seats are asked needs both seats to have a real decision.
 */
const OGRE: CardDefinition = {
  id: 'ogre',
  name: 'Ogre Battledriver',
  types: ['creature'],
  power: 3,
  toughness: 3,
  cost: { generic: 3 },
};

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

// --- the real cards, printed exactly as Scryfall has them ------------------------

const SIMIC_GROWTH_CHAMBER = makeCard({
  name: 'Simic Growth Chamber',
  typeLine: { supertypes: [], types: ['Land'], subtypes: [] },
  oracleText:
    "~ enters tapped.\nWhen ~ enters, return a land you control to its owner's hand.\n{T}: Add {G}{U}.",
});

const FLESHBAG_MARAUDER = makeCard({
  name: 'Fleshbag Marauder',
  typeLine: { supertypes: [], types: ['Creature'], subtypes: ['Human', 'Warrior'] },
  power: 2,
  toughness: 1,
  oracleText: 'When ~ enters, each player sacrifices a creature of their choice.',
});

const ACCURSED_MARAUDER = makeCard({
  name: 'Accursed Marauder',
  typeLine: { supertypes: [], types: ['Creature'], subtypes: ['Zombie', 'Knight'] },
  power: 2,
  toughness: 2,
  oracleText: 'When ~ enters, each player sacrifices a nontoken creature of their choice.',
});

const AZUSA = makeCard({
  name: 'Azusa, Lost but Seeking',
  typeLine: { supertypes: ['Legendary'], types: ['Creature'], subtypes: ['Human', 'Monk'] },
  power: 1,
  toughness: 2,
  oracleText: 'You may play two additional lands on each of your turns.',
});

const DRYAD_GROVE = makeCard({
  name: 'Dryad Test',
  typeLine: { supertypes: [], types: ['Creature'], subtypes: ['Dryad'] },
  power: 2,
  toughness: 4,
  oracleText: 'You may play an additional land on each of your turns.',
});

const EXPLORE = makeCard({
  name: 'Explore',
  typeLine: { supertypes: [], types: ['Sorcery'], subtypes: [] },
  oracleText: 'You may play an additional land this turn.\nDraw a card.',
});

const RITES_OF_FLOURISHING = makeCard({
  name: 'Rites of Flourishing',
  typeLine: { supertypes: [], types: ['Enchantment'], subtypes: [] },
  oracleText:
    "At the beginning of each player's draw step, that player draws an additional card.\nEach player may play an additional land on each of their turns.",
});

const VENSERS_JOURNAL = makeCard({
  name: "Venser's Journal",
  typeLine: { supertypes: [], types: ['Artifact'], subtypes: [] },
  oracleText:
    'You have no maximum hand size.\nAt the beginning of your upkeep, you gain 1 life for each card in your hand.',
});

// --- harness ---------------------------------------------------------------------

function deck(def: CardDefinition) {
  return { cards: Array.from({ length: DECK_SIZE }, () => def) };
}

/**
 * The hand-size limit is lifted for the same reason `step-trigger-templates.test.ts`
 * lifts it: a test here counts cards in a hand across turns, and the CR 514.1
 * cleanup discard would erase that evidence. The discard itself is pinned by
 * `engine.test.ts`, not avoided.
 */
const RULES: RulesConfig = { ...DEFAULT_RULES, maximumHandSize: Number.MAX_SAFE_INTEGER };

function act(state: GameState, action: Parameters<typeof applyAction>[1], reg: Registry): GameState {
  const result = applyAction(state, action, RULES, reg);
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

function answer(state: GameState, reg: Registry, value: ChoiceAnswer): GameState {
  const choice = state.pendingChoice;
  if (!choice) throw new Error(`no choice pending:\n${dumpState(state)}`);
  return act(
    state,
    { kind: 'answerChoice', player: choice.chooser, choiceId: choice.id, answer: value },
    reg,
  );
}

/** Settle the stack and every parked question, answering with `reply`. */
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

/** Advance (answering nothing) until the named step, or until a question parks. */
function advanceToStep(state: GameState, step: string, reg: Registry, max = 200): GameState {
  let s = state;
  let guard = 0;
  while (s.step !== step && !s.gameOver && !s.pendingChoice && guard++ < max) s = pass(s, reg);
  return s;
}

/**
 * Play forward to A's precombat main on a LATER turn, declining anything asked.
 * Used by the two lifetime tests, which are about what a NEW turn looks like.
 */
function playToOwnMainOnTurn(state: GameState, turn: number, reg: Registry, max = 400): GameState {
  let s = state;
  let guard = 0;
  while (
    (s.turnNumber < turn || s.activePlayer !== 'A' || s.step !== 'precombatMain') &&
    !s.gameOver &&
    guard++ < max
  ) {
    s = s.pendingChoice ? answer(s, reg, { kind: 'confirm', yes: false }) : pass(s, reg);
  }
  if (guard >= max) throw new Error(`never reached A's main on turn ${turn}:\n${dumpState(s)}`);
  return s;
}

let syntheticId = 84_000;

function instanceOf(
  def: CardDefinition,
  player: PlayerId,
  zone: 'battlefield' | 'hand',
): CardInstance {
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

function putOnBattlefield(state: GameState, def: CardDefinition, player: PlayerId): CardInstance {
  const card = instanceOf(def, player, 'battlefield');
  state.battlefield.push(card);
  return card;
}

function putInHand(state: GameState, def: CardDefinition, player: PlayerId): CardInstance {
  const card = instanceOf(def, player, 'hand');
  state.players[player].hand.push(card);
  return card;
}

/** Compile a card and hand back its definition, asserting it compiled COMPLETE. */
function compiledDef(card: CompilableCard): CardDefinition {
  const result = compileCard(card);
  expect(
    result.status,
    `${card.name} missing: ${result.missing.map((m) => m.text).join(' | ')}`,
  ).toBe('complete');
  return result.definition;
}

function gameAtMain(reg: Registry, seed: number, land: CardDefinition = FOREST): GameState {
  const { state } = createGame({
    seed,
    startingPlayer: 'A',
    registry: reg,
    decks: { A: deck(land), B: deck(land) },
  });
  // Empty hands, so nothing a test puts in a hand competes with an opening draw.
  state.players.A.hand = [];
  state.players.B.hand = [];
  return advanceToStep(state, 'precombatMain', reg);
}

function names(zone: readonly CardInstance[]): string[] {
  return zone.map((c) => c.def.name).sort();
}

function candidateNamed(choice: PendingChoice, name: string): number {
  if (choice.kind !== 'selectCards') throw new Error(`not a selectCards: ${choice.kind}`);
  const found = choice.candidates.find((c) => c.name === name);
  if (!found) {
    throw new Error(
      `no candidate named ${name} among ${choice.candidates.map((c) => c.name).join(', ')}`,
    );
  }
  return found.instanceId;
}

/** Flood a seat's pool so a cast under test is never a mana question. */
function floodMana(state: GameState, player: PlayerId): void {
  state.players[player].manaPool = { W: 9, U: 9, B: 9, R: 9, G: 9, C: 9 };
}

// --- the karoo lands: "return a land you control to its owner's hand" -------------

describe('bounce-land ETB — "return a land you control to its owner\'s hand"', () => {
  it('compiles COMPLETE with the chosen-at-resolution primitive and a land filter', () => {
    const result = compileCard(SIMIC_GROWTH_CHAMBER);
    expect(result.status).toBe('complete');
    expect(result.definition.triggers).toEqual([
      {
        condition: { on: 'etb' },
        effects: [{ primitive: 'returnChosenToHand', params: { filter: { anyOfTypes: ['land'] } } }],
        label: "Enters: return a land you control to its owner's hand",
      },
    ]);
    // It is NOT the targeted bounce: nothing is aimed, so the ability carries no
    // targets and cannot be fizzled by the chosen land becoming illegal.
    expect(result.definition.triggers?.[0]?.targets).toBeUndefined();
    // The land half of the card is still there — enters tapped, taps for {G}{U}.
    expect(result.definition.entersTapped).toBe(true);
    expect(result.definition.produces).toEqual(['G', 'U']);
  });

  it("PLAYS: the chosen land really leaves the battlefield for its owner's hand", () => {
    const reg = buildRegistry();
    const chamber = compiledDef(SIMIC_GROWTH_CHAMBER);
    let s = gameAtMain(reg, SEEDS.karooBounce);

    // Two ordinary lands already out, so the choice is a real one.
    putOnBattlefield(s, FOREST, 'A');
    putOnBattlefield(s, ISLAND, 'A');
    const inHand = putInHand(s, chamber, 'A');
    expect(s.players.A.hand.length).toBe(1);

    s = act(s, { kind: 'playLand', player: 'A', instanceId: inHand.instanceId }, reg);
    // The trigger parks a question aimed at its own controller.
    let asked = 0;
    s = settle(s, reg, (choice) => {
      asked++;
      expect(choice.chooser).toBe('A');
      expect(choice.kind).toBe('selectCards');
      // Every land it controls is a candidate — INCLUDING the chamber itself,
      // which is "a land you control" the moment its trigger resolves.
      if (choice.kind === 'selectCards') {
        expect(choice.candidates.map((c) => c.name).sort()).toEqual([
          'Forest',
          'Island',
          'Simic Growth Chamber',
        ]);
        expect([choice.min, choice.max]).toEqual([1, 1]);
      }
      return { kind: 'selectCards', instanceIds: [candidateNamed(choice, 'Island')] };
    });
    expect(asked).toBe(1);

    // The Island went home; the chamber and the Forest stayed.
    expect(names(s.battlefield.filter((c) => c.controller === 'A'))).toEqual([
      'Forest',
      'Simic Growth Chamber',
    ]);
    expect(names(s.players.A.hand)).toEqual(['Island']);
  });

  it('PLAYS: with the chamber as its only land, the chamber returns itself', () => {
    const reg = buildRegistry();
    const chamber = compiledDef(SIMIC_GROWTH_CHAMBER);
    let s = gameAtMain(reg, SEEDS.karooOnlyLand);

    const inHand = putInHand(s, chamber, 'A');
    s = act(s, { kind: 'playLand', player: 'A', instanceId: inHand.instanceId }, reg);
    s = settle(s, reg, (choice) => {
      // One candidate, and the return is NOT optional — the printed card makes
      // its controller give something up. A `min` of 0 here would be a strictly
      // better land than the one printed.
      if (choice.kind === 'selectCards') {
        expect(choice.candidates.map((c) => c.name)).toEqual(['Simic Growth Chamber']);
        expect(choice.min).toBe(1);
      }
      return {
        kind: 'selectCards',
        instanceIds: [candidateNamed(choice, 'Simic Growth Chamber')],
      };
    });

    expect(s.battlefield.filter((c) => c.controller === 'A')).toEqual([]);
    expect(names(s.players.A.hand)).toEqual(['Simic Growth Chamber']);
  });
});

// --- "each player sacrifices a [nontoken] creature of their choice" ---------------

describe('"each player sacrifices a creature of their choice"', () => {
  it('compiles COMPLETE with who:each — the controller is included', () => {
    const result = compileCard(FLESHBAG_MARAUDER);
    expect(result.status).toBe('complete');
    expect(result.definition.triggers?.[0]?.effects).toEqual([
      {
        primitive: 'sacrificeChosen',
        params: { who: 'each', filter: { anyOfTypes: ['creature'] } },
      },
    ]);
  });

  it('PLAYS: BOTH seats lose a creature, and each picks their own', () => {
    const reg = buildRegistry();
    const marauder = compiledDef(FLESHBAG_MARAUDER);
    let s = gameAtMain(reg, SEEDS.fleshbag);

    // BOTH seats need a real decision, or core auto-answers the trivial one and
    // the seat is never asked at all (see OGRE). B also holds a land, which must
    // never be offered as a sacrifice for a card that says "creature".
    putOnBattlefield(s, BEAR, 'A');
    putOnBattlefield(s, OGRE, 'A');
    putOnBattlefield(s, BEAR, 'B');
    putOnBattlefield(s, OGRE, 'B');
    putOnBattlefield(s, ISLAND, 'B');

    const inHand = putInHand(s, marauder, 'A');
    floodMana(s, 'A');
    s = act(s, { kind: 'castSpell', player: 'A', instanceId: inHand.instanceId }, reg);

    const askedOf: PlayerId[] = [];
    s = settle(s, reg, (choice) => {
      askedOf.push(choice.chooser);
      if (choice.kind === 'selectCards') {
        // Only creatures are ever offered — B's Island is not a candidate.
        expect(choice.candidates.every((c) => c.name !== 'Island')).toBe(true);
      }
      // Each seat gives up a Grizzly Bears, keeping its Ogre.
      return { kind: 'selectCards', instanceIds: [candidateNamed(choice, 'Grizzly Bears')] };
    });

    // BOTH seats were asked — this is the half a controller-only compile would
    // silently skip, and it is why the printed word is "each player".
    expect(askedOf.sort()).toEqual(['A', 'B']);
    expect(s.battlefield.filter((c) => c.def.name === 'Grizzly Bears')).toEqual([]);
    expect(names(s.players.A.graveyard)).toContain('Grizzly Bears');
    expect(names(s.players.B.graveyard)).toContain('Grizzly Bears');
    // Each seat kept what it chose to keep — the sacrifice is the VICTIM's pick,
    // not the caster's, which is the whole reason this is not a `destroyTarget`.
    expect(s.battlefield.filter((c) => c.def.name === 'Ogre Battledriver').length).toBe(2);
    // B's land was never in danger.
    expect(names(s.battlefield.filter((c) => c.controller === 'B'))).toContain('Island');
  });

  it('the "nontoken" narrowing is compiled, not dropped', () => {
    const result = compileCard(ACCURSED_MARAUDER);
    expect(result.status).toBe('complete');
    expect(result.definition.triggers?.[0]?.effects).toEqual([
      {
        primitive: 'sacrificeChosen',
        params: { who: 'each', filter: { anyOfTypes: ['creature'], isToken: false } },
      },
    ]);
  });

  it('PLAYS: a player whose only creature is a TOKEN sacrifices nothing', () => {
    const reg = buildRegistry();
    const marauder = compiledDef(ACCURSED_MARAUDER);
    let s = gameAtMain(reg, SEEDS.accursed);

    const tokenBear: CardDefinition = { ...BEAR, id: 'token-bear', isToken: true };
    putOnBattlefield(s, tokenBear, 'B'); // B's ONLY creature is a token
    putOnBattlefield(s, BEAR, 'A');

    const inHand = putInHand(s, marauder, 'A');
    floodMana(s, 'A');
    s = act(s, { kind: 'castSpell', player: 'A', instanceId: inHand.instanceId }, reg);
    s = settle(s, reg, (choice) => ({
      kind: 'selectCards',
      instanceIds:
        choice.kind === 'selectCards' && choice.candidates.length > 0
          ? [choice.candidates[0]!.instanceId]
          : [],
    }));

    // B's token survives because a token is not a legal sacrifice for this card;
    // A gave up its real creature.
    expect(s.battlefield.filter((c) => c.controller === 'B' && c.def.isToken === true).length).toBe(
      1,
    );
    expect(names(s.players.A.graveyard)).toContain('Grizzly Bears');
  });
});

// --- the additional-land family: one static, one one-shot, four words apart -------

describe('"you may play an additional land"', () => {
  it('the PERMANENT form compiles to the player static, with the printed count', () => {
    const azusa = compileCard(AZUSA);
    expect(azusa.status).toBe('complete');
    expect(azusa.definition.extraLandPlays).toEqual({ count: 2, who: 'controller' });

    const dryad = compileCard(DRYAD_GROVE);
    expect(dryad.status).toBe('complete');
    expect(dryad.definition.extraLandPlays).toEqual({ count: 1, who: 'controller' });

    // The symmetric printing widens BOTH seats — a different card, one word apart.
    const rites = compileCard(RITES_OF_FLOURISHING);
    expect(rites.status).toBe('complete');
    expect(rites.definition.extraLandPlays).toEqual({ count: 1, who: 'each' });
  });

  it('the ONE-SHOT form compiles to an effect, never to the static', () => {
    const explore = compileCard(EXPLORE);
    expect(explore.status).toBe('complete');
    expect(explore.definition.effects).toEqual([
      { primitive: 'grantExtraLandPlay', params: {} },
      { primitive: 'drawCards', params: { count: 1 } },
    ]);
    // THE REFUSAL THAT MATTERS: "this turn" must not become "on each of your
    // turns". A one-shot compiled as the static would be an unbounded ramp
    // engine printed on a one-mana sorcery.
    expect(explore.definition.extraLandPlays).toBeUndefined();
  });

  it('PLAYS: Azusa lets the engine ACCEPT three land drops in one turn', () => {
    const reg = buildRegistry();
    const azusa = compiledDef(AZUSA);
    let s = gameAtMain(reg, SEEDS.azusa);

    // Without Azusa the allowance is the rules floor.
    expect(maxLandPlaysFor(s, 'A', RULES.maxLandsPerTurn)).toBe(RULES.maxLandsPerTurn);
    putOnBattlefield(s, azusa, 'A');
    expect(maxLandPlaysFor(s, 'A', RULES.maxLandsPerTurn)).toBe(RULES.maxLandsPerTurn + 2);
    // …and only for its controller.
    expect(maxLandPlaysFor(s, 'B', RULES.maxLandsPerTurn)).toBe(RULES.maxLandsPerTurn);

    const lands = [
      putInHand(s, FOREST, 'A'),
      putInHand(s, FOREST, 'A'),
      putInHand(s, FOREST, 'A'),
      putInHand(s, FOREST, 'A'),
    ];
    for (let i = 0; i < 3; i++) {
      s = act(s, { kind: 'playLand', player: 'A', instanceId: lands[i]!.instanceId }, reg);
    }
    expect(s.players.A.landsPlayedThisTurn).toBe(3);

    // The FOURTH is refused — the grant is +2, not unlimited — and the engine
    // does not even OFFER it, which is the half a pilot would burn a turn on.
    expect(
      generateLegalActions(s).some(
        (a) => a.kind === 'playLand' && a.instanceId === lands[3]!.instanceId,
      ),
    ).toBe(false);
    const refused = applyAction(
      s,
      { kind: 'playLand', player: 'A', instanceId: lands[3]!.instanceId },
      RULES,
      reg,
    );
    expect(refused.events.some((e) => e.type === 'actionRejected')).toBe(true);
  });

  it('PLAYS: the grant DIES with its source — an Azusa removed mid-turn takes it back', () => {
    const reg = buildRegistry();
    const azusa = compiledDef(AZUSA);
    let s = gameAtMain(reg, SEEDS.azusaDies);
    const source = putOnBattlefield(s, azusa, 'A');

    const lands = [putInHand(s, FOREST, 'A'), putInHand(s, FOREST, 'A')];
    s = act(s, { kind: 'playLand', player: 'A', instanceId: lands[0]!.instanceId }, reg);

    // Azusa leaves. Nothing was stored when it entered, so nothing has to be
    // undone — the permission is re-derived from the board on every read.
    s.battlefield = s.battlefield.filter((c) => c.instanceId !== source.instanceId);
    expect(maxLandPlaysFor(s, 'A', RULES.maxLandsPerTurn)).toBe(RULES.maxLandsPerTurn);
    const refused = applyAction(
      s,
      { kind: 'playLand', player: 'A', instanceId: lands[1]!.instanceId },
      RULES,
      reg,
    );
    expect(refused.events.some((e) => e.type === 'actionRejected')).toBe(true);
  });

  it('PLAYS: Explore grants exactly one extra land drop, and only for THIS turn', () => {
    const reg = buildRegistry();
    const explore = compiledDef(EXPLORE);
    let s = gameAtMain(reg, SEEDS.explore);

    const spell = putInHand(s, explore, 'A');
    const lands = [putInHand(s, FOREST, 'A'), putInHand(s, FOREST, 'A'), putInHand(s, FOREST, 'A')];
    floodMana(s, 'A');

    s = act(s, { kind: 'castSpell', player: 'A', instanceId: spell.instanceId }, reg);
    s = settle(s, reg, () => {
      throw new Error('Explore asks nothing — the permission is unconditional');
    });
    expect(s.players.A.extraLandPlaysThisTurn).toBe(1);

    s = act(s, { kind: 'playLand', player: 'A', instanceId: lands[0]!.instanceId }, reg);
    s = act(s, { kind: 'playLand', player: 'A', instanceId: lands[1]!.instanceId }, reg);
    expect(s.players.A.landsPlayedThisTurn).toBe(2);
    const refusedThird = applyAction(
      s,
      { kind: 'playLand', player: 'A', instanceId: lands[2]!.instanceId },
      RULES,
      reg,
    );
    expect(refusedThird.events.some((e) => e.type === 'actionRejected')).toBe(true);

    // Round to A's NEXT turn: the one-shot expired, so it is one land again.
    s = playToOwnMainOnTurn(s, 3, reg);
    expect(s.players.A.extraLandPlaysThisTurn).toBeUndefined();
    expect(maxLandPlaysFor(s, 'A', RULES.maxLandsPerTurn)).toBe(RULES.maxLandsPerTurn);
  });

  it("PLAYS: the symmetric grant widens the OPPONENT's land drops too", () => {
    const reg = buildRegistry();
    const rites = compiledDef(RITES_OF_FLOURISHING);
    const s = gameAtMain(reg, SEEDS.ritesOfFlourishing);
    putOnBattlefield(s, rites, 'A');

    // Both seats, because a `who: 'each'` grant read as `'controller'` would be
    // a strictly one-sided card and nothing about A's own board would show it.
    expect(maxLandPlaysFor(s, 'A', RULES.maxLandsPerTurn)).toBe(RULES.maxLandsPerTurn + 1);
    expect(maxLandPlaysFor(s, 'B', RULES.maxLandsPerTurn)).toBe(RULES.maxLandsPerTurn + 1);
  });

  it('grants STACK — two sources are two extra land plays, not one', () => {
    const reg = buildRegistry();
    const dryad = compiledDef(DRYAD_GROVE);
    const s = gameAtMain(reg, SEEDS.azusaStack);
    putOnBattlefield(s, dryad, 'A');
    putOnBattlefield(s, dryad, 'A');
    expect(maxLandPlaysFor(s, 'A', RULES.maxLandsPerTurn)).toBe(RULES.maxLandsPerTurn + 2);
  });
});

// --- "you gain 1 life for each card in your hand" ---------------------------------

describe('"gain N life for each …" — a derived count in a trigger body', () => {
  it("compiles COMPLETE with the derived count, alongside Venser's other line", () => {
    const result = compileCard(VENSERS_JOURNAL);
    expect(result.status).toBe('complete');
    expect(result.definition.noMaximumHandSize).toBe(true);
    expect(result.definition.triggers?.[0]?.effects).toEqual([
      { primitive: 'gainLife', params: { amount: { countOf: 'cardsInYourHand' } } },
    ]);
  });

  it('PLAYS: the life gained is the hand size AT RESOLUTION', () => {
    const reg = buildRegistry();
    const journal = compiledDef(VENSERS_JOURNAL);
    let s = gameAtMain(reg, SEEDS.vensersJournal);
    putOnBattlefield(s, journal, 'A');
    for (let i = 0; i < 4; i++) putInHand(s, FOREST, 'A');
    const before = s.players.A.life;

    // Round to A's next upkeep and settle the trigger.
    let guard = 0;
    while (
      (s.activePlayer !== 'A' || s.step !== 'upkeep' || s.turnNumber < 3) &&
      !s.gameOver &&
      guard++ < 400
    ) {
      s = s.pendingChoice ? answer(s, reg, { kind: 'confirm', yes: false }) : pass(s, reg);
    }
    const handAtUpkeep = s.players.A.hand.length;
    s = settle(s, reg, () => {
      throw new Error('the life gain asks nothing');
    });

    // Four lands put in hand, plus whatever A drew on turn 1 — the number is
    // READ rather than assumed, because the number IS the assertion.
    expect(handAtUpkeep).toBeGreaterThanOrEqual(4);
    expect(s.players.A.life).toBe(before + handAtUpkeep);
  });
});
