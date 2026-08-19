/**
 * Planeswalkers: loyalty counters + walkers as attackable objects.
 *
 * The system under test (DESIGN §3.11 "loyalty counters + planeswalkers"):
 *   - a walker ENTERS with its printed loyalty as counters (CR 306.5b);
 *   - loyalty abilities are activated abilities with a SIGNED loyalty cost,
 *     sorcery-speed, at most one per walker per turn (CR 606);
 *   - attackers may be declared against a walker the defending player controls
 *     (the `isAttackable` seam — battles will reuse it);
 *   - combat damage to a walker removes loyalty; trample overflow past a
 *     walker's loyalty carries to the defending player (CR 702.19i);
 *   - a walker with 0 loyalty is put into its owner's graveyard by a
 *     state-based action (CR 704.5i);
 *   - there is NO damage redirection: the 2017 rules change removed it, and an
 *     attacked walker that has left the battlefield simply absorbs nothing.
 */

import { describe, expect, it } from 'vitest';
import {
  applyAction,
  createGame,
  DEFAULT_RULES,
  generateLegalActions,
  LOYALTY_COUNTER,
  loyaltyOf,
  type CardDefinition,
  type GameAction,
  type GameState,
} from './index.js';
import { createEffectRegistry } from './effects.js';
import { creatureDef, deckOf, giveHand, landDef } from './test-fixtures.js';
import type { CardInstance, InstanceId, PlayerId } from './state.js';

const ISLAND = landDef('Island', 'U');
const registry = createEffectRegistry();
// A harmless effect for loyalty abilities: unknown primitives are safe no-ops
// (`effectUnsupported`), which is all an engine-level cost test needs.
const NOTE = [{ primitive: 'testNoteEffect' }];

/** A 3-loyalty walker with a +1, a −2 and a −6, all sorcery-speed. */
function walkerDef(id = 'Test Walker'): CardDefinition {
  return {
    id,
    name: id,
    types: ['planeswalker'],
    loyalty: 3,
    activated: [
      { cost: { loyalty: 1 }, timing: 'sorcery', effects: NOTE, label: '+1: note' },
      { cost: { loyalty: -2 }, timing: 'sorcery', effects: NOTE, label: '-2: note' },
      { cost: { loyalty: -6 }, timing: 'sorcery', effects: NOTE, label: '-6: note' },
    ],
  };
}

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

/** Put a permanent straight onto the battlefield (test-position building). */
function put(
  state: GameState,
  def: CardDefinition,
  controller: PlayerId,
  opts: { loyalty?: number; sick?: boolean } = {},
): InstanceId {
  const inst: CardInstance = {
    instanceId: state.nextInstanceId++,
    def,
    controller,
    owner: controller,
    zone: 'battlefield',
    tapped: false,
    summoningSick: opts.sick ?? false,
    damageMarked: 0,
    markedByDeathtouch: false,
    attachedTo: null,
    counters:
      opts.loyalty !== undefined
        ? { [LOYALTY_COUNTER]: opts.loyalty }
        : def.loyalty !== undefined
          ? { [LOYALTY_COUNTER]: def.loyalty }
          : {},
  };
  state.battlefield.push(inst);
  return inst.instanceId;
}

function onBattlefield(state: GameState, id: InstanceId): CardInstance | undefined {
  return state.battlefield.find((c) => c.instanceId === id);
}

function inGraveyard(state: GameState, owner: PlayerId, id: InstanceId): boolean {
  return state.players[owner].graveyard.some((c) => c.instanceId === id);
}

describe('entering the battlefield', () => {
  it('a cast walker enters with its printed loyalty as counters', () => {
    const { state } = createGame({ seed: 1, decks: { A: lib(), B: lib() }, registry });
    let s = advanceToStep(state, 'precombatMain');
    const [walker] = giveHand(s, 'A', [walkerDef()]);
    s = act(s, { kind: 'castSpell', player: 'A', instanceId: walker!.instanceId });
    s = pass(s);
    s = pass(s); // both pass → resolves
    const onField = onBattlefield(s, walker!.instanceId);
    expect(onField).toBeDefined();
    expect(loyaltyOf(onField!)).toBe(3);
    // A walker is not summoning-sick: its loyalty abilities work immediately.
    expect(onField!.summoningSick).toBe(false);
  });
});

