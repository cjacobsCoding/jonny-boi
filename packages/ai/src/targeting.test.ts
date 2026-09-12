/**
 * The pilots must RESPECT a spell's printed target restriction (core's
 * `targetRestrictionOf` / `isLegalTarget`).
 *
 * Two separate failures are being prevented here, and they matter for different
 * reasons:
 *
 *  - **Play quality.** A player-only burn spell is not removal, and a
 *    creature-only burn spell is not reach. A pilot that plans a creature kill
 *    with Lava Spike, or a lethal face burn with Flame Slash, is mis-valuing the
 *    card — and the whole point of this project is that the sim's verdicts are
 *    trustworthy.
 *  - **Liveness.** The heuristic BUILDS its cast action rather than picking one
 *    the engine offered, so an illegal target is not merely a bad play: the engine
 *    rejects it, the position is unchanged, the pilot re-chooses the same action,
 *    and the match loop spins. Any restricted spell the pilot doesn't understand
 *    (it classifies most cards as "generic") would have hit this.
 */

import { describe, expect, it } from 'vitest';
import {
  applyAction,
  createGame,
  createRng,
  generateLegalActions,
  isLegalTarget,
  targetRestrictionOf,
  type CardDefinition,
  type DeckList,
  type GameState,
  type ManaCost,
} from '@jonny-boi/core';
import { createHeuristicPilot } from './heuristic.js';
import { createMctsPilot } from './mcts.js';
import { FAST_MCTS_CONFIG } from './mcts-config.js';
import { createHybridPilot } from './hybrid.js';
import { FAST_HYBRID_CONFIG } from './hybrid-config.js';
import { buildRegistry } from '@jonny-boi/cards';
import { addPool, createTestRegistry, creatureDef, giveHand, landDef, putOnBattlefield } from './test-support.js';

/** Burn that may only hit a player — Lava Spike. */
function playerOnlyBurnDef(id: string, amount: number, cost: ManaCost = { R: 1 }): CardDefinition {
  return {
    id,
    name: id,
    types: ['sorcery'],
    timing: 'sorcery',
    cost,
    effects: [{ primitive: 'dealDamage', params: { amount, targets: 'player' } }],
  };
}

/** Burn that may only hit a creature — Flame Slash. */
function creatureOnlyBurnDef(id: string, amount: number, cost: ManaCost = { R: 1 }): CardDefinition {
  return {
    id,
    name: id,
    types: ['sorcery'],
    timing: 'sorcery',
    cost,
    effects: [{ primitive: 'dealDamage', params: { amount, targets: 'creature' } }],
  };
}

/**
 * A restricted spell the pilots have NO intent vocabulary for — it is classified
 * as a generic "cast it" spell. This is the liveness case: the pilot has no reason
 * of its own to pick a target, so only the restriction can supply one.
 */
function restrictedGenericDef(id: string): CardDefinition {
  return {
    id,
    name: id,
    types: ['sorcery'],
    timing: 'sorcery',
    cost: { B: 1 },
    effects: [{ primitive: 'loseLife', params: { amount: 2, targetPlayer: true, targets: 'player' } }],
  };
}

function stubDeck(): DeckList {
  return { cards: Array.from({ length: 30 }, (_, i) => landDef(`L${i}`, 'R')) };
}

function mainPhase(seed = 5): GameState {
  const { state } = createGame({ seed, decks: { A: stubDeck(), B: stubDeck() } });
  state.step = 'precombatMain';
  state.activePlayer = 'A';
  state.priorityPlayer = 'A';
  state.stack = [];
  state.players.A.hand = [];
  state.players.B.hand = [];
  state.players.A.landsPlayedThisTurn = 0;
  return state;
}

/**
 * THE REAL BODIES, because `restrictedGenericDef` mints `loseLife` and the fixture
 * registry only ever owned `dealDamage`. The drain resolved 260 times across the
 * liveness loop below and did nothing every time — so the "many real positions" the
 * pilots were driven through were positions where life totals never moved (DESIGN
 * §3.143). The target-legality assertions were still real (a rejection is decided at
 * cast time, before resolution), but the positions they were checked over were not.
 */
const REGISTRY = createTestRegistry(buildRegistry());

/** Ask the heuristic for a decision in this position. */
function heuristicChoice(state: GameState): ReturnType<ReturnType<typeof createHeuristicPilot>['chooseAction']> {
  return createHeuristicPilot().chooseAction({
    view: state,
    legalActions: generateLegalActions(state),
    rng: createRng(1),
    registry: REGISTRY,
  });
}

