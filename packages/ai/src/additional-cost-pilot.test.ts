/**
 * The pilot does not propose a spell whose MANDATORY additional cost this board
 * cannot pay (CR 601.2h).
 *
 * WHY THIS FILE EXISTS. The heuristic builds its cast actions itself rather than
 * picking one off `generateLegalActions` — it has to, because it taps for mana
 * first and the cast is not on the menu until the mana is floating. That makes
 * every legality gate core applies at the OFFER a gate the pilot has to apply
 * too, and this one was missing: with Altar's Reap in hand and no creature, the
 * pilot built the cast, the engine rejected it, nothing about the board changed,
 * and it built the same cast on the next priority — forever. The full-pool soak
 * caught it the moment the shipped pool gained a card with such a cost: games
 * that burned the 6000-action cap without ending, plus "the engine rejected an
 * action it offered" on every one of them.
 *
 * The fix reads core's own `unpayableAdditionalCostReason`, not a second copy of
 * the rule, because three opinions about "can this be paid" is exactly how a
 * spell becomes offerable and un-castable.
 */

import { describe, expect, it } from 'vitest';
import {
  applyAction,
  createGame,
  createRng,
  generateLegalActions,
  type CardDefinition,
  type DeckList,
  type GameAction,
  type GameState,
} from '@jonny-boi/core';
import { createHeuristicPilot } from './heuristic.js';
import { createTestRegistry, creatureDef, giveHand, landDef, putOnBattlefield } from './test-support.js';

/** Altar's Reap: "As an additional cost, sacrifice a creature. Draw two cards." */
const ALTARS_REAP: CardDefinition = {
  id: 'altars-reap',
  name: "Altar's Reap",
  types: ['instant'],
  timing: 'instant',
  cost: { B: 1, generic: 1 },
  additionalCost: {
    kind: 'sacrifice',
    filter: { anyOfTypes: ['creature'] },
    label: 'Sacrifice a creature',
  },
  effects: [{ primitive: 'drawCards', params: { count: 2 } }],
};

function stubDeck(): DeckList {
  return { cards: Array.from({ length: 30 }, (_, i) => landDef(`L${i}`, 'B')) };
}

/** A's precombat main with three untapped Swamps, Altar's Reap in hand. */
function boardWith(creatures: readonly CardDefinition[]): GameState {
  const { state } = createGame({ seed: 7, decks: { A: stubDeck(), B: stubDeck() } });
  state.step = 'precombatMain';
  state.activePlayer = 'A';
  state.priorityPlayer = 'A';
  state.stack = [];
  state.players.A.hand = [];
  state.players.B.hand = [];
  state.players.A.landsPlayedThisTurn = 1;
  putOnBattlefield(
    state,
    'A',
    Array.from({ length: 3 }, (_, i) => landDef(`S${i}`, 'B')),
  );
  putOnBattlefield(state, 'A', creatures);
  giveHand(state, 'A', [ALTARS_REAP]);
  return state;
}

/**
 * Drive the pilot for a few plies, applying only its mana taps, and report the
 * cast it eventually proposes (if any). A pilot that proposes an illegal cast
 * shows up here as a `castSpell` the engine would refuse.
 */
function pilotCast(state: GameState): Extract<GameAction, { kind: 'castSpell' }> | undefined {
  const pilot = createHeuristicPilot();
  const registry = createTestRegistry();
  let current = state;
  for (let ply = 0; ply < 12; ply++) {
    const action = pilot.chooseAction({
      view: current,
      legalActions: generateLegalActions(current),
      rng: createRng(5),
    });
    if (action.kind === 'castSpell') return action;
    if (action.kind !== 'tapForMana') return undefined;
    current = applyAction(current, action, undefined, registry).state;
  }
  return undefined;
}

describe("a mandatory additional cost the board cannot pay is not a goal", () => {
  it('the pilot never proposes Altar\'s Reap with no creature to sacrifice', () => {
    const state = boardWith([]);
    // The engine agrees, and that agreement is the point — the two used to differ.
    expect(
      generateLegalActions(state).some((a) => a.kind === 'castSpell'),
      'the engine offered a cast it would reject',
    ).toBe(false);
    expect(pilotCast(state), 'the pilot built a cast the engine refuses').toBeUndefined();
  });

  it('and does cast it the moment there is one — the gate is the COST, not the card', () => {
    const state = boardWith([creatureDef('Chump', 1, 1)]);
    const reap = state.players.A.hand[0]!;
    expect(pilotCast(state)?.instanceId).toBe(reap.instanceId);
  });
});
