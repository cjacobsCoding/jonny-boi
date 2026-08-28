/**
 * THE DECK-NEUTRAL PILOT A/B — "is this pilot stronger?", asked so that no single
 * deck can answer for it (DESIGN §3.46).
 *
 * ### The question the gauntlet cannot answer
 *
 * `runGauntlet` puts the SAME pilot in both seats and reports how a deck does.
 * That number is a property of the *meta*, not of the pilot: a change that suits
 * one archetype tilts the gauntlet toward it even when the pilot got worse
 * overall, because the pilot is also playing the other side of every game. The
 * lab has already been fooled by this. During §3.45, a combat-math build took
 * **Selesnya Blink from 71% to 74%** in the gauntlet — and measured **47.5%
 * head-to-head against the pilot it replaced**. The gauntlet row and the pilot's
 * strength moved in opposite directions, and the row is the one that lies.
 * Two earlier attempts at that same fix were judged on the gauntlet row alone.
 *
 * ### The design
 *
 * Play pilot A against pilot B over **every unordered pair of gauntlet decks, in
 * BOTH orientations, on matched seeds**:
 *
 *   orientation 1 — pilot A drives deck one (seat A), pilot B drives deck two
 *   orientation 2 — pilot B drives deck one (seat A), pilot A drives deck two
 *
 * Both orientations of a pair run the same game count off the same pair seed, so
 * game *i* of one is game *i* of the other: same decks, same seats, same shuffle,
 * same player on the play. The only thing that differs is which pilot sits where.
 * Three confounders cancel exactly rather than "on average":
 *
 *   - **Deck strength.** Every deck is driven the same number of games by each
 *     pilot, on the same seeds. A pilot cannot profit from being handed the
 *     stronger archetype, because it is handed both.
 *   - **Seat.** Each pilot occupies seat A in exactly half the games.
 *   - **On the play.** `onPlayFor` alternates by game index, which is shared
 *     between the orientations; pilot A leads in orientation 1 on even indices
 *     and in orientation 2 on odd ones, so each pilot is on the play in exactly
 *     half the games — for any game count, odd or even.
 *
 * ### The control that makes a reading meaningful
 *
 * Run the SAME pilot id on both sides and the two orientations are not merely
 * similar, they are **the same game**: identical decks in identical seats with
 * identical pilots and identical seeds. Every slot is therefore level and the
 * record comes out *exactly* balanced — an identity, not a statistical
 * near-miss. That is what makes a 51.2% reading evidence instead of noise, and
 * it is checked at runtime ({@link PilotAbResult.balanced}) and pinned by
 * `pilot-ab.test.ts`. A control that comes out unbalanced means the harness is
 * broken or a pilot carries state across games, and either way every other
 * number this tool prints is void.
 *
 * ### What it measures, and what it cannot
 *
 * It compares two **registered pilot ids** (`heuristic`, `hybrid`, `mcts`,
 * `random`, or anything else in the `AiRegistry`). It cannot compare two BUILDS
 * of the same id, because both builds cannot be loaded into one process — see
 * {@link PILOT_AB_BUILD_COMPARISON_NOTE} for the protocol that can.
 *
 * ### Statistics
 *
 * The unit of analysis is the **matched slot**: one (deck pair, game index),
 * which is two games — one per orientation. A slot is either *level* (each pilot
 * took one game, or nobody did) or *decided* (one pilot took both). Decided slots
 * are exactly the discordant pairs of McNemar's test, so the significance call
 * reuses `mcNemarTest` and `decideVerdict` — the same machinery, and the same
 * alpha, as the card-swap verdict. The headline game record is reported with a
 * Wilson interval as a descriptive summary; the pairing lives in the slot table
 * and the p-value, and those are what the verdict is built on.
 *
 * Pure and deterministic: same decks, same pilots, same seed ⇒ same numbers.
 */

import type { EffectRegistry, RulesConfig } from '@jonny-boi/core';
import type { Pilot } from '@jonny-boi/ai';
import type { LoadedDeck } from './deck.js';
import { gameSeedFor, makeSeats, runMatchup, type RunOptions } from './matchup.js';
import type { MatchResult } from './match.js';
import { decideVerdict, type SwapVerdict } from './swap.js';
import { DEFAULT_SIM_CONFIG, DEFAULT_STATS_CONFIG, type SimConfig, type StatsConfig } from './config.js';
import { mcNemarTest, wilsonInterval, type McNemarResult, type PairedTable, type ProportionCI } from './stats.js';

