/**
 * The pilot actually PLAYS an Equipment whose value is a triggered ability, and
 * actually ATTACKS with a creature whose value is connecting.
 *
 * Both halves were inert before, and both failed silently — the sort of failure
 * a win rate never reports, because the card simply never does anything:
 *
 *  1. **Equipping.** The equip search gated on `attachment.modifies`, so an
 *     Equipment whose whole printed text is "whenever equipped creature deals
 *     combat damage to a player, …" scored `undefined` and was never picked up
 *     in any game ever simulated. A Sword nobody equips is a blank artifact in
 *     every A/B verdict that includes it.
 *  2. **Attacking.** A saboteur creature is priced by the face damage it deals,
 *     so a 1/1 whose whole job is to connect was valued at one point of damage
 *     and held back. The trigger is now part of what connecting is worth.
 *
 * Each is asserted against a CONTROL that differs only in the thing under test —
 * the same board with the trigger removed — so a pilot that equips/attacks for
 * some unrelated reason cannot pass.
 */

import { describe, expect, it } from 'vitest';
import {
  EQUIPMENT_WHEN_ILLEGAL,
  LOYALTY_COUNTER,
  applyAction,
  createGame,
  createRng,
  generateLegalActions,
  type CardDefinition,
  type DeckList,
  type GameAction,
  type GameState,
  type PlayerId,
} from '@jonny-boi/core';
import { createHeuristicPilot } from './heuristic.js';
import type { HeuristicWeights } from './weights.js';
import { DEFAULT_HEURISTIC_WEIGHTS } from './weights.js';
import { createTestRegistry, creatureDef, giveHand, landDef } from './test-support.js';

/** "Equip {1}" — the printed ability, exactly as the compiler emits it. */
function equipAbility(cost: number): NonNullable<CardDefinition['activated']> {
  return [
    {
      cost: { mana: { generic: cost } },
      effects: [{ primitive: 'attachToTarget', params: { targets: 'creatureYouControl' } }],
      timing: 'sorcery',
      label: `Equip {${cost}}`,
    },
  ];
}

/**
 * Sword-of-the-Animist-shaped: an Equipment whose ENTIRE reason to exist is the
 * trigger on its host. Deliberately no P/T modification at all — that is the
 * case the old score could not see.
 */
const TRIGGER_ONLY_SWORD: CardDefinition = {
  id: 'trigger-sword',
  name: 'Trigger Sword',
  types: ['artifact'],
  subtypes: ['equipment'],
  cost: { generic: 2 },
  attachment: {
    attachesTo: { anyOfTypes: ['creature'], controller: 'you' },
    whenIllegal: EQUIPMENT_WHEN_ILLEGAL,
  },
  triggers: [
    {
      condition: { on: 'combatDamageToPlayer', watches: 'attachedHost' },
      effects: [{ primitive: 'drawCards', params: { count: 1 } }],
      label: 'Equipped creature deals combat damage: draw a card',
    },
  ],
  activated: equipAbility(1),
};

/** The control: the same artifact with nothing to give. */
const BLANK_SWORD: CardDefinition = {
  ...TRIGGER_ONLY_SWORD,
  id: 'blank-sword',
  name: 'Blank Sword',
  triggers: undefined,
};

/** A 1/1 whose printed job is to connect, and the vanilla it is measured against. */
const SABOTEUR: CardDefinition = {
  ...creatureDef('Saboteur', 1, 1),
  triggers: [
    {
      condition: { on: 'combatDamageToPlayer' },
      effects: [{ primitive: 'drawCards', params: { count: 1 } }],
      label: 'Deals combat damage: draw a card',
    },
  ],
};
const VANILLA: CardDefinition = creatureDef('Vanilla', 1, 1);

function stubDeck(): DeckList {
  return { cards: Array.from({ length: 30 }, (_, i) => landDef(`L${i}`, 'R')) };
}

