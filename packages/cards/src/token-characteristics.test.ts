/**
 * **A token keeps its printed face**, from the Oracle text down to a played game.
 *
 * The bug this pins was silent for months and is the exact shape this project
 * keeps recording: `makeToken` built a `CardDefinition` with a name and a P/T and
 * nothing else, `colorsOfDefinition` reads colour off cost PIPS, and a token has
 * no mana cost — so "a 1/1 **black** Faerie Rogue creature token" and "a 5/5
 * **red** Dragon token" both entered COLOURLESS and with no creature type at all.
 * Every card printing one still compiled `'complete'`, every test still passed,
 * and the token then played as a different object from the one printed: invisible
 * to a coloured anthem, to protection from a colour, to colour-hating removal and
 * to every typal lord.
 *
 * **Everything below the compile section plays a REAL GAME with REAL POOL CARDS.**
 * That is deliberate and it is the lesson: hand-built `CardInstance` fixtures are
 * how this hid: a fixture author writes the colour they are thinking about, so a
 * definition that never carries one is never noticed. Here the definitions come
 * out of `CARD_POOL`, the tokens are created by the engine's own resolution, and
 * the assertions read the same continuous layer combat reads.
 *
 * Each interaction is pinned WITH ITS CONTROL — the token that must NOT be
 * affected — because "the anthem pumped something" is not evidence that it read a
 * colour, and a fix that pumped every token would pass a one-sided test.
 */

import { describe, expect, it } from 'vitest';
import type {
  CardDefinition,
  CardInstance,
  GameAction,
  GameState,
  PlayerId,
} from '@jonny-boi/core';
import {
  aggregateFor,
  applyAction,
  colorsOfDefinition,
  createGame,
  DEFAULT_RULES,
  dumpState,
  effectiveKeywords,
  effectivePower,
  effectiveToughness,
} from '@jonny-boi/core';
import { compileCard } from './compile/compile.js';
import type { CompilableCard } from './compile/types.js';
import { buildRegistry } from './pool.js';
import { CARD_POOL } from '../data/pool.js';

type Registry = ReturnType<typeof buildRegistry>;

const SEED = 20260820;
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

/** The `makeToken` params a card's Nth token-making effect emits. */
function tokenParams(def: CardDefinition): Record<string, unknown> {
  const fromEffects = def.effects?.find((e) => e.primitive === 'makeToken');
  const fromTrigger = def.triggers
    ?.flatMap((t) => t.effects)
    .find((e) => e.primitive === 'makeToken');
  const ref = fromEffects ?? fromTrigger;
  if (!ref) throw new Error(`${def.name} emits no makeToken effect`);
  return ref.params as Record<string, unknown>;
}

// --- the compiler reads the whole printed face ----------------------------------

