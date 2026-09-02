/**
 * THE SEARCH SCHEDULER — pure, sim-free decision-making for the suggestion engine.
 *
 * Everything in this module is a plain data transform: which candidates to try
 * first, how many games each wave grants, who survives a wave, and which untried
 * candidates a promising result should pull in next. No games are played here and
 * no RNG is touched, so every rule is unit-testable against fabricated numbers and
 * the whole search stays deterministic.
 *
 * ### Why waves
 * The old search gave all K candidates the same fixed budget. That spends as much
 * on an obvious loser as on a real contender, and — because the shortlist came from
 * a deterministic heuristic that ignores outcomes — re-running it re-tested the
 * exact same K and produced the exact same answer. Successive halving fixes the
 * first half: scout everything cheaply, then keep doubling the budget of whatever
 * still looks plausible. `prioritiseCandidates` fixes the second half by folding in
 * what previous runs already learned.
 */

import type { PairedTable } from './stats.js';
import { mcNemarTest, wilsonUpperBound } from './stats.js';
import type { StatsConfig } from './config.js';
import type { AdaptiveSearchConfig, ExplorationWeights } from './suggest-config.js';

// --- the wave plan --------------------------------------------------------------

/** One wave of the search: how wide it is, and how deep each survivor is played. */
export interface WaveSpec {
  /** 1-based wave number. */
  readonly wave: number;
  /** Paired games every candidate in this wave is played up to (cumulative). */
  readonly cumulativeGames: number;
  /** How many candidates survive INTO the next wave (the last wave keeps all). */
  readonly survivorTarget: number;
}

/**
 * Plan the ladder for a roster of `rosterSize` candidates and a full-depth budget
 * of `maxPairedGames`.
 *
 * The plan is built BACKWARDS from the final wave, because the one thing that must
 * not be compromised is the depth the winner is measured at: the last wave always
 * lands exactly on `maxPairedGames`, so the headline suggestion carries the same
 * statistical weight as the old fixed scheme gave it. Earlier waves divide by
 * `gamesGrowthFactor` as they widen. The ladder stops growing when the field is
 * down to `minSurvivors`, when `maxWaves` is reached, or when another rung would
 * fall below `minGamesPerWave` (a batch too small to produce discordant pairs is
 * not a measurement).
 *
 * Pure and total: any roster/budget yields at least one wave.
 */
export function planWaves(
  rosterSize: number,
  maxPairedGames: number,
  config: AdaptiveSearchConfig,
): readonly WaveSpec[] {
  const budget = Math.max(1, Math.floor(maxPairedGames));
  const roster = Math.max(1, Math.floor(rosterSize));

  // How many rungs can the field actually shrink over?
  const sizes: number[] = [roster];
  while (sizes.length < config.maxWaves) {
    const last = sizes[sizes.length - 1] as number;
    if (last <= config.minSurvivors) break;
    const next = Math.max(config.minSurvivors, Math.ceil(last * config.survivalFraction));
    if (next >= last) break; // a survival fraction of 1 would loop forever
    sizes.push(next);
  }

  // Drop rungs whose scout batch would be below the floor (walking down from the
  // widest wave, whose budget is the most divided).
  let waveCount = sizes.length;
  while (waveCount > 1 && budgetAt(1, waveCount, budget, config) < config.minGamesPerWave) {
    waveCount--;
  }

  const waves: WaveSpec[] = [];
  let previousBudget = 0;
  for (let w = 1; w <= waveCount; w++) {
    // Strictly increasing, so a wave always buys at least one new game per arm.
    const cumulativeGames = Math.max(previousBudget + 1, budgetAt(w, waveCount, budget, config));
    previousBudget = cumulativeGames;
    waves.push({
      wave: w,
      cumulativeGames: Math.min(cumulativeGames, budget),
      // The final wave eliminates nobody — everyone left is reported.
      survivorTarget: w === waveCount ? (sizes[w - 1] as number) : (sizes[w] as number),
    });
  }
  return waves;
}

