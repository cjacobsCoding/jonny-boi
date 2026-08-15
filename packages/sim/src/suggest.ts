/**
 * THE DECK SUGGESTION ENGINE (DESIGN §3.6) — "tell me how to make my deck better".
 *
 * Given a base deck + the gauntlet, propose candidate single-card swaps, evaluate
 * them through the EXISTING paired A/B machinery (common random numbers + McNemar,
 * §3.5), and rank them by win-rate improvement and significance. We do NOT reinvent
 * the swap math or the stats (DRY) — `summarizePairedSwap` is shared with
 * `evaluateSwap` — and candidate generation, scheduling and ranking stay separate
 * pure functions so each is testable on its own.
 *
 * ### The search is ADAPTIVE (this is the part that changed)
 *
 * The original engine enumerated ~1500 candidates, pre-ranked them with a cheap
 * deterministic heuristic, took the top K, and gave every one of them the same
 * fixed games budget. Two things were wrong with that, and a user found both:
 *
 *   1. It spent as much compute on an obvious loser as on a real contender.
 *   2. The pre-ranking ignored outcomes, so **re-running produced the identical
 *      shortlist** — "it just started comparing to Eternal Witness AGAIN". If the
 *      first K were all worse-or-inconclusive, the tool could never make progress.
 *
 * The search now:
 *
 *   - **Samples adaptively** (`suggest-schedule.ts`). Successive halving: every
 *     candidate gets a cheap scout batch, then the field halves while the budget
 *     doubles, so the finalists still reach FULL depth while hopeless arms are
 *     dropped after a fraction of the games. Clear losers exit even earlier under a
 *     futility rule (§ `selectSurvivors`).
 *   - **Corrects for multiplicity** (`stats.ts`). Testing 139 candidates at alpha
 *     0.05 yields ~7 false "better" verdicts by chance, so the reported verdict is
 *     decided from a Holm-corrected p-value over the whole family — including
 *     candidates PREVIOUS runs tested, so repeated runs cannot p-hack a winner.
 *   - **Progresses across runs** (`suggest-history.ts`). A run returns a
 *     serializable record; hand it back and the next run skips settled losers,
 *     prioritises untried candidates, and refines the promising ones.
 *   - **Exploits promising directions**. When a candidate scores well, untried
 *     candidates that resemble it (same add, same cut, same colour/curve/role) are
 *     pulled into the next wave — the user's "genetic algo" intuition, kept simple
 *     and explainable rather than a black box.
 *   - **Plays the base arm ONCE** (`paired-arms.ts`). Under common random numbers
 *     the base result for a given game is the same for every candidate; the old
 *     loop replayed the whole base gauntlet per candidate, so half of all games run
 *     were redundant.
 *
 * Honesty (CLAUDE.md rule 6, DESIGN §3.6): the report says how many games each
 * candidate actually got, what was eliminated early and why, what was never tried,
 * and how the multiple-comparisons correction was applied. Nothing is truncated
 * silently.
 *
 * Determinism: `suggestSwaps` is a pure function of its decks, options, seed and
 * supplied history. Wave scheduling changes WHICH games get played, never their
 * outcomes — every game's seed is derived from the run seed and its (opponent,
 * game index) slot, so a candidate's numbers do not depend on when it was played.
 */

import type { CardDefinition, EffectRegistry } from '@jonny-boi/core';
import { convertedManaCost, type ManaColor } from '@jonny-boi/core';
import type { CardPool } from '@jonny-boi/cards';
import type { Deck, LoadedDeck } from './deck.js';
import { validateDeck } from './deck.js';
import type { CardSwap, SwapEvaluation, SwapVerdict } from './swap.js';
import { applySwap, decideVerdict, evaluateSwap } from './swap.js';
import type { MatchupPilots, RunOptions } from './matchup.js';
import { gameSeedFor } from './matchup.js';
import { DEFAULT_DECK_RULES, DEFAULT_STATS_CONFIG, FIDELITY_CAVEAT, type DeckRules } from './config.js';
import type { MultipleComparisonsMethod } from './stats.js';
import { adjustPValues } from './stats.js';
import {
  DEFAULT_ADAPTIVE_CONFIG,
  DEFAULT_EXPLORATION_WEIGHTS,
  DEFAULT_HEURISTIC_WEIGHTS,
  DEFAULT_SUGGEST_CONFIG,
  RANK_BUCKET_ORDER,
  type AdaptiveSearchConfig,
  type ExplorationWeights,
  type HeuristicWeights,
  type SuggestConfig,
} from './suggest-config.js';
import type { ArmHandle, PairedArmsUsage } from './paired-arms.js';
import { createPairedArmRunner } from './paired-arms.js';
import type {
  ArmStanding,
  CandidateTraits,
  EliminationReason,
  SchedulableCandidate,
} from './suggest-schedule.js';
import { planWaves, prioritiseCandidates, selectOffspring, selectSurvivors } from './suggest-schedule.js';
import type { HistoryUpdate, SuggestionHistory } from './suggest-history.js';
import {
  acceptHistory,
  candidateKey,
  mergeHistory,
  priorEvidenceFrom,
  type HistoryRejection,
} from './suggest-history.js';

// --- public shapes -------------------------------------------------------------

