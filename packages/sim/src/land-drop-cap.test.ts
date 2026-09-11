/**
 * THE LAND-DROP CAP CHECK, ON THE POSITIONS THAT BROKE IT (DESIGN §3.142).
 *
 * `land-drop-cap.ts` explains why a snapshot cannot answer "did this player play
 * too many lands". These are the two states that proved it, plus the two the
 * check must still catch — because a check that stops crying wolf by stopping
 * checking is the failure this repo names explicitly: a check that reports
 * something other than "I didn't check".
 *
 * The states are hand-built rather than replayed: the soak's own seed 3679986871
 * is pinned in `soak.test.ts`, and what belongs here is the RULE, stated so a
 * failure reads as a sentence rather than as a game.
 */

import { describe, expect, it } from 'vitest';
import {
  createGame,
  DEFAULT_RULES,
  type CardDefinition,
  type DeckList,
  type GameState,
  type PlayerId,
} from '@jonny-boi/core';
import { createLandDropCapWatch } from './land-drop-cap.js';

const FOREST: CardDefinition = { id: 'Forest', name: 'Forest', types: ['land'], basic: true, produces: ['G'] };
/** Icetill Explorer's half that matters here: "you may play an additional land". */
const EXPLORATION: CardDefinition = {
  id: 'Icetill Explorer',
  name: 'Icetill Explorer',
  types: ['creature'],
  power: 2,
  toughness: 4,
  cost: { generic: 2, G: 2 },
  additionalLandPlays: 1,
};

function stubDeck(): DeckList {
  return { cards: Array.from({ length: 30 }, () => FOREST) };
}

function freshGame(): GameState {
  const { state } = createGame({ seed: 3679986871, decks: { A: stubDeck(), B: stubDeck() } });
  state.battlefield = [];
  return state;
}

/** Put a permanent under `player`'s control, and hand back the instance id. */
function place(state: GameState, player: PlayerId, def: CardDefinition): number {
  const instanceId = state.nextInstanceId++;
  state.battlefield.push({
    instanceId,
    def,
    controller: player,
    owner: player,
    zone: 'battlefield',
    tapped: false,
    summoningSick: false,
    damageMarked: 0,
    markedByDeathtouch: false,
    counters: {},
  } as never);
  return instanceId;
}

/** Hand the watch a state as `active`'s turn number `turn`. */
function turn(state: GameState, active: PlayerId, turnNumber: number): GameState {
  state.activePlayer = active;
  state.turnNumber = turnNumber;
  return state;
}

describe('the land-drop cap is judged against the cap the seat HAD, not the cap it has now', () => {
  it("does not report a seat whose extra-land permanent died after its own turn", () => {
    /*
     * THE FALSE POSITIVE (soak seed 3679986871). B played two lands on turn 16
     * under Icetill Explorer — legally, because the Explorer prints both "an
     * additional land" and "you may play lands from your graveyard". It blocked
     * on turn 17 and died. `landsPlayedThisTurn` is cleared only for the seat
     * whose turn is BEGINNING, so B's 2 is still sitting there on A's turn,
     * while `maxLandPlaysFor(B)` has fallen back to 1.
     */
    const watch = createLandDropCapWatch(DEFAULT_RULES);
    const state = freshGame();
    const explorer = place(state, 'B', EXPLORATION);

    // B's turn: the second drop is made while the Explorer is on the board.
    turn(state, 'B', 16);
    state.players.B.landsPlayedThisTurn = 1;
    expect(watch.check(state)).toBeUndefined();
    state.players.B.landsPlayedThisTurn = 2;
    expect(watch.check(state)).toBeUndefined();

    // A's turn: the Explorer dies in combat, and B's count is a leftover.
    turn(state, 'A', 17);
    state.players.A.landsPlayedThisTurn = 1;
    state.battlefield = state.battlefield.filter((c) => c.instanceId !== explorer);
    expect(watch.check(state)).toBeUndefined();
  });

  it('does not report a seat that LOSES the permanent during its own turn', () => {
    // The same shape one turn tighter: instant-speed removal on the Explorer
    // after the second drop. The plays were legal when they were made.
    const watch = createLandDropCapWatch(DEFAULT_RULES);
    const state = freshGame();
    const explorer = place(state, 'B', EXPLORATION);
    turn(state, 'B', 4);
    state.players.B.landsPlayedThisTurn = 2;
    expect(watch.check(state)).toBeUndefined();
    state.battlefield = state.battlefield.filter((c) => c.instanceId !== explorer);
    expect(watch.check(state)).toBeUndefined();
  });

  it('REPORTS a second drop by a seat that never held an extra-land permanent', () => {
    // The thing the check is FOR. Nothing on the board ever raised the cap, so a
    // count of 2 is a land drop that escaped the counter.
    const watch = createLandDropCapWatch(DEFAULT_RULES);
    const state = freshGame();
    turn(state, 'B', 6);
    state.players.B.landsPlayedThisTurn = 2;
    expect(watch.check(state)).toMatch(/B played 2 lands/);
  });

  it('REPORTS a THIRD drop under a permanent that only allows two', () => {
    // One over the raised cap is as much a violation as one over the base cap —
    // the bound moves, it does not disappear.
    const watch = createLandDropCapWatch(DEFAULT_RULES);
    const state = freshGame();
    place(state, 'B', EXPLORATION);
    turn(state, 'B', 6);
    state.players.B.landsPlayedThisTurn = 2;
    expect(watch.check(state)).toBeUndefined();
    state.players.B.landsPlayedThisTurn = 3;
    expect(watch.check(state)).toMatch(/B played 3 lands/);
  });

  it("a seat's allowance is re-read when its OWN next turn begins", () => {
    // The bound must not be remembered across the seat's own turn boundary, or a
    // dead Exploration would keep excusing a second drop for the rest of the game.
    const watch = createLandDropCapWatch(DEFAULT_RULES);
    const state = freshGame();
    const explorer = place(state, 'B', EXPLORATION);
    turn(state, 'B', 8);
    state.players.B.landsPlayedThisTurn = 2;
    expect(watch.check(state)).toBeUndefined();

    turn(state, 'A', 9);
    state.battlefield = state.battlefield.filter((c) => c.instanceId !== explorer);
    expect(watch.check(state)).toBeUndefined();

    // B's next turn: the count resets with the turn, and so does the allowance.
    turn(state, 'B', 10);
    state.players.B.landsPlayedThisTurn = 2;
    expect(watch.check(state)).toMatch(/B played 2 lands/);
  });
});
