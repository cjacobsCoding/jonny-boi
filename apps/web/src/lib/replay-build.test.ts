/**
 * Trace-content tests: a replay frame carries enough to actually SEE the game.
 *
 * Counts alone ("Hand 7") cannot answer whether the engine and the pilots are
 * doing the right thing — seven lands in hand and seven spells in hand look
 * identical. These assert the frames carry the zone contents and the unspent
 * mana pool, against a real traced game rather than a fixture.
 */

import { describe, expect, it } from 'vitest';
import { createDefaultAiRegistry, DEFAULT_PILOT_ID } from '@jonny-boi/ai';
import { buildRegistry, loadCardPool } from '@jonny-boi/cards';
import { SAMPLE_DECKS, loadDeck } from '@jonny-boi/sim';
import { buildMatchTrace } from './replay-build.js';
import type { MatchTrace } from './replay-types.js';

/** Cap high enough to play a full game, low enough to stay fast. */
const TRACE_EVENT_CAP = 4000;

/** One traced Mono-Red vs UW Control game, shared by the assertions below. */
function trace(): MatchTrace {
  const pool = loadCardPool({ onWarn: () => {} });
  const pilot = createDefaultAiRegistry().getPilot(DEFAULT_PILOT_ID)!;
  return buildMatchTrace(
    {
      deckA: loadDeck(SAMPLE_DECKS[0]!, pool),
      deckB: loadDeck(SAMPLE_DECKS[2]!, pool),
      pilotA: pilot,
      pilotB: pilot,
      registry: buildRegistry(),
      seatNames: {
        A: { player: 'A', deckName: 'A', pilot: DEFAULT_PILOT_ID },
        B: { player: 'B', deckName: 'B', pilot: DEFAULT_PILOT_ID },
      },
    },
    5,
    TRACE_EVENT_CAP,
  );
}

describe('buildMatchTrace — visible zones', () => {
  const built = trace();
  const opening = built.frames[0]!;

  it('carries the opening hand as real, nameable cards', () => {
    expect(opening.sides.A.hand).toHaveLength(opening.sides.A.handCount);
    expect(opening.sides.A.handCount).toBeGreaterThan(0);
    // Every id resolves through the trace's name map — no "#42" placeholders.
    for (const id of opening.sides.A.hand) {
      expect(built.names[id], `instance ${id} has no name`).toBeTruthy();
    }
  });

  it('carries the whole library, top card first, and names every card in it', () => {
    const { library, libraryCount } = opening.sides.A;
    expect(library).toHaveLength(libraryCount);
    expect(libraryCount).toBeGreaterThan(0);
    for (const id of library) {
      expect(built.names[id], `library instance ${id} has no name`).toBeTruthy();
    }

    // The engine draws from index 0, so the first entry is what the next draw
    // takes — the ordering the viewer labels "top".
    const firstDrawn = library[0]!;
    const afterDraw = built.frames.find(
      (frame) => !frame.sides.A.library.includes(firstDrawn),
    );
    expect(afterDraw, 'the top card is never drawn — ordering is wrong').toBeDefined();
  });

  it('reports unspent mana in the pool, omitting zeroes', () => {
    const floating = built.frames.find(
      (frame) => Object.keys(frame.sides.A.manaPool).length > 0,
    );
    expect(floating, 'no frame ever shows mana in the pool').toBeDefined();
    for (const [symbol, amount] of Object.entries(floating!.sides.A.manaPool)) {
      expect(amount, `${symbol} is in the pool with a zero amount`).toBeGreaterThan(0);
    }
  });

  it('keeps zone contents in step with their counts on every frame', () => {
    for (const frame of built.frames) {
      for (const player of ['A', 'B'] as const) {
        const side = frame.sides[player];
        expect(side.hand).toHaveLength(side.handCount);
        expect(side.library).toHaveLength(side.libraryCount);
        expect(side.graveyard).toHaveLength(side.graveyardCount);
      }
    }
  });
});
