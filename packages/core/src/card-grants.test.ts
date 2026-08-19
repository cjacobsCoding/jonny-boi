/**
 * GRAVEYARD TARGETING + CARD GRANTS — the two halves of Snapcaster Mage, pinned
 * at the core level where each can fail silently.
 *
 * What is asserted here, ordered by how quietly each would break:
 *  1. **A graveyard card is a legal target, and only the right one.** The
 *     restriction reaches the ACTING player's own graveyard, only instants and
 *     sorceries in it, and nothing at all with no actor named — the same
 *     unknown-controller conservatism `'opponent'` uses.
 *  2. **The trigger fizzles when its target leaves in response.** The target is
 *     chosen as the ability goes on the stack (CR 603.3d), so a card that has
 *     left the graveyard by resolution must leave the ability doing NOTHING —
 *     the failure that would otherwise show up as a grant on a card in exile.
 *  3. **The grant is visible to the cast path** — `flashbackCostOf` is the one
 *     accessor the offer loop and `applyCastSpell` both read, so a granted
 *     flashback plays exactly like a printed one.
 *  4. **The grant expires at end of turn**, through the real cleanup step.
 *  5. **The grant does NOT survive a zone change** (CR 400.7) — including a
 *     card that leaves the graveyard and comes back, which is a NEW object.
 *  6. **A granted flashback cast still exiles on leaving the stack.** The
 *     replacement rides the stack object's own `castFrom`, so pruning the grant
 *     as the card leaves the graveyard must not lose it.
 *  7. **The empty-check discipline holds**: a game with no grant carries no
 *     `cardGrants` field at all, so the hot loops pay one property read.
 */

import { describe, expect, it } from 'vitest';
import {
  addCardGrant,
  applyAction,
  cloneState,
  createGame,
  expireCardGrants,
  flashbackCostOf,
  generateLegalActions,
  hasCardGrants,
  isLegalTarget,
  legalTargetsFor,
  type CardDefinition,
  type GameAction,
  type GameState,
} from './index.js';
import { createEffectRegistry, type EffectRegistry } from './effects.js';
import { deckOf, giveGraveyard, giveHand, landDef } from './test-fixtures.js';

const ISLAND = landDef('Island', 'U');

/** A plain instant with no printed flashback — the grant's natural target. */
const BOLT: CardDefinition = {
  id: 'gy-instant',
  name: 'Recall Bolt',
  types: ['instant'],
  cost: { generic: 1, U: 1 },
  effects: [{ primitive: 'noteResolved' }],
};

/** A creature in the graveyard: never a legal target for this restriction. */
const BEAR: CardDefinition = {
  id: 'gy-creature',
  name: 'Yard Bear',
  types: ['creature'],
  cost: { generic: 1, G: 1 },
  power: 2,
  toughness: 2,
};

/** Snapcaster-shaped: flash + an ETB that grants flashback to a graveyard spell. */
const SNAPCASTER: CardDefinition = {
  id: 'snap',
  name: 'Snap Wizard',
  types: ['creature'],
  cost: { generic: 1, U: 1 },
  power: 2,
  toughness: 1,
  keywords: { flash: true },
  triggers: [
    {
      condition: { on: 'etb' },
      targets: 'instantOrSorceryInYourGraveyard',
      effects: [
        {
          primitive: 'grantFlashback',
          params: { targets: 'instantOrSorceryInYourGraveyard', cost: 'itsManaCost' },
        },
      ],
      label: 'Enters: grant flashback',
    },
  ],
};

/**
 * The `grantFlashback` primitive, re-implemented here against the SAME public
 * core API `packages/cards` uses. Core's own tests may not import `cards` (that
 * is the dependency direction), and a stub that only pretended to grant would
 * prove nothing — so this is the real behaviour, including the resolution-time
 * legality re-check that produces the fizzle. `packages/cards` owns the pinned
 * test of the SHIPPED primitive; this one pins the core machinery under it.
 */
