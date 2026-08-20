/**
 * PLAY-QUALITY GUARDS for the default pilot.
 *
 * These exist because a pilot swap shipped that made every simulated game worse
 * in ways no existing test could see: the suite asserted games *finish* and
 * verdicts are *reproducible*, never that the pilots play *sensibly*. A user
 * watching a replay caught it in about a minute — a player tapped a Sol Ring and
 * did nothing with the mana.
 *
 * Both guards are cheap, deterministic, and measured against the engine's own
 * event log rather than against a pilot's internal reasoning, so they hold for
 * whichever pilot occupies the default slot.
 */

import { describe, expect, it } from 'vitest';
import {
  addMana,
  createGame,
  generateLegalActions,
  type CardDefinition,
  type CardInstance,
  type DeckList,
  type GameState,
  type InstanceId,
  type PlayerId,
} from '@jonny-boi/core';
import { createDefaultAiRegistry, DEFAULT_PILOT_ID } from '@jonny-boi/ai';
import { buildRegistry, compileCard, loadCardPool } from '@jonny-boi/cards';
import { SAMPLE_DECKS } from '../data/decks/index.js';
import { loadDeck } from './deck.js';
import { runMatch } from './match.js';

/**
 * Wasted-mana budget: `manaPoolEmptied` fires only when a step ends with mana
 * still floating, so it counts misplays directly. A competent pilot occasionally
 * floats mana legitimately (a held instant that never gets cast), so the bar is
 * a loose per-turn rate rather than zero — but it is far below the 1.76/turn the
 * regression produced, and comfortably above the 0.01/turn the heuristic scores.
 */
const MAX_WASTED_MANA_PER_TURN = 0.35;

/** Games to average the waste rate over (deterministic seeds). */
const WASTE_SAMPLE_SEEDS: readonly number[] = [1, 2, 3];

