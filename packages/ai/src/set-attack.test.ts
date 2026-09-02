/**
 * BLOCKERS ARE A SHARED RESOURCE (§3.83).
 *
 * `attackIsProfitable` judges every attacker INDEPENDENTLY, against the full set
 * of enemy blockers — as though each one could be met by all of them. That is true
 * of the first attacker and false of every one after: a defender with one body
 * cannot answer four attackers, however badly each of them fares alone.
 *
 * Measured head-to-head against the pilot exactly as it was
 * (`packages/sim/bench/feature-ab.mjs --feature setAttack`, 9 decks × both
 * orientations, run on TWO independent seed sets as §3.82 now requires):
 * **58 ahead / 21 behind (p = 5.1e-5)** and **60 ahead / 23 behind (p = 7.8e-5)**
 * — CONFIRMED STRONGER, the same direction and magnitude on both.
 *
 * The tests below pin the two halves of the rule: it sends the bodies the defence
 * cannot answer, and it does NOT send them when the arithmetic does not close.
 */

import { describe, expect, it } from 'vitest';
import type { CardDefinition, GameAction, GameState } from '@jonny-boi/core';
import { createGame, DEFAULT_RULES, generateLegalActions } from '@jonny-boi/core';
import { createHeuristicPilot } from './heuristic.js';
import { creatureDef, landDef } from './test-support.js';

const BEAR: CardDefinition = creatureDef('bear', 2, 2);
const WALL: CardDefinition = creatureDef('wall', 4, 4);
const FOREST: CardDefinition = landDef('forest', 'G');

/** A board at the declare-attackers step, with the given creatures in play. */
function boardAtCombat(mine: readonly CardDefinition[], theirs: readonly CardDefinition[], theirLife: number): GameState {
  const { state } = createGame({
    seed: 5,
    startingPlayer: 'A',
    decks: {
      A: { cards: Array.from({ length: 20 }, () => FOREST) },
      B: { cards: Array.from({ length: 20 }, () => FOREST) },
    },
  });
  const place = (def: CardDefinition, controller: 'A' | 'B') => {
    state.battlefield.push({
      instanceId: state.nextInstanceId++,
      def,
      controller,
      owner: controller,
      zone: 'battlefield',
      tapped: false,
      summoningSick: false,
      damageMarked: 0,
      markedByDeathtouch: false,
      counters: {},
    } as never);
  };
  for (const def of mine) place(def, 'A');
  for (const def of theirs) place(def, 'B');
  state.players.B.life = theirLife;
  state.step = 'declareAttackers';
  state.activePlayer = 'A';
  state.priorityPlayer = 'A';
  // ⚠️ `combat` MUST BE INITIALISED or the engine offers no `declareAttackers` at
  // all — the menu is just a pass, every arm "declines to attack", and the test
  // passes while proving nothing.
  state.combat = { attackers: [], blocks: {}, attackersDeclared: false, blockersDeclared: false };
  return state;
}

function attackChosenBy(state: GameState, setAttack: boolean): GameAction {
  // `alphaStrike` is off throughout: these boards are deliberately NOT lethal, so
  // it would not fire anyway, and pinning it off keeps this test about one rule.
  const pilot = createHeuristicPilot(undefined, { setAttack, alphaStrike: false });
  const legalActions = generateLegalActions(state, DEFAULT_RULES);
  // The board must really be able to attack, or "it declined" is meaningless.
  expect(legalActions.some((a) => a.kind === 'declareAttackers')).toBe(true);
  return pilot.chooseAction({
    view: state,
    legalActions,
    rng: { next: () => 0.5 } as never,
    registry: undefined as never,
    rulesConfig: DEFAULT_RULES,
    observer: undefined,
  });
}

const attackerCount = (action: GameAction): number =>
  action.kind === 'declareAttackers'
    ? (action as Extract<GameAction, { kind: 'declareAttackers' }>).attackers.length
    : 0;

describe('the pilot counts the defence, not just the attacker', () => {
  it('sends the bodies one blocker cannot answer', () => {
    // Four 2/2s into one 4/4, opponent at 20 — nowhere near lethal, so this is
    // about value alone. Each bear alone loses to the wall, so the per-attacker
    // rule declines all four. But the wall blocks ONE: three connect for six, and
    // one 2/2 is lost. Six damage for a bear is a trade worth making.
    const state = boardAtCombat([BEAR, BEAR, BEAR, BEAR], [WALL], 20);
    expect(attackerCount(attackChosenBy(state, true))).toBe(4);
  });

  it('is exactly the attack the per-attacker rule refused', () => {
    // The control: same board, same pilot, the rule off. Without it, every bear is
    // judged against a wall that is somehow free to block all of them.
    const state = boardAtCombat([BEAR, BEAR, BEAR, BEAR], [WALL], 20);
    expect(attackChosenBy(state, false).kind).toBe('passPriority');
  });

  it('does NOT send a lone attacker into a blocker that eats it', () => {
    // One 2/2 into one 4/4: the wall has a body for it, the bear dies, and nothing
    // gets through. The set rule must reach the same answer as the old one here —
    // it is not an excuse to attack, it is a way to count.
    const state = boardAtCombat([BEAR], [WALL], 20);
    expect(attackChosenBy(state, true).kind).toBe('passPriority');
  });

  it('still declines when every attacker has a blocker waiting', () => {
    // Two 2/2s into two 4/4s: the defence has a body for each, so there is no
    // surplus to exploit and both bears would simply die.
    const state = boardAtCombat([BEAR, BEAR], [WALL, WALL], 20);
    expect(attackChosenBy(state, true).kind).toBe('passPriority');
  });

  it('sends everything when the defence has no blockers at all', () => {
    // The degenerate case the refiner deliberately skips (nothing to assign) — it
    // must still come out attacking, via the per-attacker rule that already
    // handles it. A regression here would mean the skip swallowed the attack.
    const state = boardAtCombat([BEAR, BEAR], [], 20);
    expect(attackerCount(attackChosenBy(state, true))).toBe(2);
  });
});
