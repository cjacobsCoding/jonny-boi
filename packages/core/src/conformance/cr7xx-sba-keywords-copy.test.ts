/**
 * CONFORMANCE — CR 7xx: state-based actions (704), keyword abilities (702),
 * the interaction of continuous effects (613), and the two sections this engine
 * does not implement at all (707 copying, 615/616 prevention).
 *
 * This file exists for the rules the per-feature suites do NOT reach. Everything
 * an existing suite already affirms properly is CITED from `rules-manifest.ts`
 * rather than copied here — `sba.test.ts`, `legend-rule.test.ts`,
 * `attachments.test.ts`, `indestructible.test.ts` and `statics.test.ts` between
 * them cover most of 704.5, and a second copy of a good test is a maintenance
 * cost with no new information (TESTING.md).
 *
 * Two of the tests below are **GAP PINS** rather than affirmations. They assert
 * what the engine does TODAY where that differs from the Comprehensive Rules,
 * so the day somebody implements the rule the pin goes red and tells them to
 * reclassify the section. The repo already uses this idiom deliberately — see
 * `packages/cards/src/pool-mechanics.test.ts`, where absent mechanics are
 * asserted absent WITH their reasons "so whoever closes one gets told by the
 * suite". A pin is never counted as coverage; the manifest files it under the
 * section's `gap`.
 */

import { describe, expect } from 'vitest';
import {
  MINUS_ONE_COUNTER,
  PLUS_ONE_COUNTER,
  createGame,
  aggregateFor,
  effectivePower,
  effectiveToughness,
  effectiveWardOf,
  type CardDefinition,
  type CardInstance,
  type GameAction,
  type GameState,
  type PlayerId,
} from '../index.js';
import { creatureDef, deckOf, giveHand, landDef } from '../test-fixtures.js';
import {
  act,
  advanceTo,
  assertFileMatchesManifest,
  crTest,
  newGame,
  nonActive,
  onBattlefield,
  pass,
  putOnBattlefield,
  registryWith,
} from './harness.js';

const FILE = 'cr7xx-sba-keywords-copy';

const MOUNTAIN = landDef('Mountain', 'R');
const BEAR = creatureDef('Bear', 2, 2);

/** A 3/3 with ward {2} — the fixture CR 702.21 is measured on. */
const WARDED: CardDefinition = {
  ...creatureDef('Warded Sentry', 3, 3),
  keywords: { ward: 2 },
};

/** "Deal 2 damage to target creature" — a real targeted spell, for ward. */
const SHOCK: CardDefinition = {
  id: 'shock',
  name: 'Shock',
  types: ['instant'],
  cost: { generic: 1 },
  effects: [{ primitive: 'shockTarget', params: {} }],
};

/** "Target player loses all their life." */
const DRAIN: CardDefinition = {
  id: 'drain-7xx',
  name: 'Drain',
  types: ['sorcery'],
  effects: [{ primitive: 'drainOpponent' }],
};

/** "Each creature gets -3/-3 until end of turn" — reaches 704.5f, not 704.5g. */
const WITHER: CardDefinition = {
  id: 'wither-7xx',
  name: 'Wither',
  types: ['sorcery'],
  effects: [{ primitive: 'witherAll' }],
};

const registry = registryWith({
  shockTarget: (ctx) => {
    const victim = ctx.state.battlefield.find((c) => c.instanceId === ctx.targets?.[0]);
    if (!victim) return;
    victim.damageMarked += 2;
    ctx.emit({ type: 'damageDealt', source: ctx.source.instanceId, target: victim.instanceId, amount: 2, combat: false });
  },
  drainOpponent: (ctx) => {
    const victim = ctx.controller === 'A' ? 'B' : 'A';
    const before = ctx.state.players[victim].life;
    ctx.state.players[victim].life = 0;
    ctx.emit({ type: 'lifeChanged', player: victim, delta: -before, to: 0 });
  },
  witherAll: (ctx) => {
    for (const perm of ctx.state.battlefield) {
      if (!perm.def.types.includes('creature')) continue;
      ctx.state.continuous.push({
        id: ctx.state.nextInstanceId++,
        targetInstanceId: perm.instanceId,
        sourceInstanceId: ctx.source.instanceId,
        duration: 'endOfTurn',
        power: -3,
        toughness: -3,
      });
    }
  },
});