describe('the printed token descriptor', () => {
  it('reads colour, creature types and keywords, not just the P/T', () => {
    // Bitterblossom, whose token is the reason the three cards named in this
    // branch's brief were left reporting.
    const result = compileCard(
      makeCard({
        name: 'Bitterblossom',
        manaCost: { generic: 1, W: 0, U: 0, B: 1, R: 0, G: 0, C: 0, other: [] },
        typeLine: { supertypes: [], types: ['Kindred', 'Enchantment'], subtypes: ['Faerie'] },
        oracleText:
          'At the beginning of your upkeep, you lose 1 life and create a 1/1 black Faerie Rogue creature token with flying.',
      }),
    );
    expect(result.status, JSON.stringify(result.missing)).toBe('complete');
    expect(tokenParams(result.definition)).toEqual({
      power: 1,
      toughness: 1,
      // CR 111.3: a token is NAMED by its subtype line, not by the last word of
      // it — "Rogue" would make two different tokens share a name.
      name: 'Faerie Rogue',
      colors: ['B'],
      subtypes: ['Faerie', 'Rogue'],
      keywords: { flying: true },
    });
  });

  it('reads a MULTICOLOUR token ("blue and black"), which no cost pip could have told it', () => {
    const result = compileCard(
      makeCard({
        name: 'Bitterbloom Bearer',
        manaCost: { generic: 0, W: 0, U: 0, B: 2, R: 0, G: 0, C: 0, other: [] },
        typeLine: { supertypes: [], types: ['Creature'], subtypes: ['Faerie', 'Rogue'] },
        power: 1,
        toughness: 1,
        keywords: ['Flash', 'Flying'],
        oracleText:
          'Flash\nFlying\nAt the beginning of your upkeep, you lose 1 life and create a 1/1 blue and black Faerie creature token with flying.',
      }),
    );
    expect(result.status, JSON.stringify(result.missing)).toBe('complete');
    expect(tokenParams(result.definition).colors).toEqual(['U', 'B']);
  });

  it('reads the printed word "colorless" as an EMPTY colour list, and the artifact type line', () => {
    const result = compileCard(
      makeCard({
        name: 'Third Path Iconoclast',
        manaCost: { generic: 0, W: 0, U: 1, B: 0, R: 1, G: 0, C: 0, other: [] },
        typeLine: { supertypes: [], types: ['Creature'], subtypes: ['Human', 'Monk'] },
        power: 2,
        toughness: 1,
        oracleText:
          'Whenever you cast a noncreature spell, create a 1/1 colorless Soldier artifact creature token.',
      }),
    );
    expect(result.status, JSON.stringify(result.missing)).toBe('complete');
    const params = tokenParams(result.definition);
    // EMPTY, not absent: `[]` is the printed word "colorless", and absent would
    // send core's reader back to the (nonexistent) cost pips.
    expect(params.colors).toEqual([]);
    expect(params.types).toEqual(['artifact', 'creature']);
  });

  it('REFUSES a descriptor it cannot read completely rather than dropping the part it missed', () => {
    // "tapped" is a characteristic `makeToken` cannot express, and the descriptor
    // then states no colour this rule can read. Compiling it would create an
    // untapped colourless Fish — a strictly different, strictly better card.
    const tapped = compileCard(
      makeCard({
        name: 'Tapped Fish Maker',
        typeLine: { supertypes: [], types: ['Enchantment'], subtypes: [] },
        oracleText: 'Create a tapped 1/1 blue Fish creature token.',
      }),
    );
    expect(tapped.status).toBe('incomplete');
    expect(tapped.definition.effects ?? []).toEqual([]);

    // A predefined artifact token (Treasure/Clue/Food) prints no P/T here and
    // carries an activated ability this rule does not build.
    const treasure = compileCard(
      makeCard({
        name: 'Treasure Maker',
        typeLine: { supertypes: [], types: ['Enchantment'], subtypes: [] },
        oracleText: 'Create a Treasure token.',
      }),
    );
    expect(treasure.status).toBe('incomplete');
    expect(treasure.definition.effects ?? []).toEqual([]);
  });
});

// --- the real game --------------------------------------------------------------

function poolCard(name: string): CardDefinition {
  const card = CARD_POOL.find((c) => c.name === name);
  if (!card) throw new Error(`pool missing ${name}`);
  return card;
}

/**
 * Every card below is a REAL pool card, looked up by its printed name. If one of
 * these lookups ever throws, the pool lost a card these interactions depend on —
 * which is exactly the failure worth being told about loudly.
 */
const PLAINS = poolCard('Plains');
const SWAMP = poolCard('Swamp');
const MOUNTAIN = poolCard('Mountain');
const ISLAND = poolCard('Island');
/** "Black creatures get +1/+1." — the coloured anthem. */
const BAD_MOON = poolCard('Bad Moon');
/** "Other Goblin creatures you control get +1/+1 and have haste." — the typal one. */
const GOBLIN_CHIEFTAIN = poolCard('Goblin Chieftain');
/** First strike, protection from red. */
const SILVER_KNIGHT = poolCard('Silver Knight');
/** "Destroy target nonblack creature." */
const DOOM_BLADE = poolCard('Doom Blade');
/** "Create two 1/1 red Goblin creature tokens." */
const DRAGON_FODDER = poolCard('Dragon Fodder');
/** "Create two 2/2 black Zombie creature tokens." */
const MOAN = poolCard('Moan of the Unhallowed');
/** "Create two 1/1 white Soldier creature tokens." */
const RAISE_THE_ALARM = poolCard('Raise the Alarm');
/** Makes a 1/1 COLOURLESS Soldier artifact creature token on a noncreature cast. */
const ICONOCLAST = poolCard('Third Path Iconoclast');

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