/** The cumulative budget of wave `w` of `waveCount`, dividing back from full depth. */
function budgetAt(w: number, waveCount: number, budget: number, config: AdaptiveSearchConfig): number {
  if (w >= waveCount) return budget;
  return Math.round(budget / Math.pow(config.gamesGrowthFactor, waveCount - w));
}

// --- scoring + elimination ------------------------------------------------------

/** The minimum a scheduler needs to know about an arm to judge it. */
export interface ArmStanding {
  /** Stable candidate key — the final, deterministic tiebreak everywhere. */
  readonly key: string;
  readonly gamesPlayed: number;
  readonly paired: PairedTable;
  /** See `AdaptiveArmOutcome.variantWonBySlot` — the leader-vs-runner-up input. */
  readonly variantWonBySlot?: readonly boolean[];
}

/** Why an arm stopped receiving games. */
export type EliminationReason = 'futile' | 'outranked';

/** An arm dropped from the search, with the honest reason and its evidence. */
export interface EliminatedArm {
  readonly key: string;
  /** The wave after which it was dropped. */
  readonly wave: number;
  readonly reason: EliminationReason;
  /** Games it had received when it was dropped (what its verdict is based on). */
  readonly gamesPlayed: number;
  /** A one-line, human-readable justification for the report. */
  readonly detail: string;
}

/**
 * A candidate's observed paired advantage per game: (variant-only wins − base-only
 * wins) / games. This — not the raw win-rate — is the quantity the paired test is
 * actually about, and it is exactly `delta` up to rounding, computed without
 * building a full evaluation.
 */
export function pairedAdvantage(standing: ArmStanding): number {
  if (standing.gamesPlayed <= 0) return 0;
  return (standing.paired.variantOnly - standing.paired.baseOnly) / standing.gamesPlayed;
}

/**
 * Decide who survives a wave.
 *
 * Two rules, applied in order, and BOTH reported:
 *
 *  1. **Futility.** In a paired test only discordant games carry information: the
 *     variant is better exactly when it wins more than half of them. Once an arm
 *     has enough discordant pairs to say anything, we take the upper confidence
 *     bound on its discordant win-share — the most optimistic reading of its
 *     evidence — and if even that sits below break-even, more games cannot rescue
 *     it. It is dropped as a *proven* loser, not a merely unlucky one.
 *  2. **Outranked.** Whatever survives futility is ranked by observed paired
 *     advantage and cut to `survivorTarget`. This is the successive-halving step:
 *     it makes no claim that the dropped arms are bad, only that the remaining
 *     budget buys more information spent elsewhere — which is why the report says
 *     "outranked at N games" rather than "worse".
 *
 * Deterministic: ties are broken by McNemar p-value, then by candidate key.
 */
