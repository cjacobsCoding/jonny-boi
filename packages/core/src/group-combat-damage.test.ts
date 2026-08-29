/**
 * "WHENEVER ONE OR MORE CREATURES YOU CONTROL DEAL COMBAT DAMAGE TO A PLAYER"
 * — the GROUP combat-damage trigger (Professional Face-Breaker, Spiteful
 * Banditry's mirror).
 *
 * The fidelity edge is the words "one or more": the ability fires ONCE per
 * damage batch however many creatures connected. A per-creature firing would
 * make every multi-attack strictly better than printed (three Treasures off
 * three attackers where the card makes one), which is exactly the inflation
 * the runtime's per-batch dedup exists to stop.
 */

import { describe, expect, it } from 'vitest';
import {
  applyAction,
  createGame,
  DEFAULT_RULES,
  type CardDefinition,
  type GameAction,
  type GameState,
  type InstanceId,
  type PlayerId,
  defaultAnswerFor,
} from './index.js';
import { createEffectRegistry, type EffectRegistry } from './effects.js';
import { creatureDef, deckOf, landDef } from './test-fixtures.js';

const ISLAND = landDef('Island', 'U');

/** How many times the watched trigger actually RESOLVED, per test run. */
function harness(): { reg: EffectRegistry; fired: number[] } {
  const fired: number[] = [];
  const reg = createEffectRegistry();
  reg.register('testMarkFired', () => {
    fired.push(1);
  });
  return { reg, fired };
}

/** An enchantment carrying the group trigger, watching its controller's creatures. */
const FACE_BREAKER_WATCHER: CardDefinition = {
  id: 'group-watcher',
  name: 'Group Watcher',
  types: ['enchantment'],
  triggers: [
    {
      condition: { on: 'groupCombatDamageToPlayer' },
      effects: [{ primitive: 'testMarkFired' }],
      label: 'Your creatures deal combat damage to a player: mark',
    },
  ],
};

function act(state: GameState, action: GameAction, reg: EffectRegistry): GameState {
  const r = applyAction(state, action, DEFAULT_RULES, reg);
  const rejected = r.events.find((e) => e.type === 'actionRejected');
  if (rejected) throw new Error(`unexpected rejection: ${(rejected as { reason: string }).reason}`);
  return r.state;
}

function pass(state: GameState, reg: EffectRegistry): GameState {
  const q = state.pendingChoice;
  if (q) {
    return act(state, { kind: 'answerChoice', player: q.chooser, choiceId: q.id, answer: defaultAnswerFor(q) }, reg);
  }
  return act(state, { kind: 'passPriority', player: state.priorityPlayer }, reg);
}

function advanceToStep(state: GameState, target: string, reg: EffectRegistry, max = 400): GameState {
  let s = state;
  let g = 0;
  while (s.step !== target && !s.gameOver && g++ < max) s = pass(s, reg);
  return s;
}

function setup(
  reg: EffectRegistry,
  attackerCount: number,
  watcherController: PlayerId,
): { state: GameState; attackerIds: InstanceId[] } {
  const g = createGame({ seed: 21, decks: { A: deckOf(ISLAND, 40), B: deckOf(ISLAND, 40) }, registry: reg });
  const state = g.state;
  let nextId = state.nextInstanceId;
  const place = (def: CardDefinition, controller: PlayerId): InstanceId => {
    const id = nextId++;
    state.battlefield.push({
      instanceId: id,
      def,
      controller,
      owner: controller,
      zone: 'battlefield',
      tapped: false,
      summoningSick: false,
      damageMarked: 0,
      markedByDeathtouch: false,
      counters: {},
    });
    return id;
  };
  place(FACE_BREAKER_WATCHER, watcherController);
  const attackerIds = Array.from({ length: attackerCount }, (_, i) =>
    place(creatureDef(`Att${i}`, 2, 2), 'A'),
  );
  state.nextInstanceId = nextId;
  return { state: advanceToStep(state, 'declareAttackers', reg), attackerIds };
}

function runUnblockedCombat(state: GameState, attackerIds: readonly InstanceId[], reg: EffectRegistry): GameState {
  let s = act(state, { kind: 'declareAttackers', player: 'A', attackers: [...attackerIds] }, reg);
  s = advanceToStep(s, 'declareBlockers', reg);
  s = act(s, { kind: 'declareBlockers', player: 'B', blocks: [] }, reg);
  return advanceToStep(s, 'postcombatMain', reg);
}

describe('the group combat-damage trigger fires once per batch', () => {
  it('THREE unblocked attackers → the trigger resolves exactly ONCE', () => {
    const { reg, fired } = harness();
    const { state, attackerIds } = setup(reg, 3, 'A');
    const s = runUnblockedCombat(state, attackerIds, reg);
    expect(s.players.B.life).toBe(DEFAULT_RULES.startingLife - 6);
    expect(fired.length).toBe(1);
  });

  it('one attacker → once; and the OPPONENT’s copy of the ability never fires', () => {
    const { reg, fired } = harness();
    // The watcher is B's: A's attackers are not "creatures YOU control" to it.
    const { state, attackerIds } = setup(reg, 1, 'B');
    runUnblockedCombat(state, attackerIds, reg);
    expect(fired.length).toBe(0);
  });
});
