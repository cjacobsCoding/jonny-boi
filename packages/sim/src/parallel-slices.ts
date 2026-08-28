/**
 * THE PARALLEL SLICE LAYER (DESIGN §3.53) — cutting a CLI run into independent
 * slices and merging the results back **byte-identically**, as pure functions.
 *
 * The sim's loops were built for a parallel host from the start: every game
 * seed and on-the-play assignment is a function of the game's ABSOLUTE
 * (opponent × game) indices (`RunRange`, `matchup.ts`), so playing only a slice
 * reproduces exactly those games of the whole run. The web Lab has fanned out
 * over Web Workers on that seam since §3.5; this module gives the CLI the same
 * cuts for `node:worker_threads`. It contains NO Node imports — the host
 * (`parallel-host.ts`) and the worker entry (`parallel-worker.ts`) are the only
 * Node-only files — so the identity tests can run every slice in-process and
 * compare against the sequential functions field for field.
 *
 * ## Why merged results are byte-identical, not just statistically equal
 *
 *   - Slices carry INTEGER COUNTS (wins, draws, paired 2×2 cells). Integer
 *     addition is exact and commutative, so totals cannot depend on which
 *     worker finished first.
 *   - Everything ordered (per-matchup rows, per-game seed lists) is keyed by
 *     its canonical index and reassembled in that order.
 *   - Every probability, interval, p-value and verdict is computed ONCE at the
 *     end, from the totals, by the SAME functions the sequential path calls
 *     (`wilsonInterval`, `summarizePairedSwap`, `finishPilotAb`).
 *
 * `parallel.test.ts` asserts all of it by running small grids both ways.
 *
 * The same arrangement, one level up, is `apps/web/src/lib/sim/{plan,merge}.ts`
 * — kept separate because the web's shard protocol carries Lab-specific payloads
 * (imported decks, replay traces) and bundles for the browser, while this layer
 * must stay importable by a bare Node worker with no DOM and no Vite.
 */

import type { EffectRegistry } from '@jonny-boi/core';
import { buildRegistry, loadCardPool } from '@jonny-boi/cards';
import type { CardPool } from '@jonny-boi/cards';
import { createDefaultAiRegistry } from '@jonny-boi/ai';
import type { Pilot } from '@jonny-boi/ai';
import { SAMPLE_DECKS } from '../data/decks/index.js';
import type { Deck, LoadedDeck } from './deck.js';
import { loadDeck } from './deck.js';
import {
  gameSeedFor,
  makeSeats,
  runMatchup,
  type MatchupPilots,
  type MatchupResult,
} from './matchup.js';
import type { GauntletResult } from './gauntlet.js';
import { evaluateSwap, summarizePairedSwap, type SwapEvaluation } from './swap.js';
import {
  deckPairsOf,
  emptyPilotAbTotals,
  finishPilotAb,
  foldSliceTallies,
  playPilotAbPairSlice,
  type DeckPair,
  type PilotAbContestants,
  type PilotAbResult,
  type PilotAbSliceTallies,
} from './pilot-ab.js';
import { DEFAULT_SIM_CONFIG, DEFAULT_STATS_CONFIG, type StatsConfig, type SwapScope } from './config.js';
import { wilsonInterval, type PairedTable } from './stats.js';
import { MIN_GAMES_PER_SLICE, SLICES_PER_WORKER } from './parallel-config.js';
import {
  finishSoak,
  runSoakAnchored,
  runSoakMixedRange,
  soakOptionsFor,
  type SoakPartial,
  type SoakReport,
  type SoakSliceSettings,
} from './soak.js';

// --- what a worker is told once, at startup --------------------------------------

/**
 * Everything a worker needs to rebuild the run's fixed context: decks by NAME
 * (resolved against `SAMPLE_DECKS`, the only decks the CLI accepts), pilots by
 * id (resolved against the default AI registry — the same registry, so the same
 * build). Plain JSON: it crosses `postMessage`.
 */
