/**
 * THE ADAPTIVE SEARCH, SEPARATED FROM WHOEVER PLAYS THE GAMES.
 *
 * Successive halving is **stateful across candidates**: which arms survive wave
 * N+1 depends on what wave N measured. So it cannot be expressed as "here is a
 * flat list of games, go play them" — the only shape that works is *round, wait,
 * decide, round again*. This module is that loop, and nothing else: it plans the
 * waves, says which arms need which slots next, reads the results back, applies
 * the futility + rank cut, pulls in offspring, and writes the wave report.
 *
 * It is a **generator**, and that is the whole trick. A generator can be driven
 * synchronously (the headless engine, which plays each round inline with
 * `createPairedArmRunner`) or asynchronously (the web Lab, which fans each round
 * out over a worker pool and resumes when the last shard lands) from ONE
 * implementation. The elimination rule therefore has exactly one home, and a
 * pooled run cannot quietly disagree with the CLI about who survived.
 *
 * What a driver owes the generator, per round:
 *   1. the SHARED base games for slots `[baseSlotStart, baseSlotEnd)` must exist
 *      before any variant game in the round is played (base-arm reuse: one base
 *      game per slot for the whole run, never one per candidate);
 *   2. every requested arm played from `fromGames` to `toGames` slots;
 *   3. each arm's CUMULATIVE 2×2 table handed back.
 *
 * Everything a driver may decide is scheduling: which core plays which slot, and
 * in what order. Everything it may not decide — who survives, what a verdict is,
 * how the list ranks — stays here and in `suggest-report.ts`.
 */

import type { CardPool } from '@jonny-boi/cards';
import type { Deck } from './deck.js';
import { DEFAULT_DECK_RULES, DEFAULT_SWAP_SCOPE, type DeckRules, type StatsConfig, type SwapScope } from './config.js';
import { DEFAULT_STATS_CONFIG } from './config.js';
import { gameSeedFor } from './matchup.js';
import { GAMES_PER_PAIRED_GAME } from './swap.js';
import type { PairedTable } from './stats.js';
import type { SkippedCandidate, SwapCandidate } from './suggest-candidates.js';
import { generateCandidates } from './suggest-candidates.js';
import {
  DEFAULT_ADAPTIVE_CONFIG,
  DEFAULT_EXPLORATION_WEIGHTS,
  DEFAULT_HEURISTIC_WEIGHTS,
  DEFAULT_SUGGEST_CONFIG,
  type AdaptiveSearchConfig,
  type ExplorationWeights,
  type HeuristicWeights,
  type SuggestConfig,
} from './suggest-config.js';
import type { ArmStanding, WaveSpec } from './suggest-schedule.js';
import { planWaves, prioritiseCandidates, selectOffspring, selectSurvivors } from './suggest-schedule.js';
import type { HistoryRejection, SuggestionHistory } from './suggest-history.js';
import { acceptHistory, deckFingerprint, priorEvidenceFrom } from './suggest-history.js';
import { pairedBetweenArms } from './paired-arms.js';
import { mcNemarTest } from './stats.js';
import { planSequentialLooks, SUPPORTED_LOOK_COUNTS } from './sequential.js';
import type { EliminatedSwap, EliminationNote, WaveReport } from './suggest-report.js';

export interface SettledArm {
  /** The arm's own 2×2 against the BASE deck. */
  readonly paired: PairedTable;
  readonly gamesPlayed: number;
  /** Which slots it won — see `pairedBetweenArms` (§3.97). */
  readonly variantWonBySlot?: readonly boolean[];
}

