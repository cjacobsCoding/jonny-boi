/**
 * THE CANDIDATE LAYER of the suggestion engine — which swaps exist, in what order
 * we scout them, and in what order we report the ones we measured.
 *
 * Everything here is pure: no games, no RNG, no clock. That matters twice over.
 * It makes the combinatorics unit-testable on their own, and it makes the whole
 * layer runnable ANYWHERE — the web Lab runs it once inside a worker (the card
 * pool lives there) and then schedules the resulting candidates from the main
 * thread, without the main thread ever needing the pool.
 *
 * A `SwapCandidate` is therefore deliberately SELF-DESCRIBING: it carries the
 * variant deck's name and the copy count the swap moves, not just the two card
 * ids. Those two fields are what let a pooled run summarise a finished arm —
 * `summarizePairedSwap` needs them — without re-resolving cards against a pool it
 * does not have. Re-deriving them on the main thread would be exactly the kind of
 * mirrored sim logic this package exists to prevent.
 */

import type { CardDefinition } from '@jonny-boi/core';
import { convertedManaCost, type ManaColor } from '@jonny-boi/core';
import type { CardPool } from '@jonny-boi/cards';
import type { Deck } from './deck.js';
import { validateDeck } from './deck.js';
import type { CardSwap, SwapEvaluation, SwapVerdict } from './swap.js';
import { applySwap, copiesSwappedBy } from './swap.js';
import { compareForUpgrade, roleOf, type CardRole } from './card-role.js';
import { familyOf, findRoleGaps, referenceProfile, shapeOf } from './deck-shape.js';
import { SAMPLE_DECKS } from '../data/decks/index.js';
import { DEFAULT_DECK_RULES, DEFAULT_SWAP_SCOPE, type DeckRules, type SwapScope } from './config.js';
import {
  DEFAULT_HEURISTIC_WEIGHTS,
  DEFAULT_SUGGEST_CONFIG,
  RANK_BUCKET_ORDER,
  type HeuristicWeights,
  type SuggestConfig,
} from './suggest-config.js';
import type { CandidateTraits, SchedulableCandidate } from './suggest-schedule.js';
import { candidateKey } from './suggest-history.js';

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
  /**
   * The variant deck's name, exactly as `applySwap` built it under this run's
   * scope. Carried so a host that scheduled this candidate can name the result
   * without holding the card pool (see the module header).
   */
  readonly variantDeckName: string;
  /** How many copies this swap moves — 1, or the whole cut line. */
  readonly copiesSwapped: number;
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

