/**
 * TEMPLATE-GAP closures — printed Oracle wordings the ENGINE could already play
 * but the rule table did not recognize until this pass. Each closed template is
 * proven twice, per the compiler contract:
 *
 *   1. a REAL card using the wording compiles `'complete'` (never "close enough"
 *      — the compiled data is pinned so the params cannot silently drift), and
 *   2. that compiled definition PLAYS correctly in a real game via
 *      `createGame` + `applyAction`, questions answered and outcomes asserted.
 *
 * The closures under test:
 *   - "Search your library for a basic land card, put it/that card onto the
 *     battlefield [tapped][, then shuffle]"  (Rampant Growth; and the body of
 *     Sakura-Tribe Elder's sacrifice ability, which UN-STUBS that pool card)
 *   - "Gain control of target creature until end of turn. Untap that creature.
 *     It gains haste until end of turn."     (Act of Treason's exact templating)
 *   - "Return target TYPE card from your graveyard to your hand" (Raise Dead)
 *   - "Target player/opponent discards N cards"                  (Mind Rot)
 *   - "Target player draws N cards and loses M life"             (Sign in Blood)
 *   - "[Other] creatures you control get +X/+Y / have KEYWORD"   (Glorious
 *     Anthem, Fervor — compiled onto core's statics/anthem layer)
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
import {
  applyAction,
  createGame,
  DEFAULT_RULES,
  dumpState,
  effectivePower,
  hasKeyword,
  indexContinuous,
  NO_MOD,
} from '@jonny-boi/core';
import { compileCard } from './compile.js';
import type { CompilableCard } from './types.js';
import { buildRegistry } from '../pool.js';
import { CARD_POOL, BASIC_LAND_NAMES } from '../../data/pool.js';

type Registry = ReturnType<typeof buildRegistry>;

/** Seeds are fixed per test so any failure is reproducible. */
const SEEDS = Object.freeze({
  elder: 301,
  rampant: 302,
  treason: 303,
  raiseDead: 304,
  mindRot: 305,
  anthem: 306,
  signInBlood: 307,
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

const RAMPANT_GROWTH = makeCard({
  name: 'Rampant Growth',
  typeLine: { supertypes: [], types: ['Sorcery'], subtypes: [] },
  manaCost: { generic: 1, W: 0, U: 0, B: 0, R: 0, G: 1, C: 0, other: [] },
  oracleText:
    'Search your library for a basic land card, put that card onto the battlefield tapped, then shuffle.',
});

/** Sakura-Tribe Elder, exactly as the modern Scryfall record prints it. */
const SAKURA_TRIBE_ELDER = makeCard({
  name: 'Sakura-Tribe Elder',
  typeLine: { supertypes: [], types: ['Creature'], subtypes: ['Snake', 'Shaman'] },
  manaCost: { generic: 1, W: 0, U: 0, B: 0, R: 0, G: 1, C: 0, other: [] },
  power: 1,
  toughness: 1,
  oracleText:
    'Sacrifice this creature: Search your library for a basic land card, put that card onto the battlefield tapped, then shuffle.',
});

const ACT_OF_TREASON = makeCard({
  name: 'Act of Treason',
  typeLine: { supertypes: [], types: ['Sorcery'], subtypes: [] },
  manaCost: { generic: 2, W: 0, U: 0, B: 0, R: 1, G: 0, C: 0, other: [] },
  oracleText:
    'Gain control of target creature until end of turn. Untap that creature. It gains haste until end of turn.',
});

const RAISE_DEAD = makeCard({
  name: 'Raise Dead',
  typeLine: { supertypes: [], types: ['Sorcery'], subtypes: [] },
  manaCost: { generic: 0, W: 0, U: 0, B: 1, R: 0, G: 0, C: 0, other: [] },
  oracleText: 'Return target creature card from your graveyard to your hand.',
});

const MIND_ROT = makeCard({
  name: 'Mind Rot',
  typeLine: { supertypes: [], types: ['Sorcery'], subtypes: [] },
  manaCost: { generic: 2, W: 0, U: 0, B: 1, R: 0, G: 0, C: 0, other: [] },
  oracleText: 'Target player discards two cards.',
});

const SIGN_IN_BLOOD = makeCard({
  name: 'Sign in Blood',
  typeLine: { supertypes: [], types: ['Sorcery'], subtypes: [] },
  manaCost: { generic: 0, W: 0, U: 0, B: 2, R: 0, G: 0, C: 0, other: [] },
  oracleText: 'Target player draws two cards and loses 2 life.',
});

const GLORIOUS_ANTHEM = makeCard({
  name: 'Glorious Anthem',
  typeLine: { supertypes: [], types: ['Enchantment'], subtypes: [] },
  manaCost: { generic: 1, W: 2, U: 0, B: 0, R: 0, G: 0, C: 0, other: [] },
  oracleText: 'Creatures you control get +1/+1.',
});

const FERVOR = makeCard({
  name: 'Fervor',
  typeLine: { supertypes: [], types: ['Enchantment'], subtypes: [] },
  manaCost: { generic: 2, W: 0, U: 0, B: 0, R: 1, G: 0, C: 0, other: [] },
  oracleText: 'Creatures you control have haste.',
});

// --- compile: each wording produces exactly the printed behavior ------------------

describe('template gaps — the compiler recognizes the closed wordings', () => {
  it('compiles Rampant Growth completely (basic-land search to the battlefield)', () => {
    const result = compileCard(RAMPANT_GROWTH);
    expect(result.status, JSON.stringify(result.missing)).toBe('complete');
    expect(result.definition.effects).toEqual([
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
    ]);
  });

  it('compiles Sakura-Tribe Elder completely (sacrifice-self cost + the search body)', () => {
    const result = compileCard(SAKURA_TRIBE_ELDER);
    expect(result.status, JSON.stringify(result.missing)).toBe('complete');
    expect(result.definition.activated).toHaveLength(1);
    const [ability] = result.definition.activated!;
    expect(ability!.cost).toEqual({ sacrificeSelf: true });
    expect(ability!.effects).toEqual([
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
    ]);
  });

  it('compiles Act of Treason completely, with untap AND haste', () => {
    const result = compileCard(ACT_OF_TREASON);
    expect(result.status, JSON.stringify(result.missing)).toBe('complete');
    expect(result.definition.effects).toEqual([
      { primitive: 'gainControl', params: { targets: 'creature', untap: true, haste: true } },
    ]);
  });

  it('compiles Raise Dead completely, restricted to creature cards', () => {
    const result = compileCard(RAISE_DEAD);
    expect(result.status, JSON.stringify(result.missing)).toBe('complete');
    expect(result.definition.effects).toEqual([
      { primitive: 'returnFromGraveyard', params: { count: 1, filter: { anyOfTypes: ['creature'] } } },
    ]);
  });

  it('compiles Mind Rot completely — the VICTIM chooses their own discards', () => {
    const result = compileCard(MIND_ROT);
    expect(result.status, JSON.stringify(result.missing)).toBe('complete');
    expect(result.definition.effects).toEqual([
      { primitive: 'discardCard', params: { count: 2, who: 'targetPlayer', targets: 'player' } },
    ]);
  });

  it('compiles Sign in Blood completely — both halves land on the TARGETED player', () => {
    const result = compileCard(SIGN_IN_BLOOD);
    expect(result.status, JSON.stringify(result.missing)).toBe('complete');
    expect(result.definition.effects).toEqual([
      { primitive: 'drawCards', params: { count: 2, whichPlayer: 'targetPlayer', targets: 'player' } },
      { primitive: 'loseLife', params: { amount: 2, targetPlayer: true } },
    ]);
  });

  it('compiles Glorious Anthem to a static on the anthem layer', () => {
    const result = compileCard(GLORIOUS_ANTHEM);
    expect(result.status, JSON.stringify(result.missing)).toBe('complete');
    expect(result.definition.statics).toEqual([
      {
        affects: { anyOfTypes: ['creature'], controller: 'you' },
        power: 1,
        toughness: 1,
        label: 'creatures you control get +1/+1',
      },
    ]);
  });

  it('compiles Fervor to a keyword-granting static', () => {
    const result = compileCard(FERVOR);
    expect(result.status, JSON.stringify(result.missing)).toBe('complete');
    expect(result.definition.statics).toEqual([
      {
        affects: { anyOfTypes: ['creature'], controller: 'you' },
        keywords: { haste: true },
        label: 'creatures you control have haste',
      },
    ]);
  });

  it('recognizes the "other creatures" form with the source excluded', () => {
    const result = compileCard(
      makeCard({
        name: 'Test Lord',
        typeLine: { supertypes: [], types: ['Creature'], subtypes: [] },
        power: 2,
        toughness: 2,
        oracleText: 'Other creatures you control get +1/+1.',
      }),
    );
    expect(result.status, JSON.stringify(result.missing)).toBe('complete');
    expect(result.definition.statics![0]!.affects.excludeSource).toBe(true);
  });
});

describe('template gaps — the neighbouring wordings still refuse honestly', () => {
  it('COMPILES a typed search onto the battlefield now that the tutor family is closed', () => {
    // This test used to pin the refusal: only the BASIC-land form of the search
    // existed, so "a creature card … onto the battlefield" had no rule. The
    // tutor family (`search-to-battlefield-by-filter`) closed it, and the honest
    // assertion is now the compiled search rather than the missing one.
    const result = compileCard(
      makeCard({
        name: 'Test Tutor',
        typeLine: { supertypes: [], types: ['Sorcery'], subtypes: [] },
        oracleText: 'Search your library for a creature card, put it onto the battlefield, then shuffle.',
      }),
    );
    expect(result.status, JSON.stringify(result.missing)).toBe('complete');
    expect(result.definition.effects?.[0]?.params).toMatchObject({
      filter: { anyOfTypes: ['creature'] },
      destination: 'battlefield',
    });
  });

  it('STILL REFUSES a search whose noun is outside the closed subtype table', () => {
    // The contract that replaced the blanket refusal above: the tutor compiles
    // only when the printed word names something `CardFilter` can select. A
    // "Contraption card" search would otherwise compile into a filter matching nothing
    // — a tutor that can never find, which is strictly worse than reporting.
    const result = compileCard(
      makeCard({
        name: 'Test Contraption Tutor',
        typeLine: { supertypes: [], types: ['Sorcery'], subtypes: [] },
        oracleText: 'Search your library for a Contraption card, put it onto the battlefield, then shuffle.',
      }),
    );
    expect(result.status).toBe('incomplete');
  });

  it('COMPILES a colored anthem now that the static filter carries colour', () => {
    // This test used to pin the refusal. `CardFilter` gained `anyOfColors`
    // (read from cost pips by the same reader protection uses), so the honest
    // answer flipped: the engine can express "White creatures you control".
    const result = compileCard(
      makeCard({
        name: 'Test Honor',
        typeLine: { supertypes: [], types: ['Enchantment'], subtypes: [] },
        oracleText: 'White creatures you control get +1/+1.',
      }),
    );
    expect(result.status, JSON.stringify(result.missing)).toBe('complete');
    expect(result.definition.statics?.[0]?.affects).toMatchObject({ anyOfColors: ['W'] });
  });

  it('REFUSES an anthem whose colour word is not a colour the engine knows', () => {
    // The refusal that MUST survive: a quality outside the closed colour table
    // is not silently dropped down to a colourless anthem.
    const result = compileCard(
      makeCard({
        name: 'Test Honor',
        typeLine: { supertypes: [], types: ['Enchantment'], subtypes: [] },
        oracleText: 'Legendary creatures you control get +1/+1.',
      }),
    );
    expect(result.status).toBe('incomplete');
  });

  it('COMPILES an until-end-of-turn team pump, and NEVER as a static (different mechanic)', () => {
    // ⚠️ This case used to assert `incomplete`, and that half is obsolete: §3.153
    // gave the compiler the mass until-end-of-turn modification, so Overrun's own
    // sentence has a rule now. The half that MATTERS is unchanged and is the
    // reason the case survives rather than being deleted — an anthem and a
    // team pump read almost identically and are different mechanics. A static
    // would last forever and reach creatures that arrive later; this must be a
    // DURATION, registered as an effect, gone at cleanup.
    const result = compileCard(
      makeCard({
        name: 'Test Overrun Lite',
        typeLine: { supertypes: [], types: ['Instant'], subtypes: [] },
        oracleText: 'Creatures you control get +1/+1 until end of turn.',
      }),
    );
    expect(result.status, JSON.stringify(result.missing)).toBe('complete');
    expect(result.definition.statics).toBeUndefined();
    expect(result.definition.effects?.[0]?.primitive).toBe('grantKeywordToYoursUntilEndOfTurn');
  });

  it('REFUSES a permanently-controlling theft ("gain control of target creature" with no duration)', () => {
    const result = compileCard(
      makeCard({
        name: 'Test Mind Control',
        typeLine: { supertypes: [], types: ['Enchantment'], subtypes: [] },
        oracleText: 'Gain control of target creature.',
      }),
    );
    expect(result.status).toBe('incomplete');
  });
});

// --- play: the compiled cards behave as printed in real games ---------------------

function getByName(name: string): CardDefinition {
  const card = CARD_POOL.find((c) => c.name === name);
  if (!card) throw new Error(`pool missing ${name}`);
  return card;
}

const ISLAND = getByName('Island');
const FOREST = getByName('Forest');
const SERRA = getByName('Serra Angel');
const BOLT = getByName('Lightning Bolt');

function deck(def: CardDefinition, n = DECK_SIZE): { cards: CardDefinition[] } {
  return { cards: Array.from({ length: n }, () => def) };
}

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
  const plenty = DECK_SIZE;
  state.players[player].manaPool = { W: plenty, U: plenty, B: plenty, R: plenty, G: plenty, C: plenty };
}

let syntheticId = 91_000;

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
  return act(state, { kind: 'answerChoice', player: choice.chooser, choiceId: choice.id, answer: value }, reg);
}

