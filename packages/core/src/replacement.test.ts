/**
 * REPLACEMENT AND PREVENTION EFFECTS at the core level — the four rules that
 * fail SILENTLY if they are wrong, each pinned by a test that goes red on the
 * specific mistake rather than on "something changed".
 *
 *  1. **CR 614.5 — an effect applies at most once to a given event.** The
 *     classic bug is a doubling effect matching its own output and looping
 *     forever, or (the quieter half) applying twice and reporting a plausible
 *     but wrong number. Two doublers on one event must give ×4, not ∞ and not
 *     ×2.
 *  2. **CR 616.1 — the affected player's ORDER, and that it is a real choice.**
 *     Hardened Scales + Corpsejack Menace is 4 counters one way and 3 the other,
 *     so a layer that picks arbitrarily is measurably wrong for the player whose
 *     creature it is. This engine settles it deterministically FOR that player;
 *     the test asserts the answer AND that it is stable across runs.
 *  3. **Prevention shields are consumed and cannot resurrect.** A 3-point shield
 *     hit twice must prevent 3 in total, not 6 — including when both hits come
 *     out of ONE damage step sharing ONE index, which is the arrangement that
 *     makes a stale-index bug invisible.
 *  4. **The layer is INERT with nothing to do.** A board with no replacement
 *     effect must hand back the shared frozen empty index BY REFERENCE, and a
 *     game that never makes a floating effect must carry no `replacements`
 *     field at all — the same empty-check discipline `hasCardGrants` and
 *     `isLegalTarget`'s `state.continuous.length === 0` fast path use, on the
 *     two hottest paths in the engine.
 *
 * Plus the field-by-field CLONE trap, which has bitten several branches: a new
 * state field that `internal/clone.ts` does not copy is silently dropped at the
 * very next action boundary. Here that would un-spend a shield and delete a fog.
 */

import { describe, expect, it } from 'vitest';
import {
  NO_REPLACEMENTS,
  PLUS_ONE_COUNTER,
  addFloatingReplacement,
  affectedPlayerPrefersMore,
  cloneState,
  createGame,
  expireFloatingReplacements,
  hasAnyReplacement,
  indexReplacements,
  replaceCounters,
  replaceDamage,
  replaceDraw,
  replacementIsInert,
  type CardDefinition,
  type CardInstance,
  type GameEvent,
  type GameState,
  type InstanceId,
  type PlayerId,
  type ReplacementAbility,
} from './index.js';
import { deckOf, landDef } from './test-fixtures.js';

const ISLAND = landDef('Island', 'U');

/** A bare 2/2 body to hang a printed replacement ability on. */
function permanentWith(id: string, replacements: readonly ReplacementAbility[]): CardDefinition {
  return { id, name: id, types: ['enchantment'], cost: { generic: 2 }, replacements };
}

/** "If one or more +1/+1 counters would be put on a creature you control, …" */
function counterReplacement(outcome: ReplacementAbility['outcome']): ReplacementAbility {
  return {
    event: 'counters',
    applies: {
      recipientController: 'you',
      recipientFilter: { anyOfTypes: ['creature'] },
      counterKind: PLUS_ONE_COUNTER,
    },
    outcome,
  };
}

/** "If a source you control would deal damage …, it deals `times` that much instead." */
function damageMultiplier(times: number): ReplacementAbility {
  return { event: 'damage', applies: { sourceController: 'you' }, outcome: { times } };
}

const BEAR: CardDefinition = {
  id: 'test-bear',
  name: 'Test Bear',
  types: ['creature'],
  power: 2,
  toughness: 2,
  cost: { generic: 2 },
};

function freshGame(): GameState {
  return createGame({ seed: 7, decks: { A: deckOf(ISLAND, 40), B: deckOf(ISLAND, 40) } }).state;
}