/** Put `defs` onto a player's battlefield, untapped and not summoning-sick. */
function place(state: GameState, player: PlayerId, defs: readonly CardDefinition[]) {
  const made = giveHand(state, player, defs);
  state.players[player].hand = [];
  for (const inst of made) {
    inst.zone = 'battlefield';
    inst.summoningSick = false;
    state.battlefield.push(inst);
  }
  return made;
}

/** A's precombat main, `lands` untapped Mountains, the given permanents in play. */
function mainPhase(mine: readonly CardDefinition[], lands = 3): GameState {
  const { state } = createGame({ seed: 11, decks: { A: stubDeck(), B: stubDeck() } });
  state.step = 'precombatMain';
  state.activePlayer = 'A';
  state.priorityPlayer = 'A';
  state.stack = [];
  state.players.A.hand = [];
  state.players.B.hand = [];
  state.players.A.landsPlayedThisTurn = 1;
  place(
    state,
    'A',
    Array.from({ length: lands }, (_, i) => landDef(`M${i}`, 'R')),
  );
  place(state, 'A', mine);
  return state;
}

/**
 * Drive the pilot until it either activates an ability or does something that is
 * not funding one. Returns the activation, or `undefined`.
 */
function pilotEquips(state: GameState): Extract<GameAction, { kind: 'activateAbility' }> | undefined {
  const pilot = createHeuristicPilot();
  const registry = createTestRegistry();
  let current = state;
  for (let ply = 0; ply < 10; ply++) {
    const action = pilot.chooseAction({
      view: current,
      legalActions: generateLegalActions(current),
      rng: createRng(3),
    });
    if (action.kind === 'activateAbility') return action;
    if (action.kind !== 'tapForMana') return undefined;
    current = applyAction(current, action, undefined, registry).state;
  }
  return undefined;
}

describe('the pilot equips an Equipment whose value is its trigger', () => {
  it('equips a trigger-only Sword, and does not equip the same artifact without it', () => {
    const carrier = creatureDef('Carrier', 3, 3);

    const equipped = pilotEquips(mainPhase([carrier, TRIGGER_ONLY_SWORD]));
    expect(equipped, 'a Sword whose whole text is its trigger was never equipped').toBeDefined();

    // The control: identical artifact, identical board, no trigger and no
    // modification — there is nothing to gain, so the pilot must not spend on it.
    expect(pilotEquips(mainPhase([carrier, BLANK_SWORD]))).toBeUndefined();
  });

  it('still prefers the bigger body to carry it', () => {
    const state = mainPhase([creatureDef('Small', 1, 1), creatureDef('Big', 4, 4), TRIGGER_ONLY_SWORD]);
    const big = state.battlefield.find((c) => c.def.name === 'Big');
    const equipped = pilotEquips(state);
    expect(equipped?.targets?.[0]).toBe(big?.instanceId);
  });
});

