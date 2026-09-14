/**
 * POISON — infect, wither, toxic, and poison counters as a player resource
 * (§3.105). Every test drives the REAL engine through combat or the SBA pass;
 * nothing here re-implements a rule and agrees with itself.
 *
 * The rules, with the card each one is pinned by:
 *  - CR 120.3d / 702.90c — infect damage to a creature is -1/-1 counters, not
 *    marked damage (Glistener Elf);
 *  - CR 120.3b / 702.90b — infect damage to a player is poison, not life loss
 *    (Blighted Agent);
 *  - CR 702.80a — wither is the creature half only (Boggart Ram-Gang);
 *  - CR 702.164c / 120.3g — toxic N is N poison IN ADDITION to the damage, and
 *    only for combat damage (Tyrranax Atrocity, Paladin of Predation);
 *  - CR 704.5c — ten poison loses, regardless of life total;
 *  - infect is STILL DAMAGE: lifelink gains (Flensermite), deathtouch destroys,
 *    a fog prevents, and "deals damage" fires;
 *  - CR 702.19b — trample past a blocker counts lethal by the blocker's REMAINING
 *    toughness, so -1/-1 counters already on it lower what infect must assign;
 *  - the clone and serialize paths carry poison, and omit it when zero.
 */

import { describe, expect, it } from 'vitest';
import {
  addFloatingReplacement,
  applyAction,
  checkStateBasedActions,
  cloneState,
  createGame,
  DEFAULT_RULES,
  MINUS_ONE_COUNTER,
  POISON_LOSS_REASON,
  POISON_LOSS_THRESHOLD,
  addPoisonCounters,
  poisonOf,
  serializeState,
  type CardDefinition,
  type CardInstance,
  type GameAction,
  type GameEvent,
  type GameState,
  type InstanceId,
  type PlayerId,
} from './index.js';
import { createEffectRegistry } from './effects.js';
import { creatureDef, deckOf, landDef } from './test-fixtures.js';

const ISLAND = landDef('Island', 'U');

function act(state: GameState, action: GameAction): { state: GameState; events: readonly GameEvent[] } {
  const r = applyAction(state, action, DEFAULT_RULES, createEffectRegistry());
  const rejected = r.events.find((e) => e.type === 'actionRejected');
  if (rejected) throw new Error(`unexpected rejection: ${(rejected as { reason: string }).reason}`);
  return r;
}

function pass(state: GameState): GameState {
  return act(state, { kind: 'passPriority', player: state.priorityPlayer }).state;
}

function advanceToStep(state: GameState, target: string, max = 300): GameState {
  let s = state;
  let g = 0;
  while (s.step !== target && !s.gameOver && g++ < max) s = pass(s);
  return s;
}

function find(state: GameState, id: InstanceId): CardInstance {
  const c = state.battlefield.find((x) => x.instanceId === id);
  if (!c) throw new Error(`no instance ${id} on battlefield`);
  return c;
}

function onBattlefield(state: GameState, id: InstanceId): boolean {
  return state.battlefield.some((c) => c.instanceId === id);
}

/** The combat.test.ts idiom: creatures placed directly, A at declare-attackers. */
function combatSetup(
  attackers: readonly CardDefinition[],
  blockers: readonly CardDefinition[],
  opts: { startingLife?: number; poisonB?: number; blockerCounters?: Record<string, number> } = {},
): { state: GameState; attackerIds: InstanceId[]; blockerIds: InstanceId[] } {
  const g = createGame({
    seed: 1,
    decks: { A: deckOf(ISLAND, 40), B: deckOf(ISLAND, 40) },
    config: { ...DEFAULT_RULES, startingLife: opts.startingLife ?? DEFAULT_RULES.startingLife },
  });
  const state = g.state;
  let nextId = state.nextInstanceId;
  const place = (def: CardDefinition, controller: PlayerId, counters: Record<string, number> = {}): InstanceId => {
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
      counters,
    });
    return id;
  };
  const attackerIds = attackers.map((d) => place(d, 'A'));
  const blockerIds = blockers.map((d) => place(d, 'B', opts.blockerCounters ?? {}));
  state.nextInstanceId = nextId;
  if (opts.poisonB !== undefined) addPoisonCounters(state, 'B', opts.poisonB, () => {});
  return { state: advanceToStep(state, 'declareAttackers'), attackerIds, blockerIds };
}

