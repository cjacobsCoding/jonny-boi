import { describe, expect, it } from 'vitest';
import {
  applyAction,
  createGame,
  DEFAULT_RULES,
  type CardDefinition,
  type CardInstance,
  type GameAction,
  type GameState,
  type InstanceId,
  type PlayerId,
} from './index.js';
import { createEffectRegistry } from './effects.js';
import { creatureDef, deckOf, landDef } from './test-fixtures.js';

const ISLAND = landDef('Island', 'U');

function act(state: GameState, action: GameAction): GameState {
  const r = applyAction(state, action, DEFAULT_RULES, createEffectRegistry());
  const rejected = r.events.find((e) => e.type === 'actionRejected');
  if (rejected) throw new Error(`unexpected rejection: ${(rejected as { reason: string }).reason}`);
  return r.state;
}

function pass(state: GameState): GameState {
  return act(state, { kind: 'passPriority', player: state.priorityPlayer });
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

/**
 * Build a state with the given creatures already on the battlefield (not sick),
 * with the active player A in their declareAttackers step. We construct directly
 * for combat-focused tests to avoid threading a whole game just to place creatures.
 */
function combatSetup(
  attackers: readonly CardDefinition[],
  blockers: readonly CardDefinition[],
  opts: { startingLife?: number } = {},
): { state: GameState; attackerIds: InstanceId[]; blockerIds: InstanceId[] } {
  const g = createGame({
    seed: 1,
    decks: { A: deckOf(ISLAND, 40), B: deckOf(ISLAND, 40) },
    config: { ...DEFAULT_RULES, startingLife: opts.startingLife ?? DEFAULT_RULES.startingLife },
  });
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
  const attackerIds = attackers.map((d) => place(d, 'A'));
  const blockerIds = blockers.map((d) => place(d, 'B'));
  state.nextInstanceId = nextId;
  // Move A to the declare-attackers step.
  const atStep = advanceToStep(state, 'declareAttackers');
  return { state: atStep, attackerIds, blockerIds };
}

/** Resolve combat: declare attackers (all), pass to blockers, declare, run damage. */
function runCombat(
  state: GameState,
  attackerIds: readonly InstanceId[],
  blocks: ReadonlyArray<{ blocker: InstanceId; attacker: InstanceId }>,
): GameState {
  let s = act(state, { kind: 'declareAttackers', player: 'A', attackers: [...attackerIds] });
  // Priority through declareAttackers → advance to declareBlockers.
  s = advanceToStep(s, 'declareBlockers');
  s = act(s, { kind: 'declareBlockers', player: 'B', blocks: [...blocks] });
  // Advance through to combat damage + beyond.
  s = advanceToStep(s, 'postcombatMain');
  return s;
}

describe('combat damage', () => {
  it('an unblocked attacker damages the defending player', () => {
    const { state, attackerIds } = combatSetup([creatureDef('A1', 3, 3)], []);
    const s = runCombat(state, attackerIds, []);
    expect(s.players.B.life).toBe(DEFAULT_RULES.startingLife - 3);
  });

  it('a blocked attacker and blocker trade lethal damage and both die', () => {
    const { state, attackerIds, blockerIds } = combatSetup([creatureDef('A1', 2, 2)], [creatureDef('B1', 2, 2)]);
    const s = runCombat(state, attackerIds, [{ blocker: blockerIds[0]!, attacker: attackerIds[0]! }]);
    expect(s.battlefield.some((c) => c.instanceId === attackerIds[0])).toBe(false);
    expect(s.battlefield.some((c) => c.instanceId === blockerIds[0])).toBe(false);
    expect(s.players.A.graveyard.length + s.players.B.graveyard.length).toBe(2);
    expect(s.players.B.life).toBe(DEFAULT_RULES.startingLife); // no damage got through
  });

  it('a larger blocker survives and kills the attacker', () => {
    const { state, attackerIds, blockerIds } = combatSetup([creatureDef('A1', 2, 2)], [creatureDef('B1', 3, 4)]);
    const s = runCombat(state, attackerIds, [{ blocker: blockerIds[0]!, attacker: attackerIds[0]! }]);
    expect(s.battlefield.some((c) => c.instanceId === attackerIds[0])).toBe(false); // attacker dies
    expect(s.battlefield.some((c) => c.instanceId === blockerIds[0])).toBe(true); // blocker lives
  });

  it('first strike kills before the normal-damage striker can hit back', () => {
    const fs = creatureDef('FS', 2, 2, { keywords: { firstStrike: true } });
    const vanilla = creatureDef('V', 2, 2);
    const { state, attackerIds, blockerIds } = combatSetup([fs], [vanilla]);
    const s = runCombat(state, attackerIds, [{ blocker: blockerIds[0]!, attacker: attackerIds[0]! }]);
    // First striker (2 dmg) kills the 2-toughness blocker before it deals damage.
    expect(s.battlefield.some((c) => c.instanceId === blockerIds[0])).toBe(false);
    expect(s.battlefield.some((c) => c.instanceId === attackerIds[0])).toBe(true); // FS survives
  });

  it('deathtouch makes any damage lethal', () => {
    const dt = creatureDef('DT', 1, 1, { keywords: { deathtouch: true } });
    const big = creatureDef('Big', 1, 5);
    const { state, attackerIds, blockerIds } = combatSetup([dt], [big]);
    const s = runCombat(state, attackerIds, [{ blocker: blockerIds[0]!, attacker: attackerIds[0]! }]);
    // 1 deathtouch damage kills the 5-toughness blocker; the 1/1 also dies to 1 dmg.
    expect(s.battlefield.some((c) => c.instanceId === blockerIds[0])).toBe(false);
    expect(s.battlefield.some((c) => c.instanceId === attackerIds[0])).toBe(false);
  });

  it('trample carries excess damage to the player', () => {
    const trampler = creatureDef('TR', 5, 5, { keywords: { trample: true } });
    const chump = creatureDef('Chump', 1, 1);
    const { state, attackerIds, blockerIds } = combatSetup([trampler], [chump]);
    const s = runCombat(state, attackerIds, [{ blocker: blockerIds[0]!, attacker: attackerIds[0]! }]);
    // 1 damage to kill the 1/1, 4 trample to the player.
    expect(s.players.B.life).toBe(DEFAULT_RULES.startingLife - 4);
  });

  it('deathtouch + trample only needs 1 lethal before trampling the rest', () => {
    const dtt = creatureDef('DTT', 4, 4, { keywords: { deathtouch: true, trample: true } });
    const wall = creatureDef('Wall', 0, 5);
    const { state, attackerIds, blockerIds } = combatSetup([dtt], [wall]);
    const s = runCombat(state, attackerIds, [{ blocker: blockerIds[0]!, attacker: attackerIds[0]! }]);
    // Deathtouch: 1 damage is lethal, so 3 tramples over.
    expect(s.battlefield.some((c) => c.instanceId === blockerIds[0])).toBe(false);
    expect(s.players.B.life).toBe(DEFAULT_RULES.startingLife - 3);
  });

  it('flying cannot be blocked by a ground creature', () => {
    const flyer = creatureDef('Fly', 2, 2, { keywords: { flying: true } });
    const ground = creatureDef('Ground', 2, 2);
    const { state, attackerIds, blockerIds } = combatSetup([flyer], [ground]);
    // The block should be rejected.
    let s = act(state, { kind: 'declareAttackers', player: 'A', attackers: [attackerIds[0]!] });
    s = advanceToStep(s, 'declareBlockers');
    const r = applyAction(s, {
      kind: 'declareBlockers',
      player: 'B',
      blocks: [{ blocker: blockerIds[0]!, attacker: attackerIds[0]! }],
    });
    expect(r.events.some((e) => e.type === 'actionRejected')).toBe(true);
  });

  it('flying can be blocked by reach', () => {
    const flyer = creatureDef('Fly', 2, 2, { keywords: { flying: true } });
    const reacher = creatureDef('Spider', 2, 4, { keywords: { reach: true } });
    const { state, attackerIds, blockerIds } = combatSetup([flyer], [reacher]);
    const s = runCombat(state, attackerIds, [{ blocker: blockerIds[0]!, attacker: attackerIds[0]! }]);
    expect(s.players.B.life).toBe(DEFAULT_RULES.startingLife); // blocked, no damage through
    expect(s.battlefield.some((c) => c.instanceId === attackerIds[0])).toBe(false); // flyer dies to 2/4
  });

  it('vigilance attacker stays untapped', () => {
    const vig = creatureDef('Vig', 2, 2, { keywords: { vigilance: true } });
    const { state, attackerIds } = combatSetup([vig], []);
    const s = act(state, { kind: 'declareAttackers', player: 'A', attackers: [attackerIds[0]!] });
    expect(find(s, attackerIds[0]!).tapped).toBe(false);
  });

  it('a non-vigilance attacker becomes tapped', () => {
    const { state, attackerIds } = combatSetup([creatureDef('A1', 2, 2)], []);
    const s = act(state, { kind: 'declareAttackers', player: 'A', attackers: [attackerIds[0]!] });
    expect(find(s, attackerIds[0]!).tapped).toBe(true);
  });

  it('lifelink gains life equal to damage dealt', () => {
    const ll = creatureDef('LL', 3, 3, { keywords: { lifelink: true } });
    const { state, attackerIds } = combatSetup([ll], []);
    const s = runCombat(state, attackerIds, []);
    expect(s.players.A.life).toBe(DEFAULT_RULES.startingLife + 3);
    expect(s.players.B.life).toBe(DEFAULT_RULES.startingLife - 3);
  });

  it('double striker that kills its vanilla blocker on first strike deals NO face damage without trample', () => {
    // 2/2 double strike vs a vanilla 2/2 blocker. First-strike step deals 2 →
    // kills the blocker (SBAs remove it before the normal step). The attacker
    // stays blocked for the whole combat, so with no trample it leaks ZERO to
    // the defending player on the normal step (the bug let it hit for 2).
    const ds = creatureDef('DS', 2, 2, { keywords: { doubleStrike: true } });
    const vanilla = creatureDef('V', 2, 2);
    const { state, attackerIds, blockerIds } = combatSetup([ds], [vanilla]);
    const s = runCombat(state, attackerIds, [{ blocker: blockerIds[0]!, attacker: attackerIds[0]! }]);
    expect(s.players.B.life).toBe(DEFAULT_RULES.startingLife); // no face damage
    expect(s.battlefield.some((c) => c.instanceId === blockerIds[0])).toBe(false); // blocker dead
    expect(s.battlefield.some((c) => c.instanceId === attackerIds[0])).toBe(true); // DS survives
  });

  it('double-strike trample over a blocker it kills on first strike tramples full power on the normal step', () => {
    // 4/4 double-strike trample vs a 2/2 blocker. First-strike step: 2 lethal to
    // the 2-toughness blocker, 2 tramples through → B takes 2; SBAs remove the
    // dead blocker. Normal step: still blocked but no living blocker — trample
    // pushes the FULL power (4) through (0 lethal left to assign to the corpse).
    // Total face damage = 2 (FS overflow) + 4 (normal, fully trampled) = 6.
    const dst = creatureDef('DST', 4, 4, { keywords: { doubleStrike: true, trample: true } });
    const blocker = creatureDef('Blk', 2, 2);
    const { state, attackerIds, blockerIds } = combatSetup([dst], [blocker]);
    const s = runCombat(state, attackerIds, [{ blocker: blockerIds[0]!, attacker: attackerIds[0]! }]);
    expect(s.players.B.life).toBe(DEFAULT_RULES.startingLife - 6);
    expect(s.battlefield.some((c) => c.instanceId === blockerIds[0])).toBe(false); // blocker dead
    expect(s.battlefield.some((c) => c.instanceId === attackerIds[0])).toBe(true); // DST survives
  });

  it('a regular attacker whose blocker is removed before damage deals NO face damage without trample', () => {
    // Declare a block, then the blocker leaves play before combat damage (e.g.
    // bounced/destroyed). The attacker stays blocked: a non-trample attacker
    // deals zero to the defending player, not its full power.
    const attacker = creatureDef('A1', 3, 3);
    const blocker = creatureDef('B1', 1, 1);
    const { state, attackerIds, blockerIds } = combatSetup([attacker], [blocker]);
    let s = act(state, { kind: 'declareAttackers', player: 'A', attackers: [...attackerIds] });
    s = advanceToStep(s, 'declareBlockers');
    s = act(s, { kind: 'declareBlockers', player: 'B', blocks: [{ blocker: blockerIds[0]!, attacker: attackerIds[0]! }] });
    // Remove the blocker from the battlefield before combat damage resolves.
    s = { ...s, battlefield: s.battlefield.filter((c) => c.instanceId !== blockerIds[0]) };
    s = advanceToStep(s, 'postcombatMain');
    expect(s.players.B.life).toBe(DEFAULT_RULES.startingLife); // no face damage leaked
  });

  it('a blocked trampler whose blocker is removed before damage tramples its full power', () => {
    // Same scenario but the attacker has trample: with the blocker gone, all of
    // its power tramples through (no lethal to absorb).
    const trampler = creatureDef('TR', 3, 3, { keywords: { trample: true } });
    const blocker = creatureDef('B1', 1, 1);
    const { state, attackerIds, blockerIds } = combatSetup([trampler], [blocker]);
    let s = act(state, { kind: 'declareAttackers', player: 'A', attackers: [...attackerIds] });
    s = advanceToStep(s, 'declareBlockers');
    s = act(s, { kind: 'declareBlockers', player: 'B', blocks: [{ blocker: blockerIds[0]!, attacker: attackerIds[0]! }] });
    s = { ...s, battlefield: s.battlefield.filter((c) => c.instanceId !== blockerIds[0]) };
    s = advanceToStep(s, 'postcombatMain');
    expect(s.players.B.life).toBe(DEFAULT_RULES.startingLife - 3); // full power trampled
  });

  it('combat damage to a player can be lethal and ends the game', () => {
    const big = creatureDef('Big', 5, 5);
    const { state, attackerIds } = combatSetup([big], [], { startingLife: 4 });
    const s = runCombat(state, attackerIds, []);
    expect(s.gameOver).toBe(true);
    expect(s.winner).toBe('A');
  });
});

describe('attack/block legality', () => {
  it('summoning-sick creature cannot attack', () => {
    const { state } = combatSetup([], []);
    // Place a sick creature for A directly.
    const id = state.nextInstanceId;
    state.battlefield.push({
      instanceId: id,
      def: creatureDef('Sick', 2, 2),
      controller: 'A',
      owner: 'A',
      zone: 'battlefield',
      tapped: false,
      summoningSick: true,
      damageMarked: 0,
      markedByDeathtouch: false,
      counters: {},
    });
    state.nextInstanceId = id + 1;
    const r = applyAction(state, { kind: 'declareAttackers', player: 'A', attackers: [id] });
    expect(r.events.some((e) => e.type === 'actionRejected')).toBe(true);
  });

  it('haste lets a summoning-sick creature attack', () => {
    const haste = creatureDef('Hasty', 2, 2, { keywords: { haste: true } });
    const { state } = combatSetup([], []);
    const id = state.nextInstanceId;
    state.battlefield.push({
      instanceId: id,
      def: haste,
      controller: 'A',
      owner: 'A',
      zone: 'battlefield',
      tapped: false,
      summoningSick: true,
      damageMarked: 0,
      markedByDeathtouch: false,
      counters: {},
    });
    state.nextInstanceId = id + 1;
    const r = applyAction(state, { kind: 'declareAttackers', player: 'A', attackers: [id] });
    expect(r.events.some((e) => e.type === 'actionRejected')).toBe(false);
    expect(r.events.some((e) => e.type === 'attackersDeclared')).toBe(true);
  });
});
