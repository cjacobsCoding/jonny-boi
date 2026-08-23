/**
 * CAST-COST REDUCTIONS — "instant and sorcery spells you cast cost {1} less to
 * cast" (Goblin Electromancer, the Medallion cycle), CR 601.2f.
 *
 * The two properties that would break silently, pinned:
 *  1. **Offer and pay agree.** The reduction is applied by ONE helper at both
 *     sites, so a spell a Medallion makes affordable is offered AND accepted —
 *     and a spell it does not touch is neither.
 *  2. **A reduction never touches a coloured pip.** "{1} less" against `{U}{U}`
 *     changes nothing; against `{1}{U}` it leaves `{U}`. Reducing a pip would
 *     make every mono-colour deck's curve quietly wrong.
 */

import { describe, expect, it } from 'vitest';
import {
  applyAction,
  castManaCostFor,
  createGame,
  DEFAULT_RULES,
  dumpState,
  generateLegalActions,
  type CardDefinition,
  type CardInstance,
  type GameAction,
  type GameState,
  type PlayerId,
} from './index.js';
import { createEffectRegistry, type EffectRegistry } from './effects.js';
import { deckOf, landDef } from './test-fixtures.js';

const ISLAND = landDef('Island', 'U');

/** An Electromancer-shaped reducer: instants and sorceries cost {1} less. */
const REDUCER: CardDefinition = {
  id: 'Reducer',
  name: 'Reducer',
  types: ['creature'],
  power: 2,
  toughness: 2,
  castCostReduction: { amount: 1, filter: { anyOfTypes: ['instant', 'sorcery'] } },
};

/** {1}{U} instant — the reduction's beneficiary. */
const SPELL: CardDefinition = {
  id: 'Probe Bolt',
  name: 'Probe Bolt',
  types: ['instant'],
  timing: 'instant',
  cost: { generic: 1, U: 1 },
};

/** {U}{U} instant — nothing generic for the reduction to touch. */
const PIPS: CardDefinition = {
  id: 'Double Pips',
  name: 'Double Pips',
  types: ['instant'],
  timing: 'instant',
  cost: { U: 2 },
};

/** A creature spell — outside the reducer's printed scope. */
const BEAR_SPELL: CardDefinition = {
  id: 'Bear',
  name: 'Bear',
  types: ['creature'],
  power: 2,
  toughness: 2,
  cost: { generic: 1, U: 1 },
};

const SEED = 0xc057;

function act(state: GameState, action: GameAction, reg: EffectRegistry): GameState {
  const result = applyAction(state, action, DEFAULT_RULES, reg);
  const rejected = result.events.find((e) => e.type === 'actionRejected');
  if (rejected) throw new Error(`unexpected rejection: ${(rejected as { reason: string }).reason}\n${dumpState(state)}`);
  return result.state;
}

function pass(state: GameState, reg: EffectRegistry): GameState {
  return act(state, { kind: 'passPriority', player: state.priorityPlayer }, reg);
}

let syntheticId = 97_000;

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

/** A's main phase, with `reducerFor` (if named) on the battlefield and `hand` in hand. */
function gameWith(reducerFor: PlayerId | null, hand: readonly CardDefinition[], reg: EffectRegistry): {
  state: GameState;
  cards: CardInstance[];
} {
  const created = createGame({
    seed: SEED,
    startingPlayer: 'A',
    registry: reg,
    decks: { A: deckOf(ISLAND, 40), B: deckOf(ISLAND, 40) },
  });
  let state = created.state;
  let guard = 0;
  while (state.step !== 'precombatMain' && !state.gameOver && guard++ < 50) state = pass(state, reg);
  state.players.A.hand = [];
  state.players.B.hand = [];
  if (reducerFor) state.battlefield.push({ ...instance(REDUCER, reducerFor, 'battlefield') });
  const cards = hand.map((def) => instance(def, 'A', 'hand'));
  state.players.A.hand = cards;
  // One floating {U}: exactly enough for the REDUCED {1}{U}, one short of full.
  state.players.A.manaPool = { W: 0, U: 1, B: 0, R: 0, G: 0, C: 0 };
  return { state, cards };
}

describe('castManaCostFor (the one helper both sites read)', () => {
  it('reduces the generic portion, and only for spells the filter matches', () => {
    const reg = createEffectRegistry();
    const { state } = gameWith('A', [], reg);
    expect(castManaCostFor(state, 'A', SPELL, SPELL.cost)).toEqual({ U: 1 });
    expect(castManaCostFor(state, 'A', BEAR_SPELL, BEAR_SPELL.cost)).toEqual({ generic: 1, U: 1 });
  });

  it('never touches a coloured pip', () => {
    const reg = createEffectRegistry();
    const { state } = gameWith('A', [], reg);
    expect(castManaCostFor(state, 'A', PIPS, PIPS.cost)).toEqual({ U: 2 });
  });

  it('grants nothing across the table — the printed line says "you cast"', () => {
    const reg = createEffectRegistry();
    const { state } = gameWith('B', [], reg);
    expect(castManaCostFor(state, 'A', SPELL, SPELL.cost)).toEqual({ generic: 1, U: 1 });
  });

  it('stacks copies', () => {
    const reg = createEffectRegistry();
    const { state } = gameWith('A', [], reg);
    state.battlefield.push(instance(REDUCER, 'A', 'battlefield'));
    const two: CardDefinition = { ...SPELL, cost: { generic: 2, U: 1 } };
    expect(castManaCostFor(state, 'A', two, two.cost)).toEqual({ U: 1 });
  });
});

describe('the reduction at the table', () => {
  it('a spell the reduction makes affordable is OFFERED and ACCEPTED', () => {
    const reg = createEffectRegistry();
    const { state, cards } = gameWith('A', [SPELL], reg);

    // One floating {U} cannot pay the printed {1}{U}; the reducer makes it {U}.
    expect(generateLegalActions(state).some((a) => a.kind === 'castSpell')).toBe(true);
    const cast = act(state, { kind: 'castSpell', player: 'A', instanceId: cards[0]!.instanceId }, reg);
    expect(cast.stack).toHaveLength(1);
    // The pool paid exactly the reduced cost — nothing left, nothing owed.
    expect(cast.players.A.manaPool).toEqual({ W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 });
  });

  it('a spell OUTSIDE the scope is neither offered nor accepted', () => {
    const reg = createEffectRegistry();
    const { state } = gameWith('A', [BEAR_SPELL], reg);
    expect(generateLegalActions(state).some((a) => a.kind === 'castSpell')).toBe(false);
  });

  it('without the reducer the same board cannot cast — the baseline this rests on', () => {
    const reg = createEffectRegistry();
    const { state } = gameWith(null, [SPELL], reg);
    expect(generateLegalActions(state).some((a) => a.kind === 'castSpell')).toBe(false);
  });
});