function place(state: GameState, def: CardDefinition, controller: PlayerId): CardInstance {
  const inst: CardInstance = {
    instanceId: state.nextInstanceId++,
    def,
    controller,
    owner: controller,
    zone: 'battlefield',
    tapped: false,
    summoningSick: false,
    damageMarked: 0,
    markedByDeathtouch: false,
    counters: {},
    attachedTo: null,
  };
  state.battlefield.push(inst);
  return inst;
}

/** Collect events instead of dropping them, so the log can be asserted on. */
function collector(): { emit: (e: GameEvent) => void; events: GameEvent[] } {
  const events: GameEvent[] = [];
  return { emit: (e) => void events.push(e), events };
}

describe('CR 614.5 — one effect applies at most once per event', () => {
  it('two damage doublers give x4, and the loop terminates', () => {
    const state = freshGame();
    place(state, permanentWith('doubler-1', [damageMultiplier(2)]), 'A');
    place(state, permanentWith('doubler-2', [damageMultiplier(2)]), 'A');
    const source = place(state, BEAR, 'A');
    const log = collector();
    const result = replaceDamage(
      state,
      indexReplacements(state),
      source,
      'A',
      undefined,
      'B',
      3,
      false,
      log.emit,
    );
    expect(result.amount).toBe(12);
    // Exactly two applications: a doubler that re-applied to its own output
    // would show three or more (and, unbounded, would never return at all).
    expect(log.events.filter((e) => e.type === 'replacementApplied')).toHaveLength(2);
  });

  it('a single doubler does NOT re-double its own output', () => {
    const state = freshGame();
    place(state, permanentWith('doubler', [damageMultiplier(2)]), 'A');
    const source = place(state, BEAR, 'A');
    const log = collector();
    const result = replaceDamage(
      state,
      indexReplacements(state),
      source,
      'A',
      undefined,
      'B',
      5,
      false,
      log.emit,
    );
    expect(result.amount).toBe(10);
    expect(log.events.filter((e) => e.type === 'replacementApplied')).toHaveLength(1);
  });

  it('a counter multiplier applies once even though it matches its own output', () => {
    const state = freshGame();
    place(state, permanentWith('season', [counterReplacement({ times: 2 })]), 'A');
    const creature = place(state, BEAR, 'A');
    const log = collector();
    expect(
      replaceCounters(state, indexReplacements(state), undefined, creature, PLUS_ONE_COUNTER, 1, log.emit),
    ).toBe(2);
  });
});

describe('CR 616.1 — the affected player chooses the order', () => {
  /**
   * Hardened Scales (+1) and Corpsejack Menace (x2) on ONE counter event. The
   * two legal orders give different, printed-correct answers:
   *   +1 then x2 → (1 + 1) x 2 = 4
   *   x2 then +1 →  1 x 2  + 1 = 3
   * The controller of the creature wants 4, and gets 4.
   */
  it('takes the order that is best for the permanent’s controller (+1 before x2 = 4)', () => {
    const state = freshGame();
    place(state, permanentWith('scales', [counterReplacement({ plus: 1 })]), 'A');
    place(state, permanentWith('corpsejack', [counterReplacement({ times: 2 })]), 'A');
    const creature = place(state, BEAR, 'A');
    const put = replaceCounters(
      state,
      indexReplacements(state),
      undefined,
      creature,
      PLUS_ONE_COUNTER,
      1,
      () => {},
    );
    expect(put).toBe(4);
  });

  it('is INDEPENDENT of the order the two sources happen to sit on the battlefield in', () => {
    const build = (scalesFirst: boolean): number => {
      const state = freshGame();
      if (scalesFirst) {
        place(state, permanentWith('scales', [counterReplacement({ plus: 1 })]), 'A');
        place(state, permanentWith('corpsejack', [counterReplacement({ times: 2 })]), 'A');
      } else {
        place(state, permanentWith('corpsejack', [counterReplacement({ times: 2 })]), 'A');
        place(state, permanentWith('scales', [counterReplacement({ plus: 1 })]), 'A');
      }
      const creature = place(state, BEAR, 'A');
      return replaceCounters(
        state,
        indexReplacements(state),
        undefined,
        creature,
        PLUS_ONE_COUNTER,
        1,
        () => {},
      );
    };
    expect(build(true)).toBe(4);
    expect(build(false)).toBe(4);
  });

  it('reverses the preference for DAMAGE — the affected player wants the smallest total', () => {
    // A shield of 3 and a doubler, both live, on 4 incoming damage:
    //   shield then double → (4 - 3) x 2 = 2      ← what the victim wants
    //   double then shield → (4 x 2) - 3 = 5
    const state = freshGame();
    place(state, permanentWith('doubler', [damageMultiplier(2)]), 'A');
    const source = place(state, BEAR, 'A');
    addFloatingReplacement(state, {
      event: 'damage',
      applies: { recipientController: 'you', recipientKind: 'player' },
      outcome: { preventUpTo: 3 },
      sourceInstanceId: source.instanceId,
      controller: 'B',
      duration: 'endOfTurn',
    });
    const result = replaceDamage(
      state,
      indexReplacements(state),
      source,
      'A',
      undefined,
      'B',
      4,
      false,
      () => {},
    );
    expect(result.amount).toBe(2);
  });

  it('states its objective in one named place', () => {
    expect(affectedPlayerPrefersMore('damage')).toBe(false);
    expect(affectedPlayerPrefersMore('counters', PLUS_ONE_COUNTER)).toBe(true);
    expect(affectedPlayerPrefersMore('counters', '-1/-1')).toBe(false);
  });
});

