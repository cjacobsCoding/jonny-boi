/**
 * The gauntlet is CONTENT, and content rots.
 *
 * Every win-rate delta and A/B verdict this lab produces is measured against
 * `SAMPLE_DECKS`, so the gauntlet's own health is a load-bearing property: a deck
 * that wins or loses every matchup adds no information to a hero deck's score, it
 * just adds a constant. That has happened twice already — once when the decks were
 * tuned against a buggy engine (a livelock made ~60% of games bogus timeout draws,
 * which handed aggro free wins), and once when a wave of correctness fixes made
 * several cards faithful and left the meta skewed 21%–83%.
 *
 * These assertions are deliberately LOOSE. They are not a re-tune spec and they do
 * not pin any deck's number; they only catch the failure that makes the whole lab
 * meaningless. A change that trips one is not necessarily wrong — but it does mean
 * the gauntlet needs re-measuring at full sample size before it is trusted again.
 */

import { describe, expect, it } from 'vitest';
import { buildRegistry, loadCardPool } from '@jonny-boi/cards';
import { createDefaultAiRegistry, DEFAULT_PILOT_ID } from '@jonny-boi/ai';
import type { Pilot } from '@jonny-boi/ai';
import { loadDeck, type LoadedDeck } from './deck.js';
import { makeSeats, runMatchup } from './matchup.js';
import { SAMPLE_DECKS } from '../data/decks/index.js';

/**
 * Small enough to stay a unit test, large enough that a deck stuck at ~0% or
 * ~100% cannot hide. Each deck plays this many games against each of the others,
 * from seat A, so every deck is measured over `(decks - 1) * GAMES_PER_MATCHUP`.
 */
const GAMES_PER_MATCHUP = 8;
const BASE_SEED = 20260814;

/** The band a deck's overall win rate must land in to be carrying information. */
const MIN_HEALTHY_WIN_RATE = 0.15;
const MAX_HEALTHY_WIN_RATE = 0.85;
/** No single deck may be this far clear of the field — that is a solved meta. */
const MAX_SPREAD = 0.6;
/**
 * Games that hit the turn cap instead of finishing. A high rate means the numbers
 * above are measuring stalls rather than decks, which is exactly the bug the
 * livelock fix removed; it must not creep back.
 */
const MAX_TIMEOUT_DRAW_RATE = 0.15;
/** A coin flip: the line a matchup has to fall on the right side of to "count". */
const EVEN_MATCHUP = 0.5;

const pool = loadCardPool({ onWarn: () => {} });
const registry = buildRegistry();

function pilot(): Pilot {
  const p = createDefaultAiRegistry().getPilot(DEFAULT_PILOT_ID);
  if (!p) throw new Error(`no pilot ${DEFAULT_PILOT_ID}`);
  return p;
}

interface Record_ {
  readonly name: string;
  readonly games: number;
  readonly wins: number;
  readonly draws: number;
  readonly winRate: number;
  /** This deck's win rate against each other deck, in `SAMPLE_DECKS` order. */
  readonly perMatchup: readonly number[];
}

/** One round-robin: every deck as seat A against every other deck. Run once. */
function roundRobin(): { records: Record_[]; timeoutDrawRate: number } {
  const decks: LoadedDeck[] = SAMPLE_DECKS.map((d) => loadDeck(d, pool));
  const pilots = { pilotA: pilot(), pilotB: pilot() };
  const records: Record_[] = [];
  let totalGames = 0;
  let totalDraws = 0;

  for (let i = 0; i < decks.length; i++) {
    const hero = decks[i] as LoadedDeck;
    const perMatchup: number[] = [];
    let games = 0;
    let wins = 0;
    let draws = 0;
    for (let j = 0; j < decks.length; j++) {
      if (i === j) continue;
      const result = runMatchup(
        makeSeats(hero, decks[j] as LoadedDeck, pilots, registry),
        GAMES_PER_MATCHUP,
        // A seed per ordered pair, so the whole table is reproducible.
        BASE_SEED + i * decks.length + j,
      );
      games += result.games;
      wins += result.winsA;
      draws += result.draws;
      perMatchup.push(result.winsA / result.games);
    }
    totalGames += games;
    totalDraws += draws;
    records.push({ name: hero.name, games, wins, draws, winRate: wins / games, perMatchup });
  }
  return { records, timeoutDrawRate: totalDraws / totalGames };
}

/** A readable table, so a failure says WHICH deck and by how much. */
function describeTable(records: readonly Record_[]): string {
  return records
    .map((r) => `  ${r.name.padEnd(18)} ${(r.winRate * 100).toFixed(1)}%  (${r.wins}/${r.games}, ${r.draws} draws)`)
    .join('\n');
}

describe('meta gauntlet health', () => {
  const { records, timeoutDrawRate } = roundRobin();
  const table = `\n${describeTable(records)}\n`;

  it('has at least the six archetypes the roadmap promises, all legal 60s', () => {
    expect(SAMPLE_DECKS.length).toBeGreaterThanOrEqual(6);
    for (const deck of SAMPLE_DECKS) expect(loadDeck(deck, pool).size).toBe(60);
    // Distinct names — the CLI and the Lab select decks by name.
    expect(new Set(SAMPLE_DECKS.map((d) => d.name)).size).toBe(SAMPLE_DECKS.length);
  });

  it('has no degenerate deck — nothing near 0% or 100% across the field', () => {
    for (const r of records) {
      expect(r.winRate, `${r.name} is degenerate${table}`).toBeGreaterThan(MIN_HEALTHY_WIN_RATE);
      expect(r.winRate, `${r.name} is degenerate${table}`).toBeLessThan(MAX_HEALTHY_WIN_RATE);
    }
  });

  it('has no runaway best deck', () => {
    const rates = records.map((r) => r.winRate);
    const spread = Math.max(...rates) - Math.min(...rates);
    expect(spread, `the meta is solved${table}`).toBeLessThan(MAX_SPREAD);
  });

  it('finishes its games — a high timeout-draw rate would make every number junk', () => {
    expect(timeoutDrawRate, `too many unfinished games${table}`).toBeLessThan(MAX_TIMEOUT_DRAW_RATE);
  });

  it('gives every deck at least one good matchup and at least one bad one', () => {
    // A deck with no bad matchup is oppressive; one with no good matchup is filler.
    // Both make the gauntlet a worse measuring instrument than it should be.
    for (const r of records) {
      expect(Math.max(...r.perMatchup), `${r.name} beats nobody${table}`).toBeGreaterThan(EVEN_MATCHUP);
      expect(Math.min(...r.perMatchup), `${r.name} loses to nobody${table}`).toBeLessThan(EVEN_MATCHUP);
    }
  });
});