/** A candidate single-card swap before it has been simulated. */
export interface SwapCandidate extends SchedulableCandidate {
  /** Stable identity across runs: `outId>inId`. */
  readonly key: string;
  /** The card to cut (resolved id). */
  readonly outId: string;
  /** The card to add (resolved id). */
  readonly inId: string;
  readonly outName: string;
  readonly inName: string;
  /** The cheap pre-rank score (color match + curve fit); higher = scouted sooner. */
  readonly heuristicScore: number;
  /** Traits of the added card — how "more cards like this one" is decided. */
  readonly traits: CandidateTraits;
}

/** A candidate we generated but did NOT evaluate, with the honest reason. */
export interface SkippedCandidate {
  readonly outName: string;
  readonly inName: string;
  /**
   * Why it was skipped: 'illegal' (would break legality), 'capped' (this run's
   * roster was already full) or 'settled' (a previous run gave it a fair hearing
   * and it never looked promising — see `suggest-history.ts`).
   */
  readonly reason: 'illegal' | 'capped' | 'settled';
  /** For 'illegal': the legality problems; otherwise the reasoning, when useful. */
  readonly details: readonly string[];
}

/**
 * One evaluated, ranked swap recommendation.
 *
 * ⚠️ **Two p-values, on purpose.** `evaluation.pValue` is the raw McNemar p — a
 * valid significance statement about the games THIS candidate actually played, and
 * nothing more. `adjustedPValue` corrects it for the whole family of candidates
 * tested, and it is what `evaluation.verdict` is decided from, because the honest
 * question for a suggestion list is "is this better, given we looked at 139 cards?"
 * rather than "is this better, if it were the only card I had ever considered?".
 */
export interface RankedSwap {
  readonly rank: number;
  readonly outName: string;
  readonly inName: string;
  /** The paired A/B verdict; its `verdict` is the multiplicity-adjusted call. */
  readonly evaluation: SwapEvaluation;
  /**
   * Paired games this candidate actually received (adaptive: not all are equal).
   * Optional only so that a caller assembling a report by hand — the web app's
   * worker does — is not broken by this field being added; `suggestSwaps` always
   * sets it.
   */
  readonly gamesPlayed?: number;
  /** The uncorrected McNemar p-value (identical to `evaluation.pValue`). */
  readonly rawPValue?: number;
  /** The multiplicity-corrected p-value the verdict is decided from. */
  readonly adjustedPValue?: number;
  /** Present when the search stopped spending games here, with the reason. */
  readonly elimination?: EliminationNote;
}

/** Why a candidate stopped receiving games, and on what evidence. */
export interface EliminationNote {
  /** The wave after which it was dropped. */
  readonly wave: number;
  /** 'futile' = provably not better; 'outranked' = budget bought more elsewhere. */
  readonly reason: EliminationReason;
  readonly detail: string;
}

/** An eliminated candidate, named for the report. */
export interface EliminatedSwap extends EliminationNote {
  readonly outName: string;
  readonly inName: string;
  readonly gamesPlayed: number;
}

/** What one wave of the adaptive search did — reported so nothing is silent. */
export interface WaveReport {
  readonly wave: number;
  /** Paired games each candidate in this wave was played up to (cumulative). */
  readonly cumulativeGames: number;
  /** How many candidates the wave played. */
  readonly candidatesPlayed: number;
  /** How many carried into the next wave. */
  readonly survivors: number;
  /** Who was dropped after this wave, and why. */
  readonly eliminated: readonly EliminatedSwap[];
  /** Untried candidates pulled in because they resemble this wave's leaders. */
  readonly offspring: readonly string[];
}

/** How the family of simultaneous tests was corrected. */
export interface MultipleComparisonsReport {
  readonly method: MultipleComparisonsMethod;
  /**
   * Tests the correction accounted for: every candidate this run evaluated PLUS
   * every candidate previous runs evaluated on this deck. Counting past runs is
   * what stops "just run it again until something looks significant" from working.
   */
  readonly familySize: number;
  /** Of those, how many this run evaluated. */
  readonly testedThisRun: number;
  /** Candidates whose RAW p cleared alpha but whose corrected p did not. */
  readonly demotedByCorrection: number;
}

/** The suggestion engine's report for one deck. */
export interface SuggestionReport {
  readonly baseDeck: string;
  /** The base deck's overall gauntlet win-rate (variantless reference point). */
  readonly baseGauntletWinRate: SwapEvaluation['baseWinRate'];
  /** How many candidate swaps were actually simulated. */
  readonly candidatesEvaluated: number;
  /** The ranked recommendations: proven-better, then inconclusive, then worse. */
  readonly suggestions: readonly RankedSwap[];
  /** Candidates generated but not evaluated (illegal / capped / settled). */
  readonly skipped: readonly SkippedCandidate[];
  /**
   * What each wave played, dropped, and pulled in. Empty in fixed-budget mode.
   *
   * This and the two fields below are optional purely so a caller that assembles a
   * report by hand (the web app's sim worker does, to stream progress) keeps
   * compiling as the engine grows. `suggestSwaps` always sets all three.
   */
  readonly waves?: readonly WaveReport[];
  /** How the multiple-comparisons problem was handled. */
  readonly multipleComparisons?: MultipleComparisonsReport;
  /**
   * The record to persist and hand back next time — this is what makes a re-run
   * explore new ground instead of repeating itself.
   */
  readonly history?: SuggestionHistory;
  /** Throughput + coverage notes (games run, games/sec, caveats). */
  readonly notes: SuggestionNotes;
}