/**
 * MAY THE LADDER STOP? — the whole of the §3.98 rule, in one testable place.
 *
 * `suggest` answers TWO questions at once, and an early stop has to preserve both:
 *
 *   1. **Which of these is best?** Settled when the LEADER is decided against the
 *      RUNNER-UP. Each arm is paired against the base, so this comparison does not
 *      exist in their 2×2 tables — it comes from the per-slot records (§3.97),
 *      which line up because every arm plays the same slots from the same seeds.
 *   2. **Is it actually better than doing nothing?** Settled when the leader's own
 *      verdict against the base is already in.
 *
 * ⚠️ THE SECOND CONDITION IS HERE BECAUSE ITS ABSENCE SHIPPED A DEFECT. The first
 * version stopped on (1) alone, reasoning that no further wave could change WHICH
 * swap is recommended. True, and incomplete: a measured run stopped at 400 games
 * with its top pick at adjusted p 0.11 — INCONCLUSIVE — where the full ladder
 * reached 800 games and p 6.2e-3 — BETTER. Same recommendation, no longer proven.
 * Every test then in place compared only the pick's IDENTITY and passed.
 *
 * ⚠️ THE BAR FOR (2) IS `alpha / familySize`, NOT `alpha`. The printed verdict
 * faces a Holm correction over the whole roster, and Holm judges the smallest
 * p-value against `alpha / m`. Testing against a looser bar here would let the
 * ladder stop on a verdict the report then declines to print.
 *
 * The waves are the LOOKS for (1), so its bar is the Pocock constant for the wave
 * count — the same discipline `swap` uses, for the same reason (§3.92).
 */
export function leaderIsSettled(
  leader: SettledArm,
  runnerUp: SettledArm,
  context: {
    /** Candidates the verdict will be corrected across. */
    readonly familySize: number;
    /** Per-look significance for the leader-vs-runner-up test. */
    readonly perLookAlpha: number;
    /** The run's overall significance level. */
    readonly alpha: number;
  },
): boolean {
  // Without per-slot records the two arms cannot be compared at all, so the
  // ladder simply runs its full course — the safe direction.
  if (!leader.variantWonBySlot || !runnerUp.variantWonBySlot) return false;

  const leaderProven = mcNemarTest(leader.paired).pValue < context.alpha / Math.max(1, context.familySize);
  if (!leaderProven) return false;

  const between = pairedBetweenArms(
    { variantWonBySlot: leader.variantWonBySlot, gamesPlayed: leader.gamesPlayed },
    { variantWonBySlot: runnerUp.variantWonBySlot, gamesPlayed: runnerUp.gamesPlayed },
  );
  return mcNemarTest(between).pValue < context.perLookAlpha;
}

function boundedLooks(waveCount: number): number {
  const supported = [...SUPPORTED_LOOK_COUNTS].sort((a, b) => a - b);
  return supported.find((n) => n >= waveCount) ?? (supported[supported.length - 1] as number);
}

// --- phase 1: prepare -----------------------------------------------------------

/**
 * Everything decided BEFORE a single game is played: which candidates exist, which
 * ones this run will scout, what previous runs already settled, the seed this run
 * plays on, and the wave ladder.
 *
 * Deliberately plain JSON. The web Lab computes this inside a worker (the card
 * pool lives there) and then schedules from the main thread, so the plan has to
 * survive `postMessage` intact — no `Map`, no `Set`, no class instances.
 */
export interface SuggestionRunPlan {
  readonly baseDeckName: string;
  /** Content fingerprint of the deck, so a caller can key a stored record by it. */
  readonly deckFingerprint: string;
  /** Candidates this run will scout in wave 1, in priority order. */
  readonly roster: readonly SwapCandidate[];
  /** Untried candidates the roster cap left out; the offspring pool draws on them. */
  readonly reserves: readonly SwapCandidate[];
  /** Candidates never simulated (illegal at generation, or settled by a past run). */
  readonly skipped: readonly SkippedCandidate[];
  /** Candidates generated in total (evaluated + skipped) — the honest denominator. */
  readonly candidatesGenerated: number;
  /** The accepted record; empty when none was supplied or it was rejected. */
  readonly history: SuggestionHistory;
  /** Set when a supplied record was rejected, with the reason. */
  readonly historyRejected?: HistoryRejection;
  /**
   * The seed this run's games are derived from. A re-run offsets it by the run
   * counter, so run two plays DIFFERENT games rather than re-deriving run one's.
   */
  readonly runSeed: number;
  /** Gauntlet size — one paired "slot" is one (opponent, game) pair. */
  readonly opponentCount: number;
  /** Paired slots a finalist reaches at full depth (`games × opponents`). */
  readonly maxPairedGames: number;
  /** The wave ladder for this roster and budget. */
  readonly waves: readonly WaveSpec[];
}

