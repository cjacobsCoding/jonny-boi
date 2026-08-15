/**
 * Behaviour lock: the engine's exact output for a set of seeded self-play games.
 *
 * This is the acceptance test for PERFORMANCE work. An optimization is only an
 * optimization if the engine still plays the identical game: same winner, same
 * turn count, same action count, same number of events, the same event log byte
 * for byte, and the same serialized final board. Counting outcomes is not enough
 * — two engines can agree that "A won on turn 27" while disagreeing about every
 * decision in between — so the whole log and the whole final state are hashed.
 *
 * If this fails after a refactor, the refactor changed the RULES. That is a bug,
 * not a faster engine. The table is regenerated only when a rules change is
 * deliberate: `npx tsx packages/core/bench/selfplay-digests.ts`.
 */

import { describe, expect, it } from 'vitest';
import {
  playSelfPlayGame,
  selfPlayDecks,
  selfPlayLockLine,
  SELF_PLAY_LOCK_SEEDS,
} from './test-fixtures.js';
import { applyAction, applyActionInPlace, createGame, generateLegalActions } from './engine.js';
import { cloneState } from './internal/clone.js';
import { resetInstanceForNewZone } from './internal/zones.js';
import { serializeState } from './serialize.js';
import { createRng } from './rng.js';
import type { GameAction } from './actions.js';
import type { GameState } from './state.js';

/**
 * seed | winner | over/cut | turns | actions | events | eventLogHash | finalStateHash
 */
const GOLDEN: readonly string[] = [
  '1|A|over|27|721|1522|5873a621|3f91f184',
  '2|B|over|22|592|1209|55519a3a|c8c8968d',
  '3|B|over|26|736|1532|c4cadb62|fb2764b5',
  '4|B|over|22|595|1278|d9aec3dc|f2a8f7d4',
  '5|A|over|29|781|1602|7757ff9c|bc35057e',
  '6|B|over|20|532|1093|aa179243|3ebe2f30',
  '7|A|over|25|703|1468|017657ea|315bce07',
  '8|A|over|27|776|1648|5d3b1fe4|cb1eb3b1',
  '9|A|over|15|404|848|fcc1b5f8|b0386eb2',
  '10|B|over|40|1150|2439|32ed3510|771811a2',
  '11|A|over|29|813|1737|41f45450|e775e845',
  '12|A|over|29|815|1724|f3cc4d04|20f8ac3e',
  '13|B|over|24|629|1281|fc06a8d6|607ba56e',
  '14|A|over|33|894|1867|f048a618|fed9f738',
  '15|A|over|37|1050|2235|76a03a17|aac3a513',
  '16|B|over|32|901|1908|27fd0796|d11c67ea',
  '17|B|over|36|968|1994|7e8f4888|c69e14fe',
  '18|A|over|27|752|1547|80d3dca3|51421a4d',
  '19|A|over|23|636|1358|32038a9e|8db96ab1',
  '20|A|over|27|746|1545|74482552|a6261580',
  '21|A|over|25|659|1371|2774a54e|b0d53bea',
  '22|A|over|31|864|1808|935b4b07|7713f1e9',
  '23|B|over|24|678|1427|89452967|13032bce',
  '24|A|over|25|697|1478|5355c256|c119841d',
];

describe('self-play behaviour lock', () => {
  const decks = selfPlayDecks();

  it('reproduces the pinned game for every seed', () => {
    const actual = SELF_PLAY_LOCK_SEEDS.map((seed) => selfPlayLockLine(playSelfPlayGame(decks, seed)));
    expect(actual).toEqual(GOLDEN);
  });

  it('is reproducible run to run (no hidden state between games)', () => {
    const first = playSelfPlayGame(decks, SELF_PLAY_LOCK_SEEDS[0] as number);
    // Play other games in between: a memo or a pool that leaked across games would
    // show up here and nowhere else.
    for (const seed of SELF_PLAY_LOCK_SEEDS.slice(1, 5)) playSelfPlayGame(decks, seed);
    const again = playSelfPlayGame(decks, SELF_PLAY_LOCK_SEEDS[0] as number);
    expect(selfPlayLockLine(again)).toEqual(selfPlayLockLine(first));
  });
});

/**
 * The purity contract `applyAction` sells: the caller's state comes back
 * untouched. A clone optimization that starts SHARING structure with the input
 * would pass the digest test above (which only ever looks forward) and break this
 * one, so both are needed.
 */
