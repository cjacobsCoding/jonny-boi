/**
 * The pilot has to CHOOSE WELL when a Clone enters (CR 707).
 *
 * This is the wiring that keeps a copy card from being noise. A copy effect is
 * one of the few cards whose entire value is a single decision, so a pilot that
 * answers it badly does not merely play a little worse — it turns the card into
 * a random variable, and every A/B verdict the card appears in gets that
 * variance for free. "Copying the worst creature on the board" is not a
 * rounding error; it is the difference between a 5/5 and a 1/1.
 *
 * Two failure modes are pinned here, and they fail independently:
 *
 *  1. **Ranking by the BOARD instead of by the COPIABLE values.** The generic
 *     `selectCards` path scores candidates with `cardValue`, which reads
 *     EFFECTIVE stats — counters, anthems, until-EOT pumps. None of that comes
 *     along (CR 707.2 gives you the printed card), so a pilot ranking that way
 *     copies the 1/1 wearing three +1/+1 counters over the printed 4/4 beside
 *     it and ends up a 1/1. This is the test that would have caught it.
 *  2. **Declining.** `min: 0` makes "no thanks" legal, and a Clone that declines
 *     is a 0/0 that dies to a state-based action on arrival — a mulligan of the
 *     card. The pilot must take the copy whenever it beats its own printed body.
 */

import { describe, expect, it } from 'vitest';
import { applyAction, createGame, createRng, type CardDefinition, type GameState } from '@jonny-boi/core';
import { createHeuristicPilot } from './heuristic.js';
import { copyTargetValue } from './choices.js';
import { DEFAULT_HEURISTIC_WEIGHTS } from './weights.js';
import { createTestRegistry, giveHand, landDef, putOnBattlefield } from './test-support.js';

const SEED = 20260819;

/** Clone: a 0/0 whose only text is the copy clause — the printed card exactly. */
const CLONE: CardDefinition = {
  id: 'pilot-clone',
  name: 'Pilot Clone',
  types: ['creature'],
  cost: { generic: 2, U: 2 },
  power: 0,
  toughness: 0,
  copyAsEnters: { filter: { anyOfTypes: ['creature'] } },
};

const BIG: CardDefinition = {
  id: 'pilot-big',
  name: 'Printed Giant',
  types: ['creature'],
  cost: { generic: 3, G: 1 },
  power: 4,
  toughness: 4,
};

const SMALL: CardDefinition = {
  id: 'pilot-small',
  name: 'Printed Rat',
  types: ['creature'],
  cost: { B: 1 },
  power: 1,
  toughness: 1,
};

function board(): GameState {
  const registry = createTestRegistry();
  const land = landDef('Island', 'U');
  const { state } = createGame({
    seed: SEED,
    decks: { A: { cards: Array.from({ length: 30 }, () => land) }, B: { cards: Array.from({ length: 30 }, () => land) } },
    registry,
  });
  state.step = 'precombatMain';
  state.activePlayer = 'A';
  state.priorityPlayer = 'A';
  state.stack = [];
  state.players.A.hand = [];
  state.players.B.hand = [];
  state.players.A.manaPool = { W: 9, U: 9, B: 9, R: 9, G: 9, C: 9 };
  return state;
}

/**
 * Cast the Clone with the real heuristic pilot and let IT answer the as-enters
 * question. Returns the resolved permanent's name — the whole point of the
 * decision, in one string.
 */
function pilotCopiesInto(state: GameState): string {
  const registry = createTestRegistry();
  const pilot = createHeuristicPilot();
  const rng = createRng(SEED);
  const [card] = giveHand(state, 'A', [CLONE]);
  const cloneId = card!.instanceId;

  let next = applyAction(state, { kind: 'castSpell', player: 'A', instanceId: cloneId }, undefined, registry).state;
  for (const player of ['A', 'B'] as const) {
    next = applyAction(next, { kind: 'passPriority', player }, undefined, registry).state;
  }
  const choice = next.pendingChoice;
  expect(choice, 'the pilot should have been asked which permanent to copy').toBeTruthy();

  // THE REAL PILOT answers — not a hand-built answer. A policy that is only
  // correct when a test writes the answer for it is not a policy.
  const action = pilot.chooseAction({
    view: next,
    legalActions: [{ kind: 'answerChoice', player: 'A', choiceId: choice!.id, answer: { kind: 'confirm', yes: false } }],
    rng,
    registry,
  });
  next = applyAction(next, action, undefined, registry).state;

  const resolved =
    next.battlefield.find((c) => c.instanceId === cloneId) ??
    next.players.A.graveyard.find((c) => c.instanceId === cloneId);
  return resolved?.def.name ?? '(gone)';
}

