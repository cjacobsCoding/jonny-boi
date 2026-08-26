/**
 * THE COMBAT FORECAST's arithmetic (DESIGN §3.47), pinned against the three
 * measured failure modes §3.45 recorded:
 *
 *   - no ALLOCATION → one wall deters an army and the board stalls;
 *   - no CRACK-BACK model → the pilot taps out into a lethal counterattack;
 *   - no RACE model → holding back reads the same as being ahead.
 *
 * `lookahead-pilot.test.ts` pins that the pilot ASKS this module; this file pins
 * what the module answers. Same split, same reason, as `combat-math.test.ts`
 * next to `combat-math-pilot.test.ts`.
 */

import { describe, expect, it } from 'vitest';
import { createGame, type DeckList, type GameState, type InstanceId } from '@jonny-boi/core';
import { boardIndex } from './board-stats.js';
import { chooseAttackPlan, DEFAULT_FORECAST_WEIGHTS } from './combat-forecast.js';
import { creatureDef, landDef, putOnBattlefield } from './test-support.js';
import { DEFAULT_HEURISTIC_WEIGHTS } from './weights.js';

function stubDeck(): DeckList {
  return { cards: Array.from({ length: 30 }, (_, i) => landDef(`L${i}`, 'G')) };
}

/** A fresh game paused at A's declare-attackers step, hands emptied. */
function atDeclareAttackers(seed = 1): GameState {
  const { state } = createGame({ seed, decks: { A: stubDeck(), B: stubDeck() } });
  state.step = 'declareAttackers';
  state.activePlayer = 'A';
  state.priorityPlayer = 'A';
  state.stack = [];
  state.players.A.hand = [];
  state.players.B.hand = [];
  return state;
}

function planFor(state: GameState, eligible: readonly InstanceId[]) {
  return chooseAttackPlan(
    state,
    eligible,
    DEFAULT_HEURISTIC_WEIGHTS,
    DEFAULT_FORECAST_WEIGHTS,
    boardIndex(state),
  );
}

describe('allocation — one blocker cannot deter an army (§3.45 failure 1)', () => {
  it('sends the team through a lone 0/4 wall: one attacker is soaked, the rest connect', () => {
    const state = atDeclareAttackers(21);
    const [a1, a2, a3] = putOnBattlefield(state, 'A', [
      creatureDef('Bear One', 2, 2),
      creatureDef('Bear Two', 2, 2),
      creatureDef('Bear Three', 2, 2),
    ]);
    putOnBattlefield(state, 'B', [creatureDef('Wall', 0, 4, { keywords: { defender: true } })]);

    const choice = planFor(state, [a1!.instanceId, a2!.instanceId, a3!.instanceId]);
    expect(choice.attackers.length).toBe(3);
    // The wall blocks exactly one; two connect for 4 — the allocation the plain
    // per-attacker rule cannot express.
    expect(choice.forecast.faceDamage).toBe(4);
  });

  it('attacks THROUGH a deathtoucher instead of stalling: the trade is priced, not feared', () => {
    // §3.45 failure 1: fight-maths on the attack side alone froze every attack
    // into a Deadly Recluse. With allocation the Recluse eats ONE attacker and
    // the other two connect — attacking stays right.
    const state = atDeclareAttackers(22);
    const [a1, a2, a3] = putOnBattlefield(state, 'A', [
      creatureDef('Raider One', 2, 2),
      creatureDef('Raider Two', 2, 2),
      creatureDef('Raider Three', 2, 2),
    ]);
    putOnBattlefield(state, 'B', [
      creatureDef('Deadly Spider', 1, 2, { keywords: { deathtouch: true, reach: true } }),
    ]);

    const choice = planFor(state, [a1!.instanceId, a2!.instanceId, a3!.instanceId]);
    expect(choice.attackers.length).toBe(3);
    expect(choice.forecast.faceDamage).toBe(4);
    // The forecast SAW the deathtouch trade — one of ours dies for their spider.
    expect(choice.forecast.myDeadStats).toBe(4);
    expect(choice.forecast.theirDeadStats).toBe(3);
  });
});

