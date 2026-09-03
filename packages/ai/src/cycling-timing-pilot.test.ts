/**
 * §3.123 — THE PILOT ASKS ABOUT A CYCLING ABILITY'S **TIMING**.
 *
 * `bestCycle` is one of the few places the pilot BUILDS an action instead of
 * picking one off `generateLegalActions`: the engine only offers a `cycleCard`
 * once the pool already covers the cost, so a pilot that did not plan its taps
 * would never see cycling at all. That is the right design and it carries one
 * debt — everything the offer loop checks, this policy has to check too.
 *
 * Cycling itself prints no timing restriction, so for a long while there was
 * nothing to check. Then §3.112 modelled **transmute** (CR 702.53a, "activate
 * only as a sorcery") as a cycling-shaped ability with `timing: 'sorcery'`, and
 * the policy's two scoring cases became a trap: the only one that fires for a
 * non-land is "the turn is ending with mana unspent", read off `step === 'end'`
 * — which is precisely when a sorcery-timed ability is illegal. So the pilot
 * proposed the transmute at every end step it could pay for, and the engine
 * answered **"Transmute {1}{U}{U} may be activated only as a sorcery"**. A
 * rejection is not a free retry: the sim harness passes priority after
 * `maxConsecutiveRejectedActions`, so the pilot lost the rest of the turn.
 * (Found by the full-pool soak on the 6,257-card pool, seed 2769623907.)
 *
 * What is pinned: the LITERAL rejection no longer happens, the timing question
 * is asked through core's one reader, and the cycling policy is still alive for
 * the abilities that really are instant-speed.
 *
 * LEFT UNDONE, and named rather than hidden: the pilot does not VALUE a
 * transmute as the tutor it is, so it will not transmute in its main phase
 * either. That is a scoring feature (a new candidate in `scoredSpellGoals`),
 * not a legality one, and this repo does not ship a behaviour change without
 * the two-seed A/B (§3.85). The engine offers it; nothing is illegal or blind.
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
import { createTestRegistry, giveHand } from './test-support.js';

/** Dimir House Guard-shaped: a body with Transmute {1}{U}{U}, sorcery-only. */
const TRANSMUTER: CardDefinition = {
  id: 'Transmuter',
  name: 'Transmuter',
  types: ['creature'],
  power: 2,
  toughness: 3,
  cost: { generic: 4, U: 1 },
  cycling: [
    {
      cost: { generic: 1, U: 2 },
      effects: [
        {
          primitive: 'searchLibrary',
          params: { who: 'controller', count: 1, destination: 'hand', filter: { minManaValue: 5, maxManaValue: 5 } },
        },
      ],
      label: 'Transmute {1}{U}{U}',
      kind: 'transmute',
      timing: 'sorcery',
    },
  ],
};

/** An ordinary cycler — the CONTROL that proves the guard is narrow. */
const CYCLER: CardDefinition = {
  id: 'Cycler',
  name: 'Cycler',
  types: ['creature'],
  power: 2,
  toughness: 2,
  cost: { generic: 3, U: 1 },
  cycling: [{ cost: { generic: 1, U: 2 }, effects: [{ primitive: 'drawCards', params: { count: 1 } }], label: 'Cycling {1}{U}{U}' }],
};

function stubDeck(): DeckList {
  return { cards: Array.from({ length: 30 }, (_, i) => ({ id: `L${i}`, name: `L${i}`, types: ['land'], produces: ['U'] } as CardDefinition)) };
}

/** A's board with `lands` untapped blue sources, an empty hand, at `step`. */
function boardAt(step: GameState['step'], lands = 5): GameState {
  const { state } = createGame({ seed: 21, decks: { A: stubDeck(), B: stubDeck() } });
  state.step = step;
  state.activePlayer = 'A';
  state.priorityPlayer = 'A';
  state.stack = [];
  state.players.A.hand = [];
  state.players.B.hand = [];
  const island: CardDefinition = { id: 'Island', name: 'Island', types: ['land'], produces: ['U'] };
  const placed = giveHand(state, 'A', Array.from({ length: lands }, () => island));
  state.players.A.hand = [];
  for (const land of placed) {
    land.zone = 'battlefield';
    land.summoningSick = false;
    state.battlefield.push(land);
  }
  state.players.A.landsPlayedThisTurn = 1;
  return state;
}

/**
 * Let the pilot play out `plies` decisions, APPLYING each one — so a proposal
 * the engine refuses shows up here exactly as it does in a real game.
 * Returns every action taken and every rejection reason the engine gave.
 */
function drive(state: GameState, plies = 12): { actions: GameAction[]; rejections: string[] } {
  const reg = createTestRegistry();
  const pilot = createHeuristicPilot();
  const actions: GameAction[] = [];
  const rejections: string[] = [];
  let current = state;
  for (let ply = 0; ply < plies; ply++) {
    const action = pilot.chooseAction({ view: current, legalActions: generateLegalActions(current), rng: createRng(7) });
    actions.push(action);
    const result = applyAction(current, action, undefined, reg);
    for (const event of result.events) {
      if (event.type === 'actionRejected') rejections.push(event.reason);
    }
    current = result.state;
    if (action.kind === 'passPriority') break;
  }
  return { actions, rejections };
}

describe('a sorcery-timed cycling ability at the end step (§3.123)', () => {
  it('is NOT proposed, so the engine never has to refuse it', () => {
    const state = boardAt('end');
    giveHand(state, 'A', [TRANSMUTER]);
    const { actions, rejections } = drive(state);
    expect(rejections, `the engine refused something: ${rejections.join('; ')}`).toEqual([]);
    expect(actions.some((a) => a.kind === 'cycleCard')).toBe(false);
  });

  it('was refused with the exact message this fix exists for — which the engine still gives', () => {
    const state = boardAt('end');
    const [card] = giveHand(state, 'A', [TRANSMUTER]);
    state.players.A.manaPool = { W: 0, U: 2, B: 0, R: 0, G: 0, C: 1 };
    // The rule itself is unchanged: at the end step this really is illegal, and
    // core says so. What changed is that nothing proposes it any more.
    const result = applyAction(state, { kind: 'cycleCard', player: 'A', instanceId: card!.instanceId }, undefined, createTestRegistry());
    const rejected = result.events.find((e) => e.type === 'actionRejected');
    expect(rejected && (rejected as { reason: string }).reason).toBe('Transmute {1}{U}{U} may be activated only as a sorcery');
    // …and the menu agrees with the wall: it is not on the end-step menu.
    expect(generateLegalActions(state).some((a) => a.kind === 'cycleCard')).toBe(false);
  });

  it('IS on the menu in the main phase — the mechanic is gated, not dead', () => {
    const state = boardAt('precombatMain');
    giveHand(state, 'A', [TRANSMUTER]);
    state.players.A.manaPool = { W: 0, U: 2, B: 0, R: 0, G: 0, C: 1 };
    const offers = generateLegalActions(state).filter((a) => a.kind === 'cycleCard');
    expect(offers.length).toBeGreaterThan(0);
    // Offered ⇒ accepted. The §3.36 promise, on the very action that broke it.
    const result = applyAction(state, offers[0] as GameAction, undefined, createTestRegistry());
    expect(result.events.some((e) => e.type === 'actionRejected')).toBe(false);
  });

  it('CONTROL: an instant-speed cycler is still cycled at the end step', () => {
    const state = boardAt('end');
    giveHand(state, 'A', [CYCLER]);
    const { actions, rejections } = drive(state);
    expect(rejections).toEqual([]);
    expect(actions.some((a) => a.kind === 'cycleCard'), 'the cycling policy went dead').toBe(true);
  });
});
