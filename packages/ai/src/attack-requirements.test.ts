/**
 * THE PILOT PLAYS THE COMBAT KEYWORD FAMILY (DESIGN §3.107).
 *
 * Two mirrors, each pinned because the failure it prevents is wholesale:
 *   - ATTACK REQUIREMENTS: a roster that leaves a "attacks each combat if able"
 *     creature home is rejected outright, so the heuristic pilot must include
 *     it even when its own profit judgement says stay home.
 *   - BLOCK LEGALITY: `canBlockByEvasion` must agree with core's `canBlock` on
 *     shadow, landwalk and "can block only", or one illegal pair loses the
 *     defender every other block in the declaration (§3.102's Black Knight).
 */

import { describe, expect, it } from 'vitest';
import type { CardDefinition, GameAction, GameState } from '@jonny-boi/core';
import { createGame, DEFAULT_RULES, generateLegalActions, indexContinuous } from '@jonny-boi/core';
import { canBlockByEvasion, createHeuristicPilot } from './heuristic.js';
import { withRequiredAttackers } from './attack-requirements.js';
import { creatureDef, landDef } from './test-support.js';

const BEAR = creatureDef('bear', 2, 2);
const WALL = creatureDef('wall', 4, 4);
const FOREST = landDef('forest', 'G');
const ISLAND: CardDefinition = { ...landDef('island', 'U'), subtypes: ['Island'] };
const GOBLIN_BRIGAND = creatureDef('Goblin Brigand', 2, 2, { keywords: { mustAttack: true } });

function boardAtCombat(mine: readonly CardDefinition[], theirs: readonly CardDefinition[]): GameState {
  const { state } = createGame({
    seed: 3107,
    startingPlayer: 'A',
    decks: {
      A: { cards: Array.from({ length: 20 }, () => FOREST) },
      B: { cards: Array.from({ length: 20 }, () => FOREST) },
    },
  });
  const place = (def: CardDefinition, controller: 'A' | 'B') => {
    state.battlefield.push({
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
    } as never);
  };
  for (const def of mine) place(def, 'A');
  for (const def of theirs) place(def, 'B');
  state.step = 'declareAttackers';
  state.activePlayer = 'A';
  state.priorityPlayer = 'A';
  state.combat = { attackers: [], blocks: {}, attackersDeclared: false, blockersDeclared: false };
  return state;
}

function chosenBy(state: GameState): GameAction {
  const pilot = createHeuristicPilot(undefined, { alphaStrike: false });
  const legalActions = generateLegalActions(state, DEFAULT_RULES);
  expect(legalActions.some((a) => a.kind === 'declareAttackers')).toBe(true);
  return pilot.chooseAction({
    view: state,
    legalActions,
    rng: { next: () => 0.5 } as never,
    registry: undefined as never,
    rulesConfig: DEFAULT_RULES,
    observer: undefined,
  });
}

describe('attack requirements — the pilot sends what must go', () => {
  it('a Goblin Brigand into a 4/4 wall is a losing attack the pilot would decline — and declares anyway', () => {
    // The control: a plain Bear into the wall is held back.
    expect(chosenBy(boardAtCombat([BEAR], [WALL])).kind).toBe('passPriority');
    // The Brigand must attack, so the same judgement produces a declaration.
    const action = chosenBy(boardAtCombat([GOBLIN_BRIGAND], [WALL]));
    expect(action.kind).toBe('declareAttackers');
    const attackers = (action as Extract<GameAction, { kind: 'declareAttackers' }>).attackers;
    expect(attackers).toHaveLength(1);
  });

  it('the required creature is ADDED to a profitable roster, never substituted for it', () => {
    // No blockers: the Bear's attack is free profit and stays; the Brigand joins.
    const state = boardAtCombat([BEAR, GOBLIN_BRIGAND], []);
    const action = chosenBy(state) as Extract<GameAction, { kind: 'declareAttackers' }>;
    expect(action.kind).toBe('declareAttackers');
    expect(action.attackers).toHaveLength(2);
  });

  it('withRequiredAttackers returns the SAME roster when nothing is required', () => {
    const state = boardAtCombat([BEAR], [WALL]);
    const index = indexContinuous(state);
    const bear = state.battlefield[0]!.instanceId;
    const chosen = [bear];
    expect(withRequiredAttackers(state, index, chosen, [bear])).toBe(chosen);
  });

  it('withRequiredAttackers never adds a creature the engine did not offer', () => {
    // "If able" belongs to the engine; the pilot only ever narrows the offer.
    const state = boardAtCombat([GOBLIN_BRIGAND], []);
    const index = indexContinuous(state);
    expect(withRequiredAttackers(state, index, [], [])).toEqual([]);
  });
});

describe('block legality mirror — the pilot never proposes a pair core refuses', () => {
  function pair(attackerDef: CardDefinition, blockerDef: CardDefinition, lands: readonly CardDefinition[] = []): boolean {
    const state = boardAtCombat([attackerDef], [blockerDef, ...lands]);
    const attacker = state.battlefield[0]!;
    const blocker = state.battlefield[1]!;
    return canBlockByEvasion(attacker, blocker, indexContinuous(state), state.battlefield);
  }
  const SHADOW = creatureDef('Dauthi Mercenary', 2, 1, { keywords: { shadow: true } });
  const PALE_BEARS = creatureDef('Pale Bears', 2, 2, { keywords: { landwalk: [{ kind: 'subtype', subtype: 'island' }] } });
  const WELKIN_TERN = creatureDef('Welkin Tern', 2, 1, { keywords: { flying: true, blockOnly: { attackerMustHaveAnyOf: ['flying'] } } });
  const FLIER = creatureDef('flier', 2, 2, { keywords: { flying: true } });

  it('shadow is symmetric', () => {
    expect(pair(SHADOW, BEAR)).toBe(false);
    expect(pair(BEAR, SHADOW)).toBe(false);
    expect(pair(SHADOW, SHADOW)).toBe(true);
  });

  it('landwalk reads the defender\'s lands off the board it is handed', () => {
    expect(pair(PALE_BEARS, BEAR, [ISLAND])).toBe(false);
    expect(pair(PALE_BEARS, BEAR, [])).toBe(true);
  });

  it('"can block only creatures with flying" is the blocker\'s restriction', () => {
    expect(pair(BEAR, WELKIN_TERN)).toBe(false);
    expect(pair(FLIER, WELKIN_TERN)).toBe(true);
  });
});
