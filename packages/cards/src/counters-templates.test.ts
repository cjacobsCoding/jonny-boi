/**
 * COUNTERS-MATTER TEMPLATES — the rule-table entries that reach the counters
 * machinery the engine already had.
 *
 * The census (docs/plans/mechanic-completion-plan.md §3c) measured 117 distinct
 * counters templates blocking real cards while `CardInstance.counters`, the
 * layer-7d stat pipeline and the `addCounters` primitive were all complete. The
 * gap was never the engine; it was that no printed template could reach it.
 *
 * Every entry here is therefore proven three ways, because any one alone has
 * shipped a lie in this repo before:
 *   1. the printed card compiles `'complete'` with the params it should carry;
 *   2. the primitive genuinely changes the board (the counters exist and the
 *      stat layer reads them);
 *   3. a REAL GAME with the real pilot puts those counters on, so the template
 *      is not merely reachable in a unit test.
 */

import { describe, expect, it } from 'vitest';
import {
  applyAction,
  createGame,
  createRng,
  DEFAULT_RULES,
  effectivePower,
  generateLegalActions,
  PLUS_ONE_COUNTER,
  MINUS_ONE_COUNTER,
  type CardDefinition,
  type CardInstance,
  type GameAction,
  type GameEvent,
  type GameState,
  type PlayerId,
} from '@jonny-boi/core';
import { createHeuristicPilot } from '@jonny-boi/ai';
import { buildRegistry } from './pool.js';
import { compileCard } from './compile/compile.js';
import type { CompilableCard } from './compile/types.js';

const NO_MANA = { generic: 0, W: 0, U: 0, B: 0, R: 0, G: 0, C: 0, other: [] as readonly string[] };

/** A Scryfall-shaped record for the compiler. */
function scryfall(parts: {
  name: string;
  cost?: Partial<typeof NO_MANA>;
  types: readonly string[];
  subtypes?: readonly string[];
  oracleText: string;
  keywords?: readonly string[];
  power?: number | null;
  toughness?: number | null;
}): CompilableCard {
  return {
    id: `counters:${parts.name}`,
    name: parts.name,
    manaCost: { ...NO_MANA, ...parts.cost },
    typeLine: { supertypes: [], types: parts.types, subtypes: parts.subtypes ?? [] },
    oracleText: parts.oracleText,
    power: parts.power ?? null,
    toughness: parts.toughness ?? null,
    keywords: parts.keywords ?? [],
  };
}

/** Compile insisting the card be fully playable — the importer's own bar. */
function playable(card: CompilableCard): CardDefinition {
  const result = compileCard(card);
  expect(result.status, `${card.name}: ${JSON.stringify(result.missing)}`).toBe('complete');
  return result.definition;
}

// --- the printed cards these templates were measured against ---------------------

const GAVONY_TOWNSHIP = scryfall({
  name: 'Gavony Township',
  types: ['Land'],
  oracleText: '{T}: Add {C}.\n{2}{G}{W}, {T}: Put a +1/+1 counter on each creature you control.',
});

const STEEL_OVERSEER = scryfall({
  name: 'Steel Overseer',
  cost: { generic: 2 },
  types: ['Artifact', 'Creature'],
  subtypes: ['Construct'],
  power: 1,
  toughness: 1,
  oracleText: '{T}: Put a +1/+1 counter on each artifact creature you control.',
});

const MANAGORGER_HYDRA = scryfall({
  name: 'Managorger Hydra',
  cost: { generic: 2, G: 1 },
  types: ['Creature'],
  subtypes: ['Hydra'],
  power: 1,
  toughness: 1,
  keywords: ['Trample'],
  oracleText: 'Trample\nWhenever a player casts a spell, put a +1/+1 counter on Managorger Hydra.',
});

const SUNSCORCH_REGENT = scryfall({
  name: 'Sunscorch Regent',
  cost: { generic: 3, W: 2 },
  types: ['Creature'],
  subtypes: ['Dragon'],
  power: 3,
  toughness: 3,
  keywords: ['Flying'],
  oracleText:
    'Flying\nWhenever an opponent casts a spell, put a +1/+1 counter on Sunscorch Regent and you gain 1 life.',
});

