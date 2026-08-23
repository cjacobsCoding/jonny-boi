/**
 * THE DECK-NEUTRAL PILOT A/B (DESIGN §3.46).
 *
 * The load-bearing test in this file is **the control**: the same pilot id on
 * both sides must come out EXACTLY level, with every matched slot split. That is
 * not a statistical expectation to be checked loosely — running one pilot against
 * itself makes the two orientations of a pair literally the same game, so the
 * balance is an identity. It is the property that turns a 51.2% reading into
 * evidence instead of noise, and if it ever breaks (a pilot that carries state
 * across games, a seeding slip) every number the harness prints is void.
 *
 * The other tests pin the design's symmetry (exchanging the contestants mirrors
 * the result exactly), its exposure balance (each pilot drives each deck the same
 * games), its determinism, and its POWER — heuristic vs random must come out
 * "stronger", or the harness could not detect a difference it was built to find.
 *
 * Kept deliberately small (three decks, few games): this is a correctness suite,
 * not a measurement. The measurement is `npm run sim -- pilot-ab`.
 */

import { describe, expect, it } from 'vitest';
import { loadCardPool, buildRegistry } from '@jonny-boi/cards';
import { createDefaultAiRegistry, HEURISTIC_PILOT_ID, RANDOM_PILOT_ID } from '@jonny-boi/ai';
import type { Pilot } from '@jonny-boi/ai';
import { loadDeck } from './deck.js';
import { DEFAULT_STATS_CONFIG } from './config.js';
import { MONO_RED_AGGRO, MONO_GREEN_STOMPY, SAMPLE_DECKS, UW_CONTROL } from '../data/decks/index.js';
import {
  deckPairsOf,
  DEFAULT_PILOT_AB_GAMES_PER_ORIENTATION,
  ORIENTATIONS_PER_PAIR,
  PILOT_AB_BUILD_COMPARISON_NOTE,
  runPilotAb,
  type PilotAbOptions,
} from './pilot-ab.js';

const pool = loadCardPool({ onWarn: () => {} });
const registry = buildRegistry();

function pilot(id: string): Pilot {
  const p = createDefaultAiRegistry().getPilot(id);
  if (!p) throw new Error(`no pilot ${id}`);
  return p;
}

/** A three-deck matrix: 3 pairs × 2 orientations × `games`. Small on purpose. */
const decks = [MONO_RED_AGGRO, MONO_GREEN_STOMPY, UW_CONTROL].map((d) => loadDeck(d, pool));

/**
 * Enough games that the three pairs clear `minGamesForVerdict` matched slots —
 * below that the verdict is 'inconclusive' by rule and the power test could not
 * pass however lopsided the result.
 */
const GAMES = 12;
const SEED = 4242;

function run(idA: string, idB: string, overrides: Partial<PilotAbOptions> = {}) {
  return runPilotAb({
    decks,
    pilots: { pilotA: pilot(idA), pilotB: pilot(idB) },
    registry,
    gamesPerOrientation: GAMES,
    baseSeed: SEED,
    ...overrides,
  });
}

// Played once and shared: each of these is a full matrix, and the suite is a
// correctness check, not a measurement.
const control = run(HEURISTIC_PILOT_ID, HEURISTIC_PILOT_ID);
const forward = run(HEURISTIC_PILOT_ID, RANDOM_PILOT_ID);
const reversed = run(RANDOM_PILOT_ID, HEURISTIC_PILOT_ID);

describe('deckPairsOf', () => {
  it('enumerates every unordered pair of distinct decks', () => {
    expect(deckPairsOf(4)).toEqual([
      { first: 0, second: 1 },
      { first: 0, second: 2 },
      { first: 0, second: 3 },
      { first: 1, second: 2 },
      { first: 1, second: 3 },
      { first: 2, second: 3 },
    ]);
  });

  it('is n(n-1)/2 pairs, and the bundled gauntlet is the 36 the DESIGN note cites', () => {
    for (const n of [0, 1, 2, 5, 9, 20]) expect(deckPairsOf(n)).toHaveLength((n * (n - 1)) / 2);
    expect(deckPairsOf(SAMPLE_DECKS.length)).toHaveLength(36);
  });

  it('the default run is the 7,200-game matrix the §3.45 control was measured on', () => {
    expect(
      deckPairsOf(SAMPLE_DECKS.length).length *
        ORIENTATIONS_PER_PAIR *
        DEFAULT_PILOT_AB_GAMES_PER_ORIENTATION,
    ).toBe(7200);
  });
});

describe('the control — one pilot against itself', () => {
  const result = control;

  it('comes out EXACTLY level, because both orientations are the same game', () => {
    expect(result.control).toBe(true);
    expect(result.balanced).toBe(true);
    expect(result.winsA).toBe(result.winsB);
    // Not a vacuous pass on an empty run: real games were played and decided.
    expect(result.winsA).toBeGreaterThan(0);
  });

  it('leaves every matched slot split — no slot can be decided in a control', () => {
    expect(result.slots.aheadA).toBe(0);
    expect(result.slots.aheadB).toBe(0);
    expect(result.slots.level).toBe(result.slots.total);
    expect(result.slots.total).toBe(deckPairsOf(decks.length).length * GAMES);
  });

  it('reports a dead-even share, no discordant pairs, and an inconclusive verdict', () => {
    expect(result.shareA.p).toBe(0.5);
    expect(result.mcNemar.discordant).toBe(0);
    expect(result.pValue).toBe(1);
    expect(result.verdict).toBe('inconclusive');
  });

  it('balances every DECK too, not just the total', () => {
    for (const row of result.perDeck) {
      expect(row.winsA, row.deck).toBe(row.winsB);
      expect(row.gamesDriven, row.deck).toBe(GAMES * (decks.length - 1));
    }
  });
});