/**
 * Games per deck pair PER ORIENTATION, by default. The run plays this many games
 * twice for each of the pairs, so nine sample decks at the default cost
 * 36 × 2 × 100 = 7,200 games — seconds on the heuristic pilot, which is the point:
 * a yardstick nobody can afford to run is a yardstick nobody runs.
 */
export const DEFAULT_PILOT_AB_GAMES_PER_ORIENTATION = 100;

/** Both orientations of a pair — the second is what makes the comparison deck-neutral. */
export const ORIENTATIONS_PER_PAIR = 2;

/** A dead-even head-to-head share. The null the verdict's delta is measured from. */
const EVEN_SHARE = 0.5;

/**
 * The honest limitation, in one place so the CLI help, the docs and this module
 * cannot drift apart.
 *
 * The tool pits two *registered pilot ids* against each other. Comparing two
 * BUILDS of one id — "did my change to the heuristic make it stronger?", the
 * question §3.45 actually needed — is harder, because a single process can only
 * hold one build of `heuristic`. Two protocols work, in descending order of
 * strength:
 *
 *  1. **Register the new behaviour under a second id** (the exact method).
 *     `AiRegistry.registerPilot` is a public seam and re-registering an id
 *     replaces it, so a working branch can expose its build as, say,
 *     `heuristic-next` alongside the old one and run
 *     `pilot-ab --pilot-a heuristic --pilot-b heuristic-next` in one process.
 *     Both builds then play the same matched-seed matrix against each other and
 *     the result is a true head-to-head. Delete the temporary id before merge.
 *
 *  2. **A common opponent across branches** (weaker, but needs no code).
 *     Run `pilot-ab --pilot-a heuristic --pilot-b random --seed S --games N` on
 *     the old branch and again on the new one, and compare the two win shares.
 *     This assumes strength is transitive through the yardstick pilot, which is
 *     an assumption and not a fact, and `random` is a poor yardstick besides — a
 *     change can beat it by more while being worse against a real opponent. Treat
 *     a difference here as a hint, never as a verdict.
 *
 * What does NOT work: running the same-id control on two branches and comparing
 * the numbers. The control is exactly 50% on every branch by construction, so it
 * carries no information about which build is stronger.
 */
export const PILOT_AB_BUILD_COMPARISON_NOTE =
  'This compares two REGISTERED PILOT IDS, not two builds of one id — both builds '
  + 'cannot be loaded at once. To compare builds, register the new behaviour under '
  + 'a second id (AiRegistry.registerPilot) and run the two ids head-to-head in one '
  + 'process; that is the only exact method. Running the same-id control on two '
  + 'branches proves nothing: it is exactly 50% on both by construction.';

/** The two contestants. Not seats — a seat is a `PlayerId`, and each pilot takes both. */
export interface PilotAbContestants {
  readonly pilotA: Pilot;
  readonly pilotB: Pilot;
}

/** One unordered pair of decks, by index into the supplied deck list. */
export interface DeckPair {
  readonly first: number;
  readonly second: number;
}

/**
 * Every unordered pair of distinct decks, in a stable order.
 *
 * ⚠️ A pair's seed is derived from its INDEX here, so inserting a deck into the
 * middle of `SAMPLE_DECKS` reseeds every pair after it and moves a recorded
 * baseline without changing how anything plays — the same trap the deck registry
 * documents. Append new decks; do not slot them in.
 */
export function deckPairsOf(deckCount: number): readonly DeckPair[] {
  const pairs: DeckPair[] = [];
  for (let first = 0; first < deckCount; first++) {
    for (let second = first + 1; second < deckCount; second++) pairs.push({ first, second });
  }
  return pairs;
}

/** What the harness needs to run. */
export interface PilotAbOptions {
  /** The decks to pair off — every unordered pair is played in both orientations. */
  readonly decks: readonly LoadedDeck[];
  readonly pilots: PilotAbContestants;
  readonly registry: EffectRegistry;
  /** Games per pair per orientation (so a pair costs twice this). */
  readonly gamesPerOrientation?: number;
  readonly baseSeed: number;
  readonly stats?: StatsConfig;
  readonly sim?: SimConfig;
  readonly config?: RulesConfig;
  /** Called after each pair finishes, for progress on a slow pilot. */
  readonly onPair?: (pairsDone: number, pairsTotal: number) => void;
}