/** Optional narrowing of the candidate space (focused mode) plus the swap scope. */
export interface CandidateGenerationOptions {
  /** FOCUSED MODE — restrict which cards may be cut (names or ids). */
  readonly cutOnly?: readonly string[];
  /** FOCUSED MODE — restrict the `in` candidates to this shortlist (names or ids). */
  readonly inOnly?: readonly string[];
  /**
   * Replace one copy or the whole playset. Must match the scope the evaluation
   * will actually use, or every candidate's `variantDeckName`/`copiesSwapped`
   * would describe a different experiment than the one that gets run.
   */
  readonly swapScope?: SwapScope;
}

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
  options: CandidateGenerationOptions = {},
): { readonly candidates: readonly SwapCandidate[]; readonly skipped: readonly SkippedCandidate[] } {
  const scope = options.swapScope ?? DEFAULT_SWAP_SCOPE;
  const deckProfile = profileDeck(base, pool);
  const cutDefs = resolveCuttables(base, pool, rules, config, options.cutOnly);
  const inDefs = resolveAddables(base, pool, rules, options.inOnly);

  const candidates: SwapCandidate[] = [];
  const skipped: SkippedCandidate[] = [];

  for (const outDef of cutDefs) {
    for (const inDef of inDefs) {
      // A swap of a card for itself is a no-op (delta 0) — never suggest it.
      if (outDef.id === inDef.id) continue;

      const swap: CardSwap = { out: outDef.id, in: inDef.id };
      let variant: Deck;
      try {
        variant = applySwap(base, swap, pool, scope);
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
        heuristicScore: scoreCandidate(inDef, deckProfile, weights, outDef),
        traits: traitsOf(inDef),
        variantDeckName: variant.name,
        copiesSwapped: copiesSwappedBy(base, swap, pool, scope),
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
  /**
   * §3.137 — jobs this deck is MISSING or thin on compared with decks like it.
   * Bringing one of these in is usually a bigger win than a marginally better
   * card, so a candidate holding one is scouted sooner.
   */
  readonly gapRoles: ReadonlySet<CardRole>;
  /** §3.137 — jobs this deck is HEAVY on: the first place to look for a cut. */
  readonly surplusRoles: ReadonlySet<CardRole>;
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
  // §3.137 — how this deck compares to decks like it. The reference is the
  // BUNDLED FIELD (the same decks a gauntlet run faces), with the deck itself
  // excluded so it cannot pull the norm toward its own shape and hide its gap.
  // Same-family when that cohort is big enough, the whole field when it is not —
  // `referenceProfile` decides and records which.
  const shape = shapeOf(base, pool);
  const reference = referenceProfile(familyOf(base, shape), SAMPLE_DECKS, pool, base.name);
  const gapRoles = new Set<CardRole>();
  const surplusRoles = new Set<CardRole>();
  for (const gap of findRoleGaps(shape, reference)) {
    if (gap.kind === 'heavy') surplusRoles.add(gap.role);
    else gapRoles.add(gap.role);
  }
  return { colors, avgSpellMv: spellCount > 0 ? mvSum / spellCount : 0, gapRoles, surplusRoles };
}

/**
 * The cheap pre-rank heuristic. NOT a strength judgement — just a relevance score
 * so the bounded auto mode scouts plausible swaps first. Rewards an `in` card whose
 * colored pips the deck can cast (colorMatch) and whose mana value sits near the
 * deck's curve (curveFit). The sim makes the real call.
 */
export function scoreCandidate(
  inDef: CardDefinition,
  profile: DeckProfile,
  weights: HeuristicWeights,
  /**
   * §3.135 — the card this candidate would REPLACE. Supplying it turns on the
   * like-for-like and no-brainer rewards; omitting it scores exactly as before,
   * so every existing caller and test keeps its meaning.
   */
  outDef?: CardDefinition,
): number {
  const pips = coloredPips(inDef);
  const castable = pips.length === 0 || pips.every((c) => profile.colors.has(c));
  const colorScore = castable ? weights.colorMatch : 0;

  const mv = inDef.cost ? convertedManaCost(inDef.cost) : 0;
  // Curve fit decays with distance from the deck's average spell MV; 1 at a perfect
  // match, approaching 0 as it drifts away (a smooth, parameter-free falloff).
  const curveScore = weights.curveFit / (1 + Math.abs(mv - profile.avgSpellMv));

  // §3.135 — the two job-aware rewards. Without an `outDef` there is no swap to
  // judge, so both are zero and the score is the original colour+curve number.
  if (outDef === undefined) return colorScore + curveScore;
  const { sameRole, strictUpgrade } = compareForUpgrade(outDef, inDef, profile.colors);
  const roleScore = sameRole ? weights.roleMatch : 0;
  const upgradeScore = strictUpgrade ? weights.strictUpgrade : 0;

  // §3.137 — and does this swap fix the deck's SHAPE? Bringing in a job the deck
  // lacks, or cutting one it has too much of, is scouted ahead of a like-for-like
  // shuffle that leaves the hole exactly where it was.
  const gapScore = profile.gapRoles.has(roleOf(inDef)) ? weights.fillsGap : 0;
  const surplusScore = profile.surplusRoles.has(roleOf(outDef)) ? weights.cutsSurplus : 0;

  return colorScore + curveScore + roleScore + upgradeScore + gapScore + surplusScore;
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
    role: roleOf(inDef),
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

// --- seeds ---------------------------------------------------------------------

/**
 * A stable non-negative integer salt for a candidate's seed, hashed (FNV-1a) from
 * its `out>in` key so a candidate's games never depend on where it happened to sit
 * in the roster.
 *
 * Exported because the parallel Lab needs the SAME salt to reproduce the CLI's
 * numbers, and a second hand-rolled copy next to the scheduler is precisely how
 * the two would drift apart while both looking correct.
 */
export function candidateSeedSalt(outId: string, inId: string): number {
  const FNV_OFFSET_BASIS = 0x811c9dc5;
  const FNV_PRIME = 0x01000193;
  let hash = FNV_OFFSET_BASIS;
  const key = candidateKey(outId, inId);
  for (let i = 0; i < key.length; i++) {
    hash = Math.imul(hash ^ key.charCodeAt(i), FNV_PRIME) >>> 0;
  }
  return hash;
}

// --- ranking -------------------------------------------------------------------

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
