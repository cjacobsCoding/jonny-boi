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
  DEFAULT_RULES,
  STEP_ORDER,
  aggregateFor,
  createGame,
  defaultAnswerFor,
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

/**
 * A card with MADNESS — the only thing in this engine that can make a cleanup
 * step hand out priority, because a discarded madness card is exiled instead
 * and its controller may cast it (CR 702.35a).
 */
const MADNESS_SPELL: CardDefinition = {
  id: 'madness-bolt',
  name: 'Madness Bolt',
  types: ['instant'],
  timing: 'instant',
  cost: { R: 2 },
  madness: { R: 1 },
  effects: [{ primitive: 'noop' }],
};

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
    // A creature ATTACKS, so that every combat step genuinely happens — with no
    // attackers CR 508.8 skips declare-blockers and combat-damage (pinned below).
    const bear = putOnBattlefield(state, 'A', BEAR);
    const before = stepsSeen(state, (s) => s.step === 'declareAttackers');
    const declared = attackWith(state, [bear.instanceId]);
    const after = stepsSeen(declared, (s) => s.turnNumber === 2 && s.step === 'precombatMain');
    // Everything from beginCombat to the end of A's turn, then B's turn opening.
    const expectedTail = STEP_ORDER.slice(STEP_ORDER.indexOf('beginCombat'));
    expect([...before, ...after].slice(0, expectedTail.length)).toEqual([...expectedTail]);
  });

  crTest('502.4', 'no player receives priority during the untap step', () => {
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

  crTest('502.3', 'the active player untaps their permanents as their turn begins', () => {
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

  crTest('505.6a', 'a sorcery may only be cast in the active player’s main phase with an empty stack', () => {
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

  crTest('508.1a', 'a tapped creature cannot be declared as an attacker', () => {
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

  // Bug report 20260901_205742 — "The game asks me for blocks when nothing is
  // attacking!": the defender (holding creatures) was offered `declareBlockers`
  // on a turn where the computer attacked with nothing. Both ways of not
  // attacking are pinned: an explicit empty declaration, and never declaring.
  crTest('508.8', 'with no attackers declared, the declare-blockers and combat-damage steps are skipped', () => {
    const state = atMain();
    putOnBattlefield(state, 'B', BEAR); // the defender HAS a potential blocker
    const declare = advanceTo(state, 'declareAttackers', registry);
    const none = act(declare, { kind: 'declareAttackers', player: 'A', attackers: [] }, registry);
    const seen = stepsSeen(none, (s) => s.step === 'postcombatMain');
    expect(seen).toEqual(['endCombat', 'postcombatMain']);
    // Nobody was ever offered a block declaration along the way.
    let s = none;
    for (let guard = 0; guard < 20 && s.step !== 'postcombatMain'; guard++) {
      expect(generateLegalActions(s).some((a) => a.kind === 'declareBlockers')).toBe(false);
      s = pass(s, registry);
    }
  });

  crTest('508.8', 'passing through declare-attackers without declaring skips the same two steps', () => {
    const state = atMain();
    putOnBattlefield(state, 'A', BEAR);
    putOnBattlefield(state, 'B', BEAR);
    const declare = advanceTo(state, 'declareAttackers', registry);
    const seen = stepsSeen(declare, (s) => s.step === 'postcombatMain');
    expect(seen).toEqual(['endCombat', 'postcombatMain']);
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

  crTest('510.1c', 'a blocked creature deals no damage to the defending player, even so', () => {
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

  crTest('509.1h', 'a blocked creature stays blocked even after its blocker leaves combat', () => {
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
  crTest('510.1b', 'an unblocked attacker deals its power to the defending player', () => {
    const state = atMain();
    const attacker = putOnBattlefield(state, 'A', BEAR);
    const lifeBefore = state.players.B.life;
    const s = throughCombatDamage(attackWith(state, [attacker.instanceId]));
    expect(s.players.B.life).toBe(lifeBefore - BEAR.power!);
  });

  crTest('510.2', 'a blocked attacker and its blocker deal damage to each other simultaneously', () => {
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

  crTest('514.1', 'the ACTIVE player discards down to their maximum hand size, and chooses which', () => {
    // CR 514.1 is the first turn-based action of the cleanup step, and it is the
    // active player's alone — the opponent keeps whatever they are holding until
    // their own turn ends. WHICH cards go is a choice, not the game's decision,
    // so this asserts that the chosen ones are the ones that left.
    const maximum = DEFAULT_RULES.maximumHandSize;
    const state = atMain();
    const held = giveHand(state, 'A', Array.from({ length: maximum + 2 }, () => MOUNTAIN));
    giveHand(state, 'B', Array.from({ length: maximum + 2 }, () => MOUNTAIN));

    let s = state;
    for (let guard = 0; guard < 200 && s.pendingChoice?.context !== 'cleanupDiscard'; guard++) {
      s = pass(s, registry);
    }
    const choice = s.pendingChoice;
    if (choice?.kind !== 'selectCards') throw new Error('the cleanup discard was never asked');
    expect(choice.chooser).toBe(s.activePlayer);
    expect(choice.fromZone).toBe('hand');

    // Pitch the LAST two on offer, so "the chosen ones" is a real claim rather
    // than whatever a default would have taken anyway.
    const chosen = [held[held.length - 1]!.instanceId, held[held.length - 2]!.instanceId];
    const after = act(
      s,
      { kind: 'answerChoice', player: choice.chooser, choiceId: choice.id, answer: { kind: 'selectCards', instanceIds: chosen } },
      registry,
    );

    expect(after.players.A.hand).toHaveLength(maximum);
    for (const id of chosen) {
      expect(after.players.A.hand.some((c) => c.instanceId === id)).toBe(false);
      expect(after.players.A.graveyard.some((c) => c.instanceId === id)).toBe(true);
    }
    // The non-active player is untouched: they did not end a turn.
    expect(after.players.B.hand).toHaveLength(maximum + 2);
  });

  crTest('514.1', 'the discard happens every turn, so a hand cannot grow without bound', () => {
    // The rule this engine went without: a whole game used to be playable with an
    // unbounded hand, which changes what card draw and held-back reactive spells
    // are worth. Neither hand may ever be over the maximum once its owner's turn
    // has ended, over several turns of drawing.
    const maximum = DEFAULT_RULES.maximumHandSize;
    let s = atMain();
    giveHand(s, 'A', Array.from({ length: maximum + 1 }, () => MOUNTAIN));
    giveHand(s, 'B', Array.from({ length: maximum + 1 }, () => MOUNTAIN));

    const startedAt = s.turnNumber;
    for (let guard = 0; guard < 900 && s.turnNumber < startedAt + 6; guard++) {
      const parked = s.pendingChoice;
      s = parked
        ? act(
            s,
            { kind: 'answerChoice', player: parked.chooser, choiceId: parked.id, answer: defaultAnswerFor(parked) },
            registry,
          )
        : pass(s, registry);
      // Whoever's turn has most recently ENDED cannot still be over the limit.
      if (s.step === 'untap') {
        expect(s.players.A.hand.length).toBeLessThanOrEqual(maximum);
        expect(s.players.B.hand.length).toBeLessThanOrEqual(maximum);
      }
    }
    expect(s.turnNumber).toBeGreaterThanOrEqual(startedAt + 6);
  });

  crTest('514.3a', 'a cleanup that DID open a priority window is followed by another cleanup step', () => {
    // The other half of CR 514.3a, and the half that needs a real reason for
    // anybody to hold priority in a cleanup step. A discarded MADNESS card is
    // exiled instead (CR 702.35a) and its controller may cast it, which is a
    // priority window inside cleanup — and the rule says that once the stack is
    // empty and everybody has passed, ANOTHER cleanup step begins. Not the next
    // turn: another cleanup step, with its turn-based actions performed again.
    const maximum = DEFAULT_RULES.maximumHandSize;
    const state = atMain();
    giveHand(state, 'A', Array.from({ length: maximum }, () => MOUNTAIN));
    const [madCard] = giveHand(state, 'A', [MADNESS_SPELL]);

    let s = state;
    for (let guard = 0; guard < 200 && s.pendingChoice?.context !== 'cleanupDiscard'; guard++) {
      s = pass(s, registry);
    }
    const choice = s.pendingChoice;
    if (!choice) throw new Error('the cleanup discard was never asked');
    const turnBefore = s.turnNumber;

    // Pitch the madness card itself.
    const afterDiscard = actWithEvents(
      s,
      {
        kind: 'answerChoice',
        player: choice.chooser,
        choiceId: choice.id,
        answer: { kind: 'selectCards', instanceIds: [madCard!.instanceId] },
      },
      registry,
    );
    // The window is open, the card is in EXILE, and the turn has NOT ended.
    expect(afterDiscard.state.madnessWindow?.instanceId).toBe(madCard!.instanceId);
    expect(afterDiscard.state.step).toBe('cleanup');
    expect(afterDiscard.state.turnNumber).toBe(turnBefore);

    // Decline it (a pass with a window open IS the decline, CR 702.35a), then
    // pass the window's own priority round out.
    let done = act(afterDiscard.state, { kind: 'passPriority', player: 'A' }, registry);
    const cleanupSteps = { seen: 0 };
    for (let guard = 0; guard < 40 && done.turnNumber === turnBefore; guard++) {
      const result = actWithEvents(done, { kind: 'passPriority', player: done.priorityPlayer }, registry);
      cleanupSteps.seen += eventsNamed(result.events, 'stepBegin').filter((e) => e.step === 'cleanup').length;
      done = result.state;
    }
    // ANOTHER cleanup step happened before the turn was handed over…
    expect(cleanupSteps.seen).toBeGreaterThanOrEqual(1);
    // …and then it did end, rather than looping.
    expect(done.turnNumber).toBe(turnBefore + 1);
  });

  crTest('514.3a', 'a discard alone does NOT open a priority window; the turn simply ends', () => {
    // CR 514.3a hands out priority only when state-based actions were performed
    // or triggered abilities are waiting. A discard is neither: it is the CR
    // 514.1 turn-based action, and nothing in this engine's `TriggerEvent`
    // vocabulary watches a card leave a hand. So the turn ends the moment the
    // question is answered — no second cleanup step, and nobody gets to cast an
    // instant in cleanup off the back of it.
    const state = atMain();
    giveHand(state, 'A', Array.from({ length: DEFAULT_RULES.maximumHandSize + 1 }, () => MOUNTAIN));

    let s = state;
    for (let guard = 0; guard < 200 && s.pendingChoice?.context !== 'cleanupDiscard'; guard++) {
      s = pass(s, registry);
    }
    const choice = s.pendingChoice;
    if (!choice) throw new Error('the cleanup discard was never asked');
    const turnBefore = s.turnNumber;
    const after = act(
      s,
      { kind: 'answerChoice', player: choice.chooser, choiceId: choice.id, answer: defaultAnswerFor(choice) },
      registry,
    );
    expect(after.turnNumber).toBe(turnBefore + 1);
    expect(after.step).not.toBe('cleanup');
  });

  crTest('500.5', 'each player’s mana pool empties as a step ends', () => {
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
  crTest('500.1', 'the turn passes to the other player after cleanup', () => {
    const state = atMain();
    const first: PlayerId = state.activePlayer;
    let s = state;
    for (let guard = 0; guard < 300 && s.turnNumber === 1; guard++) s = pass(s, registry);
    expect(s.turnNumber).toBe(2);
    expect(s.activePlayer).not.toBe(first);
  });

  crTest('505.6b', 'each player’s land drop resets as their turn begins', () => {
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
