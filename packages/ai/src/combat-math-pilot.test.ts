/**
 * THE PILOT'S BLOCKS, with the fight maths wired in (DESIGN §3.43).
 *
 * `combat-math.test.ts` pins the arithmetic; this pins that `pickBlocker`
 * actually ASKS it. The two are separate files on purpose — the bug this work
 * started from was not a wrong formula, it was a decision that never consulted
 * one, and a maths-only suite goes green either way.
 */

import { describe, expect, it } from 'vitest';
import {
  createGame,
  createRng,
  generateLegalActions,
  type DeckList,
  type GameAction,
  type GameState,
} from '@jonny-boi/core';
import { createHeuristicPilot } from './heuristic.js';
import { creatureDef, landDef, putOnBattlefield } from './test-support.js';

function stubDeck(): DeckList {
  return { cards: Array.from({ length: 30 }, (_, i) => landDef(`L${i}`, 'G')) };
}

function freshGame(seed = 1): GameState {
  const { state } = createGame({ seed, decks: { A: stubDeck(), B: stubDeck() } });
  return state;
}

/** A is the attacker; B is the seat we are testing, and it holds priority. */
function intoDeclareBlockers(state: GameState, attackers: readonly number[]): void {
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

const pilot = createHeuristicPilot();

function choose(state: GameState): GameAction {
  return pilot.chooseAction({
    view: state,
    legalActions: generateLegalActions(state),
    rng: createRng(7),
  });
}

function blocksOf(action: GameAction): ReadonlyArray<{ blocker: number; attacker: number }> {
  return action.kind === 'declareBlockers' ? action.blocks : [];
}

describe('the pilot blocks with a deathtoucher it used to think was outclassed', () => {
  it('a 1/2 deathtouch eats a 5/3 — the block the printed boxes called a giveaway', () => {
    const state = freshGame(11);
    const [thragtusk] = putOnBattlefield(state, 'A', [creatureDef('Big Beast', 5, 3)]);
    const [recluse] = putOnBattlefield(state, 'B', [
      creatureDef('Deadly Spider', 1, 2, { keywords: { deathtouch: true } }),
    ]);
    intoDeclareBlockers(state, [thragtusk!.instanceId]);

    const blocks = blocksOf(choose(state));
    expect(blocks).toEqual([{ blocker: recluse!.instanceId, attacker: thragtusk!.instanceId }]);
  });

  it('and it still declines a block that is pure loss — this is not "block everything"', () => {
    // A 2/2 with no deathtouch in front of a 6/4: the blocker dies, the attacker
    // lives. Nothing about the fight maths changes that answer.
    const state = freshGame(12);
    const [wurm] = putOnBattlefield(state, 'A', [creatureDef('Craw Wurm', 6, 4)]);
    putOnBattlefield(state, 'B', [creatureDef('Bears', 2, 2)]);
    intoDeclareBlockers(state, [wurm!.instanceId]);

    expect(blocksOf(choose(state))).toEqual([]);
  });
});

describe('the pilot values its own first strike', () => {
  it('blocks a 2/2 with a 2/2 FIRST STRIKER — a kill, not a trade', () => {
    const state = freshGame(13);
    const [bears] = putOnBattlefield(state, 'A', [creatureDef('Bears', 2, 2)]);
    // The plain body is FIRST on the battlefield deliberately: the printed-box
    // maths scores the two identically and falls through to whichever it meets
    // first, so a test that lists the first-striker first passes either way.
    const [plain, knight] = putOnBattlefield(state, 'B', [
      creatureDef('Plain Bears', 2, 2),
      creatureDef('Youthful Knight', 2, 2, { keywords: { firstStrike: true } }),
    ]);
    intoDeclareBlockers(state, [bears!.instanceId]);

    const blocks = blocksOf(choose(state));
    expect(blocks).toHaveLength(1);
    // Both bodies "trade" on the printed boxes, so the old maths scored them
    // identically and took whichever came first; only one of them lives.
    expect(blocks[0]!.blocker).toBe(knight!.instanceId);
    expect(blocks[0]!.blocker).not.toBe(plain!.instanceId);
  });
});

describe('the pilot puts the right body in front of a TRAMPLER', () => {
  it('an 0/4 wall soaks four where a 1/1 soaks one', () => {
    const state = freshGame(14);
    const [wurm] = putOnBattlefield(state, 'A', [
      creatureDef('Pelakka Wurm', 7, 7, { keywords: { trample: true } }),
    ]);
    const [token, wall] = putOnBattlefield(state, 'B', [
      creatureDef('Soldier token', 1, 1),
      creatureDef('Wall', 0, 4, { keywords: { defender: true } }),
    ]);
    // Low enough that the pilot is chump-blocking to survive either way: the
    // question under test is WHICH body, not whether.
    state.players.B.life = 8;
    intoDeclareBlockers(state, [wurm!.instanceId]);

    const blocks = blocksOf(choose(state));
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.blocker).toBe(wall!.instanceId);
    expect(blocks[0]!.blocker).not.toBe(token!.instanceId);
  });

  it('against a NON-trampler the cheapest chump is still the right one', () => {
    // The guard on the term above: it must not turn every chump block into
    // "spend the biggest body". Same board, no trample.
    const state = freshGame(15);
    const [wurm] = putOnBattlefield(state, 'A', [creatureDef('Craw Wurm', 7, 7)]);
    const [token, wall] = putOnBattlefield(state, 'B', [
      creatureDef('Soldier token', 1, 1),
      creatureDef('Wall', 0, 4, { keywords: { defender: true } }),
    ]);
    state.players.B.life = 8;
    intoDeclareBlockers(state, [wurm!.instanceId]);

    const blocks = blocksOf(choose(state));
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.blocker).toBe(token!.instanceId);
    expect(blocks[0]!.blocker).not.toBe(wall!.instanceId);
  });
});