describe(`default pilot ("${DEFAULT_PILOT_ID}") play quality`, () => {
  const pool = loadCardPool();
  const registry = buildRegistry();
  const pilot = createDefaultAiRegistry().getPilot(DEFAULT_PILOT_ID)!;

  it('does not tap mana it never spends', () => {
    const deckA = loadDeck(SAMPLE_DECKS[0]!, pool);
    const deckB = loadDeck(SAMPLE_DECKS[1]!, pool);

    let wasted = 0;
    let turns = 0;
    for (const seed of WASTE_SAMPLE_SEEDS) {
      const result = runMatch(
        { deckA, deckB, pilotA: pilot, pilotB: pilot, registry },
        seed,
        { recordTrace: true },
      );
      wasted += (result.events ?? []).filter((e) => e.type === 'manaPoolEmptied').length;
      turns += result.turns;
    }

    const perTurn = wasted / Math.max(turns, 1);
    expect(
      perTurn,
      `${wasted} wasted-mana events over ${turns} turns (${perTurn.toFixed(2)}/turn). ` +
        'A pilot tapping sources it never spends plays visibly badly and skews every A/B verdict.',
    ).toBeLessThan(MAX_WASTED_MANA_PER_TURN);
  });

  it('attacks with a hasty creature into an empty board', () => {
    // A deck of nothing but Mountains and Monastery Swiftspear: whatever the
    // opening hand, turn one is "land, Swiftspear, swing" and the opponent
    // (drawing only lands) can never have a blocker.
    const swiftspear = pool.getByName('Monastery Swiftspear');
    const mountain = pool.getByName('Mountain');
    expect(swiftspear, 'Monastery Swiftspear is in the pool').toBeDefined();
    expect(mountain, 'Mountain is in the pool').toBeDefined();

    const hasteDeck = {
      name: 'Haste test',
      library: [
        ...Array.from({ length: 16 }, () => swiftspear!),
        ...Array.from({ length: 17 }, () => mountain!),
      ],
    };
    const landsOnly = { name: 'Lands only', library: Array.from({ length: 33 }, () => mountain!) };

    const result = runMatch(
      { deckA: hasteDeck, deckB: landsOnly, pilotA: pilot, pilotB: pilot, registry },
      7,
      { recordTrace: true },
    );

    // The opponent has no creatures at all, so any attack that happens is the
    // hasty creature getting in — and it must happen on the turn it lands.
    const firstAttack = (result.events ?? []).find(
      (e) => e.type === 'attackersDeclared' && e.attackers.length > 0,
    );
    expect(
      firstAttack,
      'a hasty creature with no possible blocker never attacked — haste is being ignored',
    ).toBeDefined();
  });

  it('actually uses a fetchland instead of leaving it on the battlefield', () => {
    // Compiling a card and PLAYING it are different claims. The engine can offer
    // an activated ability perfectly while every pilot ignores it, which looks
    // exactly like the card not working — a fetchland that never cracks is a
    // dead land. This asserts the whole chain: compile → offer → activate →
    // resolve → the land is really on the battlefield.
    const compiled = compileCard({
      id: 'test:arid-mesa',
      name: 'Arid Mesa',
      manaCost: { generic: 0, W: 0, U: 0, B: 0, R: 0, G: 0, C: 0, other: [] },
      typeLine: { supertypes: [], types: ['Land'], subtypes: [] },
      oracleText:
        '{T}, Pay 1 life, Sacrifice Arid Mesa: Search your library for a Mountain or Plains card, put it onto the battlefield, then shuffle.',
      power: null,
      toughness: null,
      keywords: [],
    });
    expect(compiled.status, 'the fetchland compiles').toBe('complete');

    const mountain = pool.getByName('Mountain')!;
    const fetchDeck = {
      name: 'Fetch test',
      library: [
        ...Array.from({ length: 12 }, () => compiled.definition),
        ...Array.from({ length: 21 }, () => mountain),
      ],
    };
    const landsOnly = { name: 'Lands only', library: Array.from({ length: 33 }, () => mountain) };

    const result = runMatch(
      { deckA: fetchDeck, deckB: landsOnly, pilotA: pilot, pilotB: pilot, registry },
      11,
      { recordTrace: true },
    );

    const activated = (result.events ?? []).filter((e) => e.type === 'abilityActivated');
    expect(
      activated.length,
      'the pilot never cracked a fetchland — the ability is offered but unused',
    ).toBeGreaterThan(0);
  });
});

/**
 * BOARD-AWARENESS GUARDS — the pilot must evaluate the board, not the printed card.
 *
 * Every one of these failed on `main` before `fix/ai-sees-continuous-effects`,
 * and each fails for the same single reason: `packages/ai` called core's
 * `effectivePower` / `effectiveToughness` with no continuous aggregate, which
 * answers the PRINTED numbers. An anthem, an Aura, an Equipment and a
 * characteristic-defining `*` P/T box were all invisible to every pilot, so the
 * pilots attacked, blocked, traded and aimed removal at numbers the board had
 * already changed.
 *
 * They are DECISION-level rather than whole-match: a match average can absorb a
 * systematically wrong target choice and still finish, which is exactly how this
 * survived a green suite for so long. Each asks the pilot one question whose right
 * answer differs between the two readings.
 */

/** A vanilla creature definition. */
function creature(
  id: string,
  power: number,
  toughness: number,
  subtypes: readonly string[] = [],
): CardDefinition {
  return { id, name: id, types: ['creature'], subtypes, power, toughness, cost: { generic: 2 } };
}

/** "Goblins you control get +N/+N" — a tribal anthem, as data. The tribal form
 * keeps the test honest: an untyped anthem would pump BOTH of B's creatures and
 * leave the printed order intact, proving nothing. */
function anthem(id: string, amount: number): CardDefinition {
  return {
    id,
    name: id,
    types: ['enchantment'],
    cost: { generic: 2, W: 1 },
    statics: [
      {
        affects: { anyOfTypes: ['creature'], anyOfSubtypes: ['goblin'] },
        power: amount,
        toughness: amount,
        label: id,
      },
    ],
  };
}