/** Performance + honesty notes carried in the report (not console spam). */
export interface SuggestionNotes {
  /** Total individual games the sim actually played. */
  readonly totalGamesRun: number;
  /** Observed throughput; undefined when not timed. */
  readonly gamesPerSecond?: number;
  /** Wall-clock seconds the evaluations took, when measured. */
  readonly elapsedSeconds?: number;
  /** Candidates generated in total (evaluated + skipped). */
  readonly candidatesGenerated: number;
  /** True when the roster cap trimmed the candidate set. */
  readonly cappedByBudget: boolean;
  /**
   * Base-deck games played — ONCE for the whole run under base-arm reuse. Optional
   * for hand-assembled reports (see `waves`); `suggestSwaps` always sets it.
   */
  readonly baseGamesPlayed?: number;
  /** Variant games played. */
  readonly variantGamesPlayed?: number;
  /** Variant games answered for free because the swapped card was never seen. */
  readonly variantGamesSkipped?: number;
  /**
   * Games the fixed scheme would have played for the same candidates and depths —
   * the honest denominator for "how much did adaptive sampling save?".
   */
  readonly gamesAvoided?: number;
  /** Whether the identical-game optimisation was live, and why not when it wasn't. */
  readonly identicalGameSkipEnabled?: boolean;
  readonly identicalGameSkipDisabledReason?: string;
  /** Which run this was for this deck (0 = the first ever). */
  readonly runIndex?: number;
  /** Set when a supplied history was rejected, with the reason. */
  readonly historyRejected?: HistoryRejection;
  /** The shared fidelity caveat (`FIDELITY_CAVEAT`), carried for the UI/CLI. */
  readonly fidelityCaveat: string;
}

/** Options controlling a `suggestSwaps` run. */
export interface SuggestOptions {
  /** The gauntlet the candidates are judged against. Required. */
  readonly gauntletDecks: readonly LoadedDeck[];
  /** The pilots driving both seats. Required. */
  readonly pilots: MatchupPilots;
  /** The card pool (resolves names/ids and supplies `in` candidates). Required. */
  readonly pool: CardPool;
  /** The effect registry the sim plays with. Required. */
  readonly registry: EffectRegistry;
  /** Base RNG seed — same seed + inputs + history ⇒ same ranking. Required. */
  readonly baseSeed: number;
  /**
   * Games per matchup at FULL depth: what a finalist is measured with (adaptive),
   * or what every candidate gets (fixed). Defaults to `DEFAULT_SUGGEST_CONFIG`.
   */
  readonly gamesPerCandidate?: number;
  /** Bounds + thresholds (roster cap, basic-land floor). */
  readonly suggestConfig?: SuggestConfig;
  /** Cheap pre-rank heuristic weights. */
  readonly heuristicWeights?: HeuristicWeights;
  /** Wave shape, elimination thresholds, multiple-comparisons method. */
  readonly adaptiveConfig?: AdaptiveSearchConfig;
  /** Exploration weights: untried vs refine vs settled, and relatedness. */
  readonly explorationWeights?: ExplorationWeights;
  /** Deck-legality rules (4-of, min size, basics). */
  readonly deckRules?: DeckRules;
  /** Sim/stats run options threaded into the paired evaluation. */
  readonly runOptions?: RunOptions;
  /**
   * The record a previous run returned. Supply it and this run skips settled
   * losers, prioritises untried candidates, and plays DIFFERENT games (the run
   * counter offsets the seed). Omit for a first run.
   */
  readonly history?: SuggestionHistory;
  /**
   * Use the adaptive wave scheduler (default). Set false for the legacy
   * fixed-budget sweep — retained so the two can be compared head-to-head.
   */
  readonly adaptive?: boolean;
  /**
   * FOCUSED MODE — restrict which cards may be cut (names or ids). Omit for auto.
   */
  readonly cutOnly?: readonly string[];
  /**
   * FOCUSED MODE — restrict the `in` candidates to this shortlist (names or ids).
   * Omit for auto.
   */
  readonly inOnly?: readonly string[];
}

// --- candidate generation (pure) ----------------------------------------------

/**
 * Enumerate the legal single-card swaps for `base`: every (cuttable card) ×
 * (addable card) pair that yields a deck passing `validateDeck`. Each candidate
 * gets a cheap heuristic score (color match + curve fit) and the traits the
 * exploration rules reason over. Pure: no sim, no RNG — same inputs, same list.
 *
 * Legality is the source of truth, not a hand-rolled copy of the 4-of math: we
 * actually build the variant with `applySwap` and run the existing `validateDeck`
 * (DRY). A candidate whose variant is illegal is returned in `skipped`, never
 * crashed on. Basic-land cuts additionally respect `minBasicLandsKept` so we
 * never gut the mana base.
 */
