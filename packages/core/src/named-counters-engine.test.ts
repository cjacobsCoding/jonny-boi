/**
 * §3.149 — THE NAMED-COUNTER FAMILY, PLAYED RATHER THAN COMPILED.
 *
 * Three seams landed together, and each of them is the kind that a compile test
 * cannot see. A card can compile `'complete'` and still do nothing on a board —
 * that is exactly the defect the counters work found last time ("~ enters with N
 * +1/+1 counters on it" put on NO counters at all, because the primitive looked
 * only at the battlefield while the permanent was still resolving). So every
 * claim here is made against a real `applyAction` on a real board.
 *
 * Each seam is pinned from BOTH sides — it does the thing it says, and it does
 * NOT do the near-miss thing that would make it a different card:
 *
 *  1. A named counter of an INERT kind really lands, on a non-creature.
 *  2. `activateOnly` refuses the ability below the printed floor and allows it
 *     at the floor — and the counters are NOT spent, because a restriction is
 *     checked, never paid. Both the legality path AND the offer menu are
 *     asserted, because an ability offered-but-refused is its own bug.
 *  3. `youLostLife` is set by DAMAGE, which is what Luminarch Ascension's own
 *     reminder text ("Damage causes loss of life.") insists on, and the
 *     intervening "if" reads the negation.
 */

import { describe, expect, it } from 'vitest';
import { applyAction, createGame, generateLegalActions } from './engine.js';
import { createEffectRegistry } from './effects.js';
import { interveningIfHolds } from './intervening.js';
import { turnFactHolds, recordTurnFacts, clearTurnFacts } from './turn-facts.js';
import type { CardDefinition } from './card.js';
import type { EffectRegistry } from './effects.js';
import type { GameAction, GameState, InstanceId } from './index.js';

/** A plain land, so the decks are legal and the board is quiet. */
const FOREST: CardDefinition = {
  id: 'forest',
  name: 'Forest',
  types: ['land'],
  subtypes: ['forest'],
  produces: ['G'],
};

/**
 * An enchantment shaped exactly like Luminarch Ascension's second line: an
 * ability gated on four quest counters, plus a free ability that ADDS one so a
 * test can walk the gate open without hand-editing the instance.
 */
const ASCENSION: CardDefinition = {
  id: 'ascension',
  name: 'Test Ascension',
  types: ['enchantment'],
  activated: [
    {
      cost: {},
      effects: [{ primitive: 'addCounters', params: { amount: 1, kind: 'quest', self: true } }],
      label: 'Put a quest counter on ~',
    },
    {
      cost: {},
      effects: [{ primitive: 'noteActivation' }],
      label: 'Make an Angel. Activate only if ~ has four or more quest counters on it',
      activateOnly: { kind: 'sourceHasCounters', counter: 'quest', min: 4 },
    },
  ],
};

const GATED_INDEX = 1;
const ADD_COUNTER_INDEX = 0;

/** A registry with the real `addCounters` plus a witness for the gated ability. */
function registryWithCounters(): { registry: EffectRegistry; fired: { count: number } } {
  const registry = createEffectRegistry();
  const fired = { count: 0 };
  // The real counter write, in the shape the cards package emits — kept local so
  // this file does not depend on the cards package (DESIGN §6: core stands alone).
  registry.register('addCounters', (ctx) => {
    const kind = ctx.params.kind;
    const amount = ctx.params.amount;
    if (typeof kind !== 'string' || typeof amount !== 'number') return;
    const self = ctx.state.battlefield.find((c) => c.instanceId === ctx.source.instanceId);
    if (!self) return;
    self.counters = { ...self.counters, [kind]: (self.counters[kind] ?? 0) + amount };
  });
  registry.register('noteActivation', () => {
    fired.count += 1;
  });
  return { registry, fired };
}