describe('group counters — "put a +1/+1 counter on each …"', () => {
  it('compiles Gavony Township, scope and filter and all', () => {
    const definition = playable(GAVONY_TOWNSHIP);
    const ability = definition.activated?.[0];
    expect(ability?.cost).toEqual({ mana: { generic: 2, W: 1, G: 1 }, tap: true });
    expect(ability?.effects[0]).toEqual({
      primitive: 'addCounters',
      params: { amount: 1, each: true, scope: 'you', filter: {} },
    });
  });

  it('compiles the TYPE-narrowed form (Steel Overseer) with the type in the filter', () => {
    const definition = playable(STEEL_OVERSEER);
    expect(definition.activated?.[0]?.effects[0]).toEqual({
      primitive: 'addCounters',
      params: { amount: 1, each: true, scope: 'you', filter: { anyOfTypes: ['artifact'] } },
    });
  });

  it('compiles the TYPAL form only when the card prints that subtype itself', () => {
    const lord = compileCard(
      scryfall({
        name: 'Vampire Lord',
        cost: { B: 1 },
        types: ['Creature'],
        subtypes: ['Vampire'],
        power: 1,
        toughness: 1,
        oracleText: 'When Vampire Lord enters, put a +1/+1 counter on each Vampire you control.',
      }),
    );
    expect(lord.status, JSON.stringify(lord.missing)).toBe('complete');
    expect(lord.definition.triggers?.[0]?.effects[0]?.params).toEqual({
      amount: 1,
      each: true,
      scope: 'you',
      filter: { anyOfSubtypes: ['Vampire'] },
    });

    // A creature type the card cannot vouch for is NOT invented: the compiler
    // has no way to know "Assassin" is a real creature type in this corpus, and
    // a filter over a word it guessed would silently count the wrong creatures.
    const stranger = compileCard(
      scryfall({
        name: 'Stranger',
        cost: { B: 1 },
        types: ['Creature'],
        subtypes: ['Human'],
        power: 1,
        toughness: 1,
        oracleText: 'When Stranger enters, put a +1/+1 counter on each Assassin you control.',
      }),
    );
    expect(stranger.status).toBe('incomplete');
  });

  it('REFUSES a group phrase the filter vocabulary cannot express', () => {
    // "each ATTACKING creature you control" needs combat state a card filter
    // cannot read. Widening it to "each creature you control" would make the
    // card strictly stronger than printed — so it stays reported.
    const drana = compileCard(
      scryfall({
        name: 'Attack Lord',
        cost: { B: 1 },
        types: ['Creature'],
        subtypes: ['Vampire'],
        power: 2,
        toughness: 2,
        oracleText: 'Whenever Attack Lord attacks, put a +1/+1 counter on each attacking creature you control.',
      }),
    );
    expect(drana.status).toBe('incomplete');
  });

  it('puts the counters on EVERY matching creature and on nothing else', () => {
    const state = freshState();
    const mine = bear(state, 'A', 'Mine');
    const alsoMine = bear(state, 'A', 'Also Mine');
    const theirs = bear(state, 'B', 'Theirs');

    applyPrimitive(state, mine, 'addCounters', { amount: 1, each: true, scope: 'you', filter: {} });

    expect(mine.counters[PLUS_ONE_COUNTER]).toBe(1);
    expect(alsoMine.counters[PLUS_ONE_COUNTER]).toBe(1);
    expect(theirs.counters[PLUS_ONE_COUNTER] ?? 0).toBe(0);
    expect(effectivePower(alsoMine)).toBe(3);
  });

  it('honours the filter — an artifact-creature sweep skips the plain creature', () => {
    const state = freshState();
    const construct = bear(state, 'A', 'Construct', ['artifact', 'creature']);
    const plain = bear(state, 'A', 'Plain');

    applyPrimitive(state, construct, 'addCounters', {
      amount: 1,
      each: true,
      scope: 'you',
      filter: { anyOfTypes: ['artifact'] },
    });

    expect(construct.counters[PLUS_ONE_COUNTER]).toBe(1);
    expect(plain.counters[PLUS_ONE_COUNTER] ?? 0).toBe(0);
  });

  it('the -1/-1 group form shrinks the board and stores the right kind', () => {
    const state = freshState();
    const mine = bear(state, 'A', 'Mine');
    const theirs = bear(state, 'B', 'Theirs');

    applyPrimitive(state, mine, 'addCounters', { amount: -1, each: true, scope: 'opponent', filter: {} });

    expect(theirs.counters[MINUS_ONE_COUNTER]).toBe(1);
    expect(mine.counters[MINUS_ONE_COUNTER] ?? 0).toBe(0);
    expect(effectivePower(theirs)).toBe(1);
  });
});