export function generateCandidates(
  base: Deck,
  pool: CardPool,
  config: SuggestConfig = DEFAULT_SUGGEST_CONFIG,
  weights: HeuristicWeights = DEFAULT_HEURISTIC_WEIGHTS,
  rules: DeckRules = DEFAULT_DECK_RULES,
  focus: { readonly cutOnly?: readonly string[]; readonly inOnly?: readonly string[] } = {},
): { readonly candidates: readonly SwapCandidate[]; readonly skipped: readonly SkippedCandidate[] } {
  const deckProfile = profileDeck(base, pool);
  const cutDefs = resolveCuttables(base, pool, rules, config, focus.cutOnly);
  const inDefs = resolveAddables(base, pool, rules, focus.inOnly);

  const candidates: SwapCandidate[] = [];
  const skipped: SkippedCandidate[] = [];

  for (const outDef of cutDefs) {
    for (const inDef of inDefs) {
      // A swap of a card for itself is a no-op (delta 0) — never suggest it.
      if (outDef.id === inDef.id) continue;

      const swap: CardSwap = { out: outDef.id, in: inDef.id };
      let variant: Deck;
      try {
        variant = applySwap(base, swap, pool);
      } catch (err) {
        skipped.push({
          outName: outDef.name,
          inName: inDef.name,
          reason: 'illegal',
          details: [err instanceof Error ? err.message : String(err)],
        });
        continue;
      }
      const problems = validateDeck(variant, pool, rules);
      if (problems.length > 0) {
        skipped.push({ outName: outDef.name, inName: inDef.name, reason: 'illegal', details: problems });
        continue;
      }

      candidates.push({
        key: candidateKey(outDef.id, inDef.id),
        outId: outDef.id,
        inId: inDef.id,
        outName: outDef.name,
        inName: inDef.name,
        heuristicScore: scoreCandidate(inDef, deckProfile, weights),
        traits: traitsOf(inDef),
      });
    }
  }

  // Most-plausible candidates first (stable: ties broken by name for determinism).
  candidates.sort(compareCandidates);
  return { candidates, skipped };
}

/** A cheap colour/curve summary of the deck, used by the pre-rank heuristic. */
interface DeckProfile {
  /** Colours the deck can produce (from its lands/mana sources). */
  readonly colors: ReadonlySet<ManaColor>;
  /** Mean mana value of the deck's non-land spells (0 when none). */
  readonly avgSpellMv: number;
}

function profileDeck(base: Deck, pool: CardPool): DeckProfile {
  const colors = new Set<ManaColor>();
  let mvSum = 0;
  let spellCount = 0;
  for (const entry of base.cards) {
    const def = pool.get(entry.cardId) ?? pool.getByName(entry.cardId);
    if (!def) continue;
    for (const c of def.produces ?? []) colors.add(c);
    if (def.types.includes('land')) continue;
    if (def.cost) {
      mvSum += convertedManaCost(def.cost) * entry.count;
      spellCount += entry.count;
    }
  }
  return { colors, avgSpellMv: spellCount > 0 ? mvSum / spellCount : 0 };
}

/**
 * The cheap pre-rank heuristic. NOT a strength judgement — just a relevance score
 * so the bounded auto mode scouts plausible swaps first. Rewards an `in` card whose
 * colored pips the deck can cast (colorMatch) and whose mana value sits near the
 * deck's curve (curveFit). The sim makes the real call.
 */
export function scoreCandidate(inDef: CardDefinition, profile: DeckProfile, weights: HeuristicWeights): number {
  const pips = coloredPips(inDef);
  const castable = pips.length === 0 || pips.every((c) => profile.colors.has(c));
  const colorScore = castable ? weights.colorMatch : 0;

  const mv = inDef.cost ? convertedManaCost(inDef.cost) : 0;
  // Curve fit decays with distance from the deck's average spell MV; 1 at a perfect
  // match, approaching 0 as it drifts away (a smooth, parameter-free falloff).
  const curveScore = weights.curveFit / (1 + Math.abs(mv - profile.avgSpellMv));

  return colorScore + curveScore;
}

/**
 * The traits "more cards like the one that worked" is measured on. Deliberately
 * coarse and human-readable — colour identity, curve slot, role — so the report can
 * justify a promotion in words a deck-builder would use.
 */
export function traitsOf(inDef: CardDefinition): CandidateTraits {
  return {
    colorKey: coloredPips(inDef).join(''),
    manaValue: inDef.cost ? convertedManaCost(inDef.cost) : 0,
    role: inDef.types[0] ?? 'unknown',
  };
}

/** The distinct colored mana symbols a card's cost demands (empty if colorless). */
function coloredPips(def: CardDefinition): readonly ManaColor[] {
  const cost = def.cost;
  if (!cost) return [];
  const out: ManaColor[] = [];
  for (const c of ['W', 'U', 'B', 'R', 'G', 'C'] as const) {
    if ((cost[c] ?? 0) > 0) out.push(c);
  }
  return out;
}

/** Stable candidate ordering: higher heuristic first, ties by out-then-in name. */
function compareCandidates(a: SwapCandidate, b: SwapCandidate): number {
  if (b.heuristicScore !== a.heuristicScore) return b.heuristicScore - a.heuristicScore;
  if (a.outName !== b.outName) return a.outName < b.outName ? -1 : 1;
  return a.inName < b.inName ? -1 : a.inName > b.inName ? 1 : 0;
}

/**
 * Total copies of each card in the deck, keyed by resolved card id. Counting per
 * CARD rather than per decklist line matters: one card can legitimately occupy two
 * lines (a swap splits the line it cuts from), and per-line counting would both
 * emit the same cut candidate twice and misjudge the basic-land floor. Insertion
 * order is the decklist's, so downstream iteration stays deterministic.
 */
