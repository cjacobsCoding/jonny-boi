/**
 * AN ACTIVATION WITH A SACRIFICE COST IS OFFERED ONLY WHEN IT CAN BE PAID.
 *
 * Found by the soak's cloning-vs-in-place comparison on the expanded pool
 * (§3.71): one path activated Soulreaper of Mogis ("{2}{B}, Sacrifice a
 * creature: Draw a card.") and the engine answered
 * "Soulreaper of Mogis's ability needs 1 legal permanent(s) to sacrifice".
 *
 * That message can only appear if the action reached the apply path at all, so
 * whatever else is true, an offer and an apply disagreed about the same cost on
 * the same board. This file pins the agreement directly, at the boundary where
 * it is cheapest to check: every activation the menu offers must be accepted.
 */

import { describe, expect, it } from 'vitest';
import { applyAction, createGame, DEFAULT_RULES, generateLegalActions } from './index.js';
import type { CardDefinition, GameState } from './index.js';

const SOULREAPER: CardDefinition = {
  id: 'test:soulreaper',
  name: 'Soulreaper of Mogis',
  types: ['creature'],
  cost: { generic: 3, B: 1 },
  power: 3,
  toughness: 2,
  activated: [
    {
      cost: { mana: { generic: 2, B: 1 }, sacrificeAnother: { anyOfTypes: ['creature'] } },
      effects: [{ primitive: 'drawCards', params: { count: 1 } }],
    },
  ],
};

const BEAR: CardDefinition = {
  id: 'test:bear',
  name: 'Bear',
  types: ['creature'],
  cost: { generic: 1, G: 1 },
  power: 2,
  toughness: 2,
};

function boardWith(defs: readonly CardDefinition[]): GameState {
  const { state } = createGame({
    seed: 7,
    startingPlayer: 'A',
    decks: { A: { cards: [] }, B: { cards: [] } },
  });
  for (const def of defs) {
    state.battlefield.push({
      instanceId: state.nextInstanceId++,
      def,
      controller: 'A',
      owner: 'A',
      zone: 'battlefield',
      tapped: false,
      summoningSick: false,
      damageMarked: 0,
      markedByDeathtouch: false,
      counters: {},
    });
  }
  state.players.A.manaPool = { W: 0, U: 0, B: 9, R: 0, G: 0, C: 9 };
  return state;
}

/** Every `activateAbility` the menu offers, applied; the reasons it was refused. */
function rejectionsForOfferedActivations(state: GameState): string[] {
  const reasons: string[] = [];
  for (const action of generateLegalActions(state, DEFAULT_RULES)) {
    if (action.kind !== 'activateAbility') continue;
    const result = applyAction(state, action, DEFAULT_RULES);
    for (const event of result.events) {
      if (event.type === 'actionRejected') reasons.push((event as { reason: string }).reason);
    }
  }
  return reasons;
}

describe('a sacrifice cost is offered only when it can be paid', () => {
  it('offers the activation when another creature can pay, and the engine accepts it', () => {
    const state = boardWith([SOULREAPER, BEAR]);
    const offered = generateLegalActions(state, DEFAULT_RULES).filter(
      (action) => action.kind === 'activateAbility',
    );
    expect(offered.length, 'the ability should be offered with a payer available').toBeGreaterThan(0);
    expect(rejectionsForOfferedActivations(state)).toEqual([]);
  });

  it('offers the SELF-sacrifice when it is the only creature — and accepts that too', () => {
    // "Sacrifice a creature" does not say ANOTHER creature, so the source is a
    // legal payer for its own ability. Offering it and then refusing it is the
    // split this file exists to catch.
    const state = boardWith([SOULREAPER]);
    expect(rejectionsForOfferedActivations(state)).toEqual([]);
  });

  it('offers nothing at all when no creature can pay', () => {
    const state = boardWith([{ ...SOULREAPER, types: ['artifact'] }]);
    const offered = generateLegalActions(state, DEFAULT_RULES).filter(
      (action) => action.kind === 'activateAbility',
    );
    expect(offered).toEqual([]);
  });

  it('never offers a SECOND activation the first one has made unpayable', () => {
    // The shape a stale menu produces: activate once, the only payer is gone,
    // and a menu computed before that would still list the second activation.
    // Regenerating from the NEW state must not.
    const state = boardWith([SOULREAPER, BEAR]);
    const first = generateLegalActions(state, DEFAULT_RULES).find(
      (action) => action.kind === 'activateAbility',
    );
    expect(first).toBeDefined();
    const after = applyAction(state, first!, DEFAULT_RULES).state;
    expect(rejectionsForOfferedActivations(after)).toEqual([]);
  });
});
