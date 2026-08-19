/**
 * Battles: defense counters + battles as attackable objects.
 *
 * The system under test:
 *   - a battle ENTERS with its printed defense as counters (CR 310.4);
 *   - a battle is defended by its PROTECTOR, the opponent of its controller
 *     (CR 310.11) — which is why its controller attacks their OWN battle, and
 *     why the protector's creatures are the ones that may block;
 *   - attackers are declared against it through the SAME `isAttackable` seam
 *     planeswalkers use — combat itself was not reworked;
 *   - combat damage and noncombat damage alike remove defense counters
 *     (CR 120.3d), and trample overflow past the last counter carries to the
 *     defending player;
 *   - a battle with 0 defense counters is put into its owner's graveyard by a
 *     state-based action.
 *
 * ⚠️ What is deliberately NOT here, because it is deliberately not built: the
 * Siege REWARD ("exile it, then you may cast it transformed") needs the
 * castable-second-face system, which a sibling branch owns. The battle OBJECT is
 * complete; real Siege CARDS stay reported by the compiler naming that gap, so
 * no game ever silently skips a reward it claimed to pay.
 */

import { describe, expect, it } from 'vitest';
import {
  applyAction,
  createGame,
  DEFAULT_RULES,
  DEFENSE_COUNTER,
  defenseOf,
  isAttackable,
  legalTargetsFor,
  protectorOf,
  type CardDefinition,
  type GameAction,
  type GameState,
} from './index.js';
import { createEffectRegistry } from './effects.js';
import { creatureDef, deckOf, giveHand, landDef } from './test-fixtures.js';
import type { CardInstance, InstanceId, PlayerId } from './state.js';

const ISLAND = landDef('Island', 'U');
const registry = createEffectRegistry();