function copiesByCard(base: Deck, pool: CardPool): Map<string, { readonly def: CardDefinition; count: number }> {
  const counts = new Map<string, { readonly def: CardDefinition; count: number }>();
  for (const entry of base.cards) {
    const def = pool.get(entry.cardId) ?? pool.getByName(entry.cardId);
    if (!def) continue;
    const tally = counts.get(def.id);
    if (tally) tally.count += entry.count;
    else counts.set(def.id, { def, count: entry.count });
  }
  return counts;
}

/** The deck cards we may cut: each distinct card, minus a basic-land floor. */
function resolveCuttables(
  base: Deck,
  pool: CardPool,
  rules: DeckRules,
  config: SuggestConfig,
  cutOnly: readonly string[] | undefined,
): readonly CardDefinition[] {
  const allow = cutOnly ? new Set(cutOnly.map((s) => s.toLowerCase())) : undefined;
  const out: CardDefinition[] = [];
  for (const { def, count } of copiesByCard(base, pool).values()) {
    if (allow && !(allow.has(def.id.toLowerCase()) || allow.has(def.name.toLowerCase()))) continue;
    // Never cut a basic line that's already at/below the floor — it'd starve mana.
    if (rules.unlimitedCopies.has(def.name) && count <= config.minBasicLandsKept) continue;
    out.push(def);
  }
  return out;
}

/** The pool cards we may add: any not already maxed (basics always addable). */
function resolveAddables(
  base: Deck,
  pool: CardPool,
  rules: DeckRules,
  inOnly: readonly string[] | undefined,
): readonly CardDefinition[] {
  const allow = inOnly ? new Set(inOnly.map((s) => s.toLowerCase())) : undefined;
  const counts = new Map<string, number>();
  for (const [id, tally] of copiesByCard(base, pool)) counts.set(id, tally.count);
  const out: CardDefinition[] = [];
  for (const def of pool.cards) {
    if (allow && !(allow.has(def.id.toLowerCase()) || allow.has(def.name.toLowerCase()))) continue;
    const isUnlimited = rules.unlimitedCopies.has(def.name);
    const have = counts.get(def.id) ?? 0;
    if (!isUnlimited && have >= rules.maxCopiesNonBasic) continue; // already a 4-of
    out.push(def);
  }
  return out;
}

// --- ranking (pure) ------------------------------------------------------------

/**
 * Order evaluated swaps best-first. Proven-better swaps lead (largest positive
 * delta first), then the promising-but-inconclusive middle, then proven-worse
 * last. Within a bucket we sort by delta descending, breaking ties with the
 * smaller p-value (stronger signal) and finally the swap key for determinism.
 *
 * Pure over `SwapEvaluation`-shaped inputs — it makes NO sim calls, so it's tested
 * in isolation against synthetic results (the engine's real numbers can shift
 * under §3.9 without breaking this ordering contract).
 */
export function rankEvaluations(evaluations: readonly SwapEvaluation[]): readonly SwapEvaluation[] {
  return [...evaluations].sort(compareEvaluations);
}

function compareEvaluations(a: SwapEvaluation, b: SwapEvaluation): number {
  const bucketA = bucketFor(a.verdict);
  const bucketB = bucketFor(b.verdict);
  if (bucketA !== bucketB) return bucketA - bucketB;

  // Within a bucket: higher delta is better.
  if (b.delta !== a.delta) return b.delta - a.delta;
  // Tie on delta: the smaller p-value (stronger evidence) ranks higher.
  if (a.pValue !== b.pValue) return a.pValue - b.pValue;
  // Final tiebreak on the swap key, by CODE UNIT — not `localeCompare`, whose
  // ordering depends on the host's locale and ICU build, so the "same inputs ⇒
  // same ranking" guarantee would quietly hold on one machine and not another.
  const keyA = swapKey(a);
  const keyB = swapKey(b);
  return keyA < keyB ? -1 : keyA > keyB ? 1 : 0;
}

function bucketFor(verdict: SwapVerdict): number {
  return RANK_BUCKET_ORDER[verdict];
}

function swapKey(e: SwapEvaluation): string {
  return `${e.swap.out} ${e.swap.in}`;
}

// --- the engine ----------------------------------------------------------------

/** What a search strategy hands back for assembly into the report. */
interface CandidateOutcome {
  readonly candidate: SwapCandidate;
  readonly evaluation: SwapEvaluation;
  readonly gamesPlayed: number;
  readonly elimination?: EliminationNote;
}

interface SearchResult {
  readonly outcomes: readonly CandidateOutcome[];
  readonly waves: readonly WaveReport[];
  readonly usage: PairedArmsUsage;
  /** Candidates that failed at evaluation time (recorded, never fatal). */
  readonly failures: readonly SkippedCandidate[];
  /**
   * Games a fixed-budget sweep would have played to reach the same per-candidate
   * depths: `2 × Σ gamesPlayed` (each paired game plays both arms).
   */
  readonly fixedSchemeGames: number;
}

/**
 * THE SUGGESTION LOOP (DESIGN §3.6). See the module header for the full design;
 * in short: generate → prioritise (using history) → schedule in waves → correct for
 * multiplicity → rank → report, returning the record the next run builds on.
 *
 * Robust: a candidate that throws is recorded as skipped with its reason, not
 * crashed on; zero valid candidates ⇒ a well-formed empty report.
 */