/** A game sitting in A's precombat main with both hands emptied. */
function atMain(seed = 11): GameState {
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

/** Both players pass — resolving the top of the stack, or advancing the step. */
function bothPass(state: GameState): GameState {
  return pass(pass(state, registry), registry);
}

/** Cast a free spell from A's hand and resolve it. */
function castAndResolve(state: GameState, def: CardDefinition): GameState {
  const [card] = giveHand(state, 'A', [def]);
  const cast = act(state, { kind: 'castSpell', player: 'A', instanceId: card!.instanceId }, registry);
  return bothPass(cast);
}

// --- CR 704: state-based actions -------------------------------------------------

/**
 * Every CR 704.5 condition this engine models, evaluated against a state.
 *
 * Deliberately written as a QUESTION about the board rather than by calling the
 * engine's own `checkStateBasedActions` — asking the implementation whether it
 * agrees with itself proves nothing (TESTING.md, "Test against the REAL
 * vocabulary"). These read the same public accessors a card would.
 */
function outstandingSbaConditions(state: GameState): string[] {
  const found: string[] = [];
  for (const player of ['A', 'B'] as const) {
    // 704.5a — a player with 0 or less life loses the game.
    if (state.players[player].life <= 0 && !state.players[player].hasLost) {
      found.push(`704.5a: ${player} is at ${state.players[player].life} and has not lost`);
    }
  }
  for (const perm of state.battlefield) {
    if (!perm.def.types.includes('creature')) continue;
    const mod = aggregateFor(state, perm.instanceId);
    const toughness = effectiveToughness(perm, mod);
    // 704.5f — toughness 0 or less: put into the graveyard. Not destruction, so
    // indestructible does not exempt it.
    if (toughness <= 0) {
      found.push(`704.5f: ${perm.def.name} has toughness ${toughness} and is still here`);
    }
    // 704.5g — lethal damage marked: destroyed. Indestructible DOES exempt it,
    // so a creature with the keyword is not a violation.
    const indestructible = perm.def.keywords?.indestructible === true;
    if (!indestructible && toughness > 0 && perm.damageMarked >= toughness) {
      found.push(`704.5g: ${perm.def.name} has lethal damage marked and is still here`);
    }
  }
  return found;
}

describe('CR 704 — state-based actions', () => {
  crTest('704.3', 'no state-based action is left outstanding while a player holds priority', () => {
    // A scripted game that actually CREATES each condition — creatures trade in
    // combat, a sweeper shrinks a board below zero toughness, a drain empties a
    // life total — with the invariant asserted after every single action. An
    // invariant test over a game where nothing ever happens is the failure shape
    // this repo records most often, so the run is asserted to have produced the
    // conditions it means to police.
    let state = atMain();
    let checks = 0;
    let deaths = 0;
    const step = (action: GameAction): void => {
      state = act(state, action, registry);
      checks++;
      if (state.pendingChoice) return; // a parked question is not a priority window
      expect(outstandingSbaConditions(state)).toEqual([]);
    };

    // Two creatures each, then a real combat that kills both attackers.
    const aBear = putOnBattlefield(state, 'A', BEAR);
    const bBear = putOnBattlefield(state, 'B', BEAR);
    state = advanceTo(state, 'declareAttackers', registry);
    step({ kind: 'declareAttackers', player: 'A', attackers: [aBear.instanceId] });
    state = advanceTo(state, 'declareBlockers', registry);
    step({
      kind: 'declareBlockers',
      player: nonActive(state),
      blocks: [{ blocker: bBear.instanceId, attacker: aBear.instanceId }],
    });
    // Pass through the damage step, checking the invariant at every window.
    for (let guard = 0; guard < 40 && state.step !== 'postcombatMain'; guard++) {
      step({ kind: 'passPriority', player: state.priorityPlayer });
    }
    if (!onBattlefield(state, aBear.instanceId)) deaths++;
    if (!onBattlefield(state, bBear.instanceId)) deaths++;

    // Now a 0-toughness sweep on a fresh board (704.5f, a different SBA branch).
    const survivor = putOnBattlefield(state, 'A', BEAR);
    state = castAndResolve(state, WITHER);
    checks++;
    expect(outstandingSbaConditions(state)).toEqual([]);
    if (!onBattlefield(state, survivor.instanceId)) deaths++;

    // The run has to have EXERCISED the rule, not merely walked past it.
    expect(deaths).toBeGreaterThanOrEqual(3);
    expect(checks).toBeGreaterThan(5);
  });

  crTest('704.5a', 'a player reduced to 0 life loses as the spell that did it finishes resolving', () => {
    const state = atMain();
    expect(state.gameOver).toBe(false);
    const after = castAndResolve(state, DRAIN);
    expect(after.players.B.life).toBe(0);
    expect(after.players.B.hasLost).toBe(true);
    expect(after.gameOver).toBe(true);
  });

  crTest('704.5f', 'a creature at 0 or less toughness is put into the graveyard, not destroyed', () => {
    const state = atMain();
    const bear = putOnBattlefield(state, 'A', BEAR);
    // Indestructible does NOT exempt 704.5f: it is not destruction.
    const rock = putOnBattlefield(state, 'B', {
      ...creatureDef('Rock', 2, 2),
      keywords: { indestructible: true },
    });
    const after = castAndResolve(state, WITHER); // -3/-3 to every creature
    expect(onBattlefield(after, bear.instanceId)).toBeUndefined();
    expect(onBattlefield(after, rock.instanceId)).toBeUndefined();
    expect(after.players.A.graveyard.some((c) => c.instanceId === bear.instanceId)).toBe(true);
  });

  crTest('704.5g', 'a creature with lethal damage marked is destroyed at the next check', () => {
    const state = atMain();
    const oneOne = putOnBattlefield(state, 'B', creatureDef('Squire', 1, 1));
    const threeThree = putOnBattlefield(state, 'B', creatureDef('Ogre', 3, 3));
    const [shock] = giveHand(state, 'A', [SHOCK]);
    const land = putOnBattlefield(state, 'A', MOUNTAIN);
    let s = act(state, { kind: 'tapForMana', player: 'A', instanceId: land.instanceId }, registry);
    s = act(
      s,
      { kind: 'castSpell', player: 'A', instanceId: shock!.instanceId, targets: [oneOne.instanceId] },
      registry,
    );
    // Ward would interpose a trigger; this fixture has none, so one round of
    // passes resolves the Shock itself.
    s = bothPass(s);
    expect(onBattlefield(s, oneOne.instanceId)).toBeUndefined();
    // 2 damage is not lethal to a 3/3 — it is MARKED and the creature lives.
    expect(onBattlefield(s, threeThree.instanceId)).toBeDefined();
  });

  crTest('704.5q', 'GAP PIN — +1/+1 and -1/-1 counters are netted arithmetically, never REMOVED', () => {
    // CR 704.5q: "If a permanent has both a +1/+1 counter and a -1/-1 counter on
    // it, N +1/+1 and N -1/-1 counters are removed from it," where N is the
    // smaller of the two counts. This engine has no such state-based action —
    // `internal/stats.ts`'s `counterShift` subtracts the two tallies, which gives
    // the RIGHT power and toughness while leaving both counters sitting on the
    // permanent. Nothing in the shipped pool can ask "does this have a -1/-1
    // counter on it?", so the difference is currently unobservable in play; it
    // stops being unobservable the moment a card removes or counts one kind.
    //
    // This pin asserts the CURRENT behaviour. When 704.5q is implemented it goes
    // red — which is the signal to move section 704's manifest entry off `gap`.
    const state = newGame();
    const bear = putOnBattlefield(state, 'A', BEAR, {
      counters: { [PLUS_ONE_COUNTER]: 2, [MINUS_ONE_COUNTER]: 1 },
    });
    // The arithmetic is right…
    expect(effectivePower(bear)).toBe(BEAR.power! + 1);
    expect(effectiveToughness(bear)).toBe(BEAR.toughness! + 1);
    // …and both counters are still physically present, which CR 704.5q forbids.
    const after = bothPass(state);
    const still = onBattlefield(after, bear.instanceId);
    expect(still?.counters[PLUS_ONE_COUNTER]).toBe(2);
    expect(still?.counters[MINUS_ONE_COUNTER]).toBe(1);
  });
});

// --- CR 702: keyword abilities the per-feature suites do not drive ----------------

describe('CR 702 — ward', () => {
  /** Put A's Shock on the stack aimed at `target`, with the mana already paid. */
  function shockAt(state: GameState, target: CardInstance): GameState {
    const [shock] = giveHand(state, 'A', [SHOCK]);
    const land = putOnBattlefield(state, 'A', MOUNTAIN);
    let s = act(state, { kind: 'tapForMana', player: 'A', instanceId: land.instanceId }, registry);
    return act(
      s,
      { kind: 'castSpell', player: 'A', instanceId: shock!.instanceId, targets: [target.instanceId] },
      registry,
    );
  }

  crTest('702.21', 'targeting an opponent’s warded permanent puts its ward trigger above the spell', () => {
    const state = atMain();
    const sentry = putOnBattlefield(state, 'B', WARDED);
    expect(effectiveWardOf(state, sentry)).toBe(2);

    const s = shockAt(state, sentry);
    // The spell is on the stack, and the ward trigger is ABOVE it — so the ward
    // resolves first and can counter the spell before it ever gets to resolve.
    expect(s.stack).toHaveLength(2);
    expect(s.stack[0]?.kind).toBe('spell');
    const top = s.stack[1];
    expect(top?.kind).toBe('trigger');
    expect((top as { controller: PlayerId }).controller).toBe('B');
    expect((top as { sourceInstanceId: number }).sourceInstanceId).toBe(sentry.instanceId);
  });

  crTest('702.21', 'a permanent’s own controller never triggers its ward', () => {
    // Ward reads "whenever this becomes the target of a spell or ability an
    // OPPONENT controls" — aiming your own removal at your own warded creature
    // costs nothing.
    const state = atMain();
    const mine = putOnBattlefield(state, 'A', WARDED);
    const s = shockAt(state, mine);
    expect(s.stack).toHaveLength(1);
    expect(s.stack[0]?.kind).toBe('spell');
  });
});

// --- CR 613: interaction of continuous effects ------------------------------------

describe('CR 613 — interaction of continuous effects', () => {
  crTest('613.4c', 'counters and P/T-modifying effects combine additively over the printed base', () => {
    const state = newGame();
    const bear = putOnBattlefield(state, 'A', BEAR, { counters: { [PLUS_ONE_COUNTER]: 1 } });
    state.continuous.push({
      id: state.nextInstanceId++,
      targetInstanceId: bear.instanceId,
      sourceInstanceId: bear.instanceId,
      duration: 'endOfTurn',
      power: 2,
      toughness: 2,
    });
    // Printed 2/2, one +1/+1 counter, one +2/+2 effect — all inside CR 613's
    // layer 7c, which is a sum.
    const after = bothPass(state);
    const it = onBattlefield(after, bear.instanceId)!;
    const mod = aggregateFor(after, it.instanceId);
    expect(effectivePower(it, mod)).toBe(BEAR.power! + 1 + 2);
    expect(effectiveToughness(it, mod)).toBe(BEAR.toughness! + 1 + 2);
  });

  crTest('613.7', 'timestamp order cannot change the result, because every modification is additive', () => {
    // CR 613.7 orders effects within a layer by timestamp. This engine has no
    // timestamp machinery — and does not need one WHILE every modification it can
    // express is a sum or a boolean OR, both of which are commutative. That "while"
    // is the honest boundary, and `MODIFICATION_IS_PURELY_ADDITIVE` in
    // `rules-manifest.ts` is the compile-time proof that it still holds.
    //
    // The test applies the same two effects in both orders and requires the same
    // answer. If a *setting* effect is ever added ("becomes a 1/1"), the two
    // orders diverge and this goes red alongside the type proof.
    const build = (order: readonly (readonly [number, number])[]): { power: number; toughness: number } => {
      const state = newGame();
      const bear = putOnBattlefield(state, 'A', BEAR);
      for (const [power, toughness] of order) {
        state.continuous.push({
          id: state.nextInstanceId++,
          targetInstanceId: bear.instanceId,
          sourceInstanceId: bear.instanceId,
          duration: 'endOfTurn',
          power,
          toughness,
        });
      }
      const inst = onBattlefield(state, bear.instanceId)!;
      const mod = aggregateFor(state, inst.instanceId);
      return { power: effectivePower(inst, mod), toughness: effectiveToughness(inst, mod) };
    };
    const forwards = build([
      [3, 0],
      [-1, 4],
    ]);
    const backwards = build([
      [-1, 4],
      [3, 0],
    ]);
    expect(forwards).toEqual(backwards);
    expect(forwards.power).toBe(BEAR.power! + 3 - 1);
    expect(forwards.toughness).toBe(BEAR.toughness! + 4);
  });
});

assertFileMatchesManifest(FILE);