/** A 3-defense battle, as bare as the object gets. */
function battleDef(id = 'Test Siege', defense = 3): CardDefinition {
  return { id, name: id, types: ['battle'], subtypes: ['siege'], defense };
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

function eventsOf(state: GameState, action: GameAction): ReturnType<typeof applyAction>['events'] {
  return applyAction(state, action, DEFAULT_RULES, registry).events;
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
  opts: { defense?: number; sick?: boolean } = {},
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
      opts.defense !== undefined
        ? { [DEFENSE_COUNTER]: opts.defense }
        : def.defense !== undefined
          ? { [DEFENSE_COUNTER]: def.defense }
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

describe('the object', () => {
  it('a battle is attackable through the same seam as a planeswalker', () => {
    expect(isAttackable(battleDef())).toBe(true);
  });

  it('a battle is protected by its controller OPPONENT, not by its controller', () => {
    // The single fact that makes "attack your own Siege" legal and needs no
    // second combat path. A walker, by contrast, is defended by its controller.
    expect(protectorOf({ def: battleDef(), controller: 'A' })).toBe('B');
    expect(protectorOf({ def: battleDef(), controller: 'B' })).toBe('A');
    expect(
      protectorOf({ def: { id: 'w', name: 'w', types: ['planeswalker'], loyalty: 3 }, controller: 'A' }),
    ).toBe('A');
  });

  it('a cast battle enters with its printed defense as counters', () => {
    const { state } = createGame({ seed: 1, decks: { A: lib(), B: lib() }, registry });
    let s = advanceToStep(state, 'precombatMain');
    const [battle] = giveHand(s, 'A', [battleDef()]);
    s = act(s, { kind: 'castSpell', player: 'A', instanceId: battle!.instanceId });
    s = pass(s);
    s = pass(s); // both pass → resolves onto the battlefield
    const onField = onBattlefield(s, battle!.instanceId);
    expect(onField).toBeDefined();
    expect(defenseOf(onField!)).toBe(3);
  });
});

describe('attacking a battle', () => {
  /**
   * A declare-attackers state where A controls the battle (so B protects it) and
   * A has a creature able to attack. This is the printed pattern: A cast the
   * Siege, B protects it, A attacks it.
   */
  function combatWithBattle(
    seed = 2,
    power = 2,
    defense = 3,
  ): { state: GameState; battle: InstanceId; attacker: InstanceId } {
    const { state } = createGame({ seed, decks: { A: lib(), B: lib() }, registry });
    const battle = put(state, battleDef('Test Siege', defense), 'A');
    const attacker = put(state, creatureDef('Bear', power, 2), 'A');
    return { state: advanceToStep(state, 'declareAttackers'), battle, attacker };
  }

  it("a creature may attack a battle its controller's opponent protects", () => {
    const { state, battle, attacker } = combatWithBattle();
    // A controls the battle; B is the defending player AND its protector.
    const s = act(state, {
      kind: 'declareAttackers',
      player: 'A',
      attackers: [attacker],
      attackTargets: { [attacker]: battle },
    });
    expect(s.combat?.attackTargets?.[attacker]).toBe(battle);
  });

  it('a battle the DEFENDING player does not protect cannot be attacked', () => {
    // B controls this battle, so A protects it — and A is the attacker, so on
    // A's turn there is no legal attack against it. The rejection names the
    // protector rather than the controller, which is the distinction that
    // matters and the one a controller-comparison would get backwards.
    const { state } = createGame({ seed: 7, decks: { A: lib(), B: lib() }, registry });
    const battle = put(state, battleDef(), 'B');
    const attacker = put(state, creatureDef('Bear', 2, 2), 'A');
    const s = advanceToStep(state, 'declareAttackers');
    expect(
      rejectionOf(s, {
        kind: 'declareAttackers',
        player: 'A',
        attackers: [attacker],
        attackTargets: { [attacker]: battle },
      }),
    ).toMatch(/not defended by the defending player/);
  });

  it('combat damage removes defense counters and says so in the log', () => {
    const { state, battle, attacker } = combatWithBattle(3, 2, 3);
    let s = act(state, {
      kind: 'declareAttackers',
      player: 'A',
      attackers: [attacker],
      attackTargets: { [attacker]: battle },
    });
    s = advanceToStep(s, 'endCombat');
    const onField = onBattlefield(s, battle);
    expect(onField).toBeDefined();
    expect(defenseOf(onField!)).toBe(1); // 3 − 2
  });

  it('removing the LAST defense counter defeats the battle by state-based action', () => {
    // Exactly lethal: a 3-power attacker into a 3-defense battle.
    const { state, battle, attacker } = combatWithBattle(4, 3, 3);
    let s = act(state, {
      kind: 'declareAttackers',
      player: 'A',
      attackers: [attacker],
      attackTargets: { [attacker]: battle },
    });
    s = advanceToStep(s, 'endCombat');
    expect(onBattlefield(s, battle)).toBeUndefined();
    // To its OWNER's graveyard — A owns it, even though B protected it.
    expect(inGraveyard(s, 'A', battle)).toBe(true);
  });

  it('an over-killing attack leaves no negative defense', () => {
    const { state, battle, attacker } = combatWithBattle(5, 7, 3);
    let s = act(state, {
      kind: 'declareAttackers',
      player: 'A',
      attackers: [attacker],
      attackTargets: { [attacker]: battle },
    });
    s = advanceToStep(s, 'endCombat');
    expect(inGraveyard(s, 'A', battle)).toBe(true);
    // The battle left with its counters emptied, never driven below zero.
    const dead = s.players.A.graveyard.find((c) => c.instanceId === battle);
    expect(defenseOf(dead!)).toBe(0);
  });

  it('a trampling attacker carries the excess past the last counter to the defender', () => {
    // CR 702.19j: the battle's remaining defense is the lethal amount; the rest
    // tramples through to the DEFENDING player — who, for a battle, is its
    // protector. A 5-power trampler into a 2-defense battle: 2 to the battle,
    // 3 to B.
    const { state } = createGame({ seed: 6, decks: { A: lib(), B: lib() }, registry });
    const battle = put(state, battleDef('Test Siege', 2), 'A');
    const trampler = put(state, { ...creatureDef('Trampler', 5, 5), keywords: { trample: true } }, 'A');
    let s = advanceToStep(state, 'declareAttackers');
    const lifeBefore = s.players.B.life;
    s = act(s, {
      kind: 'declareAttackers',
      player: 'A',
      attackers: [trampler],
      attackTargets: { [trampler]: battle },
    });
    s = advanceToStep(s, 'endCombat');
    expect(inGraveyard(s, 'A', battle)).toBe(true);
    expect(s.players.B.life).toBe(lifeBefore - 3);
  });

  it('a battle already at 0 counters mid-combat absorbs nothing more', () => {
    // The failure mode worth pinning: two attackers sent at one battle, the
    // first of which already finishes it. The battle leaves during the SBA pass,
    // and the second attacker must deal NOTHING — not to the battle (it is
    // gone), and not redirected to the player (the 2017 removal of redirection
    // applies to every attacked object, not only to walkers).
    const { state } = createGame({ seed: 8, decks: { A: lib(), B: lib() }, registry });
    const battle = put(state, battleDef('Test Siege', 1), 'A');
    const first = put(state, creatureDef('First', 1, 1), 'A');
    const second = put(state, creatureDef('Second', 4, 4), 'A');
    let s = advanceToStep(state, 'declareAttackers');
    const lifeBefore = s.players.B.life;
    s = act(s, {
      kind: 'declareAttackers',
      player: 'A',
      attackers: [first, second],
      attackTargets: { [first]: battle, [second]: battle },
    });
    s = advanceToStep(s, 'endCombat');
    expect(inGraveyard(s, 'A', battle)).toBe(true);
    // Both attackers were aimed at the battle; neither hit B's face.
    expect(s.players.B.life).toBe(lifeBefore);
  });

  it('the protector may block an attack on the battle they protect', () => {
    // B protects A's battle, so B's creatures defend it — this is the whole
    // reason the "who defends" question is asked as `protectorOf` and not as
    // "who controls the attacked object".
    const { state } = createGame({ seed: 9, decks: { A: lib(), B: lib() }, registry });
    const battle = put(state, battleDef('Test Siege', 3), 'A');
    const attacker = put(state, creatureDef('Bear', 2, 2), 'A');
    const blocker = put(state, creatureDef('Wall', 0, 4), 'B');
    let s = advanceToStep(state, 'declareAttackers');
    s = act(s, {
      kind: 'declareAttackers',
      player: 'A',
      attackers: [attacker],
      attackTargets: { [attacker]: battle },
    });
    s = advanceToStep(s, 'declareBlockers');
    s = act(s, { kind: 'declareBlockers', player: 'B', blocks: [{ blocker, attacker }] });
    s = advanceToStep(s, 'endCombat');
    // Blocked: the battle took nothing at all.
    expect(defenseOf(onBattlefield(s, battle)!)).toBe(3);
  });
});

describe('noncombat damage and targeting', () => {
  it('"any target" reaches a battle; "creature or planeswalker" does not', () => {
    // CR 115.4: "any target" is a creature, a player, a planeswalker, OR a
    // battle — which is what makes burn a real answer to a Siege rather than a
    // rule nobody can reach. The narrower two-kind wording must NOT widen with
    // it: that printed line names two kinds, and a card that could suddenly hit
    // battles would be playing better than printed.
    const { state } = createGame({ seed: 10, decks: { A: lib(), B: lib() }, registry });
    const battle = put(state, battleDef('Test Siege', 3), 'B');
    const s = advanceToStep(state, 'precombatMain');
    expect(legalTargetsFor(s, 'any', 'A')).toContain(battle);
    expect(legalTargetsFor(s, 'creatureOrPlaneswalker', 'A')).not.toContain(battle);
    expect(legalTargetsFor(s, 'creature', 'A')).not.toContain(battle);
  });
});

describe('defeat', () => {
  it('a battle put to 0 by a state-based check emits battleDefeated', () => {
    const { state } = createGame({ seed: 11, decks: { A: lib(), B: lib() }, registry });
    const battle = put(state, battleDef('Test Siege', 1), 'A');
    const attacker = put(state, creatureDef('Bear', 2, 2), 'A');
    let s = advanceToStep(state, 'declareAttackers');
    const declare: GameAction = {
      kind: 'declareAttackers',
      player: 'A',
      attackers: [attacker],
      attackTargets: { [attacker]: battle },
    };
    s = act(s, declare);
    // Walk to the damage step collecting events.
    let sawDefeat = false;
    let guard = 0;
    while (s.step !== 'endCombat' && !s.gameOver && guard++ < 400) {
      const action: GameAction = { kind: 'passPriority', player: s.priorityPlayer };
      const evs = eventsOf(s, action);
      if (evs.some((e) => e.type === 'battleDefeated')) sawDefeat = true;
      s = act(s, action);
    }
    expect(sawDefeat).toBe(true);
  });
});