/** Resolve the stack, answering each parked question with `reply`. */
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

describe('template gaps — the compiled cards play as printed', () => {
  const reg = buildRegistry(CARD_POOL);

  it('Sakura-Tribe Elder: sacrifice, search, and the basic land enters tapped', () => {
    const state = gameAtMain(reg, SEEDS.elder);
    const elder = instance(compileCard(SAKURA_TRIBE_ELDER).definition, 'A', 'battlefield');
    state.battlefield.push(elder);
    const forest = instance(FOREST, 'A', 'library');
    state.players.A.library = [forest, ...state.players.A.library];

    let s = act(state, { kind: 'activateAbility', player: 'A', instanceId: elder.instanceId, abilityIndex: 0 }, reg);
    // The sacrifice is part of the COST: the Elder is gone before resolution.
    expect(s.players.A.graveyard.some((c) => c.instanceId === elder.instanceId)).toBe(true);
    s = settle(s, reg, (choice) => {
      expect(choice.kind).toBe('selectCards');
      return { kind: 'selectCards', instanceIds: [forest.instanceId] };
    });

    const land = s.battlefield.find((c) => c.instanceId === forest.instanceId);
    expect(land, 'the searched Forest is on the battlefield').toBeDefined();
    expect(land!.tapped, 'it entered tapped, as printed').toBe(true);
  });

  it('Rampant Growth: cast, search, land arrives tapped', () => {
    const state = gameAtMain(reg, SEEDS.rampant);
    floodMana(state, 'A');
    const [growth] = (state.players.A.hand = [instance(compileCard(RAMPANT_GROWTH).definition, 'A', 'hand')]);
    const forest = instance(FOREST, 'A', 'library');
    state.players.A.library = [forest, ...state.players.A.library];

    let s = act(state, { kind: 'castSpell', player: 'A', instanceId: growth!.instanceId }, reg);
    s = settle(s, reg, () => ({ kind: 'selectCards', instanceIds: [forest.instanceId] }));

    const land = s.battlefield.find((c) => c.instanceId === forest.instanceId);
    expect(land).toBeDefined();
    expect(land!.tapped).toBe(true);
  });

  it('Act of Treason: the stolen creature changes controller, untaps, and has haste', () => {
    const state = gameAtMain(reg, SEEDS.treason);
    floodMana(state, 'A');
    const victim = instance(SERRA, 'B', 'battlefield');
    victim.tapped = true;
    state.battlefield.push(victim);
    const [treason] = (state.players.A.hand = [instance(compileCard(ACT_OF_TREASON).definition, 'A', 'hand')]);

    let s = act(
      state,
      { kind: 'castSpell', player: 'A', instanceId: treason!.instanceId, targets: [victim.instanceId] },
      reg,
    );
    s = settle(s, reg, () => {
      throw new Error('Act of Treason should ask nothing');
    });

    const stolen = s.battlefield.find((c) => c.instanceId === victim.instanceId)!;
    expect(stolen.controller, 'controller changed until end of turn').toBe('A');
    expect(stolen.tapped, 'untapped by the printed rider').toBe(false);
    const mod = indexContinuous(s).get(stolen.instanceId) ?? NO_MOD;
    expect(hasKeyword(stolen, 'haste', mod), 'haste granted by the printed rider').toBe(true);
  });

  it('Raise Dead: only creature cards are offered, and the chosen one returns to hand', () => {
    const state = gameAtMain(reg, SEEDS.raiseDead);
    floodMana(state, 'A');
    const deadSerra = instance(SERRA, 'A', 'graveyard');
    const deadBolt = instance(BOLT, 'A', 'graveyard');
    state.players.A.graveyard = [deadSerra, deadBolt];
    const [raise] = (state.players.A.hand = [instance(compileCard(RAISE_DEAD).definition, 'A', 'hand')]);

    let s = act(state, { kind: 'castSpell', player: 'A', instanceId: raise!.instanceId }, reg);
    s = settle(s, reg, (choice) => {
      expect(choice.kind).toBe('selectCards');
      const offered = (choice as { candidates: ReadonlyArray<{ instanceId: number }> }).candidates.map(
        (c) => c.instanceId,
      );
      expect(offered, 'the Bolt is not a creature card and must not be offered').toEqual([
        deadSerra.instanceId,
      ]);
      return { kind: 'selectCards', instanceIds: [deadSerra.instanceId] };
    });

    expect(s.players.A.hand.some((c) => c.instanceId === deadSerra.instanceId)).toBe(true);
    expect(s.players.A.graveyard.some((c) => c.instanceId === deadBolt.instanceId)).toBe(true);
  });

  it('Mind Rot: the targeted player chooses and discards two cards', () => {
    const state = gameAtMain(reg, SEEDS.mindRot);
    floodMana(state, 'A');
    const kept = instance(ISLAND, 'B', 'hand');
    const tossedA = instance(ISLAND, 'B', 'hand');
    const tossedB = instance(ISLAND, 'B', 'hand');
    state.players.B.hand = [kept, tossedA, tossedB];
    const [rot] = (state.players.A.hand = [instance(compileCard(MIND_ROT).definition, 'A', 'hand')]);

    let s = act(state, { kind: 'castSpell', player: 'A', instanceId: rot!.instanceId, targets: ['B'] }, reg);
    s = settle(s, reg, (choice) => {
      // The VICTIM picks — that is the printed card ("target player discards").
      expect(choice.chooser).toBe('B');
      return { kind: 'selectCards', instanceIds: [tossedA.instanceId, tossedB.instanceId] };
    });

    expect(s.players.B.hand.map((c) => c.instanceId)).toEqual([kept.instanceId]);
    expect(s.players.B.graveyard.map((c) => c.instanceId).sort()).toEqual(
      [tossedA.instanceId, tossedB.instanceId].sort(),
    );
  });

  it('Sign in Blood: the targeted opponent draws two and loses 2 life', () => {
    const state = gameAtMain(reg, SEEDS.signInBlood);
    floodMana(state, 'A');
    const handBefore = state.players.B.hand.length;
    const lifeBefore = state.players.B.life;
    const [sign] = (state.players.A.hand = [instance(compileCard(SIGN_IN_BLOOD).definition, 'A', 'hand')]);

    let s = act(state, { kind: 'castSpell', player: 'A', instanceId: sign!.instanceId, targets: ['B'] }, reg);
    s = settle(s, reg, () => {
      throw new Error('Sign in Blood should ask nothing');
    });

    expect(s.players.B.hand.length, 'the TARGET drew, not the caster').toBe(handBefore + 2);
    expect(s.players.B.life, 'the TARGET lost the life').toBe(lifeBefore - 2);
    expect(s.players.A.life).toBe(state.players.A.life);
  });

  it('Glorious Anthem: +1/+1 to its controller\'s creatures only, gone when it leaves', () => {
    const state = gameAtMain(reg, SEEDS.anthem);
    const anthem = instance(compileCard(GLORIOUS_ANTHEM).definition, 'A', 'battlefield');
    const mine = instance(SERRA, 'A', 'battlefield');
    const theirs = instance(SERRA, 'B', 'battlefield');
    state.battlefield.push(anthem, mine, theirs);

    const mods = indexContinuous(state);
    expect(effectivePower(mine, mods.get(mine.instanceId) ?? NO_MOD)).toBe((SERRA.power ?? 0) + 1);
    expect(effectivePower(theirs, mods.get(theirs.instanceId) ?? NO_MOD)).toBe(SERRA.power ?? 0);

    // Lifetime is derived from the battlefield: remove the anthem, the buff is gone.
    state.battlefield = state.battlefield.filter((c) => c.instanceId !== anthem.instanceId);
    const after = indexContinuous(state);
    expect(effectivePower(mine, after.get(mine.instanceId) ?? NO_MOD)).toBe(SERRA.power ?? 0);
  });
});