/**
 * How one deck fared under each pilot. Both pilots drive every deck the same
 * number of games on the same seeds, so this row is a like-for-like comparison
 * and it is where "the change only helps one archetype" becomes visible.
 */
export interface PilotAbDeckRow {
  readonly deck: string;
  /**
   * Games EACH pilot drove this deck. Equal for both by construction — that
   * equality *is* the deck-neutrality, so it is reported rather than assumed.
   */
  readonly gamesDriven: number;
  /** Games pilot A won WHILE DRIVING this deck. */
  readonly winsA: number;
  /** Games pilot B won while driving this deck. */
  readonly winsB: number;
  /**
   * Drawn games this deck was in. A draw is a draw for both decks at the table,
   * so these sum to twice the run's draw count.
   */
  readonly draws: number;
  /** Pilot A's share of this deck's decisive games, with a Wilson interval. */
  readonly shareA: ProportionCI;
}

/**
 * The matched-slot tally — the paired unit the statistics actually stand on.
 * One slot is one (deck pair, game index), i.e. the same game played twice with
 * the pilots exchanged.
 */
export interface PilotAbSlots {
  /** Slots played: pairs × games per orientation. */
  readonly total: number;
  /** Slots pilot A took outright (it won more of the slot's two games). */
  readonly aheadA: number;
  /** Slots pilot B took outright. */
  readonly aheadB: number;
  /** Slots that split — no evidence either way. A control makes every slot level. */
  readonly level: number;
}

/** Pilot A's verdict against pilot B. */
export type PilotAbVerdict = 'stronger' | 'weaker' | 'inconclusive';

/**
 * The swap vocabulary mapped onto pilots, so `decideVerdict` stays the ONE place
 * that decides what clears significance.
 */
const PILOT_VERDICT_OF: Readonly<Record<SwapVerdict, PilotAbVerdict>> = Object.freeze({
  better: 'stronger',
  worse: 'weaker',
  inconclusive: 'inconclusive',
});

/** The full deck-neutral head-to-head. */
export interface PilotAbResult {
  readonly pilotA: string;
  readonly pilotB: string;
  readonly deckPairs: number;
  readonly gamesPerOrientation: number;
  readonly totalGames: number;
  /** Total games pilot A won, across every deck it drove. */
  readonly winsA: number;
  readonly winsB: number;
  readonly draws: number;
  /**
   * Pilot A's share of the decisive games, with a Wilson interval.
   *
   * Descriptive: games arrive in matched pairs, so this interval treats as
   * independent things that are not. The pairing is respected by `slots` and
   * `pValue`, and the verdict is built on those.
   */
  readonly shareA: ProportionCI;
  readonly slots: PilotAbSlots;
  /**
   * The same slot tally in McNemar's vocabulary, so the shared test can read it:
   * `baseOnly` = slots A took, `variantOnly` = slots B took. The split slots are
   * the CONCORDANT cells and the test ignores them, so they are all parked in
   * `bothWon` (rather than apportioned between `bothWon` and `neither`, which
   * would be an invented distinction) and the table's total is the slot count.
   */
  readonly paired: PairedTable;
  readonly mcNemar: McNemarResult;
  readonly pValue: number;
  readonly verdict: PilotAbVerdict;
  readonly perDeck: readonly PilotAbDeckRow[];
  /** True when both sides ran the same pilot id — the balance control. */
  readonly control: boolean;
  /**
   * Whether the record came out exactly level. A control MUST be balanced; if it
   * is not, the harness or a pilot's cross-game state is broken and nothing else
   * here can be trusted.
   */
  readonly balanced: boolean;
}

/** Per-game outcome codes, kept as small integers so a pair's games cost one typed array. */
const OUTCOME_DRAW = 0;
const OUTCOME_SEAT_A = 1;
const OUTCOME_SEAT_B = 2;

function outcomeCode(result: MatchResult): number {
  if (result.outcome.kind !== 'win') return OUTCOME_DRAW;
  return result.outcome.winner === 'A' ? OUTCOME_SEAT_A : OUTCOME_SEAT_B;
}