/** The rejection reason for an action, or undefined when it was accepted. */
function rejectionOf(state: GameState, action: GameAction, reg: Registry): string | undefined {
  const result = applyAction(state, action, DEFAULT_RULES, reg);
  const rejected = result.events.find((e) => e.type === 'actionRejected');
  return rejected ? (rejected as { reason: string }).reason : undefined;
}

function pass(state: GameState, reg: Registry): GameState {
  return act(state, { kind: 'passPriority', player: state.priorityPlayer }, reg);
}

let syntheticId = 71_000;

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

/** A game at A's first main phase with `lands` of each basic on A's battlefield. */
function board(reg: Registry, lands = 4): GameState {
  const { state: created } = createGame({
    seed: SEED,
    startingPlayer: 'A',
    registry: reg,
    decks: {
      A: { cards: Array.from({ length: DECK_SIZE }, () => PLAINS) },
      B: { cards: Array.from({ length: DECK_SIZE }, () => PLAINS) },
    },
  });
  let state = created;
  let guard = 0;
  while (state.step !== 'precombatMain' && !state.gameOver && guard++ < 50) state = pass(state, reg);
  state.players.A.hand = [];
  state.players.B.hand = [];
  for (const basic of [PLAINS, SWAMP, MOUNTAIN, ISLAND]) {
    for (let i = 0; i < lands; i++) {
      const land = instance(basic, 'A', 'battlefield');
      land.summoningSick = false;
      state.battlefield.push(land);
    }
  }
  return state;
}

/** Tap every untapped land `player` controls, so a spell can be paid for. */
function tapAllLands(state: GameState, reg: Registry, player: PlayerId = 'A'): GameState {
  let next = state;
  for (const land of [...next.battlefield]) {
    if (land.controller !== player || land.tapped || !land.def.types.includes('land')) continue;
    next = act(next, { kind: 'tapForMana', player, instanceId: land.instanceId, mode: 0 }, reg);
  }
  return next;
}

/** Cast `def` from a fresh copy in A's hand and let it resolve. */
function castAndResolve(state: GameState, reg: Registry, def: CardDefinition): GameState {
  const spell = instance(def, 'A', 'hand');
  state.players.A.hand.push(spell);
  let next = tapAllLands(state, reg);
  next = act(next, { kind: 'castSpell', player: 'A', instanceId: spell.instanceId }, reg);
  while (next.stack.length > 0 && !next.gameOver) next = pass(next, reg);
  return next;
}

/** Put a permanent straight onto the battlefield, already able to act. */
function place(state: GameState, def: CardDefinition, player: PlayerId): CardInstance {
  const perm = instance(def, player, 'battlefield');
  perm.summoningSick = false;
  state.battlefield.push(perm);
  return perm;
}

/** Every permanent A controls whose definition carries this token name. */
function tokensNamed(state: GameState, name: string): CardInstance[] {
  return state.battlefield.filter((c) => c.def.isToken === true && c.def.name === name);
}

/** Effective P/T through the SAME continuous layer combat and the SBAs read. */
function sizeOf(state: GameState, perm: CardInstance): string {
  const mod = aggregateFor(state, perm.instanceId);
  return `${effectivePower(perm, mod)}/${effectiveToughness(perm, mod)}`;
}