describe('the heuristic pilot never aims a restricted spell illegally', () => {
  it('does not plan a creature kill with a player-only burn spell', () => {
    const state = mainPhase();
    // A creature the burn would comfortably kill — the exact trap: the pilot's
    // removal scoring loves this target, and the printed card cannot hit it.
    const [victim] = putOnBattlefield(state, 'B', [creatureDef('Bear', 2, 2)]);
    giveHand(state, 'A', [playerOnlyBurnDef('Spike', 3)]);
    addPool(state, 'A', 'R', 1);

    const action = heuristicChoice(state);
    expect(action.kind).toBe('castSpell');
    if (action.kind === 'castSpell') {
      expect(action.targets).toEqual(['B']); // the face, not the bear
      expect(action.targets).not.toContain(victim!.instanceId);
    }
  });

  it('does not aim a creature-only burn spell at a face, even at lethal life', () => {
    const state = mainPhase();
    state.players.B.life = 2; // lethal for a 4-damage spell, if it could hit faces
    const [victim] = putOnBattlefield(state, 'B', [creatureDef('Bear', 2, 2)]);
    giveHand(state, 'A', [creatureOnlyBurnDef('Slash', 4)]);
    addPool(state, 'A', 'R', 1);

    const action = heuristicChoice(state);
    if (action.kind === 'castSpell') {
      expect(action.targets).toEqual([victim!.instanceId]);
      expect(action.targets).not.toContain('B');
    }
  });

  it('holds a creature-only spell entirely when there is no creature to hit', () => {
    const state = mainPhase();
    state.players.B.life = 2;
    giveHand(state, 'A', [creatureOnlyBurnDef('Slash', 4)]);
    addPool(state, 'A', 'R', 1);

    // No creature anywhere: the spell has no legal target, so it must not be cast.
    const action = heuristicChoice(state);
    expect(action.kind).not.toBe('castSpell');
  });

  it('supplies a legal target for a restricted spell it has no intent for', () => {
    const state = mainPhase();
    giveHand(state, 'A', [restrictedGenericDef('Drain')]);
    addPool(state, 'A', 'B', 1);

    const action = heuristicChoice(state);
    expect(action.kind).toBe('castSpell');
    if (action.kind === 'castSpell') expect(action.targets).toEqual(['B']);
  });
});

describe('every action a pilot returns is a target the engine accepts', () => {
  const RESTRICTED_HAND: readonly CardDefinition[] = [
    playerOnlyBurnDef('Spike', 3),
    creatureOnlyBurnDef('Slash', 4),
    restrictedGenericDef('Drain'),
  ];

  it.each([
    ['heuristic', () => createHeuristicPilot()],
    ['mcts', () => createMctsPilot(FAST_MCTS_CONFIG)],
    // The hybrid is the sharpest case for this guard. It returns the FIRST ply of
    // a multi-action macro and then carries the rest out from memory, so a plan
    // that went stale would show up here as a rejected action — and a rejected
    // action leaves the position unchanged, which is how a match loop spins.
    ['hybrid', () => createHybridPilot(FAST_HYBRID_CONFIG)],
  ])('%s: never has a cast rejected over many real positions', (_name, makePilot) => {
    const pilot = makePilot();
    const rng = createRng(909);
    let state = mainPhase(31);
    putOnBattlefield(state, 'A', [creatureDef('MyBear', 2, 2)]);
    putOnBattlefield(state, 'B', [creatureDef('TheirBear', 3, 3)]);

    for (let i = 0; i < 120 && !state.gameOver; i++) {
      // Keep restricted spells and mana in hand throughout, so the pilots keep
      // being tempted by them rather than running out after one turn.
      if (state.players[state.priorityPlayer].hand.length === 0) {
        giveHand(state, state.priorityPlayer, RESTRICTED_HAND);
        addPool(state, state.priorityPlayer, 'R', 3);
        addPool(state, state.priorityPlayer, 'B', 3);
      }
      const action = pilot.chooseAction({
        view: state,
        legalActions: generateLegalActions(state),
        rng,
        registry: REGISTRY,
      });
      const result = applyAction(state, action, undefined, REGISTRY);
      const rejected = result.events.find((e) => e.type === 'actionRejected');
      expect(rejected, `rejected: ${JSON.stringify(action)} — ${JSON.stringify(rejected)}`).toBeUndefined();

      // And whenever it did cast something restricted, the target was legal.
      if (action.kind === 'castSpell') {
        const card = state.players[action.player].hand.find((c) => c.instanceId === action.instanceId);
        const restriction = card ? targetRestrictionOf(card.def) : undefined;
        if (restriction) {
          expect(action.targets).toHaveLength(1);
          expect(isLegalTarget(state, restriction, action.targets![0]!)).toBe(true);
        }
      }
      state = result.state;
    }
  });
});
