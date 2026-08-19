/**
 * The pilot actually USES the alternative costs — the wiring that keeps them
 * from being inert. A mechanic the engine allows but no pilot ever takes would
 * silently corrupt every A/B verdict that swaps such a card in: the deck would
 * measure as though its cycling lands were plain taplands and its madness
 * creatures were blanks.
 *
 * Three loops are pinned:
 *  1. **Cycling while FLOODED** — the pilot taps for the cycling cost and
 *     cycles a surplus land. Tapping is half the wiring: the engine only OFFERS
 *     `cycleCard` once the pool already covers the cost, so a pilot that did not
 *     plan its mana would never see the action at all.
 *  2. **Not cycling when the land is still wanted** — the same board below the
 *     flood threshold plays the land instead, so the policy is a judgement and
 *     not a reflex.
 *  3. **Madness** — with a window open, the pilot funds and casts the exiled
 *     card rather than passing, which would discard it for good.
 */

import { describe, expect, it } from 'vitest';
import {
  applyAction,
  createGame,
  createRng,
  generateLegalActions,
  type CardDefinition,
  type CardInstance,
  type DeckList,
  type GameAction,
  type GameState,
} from '@jonny-boi/core';
import { createHeuristicPilot } from './heuristic.js';
import { createTestRegistry, giveHand, landDef } from './test-support.js';

/** A Lonely-Sandbar-shaped cycling land: taps for {R}, cycles for {R}. */
const CYCLING_LAND: CardDefinition = {
  id: 'cycling-land',
  name: 'Lonely Sandbar',
  types: ['land'],
  produces: ['R'],
  cycling: [{ cost: { R: 1 }, effects: [{ primitive: 'drawCards', params: { count: 1 } }], label: 'Cycling {R}' }],
};

/** A madness creature: printed {4}{R}, madness {R}. */
const MADNESS_CREATURE: CardDefinition = {
  id: 'madness-creature',
  name: 'Basking Rootwalla',
  types: ['creature'],
  power: 1,
  toughness: 1,
  cost: { generic: 4, R: 1 },
  madness: { R: 1 },
};

function stubDeck(): DeckList {
  return { cards: Array.from({ length: 30 }, (_, i) => landDef(`L${i}`, 'R')) };
}

/** A's precombat main with `landCount` untapped Mountains and an empty hand. */
function boardWith(landCount: number): GameState {
  const { state } = createGame({ seed: 11, decks: { A: stubDeck(), B: stubDeck() } });
  state.step = 'precombatMain';
  state.activePlayer = 'A';
  state.priorityPlayer = 'A';
  state.stack = [];
  state.players.A.hand = [];
  state.players.B.hand = [];
  const mountains = giveHand(state, 'A', Array.from({ length: landCount }, (_, i) => landDef(`M${i}`, 'R')));
  state.players.A.hand = [];
  for (const land of mountains) {
    land.zone = 'battlefield';
    land.summoningSick = false;
    state.battlefield.push(land);
  }
  return state;
}

/** Drive the pilot until it takes an action of `kind`, applying its taps. */
function driveUntil(
  state: GameState,
  kind: GameAction['kind'],
  plies = 12,
): { action: GameAction | undefined; state: GameState } {
  const reg = createTestRegistry();
  const pilot = createHeuristicPilot();
  let current = state;
  for (let ply = 0; ply < plies; ply++) {
    const action = pilot.chooseAction({
      view: current,
      legalActions: generateLegalActions(current),
      rng: createRng(99),
    });
    if (action.kind === kind) return { action, state: current };
    if (action.kind !== 'tapForMana') return { action: undefined, state: current };
    current = applyAction(current, action, undefined, reg).state;
  }
  return { action: undefined, state: current };
}

describe('heuristic pilot vs cycling', () => {
  it('taps for the cycling cost and cycles a surplus land when FLOODED', () => {
    const state = boardWith(6); // at/above the default flooded threshold
    const [sandbar] = giveHand(state, 'A', [CYCLING_LAND]);
    // The land drop is already spent, so cycling is the play rather than a
    // seventh land — and even if it were not, the flooded score is below
    // `playLandScore`, which the next test pins.
    state.players.A.landsPlayedThisTurn = 1;

    const { action } = driveUntil(state, 'cycleCard');
    expect(action, 'the pilot never cycled while flooded').toBeDefined();
    expect((action as Extract<GameAction, { kind: 'cycleCard' }>).instanceId).toBe(sandbar!.instanceId);
  });

  it('the engine accepts the pilot\'s own cycling action end-to-end', () => {
    const state = boardWith(6);
    giveHand(state, 'A', [CYCLING_LAND]);
    state.players.A.landsPlayedThisTurn = 1;
    const { action, state: tapped } = driveUntil(state, 'cycleCard');
    const result = applyAction(tapped, action!, undefined, createTestRegistry());
    expect(result.events.some((e) => e.type === 'actionRejected')).toBe(false);
    expect(result.events.some((e) => e.type === 'cardCycled')).toBe(true);
  });

  it('does NOT cycle a land it still wants — it plays it', () => {
    const state = boardWith(2); // well below the flood threshold
    giveHand(state, 'A', [CYCLING_LAND]);
    state.players.A.landsPlayedThisTurn = 0;
    const pilot = createHeuristicPilot();
    const action = pilot.chooseAction({
      view: state,
      legalActions: generateLegalActions(state),
      rng: createRng(99),
    });
    expect(action.kind).toBe('playLand');
  });
});

describe('heuristic pilot vs madness', () => {
  it('funds and casts the exiled card rather than letting it fall into the graveyard', () => {
    const state = boardWith(3);
    const [rootwalla] = giveHand(state, 'A', [MADNESS_CREATURE]);
    state.players.A.hand = [];
    const card = rootwalla as CardInstance;
    card.zone = 'exile';
    state.players.A.exile.push(card);
    state.madnessWindow = { instanceId: card.instanceId, controller: 'A' };

    const { action, state: tapped } = driveUntil(state, 'castSpell');
    expect(action, 'the pilot declined a madness cast it could pay for').toBeDefined();
    const cast = action as Extract<GameAction, { kind: 'castSpell' }>;
    expect(cast.fromZone).toBe('exile');
    expect(cast.instanceId).toBe(card.instanceId);

    const result = applyAction(tapped, cast, undefined, createTestRegistry());
    expect(result.events.some((e) => e.type === 'actionRejected')).toBe(false);
    expect(result.state.madnessWindow ?? null).toBeNull();
  });

  it('declines (and unblocks the game) when the madness cost cannot be paid', () => {
    const state = boardWith(0); // no mana sources at all
    const [rootwalla] = giveHand(state, 'A', [MADNESS_CREATURE]);
    state.players.A.hand = [];
    const card = rootwalla as CardInstance;
    card.zone = 'exile';
    state.players.A.exile.push(card);
    state.madnessWindow = { instanceId: card.instanceId, controller: 'A' };

    const pilot = createHeuristicPilot();
    const action = pilot.chooseAction({
      view: state,
      legalActions: generateLegalActions(state),
      rng: createRng(99),
    });
    expect(action.kind).toBe('passPriority');
    const result = applyAction(state, action, undefined, createTestRegistry());
    expect(result.state.madnessWindow ?? null).toBeNull();
    expect(result.state.players.A.graveyard.some((c) => c.instanceId === card.instanceId)).toBe(true);
  });
});