describe('a token enters with its printed COLOUR', () => {
  it('a BLACK token is pumped by a black anthem; a white and a colourless one are not', () => {
    const reg = buildRegistry();
    let state = board(reg, 5);
    // Bad Moon: "Black creatures get +1/+1."
    place(state, BAD_MOON, 'A');

    state = castAndResolve(state, reg, MOAN); // two 2/2 BLACK Zombie tokens
    state = castAndResolve(state, reg, RAISE_THE_ALARM); // two 1/1 WHITE Soldier tokens
    place(state, ICONOCLAST, 'A');
    // A noncreature spell triggers the Iconoclast: a 1/1 COLOURLESS Soldier
    // ARTIFACT creature token, alongside two more white Soldiers.
    state = castAndResolve(state, reg, RAISE_THE_ALARM);

    const zombies = tokensNamed(state, 'Zombie');
    expect(zombies).toHaveLength(2);
    for (const zombie of zombies) {
      expect(colorsOfDefinition(zombie.def)).toEqual(['B']);
      expect(sizeOf(state, zombie)).toBe('3/3'); // 2/2 + Bad Moon
    }

    const soldiers = tokensNamed(state, 'Soldier');
    const white = soldiers.filter((s) => !s.def.types.includes('artifact'));
    const colourless = soldiers.filter((s) => s.def.types.includes('artifact'));
    expect(white).toHaveLength(4);
    expect(colourless).toHaveLength(1);
    for (const soldier of white) {
      expect(colorsOfDefinition(soldier.def)).toEqual(['W']);
      expect(sizeOf(state, soldier)).toBe('1/1'); // white: the anthem does not see it
    }
    for (const soldier of colourless) {
      expect(colorsOfDefinition(soldier.def)).toEqual([]);
      expect(sizeOf(state, soldier)).toBe('1/1'); // colourless: nor does it see this
    }
  });

  it('colour-hating removal reads a token: Doom Blade cannot kill a BLACK token, and does kill a red one', () => {
    const reg = buildRegistry();
    let state = board(reg, 5);
    state = castAndResolve(state, reg, MOAN); // black Zombies
    state = castAndResolve(state, reg, DRAGON_FODDER); // red Goblins

    const zombie = tokensNamed(state, 'Zombie')[0]!;
    const goblin = tokensNamed(state, 'Goblin')[0]!;

    // "Destroy target nonblack creature" fizzles on the black token…
    let after = castAndResolveAt(state, reg, DOOM_BLADE, zombie.instanceId);
    expect(after.battlefield.some((c) => c.instanceId === zombie.instanceId)).toBe(true);

    // …and destroys the red one, so the spell itself plainly works.
    after = castAndResolveAt(state, reg, DOOM_BLADE, goblin.instanceId);
    expect(after.battlefield.some((c) => c.instanceId === goblin.instanceId)).toBe(false);
  });
});

/** Cast a targeted spell from A's hand at `target` and let it resolve. */
function castAndResolveAt(
  state: GameState,
  reg: Registry,
  def: CardDefinition,
  target: number,
): GameState {
  const spell = instance(def, 'A', 'hand');
  const next0 = { ...state, battlefield: [...state.battlefield] };
  next0.players = { A: { ...state.players.A }, B: { ...state.players.B } };
  next0.players.A.hand = [...state.players.A.hand, spell];
  let next = tapAllLands(next0, reg);
  next = act(
    next,
    { kind: 'castSpell', player: 'A', instanceId: spell.instanceId, targets: [target] },
    reg,
  );
  while (next.stack.length > 0 && !next.gameOver) next = pass(next, reg);
  return next;
}

describe('protection reads a token colour', () => {
  /** Silver Knight (protection from red) attacks; `blockerName` tries to block. */
  function blockAttempt(tokenSource: CardDefinition, tokenName: string): string | undefined {
    const reg = buildRegistry();
    let state = board(reg, 5);
    state = castAndResolve(state, reg, tokenSource);
    // The token belongs to B, the defending player, so it can block.
    for (const token of tokensNamed(state, tokenName)) {
      token.controller = 'B';
      token.owner = 'B';
      token.summoningSick = false;
    }
    const knight = place(state, SILVER_KNIGHT, 'A');
    let guard = 0;
    while (state.step !== 'declareAttackers' && !state.gameOver && guard++ < 60) {
      state = pass(state, reg);
    }
    state = act(
      state,
      { kind: 'declareAttackers', player: 'A', attackers: [knight.instanceId] },
      reg,
    );
    guard = 0;
    while (state.step !== 'declareBlockers' && !state.gameOver && guard++ < 60) {
      state = pass(state, reg);
    }
    if (state.priorityPlayer !== 'B') state = pass(state, reg);
    const blocker = tokensNamed(state, tokenName)[0]!;
    return rejectionOf(
      state,
      {
        kind: 'declareBlockers',
        player: 'B',
        blocks: [{ blocker: blocker.instanceId, attacker: knight.instanceId }],
      },
      reg,
    );
  }

  it('a RED token cannot block protection-from-red; a WHITE token can', () => {
    // Protection's fourth half (CR 702.16e): an attacker with protection from
    // red can't be blocked by red creatures.
    expect(blockAttempt(DRAGON_FODDER, 'Goblin')).toMatch(/block/i);
    expect(blockAttempt(RAISE_THE_ALARM, 'Soldier')).toBeUndefined();
  });
});

