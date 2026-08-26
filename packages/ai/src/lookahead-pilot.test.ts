/**
 * THE LOOKAHEAD PILOT (DESIGN §3.47) — that it intercepts exactly one decision,
 * asks the forecast, and is otherwise the heuristic to the byte.
 *
 * `combat-forecast.test.ts` pins the arithmetic; this pins the WIRING — the
 * §3.45 lesson that a correct formula nobody consults is a defect the maths
 * suite cannot see.
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
import {
  createDefaultAiRegistry,
  DEFAULT_PILOT_ID,
  HEURISTIC_PILOT_ID,
  SELECTABLE_PILOT_IDS,
} from './index.js';
import { createHeuristicPilot } from './heuristic.js';
import { createLookaheadPilot, LOOKAHEAD_PILOT_ID } from './lookahead.js';
import { creatureDef, landDef, putOnBattlefield, giveHand } from './test-support.js';

function stubDeck(): DeckList {
  return { cards: Array.from({ length: 30 }, (_, i) => landDef(`L${i}`, 'G')) };
}

function freshGame(seed = 1): GameState {
  const { state } = createGame({ seed, decks: { A: stubDeck(), B: stubDeck() } });
  state.players.A.hand = [];
  state.players.B.hand = [];
  state.stack = [];
  return state;
}

function atDeclareAttackers(state: GameState): void {
  state.step = 'declareAttackers';
  state.activePlayer = 'A';
  state.priorityPlayer = 'A';
  // The engine offers `declareAttackers` only inside an OPEN combat window —
  // the combat object exists and nothing is declared yet (engine.ts).
  state.combat = { attackers: [], blocks: {}, attackersDeclared: false, blockersDeclared: false };
}

function choose(pilot: ReturnType<typeof createLookaheadPilot>, state: GameState, seed = 7): GameAction {
  return pilot.chooseAction({
    view: state,
    legalActions: generateLegalActions(state),
    rng: createRng(seed),
  });
}

describe('registration — the §2 seam carries the new pilot everywhere', () => {
  it('registers under its id, selectable, and the DEFAULT is still the heuristic', () => {
    const registry = createDefaultAiRegistry();
    expect(registry.getPilot(LOOKAHEAD_PILOT_ID)?.id).toBe(LOOKAHEAD_PILOT_ID);
    expect(SELECTABLE_PILOT_IDS).toContain(LOOKAHEAD_PILOT_ID);
    // §3.47 ships a CANDIDATE, not a coup: flipping the default is the
    // integrator's measured decision, not a side effect of landing the pilot.
    expect(DEFAULT_PILOT_ID).toBe(HEURISTIC_PILOT_ID);
  });

  it('declares no game observer, like every built-in pilot', () => {
    expect(createLookaheadPilot().createGameObserver).toBeUndefined();
  });
});

describe('the crack-back interception — the play §3.45 proved the heuristic gets wrong', () => {
  /**
   * A at 4 life with two 2/2s; B's two 5/5s are TAPPED. There is no untapped
   * blocker, so the heuristic sees free face damage and taps out — and next turn
   * the giants untap and kill it through zero blockers. The lookahead holds.
   * One position, two pilots, opposite answers: the differentiating case.
   */
  function overextensionBoard(): GameState {
    const state = freshGame(31);
    state.players.A.life = 4;
    putOnBattlefield(state, 'A', [creatureDef('Guard One', 2, 2), creatureDef('Guard Two', 2, 2)]);
    const giants = putOnBattlefield(state, 'B', [
      creatureDef('Giant One', 5, 5),
      creatureDef('Giant Two', 5, 5),
    ]);
    for (const giant of giants) giant.tapped = true;
    atDeclareAttackers(state);
    return state;
  }

  it('the heuristic attacks into the lethal crack-back (the recorded blind spot)', () => {
    const action = createHeuristicPilot().chooseAction({
      view: overextensionBoard(),
      legalActions: generateLegalActions(overextensionBoard()),
      rng: createRng(7),
    });
    expect(action.kind).toBe('declareAttackers');
  });

  it('the lookahead holds its blockers instead', () => {
    const action = choose(createLookaheadPilot(), overextensionBoard());
    expect(action.kind).toBe('passPriority');
  });

  it('and says WHY, through the standard trace seam', () => {
    const state = overextensionBoard();
    let reason = '';
    createLookaheadPilot().chooseAction({
      view: state,
      legalActions: generateLegalActions(state),
      rng: createRng(7),
      trace: (t) => {
        reason = t.reason;
      },
    });
    expect(reason).toContain('holding back');
  });
});

describe('the proven kill is taken without a forecast', () => {
  it('declares the unblockable lethal alpha strike', () => {
    const state = freshGame(32);
    state.players.B.life = 4;
    const team = putOnBattlefield(state, 'A', [
      creatureDef('Closer One', 3, 3),
      creatureDef('Closer Two', 3, 3),
    ]);
    // One chump can soak 3; the other 3 still kill through any assignment.
    putOnBattlefield(state, 'B', [creatureDef('Chump', 1, 1)]);
    atDeclareAttackers(state);

    const action = choose(createLookaheadPilot(), state);
    expect(action.kind).toBe('declareAttackers');
    if (action.kind === 'declareAttackers') {
      expect([...action.attackers].sort()).toEqual(team.map((c) => c.instanceId).sort());
    }
  });
});

describe('delegation — everywhere else it IS the heuristic', () => {
  it('main-phase decisions match the heuristic exactly, same seed, same choice', () => {
    const build = () => {
      const state = freshGame(33);
      state.step = 'main1';
      state.activePlayer = 'A';
      state.priorityPlayer = 'A';
      putOnBattlefield(state, 'A', [landDef('Forest A', 'G'), landDef('Forest B', 'G')]);
      giveHand(state, 'A', [creatureDef('Grizzly', 2, 2, { cost: { G: 1 } })]);
      return state;
    };
    const heuristicChoice = createHeuristicPilot().chooseAction({
      view: build(),
      legalActions: generateLegalActions(build()),
      rng: createRng(9),
    });
    const lookaheadChoice = createLookaheadPilot().chooseAction({
      view: build(),
      legalActions: generateLegalActions(build()),
      rng: createRng(9),
    });
    expect(lookaheadChoice).toEqual(heuristicChoice);
  });

  it('the DEFENDING seat at declare-attackers is not intercepted', () => {
    // Priority in the opponent's declare step (e.g. holding instants) must fall
    // through to the heuristic's priority logic, not the attack planner.
    const state = freshGame(34);
    state.step = 'declareAttackers';
    state.activePlayer = 'B';
    state.priorityPlayer = 'A';
    putOnBattlefield(state, 'A', [creatureDef('Bystander', 2, 2)]);
    const action = choose(createLookaheadPilot(), state);
    expect(action.kind).toBe('passPriority');
  });

  it('a shared instance across games carries no state: same board, same answer, twice', () => {
    // The sim harness reuses one pilot instance across hundreds of games; a
    // forecast that remembered anything would unbalance the pilot-ab control.
    const pilot = createLookaheadPilot();
    const build = () => {
      const state = freshGame(35);
      state.players.A.life = 4;
      putOnBattlefield(state, 'A', [creatureDef('Guard', 2, 2)]);
      const [giant] = putOnBattlefield(state, 'B', [creatureDef('Giant', 5, 5)]);
      giant!.tapped = true;
      atDeclareAttackers(state);
      return state;
    };
    const first = choose(pilot, build());
    const second = choose(pilot, build());
    expect(second).toEqual(first);
  });
});