describe('prevention shields are consumed, and cannot resurrect', () => {
  function shieldedGame(amount: number): { state: GameState; source: CardInstance } {
    const state = freshGame();
    const source = place(state, BEAR, 'B');
    addFloatingReplacement(state, {
      event: 'damage',
      applies: { recipientController: 'you', recipientKind: 'player' },
      outcome: { preventUpTo: amount },
      sourceInstanceId: source.instanceId,
      controller: 'A',
      duration: 'endOfTurn',
    });
    return { state, source };
  }

  it('a 3-point shield hit for 2 twice prevents 2 then 1, and is then GONE', () => {
    const { state, source } = shieldedGame(3);
    const index = indexReplacements(state);
    const first = replaceDamage(state, index, source, 'B', undefined, 'A', 2, false, () => {});
    expect(first).toEqual({ amount: 0, prevented: 2 });
    // The SAME index, deliberately: this is the arrangement a combat damage step
    // produces, and a shield read from a stale index is exactly how one
    // resurrects.
    const second = replaceDamage(state, index, source, 'B', undefined, 'A', 2, false, () => {});
    expect(second).toEqual({ amount: 1, prevented: 1 });
    const third = replaceDamage(state, index, source, 'B', undefined, 'A', 2, false, () => {});
    expect(third).toEqual({ amount: 2, prevented: 0 });
    // Spent shields are removed, not zeroed: nothing is left for a later effect
    // to read or top up.
    expect(state.replacements ?? []).toHaveLength(0);
  });

  it('a spent shield does not come back after a state clone', () => {
    const { state, source } = shieldedGame(3);
    replaceDamage(state, indexReplacements(state), source, 'B', undefined, 'A', 3, false, () => {});
    const cloned = cloneState(state);
    const after = replaceDamage(
      cloned,
      indexReplacements(cloned),
      source,
      'B',
      undefined,
      'A',
      4,
      false,
      () => {},
    );
    expect(after).toEqual({ amount: 4, prevented: 0 });
  });

  it('a PARTLY spent shield keeps exactly its remaining ceiling across a clone', () => {
    const { state, source } = shieldedGame(5);
    replaceDamage(state, indexReplacements(state), source, 'B', undefined, 'A', 2, false, () => {});
    const cloned = cloneState(state);
    // The clone must carry `remaining: 3`, not the printed 5 and not nothing.
    expect(cloned.replacements?.[0]?.remaining).toBe(3);
    const after = replaceDamage(
      cloned,
      indexReplacements(cloned),
      source,
      'B',
      undefined,
      'A',
      4,
      false,
      () => {},
    );
    expect(after).toEqual({ amount: 1, prevented: 3 });
    // …and the ORIGINAL is untouched by what the clone spent.
    expect(state.replacements?.[0]?.remaining).toBe(3);
  });

  it('a fog with no ceiling prevents every hit until it expires', () => {
    const state = freshGame();
    const source = place(state, BEAR, 'B');
    addFloatingReplacement(state, {
      event: 'damage',
      applies: { combat: true },
      outcome: { preventAll: true },
      sourceInstanceId: source.instanceId,
      controller: 'A',
      duration: 'endOfTurn',
    });
    const index = indexReplacements(state);
    for (let i = 0; i < 3; i++) {
      expect(replaceDamage(state, index, source, 'B', undefined, 'A', 5, true, () => {}).amount).toBe(0);
    }
    // …and it does NOT touch noncombat damage, which is the printed word.
    expect(replaceDamage(state, index, source, 'B', undefined, 'A', 5, false, () => {}).amount).toBe(5);

    const log = collector();
    expireFloatingReplacements(state, 'endOfTurn', log.emit);
    expect(log.events.map((e) => e.type)).toEqual(['replacementExpired']);
    expect(indexReplacements(state)).toBe(NO_REPLACEMENTS);
  });
});

