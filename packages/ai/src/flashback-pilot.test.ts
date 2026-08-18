/**
 * The pilot actually CONSIDERS flashback casts — the wiring that keeps the
 * mechanic from being inert. A mechanic the engine allows but no pilot ever
 * uses would silently corrupt every A/B verdict that swaps a flashback card in
 * (the deck would measure as if the card's second cast did not exist), so this
 * pins the whole loop: the heuristic sees a castable card in the GRAVEYARD,
 * funds its FLASHBACK cost by tapping, and submits the cast with its explicit
 * source zone — through the same `scoredSpellGoals` seam the hybrid search's
 * policy candidates read, so both pilots inherit the consideration.
 */

import { describe, expect, it } from 'vitest';
import {
  applyAction,
  createRng,
  createGame,
  generateLegalActions,
  type CardDefinition,
  type CardInstance,
  type DeckList,
  type GameAction,
  type GameState,
} from '@jonny-boi/core';
import { createHeuristicPilot } from './heuristic.js';
import { createTestRegistry, giveHand, landDef } from './test-support.js';

/** Firebolt-shaped: printed {R}, flashback {4}{R}, 2 damage anywhere. */
const FLASHBACK_BOLT: CardDefinition = {
  id: 'fb-bolt',
  name: 'Flash Bolt',
  types: ['sorcery'],
  cost: { R: 1 },
  flashback: { generic: 4, R: 1 },
  effects: [{ primitive: 'dealDamage', params: { amount: 2, targets: 'any' } }],
};

function stubDeck(): DeckList {
  return { cards: Array.from({ length: 30 }, (_, i) => landDef(`L${i}`, 'R')) };
}

/** A's precombat main, empty hands, a flashback bolt in A's graveyard, and
 * five untapped Mountains to fund it. */
function flashbackPosition(): GameState {
  const { state } = createGame({ seed: 7, decks: { A: stubDeck(), B: stubDeck() } });
  state.step = 'precombatMain';
  state.activePlayer = 'A';
  state.priorityPlayer = 'A';
  state.stack = [];
  state.players.A.hand = [];
  state.players.B.hand = [];
  // No land drop left, so the pilot's only line is the flashback cast — and the
  // cast is LETHAL, so no scoring threshold can talk the pilot out of it.
  state.players.A.landsPlayedThisTurn = 1;
  state.players.B.life = 2;
  // Five untapped Mountains (created in hand, moved to the battlefield settled).
  const mountains = giveHand(state, 'A', Array.from({ length: 5 }, (_, i) => landDef(`M${i}`, 'R')));
  state.players.A.hand = [];
  for (const land of mountains) {
    land.zone = 'battlefield';
    land.summoningSick = false;
    state.battlefield.push(land);
  }
  // The flashback card, in the graveyard.
  const [bolt] = giveHand(state, 'A', [FLASHBACK_BOLT]);
  state.players.A.hand = [];
  bolt!.zone = 'graveyard';
  state.players.A.graveyard.push(bolt as CardInstance);
  return state;
}

describe('heuristic pilot vs flashback', () => {
  it('funds and casts a flashback spell out of its own graveyard', () => {
    const reg = createTestRegistry();
    const pilot = createHeuristicPilot();
    let state = flashbackPosition();
    const boltId = state.players.A.graveyard[0]!.instanceId;

    // Drive the pilot's own choices until it commits the cast (taps first).
    let cast: Extract<GameAction, { kind: 'castSpell' }> | undefined;
    for (let ply = 0; ply < 12 && !cast; ply++) {
      const legal = generateLegalActions(state);
      const action = pilot.chooseAction({ view: state, legalActions: legal, rng: createRng(99) });
      if (action.kind === 'castSpell') {
        cast = action;
        break;
      }
      // Anything but tapping toward the cast means the pilot is NOT pursuing it.
      expect(action.kind, 'the pilot should tap toward the flashback cast').toBe('tapForMana');
      state = applyAction(state, action, undefined, reg).state;
    }

    expect(cast, 'the pilot never attempted the flashback cast').toBeDefined();
    expect(cast!.fromZone).toBe('graveyard');
    expect(cast!.instanceId).toBe(boltId);
    // And the engine accepts the pilot's own action end-to-end.
    const result = applyAction(state, cast!, undefined, reg);
    expect(result.events.some((e) => e.type === 'actionRejected')).toBe(false);
    expect(result.events.some((e) => e.type === 'spellCast' && e.fromZone === 'graveyard')).toBe(true);
  });
});