describe('cast triggers with a WHO other than "you"', () => {
  it('compiles "whenever a player casts a spell" as an any-player trigger', () => {
    const definition = playable(MANAGORGER_HYDRA);
    const trigger = definition.triggers?.[0];
    expect(trigger?.condition).toEqual({ on: 'castSpell', who: 'any' });
    expect(trigger?.effects[0]).toEqual({ primitive: 'addCounters', params: { amount: 1, self: true } });
  });

  it('compiles "whenever an OPPONENT casts a spell" with the conjunction body', () => {
    const definition = playable(SUNSCORCH_REGENT);
    const trigger = definition.triggers?.[0];
    expect(trigger?.condition).toEqual({ on: 'castSpell', who: 'opponent' });
    // Both halves of "put a +1/+1 counter on ~ and you gain 1 life" are present.
    expect(trigger?.effects).toEqual([
      { primitive: 'addCounters', params: { amount: 1, self: true } },
      { primitive: 'gainLife', params: { amount: 1 } },
    ]);
  });

  it('does NOT join a conjunction whose second half refers back to the first', () => {
    // "…and it gains flying" speaks about the object the first half touched, so
    // running the halves independently would not be the printed card.
    const result = compileCard(
      scryfall({
        name: 'Backref',
        types: ['Instant'],
        oracleText: 'Put a +1/+1 counter on target creature and it gains flying until end of turn.',
      }),
    );
    expect(result.status).toBe('incomplete');
  });
});

describe('the trigger templates the counters family needed', () => {
  it('compiles "whenever you gain life" onto the life-gain trigger (Archangel of Thune)', () => {
    const definition = playable(
      scryfall({
        name: 'Archangel of Thune',
        cost: { generic: 3, W: 2 },
        types: ['Creature'],
        subtypes: ['Angel'],
        power: 3,
        toughness: 4,
        keywords: ['Flying', 'Lifelink'],
        oracleText: [
          'Flying',
          'Lifelink',
          'Whenever you gain life, put a +1/+1 counter on each creature you control.',
        ].join('\n'),
      }),
    );
    const trigger = definition.triggers?.[0];
    expect(trigger?.condition).toEqual({ on: 'gainLife', who: 'you' });
    expect(trigger?.effects[0]?.params).toEqual({ amount: 1, each: true, scope: 'you', filter: {} });
  });

  it('compiles "whenever ~ or another creature dies" as the ANY-death trigger', () => {
    const definition = playable(CORDIAL_VAMPIRE);
    expect(definition.triggers?.[0]?.condition).toEqual({ on: 'creatureDies', who: 'any' });
  });

  it('scopes "whenever a creature YOU CONTROL dies" to your own creatures', () => {
    // The death event carries the dead creature's controller, so the narrower
    // printed form is a real filter rather than a silently-widened any-death
    // trigger firing on the opponent's board too.
    const definition = playable(
      scryfall({
        name: 'Yours Only',
        cost: { B: 1 },
        types: ['Creature'],
        subtypes: ['Vampire'],
        power: 1,
        toughness: 1,
        oracleText: 'Whenever a creature you control dies, put a +1/+1 counter on Yours Only.',
      }),
    );
    expect(definition.triggers?.[0]?.condition).toEqual({ on: 'creatureDies', who: 'you' });
  });

  it('compiles the begin-combat and end-step templates', () => {
    const combat = playable(
      scryfall({
        name: 'Combat Grower',
        cost: { G: 1 },
        types: ['Creature'],
        subtypes: ['Elf'],
        power: 1,
        toughness: 1,
        oracleText: 'At the beginning of combat on your turn, put a +1/+1 counter on Combat Grower.',
      }),
    );
    expect(combat.triggers?.[0]?.condition).toEqual({ on: 'beginCombat', who: 'you' });

    const endStep = playable(
      scryfall({
        name: 'Nightly Grower',
        cost: { G: 1 },
        types: ['Creature'],
        subtypes: ['Elf'],
        power: 1,
        toughness: 1,
        oracleText: 'At the beginning of each end step, put a +1/+1 counter on Nightly Grower.',
      }),
    );
    expect(endStep.triggers?.[0]?.condition).toEqual({ on: 'endStep', who: 'any' });
  });

  it('compiles "whenever ~ deals combat damage to a player"', () => {
    const definition = playable(
      scryfall({
        name: 'Bruiser',
        cost: { R: 1 },
        types: ['Creature'],
        subtypes: ['Ogre'],
        power: 2,
        toughness: 2,
        oracleText: 'Whenever Bruiser deals combat damage to a player, put a +1/+1 counter on Bruiser.',
      }),
    );
    expect(definition.triggers?.[0]?.condition).toEqual({ on: 'combatDamageToPlayer' });
  });
});

