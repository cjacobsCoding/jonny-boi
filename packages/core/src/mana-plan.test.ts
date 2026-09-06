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
import {
  planManaPayment,
  manaPaymentChoiceExists,
  distanceToPayable,
  type ManaPlanView,
} from './mana-plan.js';
import {
  MANA_SOURCE_PREFERENCE_DEFAULT,
  SPARE_USEFUL_MANA_SOURCES,
  SPARE_USEFUL_MANA_SOURCES_FIRST,
} from './mana-source-preference.js';
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
/**
 * THE REPORTED CASE. A mana creature that makes exactly what a Forest makes:
 * same colour, same size, same (single) mode, so every pre-§3.60 tie-break term
 * ties with a Forest and the ranking fell through to enumeration order.
 */
const LLANOWAR_ELVES: CardDefinition = {
  id: 'LlanowarElves',
  name: 'Llanowar Elves',
  types: ['creature'],
  power: 1,
  toughness: 1,
  produces: ['G'],
};
/** A land that also prints a `{T}` ability — tapping it for mana spends that too. */
const TAP_ABILITY_LAND: CardDefinition = {
  id: 'TapAbilityLand',
  name: 'Tap-Ability Land',
  types: ['land'],
  produces: ['G'],
  activated: [{ cost: { tap: true }, effects: [], label: '{T}: Do a thing.' }],
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

describe('planManaPayment — sparing the useful source (§3.60)', () => {
  /**
   * The user report, verbatim: "it should be choosing the least useful mana
   * cards — like basic lands for example. Right now it's like auto choosing
   * mana-elfs when it could have chosen basic lands."
   *
   * The Elves is offered FIRST here on purpose. That is the shape that made the
   * bug reachable: every other term ties, so whichever the engine happened to
   * enumerate first won. A fix that only worked when the land came first would
   * be no fix at all.
   */
  it('taps the Forest, not the Llanowar Elves, for {G}', () => {
    const elves = permanent(1, LLANOWAR_ELVES);
    const forest = permanent(2, FOREST);
    const perms = [elves, forest];
    const plan = planManaPayment(
      board(perms),
      'A',
      { G: 1 },
      offeredTaps(perms),
      undefined,
      'cast',
      SPARE_USEFUL_MANA_SOURCES,
    );
    expect(taps(plan)).toEqual(['2:0']);
  });

  it('still taps the Forest when the Forest is the one offered first', () => {
    const forest = permanent(1, FOREST);
    const elves = permanent(2, LLANOWAR_ELVES);
    const perms = [forest, elves];
    const plan = planManaPayment(
      board(perms),
      'A',
      { G: 1 },
      offeredTaps(perms),
      undefined,
      'cast',
      SPARE_USEFUL_MANA_SOURCES,
    );
    expect(taps(plan)).toEqual(['1:0']);
  });

  it('spends the Elves once the lands run out rather than refusing to cast', () => {
    // Sparing a source is a PREFERENCE, never a refusal: two green pips with one
    // Forest and one Elves must still be payable, and must spend both.
    const elves = permanent(1, LLANOWAR_ELVES);
    const forest = permanent(2, FOREST);
    const perms = [elves, forest];
    const plan = planManaPayment(
      board(perms),
      'A',
      { G: 2 },
      offeredTaps(perms),
      undefined,
      'cast',
      SPARE_USEFUL_MANA_SOURCES,
    );
    expect(taps(plan)).toEqual(['2:0', '1:0']); // Forest first, then the Elves
  });

  it('prefers the plain land over one whose {T} ability it would also spend', () => {
    const utility = permanent(1, TAP_ABILITY_LAND);
    const forest = permanent(2, FOREST);
    const perms = [utility, forest];
    const plan = planManaPayment(
      board(perms),
      'A',
      { G: 1 },
      offeredTaps(perms),
      undefined,
      'cast',
      SPARE_USEFUL_MANA_SOURCES,
    );
    expect(taps(plan)).toEqual(['2:0']);
  });

  it('gives up the {T} ability before it gives up a creature body', () => {
    // Both cost the controller something; the body is the dearer loss, so the
    // utility land goes first. This is the ORDER the collateral weights encode.
    const elves = permanent(1, LLANOWAR_ELVES);
    const utility = permanent(2, TAP_ABILITY_LAND);
    const perms = [elves, utility];
    const plan = planManaPayment(
      board(perms),
      'A',
      { G: 1 },
      offeredTaps(perms),
      undefined,
      'cast',
      SPARE_USEFUL_MANA_SOURCES,
    );
    expect(taps(plan)).toEqual(['2:0']);
  });

  it('never lets sparing a body outrank keeping the least flexible source', () => {
    // The conservative placement: an any-colour BIRD is a creature (collateral)
    // and a Forest is not, but the Bird is also the flexible source the old
    // ladder already spared — and flexibility still wins, so this placement can
    // only ever decide ties the old ladder decided by enumeration order.
    const bird = permanent(1, ANY_COLOR_BIRD);
    const forest = permanent(2, FOREST);
    const perms = [bird, forest];
    const plan = planManaPayment(
      board(perms),
      'A',
      { G: 1 },
      offeredTaps(perms),
      undefined,
      'cast',
      SPARE_USEFUL_MANA_SOURCES,
    );
    expect(taps(plan)).toEqual(['2:0']);
  });

  it('promotes the term above flexibility on the aboveFlexibility policy', () => {
    // The measurement arm: with the collateral term promoted, a creature that
    // could have made five colours is spared in favour of the plain Island that
    // is worth nothing to keep — the opposite call to the default ladder's, and
    // the reason the placement is a measurable question rather than an argued one.
    const bird = permanent(1, ANY_COLOR_BIRD);
    const island = permanent(2, ISLAND);
    const perms = [bird, island];
    const cost: ManaCost = { U: 1 };
    expect(
      taps(planManaPayment(board(perms), 'A', cost, offeredTaps(perms), undefined, 'cast', SPARE_USEFUL_MANA_SOURCES)),
    ).toEqual(['2:0']);
    expect(
      taps(
        planManaPayment(
          board(perms),
          'A',
          cost,
          offeredTaps(perms),
          undefined,
          'cast',
          SPARE_USEFUL_MANA_SOURCES_FIRST,
        ),
      ),
    ).toEqual(['2:0']);
    // Where the two placements genuinely differ: the Bird is BOTH the flexible
    // source and the creature, so put the flexibility on the expendable side —
    // a two-colour land against a mono-colour mana creature.
    const dual: CardDefinition = { id: 'Dual', name: 'Dual', types: ['land'], producesOptions: [{ G: 1 }, { U: 1 }] };
    const duals = [permanent(3, dual), permanent(4, LLANOWAR_ELVES)];
    expect(
      taps(planManaPayment(board(duals), 'A', { G: 1 }, offeredTaps(duals), undefined, 'cast', SPARE_USEFUL_MANA_SOURCES)),
    ).toEqual(['4:0']); // flexibility first: spend the mono-colour Elves, keep the dual
    expect(
      taps(
        planManaPayment(
          board(duals),
          'A',
          { G: 1 },
          offeredTaps(duals),
          undefined,
          'cast',
          SPARE_USEFUL_MANA_SOURCES_FIRST,
        ),
      ),
    ).toEqual(['3:0']); // collateral first: spend the dual, keep the body
  });

  /**
   * ⚠️ THE BYTE-IDENTITY CONTRACT. The planner is shared with both AI pilots and
   * the sim's recorded seeded baselines. The DEFAULT policy must therefore keep
   * the pre-§3.60 answer exactly, including the enumeration-order tie the report
   * complains about — the preference is what fixes that, not the default.
   */
  it('leaves the default policy answering exactly as it did before', () => {
    const elves = permanent(1, LLANOWAR_ELVES);
    const forest = permanent(2, FOREST);
    const perms = [elves, forest];
    const offered = offeredTaps(perms);
    expect(taps(planManaPayment(board(perms), 'A', { G: 1 }, offered))).toEqual(['1:0']);
    expect(
      taps(planManaPayment(board(perms), 'A', { G: 1 }, offered, undefined, 'cast', MANA_SOURCE_PREFERENCE_DEFAULT)),
    ).toEqual(['1:0']);
  });
});

describe('manaPaymentChoiceExists — only ask when the choice is real (§3.60)', () => {
  it('says yes when a Forest and a Llanowar Elves could each pay', () => {
    const elves = permanent(1, LLANOWAR_ELVES);
    const forest = permanent(2, FOREST);
    const perms = [elves, forest];
    expect(manaPaymentChoiceExists(board(perms), 'A', { G: 1 }, offeredTaps(perms))).toBe(true);
  });

  it('still says yes when a SECOND Forest could stand in for the first (§3.127)', () => {
    // The blind spot the mana-choice harness found: with two Forests and an
    // Elves paying {G}, excluding the planned Forest re-planned onto the OTHER
    // Forest — same multiset, "no choice" — and the elf was never considered.
    // A Forest and an elf is a decision however many Forests there are.
    const perms = [permanent(1, FOREST), permanent(2, FOREST), permanent(3, LLANOWAR_ELVES)];
    expect(manaPaymentChoiceExists(board(perms), 'A', { G: 1 }, offeredTaps(perms))).toBe(true);
  });

  it('keeps finding the one-card swap for a larger cost (the instance pass)', () => {
    // {1}{G} with two Forests and an Elves: {Forest, Forest} vs {Forest, Elves}.
    // Excluding ALL Forests leaves the cost unpayable, so this alternative is
    // only visible to the pass that excludes a single instance — both passes
    // are load-bearing, which is why there are two.
    const perms = [permanent(1, FOREST), permanent(2, FOREST), permanent(3, LLANOWAR_ELVES)];
    expect(manaPaymentChoiceExists(board(perms), 'A', { G: 1, generic: 1 }, offeredTaps(perms))).toBe(true);
  });

  it('still says NO for three identical Forests — duplicates of a duplicate are not a choice', () => {
    const perms = [permanent(1, FOREST), permanent(2, FOREST), permanent(3, FOREST)];
    expect(manaPaymentChoiceExists(board(perms), 'A', { G: 1 }, offeredTaps(perms))).toBe(false);
  });

  it('says NO when two identical Forests could pay — that is not a decision', () => {
    // The nag guard. Losing a Forest is losing a Forest; which physical card it
    // was is not something to interrupt a player for.
    const perms = [permanent(1, FOREST), permanent(2, FOREST)];
    expect(manaPaymentChoiceExists(board(perms), 'A', { G: 1 }, offeredTaps(perms))).toBe(false);
  });

  it('says NO when every source is needed', () => {
    const perms = [permanent(1, FOREST), permanent(2, ISLAND)];
    expect(manaPaymentChoiceExists(board(perms), 'A', { G: 1, U: 1 }, offeredTaps(perms))).toBe(false);
  });

  it('says NO when there is only one source at all', () => {
    const perms = [permanent(1, FOREST)];
    expect(manaPaymentChoiceExists(board(perms), 'A', { G: 1 }, offeredTaps(perms))).toBe(false);
  });

  it('says NO when the floating pool already pays and nothing would be tapped', () => {
    const perms = [permanent(1, FOREST), permanent(2, LLANOWAR_ELVES)];
    expect(manaPaymentChoiceExists(board(perms, { G: 1 }), 'A', { G: 1 }, offeredTaps(perms))).toBe(false);
  });

  it('says NO when the cost cannot be paid at all', () => {
    const perms = [permanent(1, ISLAND)];
    expect(manaPaymentChoiceExists(board(perms), 'A', { G: 1 }, offeredTaps(perms))).toBe(false);
  });

  it('sees a choice hidden behind interchangeable sources', () => {
    // Two Forests and an Elves paying {G}{G}: the auto plan spends both Forests,
    // but "a Forest and the Elves" is a genuinely different thing to give up.
    // Excluding one Forest is what surfaces it — excluding ALL Forests would
    // wrongly report "no choice" here.
    const perms = [permanent(1, FOREST), permanent(2, FOREST), permanent(3, LLANOWAR_ELVES)];
    expect(manaPaymentChoiceExists(board(perms), 'A', { G: 2 }, offeredTaps(perms))).toBe(true);
  });

  it('sees a choice between one big source and two small ones', () => {
    const perms = [permanent(1, TWO_COLORLESS_ROCK), permanent(2, FOREST), permanent(3, ISLAND)];
    expect(manaPaymentChoiceExists(board(perms), 'A', { generic: 2 }, offeredTaps(perms))).toBe(true);
  });

  it('ignores the other seat’s sources entirely', () => {
    const mine = permanent(1, FOREST);
    const theirs = permanent(2, FOREST, 'B');
    const view = board([mine, theirs]);
    const offered = [...offeredTaps([mine]), ...offeredTaps([theirs], 'B')];
    expect(manaPaymentChoiceExists(view, 'A', { G: 1 }, offered)).toBe(false);
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