export interface WorkerInitSpec {
  /** Seat-A deck name — the gauntlet hero, match deck A, or the swap base. */
  readonly heroName?: string;
  /** Opponents by sample-deck name, in the run's canonical order. */
  readonly opponentNames?: readonly string[];
  /** The full deck list for a pilot-ab run, in `SAMPLE_DECKS` order. */
  readonly deckNames?: readonly string[];
  /** The one pilot id driving both seats (matchup/swap/soak runs). */
  readonly pilotId?: string;
  /** The two pilot-ab contestants. */
  readonly pilotAId?: string;
  readonly pilotBId?: string;
}

/** The rebuilt per-worker context. Built once; reused for every job. */
export interface ParallelSimContext {
  readonly pool: CardPool;
  readonly registry: EffectRegistry;
  readonly hero?: LoadedDeck;
  /** The hero as a `Deck` record — `evaluateSwap` builds the variant from it. */
  readonly heroDeck?: Deck;
  readonly opponents?: readonly LoadedDeck[];
  readonly decks?: readonly LoadedDeck[];
  readonly pilots?: MatchupPilots;
  readonly contestants?: PilotAbContestants;
  /** The single pilot a soak drives both seats with. */
  readonly soakPilot?: Pilot;
}

/** Resolve one sample deck by EXACT name — loud on a miss, never a guess. */
function sampleDeckByName(name: string): Deck {
  const deck = SAMPLE_DECKS.find((d) => d.name === name);
  if (!deck) throw new Error(`worker: unknown sample deck "${name}"`);
  return deck;
}

/** Resolve one pilot id to a fresh instance — loud on a miss. */
function pilotById(registry: ReturnType<typeof createDefaultAiRegistry>, id: string): Pilot {
  const pilot = registry.getPilot(id);
  if (!pilot) throw new Error(`worker: unknown pilot "${id}"`);
  return pilot;
}

/**
 * Build the fixed context a worker plays every job against. The expensive part
 * is `loadCardPool` (indexing the whole pool), which is why the host reuses
 * long-lived workers instead of spawning one per slice — the same reason the
 * web pool does (`execute.ts`'s `SimContext` note).
 */
export function createParallelContext(init: WorkerInitSpec): ParallelSimContext {
  // Pool validation warnings are silenced exactly as the CLI's `makeLab` and the
  // web workers silence them: stubbed mechanics are documented, not per-worker news.
  const pool = loadCardPool({ onWarn: () => {} });
  const registry = buildRegistry();
  const aiRegistry = createDefaultAiRegistry();

  const heroDeck = init.heroName !== undefined ? sampleDeckByName(init.heroName) : undefined;
  const hero = heroDeck !== undefined ? loadDeck(heroDeck, pool) : undefined;
  const opponents = init.opponentNames?.map((name) => loadDeck(sampleDeckByName(name), pool));
  const decks = init.deckNames?.map((name) => loadDeck(sampleDeckByName(name), pool));

  // Two seats, two instances — a pilot may carry per-seat state within a game.
  const pilots: MatchupPilots | undefined =
    init.pilotId !== undefined
      ? { pilotA: pilotById(aiRegistry, init.pilotId), pilotB: pilotById(aiRegistry, init.pilotId) }
      : undefined;
  const contestants: PilotAbContestants | undefined =
    init.pilotAId !== undefined && init.pilotBId !== undefined
      ? { pilotA: pilotById(aiRegistry, init.pilotAId), pilotB: pilotById(aiRegistry, init.pilotBId) }
      : undefined;
  const soakPilot = init.pilotId !== undefined ? pilotById(aiRegistry, init.pilotId) : undefined;

  return {
    pool,
    registry,
    ...(hero !== undefined ? { hero } : {}),
    ...(heroDeck !== undefined ? { heroDeck } : {}),
    ...(opponents !== undefined ? { opponents } : {}),
    ...(decks !== undefined ? { decks } : {}),
    ...(pilots !== undefined ? { pilots } : {}),
    ...(contestants !== undefined ? { contestants } : {}),
    ...(soakPilot !== undefined ? { soakPilot } : {}),
  };
}