/** A mutable per-deck accumulator, frozen into a `PilotAbDeckRow` at the end. */
export interface DeckTally {
  winsA: number;
  winsB: number;
  draws: number;
}

/**
 * The integer tallies from a SLICE of one deck pair: games `[gameStart, gameEnd)`
 * of both orientations. This is the parallel unit — everything in it is an exact
 * integer count, so summing slices in any order reconstructs the whole run's
 * totals bit-for-bit, and every probability/interval/verdict is computed once at
 * the end by {@link finishPilotAb}. The pair's two orientations always live in
 * the SAME slice because a matched slot needs both of its games to be scored.
 */
export interface PilotAbSliceTallies {
  readonly winsA: number;
  readonly winsB: number;
  readonly draws: number;
  readonly aheadA: number;
  readonly aheadB: number;
  readonly level: number;
  /** Wins/draws credited while a pilot drove the pair's FIRST deck. */
  readonly firstDeck: DeckTally;
  /** Wins/draws credited while a pilot drove the pair's SECOND deck. */
  readonly secondDeck: DeckTally;
}

/** What {@link playPilotAbPairSlice} needs — one pair, one game range. */
export interface PilotAbPairSliceOptions {
  readonly deckOne: LoadedDeck;
  readonly deckTwo: LoadedDeck;
  readonly pilots: PilotAbContestants;
  readonly registry: EffectRegistry;
  /** The pair's shared seed — `gameSeedFor(baseSeed, pairIndex)`, computed by the caller. */
  readonly pairSeed: number;
  /** Games per orientation of the WHOLE run (the range below slices into it). */
  readonly gamesPerOrientation: number;
  /** First game index of the slice (inclusive). */
  readonly gameStart: number;
  /** One past the last game index. */
  readonly gameEnd: number;
  readonly runOpts: RunOptions;
  /**
   * Scratch buffer for orientation one's outcomes, ≥ `gameEnd` long. Optional:
   * the sequential runner reuses ONE buffer across every pair (allocation
   * discipline, CLAUDE.md rule 7); a worker slicing a single pair lets this
   * default to a fresh buffer.
   */
  readonly scratch?: Int8Array;
}

/**
 * Play games `[gameStart, gameEnd)` of BOTH orientations of one deck pair and
 * tally them. Every seed and on-the-play assignment derives from the game's
 * ABSOLUTE index (via `runMatchup`'s range), so a slice plays byte-identical
 * games to that stretch of the whole run — the same property the web Lab's
 * gauntlet shards stand on, extended to the matched-pair unit.
 */
export function playPilotAbPairSlice(options: PilotAbPairSliceOptions): PilotAbSliceTallies {
  const { deckOne, deckTwo, pilots, registry, pairSeed, runOpts } = options;
  const range = { gameStart: options.gameStart, gameEnd: options.gameEnd };
  const firstOrientation = options.scratch ?? new Int8Array(options.gameEnd);

  const firstDeck: DeckTally = { winsA: 0, winsB: 0, draws: 0 };
  const secondDeck: DeckTally = { winsA: 0, winsB: 0, draws: 0 };
  let winsA = 0;
  let winsB = 0;
  let draws = 0;
  let aheadA = 0;
  let aheadB = 0;
  let level = 0;

  // Orientation one: pilot A takes seat A (deck one), pilot B takes seat B.
  // `MatchupPilots.pilotA/pilotB` name SEATS, not contestants.
  runMatchup(
    makeSeats(deckOne, deckTwo, { pilotA: pilots.pilotA, pilotB: pilots.pilotB }, registry),
    options.gamesPerOrientation,
    pairSeed,
    {
      ...runOpts,
      range,
      onGame: (result, index) => {
        firstOrientation[index] = outcomeCode(result);
      },
    },
  );

  // Orientation two: the contestants swap decks. Same seats, same seeds.
  runMatchup(
    makeSeats(deckOne, deckTwo, { pilotA: pilots.pilotB, pilotB: pilots.pilotA }, registry),
    options.gamesPerOrientation,
    pairSeed,
    {
      ...runOpts,
      range,
      onGame: (result, index) => {
        const one = firstOrientation[index] as number;
        const two = outcomeCode(result);

        // Who won each of the slot's two games. In orientation one seat A is
        // pilot A; in orientation two seat A is pilot B.
        const aWonOne = one === OUTCOME_SEAT_A;
        const bWonOne = one === OUTCOME_SEAT_B;
        const bWonTwo = two === OUTCOME_SEAT_A;
        const aWonTwo = two === OUTCOME_SEAT_B;

        const scoreA = (aWonOne ? 1 : 0) + (aWonTwo ? 1 : 0);
        const scoreB = (bWonOne ? 1 : 0) + (bWonTwo ? 1 : 0);
        winsA += scoreA;
        winsB += scoreB;
        if (one === OUTCOME_DRAW) draws++;
        if (two === OUTCOME_DRAW) draws++;

        // Credit each win to the deck its pilot was DRIVING.
        if (aWonOne) firstDeck.winsA++;
        if (bWonOne) secondDeck.winsB++;
        if (bWonTwo) firstDeck.winsB++;
        if (aWonTwo) secondDeck.winsA++;
        // A drawn game is a drawn game for both decks that played it.
        if (one === OUTCOME_DRAW) {
          firstDeck.draws++;
          secondDeck.draws++;
        }
        if (two === OUTCOME_DRAW) {
          firstDeck.draws++;
          secondDeck.draws++;
        }

        if (scoreA > scoreB) aheadA++;
        else if (scoreB > scoreA) aheadB++;
        else level++;
      },
    },
  );

  return { winsA, winsB, draws, aheadA, aheadB, level, firstDeck, secondDeck };
}

