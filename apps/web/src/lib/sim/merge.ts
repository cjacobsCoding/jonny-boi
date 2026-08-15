/**
 * **Merging shard results back into a run result** (pure).
 *
 * This is where determinism is enforced. Shards come home in whatever order
 * twelve workers happen to finish them, so before anything is aggregated the
 * results are re-sorted into the run's CANONICAL order — opponent index, then
 * game start, then candidate index. Only then are the tallies summed and the
 * statistics computed.
 *
 * Two properties make the output independent of core count and arrival order:
 *
 *   - Everything aggregated is an INTEGER COUNT (wins, draws, the paired 2x2
 *     cells). Integer addition is exact and commutative, so no floating-point
 *     result depends on the order shards were added. Every probability, interval,
 *     p-value and verdict is computed ONCE at the end, from those totals, by the
 *     sim's own `wilsonInterval` / `mcNemarTest` / `decideVerdict`.
 *   - Everything ORDERED (per-matchup rows, per-game seeds, the candidate list
 *     handed to `rankEvaluations`) is sorted by its canonical index first, so a
 *     stable sort's tie-breaking can't leak completion order into the ranking.
 */
import {
  DEFAULT_STATS_CONFIG,
  decideVerdict,
  gameSeedFor,
  mcNemarTest,
  rankEvaluations,
  wilsonInterval,
  FIDELITY_CAVEAT,
  type GauntletResult,
  type MatchupResult,
  type PairedTable,
  type RankedSwap,
  type SuggestionReport,
  type SwapEvaluation,
} from '@jonny-boi/sim';
import type {
  GauntletShardResult,
  PairedShardResult,
  PlannedCandidate,
  SkippedCandidateInfo,
} from './shard-protocol.js';

/** Canonical order for gauntlet shards: opponent, then position in the matchup. */
function byGauntletPosition(a: GauntletShardResult, b: GauntletShardResult): number {
  if (a.opponentIndex !== b.opponentIndex) return a.opponentIndex - b.opponentIndex;
  return a.gameStart - b.gameStart;
}

/** Canonical order for paired shards: candidate, then opponent, then position. */
function byPairedPosition(a: PairedShardResult, b: PairedShardResult): number {
  const candidateA = a.candidateIndex ?? 0;
  const candidateB = b.candidateIndex ?? 0;
  if (candidateA !== candidateB) return candidateA - candidateB;
  if (a.opponentIndex !== b.opponentIndex) return a.opponentIndex - b.opponentIndex;
  return a.gameStart - b.gameStart;
}

/**
 * Fold gauntlet shards into the run's `GauntletResult`.
 *
 * `heroName` and the opponent order come from the shards themselves, so a run
 * whose opponents were resolved on the main thread and played in workers can
 * never disagree about which row is which.
 */
export function mergeGauntlet(shards: readonly GauntletShardResult[]): GauntletResult {
  const ordered = [...shards].sort(byGauntletPosition);
  const first = ordered[0];
  if (!first) throw new Error('no gauntlet games were played.');

  const byOpponent = new Map<number, GauntletShardResult[]>();
  for (const shard of ordered) {
    const bucket = byOpponent.get(shard.opponentIndex);
    if (bucket) bucket.push(shard);
    else byOpponent.set(shard.opponentIndex, [shard]);
  }

  const matchups: MatchupResult[] = [];
  let totalGames = 0;
  let totalWins = 0;
  let totalDraws = 0;

  for (const opponentIndex of [...byOpponent.keys()].sort((a, b) => a - b)) {
    const parts = byOpponent.get(opponentIndex) as GauntletShardResult[];
    let games = 0;
    let winsA = 0;
    let winsB = 0;
    let draws = 0;
    const gameSeeds: number[] = [];
    for (const part of parts) {
      games += part.games;
      winsA += part.winsA;
      winsB += part.winsB;
      draws += part.draws;
      gameSeeds.push(...part.gameSeeds);
    }
    const head = parts[0] as GauntletShardResult;
    matchups.push({
      deckA: head.heroName,
      deckB: head.opponentName,
      games,
      winsA,
      winsB,
      draws,
      winRateA: wilsonInterval(winsA, games, DEFAULT_STATS_CONFIG.z),
      gameSeeds,
    });
    totalGames += games;
    totalWins += winsA;
    totalDraws += draws;
  }

  return {
    hero: first.heroName,
    matchups,
    totalGames,
    totalWins,
    totalDraws,
    overallWinRate: wilsonInterval(totalWins, totalGames, DEFAULT_STATS_CONFIG.z),
  };
}

/**
 * Fold the paired shards of ONE swap into a `SwapEvaluation` — the same verdict
 * `evaluateSwap` produces, assembled from parts.
 */
