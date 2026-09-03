/**
 * THE §3.108 BLOCKING SWITCH, PINNED (on and off).
 *
 *   gangBlock — two blockers kill an attacker neither could meet alone, and a
 *               menace attacker is blockable at all (ships ON: held-out 85/50 on
 *               the heuristic, 110/45 on lookahead).
 *
 * Two siblings were measured and deleted with their tests: `clockChump` (chump
 * by the opponent's proven crack-back rather than a fixed life total) was
 * CONFIRMED WEAKER, and `persistPricing` (a persisting body's death priced as
 * the counter it returns with) did not replicate on a fresh battery. DESIGN
 * §3.108 keeps the numbers.
 *
 * Every board here is checked to REALLY offer the decision (the engine's menu
 * contains the declaration) before the pilot is asked, because "it declined"
 * and "it was never offered" are the same observation otherwise (§3.4f).
 */

import { describe, expect, it } from 'vitest';
import type { CardDefinition, GameAction, GameState, InstanceId } from '@jonny-boi/core';
import { createGame, DEFAULT_RULES, generateLegalActions } from '@jonny-boi/core';
import { createHeuristicPilot, type HeuristicFeatures } from './heuristic.js';
import { creatureDef, landDef, putOnBattlefield } from './test-support.js';

const FOREST = landDef('forest', 'G');

/** B attacks A with `attackers`; A holds `blockers`, untapped, and is deciding blocks. */
function blockBoard(
  attackers: readonly CardDefinition[],
  blockers: readonly CardDefinition[],
  opts: { myLife?: number } = {},
): { state: GameState; attackerIds: InstanceId[]; blockerIds: InstanceId[] } {
  const { state } = createGame({
    seed: 11,
    startingPlayer: 'B',
    decks: {
      A: { cards: Array.from({ length: 20 }, () => FOREST) },
      B: { cards: Array.from({ length: 20 }, () => FOREST) },
    },
  });
  const placed = putOnBattlefield(state, 'B', attackers);
  for (const inst of placed) inst.tapped = true; // they attacked
  const mine = putOnBattlefield(state, 'A', blockers);
  state.players.A.life = opts.myLife ?? 20;
  state.step = 'declareBlockers';
  state.activePlayer = 'B';
  state.priorityPlayer = 'A';
  state.combat = {
    attackers: placed.map((c) => c.instanceId),
    blocks: {},
    attackersDeclared: true,
    blockersDeclared: false,
  };
  return { state, attackerIds: placed.map((c) => c.instanceId), blockerIds: mine.map((c) => c.instanceId) };
}

function blocksChosen(state: GameState, features: HeuristicFeatures): GameAction {
  const pilot = createHeuristicPilot(undefined, features);
  const legalActions = generateLegalActions(state, DEFAULT_RULES);
  expect(legalActions.some((a) => a.kind === 'declareBlockers')).toBe(true);
  return pilot.chooseAction({
    view: state,
    legalActions,
    rng: { next: () => 0.5 } as never,
    registry: undefined as never,
    rulesConfig: DEFAULT_RULES,
    observer: undefined,
  });
}

const blockList = (action: GameAction) =>
  action.kind === 'declareBlockers' ? (action as Extract<GameAction, { kind: 'declareBlockers' }>).blocks : [];

describe('gangBlock — two bodies where one is not enough', () => {
  it('double-blocks a 5/5 with two 3/3s and kills it, losing one', () => {
    // 3 + 3 = 6 ≥ 5: it dies. It assigns 3 to the first 3/3 (dies) and 2 to the
    // second (lives). Ten stats for six — a trade the single-block rule could
    // not see (each 3/3 alone just dies to it), and the control below refuses.
    const { state, attackerIds } = blockBoard([creatureDef('wurm', 5, 5)], [creatureDef('bear', 3, 3), creatureDef('bear2', 3, 3)]);
    const blocks = blockList(blocksChosen(state, { gangBlock: true }));
    expect(blocks).toHaveLength(2);
    expect(blocks.every((b) => b.attacker === attackerIds[0])).toBe(true);
    expect(blocksChosen(state, { gangBlock: false }).kind).toBe('passPriority');
  });

  it('does not double-chump: two 1/1s that cannot kill a 5/5 stay home', () => {
    const { state } = blockBoard([creatureDef('wurm', 5, 5)], [creatureDef('m1', 1, 1), creatureDef('m2', 1, 1)]);
    expect(blocksChosen(state, { gangBlock: true }).kind).toBe('passPriority');
  });

  it('blocks a menace attacker with a pair, which one blocker never legally could', () => {
    // A 4/4 menace into two 2/2s at 20 life: 2 + 2 kills it, it kills both. An
    // even trade at `blockValueThreshold` 0, and the ONLY legal block there is.
    const { state, attackerIds } = blockBoard(
      [creatureDef('menacer', 4, 4, { keywords: { menace: true } })],
      [creatureDef('b1', 2, 2), creatureDef('b2', 2, 2)],
    );
    const blocks = blockList(blocksChosen(state, { gangBlock: true }));
    expect(blocks).toHaveLength(2);
    expect(blocks.every((b) => b.attacker === attackerIds[0])).toBe(true);
    expect(blocksChosen(state, { gangBlock: false }).kind).toBe('passPriority');
  });

  it('leaves a first-striking attacker to the single-block rule', () => {
    // Two 3/3s would die to a 5/5 first-striker before striking back; the pair
    // pricing does not model that step and must not pretend to.
    const { state } = blockBoard(
      [creatureDef('knight', 5, 5, { keywords: { firstStrike: true } })],
      [creatureDef('bear', 3, 3), creatureDef('bear2', 3, 3)],
    );
    expect(blocksChosen(state, { gangBlock: true }).kind).toBe('passPriority');
  });
});
