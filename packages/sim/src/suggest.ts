/**
 * THE DECK SUGGESTION ENGINE (DESIGN §3.6) — "tell me how to make my deck better".
 *
 * Given a base deck + the gauntlet, propose candidate single-card swaps, evaluate
 * each through the EXISTING paired A/B sim (`evaluateSwap` — common random numbers
 * + McNemar, §3.5), and rank them by win-rate improvement and statistical
 * significance. We do NOT reinvent the swap math or the stats (DRY); this module
 * is pure orchestration over the §3.5 seam plus two cheap pure helpers
 * (candidate generation, ranking) that are independently testable.
 *
 * Tractability: cuttable cards × addable cards explodes, and every candidate costs
 * `2 × |gauntlet| × games` matches. Two modes keep it bounded:
 *   - FOCUSED — the caller hands us which cards to cut and/or a shortlist of `in`
 *     candidates; we evaluate exactly those.
 *   - AUTO    — we enumerate the legal swaps, pre-rank them with a cheap heuristic
 *     (color match + curve fit — no sim), keep the top `maxCandidates`, and RECORD
 *     everything we skipped so coverage is honest (CLAUDE.md: no silent truncation).
 *
 * Honesty (DESIGN §3.9, done): the engine models triggered abilities & until-EOT
 * effects; only a few advanced mechanics remain unimplemented (see `FIDELITY_CAVEAT`).
 * The report carries that caveat and the CLI prints it. The ranking math is exact
 * regardless of how many cards use a still-simplified mechanic.
 *
 * Determinism: `suggestSwaps` is a pure function of its decks + options + seed.
 * Each candidate evaluates on a seed derived from the base seed and a STABLE
 * candidate key (out+in), so the same inputs reproduce the same ranking exactly.
 */

import type { CardDefinition, EffectRegistry } from '@jonny-boi/core';
import { convertedManaCost, type ManaColor } from '@jonny-boi/core';
import type { CardPool } from '@jonny-boi/cards';
import type { Deck, LoadedDeck } from './deck.js';
import { validateDeck } from './deck.js';
import type { CardSwap, SwapEvaluation, SwapVerdict } from './swap.js';
import { applySwap, evaluateSwap } from './swap.js';
import type { MatchupPilots, RunOptions } from './matchup.js';
import { gameSeedFor } from './matchup.js';
import {
  DEFAULT_DECK_RULES,
  FIDELITY_CAVEAT,
  type DeckRules,
} from './config.js';
import {
  DEFAULT_HEURISTIC_WEIGHTS,
  DEFAULT_SUGGEST_CONFIG,
  RANK_BUCKET_ORDER,
  type HeuristicWeights,
  type SuggestConfig,
} from './suggest-config.js';

// --- public shapes -------------------------------------------------------------

/** A candidate single-card swap before it has been simulated. */
export interface SwapCandidate {
  /** The card to cut (resolved id). */
  readonly outId: string;
  /** The card to add (resolved id). */
  readonly inId: string;
  readonly outName: string;
  readonly inName: string;
  /** The cheap pre-rank score (color + curve fit); higher = evaluated sooner. */
  readonly heuristicScore: number;
}

/** A candidate we generated but did NOT evaluate, with the honest reason. */
export interface SkippedCandidate {
  readonly outName: string;
  readonly inName: string;
  /** Why it was skipped: 'illegal' (would break legality) or 'capped' (budget). */
  readonly reason: 'illegal' | 'capped';
  /** For 'illegal': the legality problems; for 'capped': empty. */
  readonly details: readonly string[];
}

/** One evaluated, ranked swap recommendation: the §3.5 verdict + readable names. */
export interface RankedSwap {
  readonly rank: number;
  readonly outName: string;
  readonly inName: string;
  /** The full paired A/B verdict from the existing sim. */
  readonly evaluation: SwapEvaluation;
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
  /** Candidates generated but not evaluated (illegal / capped), for honesty. */
  readonly skipped: readonly SkippedCandidate[];
  /** Throughput + coverage notes (games run, games/sec, caveats). */
  readonly notes: SuggestionNotes;
}