export function mergePairedEvaluation(shards: readonly PairedShardResult[]): SwapEvaluation {
  const ordered = [...shards].sort(byPairedPosition);
  const head = ordered[0];
  if (!head) throw new Error('no paired games were played.');

  let baseWins = 0;
  let variantWins = 0;
  let bothWon = 0;
  let baseOnly = 0;
  let variantOnly = 0;
  let neither = 0;
  let n = 0;
  for (const shard of ordered) {
    baseWins += shard.baseWins;
    variantWins += shard.variantWins;
    bothWon += shard.bothWon;
    baseOnly += shard.baseOnly;
    variantOnly += shard.variantOnly;
    neither += shard.neither;
    n += shard.n;
  }

  const paired: PairedTable = { bothWon, baseOnly, variantOnly, neither };
  const mcNemar = mcNemarTest(paired);
  const baseWinRate = wilsonInterval(baseWins, n, DEFAULT_STATS_CONFIG.z);
  const variantWinRate = wilsonInterval(variantWins, n, DEFAULT_STATS_CONFIG.z);
  const delta = variantWinRate.p - baseWinRate.p;

  return {
    baseDeck: head.baseDeckName,
    variantDeck: head.variantDeckName,
    swap: { out: head.outCardId, in: head.inCardId },
    outName: head.outName,
    inName: head.inName,
    baseWinRate,
    variantWinRate,
    delta,
    ci: variantWinRate,
    pValue: mcNemar.pValue,
    paired,
    mcNemar,
    verdict: decideVerdict(
      delta,
      mcNemar.pValue,
      n,
      DEFAULT_STATS_CONFIG.alpha,
      DEFAULT_STATS_CONFIG.minGamesForVerdict,
    ),
    nGames: n,
  };
}

/** What the suggestions merge needs beyond the shards themselves. */
export interface SuggestMergeInput {
  readonly baseDeckName: string;
  readonly candidates: readonly PlannedCandidate[];
  readonly shards: readonly PairedShardResult[];
  /** Candidates never simulated (illegal at generation, or over the budget cap). */
  readonly skipped: readonly SkippedCandidateInfo[];
  readonly candidatesGenerated: number;
  readonly cappedByBudget: boolean;
  readonly elapsedSeconds: number;
}

/**
 * Fold every candidate's paired shards into the ranked `SuggestionReport`.
 *
 * Candidates are rebuilt in CANONICAL index order before `rankEvaluations` sees
 * them. That matters because the ranking comparator is stable: two candidates
 * with an identical delta, p-value and swap key would otherwise be ordered by
 * whichever worker happened to finish first, and the "same seed ⇒ same ranking"
 * promise would hold only by luck.
 */
export function mergeSuggestions(input: SuggestMergeInput): SuggestionReport {
  const byCandidate = new Map<number, PairedShardResult[]>();
  for (const shard of input.shards) {
    if (shard.candidateIndex === null) continue;
    const bucket = byCandidate.get(shard.candidateIndex);
    if (bucket) bucket.push(shard);
    else byCandidate.set(shard.candidateIndex, [shard]);
  }

  const evaluations: SwapEvaluation[] = [];
  let totalGamesRun = 0;
  let baseGauntletWinRate: SwapEvaluation['baseWinRate'] | undefined;

  for (let index = 0; index < input.candidates.length; index++) {
    const parts = byCandidate.get(index);
    if (!parts || parts.length === 0) continue; // dropped (see `skipped`).
    const evaluation = mergePairedEvaluation(parts);
    evaluations.push(evaluation);
    // Each paired game plays BOTH the base and the variant → 2 games per pair.
    const GAMES_PER_PAIR = 2;
    totalGamesRun += evaluation.nGames * GAMES_PER_PAIR;
    // The base deck's gauntlet win-rate is the same for every candidate; take the
    // first in canonical order so it can't depend on who finished first.
    baseGauntletWinRate ??= evaluation.baseWinRate;
  }

  const ranked = rankEvaluations(evaluations);
  const suggestions: RankedSwap[] = ranked.map((evaluation, i) => ({
    rank: i + 1,
    outName: evaluation.outName,
    inName: evaluation.inName,
    evaluation,
  }));

  return {
    baseDeck: input.baseDeckName,
    baseGauntletWinRate: baseGauntletWinRate ?? { p: 0, low: 0, high: 0, successes: 0, n: 0 },
    candidatesEvaluated: evaluations.length,
    suggestions,
    skipped: input.skipped.map((s) => ({
      outName: s.outName,
      inName: s.inName,
      reason: s.reason,
      details: [...s.details],
    })),
    notes: {
      totalGamesRun,
      elapsedSeconds: input.elapsedSeconds > 0 ? input.elapsedSeconds : undefined,
      gamesPerSecond:
        input.elapsedSeconds > 0 ? totalGamesRun / input.elapsedSeconds : undefined,
      candidatesGenerated: input.candidatesGenerated,
      cappedByBudget: input.cappedByBudget,
      fidelityCaveat: FIDELITY_CAVEAT,
    },
  };
}

/**
 * The per-game seeds a matchup will use, derived from the run seed and the
 * opponent index alone. Exposed so callers can reconstruct or verify a matchup's
 * seeds without having played it.
 */
export function matchupGameSeeds(
  runSeed: number,
  opponentIndex: number,
  games: number,
): readonly number[] {
  const matchupSeed = gameSeedFor(runSeed, opponentIndex);
  const seeds: number[] = [];
  for (let g = 0; g < games; g++) seeds.push(gameSeedFor(matchupSeed, g));
  return seeds;
}
