/**
 * THE MANABASE SWEEP AS A RUN (DESIGN §3.175) — planning it, finishing it, and
 * the single-threaded driver that plays it inline.
 *
 * A sweep of manabase variants is a FAMILY of paired comparisons against one
 * base deck, which is exactly what the suggestion engine already schedules,
 * eliminates and corrects. So a manabase run is planned as a `SuggestionRunPlan`
 * (the variants adapted to the ladder's candidate shape — `manabaseCandidateOf`),
 * driven by `driveAdaptiveSearch`, and closed by `finishSuggestionRun`, whose
 * Holm-corrected, re-decided verdicts are then joined with the RELIABILITY
 * readings the game watch collected. Nothing statistical is re-implemented here;
 * this module adapts, joins and names.
 *
 * Two hosts drive the same plan: `runManabaseSweep` below plays every round on
 * one incremental `PairedArmRunner` (tests, a headless run), and the web Lab
 * fans each round out over its worker pool and calls `finishManabaseRun` with
 * what came back. Both end in the identical report.
 */

import type { EffectRegistry } from '@jonny-boi/core';
import type { CardPool } from '@jonny-boi/cards';
import type { Deck, LoadedDeck } from './deck.js';
import type { MatchupPilots, RunOptions } from './matchup.js';
import {
  DEFAULT_DECK_RULES,
  DEFAULT_STATS_CONFIG,
  DEFAULT_SWAP_SCOPE,
  type DeckRules,
  type StatsConfig,
} from './config.js';
import type { ProportionCI } from './stats.js';
import type { SwapEvaluation } from './swap.js';
import { summarizePairedSwap } from './swap.js';
import type { SkippedCandidate, SwapCandidate } from './suggest-candidates.js';
import {
  DEFAULT_ADAPTIVE_CONFIG,
  DEFAULT_EXPLORATION_WEIGHTS,
  DEFAULT_SUGGEST_CONFIG,
  type AdaptiveSearchConfig,
} from './suggest-config.js';
import { planWaves } from './suggest-schedule.js';
import { deckFingerprint, emptyHistory } from './suggest-history.js';
import type { AdaptiveArmOutcome, SuggestionRunPlan } from './suggest-run.js';
import { driveAdaptiveSearch } from './suggest-run.js';
import type {
  EliminationNote,
  MultipleComparisonsReport,
  SuggestionNotes,
  SuggestionSearchResult,
  WaveReport,
} from './suggest-report.js';
import { finishSuggestionRun } from './suggest-report.js';
import type { ArmHandle, PairedGameObservation, SwapArm } from './paired-arms.js';
import { createPairedArmRunner } from './paired-arms.js';
import {
  applyManabase,
  generateManabaseVariants,
  manabaseCandidateOf,
  variantForCandidateKey,
  type ManabaseSummary,
  type ManabaseSweepOptions,
  type ManabaseVariant,
  type SkippedVariant,
} from './manabase.js';
import {
  compareReliability,
  createReliabilityWatch,
  summarizeReliability,
  type ReliabilityComparison,
  type ReliabilitySummary,
} from './manabase-reliability.js';
import { RELIABILITY_NOT_MEASURED } from './manabase-config.js';

/**
 * How many variants one run may test. The adaptive ladder is comfortable with
 * the suggestion engine's cap, and a larger family only dilutes the correction.
 */
export const MANABASE_MAX_VARIANTS = DEFAULT_SUGGEST_CONFIG.maxCandidates;

/**
 * THE RECOMMENDATION RULE, in the words the panel prints. Two axes, never one
 * blended score: a variant QUALIFIES when its win rate is better or inconclusive
 * and none of its reliability metrics is worse than the base; the RECOMMENDED
 * one is the highest-ranked qualifier that is measurably better on at least one
 * axis. When nothing is measurably better anywhere, nothing is recommended.
 */
export const MANABASE_RECOMMENDATION_RULE =
  'A variant qualifies when its win rate is BETTER or INCONCLUSIVE and none of its reliability ' +
  'metrics is WORSE than the base. The recommended manabase is the highest-ranked qualifier that is ' +
  'measurably better on at least one axis — win rate or a reliability metric. Win rate and reliability ' +
  'are never blended into one score.';

/** A `SuggestionRunPlan` for a manabase family, plus the family itself. */
export interface ManabaseRunPlan extends SuggestionRunPlan {
  readonly manabase: {
    readonly base: ManabaseSummary;
    /** The variants on the roster, in the order they were enumerated. */
    readonly variants: readonly ManabaseVariant[];
    /** Variants the sweeps could not build for this deck, with reasons. */
    readonly skipped: readonly SkippedVariant[];
    /** Variants past `MANABASE_MAX_VARIANTS`, never played. */
    readonly capped: readonly ManabaseVariant[];
  };
}