describe('a combat-damage trigger is a reason to attack', () => {
  /** A's declare-attackers step with `mine` attacking into `theirs`. */
  function combat(mine: readonly CardDefinition[], theirs: readonly CardDefinition[]): GameState {
    const state = mainPhase([], 0);
    state.step = 'declareAttackers';
    // The engine offers the declaration only inside a live combat that has not
    // been declared yet — without this the position is legal-looking and offers
    // nothing but `passPriority`, and every assertion below would pass by
    // measuring silence.
    state.combat = { attackers: [], blocks: {}, attackersDeclared: false, blockersDeclared: false };
    place(state, 'A', mine);
    place(state, 'B', theirs);
    return state;
  }

  function attack(
    state: GameState,
    weights: HeuristicWeights = DEFAULT_HEURISTIC_WEIGHTS,
  ): Extract<GameAction, { kind: 'declareAttackers' }> | undefined {
    const action = createHeuristicPilot(weights).chooseAction({
      view: state,
      legalActions: generateLegalActions(state),
      rng: createRng(3),
    });
    return action.kind === 'declareAttackers' ? action : undefined;
  }

  /**
   * A pilot tuned to want more than one point of face damage before it commits a
   * creature. `attackValueThreshold` is a documented data knob, and raising it is
   * how the saboteur term becomes VISIBLE: at the shipped threshold of 1 a 1/1 is
   * already worth attacking with, so a 1/1 saboteur and a 1/1 vanilla make the
   * same decision and no assertion about the default pilot could tell them apart.
   */
  const CAUTIOUS: HeuristicWeights = { ...DEFAULT_HEURISTIC_WEIGHTS, attackValueThreshold: 3 };

  it('sends a small saboteur that a cautious pilot would hold a vanilla back with', () => {
    // Nothing to block with: the only question is whether connecting is worth it.
    expect(attack(combat([VANILLA], []), CAUTIOUS)).toBeUndefined();
    expect(attack(combat([SABOTEUR], []), CAUTIOUS)?.attackers.length).toBe(1);
  });

  it('counts the trigger an ATTACHED Equipment lends its host', () => {
    // The trigger belongs to the SWORD; the pilot has to look from the creature
    // back to whatever is attached to it to find it. The same 1/1 with the same
    // cautious pilot stays home when the Sword is lying loose.
    const loose = combat([VANILLA, TRIGGER_ONLY_SWORD], []);
    expect(attack(loose, CAUTIOUS)).toBeUndefined();

    const equipped = combat([VANILLA, TRIGGER_ONLY_SWORD], []);
    const host = equipped.battlefield.find((c) => c.def.name === 'Vanilla');
    const sword = equipped.battlefield.find((c) => c.def.name === 'Trigger Sword');
    sword!.attachedTo = host!.instanceId;
    expect(attack(equipped, CAUTIOUS)?.attackers).toEqual([host!.instanceId]);
  });

  it('never attacks with a 0-power saboteur — connecting for nothing fires nothing', () => {
    const zero: CardDefinition = { ...creatureDef('Zero', 0, 3), triggers: SABOTEUR.triggers };
    expect(attack(combat([zero], []), CAUTIOUS)).toBeUndefined();
    expect(attack(combat([zero], []))).toBeUndefined();
  });

  it('does not talk itself into a losing trade — the bonus is for CONNECTING', () => {
    // A 2/2 eats a 1/1 for free. The trigger pays nothing to a blocked attacker,
    // so it must not tip this attack, with either pilot.
    const wall = creatureDef('Wall', 2, 2);
    expect(attack(combat([SABOTEUR], [wall]))).toBeUndefined();
    expect(attack(combat([VANILLA], [wall]))).toBeUndefined();
  });

  it('sends the VANILLA at the planeswalker and the saboteur at the face', () => {
    // Two identical-sized attackers and a walker one of them can finish. They are
    // interchangeable by power, which is exactly when diverting the wrong one is
    // invisible — and diverting the saboteur throws its trigger away, because
    // "combat damage to a player" does not fire on a planeswalker.
    const walker: CardDefinition = {
      id: 'walker',
      name: 'Walker',
      types: ['planeswalker'],
      cost: { generic: 3 },
      loyalty: 1,
    };
    const state = combat([SABOTEUR, VANILLA], [walker]);
    // Loyalty lives in COUNTERS, put there as the walker enters; a walker placed
    // straight onto the battlefield has none, and `planWalkerAttack` skips a
    // 0-loyalty object entirely.
    const placed = state.battlefield.find((c) => c.def.name === 'Walker');
    placed!.counters = { [LOYALTY_COUNTER]: 1 };
    const saboteur = state.battlefield.find((c) => c.def.name === 'Saboteur');
    const vanilla = state.battlefield.find((c) => c.def.name === 'Vanilla');
    const walkerInstance = state.battlefield.find((c) => c.def.name === 'Walker');

    const declared = attack(state);
    expect(declared?.attackers.length).toBe(2);
    expect(declared?.attackTargets?.[vanilla!.instanceId]).toBe(walkerInstance!.instanceId);
    expect(declared?.attackTargets?.[saboteur!.instanceId]).toBeUndefined();
  });
});
