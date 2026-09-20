/**
 * THE LAB TRIM (DESIGN §3.174) — "bring this deck down to N".
 *
 * > "make it so there is a way in the lab to reduce a deck down towards 60 (but
 * > this should be tunable …) where it basically tries removing certain cards,
 * > sees if the deck does better or worse with the removed cards, then if the
 * > removal made it better, it shows you that result and you can click apply. …
 * > The removals should take mana into account."
 *
 * A ROUND evaluates single-card REMOVALS of the current deck through the paired
 * A/B machinery Suggest already runs on — a removal is a swap whose in-card is
 * nothing (`SWAP_IN_NOTHING`, built by `applySwap` itself), so the arm runner,
 * the successive-halving ladder (`driveAdaptiveSearch`), the Holm correction and
 * the verdict (`finishSuggestionRun` → `decideVerdict`) are REUSED, not restated.
 * What this module adds is exactly what a trim needs and a swap search does not:
 *
 *   - the candidate set: every distinct card of the deck, cut ONE copy each (and,
 *     as the widening step, nonland+land PAIRS);
 *   - the MANA PRIOR: cutting nonlands drifts the land ratio, so `landCutDue`
 *     says, from arithmetic the panel prints, whether the next cut should be a
 *     land — and the candidates the ratio favours are scouted first;
 *   - the round VERDICT: `improved` (a removal proved better — apply it, or ask)
 *     or `exhausted` (nothing did — report every row and the most likely improving
 *     removal, the "on-the-edge" candidate, which is never applied by itself);
 *   - the auto LOOP (`trimDeck`): apply the winner, shrink by one, round again,
 *     until the target or exhaustion.
 *
 * Everything here is pure and driver-agnostic. `runTrimRound` plays a round on
 * the calling thread through `createPairedArmRunner`; the web Lab plays the same
 * plan over its worker pool and hands the outcome to the same `finishTrimRound`.
 *
 * ⚠️ What a cut cannot have (and the report says so): the matched-shuffle
 * variance reduction. A shorter library shuffles differently under the same seed
 * — see `SWAP_IN_NOTHING` — so a removal arm keeps the unbiased pairing but not
 * the "only the swapped slot differs" property, and needs more games than a swap
 * for the same confidence. The identical-game skip is therefore never live for a
 * cut, by construction; `TRIM_PAIRING_NOTE` is the one wording of this caveat.
 */

import type { CardDefinition, EffectRegistry } from '@jonny-boi/core';
import type { CardPool } from '@jonny-boi/cards';
import type { Deck, LoadedDeck } from './deck.js';
import { validateDeck } from './deck.js';
import {
  DEFAULT_DECK_RULES,
  DEFAULT_STATS_CONFIG,
  type DeckRules,
  type StatsConfig,
  type SwapScope,
} from './config.js';
import type { CardSwap, SwapEvaluation } from './swap.js';
import { applySwap, copiesSwappedBy, CUT_OUT_SEPARATOR, SWAP_IN_NOTHING, summarizePairedSwap } from './swap.js';
import type { MatchupPilots, RunOptions } from './matchup.js';
import { gameSeedFor } from './matchup.js';
import {
  DEFAULT_ADAPTIVE_CONFIG,
  DEFAULT_EXPLORATION_WEIGHTS,
  type AdaptiveSearchConfig,
} from './suggest-config.js';
import { planWaves } from './suggest-schedule.js';
import type { SkippedCandidate, SwapCandidate } from './suggest-candidates.js';
import { traitsOf } from './suggest-candidates.js';
import { candidateKey, deckFingerprint, emptyHistory } from './suggest-history.js';
import type { AdaptiveArmOutcome, AdaptiveSearchOutcome, SuggestionRunPlan } from './suggest-run.js';
import { driveAdaptiveSearch } from './suggest-run.js';
import type {
  EliminationNote,
  MultipleComparisonsReport,
  SuggestionNotes,
  WaveReport,
} from './suggest-report.js';
import { finishSuggestionRun } from './suggest-report.js';
import type { ArmHandle, PairedArmRunner, PairedArmsUsage, SwapArm } from './paired-arms.js';
import { createPairedArmRunner } from './paired-arms.js';
import type { ProportionCI } from './stats.js';

// --- the closed tables -----------------------------------------------------------

/**
 * A trim candidate cuts ONE copy. `'playset'` would ask "does this card belong
 * at all?" — a different question, answered by Suggest's focused mode. A trim
 * asks "which single card is the deck better without?", one card per round.
 */
export const TRIM_SWAP_SCOPE: SwapScope = 'one';

/**
 * How far the land count may drift ABOVE the base deck's ratio, in whole lands,
 * before the next cut is due to be a land. One land: three nonland cuts from
 * 24/60 leave 24/57, whose ratio wants 22.8 lands — 1.2 over — so the fourth
 * cut should be a land. Below one whole land there is nothing to cut yet.
 */
export const LAND_RATIO_TOLERANCE_LANDS = 1;

/**
 * The KINDS of round, in widening order — a closed table. `singles` cuts one
 * card; `pairs` cuts a nonland AND a land together, the step "keep looking"
 * widens to when no single removal improved the deck. A third step is a row
 * here plus a `CARDS_PER_CUT` entry, never a branch in the loop.
 */
