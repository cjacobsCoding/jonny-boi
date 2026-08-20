/**
 * THE FAST SOAK TIER — runs in the ordinary suite, every time.
 *
 * `soak.ts` explains what a soak is and why this repo needs one. This file is
 * the tier that always runs: a few dozen seeded games over randomised full-pool
 * decks, every invariant checked on every settled state, and a hard requirement
 * that every mechanic the pool prints actually FIRES.
 *
 * It is deliberately load-bearing rather than decorative — the whole point of the
 * exercise is that "the suite is green" stopped meaning "the assembled game
 * works" once twelve systems shipped in three days and were only ever tested one
 * at a time. If this file can be deleted without anybody noticing, it has failed.
 *
 * The DEEP tier (thousands of games) lives in `soak-deep.test.ts` behind
 * `JB_SOAK_GAMES`; see TESTING.md.
 */

import { describe, expect, it } from 'vitest';
import { buildRegistry, loadCardPool } from '@jonny-boi/cards';
import { createDefaultAiRegistry, DEFAULT_PILOT_ID } from '@jonny-boi/ai';
import type { GameEvent } from '@jonny-boi/core';
import { loadDeck, validateDeck } from './deck.js';
import { makeSeats } from './matchup.js';
import {
  SOAK_BASE_SEED,
  SOAK_EVENT_WITNESS,
  SOAK_FAST_MIXED_GAMES,
  SOAK_MAX_TIMEOUT_RATE,
  SOAK_MECHANIC_SEED_ATTEMPTS,
  SOAK_MECHANICS,
  type SoakMechanicId,
} from './soak-config.js';
import {
  buildAnchoredDeck,
  buildMixedDeck,
  indexPoolForSoak,
  SOAK_DECK_SIZE,
} from './soak-decks.js';
import { compareApplyPaths, formatSoakReport, formatViolations, runSoak, soakSimConfig } from './soak.js';

const pool = loadCardPool({ onWarn: () => {} });
const registry = buildRegistry();
const pilot = createDefaultAiRegistry().getPilot(DEFAULT_PILOT_ID)!;
const index = indexPoolForSoak(pool.cards);

/**
 * THE RUN. One `runSoak` shared by every assertion below — playing it once and
 * asserting many things about it is the difference between a fast tier that runs
 * always and one somebody switches off.
 */
const report = runSoak({
  pool,
  registry,
  pilot,
  mixedGames: SOAK_FAST_MIXED_GAMES,
  anchorAttempts: SOAK_MECHANIC_SEED_ATTEMPTS,
  baseSeed: SOAK_BASE_SEED,
});

describe('the deck generator produces legal, reproducible, mixed decks', () => {
  it('every generated deck loads through the SAME loader the gauntlet uses', () => {
    const problems: string[] = [];
    for (let seed = 1; seed <= 40; seed++) {
      const deck = buildMixedDeck(index, seed);
      const reasons = validateDeck(deck, pool);
      if (reasons.length > 0) problems.push(`seed ${seed}: ${reasons.join('; ')}`);
      const size = deck.cards.reduce((sum, e) => sum + e.count, 0);
      if (size !== SOAK_DECK_SIZE) problems.push(`seed ${seed}: ${size} cards, expected ${SOAK_DECK_SIZE}`);
    }
    expect(problems).toEqual([]);
  });

  it('is a pure function of its seed — the same seed rebuilds the same sixty cards', () => {
    // Without this, "here is the seed that reproduces it" is a lie, and every
    // failure message this harness prints is worthless.
    for (const seed of [7, 4242, 0xc0ffee]) {
      expect(JSON.stringify(buildMixedDeck(index, seed))).toBe(JSON.stringify(buildMixedDeck(index, seed)));
    }
  });

  it('an anchored deck really contains the mechanic it is anchored on', () => {
    const problems: string[] = [];
    for (const mechanic of SOAK_MECHANICS) {
      const printed = index.byMechanic.get(mechanic.id) ?? [];
      if (printed.length === 0) continue; // the pool has none — pool-mechanics.test.ts owns that
      const deck = buildAnchoredDeck(index, mechanic.id, 1234);
      if (!deck) {
        problems.push(`${mechanic.id}: the pool prints ${printed.length} card(s) but no deck could be anchored on it`);
        continue;
      }
      const names = new Set(printed.map((c) => c.id));
      if (!deck.cards.some((e) => names.has(e.cardId))) {
        problems.push(`${mechanic.id}: the anchored deck contains none of its ${printed.length} cards`);
      }
      const reasons = validateDeck(deck, pool);
      if (reasons.length > 0) problems.push(`${mechanic.id}: illegal deck — ${reasons.join('; ')}`);
    }
    expect(problems).toEqual([]);
  });

  it('generated decks genuinely MIX systems rather than repeating one', () => {
    // A "mixed" generator that produced forty copies of the same archetype would
    // pass every other test here and soak nothing. Count how many distinct
    // mechanics the union of a batch of decks prints.
    const seen = new Set<SoakMechanicId>();
    for (let seed = 1; seed <= 24; seed++) {
      const deck = buildMixedDeck(index, seed);
      const ids = new Set(deck.cards.map((e) => e.cardId));
      for (const mechanic of SOAK_MECHANICS) {
        if ((index.byMechanic.get(mechanic.id) ?? []).some((c) => ids.has(c.id))) seen.add(mechanic.id);
      }
    }
    expect(seen.size, `only ${seen.size} mechanics appear across 24 mixed decks`).toBeGreaterThanOrEqual(12);
  });
});