/** The mutable whole-run accumulator {@link foldSliceTallies} folds into. */
export interface PilotAbTotals {
  winsA: number;
  winsB: number;
  draws: number;
  aheadA: number;
  aheadB: number;
  level: number;
  /** One tally per deck, indexed as the run's deck list is. */
  readonly perDeck: DeckTally[];
}

/** A zeroed accumulator for a run over `deckCount` decks. */
export function emptyPilotAbTotals(deckCount: number): PilotAbTotals {
  return {
    winsA: 0,
    winsB: 0,
    draws: 0,
    aheadA: 0,
    aheadB: 0,
    level: 0,
    perDeck: Array.from({ length: deckCount }, () => ({ winsA: 0, winsB: 0, draws: 0 })),
  };
}

/**
 * Fold one pair-slice's tallies into the run totals. Integer addition — exact
 * and commutative — so the totals cannot depend on which slice landed first,
 * which is what lets a parallel host and the sequential loop share this fold.
 */
export function foldSliceTallies(totals: PilotAbTotals, pair: DeckPair, slice: PilotAbSliceTallies): void {
  totals.winsA += slice.winsA;
  totals.winsB += slice.winsB;
  totals.draws += slice.draws;
  totals.aheadA += slice.aheadA;
  totals.aheadB += slice.aheadB;
  totals.level += slice.level;
  const first = totals.perDeck[pair.first] as DeckTally;
  const second = totals.perDeck[pair.second] as DeckTally;
  first.winsA += slice.firstDeck.winsA;
  first.winsB += slice.firstDeck.winsB;
  first.draws += slice.firstDeck.draws;
  second.winsA += slice.secondDeck.winsA;
  second.winsB += slice.secondDeck.winsB;
  second.draws += slice.secondDeck.draws;
}

/** What {@link finishPilotAb} needs beyond the summed totals. */
export interface FinishPilotAbInput {
  readonly decks: readonly LoadedDeck[];
  readonly pilotAId: string;
  readonly pilotBId: string;
  readonly pairsCount: number;
  readonly gamesPerOrientation: number;
  readonly stats: StatsConfig;
  readonly totals: PilotAbTotals;
}

/**
 * Reduce summed totals to the one `PilotAbResult` — THE single place the
 * statistics and the verdict are computed, shared by the sequential runner and
 * the CLI's parallel host so the two can never disagree about what the numbers
 * mean. Every input is an integer total; nothing here depends on the order the
 * games were played in.
 */