/** Start a game with `def` already on A's battlefield, untapped and not sick. */
function boardWith(def: CardDefinition): {
  state: GameState;
  registry: EffectRegistry;
  id: InstanceId;
  fired: { count: number };
} {
  const { registry, fired } = registryWithCounters();
  const library = [def, ...Array.from({ length: 40 }, () => FOREST)];
  const state = createGame({
    seed: 5,
    startingPlayer: 'A',
    registry,
    decks: { A: { cards: library }, B: { cards: library } },
  }).state;
  const instance = state.players.A.library.find((c) => c.def.id === def.id)!;
  state.players.A.library = state.players.A.library.filter((c) => c !== instance);
  instance.zone = 'battlefield';
  instance.summoningSick = false;
  state.battlefield.push(instance);
  return { state, registry, id: instance.instanceId, fired };
}

/** Resolve everything on the stack by passing priority from both seats. */
function resolveStack(state: GameState, registry: EffectRegistry): GameState {
  let current = state;
  for (let i = 0; i < 8 && current.stack.length > 0; i++) {
    const pass: GameAction = { kind: 'passPriority', player: current.priorityPlayer };
    current = applyAction(current, pass, undefined, registry).state;
  }
  return current;
}

/** Activate `index` on `id` and resolve it. */
function activate(state: GameState, registry: EffectRegistry, id: InstanceId, index: number) {
  const result = applyAction(
    state,
    { kind: 'activateAbility', player: 'A', instanceId: id, abilityIndex: index },
    undefined,
    registry,
  );
  return { ...result, state: resolveStack(result.state, registry) };
}

describe('§3.149 — a named counter of an inert kind really lands', () => {
  it('puts a quest counter on an ENCHANTMENT, which the +1/+1 path could never do', () => {
    const { state, registry, id } = boardWith(ASCENSION);
    const before = state.battlefield.find((c) => c.instanceId === id)!;
    expect(before.counters.quest ?? 0, 'nothing there to begin with').toBe(0);

    const after = activate(state, registry, id, ADD_COUNTER_INDEX).state;
    const perm = after.battlefield.find((c) => c.instanceId === id)!;
    // The discriminator: before this seam the target had to be a creature, so an
    // enchantment took NO counter at all and the line was silently a no-op.
    expect(perm.counters.quest, 'the counter is on the enchantment').toBe(1);
  });
});

describe('§3.149 — "Activate only if ~ has four or more quest counters on it"', () => {
  it('REFUSES the ability below the printed floor', () => {
    const { state, registry, id, fired } = boardWith(ASCENSION);
    const result = applyAction(
      state,
      { kind: 'activateAbility', player: 'A', instanceId: id, abilityIndex: GATED_INDEX },
      undefined,
      registry,
    );
    // A refusal is an `actionRejected` event carrying the reason — the shape
    // `rejectWith` produces. Asserted by REASON, not merely by "some rejection":
    // an ability refused for the wrong cause (summoning sickness, no priority)
    // would otherwise make this test pass while the restriction did nothing.
    const rejection = result.events.find((e) => e.type === 'actionRejected');
    expect(rejection, 'the engine refused it').toBeDefined();
    expect(
      (rejection as { reason: string }).reason,
      'and refused it FOR the counter restriction',
    ).toMatch(/quest counters/);
    expect(result.state.stack, 'nothing reached the stack').toHaveLength(0);
    expect(fired.count, 'and nothing resolved').toBe(0);
  });

  it('does not OFFER it below the floor either — the menu and the gate agree', () => {
    const { state, id } = boardWith(ASCENSION);
    const offered = generateLegalActions(state).filter(
      (a) => a.kind === 'activateAbility' && a.instanceId === id && a.abilityIndex === GATED_INDEX,
    );
    // An ability the engine will refuse must never appear in the menu a pilot
    // plays from: that disagreement is DESIGN §3.36's failure shape.
    expect(offered, 'the gated ability is absent from the action menu').toHaveLength(0);
  });

  it('ALLOWS it at the floor, and does NOT spend the counters', () => {
    const board = boardWith(ASCENSION);
    let state = board.state;
    for (let i = 0; i < 4; i++) state = activate(state, board.registry, board.id, ADD_COUNTER_INDEX).state;
    expect(state.battlefield.find((c) => c.instanceId === board.id)!.counters.quest).toBe(4);

    const offered = generateLegalActions(state).filter(
      (a) => a.kind === 'activateAbility' && a.instanceId === board.id && a.abilityIndex === GATED_INDEX,
    );
    expect(offered.length, 'now it is offered').toBeGreaterThan(0);

    const after = activate(state, board.registry, board.id, GATED_INDEX).state;
    expect(board.fired.count, 'the ability actually resolved').toBe(1);
    // THE POINT OF THE SEAM: a restriction is CHECKED, never PAID. Modelling it
    // as a cost would eat the counters and make Luminarch Ascension a strictly
    // worse card that makes one Angel instead of one per turn forever.
    expect(
      after.battlefield.find((c) => c.instanceId === board.id)!.counters.quest,
      'the four quest counters are still there',
    ).toBe(4);
  });
});

