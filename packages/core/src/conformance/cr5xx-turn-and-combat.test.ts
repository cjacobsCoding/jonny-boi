/**
 * CONFORMANCE — CR 5xx (turn structure), including the combat phase (506–511).
 *
 * Combat lives here rather than with the keyword abilities in the 7xx file
 * because the CR puts it here: 508 declare attackers, 509 declare blockers, 510
 * combat damage, 511 end of combat are all sections of chapter 5. The 7xx file
 * owns what the KEYWORDS do to combat (flying, first strike, trample, …); this
 * file owns the STEPS themselves — who declares, when, what taps, what the
 * damage step does with the declaration it was handed, and what cleanup undoes.
 *
 * Every position here is built small and driven with real actions: `createGame`,
 * `generateLegalActions`, `applyAction`. Nothing simulates a step.
 */

import { describe, expect } from 'vitest';
import {
  STEP_ORDER,
  aggregateFor,
  createGame,
  effectiveToughness,
  generateLegalActions,
  type CardDefinition,
  type GameState,
  type PlayerId,
} from '../index.js';
import { creatureDef, deckOf, giveHand, landDef } from '../test-fixtures.js';
import {
  act,
  actWithEvents,
  advanceTo,
  assertFileMatchesManifest,
  crTest,
  eventsNamed,
  givePriorityTo,
  nonActive,
  onBattlefield,
  pass,
  putOnBattlefield,
  registryWith,
  rejectionOf,
} from './harness.js';

const FILE = 'cr5xx-turn-and-combat';

const MOUNTAIN = landDef('Mountain', 'R');

const BEAR = creatureDef('Bear', 2, 2);
const VIGILANT = creatureDef('Vigilant Bear', 2, 2, { keywords: { vigilance: true } });
const FIRST_STRIKER = creatureDef('First Striker', 2, 2, { keywords: { firstStrike: true } });

/** "Target creature gets +3/+3 until end of turn" — the fixture cleanup must undo. */
const PUMP: CardDefinition = {
  id: 'pump',
  name: 'Pump',
  types: ['instant'],
  timing: 'instant',
  effects: [{ primitive: 'pump', params: { targets: 'creature' } }],
};

const PUMP_AMOUNT = 3;

const registry = registryWith({
  noop: () => {},
  pump: (ctx) => {
    const target = ctx.targets[0];
    if (typeof target !== 'number') return;
    ctx.addContinuousEffect({ target, power: PUMP_AMOUNT, toughness: PUMP_AMOUNT, duration: 'endOfTurn' });
  },
});

/** A game sitting in A's precombat main, hands emptied. */
function atMain(seed = 21): GameState {
  const created = createGame({
    seed,
    startingPlayer: 'A',
    registry,
    decks: { A: deckOf(MOUNTAIN, 40), B: deckOf(MOUNTAIN, 40) },
  });
  const state = advanceTo(created.state, 'precombatMain', registry);
  state.players.A.hand = [];
  state.players.B.hand = [];
  return state;
}

/** Every `stepBegin` step name a run of passes produced, in order. */
function stepsSeen(from: GameState, until: (s: GameState) => boolean): readonly string[] {
  const seen: string[] = [];
  let s = from;
  for (let guard = 0; guard < 400 && !until(s) && !s.gameOver; guard++) {
    const next = actWithEvents(s, { kind: 'passPriority', player: s.priorityPlayer }, registry);
    for (const e of eventsNamed(next.events, 'stepBegin')) seen.push(e.step);
    s = next.state;
  }
  return seen;
}

/** Declare `attackers` for the active player, from the declare-attackers step. */
function attackWith(state: GameState, attackers: readonly number[]): GameState {
  const s = advanceTo(state, 'declareAttackers', registry);
  return act(s, { kind: 'declareAttackers', player: s.activePlayer, attackers: [...attackers] }, registry);
}

/** Run combat all the way through the damage step and back to postcombat main. */
function throughCombatDamage(state: GameState): GameState {
  return advanceTo(state, 'postcombatMain', registry);
}

// --- CR 500–505: the phases and steps of a turn ---------------------------------------

