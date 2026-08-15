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
import type { Deck } from './deck.js';
import type { MatchupPilots } from './matchup.js';
import { evaluateSwap } from './swap.js';
import type { PairedBaseRecord } from './paired-arms.js';
import { createPairedArmRunner, pairedSlotAt, swappedInstanceIdsFor } from './paired-arms.js';
import { LIBRARY_READING_PRIMITIVES, LIBRARY_SAFE_PRIMITIVES } from './paired-arms-config.js';
import { MONO_RED_AGGRO, MONO_GREEN_STOMPY, UW_CONTROL, MONO_BLUE_TEMPO, RAKDOS_GOBLINS } from '../data/decks/index.js';

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

  it('detects identical libraries and every swapped slot', () => {
    const base = loadDeck(MONO_RED_AGGRO, pool);
    // A card swapped for itself: no differing slot at all.
    expect(swappedInstanceIdsFor(base.library, base.library)).toEqual([]);

    const oneChanged = [...base.library];
    oneChanged[17] = base.library[0] as (typeof base.library)[number];
    // Instance ids are 1-based over the pre-shuffle library.
    expect(swappedInstanceIdsFor(base.library, oneChanged)).toEqual([18]);

    // A PLAYSET swap rewrites four slots, and all four must be reported — a
    // single-slot detector returned `undefined` here and silently disabled the
    // whole optimisation once `DEFAULT_SWAP_SCOPE` became 'playset'.
    const lastCard = base.library[base.library.length - 1] as (typeof base.library)[number];
    const playset = [...base.library];
    const changed: number[] = [];
    for (let i = 0; i < base.library.length && changed.length < 4; i++) {
      if ((base.library[i] as (typeof base.library)[number]).id === lastCard.id) continue;
      playset[i] = lastCard;
      changed.push(i + 1);
    }
    expect(swappedInstanceIdsFor(base.library, playset)).toEqual(changed);

    // Libraries of different lengths cannot be compared at all.
    expect(swappedInstanceIdsFor(base.library, base.library.slice(1))).toBeUndefined();
  });
});

/**
 * Scoping the library check is where the optimisation is easiest to get subtly
 * wrong, so these test it against the REAL cards in the pool rather than invented
 * ones. Whose library a primitive reads is decided by `playerParam(ctx, 'who',
 * 'controller')` at RUNTIME, so neither the primitive id nor the source's
 * controller settles it — only the authored `who` on that card's own effect ref.
 */
describe("library peeks are scoped to the HERO's library", () => {
  function peekRefs(deck: Deck) {
    const found: { card: string; primitive: string; who: unknown }[] = [];
    for (const def of loadDeck(deck, pool).library) {
      const refs = [
        ...(def.effects ?? []),
        ...(def.triggers ?? []).flatMap((t) => t.effects),
        ...(def.activated ?? []).flatMap((a) => a.effects),
      ];
      for (const r of refs) {
        if (LIBRARY_READING_PRIMITIVES.has(r.primitive)) {
          found.push({ card: def.name, primitive: r.primitive, who: r.params?.['who'] });
        }
      }
    }
    return found;
  }

  it('the gauntlet really does contain all three targeting shapes', () => {
    // If this ever stops holding, the cases below stop proving anything.
    const hero = peekRefs(MONO_RED_AGGRO);
    const control = peekRefs(UW_CONTROL);

    // The hero's own Goblin Guide reveals the OPPONENT's top card.
    expect(hero.some((r) => r.card === 'Goblin Guide' && r.who === 'opponent')).toBe(true);
    // Ponder reads its own controller's library (no `who` at all).
    expect(control.some((r) => r.card === 'Ponder' && r.who === undefined)).toBe(true);
    // Path to Exile searches the library of whoever controlled the target — which
    // IS the hero when it answers a hero creature. This is the case that must stay
    // conservative, and it is why scoping by the source's controller is unsound.
    expect(control.some((r) => r.card === 'Path to Exile' && r.who === 'targetController')).toBe(true);
  });

  it('still skips games against an opponent whose only peeks read their OWN library', () => {
    // Izzet Prowess runs Ponder and no cross-table library effect, so its peeks
    // cannot reach the hero's deck: same deck, same seed, same draw in both arms.
    const runner = createPairedArmRunner(MONO_RED_AGGRO, {
      gauntletDecks: [loadDeck(MONO_BLUE_TEMPO, pool)],
      pilots: pilots(),
      pool,
      registry,
      seed: SEED,
    });
    const arm = runner.openArm(CANDIDATE, CANDIDATE.out, CANDIDATE.in);
    const played = runner.advance(arm, 20);
    expect(runner.usage().identicalGameSkipEnabled).toBe(true);
    expect(played.variantGamesSkipped).toBeGreaterThan(0);
  });

  it("a hero card that peeks at the OPPONENT's library does not disqualify a game", () => {
    // Goblin Guide triggers on nearly every attack, so treating "any library-reading
    // primitive fired" as disqualifying killed the hit rate outright — even though
    // it only ever looks at a library that is identical in both arms.
    const runner = createPairedArmRunner(MONO_RED_AGGRO, {
      gauntletDecks: [loadDeck(RAKDOS_GOBLINS, pool)],
      pilots: pilots(),
      pool,
      registry,
      seed: SEED,
    });
    const arm = runner.openArm(CANDIDATE, CANDIDATE.out, CANDIDATE.in);
    const played = runner.advance(arm, 20);
    expect(played.variantGamesSkipped).toBeGreaterThan(0);
  });
});

