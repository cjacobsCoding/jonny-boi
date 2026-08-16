/**
 * Mana PAYMENT PLANNING — the contract of `planManaPayment`.
 *
 * It is the hottest function in the engine (the hybrid search plans a payment for
 * every castable card at every node) and it is public API three seats depend on:
 * both AI pilots, the hotseat UI's auto-tap, and the online client. It had no
 * direct test of its own, which is exactly the wrong shape for a function people
 * will keep optimising — so this file pins BEHAVIOUR (what it answers) and the
 * INVARIANTS an optimisation is most likely to break:
 *
 *   - the two documented tie-breaks (least flexible source, then smallest producer)
 *   - a source's modes being alternatives, so one tap spends the whole permanent
 *   - grouping by permanent even when the offered activations are NOT contiguous
 *   - independence between calls, because the implementation keeps its working set
 *     in reused module-level buffers; a plan handed back must never be disturbed by
 *     a later call, and a big board must not leak into the next small one
 */

import { describe, expect, it } from 'vitest';
import { planManaPayment, distanceToPayable, type ManaPlanView } from './mana-plan.js';
import type { GameAction } from './actions.js';
import type { CardDefinition } from './card.js';
import type { ManaCost, ManaPool } from './mana.js';
import { emptyPool } from './mana.js';
import type { CardInstance, InstanceId, PlayerId } from './state.js';

const FOREST: CardDefinition = { id: 'Forest', name: 'Forest', types: ['land'], produces: ['G'] };
const ISLAND: CardDefinition = { id: 'Island', name: 'Island', types: ['land'], produces: ['U'] };
/** A modal source: five alternatives, exactly one chosen per activation. */
const ANY_COLOR_BIRD: CardDefinition = {
  id: 'AnyColorBird',
  name: 'Any-Color Bird',
  types: ['creature'],
  power: 0,
  toughness: 1,
  producesOptions: [{ W: 1 }, { U: 1 }, { B: 1 }, { R: 1 }, { G: 1 }],
};
/** A fixed bundle: one activation is worth two colorless. */
const TWO_COLORLESS_ROCK: CardDefinition = {
  id: 'TwoColorlessRock',
  name: 'Two-Colorless Rock',
  types: ['artifact'],
  produces: ['C', 'C'],
};

function permanent(instanceId: InstanceId, def: CardDefinition, controller: PlayerId = 'A'): CardInstance {
  return {
    instanceId,
    def,
    controller,
    owner: controller,
    zone: 'battlefield',
    tapped: false,
    summoningSick: false,
    damageMarked: 0,
    markedByDeathtouch: false,
    attachedTo: null,
    counters: {},
  };
}

/** A view of a board plus the floating pool of the seat doing the planning. */
function board(battlefield: readonly CardInstance[], pool: Partial<ManaPool> = {}): ManaPlanView {
  const filled: ManaPool = { ...emptyPool(), ...pool };
  return {
    battlefield,
    players: { A: { manaPool: filled }, B: { manaPool: emptyPool() } },
  };
}

/** Every activation the engine would offer for `perms`, in engine order. */
function offeredTaps(perms: readonly CardInstance[], player: PlayerId = 'A'): GameAction[] {
  const actions: GameAction[] = [];
  for (const perm of perms) {
    const modes = perm.def.producesOptions ?? (perm.def.produces ? [null] : []);
    for (let mode = 0; mode < modes.length; mode++) {
      actions.push({ kind: 'tapForMana', player, instanceId: perm.instanceId, mode });
    }
  }
  return actions;
}

const taps = (plan: ReturnType<typeof planManaPayment>) =>
  plan?.map((t) => `${t.instanceId}:${t.mode}`) ?? plan;

