/**
 * THE PILOT PLAYS SPLIT SECOND (CR 702.61, DESIGN §3.142).
 *
 * THE INCIDENT (soak seed 3736754678, turn 27): B cast its own Siege Smash —
 * split second — in its upkeep, then tapped two lands and cast Mouser Attack!
 * in response to it. The offer pass had withdrawn every `castSpell` from the
 * menu; the pilot built one anyway, because the spell scorer derives castability
 * from its OWN timing rule ("mirrors core's timing gate") rather than asking.
 * Both halves of the soak fired at once — `legalActionsOnly` (an action that was
 * never offered) and `noRejectedActions` (the apply path refused it).
 *
 * ⚠️ It is the same defect as the block mirrors, in a different rule: a pilot
 * answering a rules question with a local copy of the rule that is missing a
 * clause. The fix is not a fourth condition in the scorer — it is one
 * `splitSecondOnStack(view)` at the seam every constructed play passes through,
 * which is core's own predicate, the one `generateLegalActions` filters by.
 *
 * These boards are hand-built rather than replayed so the failure is a named
 * sentence rather than a seed; `soak.test.ts` pins the original game as well.
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
import { createHeuristicPilot, policyCandidates } from './heuristic.js';
import { burnDef, creatureDef, giveHand, landDef, putOnBattlefield, putOnStack } from './test-support.js';

const MOUNTAIN = landDef('Mountain', 'R');
/** Siege Smash's shape: an instant that locks the game while it is on the stack. */
const SPLIT_SECOND_SPELL: CardDefinition = {
  ...burnDef('Siege Smash', 3, { generic: 1, R: 1 }),
  keywords: { splitSecond: true },
};
/** The same card without the keyword — the control that proves the pilot WANTS to act. */
const PLAIN_SPELL: CardDefinition = burnDef('Plain Smash', 3, { generic: 1, R: 1 });
/** What the pilot tried to cast into its own lock. */
const RESPONSE = burnDef('Mouser Attack!', 2, { R: 1 });

function stubDeck(): DeckList {
  return { cards: Array.from({ length: 30 }, () => MOUNTAIN) };
}

const pilot = createHeuristicPilot();

/**
 * B holds priority with `onStack` on the stack, a burn spell in hand, and enough
 * untapped Mountains to cast it — so the ONLY thing standing between the pilot
 * and a cast is the rule.
 */
function board(onStack: CardDefinition): GameState {
  const { state } = createGame({ seed: 3736754678, decks: { A: stubDeck(), B: stubDeck() } });
  state.step = 'upkeep';
  state.activePlayer = 'B';
  state.priorityPlayer = 'B';
  state.players.A.hand = [];
  state.players.B.hand = [];
  putOnBattlefield(state, 'B', [MOUNTAIN, MOUNTAIN, MOUNTAIN]);
  // A target worth pointing a burn spell at, or the pilot holds the card for
  // want of a reason rather than for want of permission.
  putOnBattlefield(state, 'A', [creatureDef('Bear', 2, 2)]);
  giveHand(state, 'B', [RESPONSE]);
  putOnStack(state, 'B', onStack);
  return state;
}

function choose(state: GameState): GameAction {
  return pilot.chooseAction({
    view: state,
    legalActions: generateLegalActions(state),
    rng: createRng(27),
  });
}

/** The engine's refusal, if any: a rejected action leaves one `actionRejected` event. */
function rejectionOf(state: GameState, action: GameAction): string | undefined {
  for (const event of applyAction(state, action).events) {
    if (event.type === 'actionRejected') return event.reason;
  }
  return undefined;
}

describe('the pilot never plays into a split-second lock', () => {
  it('passes rather than constructing a cast the menu withdrew', () => {
    const state = board(SPLIT_SECOND_SPELL);
    // The menu really has withdrawn it — otherwise this test proves nothing
    // about the pilot, only about the board.
    expect(generateLegalActions(state).some((a) => a.kind === 'castSpell')).toBe(false);

    const action = choose(state);
    expect(action.kind).toBe('passPriority');
    // The invariant the soak broke, asserted directly: whatever the pilot
    // chooses, the engine accepts it.
    expect(rejectionOf(state, action)).toBeUndefined();
  });

  it('CONTROL: the same board without the keyword gets the cast', () => {
    // Proof the first test is about the LOCK and not about a pilot that had no
    // interest in casting anyway — the trap a "it passed, so it is fixed"
    // assertion falls into every time.
    const state = board(PLAIN_SPELL);
    const action = choose(state);
    expect(['castSpell', 'tapForMana']).toContain(action.kind);
    expect(rejectionOf(state, action)).toBeUndefined();
  });

  it('offers a SEARCH nothing but the pass under the lock', () => {
    /*
     * THE SAME DEFECT'S OTHER HOME. `policyCandidates` is the seam the search
     * pilots reach, and it builds the same constructed casts, cycles and
     * activations `decide` does — so a class fixed only in `decide` is fixed in
     * one of its two homes. The soak walks the DEFAULT pilot, which reaches
     * `decide`; nothing in that run would ever have found this one.
     */
    const state = board(SPLIT_SECOND_SPELL);
    const options = policyCandidates(state, generateLegalActions(state));
    expect(options).toHaveLength(1);
    expect(options[0]!.plies.map((p) => p.kind)).toEqual(['passPriority']);
  });

  it('CONTROL: the search gets real options without the keyword', () => {
    const state = board(PLAIN_SPELL);
    const options = policyCandidates(state, generateLegalActions(state));
    expect(options.length).toBeGreaterThan(1);
  });

  it('acts again the moment the lock lifts', () => {
    // The lock is the SPELL's, not the stack's: an empty stack is not special.
    const state = board(SPLIT_SECOND_SPELL);
    state.stack = [];
    const action = choose(state);
    expect(action.kind).not.toBe('passPriority');
    expect(rejectionOf(state, action)).toBeUndefined();
  });
});