function testRegistry(): EffectRegistry {
  const registry = createEffectRegistry();
  registry.register('noteResolved', (ctx) => {
    ctx.emit({ type: 'effectApplied', primitive: 'noteResolved', sourceInstanceId: ctx.source.instanceId });
  });
  registry.register('grantFlashback', (ctx) => {
    const target = ctx.targets[0];
    if (target === undefined || typeof target !== 'number') return;
    if (!isLegalTarget(ctx.state, 'instantOrSorceryInYourGraveyard', target, ctx.controller, ctx.source.def)) return;
    const card = ctx.state.players[ctx.controller].graveyard.find((c) => c.instanceId === target);
    if (!card?.def.cost) return;
    addCardGrant(
      ctx.state,
      {
        targetInstanceId: card.instanceId,
        sourceInstanceId: ctx.source.instanceId,
        zone: card.zone,
        duration: 'endOfTurn',
        flashback: card.def.cost,
      },
      ctx.emit,
    );
  });
  return registry;
}

/** A's precombat main with priority, an empty stack, and `islands` untapped Islands. */
function position(islands: number): GameState {
  const { state } = createGame({ seed: 11, decks: { A: deckOf(ISLAND, 30), B: deckOf(ISLAND, 30) } });
  state.step = 'precombatMain';
  state.activePlayer = 'A';
  state.priorityPlayer = 'A';
  state.stack = [];
  state.players.A.hand = [];
  state.players.B.hand = [];
  state.players.A.landsPlayedThisTurn = 1;
  const lands = giveHand(state, 'A', Array.from({ length: islands }, () => ISLAND));
  state.players.A.hand = [];
  for (const land of lands) {
    land.zone = 'battlefield';
    land.summoningSick = false;
    state.battlefield.push(land);
  }
  return state;
}

/** Tap every Island A controls, so the pool can fund a cast. */
function tapAll(state: GameState, registry: EffectRegistry): GameState {
  let next = state;
  for (const land of [...next.battlefield]) {
    if (land.controller !== 'A') continue;
    next = applyAction(next, { kind: 'tapForMana', player: 'A', instanceId: land.instanceId }, undefined, registry)
      .state;
  }
  return next;
}

describe('targeting a card in a graveyard', () => {
  it('offers only instants and sorceries in the ACTING player own graveyard', () => {
    const state = position(0);
    const [bolt, bear] = giveGraveyard(state, 'A', [BOLT, BEAR]);
    const [theirs] = giveGraveyard(state, 'B', [BOLT]);

    const mine = legalTargetsFor(state, 'instantOrSorceryInYourGraveyard', 'A');
    expect(mine).toEqual([bolt!.instanceId]);
    expect(mine).not.toContain(bear!.instanceId);
    expect(mine).not.toContain(theirs!.instanceId);

    // And the opponent's own graveyard is what THEY see — "your graveyard" is
    // read from the actor, never from the board.
    expect(legalTargetsFor(state, 'instantOrSorceryInYourGraveyard', 'B')).toEqual([theirs!.instanceId]);
  });

  it('offers nothing, and judges nothing legal, with no actor named', () => {
    const state = position(0);
    const [bolt] = giveGraveyard(state, 'A', [BOLT]);
    expect(legalTargetsFor(state, 'instantOrSorceryInYourGraveyard')).toEqual([]);
    expect(isLegalTarget(state, 'instantOrSorceryInYourGraveyard', bolt!.instanceId)).toBe(false);
  });

  it('stops being a legal target the moment the card leaves the graveyard', () => {
    const state = position(0);
    const [bolt] = giveGraveyard(state, 'A', [BOLT]);
    expect(isLegalTarget(state, 'instantOrSorceryInYourGraveyard', bolt!.instanceId, 'A')).toBe(true);
    // Exiled in response.
    state.players.A.graveyard = [];
    bolt!.zone = 'exile';
    state.players.A.exile.push(bolt!);
    expect(isLegalTarget(state, 'instantOrSorceryInYourGraveyard', bolt!.instanceId, 'A')).toBe(false);
  });
});