export function selectSurvivors(
  standings: readonly ArmStanding[],
  wave: number,
  survivorTarget: number,
  config: AdaptiveSearchConfig,
  stats: StatsConfig,
): { readonly survivors: readonly ArmStanding[]; readonly eliminated: readonly EliminatedArm[] } {
  const eliminated: EliminatedArm[] = [];
  const contenders: ArmStanding[] = [];

  for (const standing of standings) {
    const discordant = standing.paired.variantOnly + standing.paired.baseOnly;
    if (discordant >= config.minDiscordantForFutility) {
      const optimistic = wilsonUpperBound(standing.paired.variantOnly, discordant, stats.z);
      if (optimistic < config.futilityBreakEvenShare) {
        eliminated.push({
          key: standing.key,
          wave,
          reason: 'futile',
          gamesPlayed: standing.gamesPlayed,
          detail:
            `won ${standing.paired.variantOnly} of ${discordant} discordant games; even the ` +
            `optimistic bound (${(optimistic * 100).toFixed(1)}%) is below break-even ` +
            `(${(config.futilityBreakEvenShare * 100).toFixed(0)}%)`,
        });
        continue;
      }
    }
    contenders.push(standing);
  }

  /*
   * ⚠️ DO NOT ADD "stop candidates already decided against the base" HERE (§3.96).
   * It looks like a 27% saving — the two finalists of a real run reach p = 0 and
   * p = 5.5e-13 long before the final wave — but `suggest` produces a RANKED list,
   * and the final wave is what separates the leaders from each other (+10.1% vs
   * +6.8% in that run). Stopping on "decided vs the base" leaves the comparison
   * that actually matters exactly as uncertain, and makes the top recommendation
   * less reliable while the run gets faster. The two rules below already drop
   * every candidate whose extra games cannot change the ANSWER.
   *
   * ✅ RESOLVED IN §3.98: the correct rule — stop when the LEADER is decided
   * against the RUNNER-UP — now lives in `suggest-run.ts`, built on the per-slot
   * comparison §3.97 made free. 30.6% fewer games, same recommendation.
   */
  const ranked = [...contenders].sort(compareStandings);
  const keep = Math.max(0, Math.min(survivorTarget, ranked.length));
  for (const standing of ranked.slice(keep)) {
    eliminated.push({
      key: standing.key,
      wave,
      reason: 'outranked',
      gamesPlayed: standing.gamesPlayed,
      detail:
        `ranked below the top ${keep} after ${standing.gamesPlayed} games ` +
        `(paired advantage ${(pairedAdvantage(standing) * 100).toFixed(1)}%/game)`,
    });
  }
  return { survivors: ranked.slice(0, keep), eliminated };
}

/** Best-first: paired advantage, then stronger evidence, then the key. */
function compareStandings(a: ArmStanding, b: ArmStanding): number {
  const advA = pairedAdvantage(a);
  const advB = pairedAdvantage(b);
  if (advA !== advB) return advB - advA;
  const pA = mcNemarTest(a.paired).pValue;
  const pB = mcNemarTest(b.paired).pValue;
  if (pA !== pB) return pA - pB;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

// --- exploitation: which untried candidate looks like the current leader ---------

/** The traits of a candidate's `in` card that "related" is measured against. */
export interface CandidateTraits {
  /** Sorted colour-pip key of the added card, e.g. "R" or "GU" ("" = colourless). */
  readonly colorKey: string;
  /** Mana value of the added card (its curve slot). */
  readonly manaValue: number;
  /** The added card's primary type — its role (creature, instant, land…). */
  readonly role: string;
}

/** The shape `selectOffspring`/`prioritiseCandidates` need from a candidate. */
export interface SchedulableCandidate {
  readonly key: string;
  readonly outId: string;
  readonly inId: string;
  readonly heuristicScore: number;
  readonly traits: CandidateTraits;
}

/**
 * How much `candidate` resembles `leader` — the deliberately transparent version of
 * "leverage into promising directions". A card that scored well makes its
 * neighbours interesting: the same add tried against a different cut, the same cut
 * paired with a different add, and cards of the same colour, curve slot and role.
 *
 * Every term is a named weight and the total is a plain sum, so a report can say
 * *why* a candidate was promoted instead of pointing at a black box.
 */
export function relatedness(
  candidate: SchedulableCandidate,
  leader: SchedulableCandidate,
  weights: ExplorationWeights,
): number {
  if (candidate.key === leader.key) return 0;
  let score = 0;
  if (candidate.inId === leader.inId) score += weights.sameInCard;
  if (candidate.outId === leader.outId) score += weights.sameOutCard;
  if (candidate.traits.colorKey === leader.traits.colorKey) score += weights.sameColorIdentity;
  if (candidate.traits.manaValue === leader.traits.manaValue) score += weights.sameCurveSlot;
  if (candidate.traits.role === leader.traits.role) score += weights.sameRole;
  return score;
}

/**
 * Pick up to `count` untried candidates most related to the current leaders — the
 * "offspring" of a wave. Leaders are weighted by their position (the wave's best
 * result pulls hardest), and a candidate must actually resemble something
 * (`relatedness > 0`) to be pulled in at all.
 */
export function selectOffspring<T extends SchedulableCandidate>(
  leaders: readonly SchedulableCandidate[],
  untried: readonly T[],
  count: number,
  weights: ExplorationWeights,
): readonly T[] {
  if (count <= 0 || leaders.length === 0) return [];
  const scored = untried
    .map((candidate) => {
      let score = 0;
      for (let i = 0; i < leaders.length; i++) {
        // Rank-decayed: the wave's winner defines the direction most strongly.
        score += relatedness(candidate, leaders[i] as SchedulableCandidate, weights) / (i + 1);
      }
      return { candidate, score };
    })
    .filter((entry) => entry.score > 0);

  scored.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    return a.candidate.key < b.candidate.key ? -1 : a.candidate.key > b.candidate.key ? 1 : 0;
  });
  return scored.slice(0, count).map((entry) => entry.candidate);
}

