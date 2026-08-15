/**
 * The paired-arm runner is where the suggestion engine's speed comes from, and it
 * buys that speed with two claims that must be EXACT, not approximately right:
 *
 *   1. **The base arm is shared.** Under common random numbers the base deck's
 *      result for a given (opponent, game) does not depend on which candidate is
 *      being tested, so it is played once for the whole run.
 *   2. **Some variant games are free.** If the base game never saw the swapped
 *      card, the variant plays the identical game, so its result IS the base's.
 *
 * If either claim is wrong, every verdict the product prints is wrong — silently.
 * So this suite pins them against the untouched reference implementation
 * (`evaluateSwap`) and against the optimisation being switched off, and keeps the
 * self-swap invariant (delta 0, no discordant pairs, p = 1) — the proof the A/B
 * machinery is unbiased — running through the NEW path as well as the old.
 */

import { describe, expect, it } from 'vitest';
import { loadCardPool, buildRegistry, CORE_PRIMITIVE_IDS } from '@jonny-boi/cards';
import { createDefaultAiRegistry, HEURISTIC_PILOT_ID, MCTS_PILOT_ID } from '@jonny-boi/ai';
import type { Pilot } from '@jonny-boi/ai';
import { loadDeck } from './deck.js';
import type { MatchupPilots } from './matchup.js';
import { evaluateSwap } from './swap.js';
import { createPairedArmRunner, pairedSlotAt, swappedInstanceIdFor, IDENTICAL_LIBRARIES } from './paired-arms.js';
import { LIBRARY_READING_PRIMITIVES, LIBRARY_SAFE_PRIMITIVES } from './paired-arms-config.js';
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

const gauntlet = [loadDeck(MONO_GREEN_STOMPY, pool), loadDeck(UW_CONTROL, pool)];
const SEED = 20260815;
const GAMES_PER_MATCHUP = 6;

function makeRunner(overrides: { readonly reuseUnseenCardGames?: boolean; readonly pilotId?: string } = {}) {
  return createPairedArmRunner(MONO_RED_AGGRO, {
    gauntletDecks: gauntlet,
    pilots: pilots(overrides.pilotId),
    pool,
    registry,
    seed: SEED,
    ...(overrides.reuseUnseenCardGames === undefined
      ? {}
      : { reuseUnseenCardGames: overrides.reuseUnseenCardGames }),
  });
}

/** A real, legal candidate on Mono-Red: cut a Young Pyromancer for a Sol Ring. */
const CANDIDATE = { out: 'Young Pyromancer', in: 'Sol Ring' } as const;

describe('slot enumeration', () => {
  it('is round-robin, so every prefix is balanced across the gauntlet', () => {
    // Three opponents: the first three slots must hit each of them exactly once.
    const opponents = 3;
    const first = [0, 1, 2].map((k) => pairedSlotAt(k, opponents));
    expect(first.map((s) => s.opponentIndex)).toEqual([0, 1, 2]);
    expect(first.every((s) => s.gameIndex === 0)).toBe(true);
    expect(pairedSlotAt(3, opponents)).toEqual({ opponentIndex: 0, gameIndex: 1 });
  });
});

describe('the shared base arm preserves the paired property exactly', () => {
  it('a full-depth arm reproduces evaluateSwap game for game', () => {
    // THE load-bearing test. The runner plays games in a different ORDER
    // (round-robin instead of opponent-major) and plays the base arm once instead
    // of per candidate — but a 2x2 tally does not care about order, and common
    // random numbers make the base result slot-determined. So the paired table,
    // delta, p-value and verdict must match the reference implementation exactly.
    const runner = makeRunner();
    const arm = runner.openArm(CANDIDATE, CANDIDATE.out, CANDIDATE.in);
    runner.advance(arm, runner.slotCapacity(GAMES_PER_MATCHUP));
    const adaptive = runner.summarize(arm);

    const reference = evaluateSwap(
      MONO_RED_AGGRO,
      CANDIDATE,
      gauntlet,
      pilots(),
      GAMES_PER_MATCHUP,
      SEED,
      pool,
      registry,
    );

    expect(adaptive.paired).toEqual(reference.paired);
    expect(adaptive.nGames).toBe(reference.nGames);
    expect(adaptive.delta).toBe(reference.delta);
    expect(adaptive.pValue).toBe(reference.pValue);
    expect(adaptive.verdict).toBe(reference.verdict);
    expect(adaptive.baseWinRate).toEqual(reference.baseWinRate);
  });

  it('plays the base gauntlet ONCE no matter how many candidates share it', () => {
    const runner = makeRunner();
    const depth = runner.slotCapacity(GAMES_PER_MATCHUP);
    for (const inCard of ['Sol Ring', 'Birds of Paradise', 'Llanowar Elves']) {
      const arm = runner.openArm({ out: CANDIDATE.out, in: inCard }, CANDIDATE.out, inCard);
      runner.advance(arm, depth);
    }
    // Three candidates, but only one base gauntlet — the fixed scheme would have
    // played three (half of all its games were redundant).
    expect(runner.usage().baseGamesPlayed).toBe(depth);
  });

  it('is resumable: two partial advances equal one full advance', () => {
    const oneShot = makeRunner();
    const armA = oneShot.openArm(CANDIDATE, CANDIDATE.out, CANDIDATE.in);
    oneShot.advance(armA, 8);

    const stepped = makeRunner();
    const armB = stepped.openArm(CANDIDATE, CANDIDATE.out, CANDIDATE.in);
    stepped.advance(armB, 3);
    stepped.advance(armB, 5);
    stepped.advance(armB, 8);

    expect(stepped.summarize(armB).paired).toEqual(oneShot.summarize(armA).paired);
  });
});