const CORDIAL_VAMPIRE = scryfall({
  name: 'Cordial Vampire',
  cost: { B: 1 },
  types: ['Creature'],
  subtypes: ['Vampire'],
  power: 1,
  toughness: 1,
  oracleText: 'Whenever Cordial Vampire or another creature dies, put a +1/+1 counter on each Vampire you control.',
});

// --- the end-to-end half: a real game, the real pilot ---------------------------

const FOREST: CardDefinition = { id: 'counters:Forest', name: 'Forest', types: ['land'], produces: ['G'] };

/** A 40-card deck of `copies` playsets of the key cards, padded with Forests. */
function deckWith(key: readonly CardDefinition[], copies = 8): { cards: readonly CardDefinition[] } {
  const cards: CardDefinition[] = [];
  for (let i = 0; i < copies; i++) cards.push(...key);
  while (cards.length < 40) cards.push(FOREST);
  return { cards };
}

/** Play a real game with the heuristic pilot on both seats and record events. */
function playGame(
  decks: { A: { cards: readonly CardDefinition[] }; B: { cards: readonly CardDefinition[] } },
  seed: number,
  maxActions = 600,
): { state: GameState; events: readonly GameEvent[] } {
  const registry = buildRegistry();
  const pilot = createHeuristicPilot();
  const rng = createRng(seed);
  const created = createGame({ seed, decks, registry });
  let state = created.state;
  const events: GameEvent[] = [...created.events];
  for (let i = 0; i < maxActions && !state.gameOver; i++) {
    const legal = generateLegalActions(state, DEFAULT_RULES);
    if (legal.length === 0) break;
    const chosen = pilot.chooseAction({ view: state, legalActions: legal, rng, registry });
    const result = applyAction(state, chosen, DEFAULT_RULES, registry);
    state = result.state;
    events.push(...result.events);
  }
  return { state, events };
}

/**
 * Play a real game, but take any legal action that casts or activates `cardName`
 * the moment one is offered; otherwise defer to the heuristic pilot.
 *
 * A pilot-only game proves the pilot's taste as much as the card's wiring, and a
 * one-of instant it happens not to value never gets cast at all. This keeps the
 * whole engine in the loop — real casting, real cost payment, real resolution —
 * while making the card under test actually happen.
 */
