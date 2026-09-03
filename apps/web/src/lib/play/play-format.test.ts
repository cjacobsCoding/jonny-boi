/**
 * The hotseat log's new lines (§3.119) — each pinned to the report that asked
 * for it, and driven through the REAL engine so the event shapes are the ones
 * the engine emits rather than ones this test invented (TESTING.md rule 1).
 */
import { describe, expect, it } from 'vitest';
import { buildRegistry, loadCardPool } from '@jonny-boi/cards';
import {
  applyAction,
  createGame,
  DEFAULT_RULES,
  type CardDefinition,
  type CardInstance,
  type GameEvent,
  type GameState,
  type PlayerId,
} from '@jonny-boi/core';
import { describeEvents, type LogResolvers } from './play-format.js';

const pool = loadCardPool({ onWarn: () => {} });
const registry = buildRegistry();
const NAMES: Readonly<Record<PlayerId, string>> = { A: 'Player 1', B: 'Computer' };

function card(name: string): CardDefinition {
  const found = pool.getByName(name);
  if (!found) throw new Error(`no pool card named "${name}"`);
  return found;
}

function put(state: GameState, def: CardDefinition, controller: PlayerId, zone: CardInstance['zone']): CardInstance {
  const inst: CardInstance = {
    instanceId: state.nextInstanceId++,
    def,
    controller,
    owner: controller,
    zone,
    tapped: false,
    summoningSick: false,
    damageMarked: 0,
    markedByDeathtouch: false,
    counters: {},
  };
  if (zone === 'battlefield') state.battlefield.push(inst);
  else if (zone === 'hand') state.players[controller].hand.push(inst);
  return inst;
}

function resolvers(state: GameState): LogResolvers {
  return {
    name: (id) => {
      for (const zone of [state.battlefield, state.players.A.hand, state.players.B.hand, state.players.A.library, state.players.B.library]) {
        const hit = zone.find((c) => c.instanceId === id);
        if (hit) return hit.def.name;
      }
      return `#${id}`;
    },
    playerName: (p) => NAMES[p],
  };
}

/** A fresh game at the given step, both hands empty. */
function gameAt(step: GameState['step']): GameState {
  const forest = card('Forest');
  let state = createGame({
    seed: 11,
    decks: {
      A: { cards: Array.from({ length: 40 }, () => forest) },
      B: { cards: Array.from({ length: 40 }, () => forest) },
    },
    registry,
  }).state;
  state.players.A.hand = [];
  state.players.B.hand = [];
  let guard = 0;
  while (state.step !== step && guard++ < 40) {
    state = applyAction(state, { kind: 'passPriority', player: state.priorityPlayer }, DEFAULT_RULES, registry).state;
  }
  expect(state.step).toBe(step);
  return state;
}

function collect(state: GameState, actions: Array<(s: GameState) => Parameters<typeof applyAction>[1]>): { state: GameState; events: GameEvent[] } {
  const events: GameEvent[] = [];
  let s = state;
  for (const build of actions) {
    const result = applyAction(s, build(s), DEFAULT_RULES, registry);
    events.push(...result.events);
    s = result.state;
  }
  return { state: s, events };
}

describe('the reveal line (20260901_210413 — Goblin Guide)', () => {
  it('names the revealed card, whose library it came from, and where it went', () => {
    const state = gameAt('precombatMain');
    const guide = put(state, card('Goblin Guide'), 'A', 'battlefield');
    // The defending player's top card is a Forest (the whole library is), so
    // the reveal matches and the card goes to their hand.
    const { state: after, events } = collect(state, [
      (s) => ({ kind: 'passPriority', player: s.priorityPlayer }), // → beginCombat… wait for attackers
      (s) => ({ kind: 'passPriority', player: s.priorityPlayer }),
      (s) => ({ kind: 'passPriority', player: s.priorityPlayer }),
      (s) => ({ kind: 'passPriority', player: s.priorityPlayer }),
      (s) => ({ kind: 'declareAttackers', player: s.activePlayer, attackers: [guide.instanceId] }),
      (s) => ({ kind: 'passPriority', player: s.priorityPlayer }),
      (s) => ({ kind: 'passPriority', player: s.priorityPlayer }),
    ]);
    const lines = describeEvents(events, resolvers(after)).map((l) => l.text);
    const reveal = lines.find((t) => t.startsWith('Goblin Guide reveals'));
    expect(reveal, lines.join('\n')).toBe("Goblin Guide reveals Forest from the top of Computer's library — it goes to Computer's hand.");
    expect(after.players.B.hand.map((c) => c.def.name)).toEqual(['Forest']);
  });
});

describe('the pump line (20260901_204957 — Monastery Swiftspear)', () => {
  it('says the creature gets +1/+1 until end of turn, in the creature’s own name', () => {
    const state = gameAt('precombatMain');
    const swiftspear = put(state, card('Monastery Swiftspear'), 'A', 'battlefield');
    const strike = put(state, card('Lightning Strike'), 'A', 'hand');
    state.players.A.manaPool = { W: 0, U: 0, B: 0, R: 2, G: 0, C: 0 };
    const { state: after, events } = collect(state, [
      () => ({ kind: 'castSpell', player: 'A', instanceId: strike.instanceId, targets: ['B'] }),
      (s) => ({ kind: 'passPriority', player: s.priorityPlayer }), // A passes → B
      (s) => ({ kind: 'passPriority', player: s.priorityPlayer }), // B passes → prowess trigger resolves
    ]);
    const lines = describeEvents(events, resolvers(after)).map((l) => l.text);
    expect(lines).toContain('Monastery Swiftspear gets +1/+1 until end of turn.');
    expect(swiftspear.instanceId).toBeGreaterThan(0);
  });

  it('a continuous effect with no P/T delta adds no line', () => {
    const lines = describeEvents(
      [{ type: 'continuousEffectAdded', targetInstanceId: 5, sourceInstanceId: 6, duration: 'endOfTurn' }],
      { name: () => 'x', playerName: () => 'y' },
    );
    expect(lines).toEqual([]);
  });
});