/** Inputs to `prepareSuggestionRun` — everything except the games themselves. */
export interface PrepareSuggestionRunOptions {
  readonly pool: CardPool;
  /** How many gauntlet opponents the run faces (decks are not needed to plan). */
  readonly opponentCount: number;
  readonly baseSeed: number;
  /** Games per matchup at FULL depth. Defaults to `DEFAULT_SUGGEST_CONFIG`. */
  readonly gamesPerCandidate?: number;
  readonly suggestConfig?: SuggestConfig;
  readonly heuristicWeights?: HeuristicWeights;
  readonly adaptiveConfig?: AdaptiveSearchConfig;
  readonly explorationWeights?: ExplorationWeights;
  readonly deckRules?: DeckRules;
  /** Must match the scope the evaluation will use (candidates record it). */
  readonly swapScope?: SwapScope;
  /** The record a previous run returned. Omit for a first run. */
  readonly history?: SuggestionHistory;
  /**
   * The pilot that will play this run's games. Supplying it is what lets
   * `acceptHistory` refuse a record gathered at a DIFFERENT level of play —
   * pooling those is statistically invalid, not just untidy (it corrupts the
   * Holm–Bonferroni family and resurrects/retires the wrong candidates). See
   * `SuggestionHistory.pilotId`. Omit only in pure planning tests.
   */
  readonly pilotId?: string;
  /** FOCUSED MODE — restrict which cards may be cut (names or ids). */
  readonly cutOnly?: readonly string[];
  /** FOCUSED MODE — restrict the `in` candidates to this shortlist. */
  readonly inOnly?: readonly string[];
}

/**
 * Generate, prioritise and bound the candidate set for one run.
 *
 * Priority is what fixes the reported bug ("it just tested Eternal Witness
 * again"): a candidate a previous run settled is excluded outright and reported,
 * untried candidates outrank ones a previous run already covered, and the cheap
 * colour/curve prior only breaks ties.
 */
export function prepareSuggestionRun(base: Deck, options: PrepareSuggestionRunOptions): SuggestionRunPlan {
  const config = options.suggestConfig ?? DEFAULT_SUGGEST_CONFIG;
  const weights = options.heuristicWeights ?? DEFAULT_HEURISTIC_WEIGHTS;
  const adaptiveConfig = options.adaptiveConfig ?? DEFAULT_ADAPTIVE_CONFIG;
  const exploration = options.explorationWeights ?? DEFAULT_EXPLORATION_WEIGHTS;
  const rules = options.deckRules ?? DEFAULT_DECK_RULES;
  const games = options.gamesPerCandidate ?? config.defaultGamesPerCandidate;

  const generated = generateCandidates(base, options.pool, config, weights, rules, {
    ...(options.cutOnly ? { cutOnly: options.cutOnly } : {}),
    ...(options.inOnly ? { inOnly: options.inOnly } : {}),
    swapScope: options.swapScope ?? DEFAULT_SWAP_SCOPE,
  });
  // Snapshot the generation total BEFORE evaluation can append its own failures.
  const candidatesGenerated = generated.candidates.length + generated.skipped.length;

  // What previous runs learned, if the caller kept it and it still applies.
  const accepted = acceptHistory(options.history, base, options.pilotId);
  const history = accepted.history;
  const priors = priorEvidenceFrom(history, exploration);

  const prioritised = prioritiseCandidates(generated.candidates, priors, exploration);
  const settled = prioritised.filter((p) => p.settled);
  const available = prioritised.filter((p) => !p.settled);
  const roster = available.slice(0, config.maxCandidates).map((p) => p.candidate);
  const reserves = available.slice(config.maxCandidates).map((p) => p.candidate);

  const skipped: SkippedCandidate[] = [
    ...generated.skipped,
    ...settled.map((p) => ({
      outName: p.candidate.outName,
      inName: p.candidate.inName,
      reason: 'settled' as const,
      details: p.reasons,
    })),
  ];

  // A distinct seed per run, so a re-run plays DIFFERENT games rather than
  // re-deriving the same numbers from the same shuffles.
  const runSeed =
    history.runsCompleted === 0 ? options.baseSeed : gameSeedFor(options.baseSeed, history.runsCompleted);
  const maxPairedGames = Math.max(0, games) * Math.max(0, options.opponentCount);

  return {
    baseDeckName: base.name,
    deckFingerprint: deckFingerprint(base),
    roster,
    reserves,
    skipped,
    candidatesGenerated,
    history,
    ...(accepted.rejected ? { historyRejected: accepted.rejected } : {}),
    runSeed,
    opponentCount: options.opponentCount,
    maxPairedGames,
    waves: planWaves(roster.length, maxPairedGames, adaptiveConfig),
  };
}