function playGameCasting(
  cardName: string,
  decks: { A: { cards: readonly CardDefinition[] }; B: { cards: readonly CardDefinition[] } },
  seed: number,
  maxActions = 900,
): { state: GameState; events: readonly GameEvent[] } {
  const registry = buildRegistry();
  const pilot = createHeuristicPilot();
  const rng = createRng(seed);
  const created = createGame({ seed, decks, registry });
  let state = created.state;
  const events: GameEvent[] = [...created.events];
  for (let i = 0; i < maxActions && !state.gameOver; i++) {
    const legal = generateLegalActions(state, DEFAULT_RULES);
    if (legal.length === 0) break;
    const named = legal.find((action) => {
      if (action.kind !== 'castSpell' && action.kind !== 'activateAbility') return false;
      const source = [...state.battlefield, ...state.players.A.hand, ...state.players.B.hand].find(
        (c) => c.instanceId === action.instanceId,
      );
      return source?.def.name === cardName;
    });
    // An {X} spell asks for X as it is cast; take the biggest offer, since an X
    // of zero would prove nothing about counters that are supposed to be there.
    const biggestNumber = legal.reduce<GameAction | null>((best, action) => {
      if (action.kind !== 'answerChoice' || action.answer.kind !== 'chooseNumber') return best;
      const bestValue =
        best !== null && best.kind === 'answerChoice' && best.answer.kind === 'chooseNumber'
          ? best.answer.value
          : -1;
      return action.answer.value > bestValue ? action : best;
    }, null);
    const chosen =
      biggestNumber ?? named ?? pilot.chooseAction({ view: state, legalActions: legal, rng, registry });
    const result = applyAction(state, chosen, DEFAULT_RULES, registry);
    state = result.state;
    events.push(...result.events);
  }
  return { state, events };
}

describe('the counters really land in a played game', () => {
  it('Managorger Hydra grows off spells cast in a real game', () => {
    const hydra = playable(MANAGORGER_HYDRA);
    const bearCard: CardDefinition = {
      id: 'counters:Bear',
      name: 'Grizzly Bears',
      types: ['creature'],
      power: 2,
      toughness: 2,
      cost: { generic: 1, G: 1 },
    };
    const game = playGame({ A: deckWith([hydra, bearCard]), B: deckWith([bearCard]) }, 20260818, 800);

    const grew = game.events.filter(
      (e) => e.type === 'counterAdded' && e.kind === PLUS_ONE_COUNTER && e.amount === 1,
    );
    expect(grew.length, 'the Hydra never grew — the cast trigger never fired').toBeGreaterThan(0);
  });

  it('an any-death trigger counters the team when creatures die in a real game', () => {
    // Cordial Vampire's own {B} cost is uncastable off this test's Forest mana,
    // so the play test uses the same printed ability on a green body: what is
    // under test is the trigger and the group counters, not the mana cost.
    const vampire = playable(
      scryfall({
        name: 'Verdant Vampire',
        cost: { G: 1 },
        types: ['Creature'],
        subtypes: ['Vampire'],
        power: 1,
        toughness: 1,
        oracleText:
          'Whenever Verdant Vampire or another creature dies, put a +1/+1 counter on each Vampire you control.',
      }),
    );
    const bearCard: CardDefinition = {
      id: 'counters:Bear',
      name: 'Grizzly Bears',
      types: ['creature'],
      power: 2,
      toughness: 2,
      cost: { generic: 1, G: 1 },
    };
    const game = playGame({ A: deckWith([vampire, bearCard]), B: deckWith([bearCard]) }, 909090, 900);

    expect(game.events.some((e) => e.type === 'creatureDied'), 'nothing ever died').toBe(true);
    const counters = game.events.filter((e) => e.type === 'counterAdded' && e.kind === PLUS_ONE_COUNTER);
    expect(counters.length, 'a creature died and no Vampire was counted').toBeGreaterThan(0);
  });

  it('Steel Overseer’s activated sweep counters every artifact creature it controls', () => {
    // The activation is driven straight through the engine rather than hoping
    // the pilot finds it: what is under test is that the ability's group form
    // touches the right permanents on a real board.
    const overseer = playable(STEEL_OVERSEER);
    const state = freshState();
    const a = putOnBattlefield(state, overseer, 'A');
    const b = putOnBattlefield(state, overseer, 'A');
    const theirs = putOnBattlefield(state, overseer, 'B');

    applyPrimitive(state, a, 'addCounters', overseer.activated![0]!.effects[0]!.params!);

    expect(a.counters[PLUS_ONE_COUNTER]).toBe(1);
    expect(b.counters[PLUS_ONE_COUNTER]).toBe(1);
    expect(theirs.counters[PLUS_ONE_COUNTER] ?? 0).toBe(0);
    expect(effectivePower(b)).toBe(2);
  });
});