export interface PlanManabaseRunOptions {
  readonly pool: CardPool;
  readonly opponentCount: number;
  readonly baseSeed: number;
  /** Paired games per opponent a finalist reaches. Defaults to the suggest depth. */
  readonly gamesPerVariant?: number;
  readonly sweep?: ManabaseSweepOptions;
  readonly adaptiveConfig?: AdaptiveSearchConfig;
  readonly deckRules?: DeckRules;
  readonly maxVariants?: number;
}

/**
 * Enumerate the family and plan its ladder. Plain JSON, like every run plan, so
 * the web Lab can compute it in a worker and schedule from the main thread.
 */
export function planManabaseRun(base: Deck, options: PlanManabaseRunOptions): ManabaseRunPlan {
  const games = options.gamesPerVariant ?? DEFAULT_SUGGEST_CONFIG.defaultGamesPerCandidate;
  const adaptiveConfig = options.adaptiveConfig ?? DEFAULT_ADAPTIVE_CONFIG;
  const rules = options.deckRules ?? DEFAULT_DECK_RULES;
  const sweep = generateManabaseVariants(base, options.pool, { ...options.sweep, deckRules: rules });
  const cap = Math.max(1, Math.floor(options.maxVariants ?? MANABASE_MAX_VARIANTS));
  const variants = sweep.variants.slice(0, cap);
  const capped = sweep.variants.slice(cap);
  const roster: SwapCandidate[] = variants.map((variant) => manabaseCandidateOf(variant, sweep.base, base.name));
  const maxPairedGames = Math.max(0, games) * Math.max(0, options.opponentCount);
  return {
    baseDeckName: base.name,
    deckFingerprint: deckFingerprint(base),
    roster,
    // No offspring pool: a manabase family is closed by construction, and the
    // ladder's "more cards like the leader" rule has nothing to say about it.
    reserves: [],
    skipped: [],
    candidatesGenerated: sweep.variants.length,
    history: emptyHistory(base),
    runSeed: options.baseSeed,
    opponentCount: options.opponentCount,
    maxPairedGames,
    waves: planWaves(roster.length, maxPairedGames, adaptiveConfig),
    manabase: { base: sweep.base, variants, skipped: sweep.skipped, capped },
  };
}

/** One variant's row in the finished report. */
export interface ManabaseVariantResult {
  readonly rank: number;
  readonly variant: ManabaseVariant;
  /** The paired win-rate verdict; `verdict` is the Holm-corrected call. */
  readonly evaluation: SwapEvaluation;
  readonly gamesPlayed: number;
  readonly rawPValue: number;
  readonly adjustedPValue: number;
  readonly elimination?: EliminationNote;
  readonly reliability: ReliabilityComparison;
  /** Passes the qualifying half of `MANABASE_RECOMMENDATION_RULE`. */
  readonly qualifies: boolean;
  /** Measurably better on at least one axis (the other half of the rule). */
  readonly betterSomewhere: boolean;
}

/** The finished sweep. */
export interface ManabaseReport {
  readonly baseDeck: string;
  readonly base: ManabaseSummary;
  readonly baseGauntletWinRate: ProportionCI;
  /** The base deck's reliability over every base game the run played. */
  readonly baseReliability: ReliabilitySummary;
  /** Ranked: proven better, then inconclusive, then worse (the suggest order). */
  readonly results: readonly ManabaseVariantResult[];
  /** The variant the rule picks, or `null` with the rule saying why not. */
  readonly recommended: ManabaseVariantResult | null;
  readonly recommendationRule: string;
  readonly skipped: readonly SkippedVariant[];
  readonly capped: readonly ManabaseVariant[];
  /** Variants that failed while being played (recorded, never fatal). */
  readonly failures: readonly SkippedCandidate[];
  readonly waves: readonly WaveReport[];
  readonly multipleComparisons: MultipleComparisonsReport;
  readonly notes: SuggestionNotes;
  readonly notMeasured: typeof RELIABILITY_NOT_MEASURED;
}