describe('a token enters with its printed CREATURE TYPES', () => {
  it('a typal lord pumps the tokens of its type and no others', () => {
    const reg = buildRegistry();
    let state = board(reg, 5);
    // "Other Goblin creatures you control get +1/+1 and have haste."
    place(state, GOBLIN_CHIEFTAIN, 'A');
    state = castAndResolve(state, reg, DRAGON_FODDER); // 1/1 red GOBLIN tokens
    state = castAndResolve(state, reg, RAISE_THE_ALARM); // 1/1 white SOLDIER tokens

    const goblins = tokensNamed(state, 'Goblin');
    expect(goblins).toHaveLength(2);
    for (const goblin of goblins) {
      expect(goblin.def.subtypes).toEqual(['Goblin']);
      expect(sizeOf(state, goblin)).toBe('2/2');
      // The lord grants haste as well, and a token that never carried the type
      // would never have received it.
      expect(effectiveKeywords(goblin, aggregateFor(state, goblin.instanceId)).haste).toBe(true);
    }

    for (const soldier of tokensNamed(state, 'Soldier')) {
      expect(sizeOf(state, soldier)).toBe('1/1');
      expect(
        effectiveKeywords(soldier, aggregateFor(state, soldier.instanceId)).haste ?? false,
      ).toBe(false);
    }
  });
});

describe('a token is a TOKEN (CR 704.5d)', () => {
  it('ceases to exist when it leaves the battlefield, instead of filling a graveyard forever', () => {
    const reg = buildRegistry();
    let state = board(reg, 5);
    state = castAndResolve(state, reg, DRAGON_FODDER);
    const goblin = tokensNamed(state, 'Goblin')[0]!;
    const graveyardBefore = state.players.A.graveyard.length;

    const result = applyAction(
      state,
      {
        kind: 'castSpell',
        player: 'A',
        instanceId: (() => {
          const spell = instance(DOOM_BLADE, 'A', 'hand');
          state.players.A.hand.push(spell);
          state = tapAllLands(state, reg);
          return spell.instanceId;
        })(),
        targets: [goblin.instanceId],
      },
      DEFAULT_RULES,
      reg,
    );
    let after = result.state;
    let events = [...result.events];
    while (after.stack.length > 0 && !after.gameOver) {
      const step = applyAction(
        after,
        { kind: 'passPriority', player: after.priorityPlayer },
        DEFAULT_RULES,
        reg,
      );
      after = step.state;
      events = events.concat(step.events);
    }

    expect(after.battlefield.some((c) => c.instanceId === goblin.instanceId)).toBe(false);
    // The token is nowhere — not on the battlefield, and NOT in the graveyard.
    expect(after.players.A.graveyard.some((c) => c.instanceId === goblin.instanceId)).toBe(false);
    // Only Doom Blade itself joined the graveyard.
    expect(after.players.A.graveyard).toHaveLength(graveyardBefore + 1);
    // The move is still announced as a zone change, so every "dies" trigger in
    // the game sees a token's death exactly as it sees a card's…
    expect(
      events.some(
        (e) => e.type === 'zoneChange' && e.instanceId === goblin.instanceId && e.to === 'graveyard',
      ),
    ).toBe(true);
    // …and only then does the object stop existing.
    expect(events.some((e) => e.type === 'tokenCeasedToExist' && e.instanceId === goblin.instanceId)).toBe(
      true,
    );
  });

  it('a definition minted by makeToken says so, and a pool card never does', () => {
    const reg = buildRegistry();
    let state = board(reg, 5);
    state = castAndResolve(state, reg, DRAGON_FODDER);
    for (const token of tokensNamed(state, 'Goblin')) expect(token.def.isToken).toBe(true);
    // A printed card is not a token, and the flag is ABSENT on it rather than
    // false — every reader tests `=== true`.
    expect(DRAGON_FODDER.isToken).toBeUndefined();
    expect(SILVER_KNIGHT.isToken).toBeUndefined();
  });
});
