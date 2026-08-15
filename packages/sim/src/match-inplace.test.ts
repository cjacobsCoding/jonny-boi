/**
 * The in-place apply optimisation must be EXACT.
 *
 * `runMatch` stopped taking core's per-action defensive clone of the whole game
 * state (both libraries, battlefield, hands, stack, continuous effects) and now
 * mutates the state it owns. That is a large speed win in the sim's hottest loop
 * and a silent correctness disaster if it is even slightly not-equivalent — every
 * win-rate and every A/B verdict in the product is built on `runMatch`.
 *
 * So: run both paths across several decks and seeds and assert the results are
 * identical field by field, including the full event log and decision trace (the
 * paths where a retained reference to a mutated state would show up first).
 */

import { describe, expect, it } from 'vitest';
import { loadCardPool, buildRegistry } from '@jonny-boi/cards';
import { createDefaultAiRegistry, HEURISTIC_PILOT_ID, RANDOM_PILOT_ID } from '@jonny-boi/ai';
import type { Pilot } from '@jonny-boi/ai';
import { loadDeck } from './deck.js';
import { makeSeats } from './matchup.js';
import { runMatch } from './match.js';
import { DEFAULT_SIM_CONFIG } from './config.js';
import { MONO_RED_AGGRO, MONO_GREEN_STOMPY, UW_CONTROL, MONO_BLACK_MIDRANGE } from '../data/decks/index.js';

const pool = loadCardPool({ onWarn: () => {} });
const registry = buildRegistry();

function pilot(id: string): Pilot {
  const p = createDefaultAiRegistry().getPilot(id);
  if (!p) throw new Error(`no pilot ${id}`);
  return p;
}

const CLONING = { ...DEFAULT_SIM_CONFIG, applyActionsInPlace: false };
const IN_PLACE = { ...DEFAULT_SIM_CONFIG, applyActionsInPlace: true };

const MATCHUPS = [
  ['Mono-Red vs UW Control', MONO_RED_AGGRO, UW_CONTROL],
  ['Mono-Green vs Mono-Black', MONO_GREEN_STOMPY, MONO_BLACK_MIDRANGE],
  ['UW Control vs Mono-Green', UW_CONTROL, MONO_GREEN_STOMPY],
] as const;

const SEEDS = [1, 4242, 0xc0ffee];

describe('applyActionInPlace is exactly equivalent to the cloning path', () => {
  for (const [label, deckA, deckB] of MATCHUPS) {
    for (const seed of SEEDS) {
      it(`${label} @ seed ${seed} produces an identical result`, () => {
        const seats = makeSeats(loadDeck(deckA, pool), loadDeck(deckB, pool), {
          pilotA: pilot(HEURISTIC_PILOT_ID),
          pilotB: pilot(HEURISTIC_PILOT_ID),
        }, registry);

        const cloned = runMatch(seats, seed, { sim: CLONING });
        const inPlace = runMatch(seats, seed, { sim: IN_PLACE });

        expect(inPlace.outcome).toEqual(cloned.outcome);
        expect(inPlace.turns).toBe(cloned.turns);
        expect(inPlace.actions).toBe(cloned.actions);
        expect(inPlace.rejectedActions).toBe(cloned.rejectedActions);
        expect(inPlace.finalLife).toEqual(cloned.finalLife);
      });
    }
  }

  it('records a byte-identical event log and decision trace under recordTrace', () => {
    // The trace path is where an aliased state would surface: it RETAINS objects
    // produced during the game, so anything that pointed into a mutated state
    // would come back rewritten by later actions.
    const seats = makeSeats(loadDeck(MONO_RED_AGGRO, pool), loadDeck(MONO_GREEN_STOMPY, pool), {
      pilotA: pilot(HEURISTIC_PILOT_ID),
      pilotB: pilot(RANDOM_PILOT_ID),
    }, registry);

    const cloned = runMatch(seats, 99, { sim: CLONING, recordTrace: true });
    const inPlace = runMatch(seats, 99, { sim: IN_PLACE, recordTrace: true });

    expect(inPlace.events).toEqual(cloned.events);
    expect(inPlace.decisions).toEqual(cloned.decisions);
    expect((inPlace.events ?? []).length).toBeGreaterThan(0);
  });

  it('streams the same events to an observer as it records with recordTrace', () => {
    // `onEvent` is what the paired-arm runner watches to decide a game is
    // identical, so it must see EVERY event, including the setup ones emitted
    // before the first action.
    const seats = makeSeats(loadDeck(MONO_RED_AGGRO, pool), loadDeck(UW_CONTROL, pool), {
      pilotA: pilot(HEURISTIC_PILOT_ID),
      pilotB: pilot(HEURISTIC_PILOT_ID),
    }, registry);

    const streamed: unknown[] = [];
    const recorded = runMatch(seats, 7, { recordTrace: true });
    runMatch(seats, 7, { onEvent: (e) => streamed.push(e) });

    expect(streamed).toEqual(recorded.events);
  });
});