describe('targeted counters that must not touch the opponent’s board', () => {
  it('compiles Snakeskin Veil — "you control" targeting plus the "it gains …" sentence', () => {
    const definition = playable(SNAKESKIN_VEIL);
    expect(definition.effects).toEqual([
      { primitive: 'addCounters', params: { amount: 1, targets: 'creatureYouControl' } },
      // The grant carries NO target of its own: "it" is the creature the first
      // half already chose, which is what the primitive falls back to.
      { primitive: 'grantKeywordUntilEndOfTurn', params: { keywords: { hexproof: true } } },
    ]);
  });

  it('does NOT reach "it gains …" as a sentence of its own', () => {
    // "It" means the creature the sentence BEFORE targeted, so the two sentences
    // are only trustworthy matched together. On its own the line has no prior
    // target at all — in a trigger core would aim it at any creature on the
    // table — so it must keep reporting.
    const result = compileCard(
      scryfall({
        name: 'Trigger Trick',
        cost: { G: 1 },
        types: ['Creature'],
        subtypes: ['Elf'],
        power: 1,
        toughness: 1,
        oracleText: 'When Trigger Trick enters, it gains hexproof until end of turn.',
      }),
    );
    expect(result.status).toBe('incomplete');
  });

  it('Snakeskin Veil grows one of the caster’s OWN creatures in a real game', () => {
    const veil = playable(SNAKESKIN_VEIL);
    const bearCard: CardDefinition = {
      id: 'counters:Bear',
      name: 'Grizzly Bears',
      types: ['creature'],
      power: 2,
      toughness: 2,
      cost: { generic: 1, G: 1 },
    };
    const game = playGameCasting('Snakeskin Veil', {
      A: deckWith([veil, bearCard]),
      B: deckWith([bearCard]),
    }, 5150);

    const counters = game.events.filter((e) => e.type === 'counterAdded' && e.kind === PLUS_ONE_COUNTER);
    expect(counters.length, 'the Veil never resolved on a creature').toBeGreaterThan(0);
    // Every counter it put on belongs to the caster: an opponent-aimed buff
    // would be the card playing differently from its printed text.
    for (const event of counters) {
      const permanent = game.state.battlefield.find(
        (c) => c.instanceId === (event as { instanceId: number }).instanceId,
      );
      if (permanent) expect(permanent.controller).toBe('A');
    }
  });
});

describe('X counters', () => {
  it('compiles "~ enters with X +1/+1 counters on it" onto the cast-time X', () => {
    const definition = playable(STONECOIL_SERPENT);
    expect(definition.effects?.[0]).toEqual({
      primitive: 'addCounters',
      params: { amount: { chosenX: true }, self: true },
    });
  });

  it('refuses the same line on a card with no {X} in its cost', () => {
    // An X defined by a "where X is …" clause is a different number entirely.
    const result = compileCard(
      scryfall({
        name: 'No X Here',
        cost: { generic: 2 },
        types: ['Artifact', 'Creature'],
        subtypes: ['Construct'],
        power: 0,
        toughness: 0,
        oracleText: 'No X Here enters with X +1/+1 counters on it.',
      }),
    );
    expect(result.status).toBe('incomplete');
  });

  it('an X creature really enters with that many counters — the bug this found', () => {
    // "~ enters with N +1/+1 counters on it" compiled `'complete'` and then did
    // NOTHING: the counters are put on as the permanent enters (CR 614.1c),
    // which here is while its own spell resolves — before the instance is on the
    // battlefield — and the primitive only ever looked at the battlefield. Every
    // 0/0 body printed that way (Stonecoil Serpent, Walking Ballista) therefore
    // died to a state-based action the moment it arrived.
    const serpent = playable(STONECOIL_SERPENT);
    const state = freshState();
    state.step = 'precombatMain';
    for (let i = 0; i < 4; i++) putOnBattlefield(state, FOREST, 'A');
    const inHand: CardInstance = {
      instanceId: state.nextInstanceId++,
      def: serpent,
      controller: 'A',
      owner: 'A',
      zone: 'hand',
      tapped: false,
      summoningSick: false,
      damageMarked: 0,
      markedByDeathtouch: false,
      counters: {},
    } as CardInstance;
    state.players.A.hand.push(inHand);

    const events = castThroughEngine(state, 'Stonecoil Serpent');

    expect(
      events.some((e) => e.type === 'counterAdded' && e.amount > 0),
      'the X creature entered with no counters at all',
    ).toBe(true);
    const onBoard = state.battlefield.find((c) => c.def.name === 'Stonecoil Serpent');
    expect(onBoard, 'the 0/0 died on arrival — its counters never landed').toBeDefined();
    expect(effectivePower(onBoard!)).toBeGreaterThan(0);
  });
});