// --- the seam the parallel Lab runs on --------------------------------------------

describe('slicing an arm across workers changes nothing', () => {
  const SLOTS = 12;

  it('a set of slices reassembles into exactly what one advance() produced', () => {
    // The Lab splits one arm's slots over several workers and sums the 2×2 tables.
    // If a slice's games depended on where the slice STARTED — a shard-local
    // counter, a seat rebuilt mid-arm — this table would differ while both runs
    // still looked perfectly reasonable.
    const whole = makeRunner();
    const armHandle = whole.openArm(CANDIDATE, CANDIDATE.out, CANDIDATE.in);
    const reference = whole.advance(armHandle, SLOTS);

    const sliced = makeRunner();
    const tally = { bothWon: 0, baseOnly: 0, variantOnly: 0, neither: 0 };
    let skipped = 0;
    for (const [from, to] of [[0, 3], [3, 4], [4, 10], [10, SLOTS]] as const) {
      const slice = sliced.playSlice(CANDIDATE, CANDIDATE.out, CANDIDATE.in, from, to);
      tally.bothWon += slice.paired.bothWon;
      tally.baseOnly += slice.paired.baseOnly;
      tally.variantOnly += slice.paired.variantOnly;
      tally.neither += slice.paired.neither;
      skipped += slice.variantGamesSkipped;
      expect(slice.gamesPlayed).toBe(to - from);
    }
    expect(tally).toEqual(reference.paired);
    expect(skipped).toBe(reference.variantGamesSkipped);
  });

  it('adopts base games another worker played, instead of replaying them', () => {
    // This is base-arm reuse surviving the jump across workers. The adopted
    // records must also keep the identical-game skip alive — a record stripped of
    // its `leftLibrary` would be safe but would silently cost a third of the run.
    const source = makeRunner();
    const records = new Map(
      Array.from({ length: SLOTS }, (_, slot) => [slot, source.baseRecordAt(slot)] as const),
    );
    expect(source.usage().baseGamesPlayed).toBe(SLOTS);

    const adopting = createPairedArmRunner(MONO_RED_AGGRO, {
      gauntletDecks: gauntlet,
      pilots: pilots(),
      pool,
      registry,
      seed: SEED,
      baseRecords: (slot) => records.get(slot),
    });
    const slice = adopting.playSlice(CANDIDATE, CANDIDATE.out, CANDIDATE.in, 0, SLOTS);

    // Not one base game replayed…
    expect(slice.baseGamesPlayed).toBe(0);
    expect(adopting.usage().baseGamesPlayed).toBe(0);
    // …and the free-game optimisation still fired.
    expect(slice.variantGamesSkipped).toBeGreaterThan(0);

    const reference = makeRunner();
    const handle = reference.openArm(CANDIDATE, CANDIDATE.out, CANDIDATE.in);
    expect(slice.paired).toEqual(reference.advance(handle, SLOTS).paired);
  });

  it('plays a slot itself when nobody supplied it, and counts it honestly', () => {
    // The pooled schedule always supplies what it asks for, so this should never
    // happen — but if it ever did, the run must report the extra base games rather
    // than quietly double-counting the base arm.
    const runner = createPairedArmRunner(MONO_RED_AGGRO, {
      gauntletDecks: gauntlet,
      pilots: pilots(),
      pool,
      registry,
      seed: SEED,
      baseRecords: () => undefined,
    });
    const slice = runner.playSlice(CANDIDATE, CANDIDATE.out, CANDIDATE.in, 0, 4);
    expect(slice.baseGamesPlayed).toBe(4);
  });

  it('reports the swap SCOPE and copy count on the verdict it summarises', () => {
    // The adaptive engine used to report `copiesSwapped: 1` for every suggestion
    // even though it swaps the whole playset by default, so the Lab's Apply button
    // offered to move one copy of a 4-of.
    const runner = makeRunner();
    const handle = runner.openArm(CANDIDATE, CANDIDATE.out, CANDIDATE.in);
    runner.advance(handle, 2);
    const evaluation = runner.summarize(handle);
    expect(evaluation.scope).toBe('playset');
    const copies =
      MONO_RED_AGGRO.cards.find((entry) => {
        const def = pool.get(entry.cardId) ?? pool.getByName(entry.cardId);
        return def?.name === CANDIDATE.out;
      })?.count ?? 0;
    expect(copies).toBeGreaterThan(1);
    expect(evaluation.copiesSwapped).toBe(copies);
  });

  it('ticks progress once per game actually played, and never for a free one', () => {
    let ticks = 0;
    const records = new Map<number, PairedBaseRecord>();
    const source = makeRunner();
    for (let slot = 0; slot < SLOTS; slot++) records.set(slot, source.baseRecordAt(slot));

    const runner = createPairedArmRunner(MONO_RED_AGGRO, {
      gauntletDecks: gauntlet,
      pilots: pilots(),
      pool,
      registry,
      seed: SEED,
      baseRecords: (slot) => records.get(slot),
      onGame: (games) => {
        ticks += games;
      },
    });
    const slice = runner.playSlice(CANDIDATE, CANDIDATE.out, CANDIDATE.in, 0, SLOTS);
    // A progress bar that counted skipped games would race to 100% and stall.
    expect(ticks).toBe(slice.variantGamesPlayed);
    expect(slice.variantGamesPlayed + slice.variantGamesSkipped).toBe(SLOTS);
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
