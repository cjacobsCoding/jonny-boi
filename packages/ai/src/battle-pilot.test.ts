/**
 * The pilot vs battles — the "no inert features" half of the battle system.
 *
 * A battle no pilot ever attacks is a card that sits on the table forever, which
 * would make every A/B verdict involving one meaningless. These pin the
 * behaviours that make battles REAL in a sim:
 *   1. the pilot diverts enough power to DEFEAT a battle it can finish;
 *   2. it finds the battle by who PROTECTS it, not by who controls it — the
 *     printed pattern is attacking your OWN Siege, which a controller-based
 *     search would never even consider;
 *   3. it does NOT chip a battle it cannot finish (chip damage on a battle buys
 *      literally nothing — the reward only pays on the last counter);
 *   4. lethal on the player still beats any battle.
 */

import { describe, expect, it } from 'vitest';
import {
  applyAction,
  createGame,
  createRng,
  DEFENSE_COUNTER,
  generateLegalActions,
  LOYALTY_COUNTER,
  type CardDefinition,
  type CardInstance,
  type DeckList,
  type GameAction,
  type GameState,
  type PlayerId,
} from '@jonny-boi/core';
import { createHeuristicPilot } from './heuristic.js';
import { creatureDef, landDef, putOnBattlefield } from './test-support.js';

function stubDeck(): DeckList {
  return { cards: Array.from({ length: 30 }, (_, i) => landDef(`L${i}`, 'R')) };
}

function freshGame(seed = 1): GameState {
  const { state } = createGame({ seed, decks: { A: stubDeck(), B: stubDeck() } });
  return state;
}

function intoDeclareAttackers(state: GameState): void {
  state.step = 'declareAttackers';
  state.activePlayer = 'A';
  state.priorityPlayer = 'A';
  state.combat = { attackers: [], blocks: {}, attackersDeclared: false, blockersDeclared: false };
}

function battleDef(id: string, defense: number): CardDefinition {
  return { id, name: id, types: ['battle'], subtypes: ['siege'], defense };
}

function walkerDef(id: string, loyalty: number): CardDefinition {
  return { id, name: id, types: ['planeswalker'], loyalty };
}

/** Put a battle onto the battlefield carrying its defense counters. */
function putBattle(
  state: GameState,
  controller: PlayerId,
  def: CardDefinition,
  defense?: number,
): CardInstance {
  const [inst] = putOnBattlefield(state, controller, [def]);
  inst!.counters = { [DEFENSE_COUNTER]: defense ?? def.defense ?? 0 };
  return inst!;
}

function putWalker(
  state: GameState,
  controller: PlayerId,
  def: CardDefinition,
  loyalty?: number,
): CardInstance {
  const [inst] = putOnBattlefield(state, controller, [def]);
  inst!.counters = { [LOYALTY_COUNTER]: loyalty ?? def.loyalty ?? 0 };
  return inst!;
}

const pilot = createHeuristicPilot();
const rng = () => createRng(99);

function choose(state: GameState): GameAction {
  const legal = generateLegalActions(state);
  return pilot.chooseAction({ view: state, legalActions: legal, rng: rng() });
}