describe('CR 500–505 — phases and steps', () => {
  crTest('500.1', 'a turn proceeds through its steps in the printed order', () => {
    const state = atMain();
    const seen = stepsSeen(state, (s) => s.turnNumber === 2 && s.step === 'precombatMain');
    // Everything from beginCombat to the end of A's turn, then B's turn opening.
    const expectedTail = STEP_ORDER.slice(STEP_ORDER.indexOf('beginCombat'));
    expect(seen.slice(0, expectedTail.length)).toEqual([...expectedTail]);
  });

  crTest('502.3', 'no player receives priority during the untap step', () => {
    const state = atMain();
    // Run into the next turn and record every step a priority window opened in.
    let s = state;
    const withPriority = new Set<string>();
    for (let guard = 0; guard < 300 && !(s.turnNumber === 2 && s.step === 'precombatMain'); guard++) {
      withPriority.add(s.step);
      s = pass(s, registry);
    }
    expect(withPriority.has('untap')).toBe(false);
    expect(withPriority.has('upkeep')).toBe(true);
  });

  crTest('502.1', 'the active player untaps their permanents as their turn begins', () => {
    const state = atMain();
    const mine = putOnBattlefield(state, 'A', BEAR, { tapped: true });
    const theirs = putOnBattlefield(state, 'B', BEAR, { tapped: true });
    let s = state;
    for (let guard = 0; guard < 300 && !(s.turnNumber === 2 && s.step === 'upkeep'); guard++) s = pass(s, registry);
    expect(s.activePlayer).toBe('B');
    // B untapped theirs; A's stayed tapped — untapping is the ACTIVE player's.
    expect(onBattlefield(s, theirs.instanceId)?.tapped).toBe(false);
    expect(onBattlefield(s, mine.instanceId)?.tapped).toBe(true);
  });

  crTest('504.1', 'the active player draws a card during their draw step', () => {
    const state = atMain();
    let s = state;
    for (let guard = 0; guard < 300 && !(s.turnNumber === 2 && s.step === 'upkeep'); guard++) s = pass(s, registry);
    const before = s.players.B.hand.length;
    const drawStep = advanceTo(s, 'draw', registry);
    expect(drawStep.players.B.hand.length).toBe(before + 1);
  });

  crTest('505.6b', 'a sorcery may only be cast in the active player’s main phase with an empty stack', () => {
    const sorcery: CardDefinition = { id: 'slow', name: 'Slow', types: ['sorcery'], effects: [{ primitive: 'noop' }] };
    const state = atMain();
    const [card] = giveHand(state, 'A', [sorcery]);
    expect(generateLegalActions(state).some((a) => a.kind === 'castSpell')).toBe(true);

    const inCombat = advanceTo(state, 'declareAttackers', registry);
    expect(generateLegalActions(inCombat).some((a) => a.kind === 'castSpell')).toBe(false);
    expect(rejectionOf(inCombat, { kind: 'castSpell', player: 'A', instanceId: card!.instanceId }, registry)).toMatch(
      /sorcery speed/i,
    );
  });
});

// --- CR 508: declare attackers -----------------------------------------------------------

describe('CR 508 — declare attackers', () => {
  crTest('508.1a', 'only the active player declares attackers', () => {
    const state = atMain();
    const theirs = putOnBattlefield(state, 'B', BEAR);
    const declare = advanceTo(state, 'declareAttackers', registry);
    expect(
      rejectionOf(declare, { kind: 'declareAttackers', player: 'B', attackers: [theirs.instanceId] }, registry),
    ).toMatch(/only the active player/i);
  });

  crTest('508.1a', 'a creature can only be declared as an attacker by the player who controls it', () => {
    const state = atMain();
    const theirs = putOnBattlefield(state, 'B', BEAR);
    const declare = advanceTo(state, 'declareAttackers', registry);
    expect(
      rejectionOf(declare, { kind: 'declareAttackers', player: 'A', attackers: [theirs.instanceId] }, registry),
    ).toMatch(/do not control/i);
  });

  crTest('508.1c', 'a tapped creature cannot be declared as an attacker', () => {
    const state = atMain();
    const tapped = putOnBattlefield(state, 'A', BEAR, { tapped: true });
    const declare = advanceTo(state, 'declareAttackers', registry);
    expect(generateLegalActions(declare).some((a) => a.kind === 'declareAttackers')).toBe(false);
    expect(
      rejectionOf(declare, { kind: 'declareAttackers', player: 'A', attackers: [tapped.instanceId] }, registry),
    ).toMatch(/tapped/i);
  });

  crTest('508.1f', 'declaring an attacker taps it — unless it has vigilance', () => {
    const state = atMain();
    const plain = putOnBattlefield(state, 'A', BEAR);
    const vigilant = putOnBattlefield(state, 'A', VIGILANT);
    const after = attackWith(state, [plain.instanceId, vigilant.instanceId]);
    expect(onBattlefield(after, plain.instanceId)?.tapped).toBe(true);
    expect(onBattlefield(after, vigilant.instanceId)?.tapped).toBe(false);
  });

  crTest('508.1', 'the same creature cannot be declared as an attacker twice', () => {
    const state = atMain();
    const bear = putOnBattlefield(state, 'A', BEAR);
    const declare = advanceTo(state, 'declareAttackers', registry);
    expect(
      rejectionOf(
        declare,
        { kind: 'declareAttackers', player: 'A', attackers: [bear.instanceId, bear.instanceId] },
        registry,
      ),
    ).toMatch(/more than once/i);
  });
});