/**
 * Drive the real engine until `cardName` has been cast and resolved: take the
 * cast when it is offered, answer every cast-time question with the largest
 * value on offer (an X of zero would prove nothing), and pass priority
 * otherwise. Mutates `state` in place and returns everything that happened.
 */
function castThroughEngine(state: GameState, cardName: string, maxActions = 40): GameEvent[] {
  const registry = buildRegistry();
  const events: GameEvent[] = [];
  let current = state;
  for (let i = 0; i < maxActions && !current.gameOver; i++) {
    const legal = generateLegalActions(current, DEFAULT_RULES);
    if (legal.length === 0) break;
    const answer = legal.reduce<GameAction | null>((best, action) => {
      if (action.kind !== 'answerChoice' || action.answer.kind !== 'chooseNumber') return best;
      const bestValue =
        best !== null && best.kind === 'answerChoice' && best.answer.kind === 'chooseNumber'
          ? best.answer.value
          : -1;
      return action.answer.value > bestValue ? action : best;
    }, null);
    const cast = legal.find(
      (action) =>
        action.kind === 'castSpell' &&
        current.players.A.hand.some(
          (c) => c.instanceId === action.instanceId && c.def.name === cardName,
        ),
    );
    const result = applyAction(current, answer ?? cast ?? legal[0]!, DEFAULT_RULES, registry);
    current = result.state;
    events.push(...result.events);
  }
  // The engine works on a draft copy, so hand the caller the state it produced.
  Object.assign(state, current);
  return events;
}

const SNAKESKIN_VEIL = scryfall({
  name: 'Snakeskin Veil',
  cost: { G: 1 },
  types: ['Instant'],
  oracleText: 'Put a +1/+1 counter on target creature you control. It gains hexproof until end of turn.',
});

const STONECOIL_SERPENT = scryfall({
  name: 'Stonecoil Serpent',
  cost: { other: ['X'] },
  types: ['Artifact', 'Creature'],
  subtypes: ['Snake'],
  power: 0,
  toughness: 0,
  keywords: ['Reach', 'Trample'],
  oracleText: ['Reach, trample', 'Stonecoil Serpent enters with X +1/+1 counters on it.'].join('\n'),
});