export function suggestSwaps(base: Deck, options: SuggestOptions): SuggestionReport {
  const config = options.suggestConfig ?? DEFAULT_SUGGEST_CONFIG;
  const weights = options.heuristicWeights ?? DEFAULT_HEURISTIC_WEIGHTS;
  const adaptiveConfig = options.adaptiveConfig ?? DEFAULT_ADAPTIVE_CONFIG;
  const exploration = options.explorationWeights ?? DEFAULT_EXPLORATION_WEIGHTS;
  const rules = options.deckRules ?? DEFAULT_DECK_RULES;
  const stats = options.runOptions?.stats ?? DEFAULT_STATS_CONFIG;
  const games = options.gamesPerCandidate ?? config.defaultGamesPerCandidate;

  const generated = generateCandidates(base, options.pool, config, weights, rules, {
    cutOnly: options.cutOnly,
    inOnly: options.inOnly,
  });
  // Snapshot the generation total BEFORE evaluation can append its own failures.
  const candidatesGenerated = generated.candidates.length + generated.skipped.length;

  // What previous runs learned, if the caller kept it and it still applies.
  const accepted = acceptHistory(options.history, base);
  const history = accepted.history;
  const priors = priorEvidenceFrom(history, exploration);

  // Priority decides who is scouted at all — the fix for "it re-tested the same
  // shortlist": untried candidates outrank ones a previous run already covered.
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
  const runSeed = history.runsCompleted === 0 ? options.baseSeed : gameSeedFor(options.baseSeed, history.runsCompleted);

  const start = nowSeconds();
  const search =
    options.adaptive === false
      ? runFixedBudget(base, roster, options, { games, rules, stats })
      : runAdaptiveSearch(base, roster, reserves, options, {
          games,
          rules,
          stats,
          runSeed,
          adaptiveConfig,
          exploration,
        });
  const elapsedSeconds = nowSeconds() - start;

  // Candidates the roster cap left out this run — honest, not silent.
  const evaluatedKeys = new Set(search.outcomes.map((o) => o.candidate.key));
  const capped: SkippedCandidate[] = reserves
    .filter((c) => !evaluatedKeys.has(c.key))
    .map((c) => ({ outName: c.outName, inName: c.inName, reason: 'capped' as const, details: [] }));

  return assembleReport({
    base,
    search,
    skipped: [...skipped, ...search.failures, ...capped],
    candidatesGenerated,
    cappedByBudget: capped.length > 0,
    elapsedSeconds,
    history,
    ...(accepted.rejected ? { historyRejected: accepted.rejected } : {}),
    method: adaptiveConfig.multipleComparisons,
    exploration,
    stats,
  });
}

/** Shared knobs the two search strategies both need. */
interface SearchContext {
  readonly games: number;
  readonly rules: DeckRules;
  readonly stats: typeof DEFAULT_STATS_CONFIG;
}

/**
 * THE ADAPTIVE SEARCH — successive halving over the roster.
 *
 * Wave 1 scouts everyone cheaply. After each wave the futility rule retires
 * provably-not-better arms and the rank cut halves the field, the budget doubles,
 * and untried candidates resembling the leaders are pulled in. The last wave lands
 * on the full budget, so the headline suggestion is measured exactly as deeply as
 * the fixed scheme would have measured it — everything saved comes from NOT
 * measuring the hopeless ones that deeply.
 */
