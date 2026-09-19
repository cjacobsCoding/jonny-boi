/**
 * §3.173 — THE THREE ROWS CORE LEARNED, each pinned against the real engine:
 *
 *  - `'attackingOrBlockingCreature'` (Sandblast, Elite Archers): during a
 *    declared combat the attackers AND the blockers are legal, a bystander is
 *    not, a creature removed from combat is not, and outside combat nothing is;
 *  - the `yourTurn` static condition (Fresh-Faced Recruit): a static that
 *    carries it is on during its controller's turn and off on the opponent's —
 *    read live through the same layer combat reads;
 *  - the two enters-tapped facts (the Duskmourn slow lands, the Battlebond
 *    lands): "unless a player has 13 or less life" reads every total, "unless
 *    you have two or more opponents" counts the one opponent this engine seats
 *    — and a land PLAYED in a real game reads both through `entersTapped`.
 */

import { describe, expect, it } from 'vitest';
import {
  applyAction,
  createGame,
  DEFAULT_RULES,
  effectiveKeywords,
  entersTapped,
  generateLegalActions,
  indexContinuous,
  isLegalTarget,
  legalTargetsFor,
  type CardDefinition,
  type CardInstance,
  type GameAction,
  type GameState,
  type PlayerId,
} from './index.js';
import { removeFromCombat } from './combat-removal.js';
import { createEffectRegistry } from './effects.js';
import { creatureDef, deckOf, landDef } from './test-fixtures.js';

const ISLAND = landDef('Island', 'U');
const registry = createEffectRegistry();

function act(state: GameState, action: GameAction): GameState {
  const r = applyAction(state, action, DEFAULT_RULES, registry);
  const rejected = r.events.find((e) => e.type === 'actionRejected');
  if (rejected) throw new Error(`unexpected rejection: ${(rejected as { reason: string }).reason}`);
  return r.state;
}
const pass = (state: GameState) => act(state, { kind: 'passPriority', player: state.priorityPlayer });
function advanceToStep(state: GameState, target: string, max = 400): GameState {
  let s = state;
  let guard = 0;
  while (s.step !== target && !s.gameOver && guard++ < max) s = pass(s);
  return s;
}
function place(state: GameState, def: CardDefinition, controller: PlayerId): CardInstance {
  const instance: CardInstance = {
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
  };
  state.battlefield.push(instance);
  return instance;
}
function fresh(seed = 3): GameState {
  const { state } = createGame({ seed, decks: { A: deckOf(ISLAND, 40), B: deckOf(ISLAND, 40) }, registry });
  return state;
}

describe("'attackingOrBlockingCreature' — target attacking or blocking creature", () => {
  function combatWithBlock() {
    let s = fresh();
    const attacker = place(s, creatureDef('Attacker', 2, 2), 'A');
    const bystander = place(s, creatureDef('Bystander', 2, 2), 'A');
    const blocker = place(s, creatureDef('Blocker', 2, 2), 'B');
    const homebody = place(s, creatureDef('Homebody', 2, 2), 'B');
    s = advanceToStep(s, 'declareAttackers');
    s = act(s, { kind: 'declareAttackers', player: 'A', attackers: [attacker.instanceId] });
    s = advanceToStep(s, 'declareBlockers');
    s = act(s, {
      kind: 'declareBlockers',
      player: 'B',
      blocks: [{ blocker: blocker.instanceId, attacker: attacker.instanceId }],
    });
    return { s, attacker, bystander, blocker, homebody };
  }

  it('offers the attacker and the blocker, and neither bystander', () => {
    const { s, attacker, bystander, blocker, homebody } = combatWithBlock();
    const legal = legalTargetsFor(s, 'attackingOrBlockingCreature', 'A');
    expect(legal).toEqual([attacker.instanceId, blocker.instanceId]);
    expect(isLegalTarget(s, 'attackingOrBlockingCreature', bystander.instanceId, 'A')).toBe(false);
    expect(isLegalTarget(s, 'attackingOrBlockingCreature', homebody.instanceId, 'B')).toBe(false);
  });

  it('a creature removed from combat stops being legal, and outside combat nothing is', () => {
    const { s, attacker, blocker } = combatWithBlock();
    removeFromCombat(s.combat, blocker.instanceId);
    expect(legalTargetsFor(s, 'attackingOrBlockingCreature', 'A')).toEqual([attacker.instanceId]);
    const quiet = fresh();
    const idle = place(quiet, creatureDef('Idle', 2, 2), 'A');
    expect(legalTargetsFor(quiet, 'attackingOrBlockingCreature', 'A')).toEqual([]);
    expect(isLegalTarget(quiet, 'attackingOrBlockingCreature', idle.instanceId, 'A')).toBe(false);
  });
});