// --- the jobs ---------------------------------------------------------------------

/** Games `[gameStart, gameEnd)` of the hero-vs-opponent[i] matchup. */
export interface MatchupSliceJob {
  readonly kind: 'matchup-slice';
  readonly jobId: number;
  readonly opponentIndex: number;
  /** The matchup's own base seed — stamped by the host (gauntlet derives it per opponent; match uses the run seed). */
  readonly matchupSeed: number;
  /** The FULL game count of the matchup the range slices into. */
  readonly gamesPerMatchup: number;
  readonly gameStart: number;
  readonly gameEnd: number;
}

/** Paired base-vs-variant games `[gameStart, gameEnd)` against opponent[i]. */
export interface PairedSliceJob {
  readonly kind: 'paired-slice';
  readonly jobId: number;
  readonly opponentIndex: number;
  readonly gamesPerMatchup: number;
  readonly gameStart: number;
  readonly gameEnd: number;
  readonly swapSeed: number;
  readonly out: string;
  readonly in: string;
  /** Stamped on every slice from the one run-level value — slices that disagreed
   * would average two different experiments into one verdict. */
  readonly scope: SwapScope;
}

/** Games `[gameStart, gameEnd)` of BOTH orientations of deck pair [pairIndex]. */
export interface PilotAbSliceJob {
  readonly kind: 'pilot-ab-slice';
  readonly jobId: number;
  readonly pairIndex: number;
  readonly gamesPerOrientation: number;
  readonly gameStart: number;
  readonly gameEnd: number;
  readonly baseSeed: number;
}

/** The soak's anchored half — sequential by nature (see `soak.ts`), one job. */
export interface SoakAnchoredJob {
  readonly kind: 'soak-anchored';
  readonly jobId: number;
  readonly baseSeed: number;
  readonly anchorAttempts: number;
  readonly settings: SoakSliceSettings;
}

/** Mixed soak games `[gameStart, gameEnd)`, at a known global game-index base. */
export interface SoakMixedSliceJob {
  readonly kind: 'soak-mixed-slice';
  readonly jobId: number;
  readonly baseSeed: number;
  readonly gameStart: number;
  readonly gameEnd: number;
  /** Global index of mixed game 0 = games the anchored half played. The leak/equivalence
   * sampling strides run over the GLOBAL index, so this must be exact. */
  readonly firstGameIndex: number;
  readonly settings: SoakSliceSettings;
}

export type ParallelJob =
  | MatchupSliceJob
  | PairedSliceJob
  | PilotAbSliceJob
  | SoakAnchoredJob
  | SoakMixedSliceJob;

// --- the results ------------------------------------------------------------------

export interface MatchupSliceResult {
  readonly kind: 'matchup-slice';
  readonly jobId: number;
  readonly opponentIndex: number;
  readonly gameStart: number;
  readonly gameEnd: number;
  readonly deckA: string;
  readonly deckB: string;
  readonly games: number;
  readonly winsA: number;
  readonly winsB: number;
  readonly draws: number;
  readonly gameSeeds: readonly number[];
}

export interface PairedSliceResult {
  readonly kind: 'paired-slice';
  readonly jobId: number;
  readonly opponentIndex: number;
  readonly gameStart: number;
  readonly gameEnd: number;
  readonly baseDeck: string;
  readonly variantDeck: string;
  readonly outName: string;
  readonly inName: string;
  readonly scope: SwapScope;
  readonly copiesSwapped: number;
  readonly paired: PairedTable;
  readonly nGames: number;
}