describe('copyTargetValue — the ruler, on printed characteristics only', () => {
  it('ranks a bigger printed body above a smaller one', () => {
    expect(copyTargetValue(BIG, DEFAULT_HEURISTIC_WEIGHTS)).toBeGreaterThan(copyTargetValue(SMALL, DEFAULT_HEURISTIC_WEIGHTS));
  });

  it('ranks an ability and a keyword above a bare body of the same size', () => {
    const bare: CardDefinition = { ...SMALL, id: 'bare' };
    const flier: CardDefinition = { ...SMALL, id: 'flier', keywords: { flying: true } };
    const useful: CardDefinition = {
      ...SMALL,
      id: 'useful',
      triggers: [
        // No `id` here: TriggeredAbility has no such field, so the key this once
        // carried was inert — the label is the human-readable handle.
        { label: 'draw', condition: { on: 'upkeep' }, effects: [{ primitive: 'drawCards', params: { count: 1 } }] },
      ],
    };
    expect(copyTargetValue(flier, DEFAULT_HEURISTIC_WEIGHTS)).toBeGreaterThan(copyTargetValue(bare, DEFAULT_HEURISTIC_WEIGHTS));
    expect(copyTargetValue(useful, DEFAULT_HEURISTIC_WEIGHTS)).toBeGreaterThan(copyTargetValue(bare, DEFAULT_HEURISTIC_WEIGHTS));
  });

  it('scores a Clone own blank body at zero, so any real permanent beats it', () => {
    expect(copyTargetValue(CLONE, DEFAULT_HEURISTIC_WEIGHTS)).toBe(0);
    expect(copyTargetValue(SMALL, DEFAULT_HEURISTIC_WEIGHTS)).toBeGreaterThan(0);
  });

  it('values a land that taps for mana above one that does nothing', () => {
    const blank: CardDefinition = { id: 'blank-land', name: 'Blank', types: ['land'] };
    expect(copyTargetValue(landDef('Island', 'U'), DEFAULT_HEURISTIC_WEIGHTS)).toBeGreaterThan(
      copyTargetValue(blank, DEFAULT_HEURISTIC_WEIGHTS),
    );
  });
});

describe('the heuristic pilot playing a real Clone', () => {
  it('copies the BEST creature on the board, not the first or the worst', () => {
    const state = board();
    // Offered in worst-first order deliberately: a pilot that takes the first
    // candidate, or that takes the smallest legal selection, fails here.
    putOnBattlefield(state, 'A', [SMALL]);
    putOnBattlefield(state, 'B', [BIG]);
    expect(pilotCopiesInto(state)).toBe('Printed Giant');
  });

  it('copies the PRINTED 4/4 over a 1/1 wearing counters that make it a 4/4', () => {
    const state = board();
    // THE LAYER-1 TEST, from the pilot's side. The Rat is effectively a 4/4 on
    // this board; copying it yields a 1/1, because counters are layer 7d and
    // stay with the Rat. The pilot must read the COPIABLE values.
    const [rat] = putOnBattlefield(state, 'B', [SMALL]);
    rat!.counters = { '+1/+1': 3 };
    putOnBattlefield(state, 'A', [BIG]);
    expect(pilotCopiesInto(state)).toBe('Printed Giant');
  });

  it('takes the copy rather than declining into a 0/0 that dies on arrival', () => {
    const state = board();
    putOnBattlefield(state, 'B', [SMALL]);
    // Only one candidate, and it is small — the pilot must still take it: a
    // declined Clone is a 0/0 in the graveyard before anyone gets priority.
    expect(pilotCopiesInto(state)).toBe('Printed Rat');
  });
});