// --- CR 509: declare blockers -------------------------------------------------------------

describe('CR 509 — declare blockers', () => {
  /** A combat with one attacking Bear, sitting in declare-blockers with the defender on priority. */
  function atDeclareBlockers(state: GameState, attackerId: number): GameState {
    let s = attackWith(state, [attackerId]);
    s = advanceTo(s, 'declareBlockers', registry);
    return givePriorityTo(s, nonActive(s), registry);
  }

  crTest('509.1a', 'only the defending player declares blockers', () => {
    const state = atMain();
    const attacker = putOnBattlefield(state, 'A', BEAR);
    putOnBattlefield(state, 'B', BEAR);
    const s = atDeclareBlockers(state, attacker.instanceId);
    expect(rejectionOf(s, { kind: 'declareBlockers', player: 'A', blocks: [] }, registry)).toMatch(
      /only the defending player/i,
    );
  });

  crTest('509.1a', 'a tapped creature cannot be declared as a blocker', () => {
    const state = atMain();
    const attacker = putOnBattlefield(state, 'A', BEAR);
    const blocker = putOnBattlefield(state, 'B', BEAR, { tapped: true });
    const s = atDeclareBlockers(state, attacker.instanceId);
    expect(
      rejectionOf(
        s,
        {
          kind: 'declareBlockers',
          player: 'B',
          blocks: [{ blocker: blocker.instanceId, attacker: attacker.instanceId }],
        },
        registry,
      ),
    ).toMatch(/cannot block/i);
  });

  crTest('509.1a', 'a creature can only block a creature that is actually attacking', () => {
    const state = atMain();
    const attacker = putOnBattlefield(state, 'A', BEAR);
    const bystander = putOnBattlefield(state, 'A', BEAR);
    const blocker = putOnBattlefield(state, 'B', BEAR);
    const s = atDeclareBlockers(state, attacker.instanceId);
    expect(
      rejectionOf(
        s,
        {
          kind: 'declareBlockers',
          player: 'B',
          blocks: [{ blocker: blocker.instanceId, attacker: bystander.instanceId }],
        },
        registry,
      ),
    ).toMatch(/is not attacking/i);
  });

  crTest('509.1h', 'a blocked creature deals no damage to the defending player, even so', () => {
    const state = atMain();
    const attacker = putOnBattlefield(state, 'A', BEAR);
    const blocker = putOnBattlefield(state, 'B', creatureDef('Wall', 0, 9));
    let s = atDeclareBlockers(state, attacker.instanceId);
    const lifeBefore = s.players.B.life;
    s = act(
      s,
      {
        kind: 'declareBlockers',
        player: 'B',
        blocks: [{ blocker: blocker.instanceId, attacker: attacker.instanceId }],
      },
      registry,
    );
    s = throughCombatDamage(s);
    expect(s.players.B.life).toBe(lifeBefore);
    expect(onBattlefield(s, blocker.instanceId)?.damageMarked).toBe(2);
  });

  crTest('509.1b', 'a blocked creature stays blocked even after its blocker leaves combat', () => {
    // The blocker dies in the first-strike step; without trample the attacker
    // still deals nothing to the player in the normal step.
    const state = atMain();
    const attacker = putOnBattlefield(state, 'A', BEAR);
    const blocker = putOnBattlefield(state, 'B', creatureDef('Fragile', 3, 1, { keywords: { firstStrike: true } }));
    let s = attackWith(state, [attacker.instanceId]);
    s = advanceTo(s, 'declareBlockers', registry);
    s = givePriorityTo(s, nonActive(s), registry);
    const lifeBefore = s.players.B.life;
    s = act(
      s,
      {
        kind: 'declareBlockers',
        player: 'B',
        blocks: [{ blocker: blocker.instanceId, attacker: attacker.instanceId }],
      },
      registry,
    );
    s = throughCombatDamage(s);
    // The 3/1 first-striker killed the 2/2 before it could hit back…
    expect(onBattlefield(s, attacker.instanceId)).toBeUndefined();
    // …and no damage leaked to the defending player.
    expect(s.players.B.life).toBe(lifeBefore);
  });
});