export interface PilotAbSliceResult {
  readonly kind: 'pilot-ab-slice';
  readonly jobId: number;
  readonly pairIndex: number;
  readonly gameStart: number;
  readonly gameEnd: number;
  readonly tallies: PilotAbSliceTallies;
}

export interface SoakPartResult {
  readonly kind: 'soak-part';
  readonly jobId: number;
  /** Canonical position of this part in the sequential game order:
   * the anchored half is 0; mixed slice at game g starts at 1 + g. */
  readonly order: number;
  readonly part: SoakPartial;
}

export type ParallelResult =
  | MatchupSliceResult
  | PairedSliceResult
  | PilotAbSliceResult
  | SoakPartResult;

// --- planning ----------------------------------------------------------------------

/** A half-open game range. */
export interface GameRange {
  readonly gameStart: number;
  readonly gameEnd: number;
}

/**
 * Cut `total` game indices into `parts` contiguous, near-equal ranges — the web
 * planner's split, restated here because the two layers must not import each
 * other (this one has no DOM, that one has no `node:worker_threads`).
 * Deterministic and exhaustive: ranges tile `[0, total)`, remainder spread over
 * the leading chunks, empty ranges never emitted.
 */
export function splitGameRange(total: number, parts: number): readonly GameRange[] {
  if (total <= 0) return [];
  const chunks = Math.min(Math.max(1, Math.floor(parts)), total);
  const base = Math.floor(total / chunks);
  const remainder = total % chunks;
  const ranges: GameRange[] = [];
  let cursor = 0;
  for (let i = 0; i < chunks; i++) {
    const size = base + (i < remainder ? 1 : 0);
    ranges.push({ gameStart: cursor, gameEnd: cursor + size });
    cursor += size;
  }
  return ranges;
}

/**
 * How many pieces each of `unitCount` units (matchups, deck pairs) of
 * `gamesPerUnit` games is cut into to keep `workerCount` workers fed: aim for
 * `SLICES_PER_WORKER` slices per worker, never below `MIN_GAMES_PER_SLICE`
 * games each. Same arithmetic as the web planner's `shardsPerGroup`.
 */
export function slicesPerUnit(unitCount: number, gamesPerUnit: number, workerCount: number): number {
  if (unitCount <= 0 || gamesPerUnit <= 0) return 1;
  const targetSlices = Math.max(1, workerCount * SLICES_PER_WORKER);
  const wanted = Math.ceil(targetSlices / unitCount);
  const affordable = Math.max(1, Math.floor(gamesPerUnit / MIN_GAMES_PER_SLICE));
  return Math.max(1, Math.min(wanted, affordable));
}

/**
 * The matchup plan for a gauntlet (or a single `match`, which is a one-opponent
 * gauntlet whose matchup seed is the run seed itself). Opponent-major, then
 * game range — the canonical order the merge reassembles.
 */
export function planMatchupSlices(
  opponentCount: number,
  gamesPerMatchup: number,
  workerCount: number,
  matchupSeedFor: (opponentIndex: number) => number,
): readonly MatchupSliceJob[] {
  const parts = slicesPerUnit(opponentCount, gamesPerMatchup, workerCount);
  const jobs: MatchupSliceJob[] = [];
  for (let opponentIndex = 0; opponentIndex < opponentCount; opponentIndex++) {
    const matchupSeed = matchupSeedFor(opponentIndex);
    for (const range of splitGameRange(gamesPerMatchup, parts)) {
      jobs.push({
        kind: 'matchup-slice',
        jobId: jobs.length,
        opponentIndex,
        matchupSeed,
        gamesPerMatchup,
        ...range,
      });
    }
  }
  return jobs;
}

/** The paired A/B plan — same cut as the matchup plan; the pair is the unit, so
 * base and variant of one game index always land in the same slice. */