describe('applyAction purity', () => {
  const decks = selfPlayDecks();

  it('never mutates the state it was handed, over a whole game', () => {
    const rng = createRng(0x5eed);
    let state: GameState = createGame({ seed: 7, decks }).state;
    for (let i = 0; i < 400 && !state.gameOver; i++) {
      const legal = generateLegalActions(state);
      if (legal.length === 0) break;
      const before = JSON.stringify(serializeState(state));
      const beforeDeep = JSON.stringify(state);
      const next = applyAction(state, legal[rng.nextInt(legal.length)] as GameAction).state;
      expect(JSON.stringify(serializeState(state))).toEqual(before);
      expect(JSON.stringify(state)).toEqual(beforeDeep);
      state = next;
    }
  });

  it('leaks no shared mutable reference into the returned state', () => {
    const rng = createRng(0x1eaf);
    let state: GameState = createGame({ seed: 11, decks }).state;
    for (let i = 0; i < 250 && !state.gameOver; i++) {
      const legal = generateLegalActions(state);
      if (legal.length === 0) break;
      const previous = state;
      state = applyAction(previous, legal[rng.nextInt(legal.length)] as GameAction).state;
      expectNoSharedInstances(previous, state);
    }
  });

  /**
   * `applyActionInPlace` is the same engine with the defensive copy removed, so a
   * cloned state driven through it must produce exactly what the pure path does.
   * This is what lets `packages/sim` switch its match loop over without changing
   * a single result.
   */
  it('agrees with applyActionInPlace on a cloned state, action for action', () => {
    const rng = createRng(0xc0de);
    let pure: GameState = createGame({ seed: 5, decks }).state;
    let inPlace: GameState = cloneState(pure);
    for (let i = 0; i < 400 && !pure.gameOver; i++) {
      const legal = generateLegalActions(pure);
      if (legal.length === 0) break;
      const action = legal[rng.nextInt(legal.length)] as GameAction;
      const pureResult = applyAction(pure, action);
      const inPlaceResult = applyActionInPlace(inPlace, action);
      expect(JSON.stringify(inPlaceResult.events)).toEqual(JSON.stringify(pureResult.events));
      expect(JSON.stringify(inPlaceResult.state)).toEqual(JSON.stringify(pureResult.state));
      pure = pureResult.state;
      inPlace = inPlaceResult.state;
    }
  });
});

/**
 * `CardInstance.counters` is shared (as one frozen empty record) whenever an
 * instance has none — which is what makes it safe to skip an allocation per
 * instance per clone. The contract that buys that is "replace, never mutate in
 * place", and these tests are what keep it honest.
 */
describe('the empty-counters contract', () => {
  const decks = selfPlayDecks();

  it('refuses an in-place write, loudly, instead of aliasing two states', () => {
    const state = createGame({ seed: 3, decks }).state;
    const card = state.players.A.hand[0] as { counters: Record<string, number> };
    expect(Object.isFrozen(card.counters)).toBe(true);
    expect(() => {
      card.counters['+1/+1'] = 1;
    }).toThrow();
  });

  it('gives an instance that DOES carry counters a private copy per clone', () => {
    const state = createGame({ seed: 4, decks }).state;
    const original = state.players.A.hand[0] as { counters: Record<string, number> };
    // The supported way to add a counter: replace the record.
    original.counters = { ...original.counters, '+1/+1': 2 };

    const copy = cloneState(state);
    const copied = copy.players.A.hand[0] as { counters: Record<string, number> };
    expect(copied.counters).toEqual({ '+1/+1': 2 });
    expect(copied.counters).not.toBe(original.counters);
    copied.counters['+1/+1'] = 99;
    expect(original.counters['+1/+1']).toBe(2);
  });

  it('clears counters back to the shared empty record when a card changes zone', () => {
    const state = createGame({ seed: 5, decks }).state;
    const card = state.players.A.hand[0] as { counters: Record<string, number> };
    card.counters = { '+1/+1': 1 };
    resetInstanceForNewZone(card as never);
    expect(card.counters).toEqual({});
    expect(Object.isFrozen(card.counters)).toBe(true);
  });
});

/** Every card instance and zone array in `next` must be a distinct object from `previous`. */
function expectNoSharedInstances(previous: GameState, next: GameState): void {
  const seen = new Set<unknown>();
  for (const inst of allInstances(previous)) seen.add(inst);
  for (const arr of allZoneArrays(previous)) seen.add(arr);
  for (const inst of allInstances(next)) {
    expect(seen.has(inst), `instance ${inst.instanceId} is shared with the previous state`).toBe(false);
  }
  for (const arr of allZoneArrays(next)) {
    expect(seen.has(arr), 'a zone array is shared with the previous state').toBe(false);
  }
}

function* allInstances(state: GameState): Generator<GameState['battlefield'][number]> {
  yield* state.battlefield;
  for (const pid of ['A', 'B'] as const) {
    const p = state.players[pid];
    yield* p.library;
    yield* p.hand;
    yield* p.graveyard;
    yield* p.exile;
    yield* p.command;
  }
  for (const obj of state.stack) if (obj.kind === 'spell') yield obj.card;
}

function* allZoneArrays(state: GameState): Generator<unknown[]> {
  yield state.battlefield;
  yield state.stack;
  yield state.continuous;
  for (const pid of ['A', 'B'] as const) {
    const p = state.players[pid];
    yield p.library;
    yield p.hand;
    yield p.graveyard;
    yield p.exile;
    yield p.command;
  }
}