/** Declare every attacker, the given blocks, and run through combat damage. */
function runCombat(
  state: GameState,
  attackerIds: readonly InstanceId[],
  blocks: ReadonlyArray<{ blocker: InstanceId; attacker: InstanceId }>,
  beforeBlocks?: (s: GameState) => void,
): { state: GameState; events: GameEvent[] } {
  const events: GameEvent[] = [];
  let r = act(state, { kind: 'declareAttackers', player: 'A', attackers: [...attackerIds] });
  let s = advanceToStep(r.state, 'declareBlockers');
  if (beforeBlocks) beforeBlocks(s);
  r = act(s, { kind: 'declareBlockers', player: 'B', blocks: [...blocks] });
  s = r.state;
  let guard = 0;
  while (s.step !== 'postcombatMain' && !s.gameOver && guard++ < 300) {
    const step = act(s, { kind: 'passPriority', player: s.priorityPlayer });
    events.push(...step.events);
    s = step.state;
  }
  return { state: s, events };
}

const GLISTENER_ELF = creatureDef('Glistener Elf', 1, 1, { keywords: { infect: true } });
const BLIGHTED_AGENT = creatureDef('Blighted Agent', 1, 1, { keywords: { infect: true, unblockable: true } });
const BOGGART_RAM_GANG = creatureDef('Boggart Ram-Gang', 3, 3, { keywords: { wither: true, haste: true } });
const TYRRANAX_ATROCITY = creatureDef('Tyrranax Atrocity', 4, 4, { keywords: { toxic: 3, haste: true } });
const FLENSERMITE = creatureDef('Flensermite', 1, 1, { keywords: { infect: true, lifelink: true } });

describe('infect (CR 702.90) — damage lands as counters, not marks', () => {
  it('Glistener Elf blocked by a 3/3 puts one -1/-1 counter on it and marks NO damage', () => {
    const bear = creatureDef('Bear', 3, 3);
    const { state, attackerIds, blockerIds } = combatSetup([GLISTENER_ELF], [bear]);
    const { state: s } = runCombat(state, attackerIds, [{ blocker: blockerIds[0]!, attacker: attackerIds[0]! }]);
    const blocker = find(s, blockerIds[0]!);
    expect(blocker.counters[MINUS_ONE_COUNTER]).toBe(1);
    expect(blocker.damageMarked).toBe(0);
    // The elf took 3 ordinary damage from the 3/3 and died; the 3/3 is now a 2/2.
    expect(onBattlefield(s, attackerIds[0]!)).toBe(false);
  });

  it('the -1/-1 counters are PERMANENT — they survive the cleanup step that clears marked damage', () => {
    const bear = creatureDef('Bear', 3, 3);
    const { state, attackerIds, blockerIds } = combatSetup([GLISTENER_ELF], [bear]);
    const { state: afterCombat } = runCombat(state, attackerIds, [{ blocker: blockerIds[0]!, attacker: attackerIds[0]! }]);
    // Into B's turn: every "marked" thing was cleared at A's cleanup step.
    const nextTurn = advanceToStep(afterCombat, 'precombatMain', 60);
    expect(nextTurn.activePlayer).toBe('B');
    expect(find(nextTurn, blockerIds[0]!).counters[MINUS_ONE_COUNTER]).toBe(1);
  });

  it('infect damage that reaches lethal kills through the -1/-1 counters (a 2/2 dealt 2 infect damage dies)', () => {
    const two = creatureDef('Two', 2, 2);
    const infect22 = creatureDef('Scourge', 2, 2, { keywords: { infect: true } });
    const { state, attackerIds, blockerIds } = combatSetup([infect22], [two]);
    const { state: s } = runCombat(state, attackerIds, [{ blocker: blockerIds[0]!, attacker: attackerIds[0]! }]);
    expect(onBattlefield(s, blockerIds[0]!)).toBe(false);
  });

  it('Blighted Agent connecting gives one poison counter and takes NO life', () => {
    const { state, attackerIds } = combatSetup([BLIGHTED_AGENT], []);
    const { state: s, events } = runCombat(state, attackerIds, []);
    expect(s.players.B.life).toBe(DEFAULT_RULES.startingLife);
    expect(poisonOf(s.players.B)).toBe(1);
    expect(events).toContainEqual({ type: 'poisonChanged', player: 'B', delta: 1, to: 1 });
    // Still DAMAGE: the damageDealt event fires, so "deals damage" triggers see it.
    expect(events).toContainEqual({
      type: 'damageDealt',
      source: attackerIds[0],
      target: 'B',
      amount: 1,
      combat: true,
      // Combat damage names the step that dealt it (CR 510.4, §3.143 GAP-12).
      round: 'normal',
    });
    expect(events.some((e) => e.type === 'lifeChanged' && e.player === 'B')).toBe(false);
  });

  it('a granted infect ("gains infect until end of turn") is read through the continuous layer', () => {
    const vanilla = creatureDef('Vanilla', 2, 2);
    const { state, attackerIds } = combatSetup([vanilla], []);
    state.continuous.push({
      id: state.nextInstanceId++,
      targetInstanceId: attackerIds[0]!,
      sourceInstanceId: attackerIds[0]!,
      duration: 'endOfTurn',
      keywords: { infect: true },
    });
    const { state: s } = runCombat(state, attackerIds, []);
    expect(poisonOf(s.players.B)).toBe(2);
    expect(s.players.B.life).toBe(DEFAULT_RULES.startingLife);
  });
});