describe('§3.149 — "if you didn\'t lose life this turn"', () => {
  /** A bare state whose turn facts can be driven directly. */
  const freshState = (): GameState => boardWith(ASCENSION).state;

  it('DAMAGE sets youLostLife — the card\'s own reminder text demands it', () => {
    const state = freshState();
    clearTurnFacts(state);
    expect(turnFactHolds(state, 'youLostLife', 'A')).toBe(false);
    // Damage to a player is applied as a negative `lifeChanged` (damage-result.ts),
    // which is the event the fact is fed from.
    recordTurnFacts(state, { type: 'lifeChanged', player: 'A', delta: -3, to: 17 });
    expect(turnFactHolds(state, 'youLostLife', 'A'), 'A lost life').toBe(true);
    expect(turnFactHolds(state, 'youLostLife', 'B'), 'B did not').toBe(false);
  });

  it('GAINING life does not set it, and losing does not set youGainedLife', () => {
    const state = freshState();
    clearTurnFacts(state);
    recordTurnFacts(state, { type: 'lifeChanged', player: 'A', delta: +3, to: 23 });
    expect(turnFactHolds(state, 'youLostLife', 'A'), 'a gain is not a loss').toBe(false);
    expect(turnFactHolds(state, 'youGainedLife', 'A')).toBe(true);

    const other = freshState();
    clearTurnFacts(other);
    recordTurnFacts(other, { type: 'lifeChanged', player: 'A', delta: -1, to: 19 });
    expect(turnFactHolds(other, 'youGainedLife', 'A'), 'a loss is not a gain').toBe(false);
  });

  it('a turn with BOTH answers true to both questions independently', () => {
    const state = freshState();
    clearTurnFacts(state);
    recordTurnFacts(state, { type: 'lifeChanged', player: 'A', delta: +2, to: 22 });
    recordTurnFacts(state, { type: 'lifeChanged', player: 'A', delta: -1, to: 21 });
    expect(turnFactHolds(state, 'youGainedLife', 'A')).toBe(true);
    expect(turnFactHolds(state, 'youLostLife', 'A')).toBe(true);
  });

  it('the intervening "if" reads the NEGATION, and against the SOURCE\'s controller', () => {
    const board = boardWith(ASCENSION);
    const state = board.state;
    clearTurnFacts(state);
    const holds = () =>
      interveningIfHolds(state, { kind: 'didNotLoseLifeThisTurn' }, board.id, 'A');

    expect(holds(), 'a quiet turn: the condition holds').toBe(true);
    // The opponent taking damage must NOT close A's window — "you" is the
    // source's controller, never the active player or whoever the event was about.
    recordTurnFacts(state, { type: 'lifeChanged', player: 'B', delta: -5, to: 15 });
    expect(holds(), "the opponent's loss is not yours").toBe(true);
    recordTurnFacts(state, { type: 'lifeChanged', player: 'A', delta: -1, to: 19 });
    expect(holds(), 'now you have lost life, so it does not hold').toBe(false);
  });

  it('the fact clears as a turn begins, so "this turn" means this turn', () => {
    const state = freshState();
    recordTurnFacts(state, { type: 'lifeChanged', player: 'A', delta: -3, to: 17 });
    expect(turnFactHolds(state, 'youLostLife', 'A')).toBe(true);
    clearTurnFacts(state);
    expect(turnFactHolds(state, 'youLostLife', 'A'), 'a new turn is a clean slate').toBe(false);
  });
});