describe('the layer is inert when nothing replaces anything', () => {
  it('hands back the shared frozen empty index BY REFERENCE on an ordinary board', () => {
    const state = freshGame();
    place(state, BEAR, 'A');
    place(state, BEAR, 'B');
    place(state, ISLAND, 'A');
    expect(indexReplacements(state)).toBe(NO_REPLACEMENTS);
    expect(hasAnyReplacement(state)).toBe(false);
    // The optional field is ABSENT, not an empty array — the same discipline
    // `cardGrants` and `pendingChoice` follow.
    expect(state.replacements).toBeUndefined();
  });

  it('short-circuits every façade with no allocation and no events', () => {
    const state = freshGame();
    const source = place(state, BEAR, 'A');
    const creature = place(state, BEAR, 'B');
    const log = collector();
    expect(replaceDamage(state, NO_REPLACEMENTS, source, 'A', undefined, 'B', 7, true, log.emit)).toEqual({
      amount: 7,
      prevented: 0,
    });
    expect(replaceCounters(state, NO_REPLACEMENTS, source, creature, PLUS_ONE_COUNTER, 2, log.emit)).toBe(2);
    expect(replaceDraw(state, NO_REPLACEMENTS, 'A', true, log.emit)).toEqual({ count: 1, winsGame: false });
    expect(log.events).toHaveLength(0);
  });

  it('treats an ability that neither scales, adds nor prevents as inert', () => {
    expect(replacementIsInert({ event: 'damage', applies: {}, outcome: {} })).toBe(true);
    expect(replacementIsInert({ event: 'damage', applies: {}, outcome: { times: 1 } })).toBe(true);
    expect(replacementIsInert({ event: 'damage', applies: {}, outcome: { plus: 0 } })).toBe(true);
    expect(replacementIsInert({ event: 'damage', applies: {}, outcome: { plus: 2 } })).toBe(false);
    expect(replacementIsInert({ event: 'damage', applies: {}, outcome: { preventAll: true } })).toBe(false);
    // An inert declaration is not merely skipped at apply time — it never
    // reaches the index, so it cannot occupy an ordering slot either.
    const state = freshGame();
    place(state, permanentWith('inert', [{ event: 'damage', applies: {}, outcome: { times: 1 } }]), 'A');
    expect(indexReplacements(state)).toBe(NO_REPLACEMENTS);
  });
});