export function planPairedSlices(
  opponentCount: number,
  gamesPerMatchup: number,
  workerCount: number,
  swapSeed: number,
  swap: { readonly out: string; readonly in: string; readonly scope: SwapScope },
): readonly PairedSliceJob[] {
  const parts = slicesPerUnit(opponentCount, gamesPerMatchup, workerCount);
  const jobs: PairedSliceJob[] = [];
  for (let opponentIndex = 0; opponentIndex < opponentCount; opponentIndex++) {
    for (const range of splitGameRange(gamesPerMatchup, parts)) {
      jobs.push({
        kind: 'paired-slice',
        jobId: jobs.length,
        opponentIndex,
        gamesPerMatchup,
        swapSeed,
        out: swap.out,
        in: swap.in,
        scope: swap.scope,
        ...range,
      });
    }
  }
  return jobs;
}

/**
 * The finest useful cut of a run: `unitCount` independent units, each sliceable
 * down to `MIN_GAMES_PER_SLICE`-game pieces. The worker-count policies cap on
 * this so a pool is never larger than the plan can feed.
 */
export function maxUsefulSlices(unitCount: number, gamesPerUnit: number): number {
  return (
    Math.max(1, unitCount) *
    Math.max(1, Math.floor(Math.max(0, gamesPerUnit) / MIN_GAMES_PER_SLICE))
  );
}

/** The soak plan: the mixed half cut into contiguous ranges (the anchored half
 * is sequential by nature and runs on the host — see `runSoakAnchored`). */
export function planSoakMixedSlices(
  mixedGames: number,
  firstGameIndex: number,
  workerCount: number,
  baseSeed: number,
  settings: SoakSliceSettings,
): readonly SoakMixedSliceJob[] {
  const parts = slicesPerUnit(1, mixedGames, workerCount);
  return splitGameRange(mixedGames, parts).map((range, jobId) => ({
    kind: 'soak-mixed-slice',
    jobId,
    baseSeed,
    gameStart: range.gameStart,
    gameEnd: range.gameEnd,
    firstGameIndex,
    settings,
  }));
}

/** The pilot-ab plan: pair-major, then game range within the pair. */
export function planPilotAbSlices(
  pairCount: number,
  gamesPerOrientation: number,
  workerCount: number,
  baseSeed: number,
): readonly PilotAbSliceJob[] {
  const parts = slicesPerUnit(pairCount, gamesPerOrientation, workerCount);
  const jobs: PilotAbSliceJob[] = [];
  for (let pairIndex = 0; pairIndex < pairCount; pairIndex++) {
    for (const range of splitGameRange(gamesPerOrientation, parts)) {
      jobs.push({
        kind: 'pilot-ab-slice',
        jobId: jobs.length,
        pairIndex,
        gamesPerOrientation,
        baseSeed,
        ...range,
      });
    }
  }
  return jobs;
}

// --- executing one job (pure given a context; the worker AND the tests call this) --

/** Ticked with games played so far, so the host can print progress. */
export type OnGamesPlayed = (games: number) => void;

export function executeParallelJob(
  context: ParallelSimContext,
  job: ParallelJob,
  onGame?: OnGamesPlayed,
): ParallelResult {
  switch (job.kind) {
    case 'matchup-slice':
      return runMatchupSlice(context, job, onGame);
    case 'paired-slice':
      return runPairedSlice(context, job, onGame);
    case 'pilot-ab-slice':
      return runPilotAbSlice(context, job, onGame);
    case 'soak-anchored': {
      const options = soakOptionsFor(requireSoak(context), job.settings, job.baseSeed);
      const part = runSoakAnchored({ ...options, anchorAttempts: job.anchorAttempts }, onGame);
      return { kind: 'soak-part', jobId: job.jobId, order: 0, part };
    }
    case 'soak-mixed-slice': {
      const options = soakOptionsFor(requireSoak(context), job.settings, job.baseSeed);
      const part = runSoakMixedRange(options, job.firstGameIndex, job.gameStart, job.gameEnd, onGame);
      return { kind: 'soak-part', jobId: job.jobId, order: 1 + job.gameStart, part };
    }
  }
}

