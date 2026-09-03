/**
 * The gang-block search must read the same board the engine reads.
 *
 * THE INCIDENT (the §3.108 pilot merged alongside the §3.107 combat family):
 * `addGangBlocks` called the pilot's `canBlockByEvasion` mirror without the
 * battlefield, and the mirror's DEFAULT of "no lands" said an islandwalker was
 * blockable while the engine — reading the live board with an Island on it —
 * refused the whole declaration. The full-pool soak caught it on the first
 * regenerated pool (Cryptic Annelid on Glissa's Courier, seed 2580271023). The
 * fix made the board a REQUIRED argument everywhere in the pilot; this test is
 * the literal case, so the class cannot come back through a new caller that
 * finds another way to omit it.
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
  type InstanceId,
} from '@jonny-boi/core';
import { createHeuristicPilot } from './heuristic.js';
import { creatureDef, landDef, putOnBattlefield } from './test-support.js';

function stubDeck(): DeckList {
  return { cards: Array.from({ length: 30 }, (_, i) => landDef(`L${i}`, 'U')) };
}

function freshGame(seed: number): GameState {
  const { state } = createGame({ seed, decks: { A: stubDeck(), B: stubDeck() } });
  return state;
}

/** Declare-blockers with B defending against A's declared attackers. */
function intoDeclareBlockers(state: GameState, attackers: readonly InstanceId[]): void {
  state.step = 'declareBlockers';
  state.activePlayer = 'A';
  state.priorityPlayer = 'B';
  state.stack = [];
  state.players.A.hand = [];
  state.players.B.hand = [];
  state.combat = {
    attackers: [...attackers],
    blocks: {},
    attackersDeclared: true,
    blockersDeclared: false,
  };
}

/** A real Island: the subtype is what landwalk reads, not the name. */
const ISLAND: CardDefinition = {
  id: 'Island',
  name: 'Island',
  types: ['land'],
  subtypes: ['Island'],
  basic: true,
  produces: ['U'],
};

/** Glissa's Courier's shape — a 3/3 with islandwalk (CR 702.18b). */
const ISLANDWALKER = creatureDef('Islandwalker', 3, 3, {
  keywords: { landwalk: [{ kind: 'subtype', subtype: 'Island' }] },
});

// Gang blocks ON explicitly: the search under test is the one that omitted the board.
const pilot = createHeuristicPilot(undefined, { gangBlock: true });

function choose(state: GameState): GameAction {
  return pilot.chooseAction({ view: state, legalActions: generateLegalActions(state), rng: createRng(7) });
}

describe('the gang-block search reads the defender\'s lands for landwalk', () => {
  it('proposes no block on an islandwalker when the defender controls an Island', () => {
    const state = freshGame(2580271023);
    const [walker] = putOnBattlefield(state, 'A', [ISLANDWALKER]);
    // Two 2/2s that together kill a 3/3 — exactly the pair the gang search wants.
    putOnBattlefield(state, 'B', [creatureDef('Bear One', 2, 2), creatureDef('Bear Two', 2, 2), ISLAND]);
    intoDeclareBlockers(state, [walker!.instanceId]);

    const action = choose(state);
    // Whatever the pilot chooses, the engine must accept it — that is the soak's
    // invariant, and the one the incident broke.
    expect(rejectionOf(applyAction(state, action))).toBeUndefined();
    if (action.kind === 'declareBlockers') expect(action.blocks).toEqual([]);
  });

  it('CONTROL: without the Island the same pair gang-blocks the same attacker', () => {
    const state = freshGame(2580271023);
    const [walker] = putOnBattlefield(state, 'A', [ISLANDWALKER]);
    putOnBattlefield(state, 'B', [creatureDef('Bear One', 2, 2), creatureDef('Bear Two', 2, 2)]);
    intoDeclareBlockers(state, [walker!.instanceId]);

    const action = choose(state);
    expect(action.kind).toBe('declareBlockers');
    if (action.kind === 'declareBlockers') {
      // Two blockers on the one attacker: the gang path ran, so the first test
      // exercised the exact call that used to omit the board.
      expect(action.blocks.map((b) => b.attacker)).toEqual([walker!.instanceId, walker!.instanceId]);
      expect(rejectionOf(applyAction(state, action))).toBeUndefined();
    }
  });
});

/** The engine's refusal, if any: a rejected action leaves exactly one `actionRejected` event. */
function rejectionOf(result: ReturnType<typeof applyAction>): string | undefined {
  for (const event of result.events) {
    if (event.type === 'actionRejected') return event.reason;
  }
  return undefined;
}
