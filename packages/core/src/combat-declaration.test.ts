/**
 * Combat DECLARATION tests — the step must end even when nobody attacks or blocks.
 *
 * The bug these pin: "have attackers been declared?" was inferred from whether the
 * attacker list was non-empty. But declaring *no* attackers (or no blockers) is a
 * legal, routine choice, so an empty declaration left the game looking like the
 * step hadn't happened. It could then be declared again — and again — and because
 * declaring resets the consecutive-pass counter, the step could NEVER advance.
 *
 * A pilot that passes by convention never noticed. A pilot that *searches* its
 * options walks straight into it: the MCTS pilot span a single declare-blockers
 * step 240+ times, and a game that should finish in ~740 actions never got past
 * turn 5. Emptiness is not a proxy for "not yet declared".
 */

import { describe, expect, it } from 'vitest';
import {
  applyAction,
  createGame,
  DEFAULT_RULES,
  generateLegalActions,
  type GameAction,
  type GameState,
} from './index.js';
import { createEffectRegistry } from './effects.js';
import { creatureDef, deckOf, landDef } from './test-fixtures.js';

const ISLAND = landDef('Island', 'U');
const registry = createEffectRegistry();

function lib(): ReturnType<typeof deckOf> {
  return deckOf(ISLAND, 40);
}

function act(state: GameState, action: GameAction): GameState {
  const r = applyAction(state, action, DEFAULT_RULES, registry);
  const rejected = r.events.find((e) => e.type === 'actionRejected');
  if (rejected) throw new Error(`unexpected rejection: ${(rejected as { reason: string }).reason}`);
  return r.state;
}

function rejectionOf(state: GameState, action: GameAction): string | undefined {
  const r = applyAction(state, action, DEFAULT_RULES, registry);
  const rejected = r.events.find((e) => e.type === 'actionRejected');
  return rejected ? (rejected as { reason: string }).reason : undefined;
}

function pass(state: GameState): GameState {
  return act(state, { kind: 'passPriority', player: state.priorityPlayer });
}

function advanceToStep(state: GameState, target: string, max = 400): GameState {
  let s = state;
  let guard = 0;
  while (s.step !== target && !s.gameOver && guard++ < max) s = pass(s);
  return s;
}

/** The defending player — the non-active one. Priority may sit with the attacker. */
function defenderOf(state: GameState): 'A' | 'B' {
  return state.activePlayer === 'A' ? 'B' : 'A';
}

/** A game where A has a creature able to attack, sitting in declare-attackers. */
function atDeclareAttackers(seed: number): GameState {
  const { state } = createGame({ seed, decks: { A: lib(), B: lib() }, registry });
  state.battlefield.push({
    instanceId: state.nextInstanceId++,
    def: creatureDef('Bear', 2, 2),
    controller: 'A',
    owner: 'A',
    zone: 'battlefield',
    tapped: false,
    summoningSick: false,
    damageMarked: 0,
    markedByDeathtouch: false,
    counters: {},
  });
  return advanceToStep(state, 'declareAttackers');
}

describe('declaring NO attackers still counts as declaring', () => {
  it('marks the declaration done and stops offering it', () => {
    const s = atDeclareAttackers(1);
    expect(generateLegalActions(s).some((a) => a.kind === 'declareAttackers')).toBe(true);

    const after = act(s, { kind: 'declareAttackers', player: 'A', attackers: [] });
    expect(after.combat?.attackersDeclared).toBe(true);
    expect(after.combat?.attackers).toEqual([]);
    // The action must NOT be on the table again — that re-offer was the loop.
    expect(generateLegalActions(after).some((a) => a.kind === 'declareAttackers')).toBe(false);
  });

  it('rejects a second declaration', () => {
    const s = atDeclareAttackers(2);
    const after = act(s, { kind: 'declareAttackers', player: 'A', attackers: [] });
    expect(rejectionOf(after, { kind: 'declareAttackers', player: 'A', attackers: [] })).toMatch(
      /already declared/i,
    );
  });
});

describe('declaring NO blockers still counts as declaring', () => {
  /** A game in declare-blockers with A attacking and the DEFENDER holding priority. */
  function atDeclareBlockers(seed: number): GameState {
    let s = atDeclareAttackers(seed);
    const bear = s.battlefield.find((c) => c.controller === 'A')!;
    s = act(s, { kind: 'declareAttackers', player: 'A', attackers: [bear.instanceId] });
    s = advanceToStep(s, 'declareBlockers');
    // The step opens with the attacker holding priority; the declaration is the
    // defender's to make, so hand priority over before we test the offer.
    if (s.priorityPlayer !== defenderOf(s)) s = pass(s);
    return s;
  }

  it('marks the declaration done and stops offering it', () => {
    const s = atDeclareBlockers(3);
    expect(generateLegalActions(s).some((a) => a.kind === 'declareBlockers')).toBe(true);

    const after = act(s, { kind: 'declareBlockers', player: defenderOf(s), blocks: [] });
    expect(after.combat?.blockersDeclared).toBe(true);
    expect(generateLegalActions(after).some((a) => a.kind === 'declareBlockers')).toBe(false);
  });

  it('rejects a second declaration', () => {
    const s = atDeclareBlockers(4);
    const defender = defenderOf(s);
    const after = act(s, { kind: 'declareBlockers', player: defender, blocks: [] });
    expect(rejectionOf(after, { kind: 'declareBlockers', player: defender, blocks: [] })).toMatch(
      /already declared/i,
    );
  });

  it('REGRESSION: an empty block declaration does not trap the step forever', () => {
    let s = atDeclareBlockers(5);
    s = act(s, { kind: 'declareBlockers', player: defenderOf(s), blocks: [] });

    // Passing from here must reach the damage step. Before the fix the defender
    // could re-declare indefinitely and this loop never escaped declare-blockers.
    let guard = 0;
    while (s.step === 'declareBlockers' && !s.gameOver && guard++ < 50) s = pass(s);
    expect(s.step).not.toBe('declareBlockers');
  });
});

describe('a full game of empty declarations still terminates', () => {
  it('reaches a later turn instead of spinning in combat', () => {
    // Both players always take the FIRST offered action, preferring declarations —
    // the adversarial shape of a searching pilot. This must still make progress.
    const { state } = createGame({ seed: 9, decks: { A: lib(), B: lib() }, registry });
    let s = state;
    for (let i = 0; i < 1500 && !s.gameOver; i++) {
      const legal = generateLegalActions(s);
      if (legal.length === 0) break;
      const declare = legal.find((a) => a.kind === 'declareBlockers' || a.kind === 'declareAttackers');
      s = applyAction(s, declare ?? (legal[0] as GameAction), DEFAULT_RULES, registry).state;
    }
    // 1500 actions of a real game is many turns; the old engine stalled on turn 5.
    expect(s.turnNumber).toBeGreaterThan(8);
  });
});