function requireSoak(context: ParallelSimContext): {
  readonly pool: CardPool;
  readonly registry: EffectRegistry;
  readonly pilot: Pilot;
} {
  if (!context.soakPilot) throw new Error('soak slice dispatched to a worker initialised without a pilot');
  return { pool: context.pool, registry: context.registry, pilot: context.soakPilot };
}

function runMatchupSlice(
  context: ParallelSimContext,
  job: MatchupSliceJob,
  onGame?: OnGamesPlayed,
): MatchupSliceResult {
  const hero = context.hero;
  const opponent = context.opponents?.[job.opponentIndex];
  const pilots = context.pilots;
  if (!hero || !opponent || !pilots) throw new Error('matchup slice dispatched to a worker initialised without decks/pilots');
  let ticked = 0;
  const slice = runMatchup(makeSeats(hero, opponent, pilots, context.registry), job.gamesPerMatchup, job.matchupSeed, {
    range: { gameStart: job.gameStart, gameEnd: job.gameEnd },
    ...(onGame ? { onGame: () => onGame(++ticked) } : {}),
  });
  return {
    kind: 'matchup-slice',
    jobId: job.jobId,
    opponentIndex: job.opponentIndex,
    gameStart: job.gameStart,
    gameEnd: job.gameEnd,
    deckA: slice.deckA,
    deckB: slice.deckB,
    games: slice.games,
    winsA: slice.winsA,
    winsB: slice.winsB,
    draws: slice.draws,
    gameSeeds: slice.gameSeeds,
  };
}

function runPairedSlice(
  context: ParallelSimContext,
  job: PairedSliceJob,
  onGame?: OnGamesPlayed,
): PairedSliceResult {
  const base = context.heroDeck;
  const opponents = context.opponents;
  const pilots = context.pilots;
  if (!base || !opponents || !pilots) throw new Error('paired slice dispatched to a worker initialised without decks/pilots');
  let ticked = 0;
  const evaluation = evaluateSwap(
    base,
    { out: job.out, in: job.in },
    opponents,
    pilots,
    job.gamesPerMatchup,
    job.swapSeed,
    context.pool,
    context.registry,
    {
      swapScope: job.scope,
      range: {
        opponentStart: job.opponentIndex,
        opponentEnd: job.opponentIndex + 1,
        gameStart: job.gameStart,
        gameEnd: job.gameEnd,
      },
      ...(onGame ? { onGame: (games: number) => onGame((ticked += games)) } : {}),
    },
  );
  return {
    kind: 'paired-slice',
    jobId: job.jobId,
    opponentIndex: job.opponentIndex,
    gameStart: job.gameStart,
    gameEnd: job.gameEnd,
    baseDeck: evaluation.baseDeck,
    variantDeck: evaluation.variantDeck,
    outName: evaluation.outName,
    inName: evaluation.inName,
    scope: evaluation.scope,
    copiesSwapped: evaluation.copiesSwapped,
    paired: evaluation.paired,
    nGames: evaluation.nGames,
  };
}

