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
 *
 * ⚠️ REGENERATED AGAIN on `fix/reports-2026-09-01` for CR 508.8 (§3.119): a turn
 * in which no attackers were declared now SKIPS the declare-blockers and
 * combat-damage steps, so every game has fewer priority windows — fewer passes,
 * fewer `stepBegin` events — and each pilot’s seeded decisions land on a
 * different stream from that turn onward. This time EVERY column moves, winners
 * included, and that is the honest shape of a RULES change rather than a
 * refactor: the engine now plays a different, correct game. Bug report
 * 20260901_205742 is the case it fixes — a defender asked to declare blocks
 * against nothing at all.
 *
 * ⚠️ REGENERATED AGAIN for §3.143 GAP-12 — the combat-damage ROUND marker. The
 * SHAPE of this move is the evidence that it is not a rules change: every seed
 * keeps its winner, its over/cut, its turn count, its action count, its EVENT
 * COUNT and its final-state hash, and ONLY the event-log hash moves. That is the
 * signature of one field added inside existing events and nothing else — here,
 * `round: 'firstStrike' | 'normal'` on `damageDealt`/`damagePrevented` (CR
 * 510.4), stamped by `dealCombatDamageStep` so the play surface can show two
 * combat-damage steps as two rounds instead of one blur. No decision, no
 * ordering and no quantity changed; the log simply says one more true thing.
 */
const GOLDEN: readonly string[] = [
  '1|B|over|32|740|1594|7c9711d1|4ed4228a',
  '2|A|over|25|606|1302|e76ae7ca|3d0d7df0',
  '3|A|over|23|559|1244|b7f8bb72|ce5d9822',
  '4|B|over|24|612|1333|b46d0145|d1ad51df',
  '5|A|over|31|760|1635|fed8bf91|a03232e9',
  '6|B|over|26|618|1330|23f528ad|a03aae7c',
  '7|B|over|24|628|1379|d8994cd8|a4052d1d',
  '8|A|over|27|680|1505|1300bedd|746eb034',
  '9|A|over|21|510|1093|3a8355eb|0a185605',
  '10|A|over|29|704|1533|4dcb4849|d07b73d5',
  '11|B|over|36|881|1947|33217a8f|11cee777',
  '12|B|over|26|643|1431|31486666|b0945532',
  '13|B|over|26|629|1347|d7686a82|680a9b75',
  '14|B|over|28|679|1463|85f071af|335edffe',
  '15|B|over|34|864|1910|7c0a31b8|5ef6b887',
  '16|A|over|29|711|1579|55c2474e|1b144d0b',
  '17|B|over|32|764|1662|08934da7|319dce48',
  '18|A|over|31|773|1684|cae9644d|7709a894',
  '19|B|over|36|922|2040|105a3f0b|45c545ae',
  '20|A|over|29|709|1531|0cb92266|cd4fe67a',
  '21|A|over|27|679|1447|e406ca23|b6c0d04a',
  '22|B|over|24|589|1303|1ae36de2|beee33fd',
  '23|B|over|34|848|1898|c8c527d7|7a0cf66c',
  '24|B|over|34|850|1873|aa4a1146|68e94f6d',
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