// --- CR 510: combat damage ------------------------------------------------------------------

describe('CR 510 — combat damage', () => {
  crTest('510.1c', 'an unblocked attacker deals its power to the defending player', () => {
    const state = atMain();
    const attacker = putOnBattlefield(state, 'A', BEAR);
    const lifeBefore = state.players.B.life;
    const s = throughCombatDamage(attackWith(state, [attacker.instanceId]));
    expect(s.players.B.life).toBe(lifeBefore - BEAR.power!);
  });

  crTest('510.1a', 'a blocked attacker and its blocker deal damage to each other simultaneously', () => {
    const state = atMain();
    const attacker = putOnBattlefield(state, 'A', creatureDef('Trader', 2, 2));
    const blocker = putOnBattlefield(state, 'B', creatureDef('Trader B', 2, 2));
    let s = attackWith(state, [attacker.instanceId]);
    s = advanceTo(s, 'declareBlockers', registry);
    s = givePriorityTo(s, nonActive(s), registry);
    s = act(
      s,
      {
        kind: 'declareBlockers',
        player: 'B',
        blocks: [{ blocker: blocker.instanceId, attacker: attacker.instanceId }],
      },
      registry,
    );
    s = throughCombatDamage(s);
    // Both are 2/2s dealt 2: BOTH die. A sequential damage step would spare one.
    expect(onBattlefield(s, attacker.instanceId)).toBeUndefined();
    expect(onBattlefield(s, blocker.instanceId)).toBeUndefined();
  });

  crTest('510.4', 'first strike creates a separate, earlier combat damage step', () => {
    const state = atMain();
    const striker = putOnBattlefield(state, 'A', FIRST_STRIKER);
    const blocker = putOnBattlefield(state, 'B', creatureDef('Squishy', 2, 2));
    let s = attackWith(state, [striker.instanceId]);
    s = advanceTo(s, 'declareBlockers', registry);
    s = givePriorityTo(s, nonActive(s), registry);
    s = act(
      s,
      {
        kind: 'declareBlockers',
        player: 'B',
        blocks: [{ blocker: blocker.instanceId, attacker: striker.instanceId }],
      },
      registry,
    );
    s = throughCombatDamage(s);
    // The 2/2 blocker died before it dealt any damage back.
    expect(onBattlefield(s, blocker.instanceId)).toBeUndefined();
    expect(onBattlefield(s, striker.instanceId)?.damageMarked).toBe(0);
  });
});

// --- CR 511 / 514: end of combat and cleanup --------------------------------------------------

