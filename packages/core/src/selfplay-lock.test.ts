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
 *
 * ⚠️ REGENERATED DELIBERATELY on `fix/max-hand-size-and-sba`, and the SHAPE of
 * the move is the evidence. Every seed keeps its winner, its turn count, its
 * action count, its EVENT COUNT and its final-state hash; only the event-log
 * hash differs. The engine plays the identical game — one field inside one
 * event changed.
 *
 * That field is the CR 514.1 discard question's `sourceInstanceId`. It used to
 * name the first card in the discarding player's HAND; it now names no object
 * at all (`NO_ASKING_OBJECT`), because `choiceAsked` carries that field
 * unredacted into every pilot's observation feed and was therefore publishing
 * the identity of a hidden card. Regenerating this table with the old value
 * restores the previous hashes exactly, which is how the attribution was
 * checked rather than assumed.
 *
 * That the event COUNTS did not move is the second measurement in here: the new
 * CR 704.3 state-based-action check at the priority boundary fires nothing at
 * all across 24 full games, which is exactly what a backstop should do.
 */
const GOLDEN: readonly string[] = [
  '1|A|over|33|902|1863|b4dffd10|339507b6',
  '2|A|over|27|756|1617|7738464c|f495342b',
  '3|B|over|38|1140|2418|dac8c29b|db7cc0fc',
  '4|B|over|26|719|1537|62540ed1|0c8192ff',
  '5|A|over|21|561|1147|0c878a59|901c6e23',
  '6|B|over|24|642|1342|bd451eb9|c5a35b05',
  '7|A|over|27|778|1644|245db919|e24a6688',
  '8|A|over|23|650|1367|c196981b|c0deaba8',
  '9|A|over|19|512|1075|8870571b|84b06ae3',
  '10|A|over|43|1243|2643|8d68c95b|2a0ff2fa',
  '11|B|over|32|892|1894|56fd13f9|32049998',
  '12|B|over|30|849|1797|013fa061|40a3b377',
  '13|B|over|26|696|1405|89b3dbad|b13f0c8e',
  '14|B|over|32|874|1843|af67c4bd|0b625e1b',
  '15|B|over|24|654|1379|1225492c|8c7fae94',
  '16|B|over|20|541|1122|7d458e36|9e5bcab3',
  '17|B|over|34|907|1887|2717487a|b84fbe72',
  '18|A|over|23|620|1273|6d0c1957|2c427f5b',
  '19|A|over|23|631|1352|5c46d713|95a7910a',
  '20|B|over|26|714|1469|2e601e8c|38d75fea',
  '21|B|over|30|826|1738|504d87b2|04950240',
  '22|A|over|37|1065|2254|8e9e941a|581c1745',
  '23|B|over|24|678|1413|5e3ca4f4|eb8fb2fd',
  '24|A|over|27|753|1598|23944d00|d8f48334',
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