export interface ManabaseRunInput {
  readonly plan: ManabaseRunPlan;
  readonly search: SuggestionSearchResult;
  /** The base game watch's report per slot, `[0, baseSlotsPlayed)`. */
  readonly baseObserved: readonly (PairedGameObservation | null | undefined)[];
  /** Each arm's per-slot reports, keyed by the ladder candidate key. */
  readonly variantObserved: ReadonlyMap<string, readonly (PairedGameObservation | null | undefined)[]>;
  readonly elapsedSeconds: number;
  readonly workersUsed?: number;
  readonly stats?: StatsConfig;
}

/**
 * Correct, rank and join. The win-rate half is `finishSuggestionRun` verbatim
 * (Holm over the family, verdicts re-decided from the corrected p); the
 * reliability half is `compareReliability` per arm over the slots it played.
 */
export function finishManabaseRun(input: ManabaseRunInput): ManabaseReport {
  const stats = input.stats ?? DEFAULT_STATS_CONFIG;
  const report = finishSuggestionRun({
    baseDeckName: input.plan.baseDeckName,
    search: input.search,
    skipped: [],
    candidatesGenerated: input.plan.candidatesGenerated,
    cappedByBudget: input.plan.manabase.capped.length > 0,
    elapsedSeconds: input.elapsedSeconds,
    history: input.plan.history,
    method: DEFAULT_ADAPTIVE_CONFIG.multipleComparisons,
    exploration: DEFAULT_EXPLORATION_WEIGHTS,
    stats,
    ...(input.workersUsed !== undefined ? { workersUsed: input.workersUsed } : {}),
  });

  const gamesByKey = new Map(input.search.outcomes.map((o) => [o.candidate.key, o.gamesPlayed] as const));
  const results: ManabaseVariantResult[] = [];
  for (const ranked of report.suggestions) {
    const key = `${ranked.evaluation.swap.out}>${ranked.evaluation.swap.in}`;
    const variant = variantForCandidateKey(key, input.plan.manabase.variants);
    if (!variant) continue; // a foreign key cannot happen from our own plan; never invent a row for it
    const depth = gamesByKey.get(key) ?? ranked.gamesPlayed;
    const reliability = compareReliability(
      input.baseObserved.slice(0, depth),
      (input.variantObserved.get(key) ?? []).slice(0, depth),
      stats,
    );
    const winVerdict = ranked.evaluation.verdict;
    const qualifies = winVerdict !== 'worse' && reliability.notWorse;
    const betterSomewhere = winVerdict === 'better' || reliability.metrics.some((m) => m.verdict === 'better');
    results.push({
      rank: ranked.rank,
      variant,
      evaluation: ranked.evaluation,
      gamesPlayed: ranked.gamesPlayed,
      rawPValue: ranked.rawPValue,
      adjustedPValue: ranked.adjustedPValue,
      ...(ranked.elimination ? { elimination: ranked.elimination } : {}),
      reliability,
      qualifies,
      betterSomewhere,
    });
  }

  return {
    baseDeck: input.plan.baseDeckName,
    base: input.plan.manabase.base,
    baseGauntletWinRate: report.baseGauntletWinRate,
    baseReliability: summarizeReliability(input.baseObserved, stats),
    results,
    recommended: results.find((r) => r.qualifies && r.betterSomewhere) ?? null,
    recommendationRule: MANABASE_RECOMMENDATION_RULE,
    skipped: input.plan.manabase.skipped,
    capped: input.plan.manabase.capped,
    failures: input.search.failures,
    waves: report.waves,
    multipleComparisons: report.multipleComparisons,
    notes: report.notes,
    notMeasured: RELIABILITY_NOT_MEASURED,
  };
}

// --- the single-threaded driver ----------------------------------------------------

export interface ManabaseSweepRunOptions {
  readonly gauntletDecks: readonly LoadedDeck[];
  readonly pilots: MatchupPilots;
  readonly pool: CardPool;
  readonly registry: EffectRegistry;
  readonly baseSeed: number;
  readonly gamesPerVariant?: number;
  readonly sweep?: ManabaseSweepOptions;
  readonly adaptiveConfig?: AdaptiveSearchConfig;
  readonly runOptions?: RunOptions;
  readonly deckRules?: DeckRules;
  readonly maxVariants?: number;
  /** Ticked with games actually played. */
  readonly onGame?: (games: number) => void;
  /** Wall clock, isolated so the run stays a data transform in tests. */
  readonly now?: () => number;
}

/**
 * Play the whole sweep inline on one incremental runner, with the reliability
 * watch on every game. The round loop is the suggestion engine's, driven the
 * way `suggest.ts` drives it; only the arm opening differs (a variant deck built
 * by `applyManabase`, not a swap).
 */