function runPilotAbSlice(
  context: ParallelSimContext,
  job: PilotAbSliceJob,
  onGame?: OnGamesPlayed,
): PilotAbSliceResult {
  const decks = context.decks;
  const contestants = context.contestants;
  if (!decks || !contestants) throw new Error('pilot-ab slice dispatched to a worker initialised without decks/contestants');
  const pairs = deckPairsOf(decks.length);
  const pair = pairs[job.pairIndex];
  if (!pair) throw new Error(`pilot-ab slice names pair ${job.pairIndex}, but the run has ${pairs.length}`);
  // Progress: two games per matched slot (one per orientation). runMatchup's
  // onGame is per game, but playPilotAbPairSlice owns those callbacks for the
  // tally, so the tick is derived from the slot count instead.
  const tallies = playPilotAbPairSlice({
    deckOne: decks[pair.first] as LoadedDeck,
    deckTwo: decks[pair.second] as LoadedDeck,
    pilots: contestants,
    registry: context.registry,
    pairSeed: gameSeedFor(job.baseSeed, job.pairIndex),
    gamesPerOrientation: job.gamesPerOrientation,
    gameStart: job.gameStart,
    gameEnd: job.gameEnd,
    runOpts: { sim: DEFAULT_SIM_CONFIG, stats: DEFAULT_STATS_CONFIG },
  });
  onGame?.((job.gameEnd - job.gameStart) * 2);
  return {
    kind: 'pilot-ab-slice',
    jobId: job.jobId,
    pairIndex: job.pairIndex,
    gameStart: job.gameStart,
    gameEnd: job.gameEnd,
    tallies,
  };
}

// --- merging -----------------------------------------------------------------------

/** Canonical order for matchup slices: opponent, then position in the matchup. */
function byMatchupPosition(a: MatchupSliceResult, b: MatchupSliceResult): number {
  if (a.opponentIndex !== b.opponentIndex) return a.opponentIndex - b.opponentIndex;
  return a.gameStart - b.gameStart;
}

/**
 * Fold matchup slices into per-opponent `MatchupResult`s plus the gauntlet
 * totals — the same numbers `runGauntlet` produces, reassembled from parts.
 */
export function mergeGauntletFromSlices(
  slices: readonly MatchupSliceResult[],
  stats: StatsConfig = DEFAULT_STATS_CONFIG,
): GauntletResult {
  const matchups = mergeMatchupsFromSlices(slices, stats);
  const first = matchups[0];
  if (!first) throw new Error('no gauntlet games were played.');
  let totalGames = 0;
  let totalWins = 0;
  let totalDraws = 0;
  for (const m of matchups) {
    totalGames += m.games;
    totalWins += m.winsA;
    totalDraws += m.draws;
  }
  return {
    hero: first.deckA,
    matchups,
    totalGames,
    totalWins,
    totalDraws,
    overallWinRate: wilsonInterval(totalWins, totalGames, stats.z),
  };
}

/** Fold matchup slices into one `MatchupResult` per opponent, in opponent order. */
export function mergeMatchupsFromSlices(
  slices: readonly MatchupSliceResult[],
  stats: StatsConfig = DEFAULT_STATS_CONFIG,
): readonly MatchupResult[] {
  const ordered = [...slices].sort(byMatchupPosition);
  const matchups: MatchupResult[] = [];
  let current: {
    opponentIndex: number;
    deckA: string;
    deckB: string;
    games: number;
    winsA: number;
    winsB: number;
    draws: number;
    gameSeeds: number[];
  } | null = null;
  const flush = () => {
    if (!current) return;
    matchups.push({
      deckA: current.deckA,
      deckB: current.deckB,
      games: current.games,
      winsA: current.winsA,
      winsB: current.winsB,
      draws: current.draws,
      winRateA: wilsonInterval(current.winsA, current.games, stats.z),
      gameSeeds: current.gameSeeds,
    });
  };
  for (const slice of ordered) {
    if (!current || current.opponentIndex !== slice.opponentIndex) {
      flush();
      current = {
        opponentIndex: slice.opponentIndex,
        deckA: slice.deckA,
        deckB: slice.deckB,
        games: 0,
        winsA: 0,
        winsB: 0,
        draws: 0,
        gameSeeds: [],
      };
    }
    current.games += slice.games;
    current.winsA += slice.winsA;
    current.winsB += slice.winsB;
    current.draws += slice.draws;
    current.gameSeeds.push(...slice.gameSeeds);
  }
  flush();
  return matchups;
}

/**
 * Fold paired slices into the one `SwapEvaluation` — the summed 2×2 table
 * handed to `summarizePairedSwap`, exactly as `evaluateSwap` hands its own.
 */