export function finishPilotAb(input: FinishPilotAbInput): PilotAbResult {
  const { totals, stats, gamesPerOrientation: games } = input;
  const { winsA, winsB, draws, aheadA, aheadB, level } = totals;
  const decisive = winsA + winsB;
  // McNemar reads only the discordant cells. The level slots are the concordant
  // ones: they all go in `bothWon` so the table totals to the slot count, rather
  // than being apportioned across `bothWon`/`neither` on a distinction this
  // design does not make.
  const paired: PairedTable = { bothWon: level, baseOnly: aheadA, variantOnly: aheadB, neither: 0 };
  const mcNemar = mcNemarTest(paired);
  const shareA = wilsonInterval(winsA, decisive, stats.z);
  const slots: PilotAbSlots = { total: input.pairsCount * games, aheadA, aheadB, level };
  // The verdict rule is `decideVerdict`'s, unchanged: significance AND a minimum
  // sample, with the sign of the effect choosing the direction. The sample is
  // counted in matched SLOTS, because that is the independent unit here.
  const verdict =
    PILOT_VERDICT_OF[
      decideVerdict(shareA.p - EVEN_SHARE, mcNemar.pValue, slots.total, stats.alpha, stats.minGamesForVerdict)
    ];

  return {
    pilotA: input.pilotAId,
    pilotB: input.pilotBId,
    deckPairs: input.pairsCount,
    gamesPerOrientation: games,
    totalGames: input.pairsCount * games * ORIENTATIONS_PER_PAIR,
    winsA,
    winsB,
    draws,
    shareA,
    slots,
    paired,
    mcNemar,
    pValue: mcNemar.pValue,
    verdict,
    perDeck: input.decks.map((deck, i) => {
      const t = totals.perDeck[i] as DeckTally;
      return Object.freeze({
        deck: deck.name,
        // Every deck meets each of the others once per orientation, and the two
        // orientations put a different pilot behind it.
        gamesDriven: games * (input.decks.length - 1),
        winsA: t.winsA,
        winsB: t.winsB,
        draws: t.draws,
        shareA: wilsonInterval(t.winsA, t.winsA + t.winsB, stats.z),
      });
    }),
    control: input.pilotAId === input.pilotBId,
    balanced: winsA === winsB,
  };
}

/**
 * Play the whole deck-neutral matrix and reduce it to one verdict.
 *
 * Allocation discipline (CLAUDE.md rule 7): the only cross-pair allocation is
 * the reused `Int8Array` holding orientation one's outcomes until orientation
 * two catches up, plus whatever `runMatchup` itself keeps. Per-game results are
 * folded on the fly and never retained.
 *
 * Structured as slice → fold → finish so the CLI's parallel host runs the SAME
 * three functions over worker-played slices and cannot produce different
 * numbers — `parallel.test.ts` asserts the two paths field-for-field.
 */
export function runPilotAb(options: PilotAbOptions): PilotAbResult {
  const { decks, pilots, registry } = options;
  const games = options.gamesPerOrientation ?? DEFAULT_PILOT_AB_GAMES_PER_ORIENTATION;
  const stats = options.stats ?? DEFAULT_STATS_CONFIG;
  const runOpts: RunOptions = {
    sim: options.sim ?? DEFAULT_SIM_CONFIG,
    stats,
    ...(options.config ? { config: options.config } : {}),
  };
  const pairs = deckPairsOf(decks.length);

  // Orientation one's per-game winner, held only until orientation two replays
  // the same slot. One allocation for the whole run.
  const firstOrientation = new Int8Array(games);
  const totals = emptyPilotAbTotals(decks.length);

  for (let p = 0; p < pairs.length; p++) {
    const pair = pairs[p] as DeckPair;
    // Both orientations of a pair share this seed, which is what matches game i
    // of one to game i of the other.
    const pairSeed = gameSeedFor(options.baseSeed, p);
    const slice = playPilotAbPairSlice({
      deckOne: decks[pair.first] as LoadedDeck,
      deckTwo: decks[pair.second] as LoadedDeck,
      pilots,
      registry,
      pairSeed,
      gamesPerOrientation: games,
      gameStart: 0,
      gameEnd: games,
      runOpts,
      scratch: firstOrientation,
    });
    foldSliceTallies(totals, pair, slice);
    options.onPair?.(p + 1, pairs.length);
  }

  return finishPilotAb({
    decks,
    pilotAId: pilots.pilotA.id,
    pilotBId: pilots.pilotB.id,
    pairsCount: pairs.length,
    gamesPerOrientation: games,
    stats,
    totals,
  });
}
