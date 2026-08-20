/**
 * CONFORMANCE — CR 4xx (zones).
 *
 * The rules in this chapter are the ones a rules engine is most likely to get
 * *almost* right: a card really does move, so nothing looks broken, while the
 * object's identity, its order in the zone, or a continuous effect that should
 * have stopped quietly survives the trip. Each of those is a rule here.
 *
 * Covered: the new-object rule (400.7) and the two things it must reset — marked
 * damage / counters, and grants made to the card in its old zone; library order
 * and drawing from the top (401); the graveyard as an ordered zone a resolved
 * spell falls into (404, 608.2m); the stack's last-in-first-out order (405); and
 * exile as the destination flashback substitutes (406, 702.34a).
 */

import { describe, expect } from 'vitest';
import {
  DEFAULT_RULES,
  MINUS_ONE_COUNTER,
  PLUS_ONE_COUNTER,
  addCardGrant,
  createGame,
  flashbackCostOf,
  generateLegalActions,
  spellLeaveDestination,
  type CardDefinition,
  type GameState,
  type SpellStackObject,
} from '../index.js';
import { creatureDef, deckOf, giveGraveyard, giveHand, giveLibrary, landDef } from '../test-fixtures.js';
import {
  act,
  advanceTo,
  assertFileMatchesManifest,
  crTest,
  onBattlefield,
  pass,
  putOnBattlefield,
  registryWith,
} from './harness.js';

const FILE = 'cr4xx-zones';

const MOUNTAIN = landDef('Mountain', 'R');

/** A 2/2 that will be killed by a lethal-damage state-based action. */
const BEAR = creatureDef('Bear', 2, 2);

/** An instant with flashback, so a real flashback cast can be exiled on resolution. */
const RECURRING_BOLT: CardDefinition = {
  id: 'recurring-bolt',
  name: 'Recurring Bolt',
  types: ['instant'],
  timing: 'instant',
  cost: { R: 1 },
  flashback: { R: 1 },
  effects: [{ primitive: 'noop' }],
};

/** A plain instant, for the ordinary "resolves into the graveyard" case. */
const PLAIN_BOLT: CardDefinition = {
  id: 'plain-bolt',
  name: 'Plain Bolt',
  types: ['instant'],
  timing: 'instant',
  cost: { R: 1 },
  effects: [{ primitive: 'noop' }],
};

/** Two distinguishable instants, so stack ORDER can be read off the graveyard. */
function labelledBolt(id: string): CardDefinition {
  return { ...PLAIN_BOLT, id, name: id };
}