// --- progressive exploration across runs -----------------------------------------

/** What a previous run knows about one candidate (see `suggest-history.ts`). */
export interface PriorEvidence {
  readonly gamesPlayed: number;
  readonly delta: number;
  readonly settled: boolean;
}

/** A candidate with its computed starting priority and the reason for it. */
export interface PrioritisedCandidate<T extends SchedulableCandidate = SchedulableCandidate> {
  readonly candidate: T;
  readonly priority: number;
  /** Which named rules contributed, best-first — printed in the report. */
  readonly reasons: readonly string[];
  /** True when a previous run has settled this candidate; it is not re-tested. */
  readonly settled: boolean;
}

/**
 * Order candidates for THIS run, given what previous runs already learned.
 *
 * This is the fix for the reported bug. The old pre-ranking was a pure function of
 * the decklist, so run two re-derived run one's shortlist to the letter and burned
 * the same compute to print the same answer. Priority now folds in history:
 *
 *  - a candidate a previous run **settled** (enough games, never promising) is
 *    excluded outright — it is reported as skipped, not silently dropped;
 *  - a candidate **nobody has tried** gets the largest bonus, so a re-run spends
 *    its budget on genuinely new ground;
 *  - a candidate that looked **promising but inconclusive** gets a smaller bonus,
 *    so the search refines it rather than abandoning it;
 *  - the cheap colour/curve prior only breaks ties between equals.
 *
 * With no history every candidate is untried, so run one is ordered by the prior
 * exactly as before — the change is strictly additive.
 */
export function prioritiseCandidates<T extends SchedulableCandidate>(
  candidates: readonly T[],
  priorByKey: ReadonlyMap<string, PriorEvidence>,
  weights: ExplorationWeights,
): readonly PrioritisedCandidate<T>[] {
  const scored = candidates.map((candidate) => {
    const prior = priorByKey.get(candidate.key);
    const reasons: string[] = [];
    let priority = candidate.heuristicScore * weights.heuristicPrior;

    if (!prior) {
      priority += weights.untried;
      reasons.push('never tried');
    } else if (prior.settled) {
      reasons.push(`settled after ${prior.gamesPlayed} games`);
      return { candidate, priority: Number.NEGATIVE_INFINITY, reasons, settled: true };
    } else if (prior.delta > weights.promisingDelta) {
      priority += weights.refinePromising;
      reasons.push(`promising in a previous run (${(prior.delta * 100).toFixed(1)}%)`);
    } else {
      reasons.push(`tried before (${prior.gamesPlayed} games)`);
    }

    return { candidate, priority, reasons, settled: false };
  });

  return [...scored].sort((a, b) => {
    if (a.priority !== b.priority) return b.priority - a.priority;
    return a.candidate.key < b.candidate.key ? -1 : a.candidate.key > b.candidate.key ? 1 : 0;
  });
}