describe('loyalty abilities', () => {
  /** A main-phase state with A's walker on the battlefield. */
  function mainWithWalker(seed = 2): { state: GameState; walker: InstanceId } {
    const { state } = createGame({ seed, decks: { A: lib(), B: lib() }, registry });
    const walker = put(state, walkerDef(), 'A');
    return { state: advanceToStep(state, 'precombatMain'), walker };
  }

  it('a plus ability adds loyalty as its cost is paid and resolves', () => {
    const { state, walker } = mainWithWalker();
    let s = act(state, { kind: 'activateAbility', player: 'A', instanceId: walker, abilityIndex: 0 });
    expect(loyaltyOf(onBattlefield(s, walker)!)).toBe(4); // 3 + 1, paid up front
    expect(s.stack).toHaveLength(1);
    s = pass(s);
    s = pass(s);
    expect(s.stack).toHaveLength(0);
  });

  it('a minus ability removes loyalty, and paying below zero is illegal', () => {
    const { state, walker } = mainWithWalker();
    const s = act(state, { kind: 'activateAbility', player: 'A', instanceId: walker, abilityIndex: 1 });
    expect(loyaltyOf(onBattlefield(s, walker)!)).toBe(1); // 3 − 2

    // −6 with only 3 loyalty: rejected AND never offered.
    const { state: fresh, walker: w2 } = mainWithWalker(3);
    expect(
      rejectionOf(fresh, { kind: 'activateAbility', player: 'A', instanceId: w2, abilityIndex: 2 }),
    ).toMatch(/does not have 6 loyalty/);
    const offered = generateLegalActions(fresh, DEFAULT_RULES).filter(
      (a) => a.kind === 'activateAbility' && a.instanceId === w2,
    );
    expect(
      offered.some((a) => a.kind === 'activateAbility' && a.abilityIndex === 2),
    ).toBe(false);
    // The affordable ones ARE offered.
    expect(offered.some((a) => a.kind === 'activateAbility' && a.abilityIndex === 0)).toBe(true);
    expect(offered.some((a) => a.kind === 'activateAbility' && a.abilityIndex === 1)).toBe(true);
  });

  it('only one loyalty ability per walker per turn', () => {
    const { state, walker } = mainWithWalker(4);
    let s = act(state, { kind: 'activateAbility', player: 'A', instanceId: walker, abilityIndex: 0 });
    s = pass(s);
    s = pass(s); // resolve the first activation
    expect(
      rejectionOf(s, { kind: 'activateAbility', player: 'A', instanceId: walker, abilityIndex: 1 }),
    ).toMatch(/already activated a loyalty ability this turn/);
    // …and it is not offered.
    const offered = generateLegalActions(s, DEFAULT_RULES);
    expect(offered.some((a) => a.kind === 'activateAbility' && a.instanceId === walker)).toBe(false);

    // Next turn (B's) it is still A's walker and still spent; on A's NEXT turn it works.
    s = advanceToStep(s, 'cleanup');
    s = advanceToStep(s, 'precombatMain'); // B's main
    s = advanceToStep(s, 'cleanup');
    s = advanceToStep(s, 'precombatMain'); // A's main again
    expect(s.activePlayer).toBe('A');
    const again = act(s, { kind: 'activateAbility', player: 'A', instanceId: walker, abilityIndex: 0 });
    expect(loyaltyOf(onBattlefield(again, walker)!)).toBe(5);
  });

  it('loyalty abilities are sorcery-speed only', () => {
    const { state, walker } = mainWithWalker(5);
    const atUpkeep = advanceToStep(advanceToStep(state, 'cleanup'), 'upkeep');
    // B's upkeep — A holds no sorcery window anywhere here; try at A's priority.
    let s = atUpkeep;
    while (s.priorityPlayer !== 'A' && !s.gameOver) s = pass(s);
    expect(
      rejectionOf(s, { kind: 'activateAbility', player: 'A', instanceId: walker, abilityIndex: 0 }),
    ).toMatch(/sorcery speed/);
  });

  it('paying loyalty down to exactly zero kills the walker; the ability still resolves', () => {
    const { state } = createGame({ seed: 6, decks: { A: lib(), B: lib() }, registry });
    const walker = put(state, walkerDef(), 'A', { loyalty: 2 });
    let s = advanceToStep(state, 'precombatMain');
    s = act(s, { kind: 'activateAbility', player: 'A', instanceId: walker, abilityIndex: 1 }); // −2 → 0
    // Dead immediately by SBA — not still standing at 0.
    expect(onBattlefield(s, walker)).toBeUndefined();
    expect(inGraveyard(s, 'A', walker)).toBe(true);
    // The ability is still on the stack and resolves without its source.
    expect(s.stack).toHaveLength(1);
    s = pass(s);
    s = pass(s);
    expect(s.stack).toHaveLength(0);
    expect(s.gameOver).toBe(false);
  });
});