const registry = registryWith({
  noop: () => {},
  /** Marks lethal damage on every creature, so a real SBA moves it to a graveyard. */
  wrath: (ctx) => {
    for (const perm of ctx.state.battlefield) {
      if (!perm.def.types.includes('creature')) continue;
      perm.damageMarked += 99;
      ctx.emit({ type: 'damageDealt', source: ctx.source.instanceId, target: perm.instanceId, amount: 99, combat: false });
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

/** Give A `n` untapped Mountains and float that much red mana. */
function withRedMana(state: GameState, n: number): GameState {
  let s = state;
  for (let i = 0; i < n; i++) {
    const land = putOnBattlefield(s, 'A', MOUNTAIN);
    s = act(s, { kind: 'tapForMana', player: 'A', instanceId: land.instanceId }, registry);
  }
  return s;
}

/** Both players pass — resolves the top of the stack, or ends the step. */
function bothPass(state: GameState): GameState {
  return pass(pass(state, registry), registry);
}

// --- CR 400.7: a card that changes zones is a NEW object ----------------------------

describe('CR 400.7 — an object that changes zones becomes a new object', () => {
  crTest('400.7', 'a creature that dies loses its marked damage, counters and tapped status', () => {
    const state = atMain();
    const bear = putOnBattlefield(state, 'A', BEAR, {
      tapped: true,
      counters: { [PLUS_ONE_COUNTER]: 3, [MINUS_ONE_COUNTER]: 1 },
    });
    const wrath: CardDefinition = { id: 'wrath', name: 'Wrath', types: ['sorcery'], effects: [{ primitive: 'wrath' }] };
    const [spell] = giveHand(state, 'A', [wrath]);
    let s = act(state, { kind: 'castSpell', player: 'A', instanceId: spell!.instanceId }, registry);
    s = bothPass(s);

    expect(onBattlefield(s, bear.instanceId)).toBeUndefined();
    const dead = s.players.A.graveyard.find((c) => c.instanceId === bear.instanceId);
    expect(dead).toBeTruthy();
    expect(dead!.damageMarked).toBe(0);
    expect(dead!.tapped).toBe(false);
    expect(dead!.counters[PLUS_ONE_COUNTER] ?? 0).toBe(0);
    expect(dead!.counters[MINUS_ONE_COUNTER] ?? 0).toBe(0);
  });

  crTest('400.7', 'a grant made to a card in a graveyard stops applying when the card leaves that zone', () => {
    const state = atMain();
    const [card] = giveGraveyard(state, 'A', [PLAIN_BOLT]);
    addCardGrant(
      state,
      { targetInstanceId: card!.instanceId, sourceInstanceId: 0, zone: 'graveyard', flashback: { R: 1 } },
      () => {},
    );
    expect(flashbackCostOf(state, card!)).toEqual({ R: 1 });

    // Cast it with the granted flashback: the card leaves the graveyard, so the
    // grant must not follow it onto the stack.
    let s = withRedMana(state, 1);
    s = act(
      s,
      { kind: 'castSpell', player: 'A', instanceId: card!.instanceId, fromZone: 'graveyard' },
      registry,
    );
    const onStack = s.stack.find((o) => o.instanceId === card!.instanceId);
    expect(onStack).toBeTruthy();
    expect(s.cardGrants ?? []).toHaveLength(0);
  });
});

// --- CR 401: library ------------------------------------------------------------------

describe('CR 401 — library', () => {
  crTest('401.2', 'the library is an ordered zone and a draw takes the card from the TOP', () => {
    const state = atMain();
    const marker = creatureDef('Top Card', 9, 9);
    giveLibrary(state, 'A', [marker, BEAR, BEAR, BEAR, BEAR, BEAR, BEAR]);
    const libraryBefore = state.players.A.library.length;

    // Run the game to A's NEXT draw step so a real draw step does the drawing.
    let s = state;
    for (let guard = 0; guard < 400 && !(s.turnNumber === 3 && s.step === 'draw'); guard++) s = pass(s, registry);
    expect(s.turnNumber).toBe(3);
    expect(s.players.A.library.length).toBe(libraryBefore - DEFAULT_RULES.cardsPerDrawStep);
    expect(s.players.A.hand.some((c) => c.def.id === marker.id)).toBe(true);
  });

  crTest('400.1', 'a card drawn from the library is in the hand zone and nowhere else', () => {
    const state = atMain();
    const marker = creatureDef('Top Card 2', 9, 9);
    giveLibrary(state, 'A', [marker, BEAR, BEAR, BEAR, BEAR]);
    let s = state;
    for (let guard = 0; guard < 400 && !(s.turnNumber === 3 && s.step === 'precombatMain'); guard++) {
      s = pass(s, registry);
    }
    const drawn = s.players.A.hand.find((c) => c.def.id === marker.id);
    expect(drawn).toBeTruthy();
    expect(drawn!.zone).toBe('hand');
    expect(s.players.A.library.some((c) => c.instanceId === drawn!.instanceId)).toBe(false);
  });
});

// --- CR 404 / 608.2m: the graveyard --------------------------------------------------

describe('CR 404 — graveyard', () => {
  crTest('608.2n', 'an instant that finishes resolving is put into its owner’s graveyard', () => {
    const state = atMain();
    const [card] = giveHand(state, 'A', [PLAIN_BOLT]);
    let s = withRedMana(state, 1);
    s = act(s, { kind: 'castSpell', player: 'A', instanceId: card!.instanceId }, registry);
    expect(s.stack).toHaveLength(1);
    s = bothPass(s);
    expect(s.stack).toHaveLength(0);
    const inGraveyard = s.players.A.graveyard.find((c) => c.instanceId === card!.instanceId);
    expect(inGraveyard).toBeTruthy();
    expect(inGraveyard!.zone).toBe('graveyard');
  });

  crTest('404.3', 'the graveyard is an ORDERED zone — the most recent card is on top', () => {
    const state = atMain();
    const first = labelledBolt('first-bolt');
    const second = labelledBolt('second-bolt');
    const [a, b] = giveHand(state, 'A', [first, second]);
    let s = withRedMana(state, 2);
    s = act(s, { kind: 'castSpell', player: 'A', instanceId: a!.instanceId }, registry);
    s = bothPass(s);
    s = act(s, { kind: 'castSpell', player: 'A', instanceId: b!.instanceId }, registry);
    s = bothPass(s);
    expect(s.players.A.graveyard.map((c) => c.def.id)).toEqual([first.id, second.id]);
  });
});

// --- CR 405: the stack ------------------------------------------------------------------

describe('CR 405 — the stack', () => {
  crTest('405.1', 'a cast spell goes on the stack and is no longer in its owner’s hand', () => {
    const state = atMain();
    const [card] = giveHand(state, 'A', [PLAIN_BOLT]);
    let s = withRedMana(state, 1);
    s = act(s, { kind: 'castSpell', player: 'A', instanceId: card!.instanceId }, registry);
    expect(s.players.A.hand.some((c) => c.instanceId === card!.instanceId)).toBe(false);
    expect(s.stack.map((o) => o.instanceId)).toEqual([card!.instanceId]);
    expect((s.stack[0] as SpellStackObject).card.zone).toBe('stack');
  });

  crTest('405.5', 'the stack resolves LAST IN, FIRST OUT — one object at a time', () => {
    const state = atMain();
    const first = labelledBolt('bottom-bolt');
    const second = labelledBolt('top-bolt');
    const [a, b] = giveHand(state, 'A', [first, second]);
    let s = withRedMana(state, 2);
    s = act(s, { kind: 'castSpell', player: 'A', instanceId: a!.instanceId }, registry);
    s = act(s, { kind: 'castSpell', player: 'A', instanceId: b!.instanceId }, registry);
    expect(s.stack.map((o) => o.instanceId)).toEqual([a!.instanceId, b!.instanceId]);

    // One round of passes resolves exactly ONE object — the top one.
    s = bothPass(s);
    expect(s.stack.map((o) => o.instanceId)).toEqual([a!.instanceId]);
    expect(s.players.A.graveyard.map((c) => c.def.id)).toEqual([second.id]);

    s = bothPass(s);
    expect(s.stack).toHaveLength(0);
    expect(s.players.A.graveyard.map((c) => c.def.id)).toEqual([second.id, first.id]);
  });

  crTest('117.3b', 'the active player receives priority again after an object resolves', () => {
    const state = atMain();
    const [card] = giveHand(state, 'A', [PLAIN_BOLT]);
    let s = withRedMana(state, 1);
    s = act(s, { kind: 'castSpell', player: 'A', instanceId: card!.instanceId }, registry);
    // The caster keeps priority with the spell on the stack (CR 117.3c).
    expect(s.priorityPlayer).toBe('A');
    s = bothPass(s);
    expect(s.stack).toHaveLength(0);
    expect(s.priorityPlayer).toBe(s.activePlayer);
    expect(s.step).toBe('precombatMain');
  });
});

// --- CR 406 / 702.34a: exile ---------------------------------------------------------------

describe('CR 406 — exile', () => {
  crTest('702.34a', 'a spell cast from a graveyard with flashback is EXILED as it leaves the stack', () => {
    const state = atMain();
    const [card] = giveGraveyard(state, 'A', [RECURRING_BOLT]);
    let s = withRedMana(state, 1);
    expect(
      generateLegalActions(s).some((a) => a.kind === 'castSpell' && a.fromZone === 'graveyard'),
    ).toBe(true);
    s = act(s, { kind: 'castSpell', player: 'A', instanceId: card!.instanceId, fromZone: 'graveyard' }, registry);
    const stackObject = s.stack[0] as SpellStackObject;
    expect(stackObject.castFrom).toBe('graveyard');
    expect(spellLeaveDestination(stackObject)).toBe('exile');

    s = bothPass(s);
    expect(s.players.A.exile.map((c) => c.instanceId)).toEqual([card!.instanceId]);
    expect(s.players.A.graveyard.some((c) => c.instanceId === card!.instanceId)).toBe(false);
  });

  crTest('702.34a', 'exile is where a flashback spell goes even when it leaves the stack unresolved', () => {
    // The destination is a property of the STACK OBJECT, not of resolution, which
    // is what makes countering agree with resolving. Asserted on the object the
    // engine actually built for a real flashback cast.
    const state = atMain();
    const [card] = giveGraveyard(state, 'A', [RECURRING_BOLT]);
    let s = withRedMana(state, 1);
    s = act(s, { kind: 'castSpell', player: 'A', instanceId: card!.instanceId, fromZone: 'graveyard' }, registry);
    const flashbackObject = s.stack[0] as SpellStackObject;
    const handObject: SpellStackObject = { ...flashbackObject, castFrom: undefined };
    expect(spellLeaveDestination(flashbackObject)).toBe('exile');
    expect(spellLeaveDestination(handObject)).toBe('graveyard');
  });
});

assertFileMatchesManifest(FILE);