export const TRIM_ROUND_KINDS = ['singles', 'pairs'] as const;
export type TrimRoundKind = (typeof TRIM_ROUND_KINDS)[number];

/** How many cards leave the deck when a candidate of each kind is applied. */
export const CARDS_PER_CUT: Readonly<Record<TrimRoundKind, number>> = Object.freeze({
  singles: 1,
  pairs: 2,
});

/** What to do when a round finds an improving removal. */
export const TRIM_ON_IMPROVEMENT = ['ask', 'auto'] as const;
export type TrimOnImprovement = (typeof TRIM_ON_IMPROVEMENT)[number];

/** What to do when a round finds NO improving removal. */
export const TRIM_ON_NO_IMPROVEMENT = ['keep-looking', 'pause'] as const;
export type TrimOnNoImprovement = (typeof TRIM_ON_NO_IMPROVEMENT)[number];

/** The user's settings for a trim session. */
export interface TrimSettings {
  /** The size to trim towards. Never below the format's `minDeckSize`. */
  readonly targetSize: number;
  readonly onImprovement: TrimOnImprovement;
  readonly onNoImprovement: TrimOnNoImprovement;
}

/**
 * Weights of the cheap PRIOR that orders a round's candidates before any game
 * is played. It decides only what is scouted first (and what makes the roster
 * when a cap bites) — never a verdict. Every term is printed per candidate.
 */
export interface TrimPriorWeights {
  /**
   * The card type the land ratio currently favours — a land when
   * `landCutDue` says one is due, a nonland otherwise. Dominates, because it
   * is the whole of "the removals should take mana into account".
   */
  readonly favouredType: number;
  /**
   * Per copy the deck holds, counted up to the format's non-basic copy limit —
   * so a 24-of basic scores as a 4-of and cannot outrank the favoured type. The
   * fourth copy of a 4-of is the classic first trim; a 1-of leaves the deck
   * entirely. A weak tiebreak under the type: `favouredType` must exceed
   * `perCopy × maxCopiesNonBasic` or the type bonus stops being one.
   */
  readonly perCopy: number;
}

/** Bounds a round obeys. Both caps REPORT when they bite (as `capped` skips). */
export interface TrimConfig {
  /**
   * Hard ceiling on candidates a round evaluates. Generous on purpose: a
   * 64-card deck of singletons is still fully covered, and the adaptive ladder
   * is what keeps a wide round affordable. Over it, the prior chooses.
   */
  readonly maxCandidatesPerRound: number;
  /**
   * Cap on nonland+land PAIRS in a widening round — the product of the two
   * classes runs to a hundred and more, and each pair is a full arm.
   */
  readonly maxPairCandidates: number;
  readonly prior: TrimPriorWeights;
}

export const DEFAULT_TRIM_CONFIG: TrimConfig = Object.freeze({
  maxCandidatesPerRound: 64,
  maxPairCandidates: 24,
  prior: Object.freeze({ favouredType: 10, perCopy: 1 }),
});

/** The in-card label of every trim row: what a cut brings in. */
export const TRIM_IN_NAME = 'nothing';

/**
 * The one wording of the pairing caveat every surface prints beside a trim
 * result (the CLI, the panel, the report's own notes).
 */
export const TRIM_PAIRING_NOTE =
  'Removal arms play a shorter library, which shuffles differently under the same seed, so they '
  + 'keep the paired comparison (same opponent, same seed, same player on the play) but not a '
  + 'swap’s matched-shuffle variance reduction — and no game can be answered for free. Expect a '
  + 'removal to need more games than a swap for the same confidence.';

/** Why the identical-game skip is reported off for a trim round, in one place. */
export const TRIM_SKIP_NOT_APPLICABLE = 'not applicable to removals — the two libraries differ in length';

// --- the mana prior ------------------------------------------------------------------

/** A deck's land count over its size. */
export interface LandRatio {
  readonly lands: number;
  readonly size: number;
}

/** Which card class the ratio favours cutting next. */
export type FavouredCut = 'land' | 'nonland';

/** `landCutDue`'s answer, with the arithmetic it used — printed, never hidden. */
export interface LandCutReading {
  readonly base: LandRatio;
  readonly current: LandRatio;
  /** Lands the CURRENT size would hold at the BASE ratio. */
  readonly ratioLands: number;
  /** `current.lands − ratioLands`: whole lands the deck carries over its ratio. */
  readonly excessLands: number;
  readonly tolerance: number;
  /** True when `excessLands ≥ tolerance`: the next cut should be a land. */
  readonly due: boolean;
  readonly favoured: FavouredCut;
  /** The arithmetic in one line, e.g. `lands 24/60 at the start → 24/57 now → …`. */
  readonly explanation: string;
}