describe('planManaPayment — the trivial answers', () => {
  it('plans nothing when the floating pool already covers the cost', () => {
    const forest = permanent(1, FOREST);
    const view = board([forest], { G: 1 });
    expect(planManaPayment(view, 'A', { G: 1 }, offeredTaps([forest]))).toEqual([]);
  });

  it('is unpayable when no activation is offered at all', () => {
    const forest = permanent(1, FOREST);
    expect(planManaPayment(board([forest]), 'A', { G: 1 }, [])).toBeUndefined();
  });

  it('is unpayable when the offered sources cannot make the colour', () => {
    const island = permanent(1, ISLAND);
    expect(planManaPayment(board([island]), 'A', { G: 1 }, offeredTaps([island]))).toBeUndefined();
  });

  it('ignores activations offered to the other seat', () => {
    const theirs = permanent(1, FOREST, 'B');
    const view = board([theirs]);
    expect(planManaPayment(view, 'A', { G: 1 }, offeredTaps([theirs], 'B'))).toBeUndefined();
  });

  it('ignores an activation whose permanent is not on the battlefield', () => {
    const ghost: GameAction = { kind: 'tapForMana', player: 'A', instanceId: 99, mode: 0 };
    expect(planManaPayment(board([]), 'A', { G: 1 }, [ghost])).toBeUndefined();
  });
});

describe('planManaPayment — which source it spends', () => {
  it('taps exactly as many sources as the cost needs and no more', () => {
    const lands = [permanent(1, FOREST), permanent(2, FOREST), permanent(3, FOREST)];
    const plan = planManaPayment(board(lands), 'A', { G: 2 }, offeredTaps(lands));
    expect(taps(plan)).toEqual(['1:0', '2:0']);
  });

  it('spends the least flexible source first — the Forest, not the any-colour Bird', () => {
    const bird = permanent(1, ANY_COLOR_BIRD);
    const forest = permanent(2, FOREST);
    const perms = [bird, forest];
    const plan = planManaPayment(board(perms), 'A', { G: 1 }, offeredTaps(perms));
    expect(taps(plan)).toEqual(['2:0']);
  });

  it('prefers the smaller producer when flexibility ties — no cracking a 2-mana rock for one pip', () => {
    const rock = permanent(1, TWO_COLORLESS_ROCK);
    const island = permanent(2, ISLAND);
    const perms = [rock, island];
    const plan = planManaPayment(board(perms), 'A', { generic: 1 }, offeredTaps(perms));
    expect(taps(plan)).toEqual(['2:0']);
  });

  it('takes the bigger producer when it actually closes more of the shortfall', () => {
    const rock = permanent(1, TWO_COLORLESS_ROCK);
    const island = permanent(2, ISLAND);
    const perms = [rock, island];
    const plan = planManaPayment(board(perms), 'A', { generic: 2 }, offeredTaps(perms));
    expect(taps(plan)).toEqual(['1:0']);
  });

  it('picks the mode that pays, and spends the whole permanent when it does', () => {
    const bird = permanent(1, ANY_COLOR_BIRD);
    const plan = planManaPayment(board([bird]), 'A', { B: 1 }, offeredTaps([bird]));
    expect(taps(plan)).toEqual(['1:2']); // producesOptions[2] is {B:1}
  });

  it('never taps one permanent twice, even when it has several modes', () => {
    const bird = permanent(1, ANY_COLOR_BIRD);
    // Two coloured pips but only one source: its modes are alternatives, not a menu
    // to be spent twice, so the cost is unpayable rather than "tap the Bird twice".
    expect(planManaPayment(board([bird]), 'A', { B: 1, R: 1 }, offeredTaps([bird]))).toBeUndefined();
  });

  it('combines the floating pool with a tap instead of re-funding what is already paid', () => {
    const forest = permanent(1, FOREST);
    const island = permanent(2, ISLAND);
    const perms = [forest, island];
    const plan = planManaPayment(board(perms, { G: 1 }), 'A', { G: 1, U: 1 }, offeredTaps(perms));
    expect(taps(plan)).toEqual(['2:0']);
  });

  it('groups a permanent whose offered modes are NOT contiguous in the action list', () => {
    // The engine emits a source's modes together, but the planner takes ANY legal
    // action list (the online client filters its own), so grouping must not depend
    // on ordering: interleaving the Bird's modes with another source must not make
    // it look like five separate one-colour sources and beat the Forest's tie-break.
    const bird = permanent(1, ANY_COLOR_BIRD);
    const forest = permanent(2, FOREST);
    const interleaved: GameAction[] = [];
    const birdTaps = offeredTaps([bird]);
    interleaved.push(birdTaps[0] as GameAction, birdTaps[1] as GameAction);
    interleaved.push(...offeredTaps([forest]));
    interleaved.push(birdTaps[2] as GameAction, birdTaps[3] as GameAction, birdTaps[4] as GameAction);
    const plan = planManaPayment(board([bird, forest]), 'A', { G: 1 }, interleaved);
    expect(taps(plan)).toEqual(['2:0']);
  });
});