describe('heuristic pilot — attacks battles', () => {
  it('diverts enough attackers to DEFEAT a battle it can finish', () => {
    // A controls the Siege, so B protects it, so A attacks it — the printed
    // pattern. A controller-based search would look at B's permanents, find
    // nothing, and leave the battle standing forever.
    const state = freshGame(2);
    intoDeclareAttackers(state);
    const battle = putBattle(state, 'A', battleDef('My Siege', 3));
    const [big, small] = putOnBattlefield(state, 'A', [
      creatureDef('Ogre', 4, 4),
      creatureDef('Goblin', 1, 1),
    ]);
    const action = choose(state);
    expect(action.kind).toBe('declareAttackers');
    if (action.kind === 'declareAttackers') {
      // Both profitable attackers swing; the big one covers the 3 defense alone
      // and the small one keeps hitting the face.
      expect([...action.attackers].sort()).toEqual([big!.instanceId, small!.instanceId].sort());
      expect(action.attackTargets).toEqual({ [big!.instanceId]: battle.instanceId });
    }
  });

  it('does NOT chip a battle it cannot finish', () => {
    // 2 power against 8 defense. Chip damage on a battle is strictly worse than
    // face damage: the reward pays only when the LAST counter comes off, so a
    // partial attack trades real damage for nothing at all.
    const state = freshGame(3);
    intoDeclareAttackers(state);
    putBattle(state, 'A', battleDef('Big Siege', 8));
    putOnBattlefield(state, 'A', [creatureDef('Bear', 2, 2)]);
    const action = choose(state);
    expect(action.kind).toBe('declareAttackers');
    if (action.kind === 'declareAttackers') {
      expect(action.attackTargets).toBeUndefined();
    }
  });

  it('goes all-in on the player when the attack is lethal, battle or no battle', () => {
    const state = freshGame(4);
    intoDeclareAttackers(state);
    putBattle(state, 'A', battleDef('My Siege', 3));
    state.players.B.life = 4;
    putOnBattlefield(state, 'A', [creatureDef('Ogre', 5, 5)]);
    const action = choose(state);
    expect(action.kind).toBe('declareAttackers');
    if (action.kind === 'declareAttackers') {
      expect(action.attackTargets).toBeUndefined();
    }
  });

  it('does not attack a battle the DEFENDING player does not protect', () => {
    // B controls this Siege, so A protects it — A cannot legally attack it, and
    // the pilot must not propose an action the engine would reject.
    const state = freshGame(5);
    intoDeclareAttackers(state);
    putBattle(state, 'B', battleDef('Their Siege', 2));
    putOnBattlefield(state, 'A', [creatureDef('Ogre', 4, 4)]);
    const action = choose(state);
    expect(action.kind).toBe('declareAttackers');
    if (action.kind === 'declareAttackers') {
      expect(action.attackTargets).toBeUndefined();
    }
  });

  it('prefers the higher-value object when a walker and a battle compete', () => {
    // Both finishable by the same attacker, so they compete for one budget of
    // power. A walker generates value every turn it lives; a battle just sits
    // there — so at equal counters the walker is the better diversion, and the
    // weights say so rather than the code hard-coding a preference.
    const state = freshGame(6);
    intoDeclareAttackers(state);
    const walker = putWalker(state, 'B', walkerDef('Enemy Walker', 3));
    putBattle(state, 'A', battleDef('My Siege', 3));
    const [ogre] = putOnBattlefield(state, 'A', [creatureDef('Ogre', 4, 4)]);
    const action = choose(state);
    expect(action.kind).toBe('declareAttackers');
    if (action.kind === 'declareAttackers') {
      expect(action.attackTargets).toEqual({ [ogre!.instanceId]: walker.instanceId });
    }
  });

  it('attacks the battle when there is no walker to prefer', () => {
    // The same board minus the walker: the diversion must still happen, or the
    // "prefers the walker" test above would pass for the wrong reason (a pilot
    // that never diverts to battles at all).
    const state = freshGame(7);
    intoDeclareAttackers(state);
    const battle = putBattle(state, 'A', battleDef('My Siege', 3));
    const [ogre] = putOnBattlefield(state, 'A', [creatureDef('Ogre', 4, 4)]);
    const action = choose(state);
    expect(action.kind).toBe('declareAttackers');
    if (action.kind === 'declareAttackers') {
      expect(action.attackTargets).toEqual({ [ogre!.instanceId]: battle.instanceId });
    }
  });

  it('the engine ACCEPTS the attack the pilot proposes', () => {
    // The end-to-end check that matters: a plan the engine rejects is the same
    // as no plan at all, and a pilot test asserting only on its own output
    // cannot tell the two apart.
    const state = freshGame(8);
    intoDeclareAttackers(state);
    const battle = putBattle(state, 'A', battleDef('My Siege', 3));
    putOnBattlefield(state, 'A', [creatureDef('Ogre', 4, 4)]);
    const action = choose(state);
    const result = applyAction(state, action);
    expect(result.events.some((e) => e.type === 'actionRejected')).toBe(false);
    expect(result.state.combat?.attackTargets).toBeDefined();
    expect(Object.values(result.state.combat!.attackTargets!)).toContain(battle.instanceId);
  });
});