describe('infect is still damage — the other keywords and prevention apply', () => {
  it('Flensermite (infect + lifelink) gains its controller life while giving poison', () => {
    const { state, attackerIds } = combatSetup([FLENSERMITE], []);
    const { state: s } = runCombat(state, attackerIds, []);
    expect(s.players.A.life).toBe(DEFAULT_RULES.startingLife + 1);
    expect(poisonOf(s.players.B)).toBe(1);
  });

  it('deathtouch + infect destroys a creature that has no marked damage at all (CR 702.2b)', () => {
    const big = creatureDef('Big', 5, 5);
    const dtInfect = creatureDef('Venom', 1, 1, { keywords: { infect: true, deathtouch: true } });
    const { state, attackerIds, blockerIds } = combatSetup([dtInfect], [big]);
    const { state: s } = runCombat(state, attackerIds, [{ blocker: blockerIds[0]!, attacker: attackerIds[0]! }]);
    expect(onBattlefield(s, blockerIds[0]!)).toBe(false);
  });

  it('a fog prevents infect damage, so no poison is given', () => {
    const { state, attackerIds } = combatSetup([BLIGHTED_AGENT], []);
    const { state: s } = runCombat(state, attackerIds, [], (s) => {
      addFloatingReplacement(s, {
        event: 'damage',
        applies: { combat: true },
        outcome: { preventAll: true },
        sourceInstanceId: 0,
        controller: 'B',
        duration: 'endOfTurn',
      });
    });
    expect(poisonOf(s.players.B)).toBe(0);
    expect(s.players.B.life).toBe(DEFAULT_RULES.startingLife);
  });
});

describe('wither (CR 702.80) — the creature half only', () => {
  it('Boggart Ram-Gang blocked by a 4/4 leaves it a 1/1 with three -1/-1 counters', () => {
    const wall = creatureDef('Wall', 4, 4);
    const { state, attackerIds, blockerIds } = combatSetup([BOGGART_RAM_GANG], [wall]);
    const { state: s } = runCombat(state, attackerIds, [{ blocker: blockerIds[0]!, attacker: attackerIds[0]! }]);
    const blocker = find(s, blockerIds[0]!);
    expect(blocker.counters[MINUS_ONE_COUNTER]).toBe(3);
    expect(blocker.damageMarked).toBe(0);
  });

  it('Boggart Ram-Gang connecting deals ordinary life loss and no poison', () => {
    const { state, attackerIds } = combatSetup([BOGGART_RAM_GANG], []);
    const { state: s } = runCombat(state, attackerIds, []);
    expect(s.players.B.life).toBe(DEFAULT_RULES.startingLife - 3);
    expect(poisonOf(s.players.B)).toBe(0);
  });
});

describe('toxic N (CR 702.164) — poison IN ADDITION to combat damage', () => {
  it('Tyrranax Atrocity connecting deals 4 damage AND three poison counters', () => {
    const { state, attackerIds } = combatSetup([TYRRANAX_ATROCITY], []);
    const { state: s } = runCombat(state, attackerIds, []);
    expect(s.players.B.life).toBe(DEFAULT_RULES.startingLife - 4);
    expect(poisonOf(s.players.B)).toBe(3);
  });

  it('a blocked toxic creature gives no poison — it dealt no combat damage to a PLAYER', () => {
    const wall = creatureDef('Wall', 0, 8);
    const { state, attackerIds, blockerIds } = combatSetup([TYRRANAX_ATROCITY], [wall]);
    const { state: s } = runCombat(state, attackerIds, [{ blocker: blockerIds[0]!, attacker: attackerIds[0]! }]);
    expect(poisonOf(s.players.B)).toBe(0);
    expect(find(s, blockerIds[0]!).damageMarked).toBe(4);
  });

  it('a 0-power toxic creature deals no damage and therefore gives no poison', () => {
    const noPower = creatureDef('Mite', 0, 1, { keywords: { toxic: 1 } });
    const { state, attackerIds } = combatSetup([noPower], []);
    const { state: s } = runCombat(state, attackerIds, []);
    expect(poisonOf(s.players.B)).toBe(0);
  });

  it('two toxic instances SUM — "total toxic value" (CR 702.164b)', () => {
    const toxic1 = creatureDef('Duelist', 1, 1, { keywords: { toxic: 1 } });
    const { state, attackerIds } = combatSetup([toxic1], []);
    state.continuous.push({
      id: state.nextInstanceId++,
      targetInstanceId: attackerIds[0]!,
      sourceInstanceId: attackerIds[0]!,
      duration: 'endOfTurn',
      keywords: { toxic: 1 },
    });
    const { state: s } = runCombat(state, attackerIds, []);
    expect(poisonOf(s.players.B)).toBe(2);
  });
});