describe('the flashback grant', () => {
  it('is aimed by the ETB, and makes the card castable from the graveyard', () => {
    const registry = testRegistry();
    let state = position(4);
    const [bolt] = giveGraveyard(state, 'A', [BOLT]);
    const [snap] = giveHand(state, 'A', [SNAPCASTER]);

    // Before the ETB the card has no flashback at all — the control case.
    expect(flashbackCostOf(state, bolt!)).toBeUndefined();
    expect(hasCardGrants(state)).toBe(false);
    expect(state.cardGrants).toBeUndefined();

    state = tapAll(state, registry);
    state = applyAction(state, { kind: 'castSpell', player: 'A', instanceId: snap!.instanceId }, undefined, registry)
      .state;
    // Resolve the creature, then its trigger (one legal target ⇒ auto-aimed).
    for (let i = 0; i < 8 && state.stack.length > 0; i++) {
      state = applyAction(state, { kind: 'passPriority', player: state.priorityPlayer }, undefined, registry).state;
    }

    const granted = state.players.A.graveyard.find((c) => c.instanceId === bolt!.instanceId)!;
    expect(granted).toBeDefined();
    expect(flashbackCostOf(state, granted)).toEqual(BOLT.cost);
    expect(hasCardGrants(state)).toBe(true);
  });

  it('does NOTHING when its target left the graveyard in response (the fizzle)', () => {
    const registry = testRegistry();
    const state = position(0);
    const [bolt] = giveGraveyard(state, 'A', [BOLT]);
    const [snap] = giveHand(state, 'A', [SNAPCASTER]);
    // The trigger is on the stack, already aimed at the bolt…
    state.players.A.hand = [];
    snap!.zone = 'battlefield';
    state.battlefield.push(snap!);
    state.stack.push({
      kind: 'trigger',
      instanceId: 900,
      sourceInstanceId: snap!.instanceId,
      controller: 'A',
      effects: SNAPCASTER.triggers![0]!.effects,
      targets: [bolt!.instanceId],
      label: 'Enters: grant flashback',
    });
    // …and the bolt is exiled before it resolves.
    state.players.A.graveyard = [];
    bolt!.zone = 'exile';
    state.players.A.exile.push(bolt!);

    let next = applyAction(state, { kind: 'passPriority', player: 'A' }, undefined, registry).state;
    next = applyAction(next, { kind: 'passPriority', player: 'B' }, undefined, registry).state;

    expect(next.stack).toHaveLength(0);
    expect(hasCardGrants(next)).toBe(false);
    expect(flashbackCostOf(next, next.players.A.exile[0]!)).toBeUndefined();
  });

  it('expires at end of turn, saying so in the log', () => {
    const state = position(0);
    const [bolt] = giveGraveyard(state, 'A', [BOLT]);
    const events: { type: string }[] = [];
    addCardGrant(
      state,
      { targetInstanceId: bolt!.instanceId, sourceInstanceId: 99, zone: 'graveyard', flashback: BOLT.cost },
      (e) => events.push(e),
    );
    expect(flashbackCostOf(state, bolt!)).toEqual(BOLT.cost);

    expect(expireCardGrants(state, 'endOfTurn', (e) => events.push(e))).toBe(1);
    expect(flashbackCostOf(state, bolt!)).toBeUndefined();
    expect(events.map((e) => e.type)).toEqual(['cardGrantAdded', 'cardGrantExpired']);
  });

  it('expires through the real cleanup step', () => {
    const registry = testRegistry();
    let state = position(0);
    const [bolt] = giveGraveyard(state, 'A', [BOLT]);
    addCardGrant(
      state,
      { targetInstanceId: bolt!.instanceId, sourceInstanceId: 99, zone: 'graveyard', flashback: BOLT.cost },
      () => {},
    );
    const turn = state.turnNumber;
    for (let i = 0; i < 80 && state.turnNumber === turn; i++) {
      state = applyAction(state, { kind: 'passPriority', player: state.priorityPlayer }, undefined, registry).state;
    }
    expect(state.turnNumber).toBeGreaterThan(turn);
    expect(hasCardGrants(state)).toBe(false);
  });

  it('does not survive the card changing zones, and does not come back with it', () => {
    const state = position(0);
    const [bolt] = giveGraveyard(state, 'A', [BOLT]);
    addCardGrant(
      state,
      { targetInstanceId: bolt!.instanceId, sourceInstanceId: 99, zone: 'graveyard', flashback: BOLT.cost },
      () => {},
    );
    // Returned to hand: the recorded zone no longer matches, so it cannot apply.
    state.players.A.graveyard = [];
    bolt!.zone = 'hand';
    state.players.A.hand.push(bolt!);
    expect(flashbackCostOf(state, bolt!)).toBeUndefined();
  });

  it('is dropped by the zone-move chokepoint, so a card that comes BACK is clean', () => {
    const registry = testRegistry();
    const state = position(2);
    const [bolt] = giveGraveyard(state, 'A', [BOLT]);
    addCardGrant(
      state,
      { targetInstanceId: bolt!.instanceId, sourceInstanceId: 99, zone: 'graveyard', flashback: BOLT.cost },
      () => {},
    );
    // Cast it on the grant (graveyard → stack) — the chokepoint prunes it…
    const funded = tapAll(state, registry);
    const cast = applyAction(
      funded,
      { kind: 'castSpell', player: 'A', instanceId: bolt!.instanceId, fromZone: 'graveyard' },
      undefined,
      registry,
    ).state;
    expect(hasCardGrants(cast)).toBe(false);
    // …and putting the card back in the graveyard afterwards does not revive it:
    // it is a new object (CR 400.7), which must be castable only for its printed
    // cost — i.e. not at all, since this card prints no flashback.
    const onStack = cast.stack.find((o) => o.kind === 'spell');
    expect(onStack).toBeDefined();
    const returned = (onStack as { card: { zone: string } }).card;
    returned.zone = 'graveyard';
    expect(flashbackCostOf(cast, returned as never)).toBeUndefined();
  });

  it('survives the per-action clone, unaliased', () => {
    const state = position(0);
    const [bolt] = giveGraveyard(state, 'A', [BOLT]);
    addCardGrant(
      state,
      { targetInstanceId: bolt!.instanceId, sourceInstanceId: 99, zone: 'graveyard', flashback: BOLT.cost },
      () => {},
    );
    const copy = cloneState(state);
    expect(flashbackCostOf(copy, copy.players.A.graveyard[0]!)).toEqual(BOLT.cost);
    // Deep, not aliased: mutating the copy's grant must not touch the original.
    copy.cardGrants![0] = { ...copy.cardGrants![0]!, flashback: { generic: 9 } };
    expect(flashbackCostOf(state, bolt!)).toEqual(BOLT.cost);
  });

  it('a game with no grant never carries the field (the empty-check discipline)', () => {
    const state = position(2);
    expect(state.cardGrants).toBeUndefined();
    expect(hasCardGrants(state)).toBe(false);
    expect(cloneState(state).cardGrants).toBeUndefined();
  });
});