describe('the crack-back — what my board can still block after these attackers tap (§3.45 failure 2)', () => {
  it('holds the team back when tapping out hands the opponent a lethal counterattack', () => {
    // A at 4 life with two 2/2s; B has two TAPPED 5/5s. No untapped blocker, so
    // face damage is free — and next turn the 5/5s untap and kill A unless the
    // 2/2s stay home to chump. The §3.45 build attacked here and died.
    const state = atDeclareAttackers(23);
    state.players.A.life = 4;
    const [a1, a2] = putOnBattlefield(state, 'A', [
      creatureDef('Guard One', 2, 2),
      creatureDef('Guard Two', 2, 2),
    ]);
    const [b1, b2] = putOnBattlefield(state, 'B', [
      creatureDef('Giant One', 5, 5),
      creatureDef('Giant Two', 5, 5),
    ]);
    b1!.tapped = true;
    b2!.tapped = true;

    const choice = planFor(state, [a1!.instanceId, a2!.instanceId]);
    expect(choice.attackers).toEqual([]);
    // Holding keeps both bodies on defence: nothing is guaranteed through.
    expect(choice.forecast.crackBack).toBe(0);
    expect(choice.forecast.facingLethalAfter).toBe(false);
  });

  it('vigilance changes the same answer: the body attacks AND stays home, so the swing is safe', () => {
    const state = atDeclareAttackers(24);
    state.players.A.life = 5;
    const [angel] = putOnBattlefield(state, 'A', [
      creatureDef('Watchful Angel', 4, 4, { keywords: { vigilance: true } }),
    ]);
    const [giant] = putOnBattlefield(state, 'B', [creatureDef('Sleeping Giant', 5, 5)]);
    giant!.tapped = true;

    const choice = planFor(state, [angel!.instanceId]);
    expect(choice.attackers).toEqual([angel!.instanceId]);
    expect(choice.forecast.faceDamage).toBe(4);
    // The vigilant body still blocks, so the giant's crack-back is fully soaked.
    expect(choice.forecast.crackBack).toBe(0);
  });

  it('and WITHOUT vigilance the identical board holds back — the pair that isolates the model', () => {
    const state = atDeclareAttackers(24);
    state.players.A.life = 5;
    const [bruiser] = putOnBattlefield(state, 'A', [creatureDef('Reckless Bruiser', 4, 4)]);
    const [giant] = putOnBattlefield(state, 'B', [creatureDef('Sleeping Giant', 5, 5)]);
    giant!.tapped = true;

    const choice = planFor(state, [bruiser!.instanceId]);
    expect(choice.attackers).toEqual([]);
  });
});

describe('the race — several turns ahead, in closed form', () => {
  it('reports both clocks after the exchange, and prefers the plan that wins the race', () => {
    // A: three 3/3s vs B: one 1/2 deathtoucher, B at 12. Attacking trades one
    // 3/3 for the spider and puts B on a two-swing clock while B has none.
    const state = atDeclareAttackers(25);
    state.players.B.life = 12;
    const [a1, a2, a3] = putOnBattlefield(state, 'A', [
      creatureDef('Brawler One', 3, 3),
      creatureDef('Brawler Two', 3, 3),
      creatureDef('Brawler Three', 3, 3),
    ]);
    putOnBattlefield(state, 'B', [
      creatureDef('Deadly Spider', 1, 2, { keywords: { deathtouch: true, reach: true } }),
    ]);

    const choice = planFor(state, [a1!.instanceId, a2!.instanceId, a3!.instanceId]);
    expect(choice.attackers.length).toBe(3);
    const f = choice.forecast;
    // Two connect for 6; B drops to 6; two survivors kill in one more swing.
    expect(f.faceDamage).toBe(6);
    expect(f.myClock).toBe(1);
    // A spider-less, creature-less B has no clock at all — saturated.
    expect(f.theirClock).toBeGreaterThan(f.myClock);
  });

  it('a modelled kill through the predicted blocks outranks any holding pattern', () => {
    // B at 3 with one 2/2: the proven-lethal solver cannot promise the kill
    // (a chump soaks one attacker), but the forecast sees 4 through the
    // predicted block and takes it.
    const state = atDeclareAttackers(26);
    state.players.B.life = 3;
    const [a1, a2, a3] = putOnBattlefield(state, 'A', [
      creatureDef('Finisher One', 2, 2),
      creatureDef('Finisher Two', 2, 2),
      creatureDef('Finisher Three', 2, 2),
    ]);
    putOnBattlefield(state, 'B', [creatureDef('Chump', 2, 2)]);

    const choice = planFor(state, [a1!.instanceId, a2!.instanceId, a3!.instanceId]);
    expect(choice.forecast.lethalNow).toBe(true);
    expect(choice.attackers.length).toBe(3);
  });
});

describe('the search is deterministic and bounded', () => {
  it('the same position forecasts the same plan, twice', () => {
    const build = () => {
      const state = atDeclareAttackers(27);
      state.players.A.life = 9;
      const mine = putOnBattlefield(state, 'A', [
        creatureDef('Alpha', 3, 2),
        creatureDef('Beta', 2, 4, { keywords: { vigilance: true } }),
        creatureDef('Gamma', 1, 1),
      ]);
      const theirs = putOnBattlefield(state, 'B', [
        creatureDef('Keeper', 2, 3),
        creatureDef('Sky Menace', 3, 3, { keywords: { flying: true } }),
      ]);
      theirs[1]!.tapped = true;
      return { state, ids: mine.map((c) => c.instanceId) };
    };
    const one = build();
    const two = build();
    const choiceOne = planFor(one.state, one.ids);
    const choiceTwo = planFor(two.state, two.ids);
    expect(choiceTwo.attackers).toEqual(choiceOne.attackers);
    expect(choiceTwo.forecast).toEqual(choiceOne.forecast);
  });

  it('never proposes an attacker outside the engine-offered eligibility list', () => {
    const state = atDeclareAttackers(28);
    const mine = putOnBattlefield(state, 'A', [
      creatureDef('Eligible', 3, 3),
      creatureDef('Withheld', 5, 5),
    ]);
    putOnBattlefield(state, 'B', [creatureDef('Bystander', 1, 1)]);
    // The engine offered only the first — the plan must respect that boundary.
    const choice = planFor(state, [mine[0]!.instanceId]);
    for (const id of choice.attackers) expect(id).toBe(mine[0]!.instanceId);
  });
});