export function mergeSwapFromSlices(
  slices: readonly PairedSliceResult[],
  swap: { readonly out: string; readonly in: string },
  stats: StatsConfig = DEFAULT_STATS_CONFIG,
): SwapEvaluation {
  const head = [...slices].sort((a, b) =>
    a.opponentIndex !== b.opponentIndex ? a.opponentIndex - b.opponentIndex : a.gameStart - b.gameStart,
  )[0];
  if (!head) throw new Error('no paired games were played.');
  let bothWon = 0;
  let baseOnly = 0;
  let variantOnly = 0;
  let neither = 0;
  for (const slice of slices) {
    bothWon += slice.paired.bothWon;
    baseOnly += slice.paired.baseOnly;
    variantOnly += slice.paired.variantOnly;
    neither += slice.paired.neither;
  }
  return summarizePairedSwap({
    baseDeckName: head.baseDeck,
    variantDeckName: head.variantDeck,
    swap,
    outName: head.outName,
    inName: head.inName,
    paired: { bothWon, baseOnly, variantOnly, neither },
    stats,
    scope: head.scope,
    copiesSwapped: head.copiesSwapped,
  });
}

/**
 * Fold pilot-ab slices into the one `PilotAbResult`, through the SAME fold and
 * finisher `runPilotAb` uses — identity with the sequential path by
 * construction, and asserted by `parallel.test.ts`.
 */
export function mergePilotAbFromSlices(
  slices: readonly PilotAbSliceResult[],
  input: {
    readonly decks: readonly LoadedDeck[];
    readonly pilotAId: string;
    readonly pilotBId: string;
    readonly gamesPerOrientation: number;
    readonly stats?: StatsConfig;
  },
): PilotAbResult {
  const pairs = deckPairsOf(input.decks.length);
  const totals = emptyPilotAbTotals(input.decks.length);
  for (const slice of slices) {
    const pair = pairs[slice.pairIndex];
    if (!pair) throw new Error(`pilot-ab slice names pair ${slice.pairIndex}, but the run has ${pairs.length}`);
    foldSliceTallies(totals, pair as DeckPair, slice.tallies);
  }
  return finishPilotAb({
    decks: input.decks,
    pilotAId: input.pilotAId,
    pilotBId: input.pilotBId,
    pairsCount: pairs.length,
    gamesPerOrientation: input.gamesPerOrientation,
    stats: input.stats ?? DEFAULT_STATS_CONFIG,
    totals,
  });
}

/**
 * Fold soak parts into the one `SoakReport`, replaying the tallies in the
 * sequential game order (parts sorted by their canonical `order`), so even the
 * mechanics map's INSERTION order — which decides tie order in the printed
 * report — matches the single-threaded run.
 */
export function mergeSoakFromParts(
  parts: readonly SoakPartResult[],
  pool: CardPool,
  cpuMillis: number,
): SoakReport {
  const ordered = [...parts].sort((a, b) => a.order - b.order);
  return finishSoak(
    pool,
    ordered.map((p) => p.part),
    cpuMillis,
  );
}

/** Total games a slice plan will play — the progress denominator. */
export function totalGamesOf(jobs: readonly ParallelJob[]): number {
  let games = 0;
  for (const job of jobs) {
    switch (job.kind) {
      case 'matchup-slice':
        games += job.gameEnd - job.gameStart;
        break;
      case 'paired-slice':
        // Each paired index plays base AND variant.
        games += (job.gameEnd - job.gameStart) * 2;
        break;
      case 'pilot-ab-slice':
        // Both orientations.
        games += (job.gameEnd - job.gameStart) * 2;
        break;
      case 'soak-anchored':
        // Unknown until played (retries stop early); counted as it reports.
        break;
      case 'soak-mixed-slice':
        games += job.gameEnd - job.gameStart;
        break;
    }
  }
  return games;
}