describe('the mechanic inventory is a closed, checkable manifest', () => {
  it('every event type the engine can emit is classified', () => {
    // A companion to the mapped type in `soak-config.ts`: the TYPE makes a new
    // event break the build, and this makes a *stale* entry (an event type that
    // vanished) visible too.
    const classified = Object.keys(SOAK_EVENT_WITNESS) as GameEvent['type'][];
    expect(classified.length).toBeGreaterThan(50);
    for (const key of classified) {
      const value = SOAK_EVENT_WITNESS[key];
      if (value !== null) {
        expect(SOAK_MECHANICS.map((m) => m.id), `${key} names an unknown mechanic`).toContain(value);
      }
    }
  });

  it('every mechanic in the inventory is witnessable — by an event, an action or a state', () => {
    // A mechanic nobody can witness would sit in the inventory for ever reading
    // like a guarantee and asserting nothing.
    const byEvent = new Set(Object.values(SOAK_EVENT_WITNESS).filter((v): v is SoakMechanicId => v !== null));
    const missing = SOAK_MECHANICS.filter(
      (m) => m.witnessKind === 'event' && !byEvent.has(m.id) && !WITNESSED_BY_CHOICE_SOURCE.has(m.id),
    );
    expect(missing.map((m) => m.id)).toEqual([]);
  });
});

/**
 * Mechanics whose witness is an event PLUS the identity of the card that asked —
 * X, kicker and buyback all park a question, and scry and surveil are the same
 * printed look with different destinations, so the event type alone cannot name
 * them (see `soak.ts`'s `choiceAsked` handling).
 */
const WITNESSED_BY_CHOICE_SOURCE: ReadonlySet<SoakMechanicId> = new Set([
  'x-cost',
  'kicker',
  'buyback',
  'scry',
  'surveil',
  'optional-payment',
  'graveyard-recursion',
]);

describe('the fast soak', () => {
  it('breaks no invariant across the whole run', () => {
    expect(report.violations.length, `\n${formatViolations(report.violations)}\n`).toBe(0);
  });

  it('never plays a game that cannot END', () => {
    // The recorded failure shape: a combat-declaration bug once made games
    // unable to finish while every test in the repo passed, because every test
    // asserted "it finished" via a cap that the bug simply hit.
    expect(report.actionCapHits, `\n${formatSoakReport(report)}\n`).toBe(0);
  });

  it('finishes most games on the board rather than on the turn cap', () => {
    const rate = report.timeouts / Math.max(report.games, 1);
    expect(rate, `${report.timeouts}/${report.games} games stalled to the turn cap`).toBeLessThan(
      SOAK_MAX_TIMEOUT_RATE,
    );
  });

  it('fires EVERY mechanic the pool prints — an inert feature is not shipped', () => {
    expect(report.inertMechanics, `\n${formatSoakReport(report)}\n`).toEqual([]);
  });

  it('plays enough games, over enough turns, to mean something', () => {
    // Guards the guard: a soak whose deck generator silently started producing
    // unplayable piles would report zero violations and zero of everything else.
    expect(report.games).toBeGreaterThanOrEqual(SOAK_FAST_MIXED_GAMES);
    expect(report.turns / report.games, 'games are ending before anything happens').toBeGreaterThan(3);
    expect(report.actions).toBeGreaterThan(report.games * 20);
  });
});

describe('applyActionInPlace stays exact on SOAK decks', () => {
  // `match-inplace.test.ts` pins this for four curated decks and three seeds.
  // Those decks predate transform, modal casting, madness, card grants and
  // emblems — all of which mutate state in shapes that did not exist then. An
  // in-place path that aliased one of them would silently rewrite every
  // win-rate and every A/B verdict in the product.
  const sim = soakSimConfig();
  for (const seed of [11, 2027, 0xbadc0de]) {
    it(`is bit-identical on a mixed matchup @ seed ${seed}`, () => {
      const deckA = buildMixedDeck(index, seed);
      const deckB = buildMixedDeck(index, seed ^ 0x27d4eb2f);
      const seats = makeSeats(loadDeck(deckA, pool), loadDeck(deckB, pool), { pilotA: pilot, pilotB: pilot }, registry);
      expect(compareApplyPaths(seats, seed, sim, 'A')).toBeUndefined();
    });
  }
});
