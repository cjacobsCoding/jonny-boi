/**
 * TEMPLATE-GAP closures for TRIGGER **BODIES** — the half the "you may …" and
 * "At the beginning of…" families left behind.
 *
 * The triggers themselves all fire already: every printed scope, the `mayEffects`
 * "you may" wrapper, the intervening "if", and the triggering player a body
 * points at. What kept a large corpus cluster reporting was the SENTENCE AFTER
 * THE COMMA — a body no rule in the table could read. These are the bodies, plus
 * the three trigger scopes that had no optional sibling.
 *
 * Every closure is proven twice, per the compiler contract:
 *
 *   1. a REAL card printing the wording compiles `'complete'`, with the emitted
 *      params PINNED so they cannot silently drift, and
 *   2. that compiled definition PLAYS correctly in a real seeded game.
 *
 * The second half is not ceremony. This repo shipped "gains protection from red
 * until end of turn" doing NOTHING for weeks because its test asserted the
 * compiled effect refs and never played the card. So every test below puts the
 * card on a battlefield, drives a real engine turn, answers the real questions,
 * and reads the RESULT — a permanent that moved zones, a life total that
 * changed, a hand that grew.
 *
 * Alongside them sit the REFUSALS that keep it honest: a "for each" count with a
 * MULTIPLIER above one has no encoding a `DerivedValue` can carry, so a test
 * pins that it reports rather than quietly gaining half the printed life.
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
import { applyAction, createGame, DEFAULT_RULES, dumpState } from '@jonny-boi/core';
import { compileCard } from './compile.js';
import { EFFECT_RULES } from './rules.js';
import type { CompilableCard } from './types.js';
import { buildRegistry } from '../pool.js';

type Registry = ReturnType<typeof buildRegistry>;

/** Seeds are fixed per test so any failure is reproducible. */
const SEEDS = Object.freeze({
  fleshbag: 722,
  accursed: 723,
  sheoldred: 724,
  suturePriest: 725,
  vensersJournal: 727,
  shamanicDraw: 728,
  sphinx: 730,
  soulsAttendant: 731,
  solemn: 732,
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
 * is never ASKED which one to sacrifice; it simply loses it. So proving that a
 * seat is asked at all needs that seat to have a real decision.
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

const SOLEMN_SIMULACRUM = makeCard({
  name: 'Solemn Simulacrum',
  typeLine: { supertypes: [], types: ['Artifact', 'Creature'], subtypes: ['Golem'] },
  power: 2,
  toughness: 2,
  oracleText:
    'When ~ enters, you may search your library for a basic land card, put that card onto the battlefield tapped, then shuffle.\nWhen ~ dies, you may draw a card.',
});

const CONSECRATED_SPHINX = makeCard({
  name: 'Consecrated Sphinx',
  typeLine: { supertypes: [], types: ['Creature'], subtypes: ['Sphinx'] },
  power: 4,
  toughness: 6,
  keywords: ['Flying'],
  oracleText: 'Flying\nWhenever an opponent draws a card, you may draw two cards.',
});

const MESA_ENCHANTRESS = makeCard({
  name: 'Mesa Enchantress',
  typeLine: { supertypes: [], types: ['Creature'], subtypes: ['Human', 'Druid'] },
  power: 0,
  toughness: 2,
  oracleText: 'Whenever you cast an enchantment spell, you may draw a card.',
});

const SOULS_ATTENDANT = makeCard({
  name: "Soul's Attendant",
  typeLine: { supertypes: [], types: ['Creature'], subtypes: ['Human', 'Cleric'] },
  power: 1,
  toughness: 1,
  oracleText: 'Whenever another creature enters, you may gain 1 life.',
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

const SHEOLDRED = makeCard({
  name: 'Sheoldred, Whispering One',
  typeLine: { supertypes: ['Legendary'], types: ['Creature'], subtypes: ['Phyrexian', 'Praetor'] },
  power: 6,
  toughness: 6,
  keywords: ['Swampwalk'],
  oracleText:
    'Swampwalk\nAt the beginning of your upkeep, return target creature card from your graveyard to the battlefield.\nAt the beginning of each opponent’s upkeep, that player sacrifices a creature of their choice.',
});

const SUTURE_PRIEST = makeCard({
  name: 'Suture Priest',
  typeLine: { supertypes: [], types: ['Creature'], subtypes: ['Phyrexian', 'Cleric'] },
  power: 1,
  toughness: 1,
  oracleText: 'Whenever a creature an opponent controls enters, you may have that player lose 1 life.',
});

const VENSERS_JOURNAL = makeCard({
  name: "Venser's Journal",
  typeLine: { supertypes: [], types: ['Artifact'], subtypes: [] },
  oracleText:
    'You have no maximum hand size.\nAt the beginning of your upkeep, you gain 1 life for each card in your hand.',
});

const SHAMANIC_REVELATION = makeCard({
  name: 'Shamanic Revelation',
  typeLine: { supertypes: [], types: ['Sorcery'], subtypes: [] },
  oracleText:
    'Draw a card for each creature you control.\nFerocious — You gain 4 life for each creature you control with power 4 or greater.',
});

/** Shamanic Revelation's FIRST printed line, alone — the sentence, unchanged. */
const SHAMANIC_DRAW_LINE = makeCard({
  name: 'Shamanic Draw Line',
  typeLine: { supertypes: [], types: ['Sorcery'], subtypes: [] },
  oracleText: 'Draw a card for each creature you control.',
});

/**
 * The REFUSAL case for the "for each" count: a multiplier this engine cannot
 * express. `DerivedValue` is a bare count with no scale factor, so "2 life for
 * each" has no honest encoding — and emitting the count alone would print a card
 * that gains HALF the life it says.
 */
const DOUBLED_FOR_EACH = makeCard({
  name: 'Doubled For Each Test',
  typeLine: { supertypes: [], types: ['Sorcery'], subtypes: [] },
  oracleText: 'You gain 2 life for each creature you control.',
});

// --- harness ---------------------------------------------------------------------

function deck(def: CardDefinition) {
  return { cards: Array.from({ length: DECK_SIZE }, () => def) };
}

/**
 * The hand-size limit is lifted for the same reason the step-trigger tests lift
 * it: a test here counts cards in a hand across turns, and the CR 514.1 cleanup
 * discard would erase that evidence. The discard itself is pinned by
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

/** The smallest legal answer to any question — used only while getting somewhere. */
function declineAnything(choice: PendingChoice): ChoiceAnswer {
  return choice.kind === 'selectCards'
    ? { kind: 'selectCards', instanceIds: [] }
    : { kind: 'confirm', yes: false };
}

/**
 * Play forward to `player`'s `step` on turn `turn` or later, declining anything
 * asked on the way. Used by the tests that are about what a LATER turn looks
 * like (a trigger on the opponent's upkeep, an upkeep life gain).
 */
function playTo(
  state: GameState,
  reg: Registry,
  target: { player: PlayerId; step: string; turn?: number },
  max = 400,
): GameState {
  let s = state;
  let guard = 0;
  while (
    (s.activePlayer !== target.player ||
      s.step !== target.step ||
      s.turnNumber < (target.turn ?? 0)) &&
    !s.gameOver &&
    guard++ < max
  ) {
    s = s.pendingChoice ? answer(s, reg, declineAnything(s.pendingChoice)) : pass(s, reg);
  }
  if (guard >= max) {
    throw new Error(`never reached ${target.player}'s ${target.step}:\n${dumpState(s)}`);
  }
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

// --- the three trigger scopes that had no optional sibling ------------------------

describe('the "you may" siblings — dies, cast-a-spell, and draws-a-card', () => {
  it('each wraps its body in mayEffects with a GAIN valence', () => {
    // Valence is not cosmetic: `packages/ai/src/choices.ts` answers a `confirm`
    // from it, so a `'loss'` here would make every pilot DECLINE a free draw.
    const solemn = compileCard(SOLEMN_SIMULACRUM);
    expect(solemn.status).toBe('complete');
    const diesTrigger = solemn.definition.triggers?.find((t) => t.condition.on === 'dies');
    expect(diesTrigger?.effects).toEqual([
      {
        primitive: 'mayEffects',
        params: {
          prompt: 'You may draw a card',
          valence: 'gain',
          effects: [{ primitive: 'drawCards', params: { count: 1 } }],
        },
      },
    ]);

    const sphinx = compileCard(CONSECRATED_SPHINX);
    expect(sphinx.status).toBe('complete');
    expect(sphinx.definition.triggers?.[0]?.condition).toEqual({ on: 'drawsCard', who: 'opponent' });
    expect(sphinx.definition.triggers?.[0]?.effects).toEqual([
      {
        primitive: 'mayEffects',
        params: {
          prompt: 'You may draw two cards',
          valence: 'gain',
          effects: [{ primitive: 'drawCards', params: { count: 2 } }],
        },
      },
    ]);

    // The cast sibling builds ONE trigger PER matched spell filter, each with its
    // own wrapper — a printed type word that means two engine filters must still
    // ask exactly once per occurrence, not once for the card.
    const mesa = compileCard(MESA_ENCHANTRESS);
    expect(mesa.status).toBe('complete');
    for (const trigger of mesa.definition.triggers ?? []) {
      expect(trigger.condition.on).toBe('castSpell');
      expect(trigger.effects?.[0]?.primitive).toBe('mayEffects');
    }
  });

  it('PLAYS: Consecrated Sphinx asks a REAL question — yes draws two, no draws none', () => {
    const reg = buildRegistry();
    const sphinx = compiledDef(CONSECRATED_SPHINX);

    // The SAME seeded position, answered both ways. One run proving "yes draws
    // two" would pass just as well if the option were not a question at all.
    const run = (yes: boolean): number => {
      let s = gameAtMain(reg, SEEDS.sphinx);
      putOnBattlefield(s, sphinx, 'A');
      const before = s.players.A.hand.length;
      // B draws a card the engine really performs, which is what the trigger
      // watches — the draw STEP is a different card (see `trigger-draws-card`).
      let guard = 0;
      while (!s.pendingChoice && !s.gameOver && guard++ < 200) s = pass(s, reg);
      expect(s.pendingChoice?.kind).toBe('confirm');
      expect(s.pendingChoice?.chooser).toBe('A');
      s = answer(s, reg, { kind: 'confirm', yes });
      s = settle(s, reg, () => ({ kind: 'confirm', yes: false }));
      return s.players.A.hand.length - before;
    };

    expect(run(true)).toBe(2);
    expect(run(false)).toBe(0);
  });

  it('PLAYS: Solemn Simulacrum’s DEATH really offers the card', () => {
    const reg = buildRegistry();
    const solemn = compiledDef(SOLEMN_SIMULACRUM);
    let s = gameAtMain(reg, SEEDS.solemn);
    const body = putOnBattlefield(s, solemn, 'A');
    const before = s.players.A.hand.length;

    // Kill it the way the engine kills things: lethal damage plus an SBA sweep,
    // driven by a real action rather than by moving the card by hand.
    body.damageMarked = 99;
    s = pass(s, reg);
    s = settle(s, reg, () => ({ kind: 'confirm', yes: true }));

    expect(names(s.players.A.graveyard)).toContain('Solemn Simulacrum');
    expect(s.players.A.hand.length).toBe(before + 1);
  });

  it("PLAYS: Soul's Attendant gains the life its bare-bodied \"you may\" prints", () => {
    const reg = buildRegistry();
    const attendant = compiledDef(SOULS_ATTENDANT);
    let s = gameAtMain(reg, SEEDS.soulsAttendant);
    putOnBattlefield(s, attendant, 'A');
    const before = s.players.A.life;

    // Another creature arrives. The body the wrapper hands on is the BARE
    // "gain 1 life" — the printed "you" having been eaten by "you may".
    const inHand = putInHand(s, BEAR, 'A');
    floodMana(s, 'A');
    s = act(s, { kind: 'castSpell', player: 'A', instanceId: inHand.instanceId }, reg);
    s = settle(s, reg, () => ({ kind: 'confirm', yes: true }));
    expect(s.players.A.life).toBe(before + 1);
  });
});

// --- the edict family: each player, and the triggering player ---------------------

describe('"each player sacrifices a [nontoken] creature of their choice"', () => {
  it('compiles COMPLETE with who:eachPlayer — the controller is included', () => {
    const result = compileCard(FLESHBAG_MARAUDER);
    expect(result.status).toBe('complete');
    expect(result.definition.triggers?.[0]?.effects).toEqual([
      {
        primitive: 'sacrificeChosen',
        params: { who: 'eachPlayer', filter: { anyOfTypes: ['creature'] } },
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
    s = settle(s, reg, (choice, atAsk) => {
      askedOf.push(choice.chooser);
      if (choice.kind === 'selectCards') {
        // Only creatures are ever offered — B's Island is not a candidate.
        expect(choice.candidates.every((c) => c.name !== 'Island')).toBe(true);
      }
      // NOTHING has left the battlefield yet, on EITHER ask. CR 701.16 makes
      // this one simultaneous event: the second chooser must not be answering
      // on a board the first chooser's sacrifice already changed, and no
      // dies-trigger may resolve between the two halves.
      expect(
        atAsk.battlefield.filter((c) => c.def.name === 'Grizzly Bears').length,
        `${choice.chooser} was asked on a board that had already changed`,
      ).toBe(2);
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
        params: { who: 'eachPlayer', filter: { anyOfTypes: ['creature'], isToken: false } },
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

describe('"that player sacrifices a creature of their choice" — the triggering seat', () => {
  it('compiles COMPLETE with who:triggering, on the OPPONENT-scoped upkeep', () => {
    const result = compileCard(SHEOLDRED);
    expect(result.status).toBe('complete');
    const edict = result.definition.triggers?.find((t) => t.condition.who === 'opponent');
    expect(edict?.condition).toEqual({ on: 'upkeep', who: 'opponent' });
    expect(edict?.effects).toEqual([
      {
        primitive: 'sacrificeChosen',
        params: { who: 'triggering', filter: { anyOfTypes: ['creature'] } },
      },
    ]);
  });

  it('PLAYS: on the OPPONENT’s upkeep the OPPONENT gives one up — never Sheoldred’s side', () => {
    const reg = buildRegistry();
    const sheoldred = compiledDef(SHEOLDRED);
    let s = gameAtMain(reg, SEEDS.sheoldred);
    putOnBattlefield(s, sheoldred, 'A');
    // Both seats have creatures. A trigger that read `ctx.controller` instead of
    // the triggering player would eat A's board on B's turn — which is the bug
    // this test exists for, and it is invisible without A having something to
    // lose.
    putOnBattlefield(s, BEAR, 'A');
    putOnBattlefield(s, OGRE, 'A');
    putOnBattlefield(s, BEAR, 'B');
    putOnBattlefield(s, OGRE, 'B');

    s = playTo(s, reg, { player: 'B', step: 'upkeep', turn: 2 });
    const askedOf: PlayerId[] = [];
    s = settle(s, reg, (choice) => {
      askedOf.push(choice.chooser);
      return { kind: 'selectCards', instanceIds: [candidateNamed(choice, 'Grizzly Bears')] };
    });

    expect(askedOf).toEqual(['B']);
    expect(names(s.players.B.graveyard)).toContain('Grizzly Bears');
    expect(s.players.A.graveyard).toEqual([]);
    // A still has BOTH of its creatures plus Sheoldred.
    expect(names(s.battlefield.filter((c) => c.controller === 'A'))).toEqual([
      'Grizzly Bears',
      'Ogre Battledriver',
      'Sheoldred, Whispering One',
    ]);
  });
});

describe('"have that player lose N life" — the causative spelling', () => {
  it('compiles to the same triggering-seat life loss the plain spelling does', () => {
    const result = compileCard(SUTURE_PRIEST);
    expect(result.status).toBe('complete');
    expect(result.definition.triggers?.[0]?.effects).toEqual([
      {
        primitive: 'mayEffects',
        params: {
          prompt: 'You may have that player lose 1 life',
          valence: 'gain',
          effects: [{ primitive: 'loseLife', params: { amount: 1, whichPlayer: 'triggering' } }],
        },
      },
    ]);
  });

  it('PLAYS: the life comes off the seat whose creature arrived, not the controller', () => {
    const reg = buildRegistry();
    const priest = compiledDef(SUTURE_PRIEST);
    let s = gameAtMain(reg, SEEDS.suturePriest);
    putOnBattlefield(s, priest, 'A');
    const aBefore = s.players.A.life;
    const bBefore = s.players.B.life;

    // B casts a creature on B's own turn — a real arrival, really watched.
    s = playTo(s, reg, { player: 'B', step: 'precombatMain', turn: 2 });
    const inHand = putInHand(s, BEAR, 'B');
    floodMana(s, 'B');
    s = act(s, { kind: 'castSpell', player: 'B', instanceId: inHand.instanceId }, reg);
    s = settle(s, reg, () => ({ kind: 'confirm', yes: true }));

    expect(s.players.B.life).toBe(bBefore - 1);
    expect(s.players.A.life).toBe(aBefore);
  });
});

// --- "for each" — the singular half of the derived-count vocabulary ----------------

describe('"gain N life / draw a card for each …" — a derived count in a body', () => {
  it("compiles COMPLETE with the derived count, alongside Venser's other line", () => {
    const result = compileCard(VENSERS_JOURNAL);
    expect(result.status).toBe('complete');
    expect(result.definition.noMaximumHandSize).toBe(true);
    expect(result.definition.triggers?.[0]?.effects).toEqual([
      { primitive: 'gainLife', params: { amount: { countOf: 'cardsInYourHand' } } },
    ]);
  });

  it('REFUSES a multiplier it cannot express — "gain 2 life for each" reports', () => {
    const result = compileCard(DOUBLED_FOR_EACH);
    expect(result.status).toBe('incomplete');
    expect(result.missing.map((m) => m.text)).toEqual([
      'You gain 2 life for each creature you control.',
    ]);
    // And crucially it did NOT quietly compile the bare count, which would be a
    // card gaining one life per creature instead of two.
    expect(result.definition.effects ?? []).toEqual([]);
  });

  it('PLAYS: the life gained is the hand size AT RESOLUTION', () => {
    const reg = buildRegistry();
    const journal = compiledDef(VENSERS_JOURNAL);
    let s = gameAtMain(reg, SEEDS.vensersJournal);
    putOnBattlefield(s, journal, 'A');
    for (let i = 0; i < 4; i++) putInHand(s, FOREST, 'A');
    const before = s.players.A.life;

    s = playTo(s, reg, { player: 'A', step: 'upkeep', turn: 3 });
    const handAtUpkeep = s.players.A.hand.length;
    s = settle(s, reg, () => {
      throw new Error('the life gain asks nothing');
    });

    // Four lands put in hand, plus whatever A drew — the number is READ rather
    // than assumed, because the number IS the assertion.
    expect(handAtUpkeep).toBeGreaterThanOrEqual(4);
    expect(s.players.A.life).toBe(before + handAtUpkeep);
  });

  it("Shamanic Revelation's DRAW line now compiles; only its 4-life line reports", () => {
    const result = compileCard(SHAMANIC_REVELATION);
    // The card is still incomplete — and the honest reason is the MULTIPLIER on
    // the second line, not the draw. A rule that widened to swallow the "4" is
    // exactly what this assertion exists to catch.
    expect(result.status).toBe('incomplete');
    expect(result.missing.map((m) => m.text)).toEqual([
      'You gain 4 life for each creature you control with power 4 or greater.',
    ]);
    expect(compileCard(SHAMANIC_DRAW_LINE).definition.effects).toEqual([
      { primitive: 'drawCards', params: { count: { countOf: 'creaturesYouControl' } } },
    ]);
  });

  it("PLAYS: the draw is one card PER creature, counted at resolution", () => {
    const reg = buildRegistry();
    const revelation = compiledDef(SHAMANIC_DRAW_LINE);
    let s = gameAtMain(reg, SEEDS.shamanicDraw);
    putOnBattlefield(s, BEAR, 'A');
    putOnBattlefield(s, OGRE, 'A');
    putOnBattlefield(s, BEAR, 'B'); // B's creature must NOT be counted
    const before = s.players.A.hand.length;

    const inHand = putInHand(s, revelation, 'A');
    floodMana(s, 'A');
    s = act(s, { kind: 'castSpell', player: 'A', instanceId: inHand.instanceId }, reg);
    s = settle(s, reg, () => ({ kind: 'confirm', yes: false }));

    // The spell went to the hand and then left it on the cast, so the delta
    // against the ORIGINAL hand size counts only what was drawn.
    expect(s.players.A.hand.length - before).toBe(2);
  });

  /**
   * The DIVERGENCE GUARD for the singular table.
   *
   * `DERIVED_EACH_TO_PLURAL` maps a "for each" phrase onto the PLURAL row that
   * owns the count. A row naming a plural that does not exist compiles to
   * nothing at all — silently, because the rule simply returns null and the
   * clause reports as unsupported. This walks the alternation out of the shipped
   * pattern and proves every listed phrase really resolves, so the two halves of
   * one vocabulary cannot drift apart unnoticed.
   */
  it('every "for each" phrase the table lists actually resolves to a count', () => {
    const rule = EFFECT_RULES.find((r) => r.id === 'gain-life-for-each');
    expect(rule, 'gain-life-for-each rule is gone — this guard is measuring nothing').toBeDefined();
    const alternation = /for each \(([^)]+)\)\$/.exec(rule!.pattern.source);
    expect(alternation, `cannot read the phrase list out of ${rule!.pattern.source}`).not.toBeNull();
    const phrases = (alternation![1] ?? '').split('|');
    expect(phrases.length).toBeGreaterThan(1);

    for (const phrase of phrases) {
      const card = makeCard({
        name: `for-each ${phrase}`,
        typeLine: { supertypes: [], types: ['Sorcery'], subtypes: [] },
        oracleText: `You gain 1 life for each ${phrase}.`,
      });
      const result = compileCard(card);
      expect(result.status, `"for each ${phrase}" names no plural row`).toBe('complete');
      expect(result.definition.effects?.[0]?.primitive).toBe('gainLife');
    }
  });
});