export function runManabaseSweep(base: Deck, options: ManabaseSweepRunOptions): ManabaseReport {
  const now = options.now ?? (() => Date.now() / 1000);
  const startedAt = now();
  const stats = options.runOptions?.stats ?? DEFAULT_STATS_CONFIG;
  const adaptiveConfig = options.adaptiveConfig ?? DEFAULT_ADAPTIVE_CONFIG;
  const plan = planManabaseRun(base, {
    pool: options.pool,
    opponentCount: options.gauntletDecks.length,
    baseSeed: options.baseSeed,
    ...(options.gamesPerVariant !== undefined ? { gamesPerVariant: options.gamesPerVariant } : {}),
    ...(options.sweep ? { sweep: options.sweep } : {}),
    adaptiveConfig,
    ...(options.deckRules ? { deckRules: options.deckRules } : {}),
    ...(options.maxVariants !== undefined ? { maxVariants: options.maxVariants } : {}),
  });
  const runner = createPairedArmRunner(base, {
    gauntletDecks: options.gauntletDecks,
    pilots: options.pilots,
    pool: options.pool,
    registry: options.registry,
    seed: plan.runSeed,
    ...(options.deckRules ? { deckRules: options.deckRules } : {}),
    ...(options.runOptions ? { runOptions: options.runOptions } : {}),
    ...(options.onGame ? { onGame: options.onGame } : {}),
    watchGames: () => createReliabilityWatch(),
  });

  const handles = new Map<string, ArmHandle>();
  const lastArm = new Map<string, SwapArm>();
  const driver = driveAdaptiveSearch(plan, { adaptiveConfig, stats });
  let step = driver.next();
  while (!step.done) {
    const answers: AdaptiveArmOutcome[] = [];
    for (const request of step.value.arms) {
      const candidate = request.candidate;
      let handle = handles.get(candidate.key);
      if (!handle) {
        const variant = variantForCandidateKey(candidate.key, plan.manabase.variants);
        try {
          if (!variant) throw new Error(`no manabase variant for candidate "${candidate.key}"`);
          handle = runner.openVariantArm({
            key: variant.key,
            label: variant.label,
            variantDeck: applyManabase(base, variant, options.pool),
            slotsChanged: variant.slotsChanged,
          });
        } catch (err) {
          answers.push({
            key: candidate.key,
            gamesPlayed: 0,
            paired: { bothWon: 0, baseOnly: 0, variantOnly: 0, neither: 0 },
            failure: err instanceof Error ? err.message : String(err),
          });
          continue;
        }
        handles.set(candidate.key, handle);
      }
      const arm = runner.advance(handle, request.toGames);
      lastArm.set(candidate.key, arm);
      answers.push({
        key: candidate.key,
        gamesPlayed: arm.gamesPlayed,
        paired: arm.paired,
        variantWonBySlot: arm.variantWonBySlot,
      });
    }
    step = driver.next({ arms: answers });
  }

  const outcome = step.value;
  const baseObserved: (PairedGameObservation | null)[] = [];
  for (let slot = 0; slot < outcome.baseSlotsPlayed; slot++) {
    // Cached by the runner — every slot below the deepest arm was played.
    baseObserved.push(runner.baseRecordAt(slot).observed ?? null);
  }
  const variantObserved = new Map<string, readonly (PairedGameObservation | null)[]>();
  for (const [key, arm] of lastArm) variantObserved.set(key, arm.observedBySlot ?? []);

  return finishManabaseRun({
    plan,
    search: {
      outcomes: outcome.arms.map((arm) => {
        const played = lastArm.get(arm.candidate.key) as SwapArm;
        return {
          candidate: arm.candidate,
          evaluation: summarizePairedSwap({
            baseDeckName: base.name,
            variantDeckName: arm.candidate.variantDeckName,
            swap: { out: arm.candidate.outId, in: arm.candidate.inId },
            outName: arm.candidate.outName,
            inName: arm.candidate.inName,
            paired: played.paired,
            stats,
            scope: DEFAULT_SWAP_SCOPE,
            copiesSwapped: arm.candidate.copiesSwapped,
          }),
          gamesPlayed: arm.gamesPlayed,
          ...(arm.elimination ? { elimination: arm.elimination } : {}),
        };
      }),
      waves: outcome.waves,
      usage: runner.usage(),
      failures: outcome.failures,
      fixedSchemeGames: outcome.fixedSchemeGames,
    },
    baseObserved,
    variantObserved,
    elapsedSeconds: now() - startedAt,
    stats,
  });
}