describe('the yourTurn static condition — "during your turn, ~ has first strike"', () => {
  const RECRUIT: CardDefinition = {
    id: 'recruit',
    name: 'Fresh-Faced Recruit',
    types: ['creature'],
    power: 2,
    toughness: 1,
    statics: [
      {
        affects: { onlySource: true },
        keywords: { firstStrike: true },
        label: '~ has first strike',
        activeWhile: { kind: 'yourTurn' },
      },
    ],
  };
  const firstStrike = (s: GameState, id: number) =>
    effectiveKeywords(s.battlefield.find((c) => c.instanceId === id)!, indexContinuous(s).get(id) ?? undefined)
      .firstStrike === true;

  it('is on during its controller\'s turn and off on the opponent\'s — read live', () => {
    let s = fresh();
    const recruit = place(s, RECRUIT, 'A');
    s = advanceToStep(s, 'precombatMain');
    expect(s.activePlayer).toBe('A');
    expect(firstStrike(s, recruit.instanceId)).toBe(true);
    // Walk into B's turn: nothing was recomputed by a pass, the read is live.
    let guard = 0;
    while (s.activePlayer === 'A' && !s.gameOver && guard++ < 200) {
      const legal = generateLegalActions(s);
      const next = legal.find((a) => a.kind === 'passPriority') ?? legal[0]!;
      s = applyAction(s, next, DEFAULT_RULES, registry).state;
    }
    expect(s.activePlayer).toBe('B');
    expect(firstStrike(s, recruit.instanceId)).toBe(false);
  });
});

describe('enters-tapped facts — a player\'s life total, the opponent count', () => {
  const CAMPGROUND: CardDefinition = {
    id: 'campground',
    name: 'Abandoned Campground',
    types: ['land'],
    produces: ['W', 'U'],
    entersTappedUnless: { anyPlayerLifeAtMost: 13 },
  };
  const GARDEN: CardDefinition = {
    id: 'garden',
    name: 'Spire Garden',
    types: ['land'],
    produces: ['R', 'G'],
    entersTappedUnless: { minOpponents: 2 },
  };
  const context = (lifeTotals: number[], opponentCount: number) => ({
    controller: 'A',
    battlefield: [],
    lifeTotals,
    opponentCount,
  });

  it('the accessor: at 20/20 tapped, with any player at 13 untapped; one opponent is never two', () => {
    expect(entersTapped(CAMPGROUND, context([20, 20], 1))).toBe(true);
    expect(entersTapped(CAMPGROUND, context([20, 13], 1))).toBe(false);
    expect(entersTapped(CAMPGROUND, context([9, 20], 1))).toBe(false);
    expect(entersTapped(GARDEN, context([20, 20], 1))).toBe(true);
    expect(entersTapped(GARDEN, context([20, 20], 2))).toBe(false);
    // No facts at all: the printed default, tapped.
    expect(entersTapped(CAMPGROUND, { controller: 'A', battlefield: [] })).toBe(true);
  });

  it('played in a real game, the land reads the live totals and the seat count', () => {
    const play = (def: CardDefinition, lifeB: number) => {
      let s = fresh();
      s = advanceToStep(s, 'precombatMain');
      s.players.B.life = lifeB;
      const id = s.nextInstanceId++;
      s.players.A.hand.push({
        instanceId: id,
        def,
        controller: 'A',
        owner: 'A',
        zone: 'hand',
        tapped: false,
        summoningSick: false,
        damageMarked: 0,
        markedByDeathtouch: false,
        counters: {},
      });
      s = act(s, { kind: 'playLand', player: 'A', instanceId: id });
      return s.battlefield.find((c) => c.instanceId === id)!.tapped;
    };
    expect(play(CAMPGROUND, 20), 'both at 20: tapped').toBe(true);
    expect(play(CAMPGROUND, 12), 'the opponent at 12: untapped').toBe(false);
    expect(play(GARDEN, 20), 'one opponent at this table: tapped, as printed').toBe(true);
  });
});