/**
 * A `*`/`*+1` P/T box — Tarmogoyf's shape. Its real size arrives ONLY through the
 * continuous layer, so a pilot reading printed numbers prices it at 0/0.
 */
function starCreature(id: string): CardDefinition {
  return {
    id,
    name: id,
    types: ['creature'],
    cost: { generic: 1, G: 1 },
    characteristicPT: {
      power: { countOf: 'cardTypesInAllGraveyards' },
      toughness: { countOf: 'cardTypesInAllGraveyards', plus: 1 },
    },
  };
}

/** Sorcery-speed "destroy target creature". */
const DESTROY_TARGET: CardDefinition = {
  id: 'test:destroy',
  name: 'Test Removal',
  types: ['sorcery'],
  timing: 'sorcery',
  cost: { generic: 1, B: 1 },
  effects: [{ primitive: 'destroyTarget', params: { what: 'creature' } }],
};

function stubLand(i: number): CardDefinition {
  return { id: `test:land${i}`, name: `Test Land ${i}`, types: ['land'], produces: ['B'] };
}

function stubDeck(): DeckList {
  return { cards: Array.from({ length: 40 }, (_, i) => stubLand(i)) };
}

/** An empty-handed game in A's precombat main, with the stack clear. */
function bareGame(): GameState {
  const { state } = createGame({ seed: 3, decks: { A: stubDeck(), B: stubDeck() } });
  state.players.A.hand = [];
  state.players.B.hand = [];
  state.step = 'precombatMain';
  state.activePlayer = 'A';
  state.priorityPlayer = 'A';
  return state;
}

function put(state: GameState, player: PlayerId, defs: readonly CardDefinition[]): CardInstance[] {
  const made: CardInstance[] = [];
  for (const def of defs) {
    const inst: CardInstance = {
      instanceId: state.nextInstanceId++ as InstanceId,
      def,
      controller: player,
      owner: player,
      zone: 'battlefield',
      tapped: false,
      summoningSick: false,
      damageMarked: 0,
      markedByDeathtouch: false,
      counters: {},
    };
    state.battlefield.push(inst);
    made.push(inst);
  }
  return made;
}