describe('attacking a planeswalker', () => {
  /**
   * B's walker on the battlefield, A with attackers, sitting at A's
   * declare-attackers step.
   */
  function combatSetup(
    seed: number,
    attackers: readonly CardDefinition[],
    opts: { walkerLoyalty?: number; blockers?: readonly CardDefinition[] } = {},
  ): { state: GameState; walker: InstanceId; attackerIds: InstanceId[]; blockerIds: InstanceId[] } {
    const { state } = createGame({ seed, decks: { A: lib(), B: lib() }, registry });
    const walker = put(state, walkerDef('Enemy Walker'), 'B', { loyalty: opts.walkerLoyalty ?? 3 });
    const attackerIds = attackers.map((def) => put(state, def, 'A'));
    const blockerIds = (opts.blockers ?? []).map((def) => put(state, def, 'B'));
    return { state: advanceToStep(state, 'declareAttackers'), walker, attackerIds, blockerIds };
  }

  it('an unblocked attacker declared at a walker removes loyalty instead of life', () => {
    const { state, walker, attackerIds } = combatSetup(10, [creatureDef('Bear', 2, 2)]);
    let s = act(state, {
      kind: 'declareAttackers',
      player: 'A',
      attackers: attackerIds,
      attackTargets: { [attackerIds[0]!]: walker },
    });
    s = advanceToStep(s, 'endCombat');
    expect(loyaltyOf(onBattlefield(s, walker)!)).toBe(1); // 3 − 2
    expect(s.players.B.life).toBe(DEFAULT_RULES.startingLife); // the player took nothing
  });

  it('combat damage ≥ loyalty kills the walker via the state-based action', () => {
    const { state, walker, attackerIds } = combatSetup(11, [creatureDef('Ogre', 4, 4)]);
    let s = act(state, {
      kind: 'declareAttackers',
      player: 'A',
      attackers: attackerIds,
      attackTargets: { [attackerIds[0]!]: walker },
    });
    s = advanceToStep(s, 'endCombat');
    expect(onBattlefield(s, walker)).toBeUndefined();
    expect(inGraveyard(s, 'B', walker)).toBe(true);
    expect(s.players.B.life).toBe(DEFAULT_RULES.startingLife); // no trample → excess is wasted
  });

  it('a blocker in front of a walker-attacker absorbs the damage; the walker takes none', () => {
    const { state, walker, attackerIds, blockerIds } = combatSetup(12, [creatureDef('Bear', 2, 2)], {
      blockers: [creatureDef('Wall', 0, 4)],
    });
    let s = act(state, {
      kind: 'declareAttackers',
      player: 'A',
      attackers: attackerIds,
      attackTargets: { [attackerIds[0]!]: walker },
    });
    s = advanceToStep(s, 'declareBlockers');
    s = act(s, {
      kind: 'declareBlockers',
      player: 'B',
      blocks: [{ blocker: blockerIds[0]!, attacker: attackerIds[0]! }],
    });
    s = advanceToStep(s, 'endCombat');
    expect(loyaltyOf(onBattlefield(s, walker)!)).toBe(3); // untouched
    const wall = onBattlefield(s, blockerIds[0]!);
    expect(wall?.damageMarked).toBe(2);
  });

  it('trample past a blocked walker-attacker overflows to the walker, and past its loyalty to the player', () => {
    // 7-power trampler at a 2-loyalty walker, blocked by a 0/1: 1 lethal to the
    // blocker, 2 to the walker (kills it), the remaining 4 to the player.
    const { state, walker, attackerIds, blockerIds } = combatSetup(
      13,
      [creatureDef('Juggernaut', 7, 7, { keywords: { trample: true } })],
      { walkerLoyalty: 2, blockers: [creatureDef('Chump', 0, 1)] },
    );
    let s = act(state, {
      kind: 'declareAttackers',
      player: 'A',
      attackers: attackerIds,
      attackTargets: { [attackerIds[0]!]: walker },
    });
    s = advanceToStep(s, 'declareBlockers');
    s = act(s, {
      kind: 'declareBlockers',
      player: 'B',
      blocks: [{ blocker: blockerIds[0]!, attacker: attackerIds[0]! }],
    });
    s = advanceToStep(s, 'endCombat');
    expect(onBattlefield(s, walker)).toBeUndefined(); // 2 damage = its loyalty
    expect(s.players.B.life).toBe(DEFAULT_RULES.startingLife - 4);
  });

  it('a walker that dies mid-combat absorbs nothing and redirects nothing', () => {
    // The walker leaves before damage (its controller "sacrifices" it here by a
    // direct state edit standing in for removal-in-response). The attacker was
    // attacking that object, so it deals NO combat damage — the 2017 rules
    // removed redirection.
    const { state, walker, attackerIds } = combatSetup(14, [creatureDef('Bear', 2, 2)]);
    let s = act(state, {
      kind: 'declareAttackers',
      player: 'A',
      attackers: attackerIds,
      attackTargets: { [attackerIds[0]!]: walker },
    });
    // Remove the walker before the damage step.
    const idx = s.battlefield.findIndex((c) => c.instanceId === walker);
    const [gone] = s.battlefield.splice(idx, 1);
    gone!.zone = 'graveyard';
    s.players.B.graveyard.push(gone!);
    s = advanceToStep(s, 'endCombat');
    expect(s.players.B.life).toBe(DEFAULT_RULES.startingLife);
  });

  it('rejects attacking your own walker, a non-attackable permanent, or a non-attacker entry', () => {
    const { state } = createGame({ seed: 15, decks: { A: lib(), B: lib() }, registry });
    const myWalker = put(state, walkerDef('My Walker'), 'A');
    const enemyBear = put(state, creatureDef('Enemy Bear', 2, 2), 'B');
    const bear = put(state, creatureDef('Bear', 2, 2), 'A');
    const s = advanceToStep(state, 'declareAttackers');

    expect(
      rejectionOf(s, {
        kind: 'declareAttackers',
        player: 'A',
        attackers: [bear],
        attackTargets: { [bear]: myWalker },
      }),
      // Reworded when battles landed: the question the engine asks is who
      // DEFENDS the attacked object, not who controls it. For a walker the two
      // are the same player; for a battle they are deliberately opposite, which
      // is why the check had to move to `protectorOf` and the message with it.
    ).toMatch(/not defended by the defending player/);
    expect(
      rejectionOf(s, {
        kind: 'declareAttackers',
        player: 'A',
        attackers: [bear],
        attackTargets: { [bear]: enemyBear },
      }),
    ).toMatch(/not a permanent that can be attacked/);
    expect(
      rejectionOf(s, {
        kind: 'declareAttackers',
        player: 'A',
        attackers: [bear],
        attackTargets: { [enemyBear]: 'B' },
      }),
    ).toMatch(/not a declared attacker/);
  });
});

describe('state-based actions', () => {
  it('a walker at 0 loyalty is put into its owner\'s graveyard on the next check', () => {
    const { state } = createGame({ seed: 20, decks: { A: lib(), B: lib() }, registry });
    const walker = put(state, walkerDef(), 'A', { loyalty: 0 });
    // Any action runs the SBA sweep via the priority machinery; a pass suffices
    // once the game reaches a step transition. Drive one step.
    const s = advanceToStep(state, 'precombatMain');
    expect(onBattlefield(s, walker)).toBeUndefined();
    expect(inGraveyard(s, 'A', walker)).toBe(true);
  });
});
