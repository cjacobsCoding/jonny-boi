/**
 * CONFORMANCE — CR 6xx (spells, abilities and effects).
 *
 * This chapter is where a rules engine's "it worked when I tried it" bugs live:
 * casting steps that happen in the wrong order (601.2), a cost refunded when the
 * spell is answered (602.2), a trigger that fires at the wrong moment or picks
 * its targets at the wrong moment (603), a loyalty ability that can be used
 * twice (606.3), and a replacement effect applied after the event instead of
 * instead of it (614).
 *
 * The stack ORDER rules themselves live in `cr4xx-zones.test.ts` with the stack
 * zone; here we test what putting things on it and taking them off must obey.
 */

import { describe, expect } from 'vitest';
import {
  LOYALTY_COUNTER,
  createGame,
  generateLegalActions,
  loyaltyOf,
  poolTotal,
  type CardDefinition,
  type GameState,
  type InstanceId,
} from '../index.js';
import { creatureDef, deckOf, giveHand, landDef } from '../test-fixtures.js';
import {
  act,
  actWithEvents,
  advanceTo,
  assertFileMatchesManifest,
  crTest,
  eventsNamed,
  onBattlefield,
  pass,
  putOnBattlefield,
  registryWith,
  rejectionOf,
} from './harness.js';

const FILE = 'cr6xx-spells-and-abilities';

const MOUNTAIN = landDef('Mountain', 'R');
const BEAR = creatureDef('Bear', 2, 2);

/** Order marks appended by the `log` primitive, so effect ORDER is observable. */
const orderLog: string[] = [];

/** A creature whose ETB trigger pings the opponent for 2 — an untargeted trigger. */
const PINGER: CardDefinition = {
  ...creatureDef('Pinger', 1, 1, { cost: { generic: 1 } }),
  triggers: [
    {
      condition: { on: 'etb' },
      effects: [{ primitive: 'pingOpponent', params: { amount: 2 } }],
      label: 'when ~ enters, deal 2 damage',
    },
  ],
};

/**
 * An ARTIFACT whose ETB trigger shrinks TARGET creature (CR 603.3d).
 *
 * Deliberately not a creature: that keeps the only legal target on the board the
 * one the test put there, so the aiming is unambiguous and the assertion is about
 * WHEN the target is chosen rather than about which of two it picked.
 */
const TARGETED_PINGER: CardDefinition = {
  id: 'targeted-pinger',
  name: 'Targeted Pinger',
  types: ['artifact'],
  cost: { generic: 1 },
  triggers: [
    {
      condition: { on: 'etb' },
      targets: 'creature',
      effects: [{ primitive: 'shrinkTarget' }],
      label: 'when ~ enters, it shrinks target creature',
    },
  ],
};

/** A permanent that always enters tapped — CR 614's simplest replacement effect. */
const TAPLAND: CardDefinition = { ...landDef('Tapland', 'R'), id: 'tapland', entersTapped: true };

/** A sorcery whose two effects must run in the printed order. */
const TWO_STEP: CardDefinition = {
  id: 'two-step',
  name: 'Two Step',
  types: ['sorcery'],
  effects: [
    { primitive: 'log', params: { tag: 'first' } },
    { primitive: 'log', params: { tag: 'second' } },
  ],
};

/** A permanent with a "{1}: do nothing" ability and a "{T}, sacrifice" one. */
const ENGINE: CardDefinition = {
  id: 'engine',
  name: 'Engine',
  types: ['artifact'],
  cost: { generic: 1 },
  activated: [
    { cost: { mana: { generic: 1 } }, effects: [{ primitive: 'log', params: { tag: 'engine' } }], label: '{1}: log' },
    { cost: { tap: true }, timing: 'sorcery', effects: [{ primitive: 'noop' }], label: '{T}, sorcery-speed: nothing' },
  ],
};

/** A 3-loyalty walker with one plus and one big minus ability. */
const WALKER: CardDefinition = {
  id: 'conformance-walker',
  name: 'Conformance Walker',
  types: ['planeswalker'],
  cost: { generic: 3 },
  loyalty: 3,
  activated: [
    { cost: { loyalty: 1 }, timing: 'sorcery', effects: [{ primitive: 'noop' }], label: '+1' },
    { cost: { loyalty: -6 }, timing: 'sorcery', effects: [{ primitive: 'noop' }], label: '-6' },
  ],
};