/** `n` to one decimal, without a trailing `.0` — "22.8", "24". */
function oneDecimal(n: number): string {
  const rounded = Math.round(n * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

/** A ratio as a percentage with one decimal, for the explanation line. */
function ratioPct(ratio: LandRatio): string {
  return ratio.size > 0 ? `${((ratio.lands / ratio.size) * 100).toFixed(1)}%` : '—';
}

/**
 * IS A LAND CUT DUE? — the whole of the mana prior, as one pure function.
 *
 * The BASE deck (the deck when the session began) fixes the ratio the trim
 * preserves: `baseLands / baseSize`. At the current size that ratio wants
 * `ratioLands` lands; the deck carries `excessLands` more than that, and once
 * the excess reaches `tolerance` whole lands the next cut is due to be a land.
 * Cutting a nonland from 24/60 leaves 24/59 (0.4 over), then 24/58 (0.8 over),
 * then 24/57 (1.2 over) — due. A negative excess (the deck has FEWER lands than
 * its ratio) favours a nonland just as "not yet due" does.
 *
 * A base of size 0 has no ratio; nothing is ever due and the reading says so.
 */
export function landCutDue(
  baseLands: number,
  baseSize: number,
  currentLands: number,
  currentSize: number,
  tolerance: number = LAND_RATIO_TOLERANCE_LANDS,
): LandCutReading {
  const base: LandRatio = { lands: baseLands, size: baseSize };
  const current: LandRatio = { lands: currentLands, size: currentSize };
  const ratioLands = baseSize > 0 ? (baseLands / baseSize) * currentSize : 0;
  const excessLands = baseSize > 0 ? currentLands - ratioLands : 0;
  const due = baseSize > 0 && excessLands >= tolerance;
  const favoured: FavouredCut = due ? 'land' : 'nonland';

  const opening = `lands ${base.lands}/${base.size} at the start (${ratioPct(base)})`;
  const now =
    current.size === base.size && current.lands === base.lands
      ? 'unchanged so far'
      : `${current.lands}/${current.size} now (${ratioPct(current)})`;
  const arithmetic =
    baseSize > 0
      ? `${oneDecimal(ratioLands)} lands would keep that ratio → ` +
        `${excessLands >= 0 ? oneDecimal(excessLands) + ' over' : oneDecimal(-excessLands) + ' under'} ` +
        `(a land cut is due at ${tolerance} over)`
      : 'the base deck has no cards, so no ratio to keep';
  const call = due ? 'a land cut is due' : 'no land cut due yet — a nonland goes first';

  return {
    base,
    current,
    ratioLands,
    excessLands,
    tolerance,
    due,
    favoured,
    explanation: `${opening} → ${now} → ${arithmetic} → ${call}`,
  };
}

/** Whether a compiled card is a land — the one test every trim decision uses. */
export function isLandCard(def: CardDefinition): boolean {
  return def.types.includes('land');
}

/** A deck's land ratio, read against the pool (unresolvable entries count as nonlands). */
export function landRatioOf(deck: Deck, pool: CardPool): LandRatio {
  let lands = 0;
  let size = 0;
  for (const entry of deck.cards) {
    size += entry.count;
    const def = resolveEntry(pool, entry);
    if (def && isLandCard(def)) lands += entry.count;
  }
  return { lands, size };
}

/** Total copies in a deck. */
export function deckSizeOf(deck: Deck): number {
  return deck.cards.reduce((sum, entry) => sum + entry.count, 0);
}

function resolveEntry(pool: CardPool, entry: Deck['cards'][number]): CardDefinition | undefined {
  return (
    pool.get(entry.cardId) ??
    (entry.name !== undefined ? pool.getByName(entry.name) : undefined) ??
    pool.getByName(entry.cardId)
  );
}

// --- candidates -------------------------------------------------------------------------

/** One card a candidate removes. */
export interface TrimCut {
  readonly cardId: string;
  readonly name: string;
  readonly isLand: boolean;
}

/**
 * A trim candidate IS a `SwapCandidate` (in-card: nothing), so the wave ladder
 * schedules it unchanged, plus what a trim row needs to describe itself.
 */
export interface TrimCandidate extends SwapCandidate {
  readonly cuts: readonly TrimCut[];
  readonly roundKind: TrimRoundKind;
  /** The deck's size once this candidate is applied. */
  readonly sizeAfter: number;
  /** The prior's terms, best-first, so the report can say why it was scouted where it was. */
  readonly priorReasons: readonly string[];
}

/** A plan's roster entry narrowed back to a trim candidate (it survives `postMessage` as data). */
export function isTrimCandidate(candidate: SwapCandidate): candidate is TrimCandidate {
  return Array.isArray((candidate as TrimCandidate).cuts) && typeof (candidate as TrimCandidate).sizeAfter === 'number';
}

/** Options for one round's candidate set. */
export interface TrimCandidateOptions {
  readonly kind: TrimRoundKind;
  /** The mana prior's reading for the current deck. */
  readonly reading: LandCutReading;
  readonly rules?: DeckRules;
  readonly config?: TrimConfig;
}

/** The distinct cards of a deck with their copy counts, in decklist order. */
function distinctCards(base: Deck, pool: CardPool): { readonly def: CardDefinition; count: number }[] {
  const byId = new Map<string, { readonly def: CardDefinition; count: number }>();
  for (const entry of base.cards) {
    const def = resolveEntry(pool, entry);
    if (!def) continue;
    const tally = byId.get(def.id);
    if (tally) tally.count += entry.count;
    else byId.set(def.id, { def, count: entry.count });
  }
  return [...byId.values()];
}

/** The label a row prints for its cuts: "Swamp", or "Craw Wurm + Forest". */
export function describeCuts(cuts: readonly TrimCut[]): string {
  return cuts.map((cut) => cut.name).join(' + ');
}

/**
 * Enumerate a round's removal candidates, in prior order.
 *
 * `singles`: every distinct card, cut one copy. `pairs`: every (nonland, land)
 * pair, cut one copy of each, capped by `maxPairCandidates` after the prior has
 * ordered them (the rest are reported `capped`). Legality is the truth, not a
 * copy of the size rule: the variant is BUILT (`applySwap`, the one funnel) and
 * `validateDeck` decides — a cut that would take the deck under `minDeckSize`
 * comes back `illegal`, never crashed on.
 *
 * ⚠️ No basic-land floor, unlike Suggest's cut set. Suggest keeps eight of each
 * basic so a swap cannot gut a manabase; a trim's whole job includes cutting
 * the dead basic (three Swamps in a mono-green deck), and the land-ratio prior
 * is what keeps the manabase honest here instead.
 */
export function generateTrimCandidates(
  base: Deck,
  pool: CardPool,
  options: TrimCandidateOptions,
): { readonly candidates: readonly TrimCandidate[]; readonly skipped: readonly SkippedCandidate[] } {
  const rules = options.rules ?? DEFAULT_DECK_RULES;
  const config = options.config ?? DEFAULT_TRIM_CONFIG;
  const size = deckSizeOf(base);
  const cards = distinctCards(base, pool);

  /** Build one candidate from the cards it cuts, or record why it cannot be. */
  const build = (
    parts: readonly { readonly def: CardDefinition; readonly count: number }[],
    skipped: SkippedCandidate[],
  ): TrimCandidate | undefined => {
    const cuts: TrimCut[] = parts.map(({ def }) => ({ cardId: def.id, name: def.name, isLand: isLandCard(def) }));
    const label = describeCuts(cuts);
    const swap: CardSwap = { out: parts.map((p) => p.def.id).join(CUT_OUT_SEPARATOR), in: SWAP_IN_NOTHING };
    let variant: Deck;
    try {
      variant = applySwap(base, swap, pool, TRIM_SWAP_SCOPE);
    } catch (err) {
      skipped.push({ outName: label, inName: TRIM_IN_NAME, reason: 'illegal', details: [String(err instanceof Error ? err.message : err)] });
      return undefined;
    }
    const problems = validateDeck(variant, pool, rules);
    if (problems.length > 0) {
      skipped.push({ outName: label, inName: TRIM_IN_NAME, reason: 'illegal', details: problems });
      return undefined;
    }
    const { score, reasons } = priorOf(parts, options.reading, config.prior, rules.maxCopiesNonBasic);
    const first = parts[0] as { readonly def: CardDefinition; readonly count: number };
    return {
      key: candidateKey(swap.out, swap.in),
      outId: swap.out,
      inId: swap.in,
      outName: label,
      inName: TRIM_IN_NAME,
      heuristicScore: score,
      traits: traitsOf(first.def),
      variantDeckName: variant.name,
      copiesSwapped: copiesSwappedBy(base, swap, pool, TRIM_SWAP_SCOPE),
      cuts,
      roundKind: options.kind,
      sizeAfter: size - CARDS_PER_CUT[options.kind],
      priorReasons: reasons,
    };
  };

  const skipped: SkippedCandidate[] = [];
  const candidates: TrimCandidate[] = [];

  if (options.kind === 'singles') {
    for (const card of cards) {
      const candidate = build([card], skipped);
      if (candidate) candidates.push(candidate);
    }
  } else {
    const nonlands = cards.filter((c) => !isLandCard(c.def));
    const lands = cards.filter((c) => isLandCard(c.def));
    for (const nonland of nonlands) {
      for (const land of lands) {
        const candidate = build([nonland, land], skipped);
        if (candidate) candidates.push(candidate);
      }
    }
  }

  candidates.sort(comparePrior);
  const cap = options.kind === 'pairs' ? Math.min(config.maxPairCandidates, config.maxCandidatesPerRound) : config.maxCandidatesPerRound;
  const kept = candidates.slice(0, cap);
  for (const dropped of candidates.slice(cap)) {
    skipped.push({ outName: dropped.outName, inName: TRIM_IN_NAME, reason: 'capped', details: dropped.priorReasons });
  }
  return { candidates: kept, skipped };
}

/** The prior: the class the ratio favours, then copies held. Every term named. */
function priorOf(
  parts: readonly { readonly def: CardDefinition; readonly count: number }[],
  reading: LandCutReading,
  weights: TrimPriorWeights,
  copiesCap: number,
): { readonly score: number; readonly reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];
  const favoursLand = reading.favoured === 'land';
  for (const { def, count } of parts) {
    const land = isLandCard(def);
    if (land === favoursLand) {
      score += weights.favouredType;
      reasons.push(land ? 'a land, and a land cut is due' : 'a nonland, and no land cut is due');
    }
    score += Math.min(count, copiesCap) * weights.perCopy;
    reasons.push(`${count} ${count === 1 ? 'copy' : 'copies'} in the deck`);
  }
  return { score, reasons };
}

/** Higher prior first; ties by name, then key — deterministic on every host. */
function comparePrior(a: TrimCandidate, b: TrimCandidate): number {
  if (b.heuristicScore !== a.heuristicScore) return b.heuristicScore - a.heuristicScore;
  if (a.outName !== b.outName) return a.outName < b.outName ? -1 : 1;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

// --- the round plan ---------------------------------------------------------------------

/** What `prepareTrimRound` needs — everything except the games. */
export interface PrepareTrimRoundOptions {
  readonly pool: CardPool;
  readonly opponentCount: number;
  readonly baseSeed: number;
  /**
   * Which round of the session this is (0 for the first). Offsets the seed so
   * consecutive rounds play DIFFERENT games — the same candidates on a deck one
   * card smaller would otherwise re-run on the same shuffles and inherit the
   * previous round's luck.
   */
  readonly round: number;
  readonly gamesPerCandidate: number;
  readonly roundKind: TrimRoundKind;
  readonly targetSize: number;
  /**
   * The land ratio of the deck when the SESSION began. Omitted on the first
   * round, when the deck being trimmed is the base.
   */
  readonly baseLandRatio?: LandRatio;
  readonly deckRules?: DeckRules;
  readonly adaptiveConfig?: AdaptiveSearchConfig;
  readonly trimConfig?: TrimConfig;
}

/** Everything decided before a game is played. Plain data (it crosses `postMessage`). */
export interface TrimRoundPlan {
  /** The wave-ladder plan the adaptive search drives — its roster is `candidates`. */
  readonly plan: SuggestionRunPlan;
  readonly candidates: readonly TrimCandidate[];
  readonly reading: LandCutReading;
  readonly roundKind: TrimRoundKind;
  readonly round: number;
  readonly targetSize: number;
  readonly deckSize: number;
  readonly cardsPerCut: number;
}

/**
 * Plan one round: read the land ratio, enumerate the candidates in prior
 * order, and lay the wave ladder over them. Refuses (throws, with the reason)
 * a target under the format minimum, a deck already at or under the target, and
 * a round kind whose cut would overshoot the target — every one of those is a
 * caller error the UI guards against, and a silent plan would be worse.
 */
export function prepareTrimRound(base: Deck, options: PrepareTrimRoundOptions): TrimRoundPlan {
  const rules = options.deckRules ?? DEFAULT_DECK_RULES;
  const adaptiveConfig = options.adaptiveConfig ?? DEFAULT_ADAPTIVE_CONFIG;
  const deckSize = deckSizeOf(base);
  const cardsPerCut = CARDS_PER_CUT[options.roundKind];

  if (!Number.isInteger(options.targetSize) || options.targetSize < rules.minDeckSize) {
    throw new Error(`the trim target (${options.targetSize}) may not go below the format minimum of ${rules.minDeckSize}`);
  }
  if (deckSize <= options.targetSize) {
    throw new Error(`"${base.name}" is ${deckSize} cards — already at or below the target of ${options.targetSize}`);
  }
  if (deckSize - cardsPerCut < options.targetSize) {
    throw new Error(
      `a ${options.roundKind} round cuts ${cardsPerCut} cards, which would take ${deckSize} under the target of ${options.targetSize}`,
    );
  }

  const current = landRatioOf(base, options.pool);
  const baseRatio = options.baseLandRatio ?? current;
  const reading = landCutDue(baseRatio.lands, baseRatio.size, current.lands, current.size);

  const generated = generateTrimCandidates(base, options.pool, {
    kind: options.roundKind,
    reading,
    rules,
    ...(options.trimConfig ? { config: options.trimConfig } : {}),
  });

  const runSeed = options.round === 0 ? options.baseSeed : gameSeedFor(options.baseSeed, options.round);
  const maxPairedGames = Math.max(0, options.gamesPerCandidate) * Math.max(0, options.opponentCount);

  const plan: SuggestionRunPlan = {
    baseDeckName: base.name,
    deckFingerprint: deckFingerprint(base),
    roster: generated.candidates,
    // No reserves: offspring selection reasons over in-card traits, and every
    // trim candidate shares the same in-card. What the cap left out is reported.
    reserves: [],
    skipped: generated.skipped,
    candidatesGenerated: generated.candidates.length + generated.skipped.length,
    // Each round is a new deck, so each round is its own family; no cross-run record.
    history: emptyHistory(base),
    runSeed,
    opponentCount: options.opponentCount,
    maxPairedGames,
    waves: planWaves(generated.candidates.length, maxPairedGames, adaptiveConfig),
  };

  return {
    plan,
    candidates: generated.candidates,
    reading,
    roundKind: options.roundKind,
    round: options.round,
    targetSize: options.targetSize,
    deckSize,
    cardsPerCut,
  };
}

// --- the round report ------------------------------------------------------------------

/** One evaluated removal, ranked — the trim's view of a `RankedSwap`. */
export interface TrimRow {
  readonly rank: number;
  readonly key: string;
  readonly cuts: readonly TrimCut[];
  /** "Swamp", or "Craw Wurm + Forest". */
  readonly label: string;
  readonly sizeAfter: number;
  /** The paired verdict; `verdict` is the Holm-corrected call. */
  readonly evaluation: SwapEvaluation;
  readonly gamesPlayed: number;
  readonly rawPValue: number;
  readonly adjustedPValue: number;
  readonly elimination?: EliminationNote;
  readonly priorReasons: readonly string[];
}

/** A round's outcome: a removal proved better, or none did. */
export type TrimRoundVerdict = 'improved' | 'exhausted';

/** What one round of trimming found. */
export interface TrimRoundReport {
  readonly deckName: string;
  readonly deckFingerprint: string;
  readonly deckSize: number;
  readonly targetSize: number;
  readonly round: number;
  readonly roundKind: TrimRoundKind;
  readonly cardsPerCut: number;
  /** The mana prior's reading, with its arithmetic. */
  readonly reading: LandCutReading;
  readonly verdict: TrimRoundVerdict;
  /** Every removal evaluated, ranked better → inconclusive → worse. */
  readonly rows: readonly TrimRow[];
  /** The removal to apply — present iff `verdict` is `improved`. */
  readonly winner?: TrimRow;
  /**
   * "The most likely improving removal": the best delta among the INCONCLUSIVE
   * rows, present iff `verdict` is `exhausted` and such a row exists. It is
   * offered, labelled on-the-edge, and NEVER applied by the engine itself.
   */
  readonly edgeCandidate?: TrimRow;
  /** The base deck's win rate over the deepest arm's games. */
  readonly baseWinRate: ProportionCI;
  readonly candidatesEvaluated: number;
  readonly skipped: readonly SkippedCandidate[];
  readonly waves: readonly WaveReport[];
  readonly multipleComparisons: MultipleComparisonsReport;
  readonly notes: SuggestionNotes;
  /** `TRIM_PAIRING_NOTE`, carried so every surface prints the one wording. */
  readonly pairingNote: string;
}

/** What a driver hands back for assembly — the search's outcome and its usage. */
export interface FinishTrimRoundInput {
  readonly round: TrimRoundPlan;
  readonly outcome: AdaptiveSearchOutcome;
  readonly usage: PairedArmsUsage;
  readonly elapsedSeconds: number;
  readonly stats?: StatsConfig;
  readonly adaptiveConfig?: AdaptiveSearchConfig;
  /** How many workers played the games; omitted means single-threaded. */
  readonly workersUsed?: number;
}

/**
 * Turn a finished search into the round's report.
 *
 * Every statistic is the shared one: each arm's cumulative table becomes a
 * `SwapEvaluation` through `summarizePairedSwap`, and `finishSuggestionRun`
 * applies the Holm correction over the round's family and re-decides every
 * verdict — the same code path a Suggest run's verdicts take. This function
 * only reads the result back as removals: the winner is the top-ranked row
 * proved better; the edge candidate is the best-delta inconclusive row.
 */
export function finishTrimRound(input: FinishTrimRoundInput): TrimRoundReport {
  const { round, outcome } = input;
  const stats = input.stats ?? DEFAULT_STATS_CONFIG;
  const adaptiveConfig = input.adaptiveConfig ?? DEFAULT_ADAPTIVE_CONFIG;
  const byKey = new Map<string, TrimCandidate>();
  for (const candidate of round.candidates) byKey.set(candidate.key, candidate);

  const report = finishSuggestionRun({
    baseDeckName: round.plan.baseDeckName,
    search: {
      outcomes: outcome.arms.map((arm) => ({
        candidate: arm.candidate,
        evaluation: summarizePairedSwap({
          baseDeckName: round.plan.baseDeckName,
          variantDeckName: arm.candidate.variantDeckName,
          swap: { out: arm.candidate.outId, in: arm.candidate.inId },
          outName: arm.candidate.outName,
          inName: arm.candidate.inName,
          paired: arm.paired,
          stats,
          scope: TRIM_SWAP_SCOPE,
          copiesSwapped: arm.candidate.copiesSwapped,
        }),
        gamesPlayed: arm.gamesPlayed,
        ...(arm.elimination ? { elimination: arm.elimination } : {}),
      })),
      waves: outcome.waves,
      // A cut can never be answered for free (see `SWAP_IN_NOTHING`); say so in
      // the one place the note is read, whatever the runner decided for the run.
      usage: {
        ...input.usage,
        identicalGameSkipEnabled: false,
        identicalGameSkipDisabledReason: TRIM_SKIP_NOT_APPLICABLE,
      },
      failures: outcome.failures,
      fixedSchemeGames: outcome.fixedSchemeGames,
    },
    skipped: [...round.plan.skipped, ...outcome.failures],
    candidatesGenerated: round.plan.candidatesGenerated,
    cappedByBudget: round.plan.skipped.some((s) => s.reason === 'capped'),
    elapsedSeconds: input.elapsedSeconds,
    history: round.plan.history,
    method: adaptiveConfig.multipleComparisons,
    exploration: DEFAULT_EXPLORATION_WEIGHTS,
    stats,
    ...(input.workersUsed !== undefined ? { workersUsed: input.workersUsed } : {}),
  });

  const rows: TrimRow[] = [];
  for (const suggestion of report.suggestions) {
    const key = candidateKey(suggestion.evaluation.swap.out, suggestion.evaluation.swap.in);
    const candidate = byKey.get(key);
    if (!candidate) continue; // cannot happen: every outcome came from the roster
    rows.push({
      rank: suggestion.rank,
      key,
      cuts: candidate.cuts,
      label: candidate.outName,
      sizeAfter: candidate.sizeAfter,
      evaluation: suggestion.evaluation,
      gamesPlayed: suggestion.gamesPlayed,
      rawPValue: suggestion.rawPValue,
      adjustedPValue: suggestion.adjustedPValue,
      ...(suggestion.elimination ? { elimination: suggestion.elimination } : {}),
      priorReasons: candidate.priorReasons,
    });
  }

  // The ranking already puts proven-better first by delta, then the inconclusive
  // by delta — so "first of its verdict" IS "best of its verdict".
  const winner = rows.find((row) => row.evaluation.verdict === 'better');
  const edge = winner ? undefined : rows.find((row) => row.evaluation.verdict === 'inconclusive');
  // The base arm is shared, so the deepest arm's base rate is the best-measured one.
  const deepest = rows.reduce<TrimRow | undefined>(
    (best, row) => (best === undefined || row.evaluation.nGames > best.evaluation.nGames ? row : best),
    undefined,
  );

  return {
    deckName: round.plan.baseDeckName,
    deckFingerprint: round.plan.deckFingerprint,
    deckSize: round.deckSize,
    targetSize: round.targetSize,
    round: round.round,
    roundKind: round.roundKind,
    cardsPerCut: round.cardsPerCut,
    reading: round.reading,
    verdict: winner ? 'improved' : 'exhausted',
    rows,
    ...(winner ? { winner } : {}),
    ...(edge ? { edgeCandidate: edge } : {}),
    baseWinRate: deepest?.evaluation.baseWinRate ?? report.baseGauntletWinRate,
    candidatesEvaluated: report.candidatesEvaluated,
    skipped: report.skipped,
    waves: report.waves,
    multipleComparisons: report.multipleComparisons,
    notes: report.notes,
    pairingNote: TRIM_PAIRING_NOTE,
  };
}

// --- applying a removal -------------------------------------------------------------------

/**
 * Apply a removal to a deck — the same `applySwap` funnel that built the arm's
 * variant, so the deck the user ends up with is byte-for-byte the deck that was
 * tested. The deck keeps its own name (the variant's name records the cut, which
 * is right for a test and wrong for the deck itself).
 */
export function applyTrimCut(deck: Deck, cuts: readonly TrimCut[], pool: CardPool): Deck {
  const swap: CardSwap = { out: cuts.map((cut) => cut.cardId).join(CUT_OUT_SEPARATOR), in: SWAP_IN_NOTHING };
  return { ...applySwap(deck, swap, pool, TRIM_SWAP_SCOPE), name: deck.name };
}

/**
 * The next round kind to widen to when a round found nothing — the row after
 * `kind` in `TRIM_ROUND_KINDS` whose cut still fits above the target — or
 * `undefined` when there is nothing left to widen to (exhaustion is final).
 */
export function nextWideningStep(kind: TrimRoundKind, deckSize: number, targetSize: number): TrimRoundKind | undefined {
  const index = TRIM_ROUND_KINDS.indexOf(kind);
  for (const next of TRIM_ROUND_KINDS.slice(index + 1)) {
    if (deckSize - CARDS_PER_CUT[next] >= targetSize) return next;
  }
  return undefined;
}

// --- playing a round on the calling thread ---------------------------------------------

/**
 * The slice of a `PairedArmRunner` a local round needs. Narrow on purpose: a
 * test rigs one of these with fabricated tallies to prove the LOOP — the
 * verdict, the apply, the shrink, the stop — without the statistics being
 * hostage to what a few dozen real games happen to say.
 */
export type TrimArmRunner = Pick<PairedArmRunner, 'openArm' | 'advance' | 'usage'>;

/** Progress callbacks for a local round. */
export interface TrimProgress {
  readonly onWave?: (info: { readonly wave: number; readonly totalWaves: number; readonly candidates: number }) => void;
  readonly onGame?: (games: number) => void;
}

/** Everything a local round needs beyond the plan. */
export interface RunTrimRoundOptions extends Omit<PrepareTrimRoundOptions, 'opponentCount'> {
  readonly gauntletDecks: readonly LoadedDeck[];
  readonly pilots: MatchupPilots;
  readonly registry: EffectRegistry;
  readonly runOptions?: RunOptions;
  readonly stats?: StatsConfig;
  readonly onProgress?: TrimProgress;
  /**
   * Where the games are played. Defaults to a real `createPairedArmRunner` over
   * the gauntlet; a test supplies a rigged runner. Called once per round with
   * the plan, so a rig can key its answers on the round's deck.
   */
  readonly armRunner?: (base: Deck, round: TrimRoundPlan) => TrimArmRunner;
}

/**
 * Drive one round's wave ladder on the calling thread — the sequential
 * counterpart of the Lab's pooled driver, over the SAME generator. Nothing
 * here decides who survives; `driveAdaptiveSearch` does.
 */
export function driveTrimRound(
  round: TrimRoundPlan,
  runner: TrimArmRunner,
  settings: { readonly adaptiveConfig?: AdaptiveSearchConfig; readonly stats?: StatsConfig } = {},
  progress?: TrimProgress,
): { readonly outcome: AdaptiveSearchOutcome; readonly usage: PairedArmsUsage } {
  const handles = new Map<string, ArmHandle>();
  const driver = driveAdaptiveSearch(round.plan, {
    adaptiveConfig: settings.adaptiveConfig ?? DEFAULT_ADAPTIVE_CONFIG,
    explorationWeights: DEFAULT_EXPLORATION_WEIGHTS,
    stats: settings.stats ?? DEFAULT_STATS_CONFIG,
  });

  let step = driver.next();
  while (!step.done) {
    const wave = step.value;
    progress?.onWave?.({ wave: wave.wave, totalWaves: round.plan.waves.length, candidates: wave.arms.length });
    const answers: AdaptiveArmOutcome[] = [];
    for (const request of wave.arms) {
      const candidate = request.candidate;
      let handle = handles.get(candidate.key);
      if (!handle) {
        try {
          handle = runner.openArm({ out: candidate.outId, in: candidate.inId }, candidate.outName, candidate.inName);
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
      const arm: SwapArm = runner.advance(handle, request.toGames);
      answers.push({
        key: candidate.key,
        gamesPlayed: arm.gamesPlayed,
        paired: arm.paired,
        variantWonBySlot: arm.variantWonBySlot,
      });
    }
    step = driver.next({ arms: answers });
  }
  return { outcome: step.value, usage: runner.usage() };
}

/**
 * Play ONE round on the calling thread: plan → ladder → report.
 */
export function runTrimRound(base: Deck, options: RunTrimRoundOptions): TrimRoundReport {
  const round = prepareTrimRound(base, { ...options, opponentCount: options.gauntletDecks.length });
  const runner =
    options.armRunner?.(base, round) ??
    createPairedArmRunner(base, {
      gauntletDecks: options.gauntletDecks,
      pilots: options.pilots,
      pool: options.pool,
      registry: options.registry,
      seed: round.plan.runSeed,
      deckRules: options.deckRules ?? DEFAULT_DECK_RULES,
      // ONE copy per cut — the runner's `applySwap` must build the same variant
      // the candidate generator validated.
      runOptions: { ...options.runOptions, swapScope: TRIM_SWAP_SCOPE },
      ...(options.onProgress?.onGame ? { onGame: options.onProgress.onGame } : {}),
    });
  const started = Date.now();
  const { outcome, usage } = driveTrimRound(
    round,
    runner,
    { ...(options.adaptiveConfig ? { adaptiveConfig: options.adaptiveConfig } : {}), ...(options.stats ? { stats: options.stats } : {}) },
    options.onProgress,
  );
  return finishTrimRound({
    round,
    outcome,
    usage,
    elapsedSeconds: (Date.now() - started) / 1000,
    ...(options.stats ? { stats: options.stats } : {}),
    ...(options.adaptiveConfig ? { adaptiveConfig: options.adaptiveConfig } : {}),
  });
}

// --- the session loop -----------------------------------------------------------------

/** Why a trim session stopped. */
export type TrimStopReason =
  /** The deck reached the target. */
  | 'target-reached'
  /** A round improved the deck and the settings say ask — the caller applies (or not). */
  | 'awaiting-apply'
  /** No removal improved the deck and nothing is left to widen to (or the settings say pause). */
  | 'exhausted';

/** A session's result: the deck as it stands, every round, and why it stopped. */
export interface TrimSessionResult {
  readonly deck: Deck;
  readonly rounds: readonly TrimRoundReport[];
  /** The removals applied, in order. */
  readonly applied: readonly TrimRow[];
  readonly stopped: TrimStopReason;
}

/** Options for a whole session — the round options minus what the loop decides. */
export interface TrimSessionOptions extends Omit<RunTrimRoundOptions, 'round' | 'roundKind' | 'baseLandRatio' | 'targetSize'> {
  readonly settings: TrimSettings;
  /** Called after each round, so a long session can say where it is. */
  readonly onRound?: (report: TrimRoundReport) => void;
}

/**
 * THE AUTO LOOP: round, apply the winner, shrink by one, round again — until
 * the target, or until no removal improves the deck and there is nothing left
 * to widen to. Under `ask` it returns after the first improving round with the
 * winner unapplied. Nothing on-the-edge is ever applied here.
 *
 * The base land ratio is read ONCE, from the deck the session began with, so
 * the prior measures drift from where the user started — not from the previous
 * round.
 */
export function trimDeck(base: Deck, options: TrimSessionOptions): TrimSessionResult {
  const { settings } = options;
  const baseLandRatio = landRatioOf(base, options.pool);
  const rounds: TrimRoundReport[] = [];
  const applied: TrimRow[] = [];
  let deck = base;
  let round = 0;
  let kind: TrimRoundKind = TRIM_ROUND_KINDS[0];

  while (deckSizeOf(deck) > settings.targetSize) {
    const report = runTrimRound(deck, { ...options, round, roundKind: kind, targetSize: settings.targetSize, baseLandRatio });
    rounds.push(report);
    options.onRound?.(report);
    round += 1;

    if (report.verdict === 'improved' && report.winner) {
      if (settings.onImprovement === 'ask') return { deck, rounds, applied, stopped: 'awaiting-apply' };
      deck = applyTrimCut(deck, report.winner.cuts, options.pool);
      applied.push(report.winner);
      kind = TRIM_ROUND_KINDS[0];
      continue;
    }

    const next: TrimRoundKind | undefined =
      settings.onNoImprovement === 'keep-looking' ? nextWideningStep(kind, deckSizeOf(deck), settings.targetSize) : undefined;
    if (next === undefined) return { deck, rounds, applied, stopped: 'exhausted' };
    kind = next;
  }
  return { deck, rounds, applied, stopped: 'target-reached' };
}
