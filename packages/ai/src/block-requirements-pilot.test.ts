/**
 * The pilot vs BLOCK REQUIREMENTS (CR 509.1c/d) — the "the AI must not be blind"
 * half of the rule.
 *
 * A block requirement is the sharpest case of the general problem, for two
 * reasons:
 *
 *  1. **Getting it wrong loses the WHOLE declaration.** A declaration that
 *     satisfies fewer requirements than it could is rejected outright, so a pilot
 *     that picked its favourite blocks first and only then noticed the lure loses
 *     every block in the same action, not just the one it got wrong. The engine
 *     then re-offers the same decision, which is a live-lock.
 *  2. **A LURE IS A THREAT, NOT A GIFT.** "Must be blocked if able" does not make
 *     the creature easier to kill; it drags the defender's blockers off every
 *     other attacker. A pilot that ranked removal targets by body size alone
 *     would leave the lure alone and lose to the attack it enabled.
 *
 * Both are tested through the REAL heuristic pilot against the REAL engine, so a
 * pilot that merely *believes* it is legal cannot pass.
 */

import { describe, expect, it } from 'vitest';
import {
  applyAction,
  createGame,
  createRng,
  DEFAULT_RULES,
  generateLegalActions,
  type CardDefinition,
  type DeckList,
  type GameAction,
  type GameState,
} from '@jonny-boi/core';
import { createHeuristicPilot } from './heuristic.js';
import { addPool, creatureDef, destroyDef, giveHand, landDef, putOnBattlefield } from './test-support.js';

function stubDeck(): DeckList {
  return { cards: Array.from({ length: 30 }, (_, i) => landDef(`L${i}`, 'R')) };
}

function freshGame(seed = 1): GameState {
  const { state } = createGame({ seed, decks: { A: stubDeck(), B: stubDeck() } });
  return state;
}

function intoMainPhase(state: GameState): void {
  state.step = 'precombatMain';
  state.activePlayer = 'A';
  state.priorityPlayer = 'A';
  state.stack = [];
  state.players.A.hand = [];
  state.players.B.hand = [];
  state.players.A.landsPlayedThisTurn = 0;
}

function intoDeclareBlockers(state: GameState, attackers: readonly number[]): void {
  state.step = 'declareBlockers';
  state.activePlayer = 'A';
  state.priorityPlayer = 'B';
  state.stack = [];
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
    rng: createRng(99),
  });
}

/** The engine's verdict on an action, as a rejection reason or `undefined`. */
function rejectionOf(state: GameState, action: GameAction): string | undefined {
  const result = applyAction(state, action, DEFAULT_RULES);
  const rejected = result.events.find((e) => e.type === 'actionRejected');
  return rejected ? (rejected as { reason: string }).reason : undefined;
}