const registry = registryWith({
  noop: () => {},
  log: (ctx) => {
    const tag = ctx.params.tag as string | undefined;
    if (tag) orderLog.push(tag);
  },
  pingOpponent: (ctx) => {
    const amount = (ctx.params.amount as number | undefined) ?? 1;
    const victim = ctx.controller === 'A' ? 'B' : 'A';
    ctx.state.players[victim].life -= amount;
    ctx.emit({ type: 'lifeChanged', player: victim, delta: -amount, to: ctx.state.players[victim].life });
  },
  shrinkTarget: (ctx) => {
    const target = ctx.targets[0];
    if (typeof target !== 'number') return;
    ctx.addContinuousEffect({ target, power: -1, toughness: -1, duration: 'endOfTurn' });
  },
});

/** A game sitting in A's precombat main, hands emptied. */
function atMain(seed = 31): GameState {
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

/** Put `n` Mountains onto A's battlefield and float that much red mana. */
function withRedMana(state: GameState, n: number): GameState {
  let s = state;
  for (let i = 0; i < n; i++) {
    const land = putOnBattlefield(s, 'A', MOUNTAIN);
    s = act(s, { kind: 'tapForMana', player: 'A', instanceId: land.instanceId }, registry);
  }
  return s;
}

function bothPass(state: GameState): GameState {
  return pass(pass(state, registry), registry);
}

/** Resolve everything currently on the stack (each object takes one pass round). */
function resolveStack(state: GameState): GameState {
  let s = state;
  for (let guard = 0; guard < 20 && s.stack.length > 0; guard++) s = bothPass(s);
  return s;
}

// --- CR 601: casting a spell ---------------------------------------------------------

describe('CR 601 — casting a spell', () => {
  crTest('601.2a', 'casting moves the card from its zone to the stack before anything else happens', () => {
    const state = atMain();
    const [card] = giveHand(state, 'A', [BEAR]);
    const s = withRedMana(state, 1);
    const after = act(s, { kind: 'castSpell', player: 'A', instanceId: card!.instanceId }, registry);
    expect(after.players.A.hand.some((c) => c.instanceId === card!.instanceId)).toBe(false);
    expect(after.stack.map((o) => o.instanceId)).toEqual([card!.instanceId]);
    // It is a SPELL on the stack, not yet a permanent.
    expect(onBattlefield(after, card!.instanceId)).toBeUndefined();
  });

  crTest('601.2c', 'a spell’s targets are chosen as it is put on the stack, and stay on it', () => {
    const state = atMain();
    const victim = putOnBattlefield(state, 'B', BEAR);
    const zap: CardDefinition = {
      id: 'zap',
      name: 'Zap',
      types: ['instant'],
      timing: 'instant',
      effects: [{ primitive: 'shrinkTarget', params: { targets: 'creature' } }],
    };
    const [card] = giveHand(state, 'A', [zap]);
    const after = act(
      state,
      { kind: 'castSpell', player: 'A', instanceId: card!.instanceId, targets: [victim.instanceId] },
      registry,
    );
    expect(after.stack[0]?.targets).toEqual([victim.instanceId]);
  });

  crTest('601.2h', 'a spell whose cost the player cannot pay is neither offered nor castable', () => {
    const state = atMain();
    const expensive: CardDefinition = {
      id: 'expensive',
      name: 'Expensive',
      types: ['sorcery'],
      cost: { generic: 5 },
      effects: [{ primitive: 'noop' }],
    };
    const [card] = giveHand(state, 'A', [expensive]);
    const s = withRedMana(state, 1);
    expect(generateLegalActions(s).some((a) => a.kind === 'castSpell')).toBe(false);
    expect(rejectionOf(s, { kind: 'castSpell', player: 'A', instanceId: card!.instanceId }, registry)).toMatch(
      /insufficient mana/i,
    );
  });

  crTest('601.2h', 'the cost is paid as the spell is cast, not when it resolves', () => {
    const state = atMain();
    const [card] = giveHand(state, 'A', [BEAR]);
    const s = withRedMana(state, 1);
    expect(poolTotal(s.players.A.manaPool)).toBe(1);
    const after = act(s, { kind: 'castSpell', player: 'A', instanceId: card!.instanceId }, registry);
    expect(poolTotal(after.players.A.manaPool)).toBe(0);
    expect(after.stack).toHaveLength(1);
  });

  crTest('117.3c', 'the player who casts a spell receives priority again afterwards', () => {
    const state = atMain();
    const [card] = giveHand(state, 'A', [BEAR]);
    const s = withRedMana(state, 1);
    const after = act(s, { kind: 'castSpell', player: 'A', instanceId: card!.instanceId }, registry);
    expect(after.priorityPlayer).toBe('A');
    expect(after.consecutivePasses).toBe(0);
  });

  crTest('304.1', 'an instant may be cast whenever its controller has priority', () => {
    const instant: CardDefinition = {
      id: 'fast',
      name: 'Fast',
      types: ['instant'],
      timing: 'instant',
      effects: [{ primitive: 'noop' }],
    };
    // A fresh game per step, so each position is reached forwards through the
    // real turn machine rather than by rewinding one.
    for (const step of ['upkeep', 'declareAttackers', 'end'] as const) {
      const created = createGame({
        seed: 31,
        startingPlayer: 'A',
        registry,
        decks: { A: deckOf(MOUNTAIN, 40), B: deckOf(MOUNTAIN, 40) },
      });
      const at = advanceTo(created.state, step, registry);
      at.players.A.hand = [];
      giveHand(at, 'A', [instant]);
      expect(at.priorityPlayer).toBe('A');
      expect(generateLegalActions(at).some((a) => a.kind === 'castSpell')).toBe(true);
    }
  });
});

// --- CR 602: activated abilities -------------------------------------------------------

describe('CR 602 — activating an ability', () => {
  crTest('602.2a', 'activating an ability puts it on the stack and pays its cost immediately', () => {
    const state = atMain();
    const engine = putOnBattlefield(state, 'A', ENGINE);
    const s = withRedMana(state, 1);
    const after = act(
      s,
      { kind: 'activateAbility', player: 'A', instanceId: engine.instanceId, abilityIndex: 0 },
      registry,
    );
    expect(after.stack).toHaveLength(1);
    expect(after.stack[0]?.kind).toBe('trigger');
    // The mana is GONE the moment the ability was activated.
    expect(poolTotal(after.players.A.manaPool)).toBe(0);
  });

  crTest('602.5d', 'an activated ability with no stated timing may be activated at instant speed', () => {
    const state = atMain();
    putOnBattlefield(state, 'A', ENGINE);
    const inCombat = withRedMana(advanceTo(state, 'declareAttackers', registry), 1);
    const offered = generateLegalActions(inCombat).filter((a) => a.kind === 'activateAbility');
    expect(offered.map((a) => (a as { abilityIndex: number }).abilityIndex)).toEqual([0]);
  });

  crTest('602.5d', 'an ability printed at sorcery speed is not offered outside a main phase', () => {
    const state = atMain();
    const engine = putOnBattlefield(state, 'A', ENGINE);
    const inCombat = advanceTo(state, 'declareAttackers', registry);
    expect(
      rejectionOf(
        inCombat,
        { kind: 'activateAbility', player: 'A', instanceId: engine.instanceId, abilityIndex: 1 },
        registry,
      ),
    ).toBeTruthy();
    // …and in a main phase the very same ability IS available.
    expect(
      generateLegalActions(state).some(
        (a) => a.kind === 'activateAbility' && (a as { abilityIndex: number }).abilityIndex === 1,
      ),
    ).toBe(true);
  });

  crTest('602.2b', 'the cost of an activated ability is not refunded when its source leaves', () => {
    const state = atMain();
    const engine = putOnBattlefield(state, 'A', ENGINE);
    let s = withRedMana(state, 1);
    s = act(s, { kind: 'activateAbility', player: 'A', instanceId: engine.instanceId, abilityIndex: 0 }, registry);
    // The source is destroyed with the ability still on the stack.
    s.battlefield = s.battlefield.filter((c) => c.instanceId !== engine.instanceId);
    const before = orderLog.length;
    s = resolveStack(s);
    expect(poolTotal(s.players.A.manaPool)).toBe(0);
    // …and the ability still resolved: an ability on the stack is independent of
    // its source (CR 113.7a).
    expect(orderLog.length).toBe(before + 1);
  });
});

// --- CR 603: triggered abilities ---------------------------------------------------------

describe('CR 603 — triggered abilities', () => {
  crTest('603.3', 'a triggered ability goes on the stack the next time a player would get priority', () => {
    const state = atMain();
    const [card] = giveHand(state, 'A', [PINGER]);
    let s = withRedMana(state, 1);
    s = act(s, { kind: 'castSpell', player: 'A', instanceId: card!.instanceId }, registry);
    const lifeBefore = s.players.B.life;
    // Resolving the creature spell puts the ETB trigger on the stack — it does
    // NOT resolve as part of the creature's own resolution.
    s = bothPass(s);
    expect(onBattlefield(s, card!.instanceId)).toBeTruthy();
    expect(s.stack).toHaveLength(1);
    expect(s.stack[0]?.kind).toBe('trigger');
    expect(s.players.B.life).toBe(lifeBefore);

    s = bothPass(s);
    expect(s.stack).toHaveLength(0);
    expect(s.players.B.life).toBe(lifeBefore - 2);
  });

  crTest('603.3d', 'a triggered ability’s targets are chosen as it is put on the stack', () => {
    const state = atMain();
    const victim = putOnBattlefield(state, 'B', BEAR);
    const [card] = giveHand(state, 'A', [TARGETED_PINGER]);
    let s = withRedMana(state, 1);
    s = act(s, { kind: 'castSpell', player: 'A', instanceId: card!.instanceId }, registry);
    s = bothPass(s);
    // The artifact has resolved and its trigger is ON the stack, already aimed —
    // the target is fixed before anything resolves, not read at resolution.
    const trigger = s.stack.find((o) => o.kind === 'trigger');
    expect(trigger).toBeTruthy();
    expect(trigger?.targets).toEqual([victim.instanceId]);
    expect(s.continuous).toHaveLength(0);

    s = bothPass(s);
    expect(s.continuous).toHaveLength(1);
  });

  crTest('603.3', 'a trigger whose condition never occurs never goes on the stack', () => {
    const state = atMain();
    // The Pinger is put onto the battlefield directly (no zone change into it
    // through the engine), so no ETB event exists to match.
    putOnBattlefield(state, 'A', PINGER);
    const lifeBefore = state.players.B.life;
    const s = bothPass(state);
    expect(s.stack).toHaveLength(0);
    expect(s.players.B.life).toBe(lifeBefore);
  });
});

// --- CR 606: loyalty abilities --------------------------------------------------------------

describe('CR 606 — loyalty abilities', () => {
  /** A walker already on the battlefield, unsick, in A's main phase. */
  function withWalker(): { state: GameState; walkerId: InstanceId } {
    const state = atMain();
    const walker = putOnBattlefield(state, 'A', WALKER, { counters: { [LOYALTY_COUNTER]: WALKER.loyalty! } });
    return { state, walkerId: walker.instanceId };
  }

  crTest('606.3', 'a loyalty ability may only be activated at sorcery speed', () => {
    const { state, walkerId } = withWalker();
    const inCombat = advanceTo(state, 'declareAttackers', registry);
    expect(generateLegalActions(inCombat).some((a) => a.kind === 'activateAbility')).toBe(false);
    expect(
      rejectionOf(inCombat, { kind: 'activateAbility', player: 'A', instanceId: walkerId, abilityIndex: 0 }, registry),
    ).toBeTruthy();
  });

  crTest('606.3', 'only one loyalty ability may be activated per planeswalker each turn', () => {
    const { state, walkerId } = withWalker();
    let s = act(state, { kind: 'activateAbility', player: 'A', instanceId: walkerId, abilityIndex: 0 }, registry);
    s = resolveStack(s);
    expect(loyaltyOf(onBattlefield(s, walkerId)!)).toBe(WALKER.loyalty! + 1);
    expect(
      generateLegalActions(s).some((a) => a.kind === 'activateAbility' && a.instanceId === walkerId),
    ).toBe(false);
    expect(
      rejectionOf(s, { kind: 'activateAbility', player: 'A', instanceId: walkerId, abilityIndex: 0 }, registry),
    ).toBeTruthy();
  });

  crTest('606.6', 'a minus ability cannot be activated for more loyalty than the walker has', () => {
    const { state, walkerId } = withWalker();
    expect(
      generateLegalActions(state).some(
        (a) =>
          a.kind === 'activateAbility' &&
          a.instanceId === walkerId &&
          (a as { abilityIndex: number }).abilityIndex === 1,
      ),
    ).toBe(false);
    expect(
      rejectionOf(state, { kind: 'activateAbility', player: 'A', instanceId: walkerId, abilityIndex: 1 }, registry),
    ).toBeTruthy();
  });
});

// --- CR 608: resolving a spell or ability ------------------------------------------------------

describe('CR 608 — resolving spells and abilities', () => {
  crTest('608.2c', 'a resolving spell follows its instructions in the printed order', () => {
    const state = atMain();
    orderLog.length = 0;
    const [card] = giveHand(state, 'A', [TWO_STEP]);
    let s = act(state, { kind: 'castSpell', player: 'A', instanceId: card!.instanceId }, registry);
    s = bothPass(s);
    expect(orderLog).toEqual(['first', 'second']);
    // …and the spell genuinely finished: an assertion on a log alone would pass
    // for a spell that ran its script twice, or never left the stack.
    expect(s.stack).toHaveLength(0);
  });

  crTest('608.3', 'a resolving permanent spell becomes a permanent on the battlefield', () => {
    const state = atMain();
    const [card] = giveHand(state, 'A', [BEAR]);
    let s = withRedMana(state, 1);
    s = act(s, { kind: 'castSpell', player: 'A', instanceId: card!.instanceId }, registry);
    s = bothPass(s);
    const permanent = onBattlefield(s, card!.instanceId);
    expect(permanent).toBeTruthy();
    expect(permanent?.zone).toBe('battlefield');
    expect(s.players.A.graveyard.some((c) => c.instanceId === card!.instanceId)).toBe(false);
  });
});

// --- CR 614: replacement effects ------------------------------------------------------------------

describe('CR 614 — replacement effects', () => {
  crTest('614.1c', 'a permanent that "enters tapped" is never untapped on the battlefield first', () => {
    const state = atMain();
    const [card] = giveHand(state, 'A', [TAPLAND]);
    const after = actWithEvents(state, { kind: 'playLand', player: 'A', instanceId: card!.instanceId }, registry);
    const land = onBattlefield(after.state, card!.instanceId);
    expect(land?.tapped).toBe(true);
    // The log must SAY it arrived tapped — a replay that folds the event stream
    // starts every entering permanent untapped.
    expect(eventsNamed(after.events, 'tapped').some((e) => e.instanceId === card!.instanceId)).toBe(true);
    // …and no untap event undid it in the same breath.
    expect(eventsNamed(after.events, 'untapped')).toHaveLength(0);
  });

  crTest('302.6', 'a creature entering the battlefield is summoning sick unless it has haste', () => {
    const state = atMain();
    const hasty = creatureDef('Hasty', 2, 2, { keywords: { haste: true } });
    const [slow, quick] = giveHand(state, 'A', [BEAR, hasty]);
    let s = withRedMana(state, 2);
    s = act(s, { kind: 'castSpell', player: 'A', instanceId: slow!.instanceId }, registry);
    s = bothPass(s);
    s = act(s, { kind: 'castSpell', player: 'A', instanceId: quick!.instanceId }, registry);
    s = bothPass(s);
    expect(onBattlefield(s, slow!.instanceId)?.summoningSick).toBe(true);
    expect(onBattlefield(s, quick!.instanceId)?.summoningSick).toBe(false);

    const declare = advanceTo(s, 'declareAttackers', registry);
    const attack = generateLegalActions(declare).find((a) => a.kind === 'declareAttackers');
    expect(attack).toBeTruthy();
    expect((attack as { attackers: readonly InstanceId[] }).attackers).toEqual([quick!.instanceId]);
  });
});

assertFileMatchesManifest(FILE);