/** Performance + honesty notes carried in the report (not console spam). */
export interface SuggestionNotes {
  /** Total individual games the sim played across all evaluations. */
  readonly totalGamesRun: number;
  /** Observed throughput; undefined when not timed (e.g. elapsed unknown). */
  readonly gamesPerSecond?: number;
  /** Wall-clock seconds the evaluations took, when measured. */
  readonly elapsedSeconds?: number;
  /** Candidates generated in total (evaluated + skipped). */
  readonly candidatesGenerated: number;
  /** True when the auto cap trimmed the candidate set. */
  readonly cappedByBudget: boolean;
  /** The shared fidelity caveat (`FIDELITY_CAVEAT`), carried so the UI/CLI can surface it. */
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
  /** Base RNG seed — same seed + inputs ⇒ same ranking. Required. */
  readonly baseSeed: number;
  /** Games per matchup per candidate. Defaults to `DEFAULT_SUGGEST_CONFIG`. */
  readonly gamesPerCandidate?: number;
  /** Bounds + thresholds (cap, basic-land floor). */
  readonly suggestConfig?: SuggestConfig;
  /** Cheap pre-rank heuristic weights. */
  readonly heuristicWeights?: HeuristicWeights;
  /** Deck-legality rules (4-of, min size, basics). */
  readonly deckRules?: DeckRules;
  /** Sim/stats run options threaded into `evaluateSwap`. */
  readonly runOptions?: RunOptions;
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
 * gets a cheap heuristic score (color match + curve fit) so the caller can keep
 * the most plausible top-K. Pure: no sim, no RNG — same inputs, same list.
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
        outId: outDef.id,
        inId: inDef.id,
        outName: outDef.name,
        inName: inDef.name,
        heuristicScore: scoreCandidate(inDef, deckProfile, weights),
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
 * so the bounded auto mode spends sim budget on plausible swaps. Rewards an `in`
 * card whose colored pips the deck can cast (colorMatch) and whose mana value sits
 * near the deck's curve (curveFit). The sim makes the real call.
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

/** The deck cards we may cut: each distinct entry, minus a basic-land floor. */
function resolveCuttables(
  base: Deck,
  pool: CardPool,
  rules: DeckRules,
  config: SuggestConfig,
  cutOnly: readonly string[] | undefined,
): readonly CardDefinition[] {
  const allow = cutOnly ? new Set(cutOnly.map((s) => s.toLowerCase())) : undefined;
  const out: CardDefinition[] = [];
  for (const entry of base.cards) {
    const def = pool.get(entry.cardId) ?? pool.getByName(entry.cardId);
    if (!def) continue;
    if (allow && !(allow.has(def.id.toLowerCase()) || allow.has(def.name.toLowerCase()))) continue;
    // Never cut a basic line that's already at/below the floor — it'd starve mana.
    if (rules.unlimitedCopies.has(def.name) && entry.count <= config.minBasicLandsKept) continue;
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
  for (const entry of base.cards) {
    const def = pool.get(entry.cardId) ?? pool.getByName(entry.cardId);
    if (def) counts.set(def.id, (counts.get(def.id) ?? 0) + entry.count);
  }
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
  // Final, fully-deterministic tiebreak on the swap key.
  return swapKey(a).localeCompare(swapKey(b));
}

function bucketFor(verdict: SwapVerdict): number {
  return RANK_BUCKET_ORDER[verdict];
}

function swapKey(e: SwapEvaluation): string {
  return `${e.swap.out} ${e.swap.in}`;
}

// --- the engine ----------------------------------------------------------------

/**
 * THE SUGGESTION LOOP (DESIGN §3.6).
 *
 * 1. Generate legal candidate swaps (focused or auto), pre-ranking auto ones by
 *    the cheap heuristic and recording illegal ones as skipped.
 * 2. Trim auto candidates to `maxCandidates`, recording the overflow as
 *    'capped' (honest coverage — no silent truncation).
 * 3. Evaluate each surviving candidate through the EXISTING paired A/B sim
 *    (`evaluateSwap`), on a seed derived from the base seed + the candidate key so
 *    the whole run is deterministic.
 * 4. Rank the results and assemble a `SuggestionReport` with throughput notes and
 *    the shared fidelity caveat.
 *
 * Robust: a candidate that throws (e.g. a freshly-illegal variant) is recorded as
 * skipped with its reason, not crashed on; zero valid candidates ⇒ a well-formed
 * empty report.
 */
export function suggestSwaps(base: Deck, options: SuggestOptions): SuggestionReport {
  const config = options.suggestConfig ?? DEFAULT_SUGGEST_CONFIG;
  const weights = options.heuristicWeights ?? DEFAULT_HEURISTIC_WEIGHTS;
  const rules = options.deckRules ?? DEFAULT_DECK_RULES;
  const games = options.gamesPerCandidate ?? config.defaultGamesPerCandidate;

  const generated = generateCandidates(
    base,
    options.pool,
    config,
    weights,
    rules,
    { cutOnly: options.cutOnly, inOnly: options.inOnly },
  );
  const candidates = generated.candidates;
  // Mutable: defensive 'illegal' skips from evaluation are appended here too.
  const illegalSkipped: SkippedCandidate[] = [...generated.skipped];

  // Bound the search: keep the top-K, record the rest as 'capped'.
  const evaluated = candidates.slice(0, config.maxCandidates);
  const cappedByBudget = candidates.length > evaluated.length;
  const capped: SkippedCandidate[] = candidates.slice(config.maxCandidates).map((c) => ({
    outName: c.outName,
    inName: c.inName,
    reason: 'capped' as const,
    details: [],
  }));

  const evaluations: SwapEvaluation[] = [];
  let totalGamesRun = 0;
  let baseGauntletWinRate: SwapEvaluation['baseWinRate'] | undefined;

  const start = nowSeconds();
  for (const candidate of evaluated) {
    // Per-candidate seed derived from the base seed and the STABLE candidate key,
    // so reordering candidates can't change any single evaluation's outcome.
    const candidateSeed = gameSeedFor(options.baseSeed, candidateSeedSalt(candidate));
    let evaluation: SwapEvaluation;
    try {
      evaluation = evaluateSwap(
        base,
        { out: candidate.outId, in: candidate.inId },
        options.gauntletDecks,
        options.pilots,
        games,
        candidateSeed,
        options.pool,
        options.registry,
        options.runOptions,
      );
    } catch (err) {
      // Defensive: a candidate that survived legality but still throws is recorded,
      // never allowed to abort the whole run.
      illegalSkipped.push({
        outName: candidate.outName,
        inName: candidate.inName,
        reason: 'illegal',
        details: [err instanceof Error ? err.message : String(err)],
      });
      continue;
    }
    evaluations.push(evaluation);
    // Each paired game plays BOTH the base and the variant → 2 games per pair.
    totalGamesRun += evaluation.nGames * 2;
    // The base deck's gauntlet win-rate is identical across candidates (same base,
    // same gauntlet) — capture it once for the report's reference point.
    baseGauntletWinRate ??= evaluation.baseWinRate;
  }
  const elapsedSeconds = nowSeconds() - start;

  const ranked = rankEvaluations(evaluations);
  const suggestions: RankedSwap[] = ranked.map((evaluation, i) => ({
    rank: i + 1,
    outName: evaluation.outName,
    inName: evaluation.inName,
    evaluation,
  }));

  const notes: SuggestionNotes = {
    totalGamesRun,
    elapsedSeconds: elapsedSeconds > 0 ? elapsedSeconds : undefined,
    gamesPerSecond: elapsedSeconds > 0 ? totalGamesRun / elapsedSeconds : undefined,
    candidatesGenerated: candidates.length + illegalSkipped.length,
    cappedByBudget,
    fidelityCaveat: FIDELITY_CAVEAT,
  };

  return {
    baseDeck: base.name,
    // No candidate ran (empty report) → a zero win-rate placeholder, clearly noted.
    baseGauntletWinRate: baseGauntletWinRate ?? { p: 0, low: 0, high: 0, successes: 0, n: 0 },
    candidatesEvaluated: evaluations.length,
    suggestions,
    skipped: [...illegalSkipped, ...capped],
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