describe('the identical-game skip is exact', () => {
  it('produces byte-identical statistics with the optimisation on and off', () => {
    const depth = 2 * GAMES_PER_MATCHUP;

    const on = makeRunner({ reuseUnseenCardGames: true });
    const armOn = on.openArm(CANDIDATE, CANDIDATE.out, CANDIDATE.in);
    on.advance(armOn, depth);
    const withSkip = on.summarize(armOn);

    const off = makeRunner({ reuseUnseenCardGames: false });
    const armOff = off.openArm(CANDIDATE, CANDIDATE.out, CANDIDATE.in);
    off.advance(armOff, depth);
    const withoutSkip = off.summarize(armOff);

    expect(withSkip.paired).toEqual(withoutSkip.paired);
    expect(withSkip.delta).toBe(withoutSkip.delta);
    expect(withSkip.pValue).toBe(withoutSkip.pValue);
    expect(withSkip.verdict).toBe(withoutSkip.verdict);

    // …and it actually did something: the whole point is fewer games played.
    expect(on.usage().identicalGameSkipEnabled).toBe(true);
    expect(on.usage().variantGamesPlayed).toBeLessThan(off.usage().variantGamesPlayed);
    expect(off.usage().variantGamesSkipped).toBe(0);
  });

  it('switches itself off for a pilot that reasons over hidden library contents', () => {
    // A look-ahead pilot rolls out real draws, so the swapped card influences its
    // decisions from turn one whether or not it is ever drawn — "the game never saw
    // the card" is simply false, and the optimisation is unsound.
    const usage = makeRunner({ pilotId: MCTS_PILOT_ID }).usage();
    expect(usage.identicalGameSkipEnabled).toBe(false);
    expect(usage.identicalGameSkipDisabledReason).toMatch(/hidden library|rolls out/i);
  });
});

describe('the self-swap invariant survives the new machinery', () => {
  it('swapping a card for itself is EXACTLY zero: delta 0, no discordant pairs, p = 1', () => {
    // This is the proof the whole A/B apparatus is unbiased. A variant identical to
    // the base must agree with it in every single game.
    const runner = makeRunner();
    for (const card of ['Young Pyromancer', 'Goblin Guide', 'Beetleback Chief']) {
      const arm = runner.openArm({ out: card, in: card }, card, card);
      const played = runner.advance(arm, runner.slotCapacity(GAMES_PER_MATCHUP));
      const evaluation = runner.summarize(arm);

      expect(evaluation.delta).toBe(0);
      expect(evaluation.paired.baseOnly).toBe(0);
      expect(evaluation.paired.variantOnly).toBe(0);
      expect(evaluation.mcNemar.discordant).toBe(0);
      expect(evaluation.pValue).toBe(1);
      expect(evaluation.verdict).toBe('inconclusive');
      // And it costs nothing: identical libraries mean every game is the same game.
      expect(played.variantGamesSkipped).toBe(played.gamesPlayed);
    }
  });

  it('detects identical libraries and the single swapped slot', () => {
    const base = loadDeck(MONO_RED_AGGRO, pool);
    expect(swappedInstanceIdFor(base.library, base.library)).toBe(IDENTICAL_LIBRARIES);

    const variant = [...base.library];
    variant[17] = base.library[0] as (typeof base.library)[number];
    const id = swappedInstanceIdFor(base.library, variant);
    // Instance ids are 1-based over the pre-shuffle library.
    expect(id).toBe(18);

    // Two differences is not a single-card swap — refuse to reason about it.
    // (The deck's last card is a land, its first a creature, so this really is a
    // second, distinct change rather than an accidental like-for-like.)
    const twoChanges = [...variant];
    const lastCard = base.library[base.library.length - 1] as (typeof base.library)[number];
    expect(lastCard.id).not.toBe((base.library[2] as (typeof base.library)[number]).id);
    twoChanges[2] = lastCard;
    expect(swappedInstanceIdFor(base.library, twoChanges)).toBeUndefined();
  });
});

describe('the primitive classification stays complete', () => {
  it('classifies EVERY registered primitive as library-reading or library-safe', () => {
    // The identical-game argument rests on knowing which effects can look at a
    // library. A newly-added primitive that nobody classified would silently be
    // treated as safe, so this test fails the build until it is decided — the
    // failure mode is red, never a wrong verdict.
    const unclassified = CORE_PRIMITIVE_IDS.filter(
      (id) => !LIBRARY_READING_PRIMITIVES.has(id) && !LIBRARY_SAFE_PRIMITIVES.has(id),
    );
    expect(unclassified).toEqual([]);
  });

  it('never classifies a primitive as both', () => {
    const both = [...LIBRARY_READING_PRIMITIVES].filter((id) => LIBRARY_SAFE_PRIMITIVES.has(id));
    expect(both).toEqual([]);
  });

  it('knows the library-touching primitives the pool actually ships', () => {
    // Test against the REAL vocabulary (TESTING.md): a fabricated id would prove
    // nothing, so assert these ids exist in the registry.
    for (const id of ['searchLibrary', 'revealTopCard', 'reorderTopOfLibrary']) {
      expect(CORE_PRIMITIVE_IDS).toContain(id);
      expect(LIBRARY_READING_PRIMITIVES.has(id)).toBe(true);
    }
  });
});
