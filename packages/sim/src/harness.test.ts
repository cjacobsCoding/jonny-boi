import { describe, expect, it } from 'vitest';
import { loadCardPool, buildRegistry } from '@jonny-boi/cards';
import { createDefaultAiRegistry, HEURISTIC_PILOT_ID, RANDOM_PILOT_ID } from '@jonny-boi/ai';
import type { Pilot } from '@jonny-boi/ai';
import { loadDeck } from './deck.js';
import { runMatch } from './match.js';
import { makeSeats, runMatchup, type MatchupPilots } from './matchup.js';
import { runGauntlet } from './gauntlet.js';
import { evaluateSwap } from './swap.js';
import { MONO_RED_AGGRO, MONO_GREEN_STOMPY, UW_CONTROL } from '../data/decks/index.js';

const pool = loadCardPool({ onWarn: () => {} });
const registry = buildRegistry();

function pilot(id: string): Pilot {
  const p = createDefaultAiRegistry().getPilot(id);
  if (!p) throw new Error(`no pilot ${id}`);
  return p;
}

function pilots(id = HEURISTIC_PILOT_ID): MatchupPilots {
  return { pilotA: pilot(id), pilotB: pilot(id) };
}

const red = loadDeck(MONO_RED_AGGRO, pool);
const green = loadDeck(MONO_GREEN_STOMPY, pool);
const control = loadDeck(UW_CONTROL, pool);

describe('runMatch', () => {
  it('plays one game to a winner or a recorded timeout (never hangs)', () => {
    const seats = makeSeats(red, green, pilots(), registry);
    const result = runMatch(seats, 12345);
    expect(['win', 'timeout']).toContain(result.outcome.kind);
    expect(result.turns).toBeGreaterThan(0);
  });

  it('is deterministic: the same seed reproduces an identical result', () => {
    const seats = makeSeats(red, control, pilots(), registry);
    for (const seed of [1, 2, 7, 99, 2024]) {
      const a = runMatch(seats, seed);
      const b = runMatch(seats, seed);
      expect(a.outcome).toEqual(b.outcome);
      expect(a.turns).toBe(b.turns);
      expect(a.actions).toBe(b.actions);
      expect(a.finalLife).toEqual(b.finalLife);
    }
  });

  it('also terminates with the random pilot across several seeds', () => {
    const seats = makeSeats(red, green, pilots(RANDOM_PILOT_ID), registry);
    for (const seed of [3, 13, 31, 131]) {
      const r = runMatch(seats, seed);
      expect(['win', 'timeout']).toContain(r.outcome.kind);
    }
  });

  it('records a trace only when asked', () => {
    const seats = makeSeats(red, green, pilots(), registry);
    const plain = runMatch(seats, 5);
    expect(plain.events).toBeUndefined();
    const traced = runMatch(seats, 5, { recordTrace: true });
    expect(traced.events && traced.events.length).toBeGreaterThan(0);
    expect(traced.decisions && traced.decisions.length).toBeGreaterThan(0);
    // Tracing must not change the outcome.
    expect(traced.outcome).toEqual(plain.outcome);
  });
});

describe('runMatchup', () => {
  it('is reproducible: same baseSeed → identical win counts', () => {
    const seats = makeSeats(red, green, pilots(), registry);
    const a = runMatchup(seats, 20, 777);
    const b = runMatchup(seats, 20, 777);
    expect(a.winsA).toBe(b.winsA);
    expect(a.winsB).toBe(b.winsB);
    expect(a.gameSeeds).toEqual(b.gameSeeds);
  });

  it('produces a Wilson CI that brackets the point estimate', () => {
    const seats = makeSeats(red, green, pilots(), registry);
    const r = runMatchup(seats, 30, 42);
    expect(r.winsA + r.winsB + r.draws).toBe(30);
    expect(r.winRateA.low).toBeLessThanOrEqual(r.winRateA.p);
    expect(r.winRateA.high).toBeGreaterThanOrEqual(r.winRateA.p);
  });
});

describe('runGauntlet', () => {
  it('runs the hero against every opponent and aggregates an overall CI', () => {
    const r = runGauntlet(red, [green, control], pilots(), 15, 9, registry);
    expect(r.matchups).toHaveLength(2);
    expect(r.totalGames).toBe(30);
    expect(r.totalWins).toBe(r.matchups[0]!.winsA + r.matchups[1]!.winsA);
  });
});

describe('evaluateSwap (the A/B test)', () => {
  it('self-swap is unbiased: ~0 delta, no discordant pairs, inconclusive', () => {
    const verdict = evaluateSwap(
      MONO_RED_AGGRO,
      { out: 'Lightning Bolt', in: 'Lightning Bolt' },
      [green, control],
      pilots(),
      40,
      55,
      pool,
      registry,
    );
    expect(verdict.delta).toBe(0);
    expect(verdict.paired.baseOnly).toBe(0);
    expect(verdict.paired.variantOnly).toBe(0);
    expect(verdict.pValue).toBe(1);
    expect(verdict.verdict).toBe('inconclusive');
  });

  it('a rigged downgrade (creature → a basic land) registers as worse-or-inconclusive, never better', () => {
    // Swapping a threat for a do-nothing land strictly weakens an aggro deck. The
    // delta must not be positive; with enough signal it reads 'worse'.
    const verdict = evaluateSwap(
      MONO_RED_AGGRO,
      { out: 'Goblin Guide', in: 'Mountain' },
      [green, control],
      pilots(),
      60,
      314,
      pool,
      registry,
    );
    expect(verdict.delta).toBeLessThanOrEqual(0);
    expect(verdict.verdict).not.toBe('better');
  });

  it('is deterministic: same seed → identical verdict', () => {
    // Swap a maxed creature for a card not already in the deck (keeps it legal).
    const args = [
      MONO_RED_AGGRO,
      { out: 'Young Pyromancer', in: 'Sol Ring' } as const,
      [green, control],
      pilots(),
      30,
      2718,
      pool,
      registry,
    ] as const;
    const a = evaluateSwap(...args);
    const b = evaluateSwap(...args);
    expect(a.delta).toBe(b.delta);
    expect(a.pValue).toBe(b.pValue);
    expect(a.verdict).toBe(b.verdict);
    expect(a.paired).toEqual(b.paired);
  });

  it('builds the variant deck with one card swapped (count math is correct)', () => {
    // Goblin Guide (4 → 3) out, Sol Ring (0 → 1) in — keeps the deck a legal 60.
    const verdict = evaluateSwap(
      MONO_RED_AGGRO,
      { out: 'Goblin Guide', in: 'Sol Ring' },
      [green],
      pilots(),
      5,
      1,
      pool,
      registry,
    );
    expect(verdict.outName).toBe('Goblin Guide');
    expect(verdict.inName).toBe('Sol Ring');
    expect(verdict.nGames).toBe(5);
  });

  it('rejects an illegal variant (swapping a card to 5-of) with a clear error', () => {
    // Lightning Bolt is already a 4-of; adding one more is illegal — the swap test
    // surfaces a DeckLoadError rather than silently running an illegal deck.
    expect(() =>
      evaluateSwap(
        MONO_RED_AGGRO,
        { out: 'Goblin Guide', in: 'Lightning Bolt' },
        [green],
        pilots(),
        5,
        1,
        pool,
        registry,
      ),
    ).toThrow(/exceeds the 4-of limit/);
  });
});