describe('CR 704.5c — ten poison counters loses the game', () => {
  it('a player given their tenth counter loses on the next state-based check, at full life', () => {
    const g = createGame({ seed: 1, decks: { A: deckOf(ISLAND, 40), B: deckOf(ISLAND, 40) } });
    const state = g.state;
    const events: GameEvent[] = [];
    addPoisonCounters(state, 'B', POISON_LOSS_THRESHOLD - 1, (e) => events.push(e));
    checkStateBasedActions(state, (e) => events.push(e));
    expect(state.players.B.hasLost).toBe(false);
    addPoisonCounters(state, 'B', 1, (e) => events.push(e));
    checkStateBasedActions(state, (e) => events.push(e));
    expect(state.players.B.hasLost).toBe(true);
    expect(state.players.B.life).toBe(DEFAULT_RULES.startingLife);
    expect(events).toContainEqual({ type: 'playerLost', player: 'B', reason: POISON_LOSS_REASON });
    expect(state.gameOver).toBe(true);
    expect(state.winner).toBe('A');
  });

  it('the tenth counter arriving through combat ends the game at the SBA boundary after damage', () => {
    const { state, attackerIds } = combatSetup([BLIGHTED_AGENT], [], { poisonB: POISON_LOSS_THRESHOLD - 1 });
    const { state: s } = runCombat(state, attackerIds, []);
    expect(s.gameOver).toBe(true);
    expect(s.winner).toBe('A');
    expect(poisonOf(s.players.B)).toBe(POISON_LOSS_THRESHOLD);
  });
});

describe('trample + infect (CR 702.19b) — lethal is judged by REMAINING toughness', () => {
  it('a 4-power infect trampler assigns 1 to a 3/3 already wearing two -1/-1 counters and 3 to the player', () => {
    const trampler = creatureDef('Putrefax', 4, 4, { keywords: { infect: true, trample: true } });
    const bear = creatureDef('Bear', 3, 3);
    const { state, attackerIds, blockerIds } = combatSetup([trampler], [bear], {
      blockerCounters: { [MINUS_ONE_COUNTER]: 2 },
    });
    const { state: s } = runCombat(state, attackerIds, [{ blocker: blockerIds[0]!, attacker: attackerIds[0]! }]);
    expect(onBattlefield(s, blockerIds[0]!)).toBe(false); // the 1/1 took its lethal counter
    expect(poisonOf(s.players.B)).toBe(3);
  });
});

describe('poison travels with the state', () => {
  it('cloneState carries poison, and a state that never had it stays without the field', () => {
    const g = createGame({ seed: 1, decks: { A: deckOf(ISLAND, 40), B: deckOf(ISLAND, 40) } });
    addPoisonCounters(g.state, 'A', 4, () => {});
    const copy = cloneState(g.state);
    expect(poisonOf(copy.players.A)).toBe(4);
    expect('poison' in copy.players.B).toBe(false);
  });

  it('serializeState reports poison only when it is nonzero (the golden-digest discipline)', () => {
    const g = createGame({ seed: 1, decks: { A: deckOf(ISLAND, 40), B: deckOf(ISLAND, 40) } });
    expect('poison' in serializeState(g.state).players.A).toBe(false);
    addPoisonCounters(g.state, 'A', 2, () => {});
    expect(serializeState(g.state).players.A.poison).toBe(2);
  });

  it('a non-positive amount is a no-op and emits nothing', () => {
    const g = createGame({ seed: 1, decks: { A: deckOf(ISLAND, 40), B: deckOf(ISLAND, 40) } });
    const events: GameEvent[] = [];
    addPoisonCounters(g.state, 'A', 0, (e) => events.push(e));
    addPoisonCounters(g.state, 'A', -3, (e) => events.push(e));
    expect(events).toEqual([]);
    expect(poisonOf(g.state.players.A)).toBe(0);
  });
});
