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
  POISON_LOSS_THRESHOLD,
  addPoisonCounters,
  poisonOf,
  generateLegalActions,
  openSuspendWindow,
  turnFactHolds,
  // §3.113 — the spell-count family's core seams.
  makeSpellCopy,
  performCascade,
  spellOnStackById,
  spellsCastThisTurn,
  stackManaValueOf,
  type CardDefinition,
  type CardInstance,
  type GameAction,
  type GameState,
  type PlayerId,
} from '../index.js';
import { creatureDef, deckOf, giveGraveyard, giveHand, landDef, spellDef } from '../test-fixtures.js';
import { creatureDef, deckOf, giveHand, giveLibrary, landDef } from '../test-fixtures.js';
import {
  act,
  FILLER_LAND,
  advanceTo,
  advanceToTurn,
  assertFileMatchesManifest,
  crTest,
  newGame,
  nonActive,
  offers,
  onBattlefield,
  pass,
  putOnBattlefield,
  registryWith,
  rejectionOf,
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

  crTest('704.5q', '+1/+1 and -1/-1 counters on one permanent are REMOVED in pairs', () => {
    // CR 704.5q: "If a permanent has both a +1/+1 counter and a -1/-1 counter on
    // it, N +1/+1 and N -1/-1 counters are removed from it," where N is the
    // smaller of the two counts.
    //
    // The arithmetic never depended on this — `counterShift` nets the tallies, so
    // the power and toughness were always right — which is exactly why the rule
    // was easy to leave out. What it decides is the STATE: whether the permanent
    // still HAS a -1/-1 counter on it afterwards, which is what persist's own
    // printed condition, undying's, and every "remove a counter" effect ask.
    //
    // The counters are placed directly on the permanent rather than through the
    // counters primitive, on purpose: this is a state-based action, so it must
    // apply to counters that arrived by ANY route.
    const state = newGame();
    const bear = putOnBattlefield(state, 'A', BEAR, {
      counters: { [PLUS_ONE_COUNTER]: 2, [MINUS_ONE_COUNTER]: 1 },
    });
    expect(effectivePower(bear)).toBe(BEAR.power! + 1);

    const after = bothPass(state);
    const still = onBattlefield(after, bear.instanceId);
    // One pair annihilated: one +1/+1 left, no -1/-1 at all.
    expect(still?.counters[PLUS_ONE_COUNTER]).toBe(1);
    expect(still?.counters[MINUS_ONE_COUNTER]).toBe(0);
    // …and the creature is the same size it was. The rule changes the counters,
    // never the numbers.
    expect(effectivePower(still!)).toBe(BEAR.power! + 1);
    expect(effectiveToughness(still!)).toBe(BEAR.toughness! + 1);
  });

  crTest('704.3', 'a condition nobody announced is caught the moment a player would get priority', () => {
    // The invariant test above proves the engine settles every condition its own
    // mutation sites create. This one proves the BACKSTOP: the condition is
    // created by writing on the state directly, so no mutation site runs and
    // nothing but the priority boundary can catch it.
    //
    // That is not a contrived position — it is the shape of the next branch that
    // adds a way to change a life total and does not know to call the check. CR
    // 704.3 says the game looks whenever a player WOULD receive priority, which
    // makes the answer independent of how the condition got there.
    const state = newGame();
    state.players.B.life = 0;
    // Nothing has noticed yet: no action has been taken.
    expect(state.players.B.hasLost).toBe(false);

    const after = pass(state, registry);

    expect(after.players.B.hasLost).toBe(true);
    expect(after.gameOver).toBe(true);
    expect(after.winner).toBe('A');
  });
});

// --- CR 702 / 704.5c: the poison family (§3.105) -----------------------------------

describe('CR 702 / 704.5c — infect, wither, toxic and the poison loss', () => {
  const INFECT_ELF: CardDefinition = creatureDef('Glistener Elf', 1, 1, { keywords: { infect: true } });
  const WITHER_GANG: CardDefinition = creatureDef('Boggart Ram-Gang', 3, 3, { keywords: { wither: true } });
  const TOXIC_REX: CardDefinition = creatureDef('Tyrranax Atrocity', 4, 4, { keywords: { toxic: 3 } });

  /** A's `attacker` attacks; B blocks with `blocker` when given; combat resolves. */
  function swing(state: GameState, attacker: CardInstance, blocker?: CardInstance): GameState {
    let s = advanceTo(state, 'declareAttackers', registry);
    s = act(s, { kind: 'declareAttackers', player: 'A', attackers: [attacker.instanceId] }, registry);
    s = advanceTo(s, 'declareBlockers', registry);
    s = act(
      s,
      {
        kind: 'declareBlockers',
        player: nonActive(s),
        blocks: blocker ? [{ blocker: blocker.instanceId, attacker: attacker.instanceId }] : [],
      },
      registry,
    );
    // Not `advanceTo`: the 704.5c case ENDS the game at the damage step's SBA
    // check, and a helper that insists on reaching postcombat would call the
    // rule working correctly a failure to advance.
    for (let guard = 0; guard < 100 && s.step !== 'postcombatMain' && !s.gameOver; guard++) s = pass(s, registry);
    return s;
  }

  crTest('702.90c', 'infect damage to a creature is -1/-1 counters, and no damage is marked', () => {
    const state = atMain();
    const elf = putOnBattlefield(state, 'A', INFECT_ELF);
    const bear = putOnBattlefield(state, 'B', creatureDef('Big Bear', 3, 3));
    const s = swing(state, elf, bear);
    const after = onBattlefield(s, bear.instanceId);
    expect(after?.counters[MINUS_ONE_COUNTER]).toBe(1);
    expect(after?.damageMarked).toBe(0);
  });

  crTest('702.90b', 'infect damage to a player is poison counters, and no life is lost', () => {
    const state = atMain();
    const elf = putOnBattlefield(state, 'A', INFECT_ELF);
    const s = swing(state, elf);
    expect(s.players.B.life).toBe(state.players.B.life);
    expect(poisonOf(s.players.B)).toBe(1);
  });

  crTest('702.80a', 'wither damage to a creature is -1/-1 counters; to a player it is ordinary life loss', () => {
    const blocked = atMain();
    const gang = putOnBattlefield(blocked, 'A', WITHER_GANG);
    const wall = putOnBattlefield(blocked, 'B', creatureDef('Wall', 0, 5));
    const s1 = swing(blocked, gang, wall);
    expect(onBattlefield(s1, wall.instanceId)?.counters[MINUS_ONE_COUNTER]).toBe(3);
    const unblocked = atMain();
    const gang2 = putOnBattlefield(unblocked, 'A', WITHER_GANG);
    const s2 = swing(unblocked, gang2);
    expect(s2.players.B.life).toBe(unblocked.players.B.life - 3);
    expect(poisonOf(s2.players.B)).toBe(0);
  });

  crTest('702.164c', 'a player dealt combat damage by a toxic creature also gets N poison counters', () => {
    const state = atMain();
    const rex = putOnBattlefield(state, 'A', TOXIC_REX);
    const s = swing(state, rex);
    expect(s.players.B.life).toBe(state.players.B.life - 4);
    expect(poisonOf(s.players.B)).toBe(3);
  });

  crTest('704.5c', 'a player with ten or more poison counters loses the game', () => {
    const state = atMain();
    const elf = putOnBattlefield(state, 'A', INFECT_ELF);
    addPoisonCounters(state, 'B', POISON_LOSS_THRESHOLD - 1, () => {});
    const s = swing(state, elf);
    expect(poisonOf(s.players.B)).toBe(POISON_LOSS_THRESHOLD);
    expect(s.players.B.hasLost).toBe(true);
    expect(s.gameOver).toBe(true);
    expect(s.winner).toBe('A');
  });
});