// --- phase 2: the round-by-round search ------------------------------------------

/** One arm's work in a round: play its slots `[fromGames, toGames)`. */
export interface AdaptiveArmRequest {
  readonly candidate: SwapCandidate;
  /** Slots this arm has already played (0 for a newcomer). */
  readonly fromGames: number;
  /** Slots it must have played by the end of this round. */
  readonly toGames: number;
}

/**
 * One round of the search — everything that can run in parallel, and nothing that
 * cannot. A driver must complete ALL of it before resuming the generator.
 */
export interface AdaptiveRound {
  readonly wave: number;
  /** Paired slots every arm in this round is played up to. */
  readonly cumulativeGames: number;
  /**
   * Shared base games this round needs that no earlier round did:
   * `[baseSlotStart, baseSlotEnd)`. Empty when the round adds no depth. These MUST
   * be played (once each) before the round's variant games, because the
   * identical-game skip reads them.
   */
  readonly baseSlotStart: number;
  readonly baseSlotEnd: number;
  /** The arms to advance. Empty only when the search has nothing left to play. */
  readonly arms: readonly AdaptiveArmRequest[];
}

/** What a driver reports back for one arm after a round. */
export interface AdaptiveArmOutcome {
  readonly key: string;
  /** Slots the arm has now played in total. */
  readonly gamesPlayed: number;
  /** Its CUMULATIVE 2×2 table over those slots. */
  readonly paired: PairedTable;
  /**
   * Which slots this arm won, so the ladder can compare candidates against EACH
   * OTHER and not only against the base (§3.97). Optional: an arm that failed to
   * play has none, and a caller that does not track them still schedules fine.
   */
  readonly variantWonBySlot?: readonly boolean[];
  /**
   * Set when the arm could not be played at all (an illegal variant that survived
   * generation, a shard that failed permanently). It leaves the search and is
   * reported as skipped — one bad candidate never costs a whole run.
   */
  readonly failure?: string;
}

/** A driver's answer to one round. */
export interface AdaptiveRoundResult {
  readonly arms: readonly AdaptiveArmOutcome[];
}

/** An arm the search finished with, and how deeply it was measured. */
export interface AdaptiveArmResult {
  readonly candidate: SwapCandidate;
  readonly gamesPlayed: number;
  readonly paired: PairedTable;
  readonly elimination?: EliminationNote;
}

/** What the whole adaptive search produced, before statistics are applied. */
export interface AdaptiveSearchOutcome {
  /** Arms that played at least one slot, in the order they entered the search. */
  readonly arms: readonly AdaptiveArmResult[];
  readonly waves: readonly WaveReport[];
  /** Arms that failed at evaluation time (recorded, never fatal). */
  readonly failures: readonly SkippedCandidate[];
  /**
   * Games a fixed-budget sweep would have played to reach the same per-candidate
   * depths: `2 × Σ gamesPlayed` (each paired game plays both arms).
   */
  readonly fixedSchemeGames: number;
  /** Base slots the search actually required (the base arm's depth). */
  readonly baseSlotsPlayed: number;
}

/** The elimination/exploration knobs the search runs on. */
export interface AdaptiveSearchSettings {
  readonly adaptiveConfig?: AdaptiveSearchConfig;
  readonly explorationWeights?: ExplorationWeights;
  readonly stats?: StatsConfig;
}

/** The driveable search: yields rounds, is fed results, returns the outcome. */
export type AdaptiveSearchDriver = Generator<AdaptiveRound, AdaptiveSearchOutcome, AdaptiveRoundResult>;

/**
 * THE ADAPTIVE SEARCH — successive halving over the roster, as a generator.
 *
 * Wave 1 scouts everyone cheaply. After each wave the futility rule retires
 * provably-not-better arms and the rank cut halves the field, the budget doubles,
 * and untried candidates resembling the leaders are pulled in. The last wave lands
 * on the full budget, so the headline suggestion is measured exactly as deeply as
 * the fixed scheme would have measured it — everything saved comes from NOT
 * measuring the hopeless ones that deeply.
 */
