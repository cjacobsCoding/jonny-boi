/**
 * THE FAST PASS IS A PROMISE, AND THIS IS WHERE THE PROMISE IS CHECKED (§3.73).
 *
 * `Pilot.willPassPriority` lets a pilot say, from the state alone, that it is
 * going to pass whatever the legal menu turns out to hold — and the harness then
 * applies the pass WITHOUT BUILDING THE MENU. That is the whole saving (the
 * pilot passes 81.7% of a game's 592 decision windows) and the whole danger: a
 * gate that answers `true` in a window where the pilot would actually have cast
 * something makes it play worse, silently, in every recorded win rate.
 *
 * So the property is not "the gate looks sensible". It is: **a game played with
 * the seam is the same game, action for action, as one played without it.** That
 * is checked here by playing whole games both ways and comparing transcripts.
 *
 * ⚠️ THE COMPARISON IS THE DECISION TRACE, NOT THE OUTCOME. Two games can reach
 * the same winner down different lines, so comparing results would pass a gate
 * that changes play but not who happens to win. The action-by-action trace
 * cannot.
 */

import { describe, expect, it } from 'vitest';
import { createDefaultAiRegistry, HEURISTIC_PILOT_ID, type Pilot } from '@jonny-boi/ai';
import { buildRegistry, loadCardPool } from '@jonny-boi/cards';
import { SAMPLE_DECKS } from '../data/decks/index.js';
import { loadDeck } from './deck.js';
import { makeSeats } from './matchup.js';
import { runMatch } from './match.js';
import { DEFAULT_SIM_CONFIG } from './config.js';
import { applyAction, createGame, DEFAULT_RULES, generateLegalActions } from '@jonny-boi/core';

const pool = loadCardPool({ onWarn: () => {} });
const registry = buildRegistry();

function heuristic(): Pilot {
  const pilot = createDefaultAiRegistry().getPilot(HEURISTIC_PILOT_ID);
  if (!pilot) throw new Error('no heuristic pilot');
  return pilot;
}

/** The same pilot with the seam removed — the control arm. */
function withoutFastPass(pilot: Pilot): Pilot {
  const { willPassPriority: _dropped, ...rest } = pilot;
  return rest as Pilot;
}

/** Decks chosen to span the archetypes: a race, a grind, and a midrange board. */
const MATCHUPS: ReadonlyArray<readonly [string, string]> = [
  ['Mono-Red Aggro', 'UW Control'],
  ['Mono-Green Ramp', 'Golgari Midrange'],
  ['Orzhov Lifegain', 'Izzet Prowess'],
];

function deckByName(name: string) {
  const deck = SAMPLE_DECKS.find((entry) => entry.name === name);
  if (!deck) throw new Error(`no sample deck '${name}'`);
  return loadDeck(deck, pool);
}