// --- CR 702: keyword abilities the per-feature suites do not drive ----------------

describe('CR 702 — ward', () => {
  /** Put A's Shock on the stack aimed at `target`, with the mana already paid. */
  function shockAt(state: GameState, target: CardInstance): GameState {
    const [shock] = giveHand(state, 'A', [SHOCK]);
    const land = putOnBattlefield(state, 'A', MOUNTAIN);
    const s = act(state, { kind: 'tapForMana', player: 'A', instanceId: land.instanceId }, registry);
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

// --- CR 702: the combat keyword family (DESIGN §3.107) ------------------------------

describe('CR 702 — the combat keyword family', () => {
  const SHADOW = creatureDef('Dauthi Mercenary', 2, 1, { keywords: { shadow: true } });
  const ISLANDWALKER = creatureDef('Pale Bears', 2, 2, { keywords: { landwalk: [{ kind: 'subtype', subtype: 'island' }] } });
  /** A land with the Island SUBTYPE — landwalk reads the type line, not the name. */
  const ISLAND: CardDefinition = { ...landDef('Island', 'U'), subtypes: ['Island'] };
  /** The family's registry: a probe that pumps the TRIGGERING creatures. */
  const familyRegistry = registryWith({
    noop: () => {},
    pumpTriggering: (ctx) => {
      const power = typeof ctx.params.power === 'number' ? ctx.params.power : 0;
      const toughness = typeof ctx.params.toughness === 'number' ? ctx.params.toughness : 0;
      for (const id of ctx.triggeringInstances ?? []) {
        ctx.addContinuousEffect({ target: id, power, toughness, duration: 'endOfTurn' });
      }
    },
  });

  /** A's creature attacks; the defender is offered blockers; returns that state. */
  function attackInto(state: GameState, attackerId: number, reg = registry): GameState {
    const declare = advanceTo(state, 'declareAttackers', reg);
    let s = act(declare, { kind: 'declareAttackers', player: 'A', attackers: [attackerId] }, reg);
    for (let guard = 0; guard < 20 && s.stack.length > 0; guard++) s = pass(pass(s, reg), reg);
    s = advanceTo(s, 'declareBlockers', reg);
    return s.priorityPlayer === nonActive(s) ? s : pass(s, reg);
  }

  crTest('702.28b', 'a creature with shadow can be blocked only by a creature with shadow, and vice versa', () => {
    const state = atMain();
    const mercenary = putOnBattlefield(state, 'A', SHADOW);
    const bear = putOnBattlefield(state, 'B', BEAR);
    const blockers = attackInto(state, mercenary.instanceId);
    expect(
      rejectionOf(blockers, { kind: 'declareBlockers', player: 'B', blocks: [{ blocker: bear.instanceId, attacker: mercenary.instanceId }] }, registry),
    ).toMatch(/cannot block/);
    // The mirror: a Bear attacks, and the shadow creature may not block it.
    const reverse = atMain();
    const attacker = putOnBattlefield(reverse, 'A', BEAR);
    const shade = putOnBattlefield(reverse, 'B', SHADOW);
    const reverseBlockers = attackInto(reverse, attacker.instanceId);
    expect(
      rejectionOf(reverseBlockers, { kind: 'declareBlockers', player: 'B', blocks: [{ blocker: shade.instanceId, attacker: attacker.instanceId }] }, registry),
    ).toMatch(/cannot block/);
  });

  crTest('702.18b', 'a creature with islandwalk can’t be blocked while the defending player controls an Island', () => {
    const state = atMain();
    const bears = putOnBattlefield(state, 'A', ISLANDWALKER);
    const blocker = putOnBattlefield(state, 'B', BEAR);
    putOnBattlefield(state, 'B', ISLAND);
    const blockers = attackInto(state, bears.instanceId);
    expect(
      rejectionOf(blockers, { kind: 'declareBlockers', player: 'B', blocks: [{ blocker: blocker.instanceId, attacker: bears.instanceId }] }, registry),
    ).toMatch(/cannot block/);
    // Without the Island the same block stands.
    const dry = atMain();
    const bears2 = putOnBattlefield(dry, 'A', ISLANDWALKER);
    const blocker2 = putOnBattlefield(dry, 'B', BEAR);
    const dryBlockers = attackInto(dry, bears2.instanceId);
    expect(
      rejectionOf(dryBlockers, { kind: 'declareBlockers', player: 'B', blocks: [{ blocker: blocker2.instanceId, attacker: bears2.instanceId }] }, registry),
    ).toBeUndefined();
  });

  crTest('702.61a', 'while a spell with split second is on the stack, players can’t cast spells or activate non-mana abilities', () => {
    const suddenShock: CardDefinition = {
      id: 'sudden-shock-7xx',
      name: 'Sudden Shock',
      types: ['instant'],
      cost: { generic: 1 },
      keywords: { splitSecond: true },
      effects: [{ primitive: 'noop' }],
    };
    const response: CardDefinition = { id: 'response-7xx', name: 'Response', types: ['instant'], effects: [{ primitive: 'noop' }] };
    const state = atMain();
    const [shock] = giveHand(state, 'A', [suddenShock]);
    const [answer] = giveHand(state, 'B', [response]);
    const land = putOnBattlefield(state, 'A', MOUNTAIN);
    let s = act(state, { kind: 'tapForMana', player: 'A', instanceId: land.instanceId }, registry);
    s = act(s, { kind: 'castSpell', player: 'A', instanceId: shock!.instanceId }, registry);
    // B, holding a free instant, is offered no cast and is refused one.
    const toB = pass(s, registry);
    expect(toB.priorityPlayer).toBe('B');
    expect(generateLegalActions(toB).some((a) => a.kind === 'castSpell')).toBe(false);
    expect(rejectionOf(toB, { kind: 'castSpell', player: 'B', instanceId: answer!.instanceId }, registry)).toMatch(/split second/);
    // Mana abilities are exempt (CR 702.61b): a land still taps.
    const theirLand = putOnBattlefield(toB, 'B', MOUNTAIN);
    expect(rejectionOf(toB, { kind: 'tapForMana', player: 'B', instanceId: theirLand.instanceId }, registry)).toBeUndefined();
  });

  crTest('702.90a', 'exalted pumps the creature that attacks alone, once per instance of exalted', () => {
    const exalted: CardDefinition = {
      ...landDef('Cathedral of War', 'C'),
      triggers: [
        { condition: { on: 'creatureAttacksAlone' }, effects: [{ primitive: 'pumpTriggering', params: { power: 1, toughness: 1 } }], label: 'Exalted' },
      ],
    };
    const state = atMain();
    const bear = putOnBattlefield(state, 'A', BEAR);
    putOnBattlefield(state, 'A', exalted);
    putOnBattlefield(state, 'A', exalted);
    const blockers = attackInto(state, bear.instanceId, familyRegistry);
    const it = onBattlefield(blockers, bear.instanceId)!;
    expect(effectivePower(it, aggregateFor(blockers, it.instanceId))).toBe(BEAR.power! + 2);
    expect(effectiveToughness(it, aggregateFor(blockers, it.instanceId))).toBe(BEAR.toughness! + 2);
  });

  crTest('702.25a', 'flanking gives each blocking creature without flanking −1/−1', () => {
    const cavalry: CardDefinition = {
      ...creatureDef('Benalish Cavalry', 2, 2, { keywords: { flanking: true } }),
      triggers: [
        {
          condition: { on: 'becomesBlockedByCreature', counterpartLacksKeyword: 'flanking' },
          effects: [{ primitive: 'pumpTriggering', params: { power: -1, toughness: -1 } }],
          label: 'Flanking',
        },
      ],
    };
    const state = atMain();
    const attacker = putOnBattlefield(state, 'A', cavalry);
    const bear = putOnBattlefield(state, 'B', BEAR);
    const knight = putOnBattlefield(state, 'B', creatureDef('Flanking Knight', 2, 2, { keywords: { flanking: true } }));
    let s = attackInto(state, attacker.instanceId, familyRegistry);
    s = act(
      s,
      {
        kind: 'declareBlockers',
        player: 'B',
        blocks: [
          { blocker: bear.instanceId, attacker: attacker.instanceId },
          { blocker: knight.instanceId, attacker: attacker.instanceId },
        ],
      },
      familyRegistry,
    );
    for (let guard = 0; guard < 20 && s.stack.length > 0; guard++) s = pass(pass(s, familyRegistry), familyRegistry);
    const shrunk = onBattlefield(s, bear.instanceId)!;
    const exempt = onBattlefield(s, knight.instanceId)!;
    expect(effectivePower(shrunk, aggregateFor(s, shrunk.instanceId))).toBe(BEAR.power! - 1);
    expect(effectivePower(exempt, aggregateFor(s, exempt.instanceId))).toBe(2);
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

// --- §3.106 upkeep costs and time counters ------------------------------------------

/** Echo, as the compiler emits it: the came-under-your-control "if" gating an upkeep body. */
const ECHO_CREATURE: CardDefinition = {
  ...creatureDef('Echo Bear', 2, 2, { cost: { generic: 1 } }),
  triggers: [
    {
      condition: { on: 'upkeep', who: 'you', intervening: { kind: 'sourceControlledSinceLastUpkeep' } },
      effects: [{ primitive: 'noteBill' }],
      label: 'Echo {1}',
    },
  ],
};

/** Vanishing 3 / Fading 2, as the compiler emits their entry halves. */
const VANISHING_CREATURE: CardDefinition = {
  ...creatureDef('Vanishing Beast', 5, 5, { cost: { generic: 1 } }),
  entersWithCounters: [{ kind: 'time', count: 3 }],
};
const FADING_LAND: CardDefinition = { ...landDef('Fading Land', 'C'), entersWithCounters: [{ kind: 'fade', count: 2 }] };

/** Suspend 1—{R} on a sorcery-speed creature with a mana cost nobody here can pay. */
const SUSPENDED_GIANT: CardDefinition = {
  ...creatureDef('Suspended Giant', 6, 6, { cost: { generic: 9 } }),
  suspend: { count: 1, cost: { R: 1 }, upkeep: [{ primitive: 'tick' }] },
};

describe('CR 702 — upkeep costs and time counters (§3.106)', () => {
  const billed: number[] = [];
  const registry = registryWith({
    noteBill: (ctx) => {
      billed.push(ctx.state.turnNumber);
    },
    tick: (ctx) => {
      // The exile-side upkeep ability, in miniature: the cards package's
      // `suspendTick` does the same through core's exported window opener.
      const card = ctx.source;
      const left = (card.counters.time ?? 0) - 1;
      card.counters = { ...card.counters, time: left };
      if (left <= 0) openSuspendWindow(ctx.state, card, ctx.emit);
    },
  });

  function atMainWith(defs: readonly CardDefinition[]): { state: GameState; cards: CardInstance[] } {
    const state = advanceTo(newGame({ registry }), 'precombatMain', registry);
    // Both hands emptied: a seven-land opening hand plus draws would park the
    // cleanup discard question on turn 2 and stop the passes these tests make.
    state.players.A.hand = [];
    state.players.B.hand = [];
    const cards = giveHand(state, 'A', defs);
    state.players.A.manaPool = { W: 0, U: 0, B: 0, R: 1, G: 0, C: 9 };
    return { state, cards };
  }

  crTest('702.30a', 'echo bills on the first upkeep after the permanent came under your control, and not on the next', () => {
    billed.length = 0;
    const { state, cards } = atMainWith([ECHO_CREATURE]);
    let s = act(state, { kind: 'castSpell', player: 'A', instanceId: cards[0]!.instanceId }, registry);
    s = pass(s, registry);
    s = pass(s, registry);
    expect(onBattlefield(s, cards[0]!.instanceId)?.controlledSinceTurn).toBe(1);
    s = advanceToTurn(s, 5, 'draw', registry);
    // Turn 3's upkeep asked; turn 5's did not — the intervening "if" (CR 603.4)
    // kept the ability off the stack entirely.
    expect(billed).toEqual([3]);
  });

  crTest('702.63a', 'a permanent with vanishing enters with its printed time counters, cast or played', () => {
    const { state, cards } = atMainWith([VANISHING_CREATURE, FADING_LAND]);
    let s = act(state, { kind: 'castSpell', player: 'A', instanceId: cards[0]!.instanceId }, registry);
    s = pass(s, registry);
    s = pass(s, registry);
    expect(onBattlefield(s, cards[0]!.instanceId)?.counters.time).toBe(3);
  });

  crTest('702.32a', 'a permanent with fading enters with its printed fade counters, through the land-play path too', () => {
    const { state, cards } = atMainWith([VANISHING_CREATURE, FADING_LAND]);
    const s = act(state, { kind: 'playLand', player: 'A', instanceId: cards[1]!.instanceId }, registry);
    expect(onBattlefield(s, cards[1]!.instanceId)?.counters.fade).toBe(2);
  });

  crTest('702.62a', 'suspend exiles the card with N time counters for its suspend cost, and the last counter leaving lets it be cast for nothing', () => {
    const { state, cards } = atMainWith([SUSPENDED_GIANT]);
    const giant = cards[0]!;
    // {9} is out of reach; the special action is not.
    expect(offers(state, 'suspendCard')).toBe(true);
    let s = act(state, { kind: 'suspendCard', player: 'A', instanceId: giant.instanceId }, registry);
    expect(s.players.A.exile[0]?.counters.time).toBe(1);
    expect(s.players.A.manaPool.R).toBe(0);
    s = advanceTo(s, 'upkeep', registry);
    s = advanceToTurn(s, 3, 'upkeep', registry);
    // The tick resolved and opened the window: cast it now, for nothing, in
    // the upkeep — the printed sorcery timing does not apply (CR 702.62a).
    let guard = 0;
    while (s.madnessWindow?.kind !== 'suspend' && guard++ < 10) s = pass(s, registry);
    expect(s.madnessWindow?.kind).toBe('suspend');
    s.players.A.manaPool = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
    s = act(s, { kind: 'castSpell', player: 'A', instanceId: giant.instanceId, fromZone: 'exile' }, registry);
    s = pass(s, registry);
    s = pass(s, registry);
    const entered = onBattlefield(s, giant.instanceId);
    expect(entered).toBeDefined();
    // "It gains haste until you lose control of it": it entered unsick.
    expect(entered?.summoningSick).toBe(false);
  });
});

// --- §3.111 the graveyard-casting family --------------------------------------------

describe('CR 702 — the graveyard-casting family (§3.111)', () => {
  const resolvedIn: string[] = [];
  const registry = registryWith({
    noteZone: (ctx) => {
      resolvedIn.push(ctx.source.zone);
    },
    // Unearth's body in miniature — the cards package's `unearthReturn` does
    // the same through the shared entry helper: graveyard → battlefield,
    // unsick, with CR 702.84c's replacement recorded on the object.
    unearth: (ctx) => {
      const owner = ctx.state.players[ctx.source.owner];
      const index = owner.graveyard.findIndex((c) => c.instanceId === ctx.source.instanceId);
      const [card] = index < 0 ? [] : owner.graveyard.splice(index, 1);
      if (!card) return;
      card.zone = 'battlefield';
      card.controller = ctx.controller;
      card.summoningSick = false;
      card.exileIfLeaves = true;
      ctx.state.battlefield.push(card);
      ctx.emit({ type: 'zoneChange', instanceId: card.instanceId, from: 'graveyard', to: 'battlefield' });
    },
  });
  const SWAMP = landDef('Swamp', 'B');
  const BEAR = creatureDef('bear', 2, 2, { cost: { generic: 1, G: 1 }, name: 'Bear' });
  const UNEARTHER: CardDefinition = {
    ...creatureDef('unearther', 2, 1, { cost: { generic: 1, B: 1 }, name: 'Unearther' }),
    graveyardAbilities: [{ kind: 'unearth', cost: { mana: { C: 1 } }, effects: [{ primitive: 'unearth' }], timing: 'sorcery', label: 'Unearth {1}' }],
  };
  const SCAVENGER: CardDefinition = {
    ...creatureDef('scavenger', 3, 3, { cost: { generic: 2, G: 1 }, name: 'Scavenger' }),
    graveyardAbilities: [
      { kind: 'scavenge', cost: { mana: { C: 1 } }, exileSelf: true, effects: [{ primitive: 'noteZone', params: { targets: 'creature' } }], timing: 'sorcery', label: 'Scavenge {1}' },
    ],
  };
  const RETRACER: CardDefinition = {
    ...spellDef('retracer', 'sorcery', [{ primitive: 'noteZone' }], { C: 1 }),
    graveyardCasts: [{ kind: 'retrace', additional: { kind: 'discard', filter: { anyOfTypes: ['land'] }, label: 'Discard a land card' } }],
  };
  const JUMPER: CardDefinition = {
    ...spellDef('jumper', 'sorcery', [{ primitive: 'noteZone' }], { C: 1 }),
    graveyardCasts: [{ kind: 'jumpStart', additional: { kind: 'discard', label: 'Discard a card' } }],
  };
  const ESCAPER: CardDefinition = {
    ...spellDef('escaper', 'sorcery', [{ primitive: 'noteZone' }], { C: 3 }),
    graveyardCasts: [{ kind: 'escape', cost: { C: 1 }, additional: { kind: 'exileFromGraveyard', count: 2, label: 'Exile two other cards from your graveyard' } }],
  };
  const DREAD: CardDefinition = {
    ...spellDef('dread', 'sorcery', [{ primitive: 'noteZone' }], { C: 4 }),
    flashback: {},
    flashbackAdditionalCost: { kind: 'sacrifice', count: 2, filter: { anyOfTypes: ['creature'] }, label: 'Sacrifice two creatures' },
  };

  function atMainWithGraveyard(defs: readonly CardDefinition[]): { state: GameState; cards: CardInstance[] } {
    const state = advanceTo(newGame({ registry }), 'precombatMain', registry);
    state.players.A.hand = [];
    state.players.B.hand = [];
    const cards = giveGraveyard(state, 'A', defs);
    state.players.A.manaPool = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 1 };
    return { state, cards };
  }
  const settle = (s: GameState): GameState => pass(pass(s, registry), registry);
  const zoneOf = (s: GameState, id: number): string =>
    s.battlefield.some((c) => c.instanceId === id)
      ? 'battlefield'
      : s.players.A.graveyard.some((c) => c.instanceId === id)
        ? 'graveyard'
        : s.players.A.exile.some((c) => c.instanceId === id)
          ? 'exile'
          : 'elsewhere';

  crTest('702.84a', 'unearth is activated from the graveyard, at sorcery speed, for its cost, and returns the card to the battlefield', () => {
    const { state, cards } = atMainWithGraveyard([UNEARTHER]);
    const id = cards[0]!.instanceId;
    expect(offers(state, 'activateGraveyardAbility')).toBe(true);
    let s = act(state, { kind: 'activateGraveyardAbility', player: 'A', instanceId: id, abilityIndex: 0 }, registry);
    expect(s.players.A.manaPool.C).toBe(0);
    s = settle(s);
    expect(zoneOf(s, id)).toBe('battlefield');
    // Not at instant speed: on the opponent's turn the ability is not offered.
    const offTurn = advanceToTurn(s, 2, 'precombatMain', registry);
    const other = giveGraveyard(offTurn, 'A', [UNEARTHER]);
    offTurn.players.A.manaPool = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 1 };
    const rejected = rejectionOf(offTurn, { kind: 'activateGraveyardAbility', player: 'A', instanceId: other[0]!.instanceId, abilityIndex: 0 }, registry);
    expect(rejected).toBeDefined();
  });

  crTest('702.84c', 'an unearthed permanent that would leave the battlefield is exiled instead of going anywhere else', () => {
    const { state, cards } = atMainWithGraveyard([UNEARTHER]);
    const id = cards[0]!.instanceId;
    let s = settle(act(state, { kind: 'activateGraveyardAbility', player: 'A', instanceId: id, abilityIndex: 0 }, registry));
    const body = onBattlefield(s, id) as CardInstance;
    body.damageMarked = body.def.toughness ?? 1;
    s = pass(s, registry);
    expect(zoneOf(s, id)).toBe('exile');
  });

  crTest('702.96a', 'scavenge exiles the card from the graveyard as a COST, before its ability resolves', () => {
    resolvedIn.length = 0;
    const { state, cards } = atMainWithGraveyard([SCAVENGER]);
    const bear = putOnBattlefield(state, 'A', BEAR);
    let s = act(state, { kind: 'activateGraveyardAbility', player: 'A', instanceId: cards[0]!.instanceId, abilityIndex: 0, targets: [bear.instanceId] }, registry);
    expect(zoneOf(s, cards[0]!.instanceId)).toBe('exile');
    s = settle(s);
    expect(resolvedIn).toEqual(['exile']);
  });

  crTest('702.81a', 'retrace casts the card from the graveyard for its printed cost plus a discarded land card, and the card returns to the graveyard', () => {
    const { state, cards } = atMainWithGraveyard([RETRACER]);
    const id = cards[0]!.instanceId;
    expect(rejectionOf(state, { kind: 'castSpell', player: 'A', instanceId: id, fromZone: 'graveyard', graveyardCast: 'retrace' }, registry)).toMatch(/additional cost/);
    const [land] = giveHand(state, 'A', [SWAMP]);
    let s = act(state, { kind: 'castSpell', player: 'A', instanceId: id, fromZone: 'graveyard', graveyardCast: 'retrace' }, registry);
    expect(s.players.A.manaPool.C).toBe(0);
    expect(zoneOf(s, land!.instanceId)).toBe('graveyard');
    s = settle(s);
    expect(zoneOf(s, id)).toBe('graveyard');
  });

  crTest('702.133a', 'jump-start casts the card from the graveyard for its printed cost plus a discarded card, then exiles it', () => {
    const { state, cards } = atMainWithGraveyard([JUMPER]);
    const id = cards[0]!.instanceId;
    const [pitched] = giveHand(state, 'A', [BEAR]);
    let s = act(state, { kind: 'castSpell', player: 'A', instanceId: id, fromZone: 'graveyard', graveyardCast: 'jumpStart' }, registry);
    expect(zoneOf(s, pitched!.instanceId)).toBe('graveyard');
    s = settle(s);
    expect(zoneOf(s, id)).toBe('exile');
  });

  crTest('702.138a', 'escape casts the card from the graveyard for its escape cost plus N other exiled graveyard cards, and does not exile it', () => {
    const { state, cards } = atMainWithGraveyard([ESCAPER, SWAMP, SWAMP]);
    const id = cards[0]!.instanceId;
    // The escape cost is {1}, not the printed {3}: one colourless pays it.
    let s = act(state, { kind: 'castSpell', player: 'A', instanceId: id, fromZone: 'graveyard', graveyardCast: 'escape' }, registry);
    expect(zoneOf(s, cards[1]!.instanceId)).toBe('exile');
    expect(zoneOf(s, cards[2]!.instanceId)).toBe('exile');
    s = settle(s);
    expect(zoneOf(s, id)).toBe('graveyard');
  });

  crTest('702.34a', 'a flashback cost printed as a sacrifice is paid by sacrificing, with no mana, and the spell is still exiled as it leaves the stack', () => {
    const { state, cards } = atMainWithGraveyard([DREAD]);
    const id = cards[0]!.instanceId;
    state.players.A.manaPool = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
    expect(offers(state, 'castSpell')).toBe(false);
    const bears = [putOnBattlefield(state, 'A', BEAR), putOnBattlefield(state, 'A', BEAR)];
    expect(offers(state, 'castSpell')).toBe(true);
    let s = act(state, { kind: 'castSpell', player: 'A', instanceId: id, fromZone: 'graveyard' }, registry);
    for (const bear of bears) expect(zoneOf(s, bear.instanceId)).toBe('graveyard');
    s = settle(s);
    expect(zoneOf(s, id)).toBe('exile');
// --- §3.110 the counter keyword family — the core halves ---------------------------
//
// The bodies (undying's return, modular's move, riot's question) are cards-package
// primitives pinned on the printed cards in packages/cards/src/compile/
// counter-keyword-family.test.ts. What core owes the family, and what is proven
// here, is the CONDITION side: the last-known counter snapshot a `dies` trigger
// reads, the four intervening-"if" kinds, the self-only static, and the turn fact.

describe('CR 702 — the counter keyword family (§3.110)', () => {
  const noted: string[] = [];
  const familyRegistry = registryWith({
    note: (ctx) => {
      noted.push(typeof ctx.params.what === 'string' ? ctx.params.what : '?');
    },
    stampRenowned: (ctx) => {
      const self = ctx.state.battlefield.find((c) => c.instanceId === ctx.source.instanceId);
      if (self) self.renowned = true;
      noted.push('renown');
    },
  });

  /** Undying's trigger, as the compiler emits its condition; the body only notes. */
  const UNDYING_WOLF: CardDefinition = {
    ...creatureDef('Young Wolf', 1, 1),
    triggers: [
      {
        condition: {
          on: 'dies',
          snapshotsCounters: PLUS_ONE_COUNTER,
          intervening: { kind: 'sourceDiedWithoutCounter', counter: PLUS_ONE_COUNTER },
        },
        effects: [{ primitive: 'note', params: { what: 'undying' } }],
        label: 'Undying',
      },
    ],
  };
  const EVOLVER: CardDefinition = {
    ...creatureDef('Cloudfin Raptor', 0, 1),
    triggers: [
      {
        condition: {
          on: 'permanentEnters',
          who: 'you',
          permanentFilter: { anyOfTypes: ['creature'] },
          carriesSubject: true,
          intervening: { kind: 'triggeringCreatureLargerThanSource' },
        },
        effects: [{ primitive: 'note', params: { what: 'evolve' } }],
        label: 'Evolve',
      },
    ],
  };
  const RENOWNED: CardDefinition = {
    ...creatureDef('Rhox Maulers', 4, 4),
    triggers: [
      {
        condition: { on: 'combatDamageToPlayer', intervening: { kind: 'sourceNotRenowned' } },
        effects: [{ primitive: 'stampRenowned' }],
        label: 'Renown 2',
      },
    ],
  };
  const DETHRONER: CardDefinition = {
    ...creatureDef('Marchesa’s Emissary', 2, 2),
    triggers: [
      {
        condition: { on: 'attacks', intervening: { kind: 'opponentHasMostLife' } },
        effects: [{ primitive: 'note', params: { what: 'dethrone' } }],
        label: 'Dethrone',
      },
    ],
  };
  const UNLEASHED: CardDefinition = {
    ...creatureDef('Rakdos Cackler', 1, 1),
    statics: [{ affects: { onlySource: true, hasCounterKind: PLUS_ONE_COUNTER }, keywords: { cantBlock: true }, label: 'Unleash' }],
  };
  const TINY: CardDefinition = creatureDef('Squire', 1, 1);
  const BIG: CardDefinition = creatureDef('Hill Giant', 3, 3);

  function familyMain(): GameState {
    const created = createGame({
      seed: 3110,
      startingPlayer: 'A',
      registry: familyRegistry,
      decks: { A: deckOf(MOUNTAIN, 40), B: deckOf(MOUNTAIN, 40) },
    });
    const state = advanceTo(created.state, 'precombatMain', familyRegistry);
    state.players.A.hand = [];
    state.players.B.hand = [];
    // Enough floating mana to cast any fixture creature outright.
    state.players.A.manaPool = { W: 9, U: 9, B: 9, R: 9, G: 9, C: 9 };
    return state;
  }

  /** A's `attackerId` attacks; B is offered blockers. */
  function attackInto(state: GameState, attackerId: number): GameState {
    const declare = advanceTo(state, 'declareAttackers', familyRegistry);
    let s = act(declare, { kind: 'declareAttackers', player: 'A', attackers: [attackerId] }, familyRegistry);
    for (let guard = 0; guard < 20 && s.stack.length > 0; guard++) s = pass(pass(s, familyRegistry), familyRegistry);
    s = advanceTo(s, 'declareBlockers', familyRegistry);
    return s.priorityPlayer === nonActive(s) ? s : pass(s, familyRegistry);
  }

  /** B blocks `attacker` with `blocker`; combat plays out to the second main phase. */
  function blockAndFinish(state: GameState, blocker: number, attacker: number): GameState {
    const declared = act(state, { kind: 'declareBlockers', player: 'B', blocks: [{ blocker, attacker }] }, familyRegistry);
    return advanceTo(declared, 'postcombatMain', familyRegistry);
  }

  crTest('702.93a', 'undying returns only a creature that had no +1/+1 counter as it died — the "if" reads last-known counters', () => {
    noted.length = 0;
    const state = familyMain();
    const wolf = putOnBattlefield(state, 'A', UNDYING_WOLF);
    const giant = putOnBattlefield(state, 'B', BIG);
    blockAndFinish(attackInto(state, wolf.instanceId), giant.instanceId, wolf.instanceId);
    expect(noted).toEqual(['undying']);
    // The same wolf carrying a +1/+1 counter: it dies, and the ability never
    // reaches the stack (CR 603.4's first check on the snapshotted count).
    noted.length = 0;
    const again = familyMain();
    const grown = putOnBattlefield(again, 'A', UNDYING_WOLF, { counters: { [PLUS_ONE_COUNTER]: 1 } });
    const giant2 = putOnBattlefield(again, 'B', BIG);
    const after = blockAndFinish(attackInto(again, grown.instanceId), giant2.instanceId, grown.instanceId);
    expect(onBattlefield(after, grown.instanceId)).toBeUndefined();
    expect(noted).toEqual([]);
  });

  crTest('702.100a', 'evolve triggers only when the entering creature has greater power or toughness than the source', () => {
    noted.length = 0;
    const state = familyMain();
    putOnBattlefield(state, 'A', EVOLVER);
    const [squire, giant] = giveHand(state, 'A', [TINY, BIG]);
    /** Cast from hand and pass until the spell AND anything it triggered have resolved. */
    const castAndSettle = (from: GameState, instanceId: number): GameState => {
      let s = act(from, { kind: 'castSpell', player: 'A', instanceId }, familyRegistry);
      for (let guard = 0; guard < 12 && s.stack.length > 0; guard++) s = pass(s, familyRegistry);
      return s;
    };
    const afterSquire = castAndSettle(state, squire!.instanceId);
    // A 1/1 beside a 0/1: greater power, so it fires.
    expect(noted).toEqual(['evolve']);
    castAndSettle(afterSquire, giant!.instanceId);
    expect(noted).toEqual(['evolve', 'evolve']);
    // Its own entry compares the source to itself and fails: a control.
    noted.length = 0;
    const own = familyMain();
    const [raptor] = giveHand(own, 'A', [EVOLVER]);
    castAndSettle(own, raptor!.instanceId);
    expect(noted).toEqual([]);
  });

  crTest('702.112a', 'renown grows the creature the first time it deals combat damage to a player, and never again', () => {
    noted.length = 0;
    const state = familyMain();
    const maulers = putOnBattlefield(state, 'A', RENOWNED);
    let s = attackInto(state, maulers.instanceId);
    s = advanceTo(s, 'postcombatMain', familyRegistry);
    expect(onBattlefield(s, maulers.instanceId)?.renowned).toBe(true);
    expect(noted).toEqual(['renown']);
    s = advanceToTurn(s, 3, 'precombatMain', familyRegistry);
    s = attackInto(s, maulers.instanceId);
    s = advanceTo(s, 'postcombatMain', familyRegistry);
    // Connected twice; renowned once — the second trigger never reached the stack.
    expect(noted).toEqual(['renown']);
  });

  crTest('702.105a', 'dethrone triggers when the defending player has the most life or is tied, and not otherwise', () => {
    noted.length = 0;
    const tied = familyMain();
    const emissary = putOnBattlefield(tied, 'A', DETHRONER);
    attackInto(tied, emissary.instanceId);
    expect(noted).toEqual(['dethrone']);
    noted.length = 0;
    const behind = familyMain();
    behind.players.B.life = behind.players.A.life - 1;
    const emissary2 = putOnBattlefield(behind, 'A', DETHRONER);
    attackInto(behind, emissary2.instanceId);
    expect(noted).toEqual([]);
  });

  crTest('702.98a', 'an unleashed creature with a +1/+1 counter can’t block, and the self-only static reaches no other creature', () => {
    const state = familyMain();
    const attacker = putOnBattlefield(state, 'A', BIG);
    const cackler = putOnBattlefield(state, 'B', UNLEASHED, { counters: { [PLUS_ONE_COUNTER]: 1 } });
    const bystander = putOnBattlefield(state, 'B', TINY);
    const blockers = attackInto(state, attacker.instanceId);
    expect(
      rejectionOf(blockers, { kind: 'declareBlockers', player: 'B', blocks: [{ blocker: cackler.instanceId, attacker: attacker.instanceId }] }, familyRegistry),
    ).toMatch(/cannot block/);
    expect(
      rejectionOf(blockers, { kind: 'declareBlockers', player: 'B', blocks: [{ blocker: bystander.instanceId, attacker: attacker.instanceId }] }, familyRegistry),
    ).toBeUndefined();
    // Without the counter the same Cackler blocks.
    const plain = familyMain();
    const attacker2 = putOnBattlefield(plain, 'A', BIG);
    const cackler2 = putOnBattlefield(plain, 'B', UNLEASHED);
    const blockers2 = attackInto(plain, attacker2.instanceId);
    expect(
      rejectionOf(blockers2, { kind: 'declareBlockers', player: 'B', blocks: [{ blocker: cackler2.instanceId, attacker: attacker2.instanceId }] }, familyRegistry),
    ).toBeUndefined();
  });

  crTest('702.54a', 'bloodthirst’s question — "an opponent was dealt damage this turn" — is a turn fact recorded for the damager’s side', () => {
    const state = familyMain();
    const bear = putOnBattlefield(state, 'A', BEAR);
    expect(turnFactHolds(state, 'opponentWasDealtDamage', 'A')).toBe(false);
    let s = attackInto(state, bear.instanceId);
    s = advanceTo(s, 'postcombatMain', familyRegistry);
    expect(s.players.B.life).toBe(18);
    expect(turnFactHolds(s, 'opponentWasDealtDamage', 'A')).toBe(true);
    expect(turnFactHolds(s, 'opponentWasDealtDamage', 'B')).toBe(false);
    // Cleared as the next turn begins.
    const next = advanceToTurn(s, 2, 'precombatMain', familyRegistry);
    expect(turnFactHolds(next, 'opponentWasDealtDamage', 'A')).toBe(false);
  });
// --- §3.113 the spell-count family: storm, cascade, ripple ---------------------------

/** A blank one-mana sorcery — the "other spell cast before it this turn". */
const BLANK_SPELL: CardDefinition = {
  id: 'blank-spell',
  name: 'Blank Spell',
  types: ['sorcery'],
  timing: 'sorcery',
  cost: { generic: 1 },
  effects: [],
};
/** Storm on a sorcery whose body records that it resolved. */
const STORM_SORCERY: CardDefinition = {
  id: 'storm-sorcery',
  name: 'Storm Sorcery',
  types: ['sorcery'],
  timing: 'sorcery',
  cost: { generic: 2 },
  effects: [{ primitive: 'countResolution' }],
  castTriggers: [{ keyword: 'storm', label: 'Storm', effects: [{ primitive: 'copyForEachEarlierSpell' }] }],
};
/** Cascade on a four-mana creature. */
const CASCADE_CREATURE: CardDefinition = {
  ...creatureDef('Cascade Bear', 3, 3, { cost: { generic: 4 } }),
  castTriggers: [{ keyword: 'cascade', label: 'Cascade', effects: [{ primitive: 'runCascade' }] }],
};
const CHEAP_BEAR = creatureDef('Cheap Bear', 2, 2, { cost: { generic: 2 } });
const COSTLY_BEAR = creatureDef('Costly Bear', 6, 6, { cost: { generic: 6 } });

describe('CR 702 — the spell-count family (§3.113)', () => {
  const resolutions: string[] = [];
  const registry = registryWith({
    countResolution: (ctx) => {
      resolutions.push(ctx.source.def.name);
    },
    // The cards package's `stormCopies`, in miniature: the count rides the
    // trigger, and the object copied is the spell still on the stack.
    copyForEachEarlierSpell: (ctx) => {
      const original = spellOnStackById(ctx.state, ctx.source.instanceId);
      if (!original) return;
      for (let i = 0; i < (ctx.triggeringAmount ?? 0); i++) {
        ctx.state.stack.push(makeSpellCopy(ctx.state, original, ctx.controller));
      }
    },
    runCascade: (ctx) => {
      const spell = spellOnStackById(ctx.state, ctx.source.instanceId);
      if (!spell) return;
      performCascade(ctx.state, ctx.controller, stackManaValueOf(spell), ctx.emit);
    },
  });

  /** A's precombat main with empty hands and a pool nothing here can exhaust. */
  function atMain(): GameState {
    const state = advanceTo(newGame({ registry }), 'precombatMain', registry);
    state.players.A.hand = [];
    state.players.B.hand = [];
    state.players.A.manaPool = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 20 };
    return state;
  }

  /** Pass until the stack empties or a cast window opens. */
  function settle(state: GameState): GameState {
    let s = state;
    for (let guard = 0; guard < 40 && s.stack.length > 0 && !s.madnessWindow; guard++) s = pass(s, registry);
    return s;
  }

  crTest('702.40a', 'storm copies the spell once for each OTHER spell cast before it this turn, and a copy is not itself a cast', () => {
    resolutions.length = 0;
    const state = atMain();
    const [first, second, storm] = giveHand(state, 'A', [BLANK_SPELL, BLANK_SPELL, STORM_SORCERY]);
    let s = act(state, { kind: 'castSpell', player: 'A', instanceId: first!.instanceId }, registry);
    s = settle(s);
    s = act(s, { kind: 'castSpell', player: 'A', instanceId: second!.instanceId }, registry);
    s = settle(s);
    expect(spellsCastThisTurn(s)).toBe(2);
    s = act(s, { kind: 'castSpell', player: 'A', instanceId: storm!.instanceId }, registry);
    // The trigger is above its spell, with the count already fixed — a spell
    // cast in RESPONSE cannot change it.
    const top = s.stack[s.stack.length - 1]!;
    expect(top.kind === 'trigger' && top.label).toBe('Storm');
    expect(top.kind === 'trigger' && top.triggeringAmount).toBe(2);
    s = settle(s);
    // Two copies plus the original: three resolutions, and only ONE card in the
    // graveyard, because a copy of a spell ceases to exist (CR 704.5e).
    expect(resolutions).toEqual(['Storm Sorcery', 'Storm Sorcery', 'Storm Sorcery']);
    expect(s.players.A.graveyard.filter((c) => c.def.name === 'Storm Sorcery').length).toBe(1);
    // Casting is what the count counts: the two copies did not raise it.
    expect(spellsCastThisTurn(s)).toBe(3);
  });

  crTest('702.85a', 'cascade exiles until a nonland card of lesser mana value, casts it for no mana, and bottoms the rest', () => {
    const state = atMain();
    const [cascader] = giveHand(state, 'A', [CASCADE_CREATURE]);
    const [land, costly, cheap, ...rest] = giveLibrary(state, 'A', [
      FILLER_LAND,
      COSTLY_BEAR,
      CHEAP_BEAR,
      FILLER_LAND,
      FILLER_LAND,
    ]);
    let s = act(state, { kind: 'castSpell', player: 'A', instanceId: cascader!.instanceId }, registry);
    s = settle(s);
    // It stopped on the first NONLAND card of LESSER mana value: past the land
    // (a land is never the hit) and past the 6-drop (not lesser than 4).
    expect(s.madnessWindow?.kind).toBe('cascade');
    expect(s.madnessWindow?.instanceId).toBe(cheap!.instanceId);
    expect(s.players.A.exile.map((c) => c.instanceId)).toEqual([land!.instanceId, costly!.instanceId, cheap!.instanceId]);
    // "Without paying its mana cost": an empty pool casts it.
    s.players.A.manaPool = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
    s = act(s, { kind: 'castSpell', player: 'A', instanceId: cheap!.instanceId, fromZone: 'exile' }, registry);
    expect(s.madnessWindow).toBeNull();
    // The two uncast cards are the bottom of the library, in SOME order.
    const library = s.players.A.library;
    expect(new Set(library.slice(-2).map((c) => c.instanceId))).toEqual(new Set([land!.instanceId, costly!.instanceId]));
    expect(library.slice(0, rest.length).map((c) => c.instanceId)).toEqual(rest.map((c) => c.instanceId));
    s = settle(s);
    expect(s.battlefield.map((c) => c.def.name)).toEqual(['Cheap Bear', 'Cascade Bear']);
  });

  crTest('702.85a', 'declining the cascade window bottoms the whole pile, the offered card included', () => {
    const state = atMain();
    const [cascader] = giveHand(state, 'A', [CASCADE_CREATURE]);
    const [cheap] = giveLibrary(state, 'A', [CHEAP_BEAR, FILLER_LAND, FILLER_LAND]);
    let s = act(state, { kind: 'castSpell', player: 'A', instanceId: cascader!.instanceId }, registry);
    s = settle(s);
    expect(s.madnessWindow?.instanceId).toBe(cheap!.instanceId);
    s = act(s, { kind: 'passPriority', player: 'A' }, registry);
    expect(s.madnessWindow).toBeNull();
    expect(s.players.A.exile).toEqual([]);
    expect(s.players.A.library.some((c) => c.instanceId === cheap!.instanceId)).toBe(true);
    s = settle(s);
    expect(s.battlefield.map((c) => c.def.name)).toEqual(['Cascade Bear']);
  });
});

assertFileMatchesManifest(FILE);
