/**
 * THE PLAN SEAM IS A PROMISE, AND THIS IS WHERE THE PROMISE IS CHECKED (§3.108).
 *
 * `Pilot.chooseActions` lets a pilot hand the harness its decision AND the
 * actions it would take next — the rest of a spell's funding taps and the cast —
 * so the loop applies them without building a menu or asking again. Together
 * with the widened fast pass (which now judges the post-declaration combat
 * windows, a non-empty stack, and an instant that provably has nothing to do)
 * that is where the pilot's per-window cost went; and it is the same danger as
 * §3.73's: a continuation that differs from what the pilot would really have
 * chosen, or a gate that lies, changes the game silently.
 *
 * So the property is the one `fast-pass.test.ts` states: **a game played with
 * both seams is the same game, action for action, as one played with neither.**
 * Checked for BOTH pilots that carry the seams — the heuristic, and the
 * `lookahead` pilot that ships by default and delegates them.
 *
 * ⚠️ THE COMPARISON IS THE DECISION TRACE, NOT THE OUTCOME — two games can
 * reach one winner down different lines.
 */

import { describe, expect, it } from 'vitest';
import {
  createDefaultAiRegistry,
  HEURISTIC_PILOT_ID,
  LOOKAHEAD_PILOT_ID,
  type Pilot,
} from '@jonny-boi/ai';
import { buildRegistry, loadCardPool } from '@jonny-boi/cards';
import { SAMPLE_DECKS } from '../data/decks/index.js';
import { loadDeck } from './deck.js';
import { makeSeats } from './matchup.js';
import { runMatch } from './match.js';
import { DEFAULT_SIM_CONFIG } from './config.js';

const pool = loadCardPool({ onWarn: () => {} });
const registry = buildRegistry();

function pilotById(id: string): Pilot {
  const pilot = createDefaultAiRegistry().getPilot(id);
  if (!pilot) throw new Error(`no pilot '${id}'`);
  return pilot;
}

/** The same pilot with BOTH seams removed — the control arm. */
function withoutSeams(pilot: Pilot): Pilot {
  const { willPassPriority: _gate, chooseActions: _plan, ...rest } = pilot;
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

describe.each([HEURISTIC_PILOT_ID, LOOKAHEAD_PILOT_ID])(
  'the plan seam and the widened fast pass never change the game %s is playing',
  (pilotId) => {
    it('reproduces the decision trace exactly, across archetypes and both seats', () => {
      let windows = 0;
      let plannedWindows = 0;
      for (const [nameA, nameB] of MATCHUPS) {
        const deckA = deckByName(nameA);
        const deckB = deckByName(nameB);
        for (let seed = 1; seed <= 12; seed++) {
          for (const startingPlayer of ['A', 'B'] as const) {
            const seamed = pilotById(pilotId);
            const plain = withoutSeams(pilotById(pilotId));
            // The control arm must really be without the seams, or this test is
            // two identical runs agreeing with each other.
            expect(plain.willPassPriority).toBeUndefined();
            expect(plain.chooseActions).toBeUndefined();
            expect(seamed.willPassPriority).toBeTypeOf('function');
            expect(seamed.chooseActions).toBeTypeOf('function');

            const options = { sim: DEFAULT_SIM_CONFIG, startingPlayer, recordTrace: true } as const;
            const withSeams = runMatch(
              makeSeats(deckA, deckB, { pilotA: seamed, pilotB: pilotById(pilotId) }, registry),
              seed,
              options,
            );
            const withoutSeam = runMatch(
              makeSeats(deckA, deckB, { pilotA: plain, pilotB: withoutSeams(pilotById(pilotId)) }, registry),
              seed,
              options,
            );
            windows += withSeams.decisions?.length ?? 0;
            // A tap followed by another action of the same seat is the shape a
            // continuation covers; counting them keeps "identical" from being a
            // claim about games in which the seam never fired.
            const trace = withSeams.decisions ?? [];
            for (let i = 1; i < trace.length; i++) {
              if (trace[i - 1]!.action.kind === 'tapForMana' && trace[i]!.player === trace[i - 1]!.player) {
                plannedWindows++;
              }
            }
            expect(
              JSON.stringify(withSeams.decisions),
              `${nameA} vs ${nameB}, seed ${seed}, ${startingPlayer} on the play`,
            ).toBe(JSON.stringify(withoutSeam.decisions));
            expect(JSON.stringify(withSeams.events)).toBe(JSON.stringify(withoutSeam.events));
            expect(withSeams.outcome).toEqual(withoutSeam.outcome);
          }
        }
      }
      // "Identical" over nothing is not evidence. These games have to be real
      // ones, and the plan seam has to have had something to promise.
      expect(windows, 'the comparison must actually have played games').toBeGreaterThan(10_000);
      expect(plannedWindows, 'the plan seam must actually have fired').toBeGreaterThan(1_000);
    }, 600_000);
  },
);