describe('the filter says exactly what the printed line says', () => {
  it('"a source you control" does not reach the opponent’s sources', () => {
    const state = freshGame();
    place(state, permanentWith('mine-only', [damageMultiplier(2)]), 'A');
    const mine = place(state, BEAR, 'A');
    const theirs = place(state, BEAR, 'B');
    const index = indexReplacements(state);
    expect(replaceDamage(state, index, mine, 'A', undefined, 'B', 3, true, () => {}).amount).toBe(6);
    expect(replaceDamage(state, index, theirs, 'B', undefined, 'A', 3, true, () => {}).amount).toBe(3);
  });

  it('a "+1/+1 counters" multiplier ignores a -1/-1 counter', () => {
    const state = freshGame();
    place(state, permanentWith('scales', [counterReplacement({ plus: 1 })]), 'A');
    const creature = place(state, BEAR, 'A');
    const index = indexReplacements(state);
    expect(replaceCounters(state, index, undefined, creature, PLUS_ONE_COUNTER, 1, () => {})).toBe(2);
    expect(replaceCounters(state, index, undefined, creature, '-1/-1', 1, () => {})).toBe(1);
  });

  it('"on a creature you control" does not reach the opponent’s creature', () => {
    const state = freshGame();
    place(state, permanentWith('scales', [counterReplacement({ plus: 1 })]), 'A');
    const theirs = place(state, BEAR, 'B');
    expect(
      replaceCounters(state, indexReplacements(state), undefined, theirs, PLUS_ONE_COUNTER, 1, () => {}),
    ).toBe(1);
  });

  it('the printed word "other" excludes the ability’s own source', () => {
    const shield: ReplacementAbility = {
      event: 'damage',
      applies: {
        recipientController: 'you',
        recipientKind: 'permanent',
        recipientFilter: { anyOfTypes: ['creature'] },
        excludeSource: true,
      },
      outcome: { preventAll: true },
    };
    const state = freshGame();
    const guard = place(
      state,
      { id: 'vigor', name: 'Vigor', types: ['creature'], power: 6, toughness: 6, replacements: [shield] },
      'A',
    );
    const friend = place(state, BEAR, 'A');
    const attacker = place(state, BEAR, 'B');
    const index = indexReplacements(state);
    expect(replaceDamage(state, index, attacker, 'B', friend, 'A', 3, true, () => {}).amount).toBe(0);
    expect(replaceDamage(state, index, attacker, 'B', guard, 'A', 3, true, () => {}).amount).toBe(3);
  });
});

describe('draw replacement', () => {
  const LAB_MANIAC = permanentWith('lab-maniac', [
    {
      event: 'draw',
      applies: { recipientController: 'you', requiresEmptyLibrary: true },
      outcome: { winGame: true },
    },
  ]);
  const TEFERIS = permanentWith('teferis', [
    {
      event: 'draw',
      applies: { recipientController: 'you', exceptFirstDrawEachDrawStep: true },
      outcome: { times: 2 },
    },
  ]);

  it('wins the game instead of drawing from an empty library — and ONLY when it is empty', () => {
    const state = freshGame();
    place(state, LAB_MANIAC, 'A');
    expect(replaceDraw(state, indexReplacements(state), 'A', false, () => {})).toEqual({
      count: 1,
      winsGame: false,
    });
    state.players.A.library = [];
    expect(replaceDraw(state, indexReplacements(state), 'A', false, () => {})).toEqual({
      count: 0,
      winsGame: true,
    });
    // …and it is the CONTROLLER's draw, not the opponent's.
    expect(replaceDraw(state, indexReplacements(state), 'B', false, () => {}).winsGame).toBe(false);
  });

  it('skips the first draw-step draw and replaces every later one', () => {
    const state = freshGame();
    place(state, TEFERIS, 'A');
    const index = indexReplacements(state);
    expect(replaceDraw(state, index, 'A', true, () => {}).count).toBe(1);
    expect(replaceDraw(state, index, 'A', false, () => {}).count).toBe(2);
  });

  it('stacks two draw multipliers into one four-card draw (CR 614.5, once each)', () => {
    const state = freshGame();
    place(state, TEFERIS, 'A');
    place(state, permanentWith('archive', [
      {
        event: 'draw',
        applies: { recipientController: 'you', exceptFirstDrawEachDrawStep: true },
        outcome: { times: 2 },
      },
    ]), 'A');
    expect(replaceDraw(state, indexReplacements(state), 'A', false, () => {}).count).toBe(4);
  });
});

