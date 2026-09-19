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
  wilsonInterval,
  type GauntletResult,
  type MatchupResult,
  type PairedTable,
  type SwapEvaluation,
} from '@jonny-boi/sim';
import type {
  GauntletShardResult,
  PairedShardResult,
  VariantSliceShardResult,
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
    // Every shard of a swap plays the same scope (the plan stamps it), so the
    // canonical-first shard speaks for all of them.
    scope: head.scope,
    copiesSwapped: head.copiesSwapped,
  };
}

/**
 * Fold a round's variant slices into each arm's CUMULATIVE paired table.
 *
 * Every cell is an integer count, and integer addition is exact and commutative,
 * so an arm's table cannot depend on how its slots were split across workers or
 * on which slice came home first. That is the entire reason a slice reports its
 * own 2×2 table rather than a win-rate: a proportion would have to be re-weighted,
 * and re-weighting floats is order-dependent.
 *
 * `previous` holds what earlier rounds already measured for each arm (successive
 * halving keeps playing the SAME arms deeper), so the result is the arm's whole
 * history, which is exactly what the elimination rule is entitled to see.
 */
export function mergeVariantSlices(
  previous: ReadonlyMap<string, PairedTable>,
  // Structural on purpose (§3.175): a manabase variant slice carries the same
  // key and table, and folds through the same integer addition.
  slices: readonly Pick<VariantSliceShardResult, 'candidateKey' | 'paired'>[],
): Map<string, PairedTable> {
  const totals = new Map<string, PairedTable>(previous);
  for (const slice of slices) {
    const running = totals.get(slice.candidateKey) ?? {
      bothWon: 0,
      baseOnly: 0,
      variantOnly: 0,
      neither: 0,
    };
    totals.set(slice.candidateKey, {
      bothWon: running.bothWon + slice.paired.bothWon,
      baseOnly: running.baseOnly + slice.paired.baseOnly,
      variantOnly: running.variantOnly + slice.paired.variantOnly,
      neither: running.neither + slice.paired.neither,
    });
  }
  return totals;
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