describe('the design cancels deck, seat and the play', () => {
  it('exchanging the contestants mirrors the result exactly', () => {
    // Run 2's orientation one IS run 1's orientation two. Same games, opposite
    // labels — so every A-column must land in the B-column and vice versa. This
    // is the statement that no seat or ordering bias can leak into the reading.
    expect(reversed.winsA).toBe(forward.winsB);
    expect(reversed.winsB).toBe(forward.winsA);
    expect(reversed.draws).toBe(forward.draws);
    expect(reversed.slots.aheadA).toBe(forward.slots.aheadB);
    expect(reversed.slots.aheadB).toBe(forward.slots.aheadA);
    expect(reversed.slots.level).toBe(forward.slots.level);
    expect(reversed.pValue).toBeCloseTo(forward.pValue, 12);
    for (let i = 0; i < forward.perDeck.length; i++) {
      expect(reversed.perDeck[i]?.winsA).toBe(forward.perDeck[i]?.winsB);
      expect(reversed.perDeck[i]?.winsB).toBe(forward.perDeck[i]?.winsA);
    }
  });

  it('gives each pilot the same exposure to every deck, and loses no win', () => {
    const result = forward;
    const perDeck = result.perDeck;
    expect(perDeck.reduce((n, r) => n + r.winsA, 0)).toBe(result.winsA);
    expect(perDeck.reduce((n, r) => n + r.winsB, 0)).toBe(result.winsB);
    for (const row of perDeck) {
      // Neither pilot can win more games with a deck than it was handed.
      expect(row.winsA, row.deck).toBeLessThanOrEqual(row.gamesDriven);
      expect(row.winsB, row.deck).toBeLessThanOrEqual(row.gamesDriven);
    }
    // Every game is a win for somebody or a draw, and the totals close.
    expect(result.winsA + result.winsB + result.draws).toBe(result.totalGames);
    expect(result.totalGames).toBe(result.slots.total * ORIENTATIONS_PER_PAIR);
  });

  it('accounts for every matched slot', () => {
    const { slots } = forward;
    expect(slots.aheadA + slots.aheadB + slots.level).toBe(slots.total);
  });
});

describe('the reading', () => {
  it('detects a difference it was built to find: heuristic beats random', () => {
    expect(forward.control).toBe(false);
    expect(forward.shareA.p).toBeGreaterThan(0.5);
    expect(forward.slots.aheadA).toBeGreaterThan(forward.slots.aheadB);
    expect(forward.slots.total).toBeGreaterThanOrEqual(DEFAULT_STATS_CONFIG.minGamesForVerdict);
    expect(forward.verdict).toBe('stronger');
    // The direction is not an accident of the label order.
    expect(reversed.verdict).toBe('weaker');
  });

  it('is deterministic — the same seed reproduces the same verdict', () => {
    expect(run(HEURISTIC_PILOT_ID, RANDOM_PILOT_ID)).toEqual(forward);
  });

  it('is driven by the seed — the base seed reaches the games', () => {
    // Cheap runs: this asks only that the seed changes WHAT is played, so it
    // needs variety, not depth. Checked over four seeds rather than two because
    // any single pair of small samples can coincide by chance.
    const shapes = new Set(
      [SEED, SEED + 1, SEED + 2, SEED + 3].map((baseSeed) =>
        JSON.stringify(
          run(HEURISTIC_PILOT_ID, HEURISTIC_PILOT_ID, {
            baseSeed,
            gamesPerOrientation: SEED_PROBE_GAMES,
          }).perDeck.map((row) => row.winsA),
        ),
      ),
    );
    expect(shapes.size).toBeGreaterThan(1);
  });

  it('names both contestants so a report cannot be mislabelled', () => {
    expect(forward.pilotA).toBe(HEURISTIC_PILOT_ID);
    expect(forward.pilotB).toBe(RANDOM_PILOT_ID);
  });
});

/** Games per orientation for the seed-sensitivity probe — variety, not depth. */
const SEED_PROBE_GAMES = 4;

describe('the honesty note', () => {
  it('says plainly that this compares registered ids, not two builds of one id', () => {
    // Pinned because the limitation is the whole reason the tool can mislead:
    // an agent who reads this as a build comparison will draw a false conclusion.
    expect(PILOT_AB_BUILD_COMPARISON_NOTE).toMatch(/REGISTERED PILOT IDS/);
    expect(PILOT_AB_BUILD_COMPARISON_NOTE).toMatch(/registerPilot/);
    expect(PILOT_AB_BUILD_COMPARISON_NOTE).toMatch(/exactly 50% on both/);
  });
});
