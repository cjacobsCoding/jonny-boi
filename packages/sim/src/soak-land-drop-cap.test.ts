/**
 * §3.123 — THE LAND-DROP CAP IS READ AT THE MOMENT THE LAND WAS PLAYED.
 *
 * §3.71 already fixed this invariant once: it compared `landsPlayedThisTurn`
 * against the CONFIG's base of one, so the first Exploration in the pool turned
 * a legal second land drop into a reported rules violation. The fix was to ask
 * the engine — `maxLandPlaysFor` — instead of the config.
 *
 * The right reader, at the wrong moment, is the same bug one step further on.
 * The allowance is a LIVE quantity: it is the base plus every
 * `additionalLandPlays` permanent the seat controls RIGHT NOW. The engine
 * checks it when the land is played (CR 305.2) and never again — so an Azusa
 * that dies in combat after its controller's second land drop takes the limit
 * back down to one while the counter stays at two, and a watcher reading the
 * live board calls a legal turn a violation. That is exactly what the soak
 * reported on the 6,257-card pool: "B played 2 lands this turn", seed
 * 1297421786, at `combatDamage` — the step the creature died in.
 *
 * So the bound is the HIGH-WATER MARK of the allowance over the turn: every
 * land play is a decision and every decision is observed, so the largest
 * allowance the watcher saw this turn is at least the allowance in force when
 * the land was played. That is a weaker bound than a perfect one and a strictly
 * stronger one than "whatever is on the board now" — and the case the invariant
 * exists to catch, a seat playing more lands than it was EVER allowed, still
 * breaks it. The third test is that case, and it is why this is not a
 * weakening.
 */

import { describe, expect, it } from 'vitest';
import { createGame, type CardDefinition, type CardInstance, type DeckList, type GameAction, type GameState } from '@jonny-boi/core';
import { createGameWatcher } from './soak.js';
import { SOAK_INVARIANTS } from './soak-config.js';
import type { Pilot } from '@jonny-boi/ai';

/** Azusa, Lost but Seeking — the pool's "play two additional lands" creature. */
const AZUSA: CardDefinition = {
  id: 'Azusa',
  name: 'Azusa, Lost but Seeking',
  types: ['creature'],
  cost: { generic: 2, G: 1 },
  power: 1,
  toughness: 2,
  legendary: true,
  additionalLandPlays: 2,
};

function stubDeck(): DeckList {
  return { cards: Array.from({ length: 30 }, (_, i) => ({ id: `L${i}`, name: `L${i}`, types: ['land'], produces: ['G'] }) as CardDefinition) };
}

/** A pilot that only ever passes — the watcher is what is under test, not play. */
const PASSER: Pilot = {
  id: 'passer',
  description: 'passes',
  chooseAction(ctx): GameAction {
    return { kind: 'passPriority', player: (ctx.view as GameState).priorityPlayer };
  },
};

function board(): GameState {
  const { state } = createGame({ seed: 41, decks: { A: stubDeck(), B: stubDeck() } });
  state.step = 'precombatMain';
  state.activePlayer = 'B';
  state.priorityPlayer = 'B';
  state.stack = [];
  state.players.A.hand = [];
  state.players.B.hand = [];
  state.turnNumber = 19;
  return state;
}

function putAzusa(state: GameState): CardInstance {
  const azusa: CardInstance = {
    instanceId: 900_001 as CardInstance['instanceId'],
    def: AZUSA,
    owner: 'B',
    controller: 'B',
    zone: 'battlefield',
    tapped: false,
    summoningSick: false,
    damage: 0,
    counters: {},
  } as CardInstance;
  state.battlefield.push(azusa);
  return azusa;
}

/** Show the watcher a state, exactly as the real harness does before a decision. */
function observe(watcher: ReturnType<typeof createGameWatcher>, state: GameState): void {
  watcher.pilot.chooseAction({
    view: state,
    legalActions: [{ kind: 'passPriority', player: state.priorityPlayer }],
    rng: () => 0,
  } as never);
}

const capBreaks = (watcher: ReturnType<typeof createGameWatcher>) =>
  watcher.violations.filter((v) => v.invariant === SOAK_INVARIANTS.landDropCap);

describe('the land-drop cap invariant (§3.123)', () => {
  it('does not fire when the permanent that allowed the drop has since died', () => {
    const watcher = createGameWatcher(PASSER);
    const state = board();
    const azusa = putAzusa(state);
    // Turn 19 as it really ran: Azusa is out, B takes its second land drop.
    state.players.B.landsPlayedThisTurn = 2;
    observe(watcher, state);
    expect(capBreaks(watcher)).toEqual([]);
    // …then Azusa dies in combat. The counter stays; the live allowance drops.
    state.battlefield = state.battlefield.filter((c) => c.instanceId !== azusa.instanceId);
    state.players.B.graveyard.push({ ...azusa, zone: 'graveyard' } as CardInstance);
    state.step = 'combatDamage';
    observe(watcher, state);
    expect(capBreaks(watcher), 'a legal turn was reported as a rules violation').toEqual([]);
  });

  it('resets the allowance when the turn does — last turn’s Azusa buys nothing', () => {
    const watcher = createGameWatcher(PASSER);
    const state = board();
    const azusa = putAzusa(state);
    state.players.B.landsPlayedThisTurn = 2;
    observe(watcher, state);
    expect(capBreaks(watcher)).toEqual([]);
    // A NEW turn, with Azusa gone before anyone looked: two land drops are now
    // two more than the seat was ever allowed.
    state.battlefield = state.battlefield.filter((c) => c.instanceId !== azusa.instanceId);
    state.turnNumber = 20;
    state.players.B.landsPlayedThisTurn = 2;
    observe(watcher, state);
    expect(capBreaks(watcher)).toHaveLength(1);
  });

  it('STILL CATCHES the real thing: more lands than the seat was ever allowed', () => {
    const watcher = createGameWatcher(PASSER);
    const state = board();
    putAzusa(state); // allowance 3
    state.players.B.landsPlayedThisTurn = 4;
    observe(watcher, state);
    const breaks = capBreaks(watcher);
    expect(breaks).toHaveLength(1);
    expect(breaks[0]?.detail).toContain('allowed at most 3');
  });
});