describe('the pilot proposes only declarations the requirement rules accept', () => {
  it('blocks a lure it would otherwise happily ignore', () => {
    // The lure is a 1/1: blocking it with a 3/3 is a fine trade, but blocking it
    // with the 3/3 while a 5/5 swings in is not what the pilot would CHOOSE. The
    // rule leaves it no choice, and the engine must accept what the pilot builds.
    const state = freshGame(11);
    const [lure, big] = putOnBattlefield(state, 'A', [
      creatureDef('Lure Target', 1, 1, { keywords: { mustBeBlocked: true } }),
      creatureDef('Big Threat', 5, 5),
    ]);
    putOnBattlefield(state, 'B', [creatureDef('Bear', 3, 3)]);
    intoDeclareBlockers(state, [lure!.instanceId, big!.instanceId]);

    const action = choose(state);
    expect(action.kind).toBe('declareBlockers');
    if (action.kind === 'declareBlockers') {
      expect(action.blocks.map((b) => b.attacker)).toEqual([lure!.instanceId]);
      expect(rejectionOf(state, action)).toBeUndefined();
    }
  });

  it('puts EVERY able creature on an "all creatures able to block" attacker', () => {
    const state = freshGame(12);
    const [lure, other] = putOnBattlefield(state, 'A', [
      creatureDef('Lure', 1, 1, { keywords: { blockedByAllAble: true } }),
      creatureDef('Other', 4, 4),
    ]);
    const defenders = putOnBattlefield(state, 'B', [
      creatureDef('First', 2, 2),
      creatureDef('Second', 2, 2),
    ]);
    intoDeclareBlockers(state, [lure!.instanceId, other!.instanceId]);

    const action = choose(state);
    expect(action.kind).toBe('declareBlockers');
    if (action.kind === 'declareBlockers') {
      const onLure = action.blocks.filter((b) => b.attacker === lure!.instanceId).map((b) => b.blocker);
      expect(onLure.sort()).toEqual(defenders.map((d) => d!.instanceId).sort());
      expect(rejectionOf(state, action)).toBeUndefined();
    }
  });

  it('never proposes a block a comparing RESTRICTION forbids', () => {
    // Gingerbrute's shape: only a hasty creature may block it. The pilot's only
    // untapped creature has no haste, so it must not be offered up — a rejected
    // declaration costs the pilot every other block in the same action.
    const state = freshGame(13);
    const [brute] = putOnBattlefield(state, 'A', [
      creatureDef('Gingerbrute', 3, 3, {
        keywords: { blockRestriction: { blockerMustHaveAnyOf: ['haste'] } },
      }),
    ]);
    putOnBattlefield(state, 'B', [creatureDef('Slow Wall', 0, 6)]);
    intoDeclareBlockers(state, [brute!.instanceId]);

    const action = choose(state);
    if (action.kind === 'declareBlockers') {
      expect(action.blocks).toEqual([]);
      expect(rejectionOf(state, action)).toBeUndefined();
    } else {
      // Passing (taking the hit) is the other legal answer, and also fine.
      expect(action.kind).toBe('passPriority');
    }
  });
});

describe('a lure is a THREAT: the pilot points removal at it', () => {
  it('kills the 1/1 lure over the bigger ordinary creature', () => {
    const state = freshGame(14);
    intoMainPhase(state);
    const [lure, bear] = putOnBattlefield(state, 'B', [
      creatureDef('Lure Target', 1, 1, { keywords: { mustBeBlocked: true } }),
      creatureDef('Ordinary Bear', 4, 4),
    ]);
    giveHand(state, 'A', [destroyDef('Doom Blade')]);
    addPool(state, 'A', 'B', 1);
    addPool(state, 'A', 'R', 1);

    const action = choose(state);
    expect(action.kind).toBe('castSpell');
    if (action.kind === 'castSpell') {
      expect(action.targets).toEqual([lure!.instanceId]);
      expect(action.targets).not.toContain(bear!.instanceId);
    }
  });

  it('still prefers a genuinely bigger body when the gap is large enough', () => {
    // The bonus is worth a couple of stat points, not infinity — a 1/1 lure does
    // not outrank a 9/9. Pinned so a later tuning pass that raises the weight has
    // to decide that deliberately.
    const state = freshGame(15);
    intoMainPhase(state);
    const [, colossus] = putOnBattlefield(state, 'B', [
      creatureDef('Lure Target', 1, 1, { keywords: { mustBeBlocked: true } }),
      creatureDef('Colossus', 9, 9),
    ]);
    giveHand(state, 'A', [destroyDef('Doom Blade')]);
    addPool(state, 'A', 'B', 1);
    addPool(state, 'A', 'R', 1);

    const action = choose(state);
    expect(action.kind).toBe('castSpell');
    if (action.kind === 'castSpell') {
      expect(action.targets).toEqual([colossus!.instanceId]);
    }
  });
});

/** Referenced so the import stays honest about what a definition is here. */
export type PilotBlockTestCard = CardDefinition;