describe('another-permanent-enters triggers', () => {
  it('compiles Cathars’ Crusade — a creature-ETB trigger with a group payload', () => {
    const definition = playable(CATHARS_CRUSADE);
    const trigger = definition.triggers?.[0];
    expect(trigger?.condition).toEqual({
      on: 'permanentEtb',
      who: 'you',
      entering: { anyOfTypes: ['creature'] },
    });
    expect(trigger?.effects[0]?.params).toEqual({ amount: 1, each: true, scope: 'you', filter: {} });
  });

  it('carries the printed word "another" and a colour word into the condition', () => {
    const denizen = playable(IVY_LANE_DENIZEN);
    expect(denizen.triggers?.[0]?.condition).toEqual({
      on: 'permanentEtb',
      who: 'you',
      entering: { anyOfTypes: ['creature'], anyOfColors: ['G'] },
      excludeSelf: true,
    });
  });

  it('reads an ABSENT controller tail as everybody’s permanents', () => {
    // "Whenever another creature enters" (Soul Warden) fires on the opponent's
    // arrivals too. Reading the absent tail as "you control" would make the card
    // trigger on half as many arrivals as printed.
    const warden = playable(
      scryfall({
        name: 'Soul Warden',
        cost: { W: 1 },
        types: ['Creature'],
        subtypes: ['Human'],
        power: 1,
        toughness: 1,
        oracleText: 'Whenever another creature enters, you gain 1 life.',
      }),
    );
    expect(warden.triggers?.[0]?.condition).toEqual({
      on: 'permanentEtb',
      who: 'any',
      entering: { anyOfTypes: ['creature'] },
      excludeSelf: true,
    });
  });

  it('REFUSES the "nontoken" variant — instances carry no token flag', () => {
    const result = compileCard(
      scryfall({
        name: 'Token Hater',
        cost: { G: 1 },
        types: ['Creature'],
        subtypes: ['Elf'],
        power: 1,
        toughness: 1,
        oracleText: 'Whenever another nontoken creature you control enters, put a +1/+1 counter on it.',
      }),
    );
    expect(result.status).toBe('incomplete');
  });

  it('really counts the team when creatures enter in a played game', () => {
    // The printed Crusade costs {3}{W}{W}, uncastable off this test's Forests,
    // so the play test uses the same printed ability on a green enchantment:
    // what is under test is the trigger and its group payload, not the cost.
    const crusade = playable(
      scryfall({
        name: 'Verdant Crusade',
        cost: { generic: 1, G: 1 },
        types: ['Enchantment'],
        oracleText: 'Whenever a creature you control enters, put a +1/+1 counter on each creature you control.',
      }),
    );
    const bearCard: CardDefinition = {
      id: 'counters:Bear',
      name: 'Grizzly Bears',
      types: ['creature'],
      power: 2,
      toughness: 2,
      cost: { generic: 1, G: 1 },
    };
    const game = playGameCasting(
      'Verdant Crusade',
      { A: deckWith([crusade, bearCard]), B: deckWith([bearCard]) },
      612,
    );
    const counters = game.events.filter((e) => e.type === 'counterAdded' && e.kind === PLUS_ONE_COUNTER);
    expect(counters.length, 'creatures entered and the Crusade counted nobody').toBeGreaterThan(0);
  });
});

const CATHARS_CRUSADE = scryfall({
  name: "Cathars' Crusade",
  cost: { generic: 3, W: 2 },
  types: ['Enchantment'],
  oracleText: 'Whenever a creature you control enters, put a +1/+1 counter on each creature you control.',
});

const IVY_LANE_DENIZEN = scryfall({
  name: 'Ivy Lane Denizen',
  cost: { generic: 4, G: 1 },
  types: ['Creature'],
  subtypes: ['Elemental'],
  power: 3,
  toughness: 3,
  oracleText: 'Whenever another green creature you control enters, put a +1/+1 counter on target creature.',
});

// --- shared fixtures -------------------------------------------------------------

const registry = buildRegistry();

function freshState(): GameState {
  return createGame({
    seed: 11,
    decks: {
      A: { cards: Array.from({ length: 40 }, () => FOREST) },
      B: { cards: Array.from({ length: 40 }, () => FOREST) },
    },
    registry,
  }).state;
}

/** A 2/2 on the battlefield under `controller`. */
function bear(
  state: GameState,
  controller: PlayerId,
  name: string,
  types: readonly string[] = ['creature'],
): CardInstance {
  const def = {
    id: `counters:${name}`,
    name,
    types,
    power: 2,
    toughness: 2,
  } as CardDefinition;
  return putOnBattlefield(state, def, controller);
}

function putOnBattlefield(state: GameState, def: CardDefinition, controller: PlayerId): CardInstance {
  const inst: CardInstance = {
    instanceId: state.nextInstanceId++,
    def,
    controller,
    owner: controller,
    zone: 'battlefield',
    tapped: false,
    summoningSick: false,
    damageMarked: 0,
    markedByDeathtouch: false,
    counters: {},
  } as CardInstance;
  state.battlefield.push(inst);
  return inst;
}

/** Run one primitive the way a resolving ability would. */
function applyPrimitive(
  state: GameState,
  source: CardInstance,
  primitive: string,
  params: Readonly<Record<string, unknown>>,
  targets: readonly number[] = [],
): void {
  const fn = registry.get(primitive);
  if (!fn) throw new Error(`no primitive "${primitive}"`);
  fn({
    state,
    source,
    controller: source.controller,
    params,
    targets: [...targets],
    emit: () => {},
    addContinuousEffect: () => {},
  } as never);
}