describe('the clone trap — a new state field that internal/clone.ts drops', () => {
  it('copies GameState.replacements, deeply enough that the two cannot alias', () => {
    const state = freshGame();
    const source = place(state, BEAR, 'A');
    const id: number = addFloatingReplacement(state, {
      event: 'damage',
      applies: { combat: true },
      outcome: { preventUpTo: 4 },
      sourceInstanceId: source.instanceId,
      controller: 'A',
      duration: 'endOfTurn',
      label: 'Fog',
    });
    const cloned = cloneState(state);
    expect(cloned.replacements).toHaveLength(1);
    expect(cloned.replacements?.[0]?.id).toBe(id);
    expect(cloned.replacements?.[0]?.label).toBe('Fog');
    // Not the same object: spending the clone's shield must not spend the
    // original's, which is what makes a look-ahead pilot safe.
    expect(cloned.replacements?.[0]).not.toBe(state.replacements?.[0]);
    const cloneShield = cloned.replacements?.[0] as { remaining?: number };
    cloneShield.remaining = 1;
    expect(state.replacements?.[0]?.remaining).toBe(4);
  });

  it('leaves the field ABSENT on a clone of a game that never made one', () => {
    const state = freshGame();
    expect(cloneState(state).replacements).toBeUndefined();
  });
});

describe('every damage site in the engine consults the same layer', () => {
  /**
   * The one thing a "one seam" claim has to prove: that no call site kept its
   * own arithmetic. `indexReplacements` is the only door in, so this asserts
   * the door is reachable from a state built the way each site builds one —
   * a battlefield source, a command-zone (emblem) source, and a floating
   * record — and that all three land in ONE list.
   */
  it('gathers printed, emblem and floating effects into one index', () => {
    const state = freshGame();
    place(state, permanentWith('printed', [damageMultiplier(2)]), 'A');
    const emblem: CardInstance = {
      instanceId: state.nextInstanceId++,
      def: permanentWith('emblem', [damageMultiplier(2)]),
      controller: 'A',
      owner: 'A',
      zone: 'command',
      tapped: false,
      summoningSick: false,
      damageMarked: 0,
      markedByDeathtouch: false,
      counters: {},
      attachedTo: null,
    };
    state.players.A.command.push(emblem);
    const source = place(state, BEAR, 'A');
    addFloatingReplacement(state, {
      event: 'damage',
      applies: { sourceController: 'you' },
      outcome: { times: 2 },
      sourceInstanceId: source.instanceId,
      controller: 'A',
      duration: 'endOfTurn',
    });
    expect(indexReplacements(state)).toHaveLength(3);
    expect(
      replaceDamage(state, indexReplacements(state), source, 'A', undefined, 'B', 1, true, () => {}).amount,
    ).toBe(8);
  });

  it('attributes every application to the source that did it', () => {
    const state = freshGame();
    const doubler = place(state, permanentWith('doubler', [damageMultiplier(2)]), 'A');
    const source = place(state, BEAR, 'A');
    const log = collector();
    replaceDamage(state, indexReplacements(state), source, 'A', undefined, 'B', 3, true, log.emit);
    const applied = log.events.filter(
      (e): e is Extract<GameEvent, { type: 'replacementApplied' }> => e.type === 'replacementApplied',
    );
    expect(applied).toHaveLength(1);
    expect(applied[0]?.source).toBe<InstanceId>(doubler.instanceId);
    expect(applied[0]).toMatchObject({ event: 'damage', from: 3, to: 6, prevented: 0 });
  });
});