describe('CR 511 / 514 — end of combat and cleanup', () => {
  crTest('511.3', 'creatures stop being attackers when combat ends', () => {
    const state = atMain();
    const attacker = putOnBattlefield(state, 'A', BEAR);
    let s = attackWith(state, [attacker.instanceId]);
    expect(s.combat?.attackers).toEqual([attacker.instanceId]);
    // Run to the next turn: the combat record is gone entirely.
    for (let guard = 0; guard < 300 && s.turnNumber === 1; guard++) s = pass(s, registry);
    expect(s.combat === null || (s.combat?.attackers.length ?? 0) === 0).toBe(true);
  });

  crTest('514.2', 'damage marked on permanents is removed as the turn ends', () => {
    const state = atMain();
    const attacker = putOnBattlefield(state, 'A', BEAR);
    const blocker = putOnBattlefield(state, 'B', creatureDef('Wall', 0, 9));
    let s = attackWith(state, [attacker.instanceId]);
    s = advanceTo(s, 'declareBlockers', registry);
    s = givePriorityTo(s, nonActive(s), registry);
    s = act(
      s,
      {
        kind: 'declareBlockers',
        player: 'B',
        blocks: [{ blocker: blocker.instanceId, attacker: attacker.instanceId }],
      },
      registry,
    );
    s = throughCombatDamage(s);
    expect(onBattlefield(s, blocker.instanceId)?.damageMarked).toBe(2);
    for (let guard = 0; guard < 300 && s.turnNumber === 1; guard++) s = pass(s, registry);
    expect(onBattlefield(s, blocker.instanceId)?.damageMarked).toBe(0);
  });

  crTest('514.2', '"until end of turn" effects end during the cleanup step', () => {
    const state = atMain();
    const bear = putOnBattlefield(state, 'A', BEAR);
    const [card] = giveHand(state, 'A', [PUMP]);
    let s = act(
      state,
      { kind: 'castSpell', player: 'A', instanceId: card!.instanceId, targets: [bear.instanceId] },
      registry,
    );
    s = pass(pass(s, registry), registry);
    expect(s.continuous.length).toBe(1);
    // Read through the engine's OWN aggregation, never a hand-built modifier.
    expect(effectiveToughness(onBattlefield(s, bear.instanceId)!, aggregateFor(s, bear.instanceId))).toBe(
      BEAR.toughness! + PUMP_AMOUNT,
    );

    for (let guard = 0; guard < 300 && s.turnNumber === 1; guard++) s = pass(s, registry);
    expect(s.continuous).toHaveLength(0);
    expect(effectiveToughness(onBattlefield(s, bear.instanceId)!, aggregateFor(s, bear.instanceId))).toBe(
      BEAR.toughness!,
    );
  });

  crTest('514.3', 'no player receives priority during the cleanup step', () => {
    const state = atMain();
    let s = state;
    const withPriority = new Set<string>();
    for (let guard = 0; guard < 300 && !(s.turnNumber === 2 && s.step === 'precombatMain'); guard++) {
      withPriority.add(s.step);
      s = pass(s, registry);
    }
    expect(withPriority.has('cleanup')).toBe(false);
    expect(withPriority.has('end')).toBe(true);
  });

  crTest('500.4', 'each player’s mana pool empties as a step ends', () => {
    const state = atMain();
    const land = putOnBattlefield(state, 'A', MOUNTAIN);
    let s = act(state, { kind: 'tapForMana', player: 'A', instanceId: land.instanceId }, registry);
    expect(s.players.A.manaPool.R).toBe(1);
    s = pass(pass(s, registry), registry);
    expect(s.players.A.manaPool.R ?? 0).toBe(0);
  });
});

// --- turn hand-off ----------------------------------------------------------------------------

describe('CR 500 — turn hand-off', () => {
  crTest('500.7', 'the turn passes to the other player after cleanup', () => {
    const state = atMain();
    const first: PlayerId = state.activePlayer;
    let s = state;
    for (let guard = 0; guard < 300 && s.turnNumber === 1; guard++) s = pass(s, registry);
    expect(s.turnNumber).toBe(2);
    expect(s.activePlayer).not.toBe(first);
  });

  crTest('505.5a', 'each player’s land drop resets as their turn begins', () => {
    const state = atMain();
    const [land] = giveHand(state, 'A', [MOUNTAIN]);
    let s = act(state, { kind: 'playLand', player: 'A', instanceId: land!.instanceId }, registry);
    expect(s.players.A.landsPlayedThisTurn).toBe(1);
    for (let guard = 0; guard < 400 && !(s.turnNumber === 3 && s.step === 'precombatMain'); guard++) {
      s = pass(s, registry);
    }
    expect(s.activePlayer).toBe('A');
    expect(s.players.A.landsPlayedThisTurn).toBe(0);
  });
});

assertFileMatchesManifest(FILE);