export function* driveAdaptiveSearch(
  plan: SuggestionRunPlan,
  settings: AdaptiveSearchSettings = {},
): AdaptiveSearchDriver {
  const adaptiveConfig = settings.adaptiveConfig ?? DEFAULT_ADAPTIVE_CONFIG;
  const exploration = settings.explorationWeights ?? DEFAULT_EXPLORATION_WEIGHTS;
  const stats = settings.stats ?? DEFAULT_STATS_CONFIG;

  const byKey = new Map<string, SwapCandidate>();
  for (const candidate of [...plan.roster, ...plan.reserves]) byKey.set(candidate.key, candidate);

  /** Arms that have entered the search, in entry order — the report's order. */
  const entered: string[] = [];
  const gamesByKey = new Map<string, number>();
  const pairedByKey = new Map<string, PairedTable>();
  /** Per-arm slot outcomes, for the leader-vs-runner-up test (§3.98). */
  const slotsByKey = new Map<string, readonly boolean[]>();
  const eliminations = new Map<string, EliminationNote>();
  const failures: SkippedCandidate[] = [];
  const failed = new Set<string>();

  const waves: WaveReport[] = [];
  const offspringPool: SwapCandidate[] = [...plan.reserves];
  let baseSlotsPlayed = 0;

  let current: readonly SwapCandidate[] = plan.roster;
  for (const spec of plan.waves) {
    const requests: AdaptiveArmRequest[] = [];
    for (const candidate of current) {
      if (failed.has(candidate.key)) continue;
      if (!gamesByKey.has(candidate.key)) {
        entered.push(candidate.key);
        gamesByKey.set(candidate.key, 0);
      }
      requests.push({
        candidate,
        fromGames: gamesByKey.get(candidate.key) as number,
        toGames: spec.cumulativeGames,
      });
    }

    if (requests.length > 0) {
      // The base arm is only ever played as deep as some candidate needed it, so
      // a search that stops early costs the base arm nothing extra.
      const baseSlotStart = baseSlotsPlayed;
      const baseSlotEnd = Math.max(baseSlotsPlayed, spec.cumulativeGames);
      const answer: AdaptiveRoundResult = yield {
        wave: spec.wave,
        cumulativeGames: spec.cumulativeGames,
        baseSlotStart,
        baseSlotEnd,
        arms: requests,
      };
      baseSlotsPlayed = baseSlotEnd;

      for (const outcome of answer.arms) {
        if (outcome.failure !== undefined) {
          if (!failed.has(outcome.key)) {
            failed.add(outcome.key);
            const candidate = byKey.get(outcome.key);
            failures.push({
              outName: candidate?.outName ?? 'unknown',
              inName: candidate?.inName ?? 'unknown',
              reason: 'illegal',
              details: [outcome.failure],
            });
          }
          gamesByKey.delete(outcome.key);
          pairedByKey.delete(outcome.key);
          continue;
        }
        gamesByKey.set(outcome.key, outcome.gamesPlayed);
        pairedByKey.set(outcome.key, outcome.paired);
        if (outcome.variantWonBySlot) slotsByKey.set(outcome.key, outcome.variantWonBySlot);
      }
    }

    const standings: ArmStanding[] = [];
    for (const request of requests) {
      const key = request.candidate.key;
      if (failed.has(key)) continue;
      const slots = slotsByKey.get(key);
      standings.push({
        key,
        gamesPlayed: gamesByKey.get(key) ?? 0,
        paired: pairedByKey.get(key) ?? emptyTable(),
        ...(slots ? { variantWonBySlot: slots } : {}),
      });
    }

    const isFinalWave = spec.wave === plan.waves.length;
    if (isFinalWave || standings.length === 0) {
      waves.push({
        wave: spec.wave,
        cumulativeGames: spec.cumulativeGames,
        candidatesPlayed: standings.length,
        survivors: standings.length,
        eliminated: [],
        offspring: [],
      });
      break;
    }

    const cut = selectSurvivors(standings, spec.wave, spec.survivorTarget, adaptiveConfig, stats);

    /*
     * ⚠️ THE ONLY STOPPING RULE THAT DOES NOT COST THE RANKING (§3.98).
     *
     * §3.96 measured that the finalists are decided against the BASE long before
     * the last wave, and declined to stop on it: `suggest` outputs an ORDER, and
     * the last wave is what separates the leaders from EACH OTHER. §3.97 made
     * that comparison available for free — every arm plays the same slots from
     * the same seeds, so the leader and the runner-up can be cross-tabulated
     * directly. When THAT is decided, no further wave can change which candidate
     * is recommended, and the games it would have cost buy nothing.
     *
     * The waves are the looks, so the boundary is the Pocock one for the wave
     * count — the same discipline `swap` uses, for the same reason (§3.92).
     */
    if (adaptiveConfig.stopWhenLeaderSettled && cut.survivors.length >= 2) {
      const leader = cut.survivors[0] as ArmStanding;
      const runnerUp = cut.survivors[1] as ArmStanding;
      const looks = planSequentialLooks(plan.maxPairedGames, boundedLooks(plan.waves.length));
      const settled = leaderIsSettled(
        { paired: pairedByKey.get(leader.key) ?? emptyTable(), gamesPlayed: leader.gamesPlayed, ...(leader.variantWonBySlot ? { variantWonBySlot: leader.variantWonBySlot } : {}) },
        { paired: pairedByKey.get(runnerUp.key) ?? emptyTable(), gamesPlayed: runnerUp.gamesPlayed, ...(runnerUp.variantWonBySlot ? { variantWonBySlot: runnerUp.variantWonBySlot } : {}) },
        { familySize: plan.roster.length, perLookAlpha: looks.perLookAlpha, alpha: stats.alpha },
      );
      if (settled) {
        waves.push({
          wave: spec.wave,
          cumulativeGames: spec.cumulativeGames,
          candidatesPlayed: standings.length,
          survivors: cut.survivors.length,
          eliminated: [],
          offspring: [],
        });
        break;
      }
    }
    const eliminated: EliminatedSwap[] = cut.eliminated.map((e) => {
      const candidate = byKey.get(e.key) as SwapCandidate;
      const note: EliminationNote = { wave: e.wave, reason: e.reason, detail: e.detail };
      eliminations.set(e.key, note);
      return { ...note, outName: candidate.outName, inName: candidate.inName, gamesPlayed: e.gamesPlayed };
    });

    const leaders = cut.survivors.map((s) => byKey.get(s.key) as SwapCandidate);
    const nextBudget = plan.waves[spec.wave]?.cumulativeGames ?? plan.maxPairedGames;
    // A newcomer plays catch-up from zero, so it may only join while the next
    // wave's budget is still cheap.
    const offspringAllowed = nextBudget <= plan.maxPairedGames * adaptiveConfig.offspringMaxEntryBudgetFraction;
    const offspring = offspringAllowed
      ? selectOffspring(leaders, offspringPool, adaptiveConfig.offspringPerWave, exploration)
      : [];
    for (const child of offspring) {
      const index = offspringPool.findIndex((c) => c.key === child.key);
      if (index >= 0) offspringPool.splice(index, 1);
    }

    waves.push({
      wave: spec.wave,
      cumulativeGames: spec.cumulativeGames,
      candidatesPlayed: standings.length,
      survivors: leaders.length + offspring.length,
      eliminated,
      offspring: offspring.map((c) => `${c.outName} → ${c.inName}`),
    });
    current = [...leaders, ...(offspring as SwapCandidate[])];
  }

  const arms: AdaptiveArmResult[] = [];
  let fixedSchemeGames = 0;
  for (const key of entered) {
    const gamesPlayed = gamesByKey.get(key) ?? 0;
    if (gamesPlayed <= 0) continue;
    fixedSchemeGames += gamesPlayed * GAMES_PER_PAIRED_GAME;
    const elimination = eliminations.get(key);
    arms.push({
      candidate: byKey.get(key) as SwapCandidate,
      gamesPlayed,
      paired: pairedByKey.get(key) ?? emptyTable(),
      ...(elimination ? { elimination } : {}),
    });
  }

  return { arms, waves, failures, fixedSchemeGames, baseSlotsPlayed };
}

function emptyTable(): PairedTable {
  return { bothWon: 0, baseOnly: 0, variantOnly: 0, neither: 0 };
}