function runAdaptiveSearch(
  base: Deck,
  roster: readonly SwapCandidate[],
  reserves: readonly SwapCandidate[],
  options: SuggestOptions,
  ctx: SearchContext & {
    readonly runSeed: number;
    readonly adaptiveConfig: AdaptiveSearchConfig;
    readonly exploration: ExplorationWeights;
  },
): SearchResult {
  const runner = createPairedArmRunner(base, {
    gauntletDecks: options.gauntletDecks,
    pilots: options.pilots,
    pool: options.pool,
    registry: options.registry,
    seed: ctx.runSeed,
    deckRules: ctx.rules,
    ...(options.runOptions ? { runOptions: options.runOptions } : {}),
  });

  const failures: SkippedCandidate[] = [];
  const handles = new Map<string, ArmHandle>();
  const byKey = new Map<string, SwapCandidate>();
  const eliminations = new Map<string, EliminationNote>();
  const gamesByKey = new Map<string, number>();
  for (const candidate of [...roster, ...reserves]) byKey.set(candidate.key, candidate);

  const maxPairedGames = runner.slotCapacity(ctx.games);
  const plan = planWaves(roster.length, maxPairedGames, ctx.adaptiveConfig);
  const waves: WaveReport[] = [];
  const offspringPool: SwapCandidate[] = [...reserves];

  let current: readonly SwapCandidate[] = roster;
  for (const spec of plan) {
    const standings: ArmStanding[] = [];
    for (const candidate of current) {
      let handle = handles.get(candidate.key);
      if (!handle) {
        try {
          handle = runner.openArm({ out: candidate.outId, in: candidate.inId }, candidate.outName, candidate.inName);
        } catch (err) {
          // Survived legality but still failed to build — recorded, never fatal.
          failures.push({
            outName: candidate.outName,
            inName: candidate.inName,
            reason: 'illegal',
            details: [err instanceof Error ? err.message : String(err)],
          });
          continue;
        }
        handles.set(candidate.key, handle);
      }
      const arm = runner.advance(handle, spec.cumulativeGames);
      gamesByKey.set(candidate.key, arm.gamesPlayed);
      standings.push({ key: candidate.key, gamesPlayed: arm.gamesPlayed, paired: arm.paired });
    }

    const isFinalWave = spec.wave === plan.length;
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

    const cut = selectSurvivors(standings, spec.wave, spec.survivorTarget, ctx.adaptiveConfig, ctx.stats);
    const eliminated: EliminatedSwap[] = cut.eliminated.map((e) => {
      const candidate = byKey.get(e.key) as SwapCandidate;
      const note: EliminationNote = { wave: e.wave, reason: e.reason, detail: e.detail };
      eliminations.set(e.key, note);
      return { ...note, outName: candidate.outName, inName: candidate.inName, gamesPlayed: e.gamesPlayed };
    });

    const leaders = cut.survivors.map((s) => byKey.get(s.key) as SwapCandidate);
    const nextBudget = plan[spec.wave]?.cumulativeGames ?? maxPairedGames;
    // A newcomer plays catch-up from zero, so it may only join while the next
    // wave's budget is still cheap.
    const offspringAllowed = nextBudget <= maxPairedGames * ctx.adaptiveConfig.offspringMaxEntryBudgetFraction;
    const offspring = offspringAllowed
      ? selectOffspring(leaders, offspringPool, ctx.adaptiveConfig.offspringPerWave, ctx.exploration)
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

  const outcomes: CandidateOutcome[] = [];
  let fixedSchemeGames = 0;
  for (const [key, handle] of handles) {
    const gamesPlayed = gamesByKey.get(key) ?? 0;
    if (gamesPlayed <= 0) continue;
    fixedSchemeGames += gamesPlayed * 2;
    const elimination = eliminations.get(key);
    outcomes.push({
      candidate: byKey.get(key) as SwapCandidate,
      evaluation: runner.summarize(handle),
      gamesPlayed,
      ...(elimination ? { elimination } : {}),
    });
  }

  return { outcomes, waves, usage: runner.usage(), failures, fixedSchemeGames };
}

/**
 * THE LEGACY FIXED-BUDGET SWEEP — every candidate gets the same games, on its own
 * derived seed, through `evaluateSwap`. Retained (behind `adaptive: false`) so the
 * adaptive search can be compared against it head-to-head on the same inputs.
 */
function runFixedBudget(
  base: Deck,
  roster: readonly SwapCandidate[],
  options: SuggestOptions,
  ctx: SearchContext,
): SearchResult {
  const outcomes: CandidateOutcome[] = [];
  const failures: SkippedCandidate[] = [];
  let totalGamesPlayed = 0;

  for (const candidate of roster) {
    // Per-candidate seed derived from the base seed and the STABLE candidate key,
    // so reordering candidates can't change any single evaluation's outcome.
    const candidateSeed = gameSeedFor(options.baseSeed, candidateSeedSalt(candidate));
    try {
      const evaluation = evaluateSwap(
        base,
        { out: candidate.outId, in: candidate.inId },
        options.gauntletDecks,
        options.pilots,
        ctx.games,
        candidateSeed,
        options.pool,
        options.registry,
        // Hand the SAME legality rules down that generated the candidates.
        { ...options.runOptions, deckRules: ctx.rules },
      );
      outcomes.push({ candidate, evaluation, gamesPlayed: evaluation.nGames });
      totalGamesPlayed += evaluation.nGames * 2;
    } catch (err) {
      failures.push({
        outName: candidate.outName,
        inName: candidate.inName,
        reason: 'illegal',
        details: [err instanceof Error ? err.message : String(err)],
      });
    }
  }

  return {
    outcomes,
    waves: [],
    usage: {
      baseGamesPlayed: totalGamesPlayed / 2,
      variantGamesPlayed: totalGamesPlayed / 2,
      variantGamesSkipped: 0,
      totalGamesPlayed,
      identicalGameSkipEnabled: false,
      identicalGameSkipDisabledReason: 'fixed-budget mode re-runs both arms per candidate',
    },
    failures,
    fixedSchemeGames: totalGamesPlayed,
  };
}

/** Everything `assembleReport` needs; grouped so the call site stays readable. */
interface ReportInput {
  readonly base: Deck;
  readonly search: SearchResult;
  readonly skipped: readonly SkippedCandidate[];
  readonly candidatesGenerated: number;
  readonly cappedByBudget: boolean;
  readonly elapsedSeconds: number;
  readonly history: SuggestionHistory;
  readonly historyRejected?: HistoryRejection;
  readonly method: MultipleComparisonsMethod;
  readonly exploration: ExplorationWeights;
  readonly stats: typeof DEFAULT_STATS_CONFIG;
}

/**
 * Correct for multiplicity, re-decide every verdict from the corrected p-value,
 * rank, and assemble — plus the record the next run continues from.
 *
 * The family is every candidate tested on this deck EVER, not just this run: the
 * padding entries stand for candidates a previous run tested and this one didn't,
 * which is exactly what keeps "run it again until something looks significant" from
 * manufacturing a winner. Padding with p = 1 is the standard, conservative way to
 * apply Holm/BH to a family you only partly observe.
 */
function assembleReport(input: ReportInput): SuggestionReport {
  const outcomes = input.search.outcomes;
  const priorKeys = new Set(input.history.candidates.map((c) => candidateKey(c.outId, c.inId)));
  for (const outcome of outcomes) priorKeys.add(outcome.candidate.key);
  const familySize = Math.max(priorKeys.size, outcomes.length);

  const rawPValues = outcomes.map((o) => o.evaluation.pValue);
  const padded = [...rawPValues, ...new Array(Math.max(0, familySize - rawPValues.length)).fill(1)];
  const adjustedAll = adjustPValues(padded, input.method);
  const adjusted = adjustedAll.slice(0, rawPValues.length);

  let demotedByCorrection = 0;
  const byEvaluation = new Map<SwapEvaluation, { readonly outcome: CandidateOutcome; readonly adjustedP: number }>();
  const corrected: SwapEvaluation[] = outcomes.map((outcome, i) => {
    const adjustedP = adjusted[i] as number;
    const verdict = decideVerdict(
      outcome.evaluation.delta,
      adjustedP,
      outcome.evaluation.nGames,
      input.stats.alpha,
      input.stats.minGamesForVerdict,
    );
    if (outcome.evaluation.verdict !== 'inconclusive' && verdict === 'inconclusive') demotedByCorrection++;
    const evaluation: SwapEvaluation = { ...outcome.evaluation, verdict };
    byEvaluation.set(evaluation, { outcome, adjustedP });
    return evaluation;
  });

  const ranked = rankEvaluations(corrected);
  const suggestions: RankedSwap[] = ranked.map((evaluation, i) => {
    const meta = byEvaluation.get(evaluation) as { outcome: CandidateOutcome; adjustedP: number };
    return {
      rank: i + 1,
      outName: evaluation.outName,
      inName: evaluation.inName,
      evaluation,
      gamesPlayed: meta.outcome.gamesPlayed,
      rawPValue: evaluation.pValue,
      adjustedPValue: meta.adjustedP,
      ...(meta.outcome.elimination ? { elimination: meta.outcome.elimination } : {}),
    };
  });

  // History records the UNCORRECTED verdict on purpose: it drives budget decisions
  // ("has this candidate had a fair hearing?"), not published claims, and the
  // correction is re-derived from the whole family each run anyway.
  const updates: HistoryUpdate[] = outcomes.map((outcome) => ({
    outId: outcome.candidate.outId,
    inId: outcome.candidate.inId,
    outName: outcome.candidate.outName,
    inName: outcome.candidate.inName,
    gamesPlayed: outcome.gamesPlayed,
    delta: outcome.evaluation.delta,
    verdict: outcome.evaluation.verdict,
    // Futility is the scheduler saying "provably not better" — settle it for good.
    provenNotBetter: outcome.evaluation.verdict === 'worse' || outcome.elimination?.reason === 'futile',
  }));

  const usage = input.search.usage;
  const totalGamesRun = usage.totalGamesPlayed;
  const notes: SuggestionNotes = {
    totalGamesRun,
    elapsedSeconds: input.elapsedSeconds > 0 ? input.elapsedSeconds : undefined,
    gamesPerSecond: input.elapsedSeconds > 0 ? totalGamesRun / input.elapsedSeconds : undefined,
    candidatesGenerated: input.candidatesGenerated,
    cappedByBudget: input.cappedByBudget,
    baseGamesPlayed: usage.baseGamesPlayed,
    variantGamesPlayed: usage.variantGamesPlayed,
    variantGamesSkipped: usage.variantGamesSkipped,
    gamesAvoided: Math.max(0, input.search.fixedSchemeGames - totalGamesRun),
    identicalGameSkipEnabled: usage.identicalGameSkipEnabled,
    ...(usage.identicalGameSkipDisabledReason
      ? { identicalGameSkipDisabledReason: usage.identicalGameSkipDisabledReason }
      : {}),
    runIndex: input.history.runsCompleted,
    ...(input.historyRejected ? { historyRejected: input.historyRejected } : {}),
    fidelityCaveat: FIDELITY_CAVEAT,
  };

  return {
    baseDeck: input.base.name,
    // No candidate ran (empty report) → a zero win-rate placeholder, clearly noted.
    baseGauntletWinRate: outcomes[0]?.evaluation.baseWinRate ?? { p: 0, low: 0, high: 0, successes: 0, n: 0 },
    candidatesEvaluated: outcomes.length,
    suggestions,
    skipped: input.skipped,
    waves: input.search.waves,
    multipleComparisons: {
      method: input.method,
      familySize,
      testedThisRun: outcomes.length,
      demotedByCorrection,
    },
    history: mergeHistory(input.history, updates, input.exploration),
    notes,
  };
}

/** A stable non-negative integer salt for a candidate's seed (from out+in ids). */
function candidateSeedSalt(candidate: SwapCandidate): number {
  let h = 0x811c9dc5;
  const key = `${candidate.outId}>${candidate.inId}`;
  for (let i = 0; i < key.length; i++) {
    h = Math.imul(h ^ key.charCodeAt(i), 0x01000193) >>> 0;
  }
  return h;
}

/** Wall-clock seconds; isolated so the engine stays a pure-ish data transform. */
function nowSeconds(): number {
  return Date.now() / 1000;
}