describe('the fast pass never changes the game it is playing', () => {
  it('reproduces the decision trace exactly, across archetypes and both seats', () => {
    let windows = 0;
    for (const [nameA, nameB] of MATCHUPS) {
      const deckA = deckByName(nameA);
      const deckB = deckByName(nameB);
      for (let seed = 1; seed <= 12; seed++) {
        for (const startingPlayer of ['A', 'B'] as const) {
          const fast = heuristic();
          const plain = withoutFastPass(heuristic());
          // The control arm must really be without the seam, or this test is two
          // identical runs agreeing with each other.
          expect(plain.willPassPriority).toBeUndefined();
          expect(fast.willPassPriority).toBeTypeOf('function');

          const options = { sim: DEFAULT_SIM_CONFIG, startingPlayer, recordTrace: true } as const;
          const withSeam = runMatch(
            makeSeats(deckA, deckB, { pilotA: fast, pilotB: heuristic() }, registry),
            seed,
            options,
          );
          const withoutSeam = runMatch(
            makeSeats(deckA, deckB, { pilotA: plain, pilotB: withoutFastPass(heuristic()) }, registry),
            seed,
            options,
          );
          windows += withSeam.decisions?.length ?? 0;
          expect(
            JSON.stringify(withSeam.decisions),
            `${nameA} vs ${nameB}, seed ${seed}, ${startingPlayer} on the play`,
          ).toBe(JSON.stringify(withoutSeam.decisions));
          expect(JSON.stringify(withSeam.events)).toBe(JSON.stringify(withoutSeam.events));
          expect(withSeam.outcome).toEqual(withoutSeam.outcome);
        }
      }
    }
    // "Identical" over nothing is not evidence. These games have to be real ones.
    expect(windows, 'the comparison must actually have played games').toBeGreaterThan(10_000);
  }, 300_000);

  it('keeps its promise window by window, and refuses where it cannot know', () => {
    // The one-sided contract, checked directly against the pilot's real choice.
    //
    // ⚠️ "NEVER IN THE PILOT'S OWN MAIN PHASE" IS NOT ONE OF THE PROPERTIES, and
    // an earlier version of this test asserted it. That was a description of the
    // first gate's SHAPE, not of its contract: once the gate could compare the
    // cheapest playable card against an upper bound on available mana, a main
    // phase holding one five-drop and two lands became provably a pass. Pinning
    // the shape would have forbidden the improvement that doubled its hit rate.
    // What must hold is only this: where it says pass, the pilot passes.
    const pilot = heuristic();
    const deckA = deckByName('Mono-Red Aggro');
    const deckB = deckByName('UW Control');
    const seats = makeSeats(deckA, deckB, { pilotA: pilot, pilotB: pilot }, registry);
    let gateFired = 0;
    let sawStack = 0;
    let gatedOnStack = 0;
    runMatch(seats, 4242, {
      sim: DEFAULT_SIM_CONFIG,
      startingPlayer: 'A',
      recordTrace: true,
      onEvent: () => {},
    });
    // Re-play by hand so the STATE at each window can be inspected, which the
    // match result cannot give us.
    const { state } = createGame({
      seed: 4242,
      startingPlayer: 'A',
      registry,
      decks: { A: { cards: deckA.library }, B: { cards: deckB.library } },
    });
    let s = state;
    for (let i = 0; i < 2000 && !s.gameOver; i++) {
      const gate = pilot.willPassPriority?.(s, DEFAULT_RULES) ?? false;
      if (gate) gateFired += 1;
      // A non-empty stack is NOT a refusal in itself (§3.108): the gate reasons
      // about what this seat could cast INTO it exactly as it does about an
      // empty one — a counterspell has a target now, a sorcery cannot be cast at
      // all — and the promise below is what must hold there, not the old
      // gate's blanket "no". An earlier version of this test pinned that "no",
      // which was the same shape-pinning mistake the comment above describes.
      if (s.stack.length > 0) {
        sawStack += 1;
        if (gate) gatedOnStack += 1;
      }
      if (s.pendingChoice) expect(gate, 'never fast-pass a parked question').toBe(false);
      const legal = generateLegalActions(s, DEFAULT_RULES);
      if (legal.length === 0) break;
      const chosen = pilot.chooseAction({
        view: s,
        legalActions: legal,
        rng: { next: () => 0.5 } as never,
        registry,
        rulesConfig: DEFAULT_RULES,
        observer: undefined,
      });
      // And the promise itself, window by window: a `true` must be a pass.
      if (gate) expect(chosen.kind).toBe('passPriority');
      s = applyAction(s, chosen, DEFAULT_RULES, registry).state;
    }
    // The gate must actually FIRE, or 'it never lied' is a claim about nothing.
    expect(gateFired, 'the gate must fire in a real game').toBeGreaterThan(100);
    expect(sawStack, 'the replay must have seen a non-empty stack').toBeGreaterThan(0);
    // And it must have fired with something on the stack, or the reasoning that
    // handles that window was never exercised by the promise check above.
    expect(gatedOnStack, 'the gate must fire with a non-empty stack').toBeGreaterThan(0);
  }, 120_000);
});