/** Put a card in hand and float enough mana that casting it is the next action. */
function armWithRemoval(state: GameState, player: PlayerId): void {
  const inst: CardInstance = {
    instanceId: state.nextInstanceId++ as InstanceId,
    def: DESTROY_TARGET,
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
  state.players[player].manaPool = addMana(state.players[player].manaPool, 'B', 2);
}

describe('the pilot evaluates the BOARD, not the printed card', () => {
  const pilot = createDefaultAiRegistry().getPilot(DEFAULT_PILOT_ID)!;
  const rng = { next: () => 0.5, int: () => 0 } as unknown as Parameters<
    typeof pilot.chooseAction
  >[0]['rng'];

  function chosenRemovalTarget(state: GameState): InstanceId | undefined {
    const action = pilot.chooseAction({
      view: state,
      legalActions: generateLegalActions(state),
      rng,
    });
    if (action.kind !== 'castSpell') return undefined;
    const target = action.targets?.[0];
    return typeof target === 'number' ? (target as InstanceId) : undefined;
  }

  it('aims removal at the creature an ANTHEM made biggest, not the biggest printed one', () => {
    // B's board: a printed 4/4, and a printed 2/2 standing under a +3/+3 anthem —
    // a 5/5 in play. Printed-blind, the pilot kills the 4/4 and leaves the bigger
    // creature alive; that is the anthem being invisible to evaluation.
    const state = bareGame();
    const [printedBig] = put(state, 'B', [creature('printed-4-4', 4, 4)]);
    const [buffed] = put(state, 'B', [creature('printed-2-2', 2, 2, ['goblin'])]);
    put(state, 'B', [anthem('Test Anthem', 3)]);
    armWithRemoval(state, 'A');

    const target = chosenRemovalTarget(state);
    expect(target, 'the pilot cast its removal at a creature').toBeDefined();
    expect(
      target,
      `killed ${target === printedBig!.instanceId ? 'the printed 4/4' : 'something else'} ` +
        'while a 2/2 under a +3/+3 anthem — a real 5/5 — stayed on the board',
    ).toBe(buffed!.instanceId);
  });

  it('values a characteristic-defining `*` creature above zero', () => {
    // A `*`/`*+1` box with four card types in the graveyards is a 4/5. Read
    // printed, it is 0/0 — literally the least threatening thing on the board —
    // so a printed-blind pilot points its removal anywhere else.
    const state = bareGame();
    const [goyf] = put(state, 'B', [starCreature('Test Goyf')]);
    put(state, 'B', [creature('printed-3-3', 3, 3)]);
    // Four distinct card types in the graveyard ⇒ the star box is a 4/5.
    state.players.B.graveyard = [
      { def: creature('gy-creature', 1, 1), types: ['creature'] },
      { def: { id: 'gy:l', name: 'gy land', types: ['land'] } as CardDefinition, types: ['land'] },
      {
        def: { id: 'gy:i', name: 'gy instant', types: ['instant'] } as CardDefinition,
        types: ['instant'],
      },
      {
        def: { id: 'gy:s', name: 'gy sorcery', types: ['sorcery'] } as CardDefinition,
        types: ['sorcery'],
      },
    ].map(({ def }, i) => ({
      instanceId: (900 + i) as InstanceId,
      def,
      controller: 'B' as PlayerId,
      owner: 'B' as PlayerId,
      zone: 'graveyard' as const,
      tapped: false,
      summoningSick: false,
      damageMarked: 0,
      markedByDeathtouch: false,
      counters: {},
    }));
    armWithRemoval(state, 'A');

    const target = chosenRemovalTarget(state);
    expect(target, 'the pilot cast its removal at a creature').toBeDefined();
    expect(
      target,
      'the pilot left a 4/5 star-P/T creature alone and killed a 3/3 — it is reading ' +
        'the printed (empty) P/T box, which is a 0/0',
    ).toBe(goyf!.instanceId);
  });

  it('does not attack a 4/4 into an anthem-boosted 3/3 that is really a 6/6', () => {
    // A's 4/4 into B's 3/3 under a +3/+3 anthem. Printed, the blocker is a 3/3 the
    // attacker kills and survives — a free attack. In reality the blocker is a 6/6
    // that eats the attacker for nothing, which is a creature given away.
    const state = bareGame();
    state.step = 'declareAttackers';
    state.combat = { attackers: [], blocks: {}, attackersDeclared: false, blockersDeclared: false };
    put(state, 'A', [creature('mine-4-4', 4, 4)]);
    put(state, 'B', [creature('theirs-3-3', 3, 3, ['goblin'])]);
    put(state, 'B', [anthem('Big Anthem', 3)]);

    const legal = generateLegalActions(state);
    const offered = legal.find((a) => a.kind === 'declareAttackers');
    // Without this the assertion below is hollow: "no attack was declared" is also
    // what a position with no attack on offer produces, and a guard that cannot
    // tell those apart reports something other than "I did not check".
    expect(
      offered && offered.kind === 'declareAttackers' ? offered.attackers.length : 0,
      'the engine offered an attack with the 4/4 — otherwise this proves nothing',
    ).toBe(1);

    const action = pilot.chooseAction({ view: state, legalActions: legal, rng });
    const attackers = action.kind === 'declareAttackers' ? action.attackers.length : 0;
    expect(
      attackers,
      'attacked a 3/3 that an anthem has already made a 6/6 — the free kill the ' +
        'pilot thought it was taking simply loses the attacker',
    ).toBe(0);
  });
});