describe('planManaPayment — one call never leaks into the next', () => {
  /**
   * The implementation keeps its working set in reused module-level buffers. These
   * pin the two ways that could go wrong: a returned plan aliasing a buffer, and a
   * previous (larger) call leaving values behind.
   */
  it('hands back plans that survive later calls unchanged', () => {
    const forest = permanent(1, FOREST);
    const island = permanent(2, ISLAND);
    const first = planManaPayment(board([forest]), 'A', { G: 1 }, offeredTaps([forest]));
    const snapshot = JSON.parse(JSON.stringify(first)) as unknown;
    // A completely different, larger board plans in between.
    const crowd = Array.from({ length: 24 }, (_, i) => permanent(i + 10, i % 2 ? ISLAND : FOREST));
    planManaPayment(board(crowd), 'A', { G: 3, U: 3 }, offeredTaps(crowd));
    planManaPayment(board([island]), 'A', { U: 1 }, offeredTaps([island]));
    expect(first).toEqual(snapshot);
  });

  it('gives a small board the same answer whether or not a big one planned first', () => {
    const forest = permanent(1, FOREST);
    const small = () => planManaPayment(board([forest]), 'A', { G: 1 }, offeredTaps([forest]));
    const alone = taps(small());
    const crowd = Array.from({ length: 40 }, (_, i) => permanent(i + 10, i % 2 ? ISLAND : FOREST));
    expect(taps(planManaPayment(board(crowd), 'A', { G: 5, U: 5 }, offeredTaps(crowd)))).toHaveLength(10);
    expect(taps(small())).toEqual(alone);
  });

  it('handles more offered activations than its buffers start out sized for', () => {
    // Deliberately past the initial capacity: a board of modal sources offers five
    // activations each, so the production buffer has to grow mid-call.
    const birds = Array.from({ length: 12 }, (_, i) => permanent(i + 1, ANY_COLOR_BIRD));
    const plan = planManaPayment(board(birds), 'A', { W: 2, U: 2, B: 2, R: 2, G: 2 }, offeredTaps(birds));
    expect(plan).toHaveLength(10);
    expect(new Set(plan?.map((t) => t.instanceId)).size).toBe(10); // ten DIFFERENT birds
  });
});

describe('distanceToPayable', () => {
  it('counts the pips still unfunded, colour by colour', () => {
    expect(distanceToPayable(emptyPool(), { G: 2 })).toBe(2);
    expect(distanceToPayable({ ...emptyPool(), G: 1 }, { G: 2 })).toBe(1);
    expect(distanceToPayable({ ...emptyPool(), G: 2 }, { G: 2 })).toBe(0);
  });

  it('lets spare coloured mana pay generic, but never the other way round', () => {
    expect(distanceToPayable({ ...emptyPool(), G: 3 }, { generic: 2 })).toBe(0);
    expect(distanceToPayable({ ...emptyPool(), G: 1 }, { generic: 2 })).toBe(1);
    expect(distanceToPayable({ ...emptyPool(), C: 2 }, { G: 1 } as ManaCost)).toBe(1);
  });
});