describe('casting on a granted flashback', () => {
  /** A position where the bolt in A's graveyard already carries the grant. */
  function granted(): { state: GameState; registry: EffectRegistry; boltId: number } {
    const registry = testRegistry();
    const state = position(2);
    const [bolt] = giveGraveyard(state, 'A', [BOLT]);
    addCardGrant(
      state,
      { targetInstanceId: bolt!.instanceId, sourceInstanceId: 99, zone: 'graveyard', flashback: BOLT.cost },
      () => {},
    );
    return { state, registry, boltId: bolt!.instanceId };
  }

  it('is OFFERED by generateLegalActions exactly like a printed flashback', () => {
    const { state, registry, boltId } = granted();
    const funded = tapAll(state, registry);
    const offered = generateLegalActions(funded).filter(
      (a): a is Extract<GameAction, { kind: 'castSpell' }> => a.kind === 'castSpell' && a.fromZone === 'graveyard',
    );
    expect(offered.map((a) => a.instanceId)).toEqual([boltId]);
  });

  it('resolves to EXILE — the grant is pruned, the replacement is not', () => {
    const { state, registry, boltId } = granted();
    let next = tapAll(state, registry);
    next = applyAction(
      next,
      { kind: 'castSpell', player: 'A', instanceId: boltId, fromZone: 'graveyard' },
      undefined,
      registry,
    ).state;
    // Casting moved the card out of the graveyard, so the grant is pruned…
    expect(hasCardGrants(next)).toBe(false);
    // …and the spell still exiles on leaving the stack (CR 702.34a), because
    // that replacement rides the stack object's `castFrom`, not the grant.
    for (let i = 0; i < 6 && next.stack.length > 0; i++) {
      next = applyAction(next, { kind: 'passPriority', player: next.priorityPlayer }, undefined, registry).state;
    }
    expect(next.players.A.exile.map((c) => c.instanceId)).toContain(boltId);
    expect(next.players.A.graveyard.map((c) => c.instanceId)).not.toContain(boltId);
  });

  it('rejects a graveyard cast of a card with neither a printed nor a granted cost', () => {
    const registry = testRegistry();
    const state = position(2);
    const [bolt] = giveGraveyard(state, 'A', [BOLT]);
    const funded = tapAll(state, registry);
    const result = applyAction(
      funded,
      { kind: 'castSpell', player: 'A', instanceId: bolt!.instanceId, fromZone: 'graveyard' },
      undefined,
      registry,
    );
    expect(result.events.some((e) => e.type === 'actionRejected')).toBe(true);
  });
});
