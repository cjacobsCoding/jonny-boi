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
import {
  applySwap,
  copiesSwappedBy,
  CUT_OUT_SEPARATOR,
  SWAP_IN_NOTHING,
  summarizePairedSwap,
  SWAP_VERDICT_REASON_BY_KEY,
} from './swap.js';
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
 * THE CUT SIZES a trim round may run, in widening order — ONE closed table with
 * one row per size (DESIGN §3.180).
 *
 * ⚠️ WHY THE SIZE IS THE TABLE AND THE KIND NAME IS DERIVED FROM IT. The cut
 * SIZE is the real axis: a round cuts k cards, the deck shrinks by k, and the
 * mana prior reads the ratio k cards later. The kind NAME is only a label for k.
 * Before §3.180 the two were separate facts — `TRIM_ROUND_KINDS` listed the
 * names and `CARDS_PER_CUT` mapped each name to its k — so adding a size meant
 * editing two tables that could disagree about the same question. Now a new size
 * is ONE row here and every other shape is derived from it; `trim.test.ts`
 * asserts the derivations cannot drift from these rows.
 *
 * `noun` is the coverage line's wording, so "48 of 595 two-card cuts tried" is
 * written once here rather than assembled by whichever surface prints it.
 */
export interface TrimCutSizeRow {
  /** How many cards leave the deck when a candidate of this size is applied. */
  readonly cardsPerCut: number;
  /** The round-kind label this size is known by, in reports and in the panel. */
  readonly kind: string;
  /** The plural noun the coverage line uses: "two-card cuts". */
  readonly noun: string;
}

export const TRIM_CUT_SIZE_ROWS = [
  { cardsPerCut: 1, kind: 'singles', noun: 'single-card cuts' },
  { cardsPerCut: 2, kind: 'pairs', noun: 'two-card cuts' },
  { cardsPerCut: 3, kind: 'triples', noun: 'three-card cuts' },
  { cardsPerCut: 4, kind: 'quads', noun: 'four-card cuts' },
] as const;

export type TrimRoundKind = (typeof TRIM_CUT_SIZE_ROWS)[number]['kind'];

/**
 * The kinds, in widening order. DERIVED — kept under its original name because
 * the CLI, the Lab's own driver and two test files already read it.
 */
export const TRIM_ROUND_KINDS: readonly TrimRoundKind[] = TRIM_CUT_SIZE_ROWS.map((row) => row.kind);

/**
 * The cheapest kind — where every ladder starts, and where it returns after a
 * cut lands. Derived from row 0 so "the first kind" has one answer.
 */
export const TRIM_FIRST_ROUND_KIND: TrimRoundKind = TRIM_CUT_SIZE_ROWS[0].kind;

/** How many cards leave the deck when a candidate of each kind is applied. DERIVED. */
export const CARDS_PER_CUT: Readonly<Record<TrimRoundKind, number>> = Object.freeze(
  Object.fromEntries(TRIM_CUT_SIZE_ROWS.map((row) => [row.kind, row.cardsPerCut])),
) as Readonly<Record<TrimRoundKind, number>>;

/** Each kind's whole row, for the surfaces that need its wording. DERIVED. */
export const TRIM_CUT_SIZE_ROW_BY_KIND: Readonly<Record<TrimRoundKind, TrimCutSizeRow>> = Object.freeze(
  Object.fromEntries(TRIM_CUT_SIZE_ROWS.map((row) => [row.kind, row])),
) as Readonly<Record<TrimRoundKind, TrimCutSizeRow>>;

/**
 * The largest cut the table can express. A `maxCardsPerCut` above this is
 * clamped and the clamp is REPORTED (`TrimSettings.maxCardsPerCut`) — the
 * closed-table rule: a value outside the table says so rather than being
 * widened to the nearest thing that happens to exist.
 */
export const TRIM_MAX_CUT_SIZE: number = TRIM_CUT_SIZE_ROWS[TRIM_CUT_SIZE_ROWS.length - 1]?.cardsPerCut ?? 1;

/**
 * The kind whose cut is exactly `cardsPerCut`, or `undefined` when the table has
 * no such row. The closed-table read: nothing is approximated to a neighbour.
 */
export function trimKindForCutSize(cardsPerCut: number): TrimRoundKind | undefined {
  return TRIM_CUT_SIZE_ROWS.find((row) => row.cardsPerCut === cardsPerCut)?.kind;
}

/** What to do when a round finds an improving removal. */
export const TRIM_ON_IMPROVEMENT = ['ask', 'auto'] as const;
export type TrimOnImprovement = (typeof TRIM_ON_IMPROVEMENT)[number];

/** What to do when a round finds NO improving removal. */
export const TRIM_ON_NO_IMPROVEMENT = ['keep-looking', 'pause'] as const;
export type TrimOnNoImprovement = (typeof TRIM_ON_NO_IMPROVEMENT)[number];

/**
 * THE DEEPENING LADDER (DESIGN §3.179) — the lever after the KINDS run out.
 *
 * ⚠️ THE BUG THIS REPLACES. `keep-looking` used to widen through
 * `TRIM_ROUND_KINDS` and treat the end of that two-row table as the end of the
 * search, so it got exactly TWO rounds and then reported `exhausted` — the
 * "couple waves then stop" Caleb reported. The table is fine; reading the end of
 * it as the end of the search was the defect.
 *
 * When a round ends with no winner, is still UNSURE (some row could yet be
 * settled by more games) and the kinds are spent, the answer is not more kinds —
 * it is more DEPTH on the same question. `gamesPerCandidate` grows by `factor`
 * up to `maxGamesPerCandidate`, and the kind ladder resets so the singles get
 * re-asked at a depth that can actually answer them.
 *
 * ⚠️ WHY THE WHOLE ROUND DEEPENS AND NOT A HAND-PICKED SHORTLIST.
 * `driveAdaptiveSearch` is successive halving: a bigger round budget is already
 * spent preferentially on the survivors. A second site choosing which candidates
 * deserve depth would be a second answer to a question the ladder already
 * answers, and the two would drift.
 */
export const TRIM_DEEPEN = Object.freeze({
  /** Multiply `gamesPerCandidate` by this each time a round ends unsure. */
  factor: 2,
  /**
   * The hard ceiling on per-candidate depth. Past this the paired A/B is not the
   * thing that is short — the effect is smaller than the Lab is built to see —
   * and saying so is more useful than spending another hour proving it.
   */
  maxGamesPerCandidate: 640,
});

/**
 * A session's boundary. `keep-looking` is NOT permission to run forever, and
 * hitting the edge is a REPORTED stop reason rather than a silent one.
 */
export interface TrimBudget {
  /** Individual games (two per paired game), summed over every round. */
  readonly maxGames: number;
  /** Wall-clock seconds, summed over every round. */
  readonly maxSeconds: number;
}

/**
 * The default boundary. Deliberately generous — it exists so an unattended
 * `keep-looking` session terminates and says why, not to ration an attended one.
 */
export const DEFAULT_TRIM_BUDGET: TrimBudget = Object.freeze({
  maxGames: 40_000,
  maxSeconds: 1_800,
});

/**
 * The DEFAULT ceiling on how many cards one cut may take.
 *
 * ⚠️ TWO, NOT ONE, AND THE REASON MATTERS. The plan for §3.180 proposed a
 * default of 1 "so today's behaviour is unchanged" — but that was written
 * against the pre-§3.179 code, and it is not what the measurement says. Today's
 * ladder is singles THEN pairs: §3.179 ships `keep-looking` widening to a
 * nonland+land pair, and `trim-ladder.test.ts` asserts a conclusive session runs
 * exactly that two-round ladder. A default of 1 would DELETE the pairs round.
 * Two is what leaves today's behaviour untouched, so two is the default.
 */
export const DEFAULT_MAX_CARDS_PER_CUT = 2;

/** The user's settings for a trim session. */
export interface TrimSettings {
  /** The size to trim towards. Never below the format's `minDeckSize`. */
  readonly targetSize: number;
  readonly onImprovement: TrimOnImprovement;
  readonly onNoImprovement: TrimOnNoImprovement;
  /**
   * The session's game/time boundary (§3.179). Omitted means
   * `DEFAULT_TRIM_BUDGET` — never "unbounded", because `keep-looking` now
   * deepens instead of giving up and something has to stop it.
   */
  readonly budget?: TrimBudget;
  /**
   * THE TUNABLE CUT SIZE (§3.180) — the most cards one removal may take.
   *
   * Caleb's words: *"right now it tries to cut one card at a time - it should
   * allow you to try to cut more than one at a time."* This is the ceiling of
   * the widening ladder, not the size of every round: a session still starts at
   * singles and widens only when a round finds nothing, because a one-card cut
   * that improves the deck is strictly cheaper to find and strictly safer to
   * apply than a two-card one. Omitted means `DEFAULT_MAX_CARDS_PER_CUT`.
   *
   * Values above `TRIM_MAX_CUT_SIZE` are clamped to it — and `trimCutSizeLadder`
   * is the ONE place that clamps, so no surface can disagree about the ceiling.
   */
  readonly maxCardsPerCut?: number;
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

/**
 * HOW A k > 1 ROSTER IS ASSEMBLED — the combinatorics, stated rather than hidden
 * (DESIGN §3.180).
 *
 * ⚠️ THIS IS THE DESIGN PROBLEM OF THE WHOLE FEATURE. A 63-card deck has ~35
 * distinct cards: k = 1 is 35 candidates, k = 2 is C(35,2) = 595, k = 3 is
 * 6,545. Enumerating them and running a paired A/B on each would spend the
 * entire session budget on a table nobody can read — and §3.179 measured that
 * spreading a budget that thin is *already* why every row read INCONCLUSIVE. So
 * a k > 1 round is SEEDED, not enumerated, and the panel prints how much of the
 * space it actually saw.
 *
 * The roster is split between two quotas, and the split is the interesting part:
 *
 *  - `exploitShare` of it comes from k-subsets of the best SINGLE cuts the
 *    previous round measured. Cheap and usually right: a pair of cards that are
 *    each nearly worth cutting is the likeliest pair worth cutting.
 *  - the REST is a systematic, evenly-strided sweep of the whole k-subset space.
 *
 * ⚠️ AND THE SWEEP IS NOT OPTIONAL. Seeding only from the best singles would
 * systematically MISS the case this feature exists for — two cards that are bad
 * only TOGETHER, each of which looks fine alone and therefore never ranks near
 * the top of a singles round. The sweep is what makes those reachable, and
 * `trim.test.ts` proves it on a rigged deck where k = 1 finds neither card.
 */
export const TRIM_SEED_POLICY = Object.freeze({
  /**
   * Share of a k > 1 roster drawn from the best single cuts. The remainder is
   * the systematic sweep. Six-tenths: enough that the likely answer is scouted
   * first, not so much that the sweep stops being a real sample.
   */
  exploitShare: 0.6,
  /**
   * How many of the previous round's best single cuts are eligible as seeds.
   * k-subsets are drawn from these, so it bounds the exploit pool rather than
   * the roster: C(10,2) = 45 already exceeds any default cap.
   */
  bestSinglesConsidered: 10,
});

/** Bounds a round obeys. Both caps REPORT when they bite (as `capped` skips). */
export interface TrimConfig {
  /**
   * Hard ceiling on candidates a round evaluates. Generous on purpose: a
   * 64-card deck of singletons is still fully covered, and the adaptive ladder
   * is what keeps a wide round affordable. Over it, the prior chooses.
   */
  readonly maxCandidatesPerRound: number;
  /**
   * Ceiling on MULTI-CARD candidates in a widening round — each one is a full
   * arm, and the space they are drawn from is combinatorial.
   *
   * ⚠️ Renamed from `maxPairCandidates` in §3.180. The old name stopped being
   * true the moment a round could cut three cards, and a name that is a lie is
   * worse than a name that is vague. Nothing outside this module read it.
   */
  readonly maxMultiCutCandidates: number;
  readonly prior: TrimPriorWeights;
}

export const DEFAULT_TRIM_CONFIG: TrimConfig = Object.freeze({
  maxCandidatesPerRound: 64,
  maxMultiCutCandidates: 24,
  prior: Object.freeze({ favouredType: 10, perCopy: 1 }),
});

/**
 * HOW MUCH OF THE k-SUBSET SPACE A ROUND ACTUALLY TRIED — a count with its
 * denominator AND the denominator's source (project rule 11).
 *
 * A bare "24 cuts tried" invites the reader to assume that was all of them. The
 * honest line is *"24 of 595 two-card cuts tried"*, and `source` says where 595
 * came from so nobody has to trust it.
 */
export interface TrimSubsetCoverage {
  readonly cardsPerCut: number;
  /** Candidates the round will actually play. */
  readonly tried: number;
  /** `C(distinct, k)` — every k-subset of the deck's distinct cards. */
  readonly possible: number;
  /** The deck's distinct-card count, which is the `n` of that binomial. */
  readonly distinctCards: number;
  /** The plural noun from the cut-size row: "two-card cuts". */
  readonly noun: string;
  /** The arithmetic in one line, printed verbatim by every surface. */
  readonly source: string;
}

/**
 * `C(n, k)` as an exact integer, or `Number.POSITIVE_INFINITY` if it would
 * leave the safe-integer range.
 *
 * Multiplicative, dividing as it goes so the intermediate never exceeds the
 * answer: the factorial form overflows at n = 171 while C(171,2) is 14,535.
 * Reports rather than approximating when it genuinely cannot say (rule 2).
 */
export function binomial(n: number, k: number): number {
  if (!Number.isInteger(n) || !Number.isInteger(k) || k < 0 || n < 0) return 0;
  if (k > n) return 0;
  const half = Math.min(k, n - k);
  let result = 1;
  for (let i = 1; i <= half; i += 1) {
    result = (result * (n - half + i)) / i;
    if (!Number.isFinite(result) || result > Number.MAX_SAFE_INTEGER) return Number.POSITIVE_INFINITY;
  }
  return Math.round(result);
}

/**
 * The `index`-th k-subset of `n` items, in lexicographic order, as ascending
 * item indices — the combinatorial number system, so the systematic sweep can
 * sample the space evenly WITHOUT materialising it. C(100,4) is 3.9 million
 * subsets; building them all to take twenty would be the same mistake at a
 * different layer.
 *
 * Returns `undefined` for an index outside `C(n, k)`.
 */
/**
 * Build a coverage row — the ONE place the line is worded (§3.180).
 *
 * Exported because every surface that shows a trim round needs one and the web
 * Lab's own tests build fake rounds: a test that hand-wrote the sentence would
 * pass while the panel printed something else, which is the divergence rule 12
 * exists to stop. The generator calls this; so does anything faking a report.
 */
export function trimCoverage(kind: TrimRoundKind, tried: number, distinctCards: number): TrimSubsetCoverage {
  const row = TRIM_CUT_SIZE_ROW_BY_KIND[kind];
  const possible = binomial(distinctCards, row.cardsPerCut);
  const possibleText = Number.isFinite(possible) ? possible.toLocaleString('en-US') : 'more than can be counted';
  return {
    cardsPerCut: row.cardsPerCut,
    tried,
    possible,
    distinctCards,
    noun: row.noun,
    source:
      `${tried.toLocaleString('en-US')} of ${possibleText} ${row.noun} tried` +
      ` — C(${distinctCards}, ${row.cardsPerCut}) over the deck's ${distinctCards} distinct cards`,
  };
}

/** Euclid, for choosing a sweep stride that visits every subset exactly once. */
function greatestCommonDivisor(a: number, b: number): number {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y !== 0) [x, y] = [y, x % y];
  return x;
}

export function nthCombination(n: number, k: number, index: number): number[] | undefined {
  const total = binomial(n, k);
  if (!Number.isInteger(index) || index < 0 || index >= total) return undefined;
  const combination: number[] = [];
  let remaining = index;
  let item = 0;
  for (let chosen = k; chosen > 0; chosen -= 1) {
    // Walk the first element forward, subtracting the block of subsets that
    // start with each candidate, until `remaining` falls inside one.
    for (;;) {
      const block = binomial(n - item - 1, chosen - 1);
      if (remaining < block) break;
      remaining -= block;
      item += 1;
    }
    combination.push(item);
    item += 1;
  }
  return combination;
}

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
  /**
   * The deck's land ratio once this candidate is applied (§3.180).
   *
   * Carried because a k-card cut's effect on the manabase is NOT k times a
   * single cut's: a nonland+land pair leaves the ratio where it was, while two
   * nonlands move it as far as two rounds of single cuts would. The prior reads
   * this post-cut state, and the panel can print it, so the arithmetic is
   * visible rather than implied.
   */
  readonly ratioAfter: LandRatio;
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
  /**
   * The card ids of the previous round's best SINGLE cuts, best-first — the
   * seeds a k > 1 round exploits (§3.180). Omitted on a first round, or when the
   * previous round was itself k > 1: the prior's own order is then the seed
   * order, so a k = 2 round still works with no history behind it.
   */
  readonly seeds?: readonly string[];
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
 * `k = 1`: every distinct card, cut one copy — unchanged from §3.174 and pinned
 * as unchanged by a test. `k > 1`: k-card subsets, EXACT while the whole space
 * fits under the cap and SEEDED above it (`TRIM_SEED_POLICY`), with `coverage`
 * saying which of those two happened and how much of the space was seen.
 *
 * ⚠️ WHAT §3.180 WIDENED, precisely. A `pairs` round used to enumerate the
 * nonland × land CROSS PRODUCT — so two nonlands together, or two lands
 * together, could not be tried at all, whatever the deck. Cutting the two cards
 * that are weak only as a pair was therefore unreachable, which is the whole
 * thing Caleb asked for. A k-subset is any k distinct cards.
 *
 * Legality is the truth, not a copy of the size rule: the variant is BUILT
 * (`applySwap`, the one funnel) and `validateDeck` decides — a cut that would
 * take the deck under `minDeckSize` comes back `illegal`, never crashed on.
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
): {
  readonly candidates: readonly TrimCandidate[];
  readonly skipped: readonly SkippedCandidate[];
  readonly coverage: TrimSubsetCoverage;
} {
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
      // Read off the VARIANT that was just built, not arithmetic on the base:
      // `applySwap` is the one funnel that decides what a cut actually removes,
      // and a second calculation of the same thing is a second answer waiting to
      // disagree with it (rule 12).
      ratioAfter: landRatioOf(variant, pool),
      priorReasons: reasons,
    };
  };

  const skipped: SkippedCandidate[] = [];
  const candidates: TrimCandidate[] = [];
  const seen = new Set<string>();
  const cardsPerCut = CARDS_PER_CUT[options.kind];
  const n = cards.length;
  const possible = binomial(n, cardsPerCut);

  /**
   * The parts of a subset in CANONICAL order: nonlands first, then lands, each
   * in decklist order. Canonical so a subset has exactly one key however it was
   * reached (the exploit pool and the sweep will reach the same subset by
   * different routes), and nonland-first because that is the order §3.174's
   * pairs were built in — "Craw Wurm + Forest" reads the way it always has.
   */
  const orderParts = (indices: readonly number[]): { readonly def: CardDefinition; readonly count: number }[] => {
    const picked = indices.map((i) => cards[i]).filter((c): c is { readonly def: CardDefinition; count: number } => c !== undefined);
    return [...picked.filter((c) => !isLandCard(c.def)), ...picked.filter((c) => isLandCard(c.def))];
  };

  /** Build the subset at these indices, once, deduplicated by candidate key. */
  const take = (indices: readonly number[]): void => {
    const parts = orderParts(indices);
    if (parts.length !== cardsPerCut) return;
    const key = candidateKey(parts.map((p) => p.def.id).join(CUT_OUT_SEPARATOR), SWAP_IN_NOTHING);
    if (seen.has(key)) return;
    seen.add(key);
    const candidate = build(parts, skipped);
    if (candidate) candidates.push(candidate);
  };

  const cap =
    cardsPerCut > 1
      ? Math.min(config.maxMultiCutCandidates, config.maxCandidatesPerRound)
      : config.maxCandidatesPerRound;

  if (cardsPerCut <= 1) {
    // k = 1 is unchanged, deliberately and verifiably: every distinct card in
    // decklist order. `trim.test.ts` pins the whole candidate list against this,
    // because "today's behaviour is untouched at k = 1" is a claim, not a hope.
    for (let i = 0; i < n; i += 1) take([i]);
  } else if (possible <= cap) {
    // Small enough to be EXACT. A deck whose whole k-subset space fits under the
    // cap is enumerated rather than sampled, so the coverage line can honestly
    // read "9 of 9" instead of implying a sample where none was needed.
    for (let index = 0; index < possible; index += 1) {
      const combination = nthCombination(n, cardsPerCut, index);
      if (combination) take(combination);
    }
  } else {
    // SEEDED. Two quotas, both stated (`TRIM_SEED_POLICY`).
    const exploitQuota = Math.round(cap * TRIM_SEED_POLICY.exploitShare);

    // (1) EXPLOIT — k-subsets of the best single cuts. The seed order is the
    // previous round's RANKING when there is one, which is ordered by observed
    // delta: two cards that each measured mildly bad without clearing the bar
    // are exactly the pair worth asking about together, and the prior alone
    // would never have noticed them. With no history the prior's order stands.
    const seedRank = new Map<string, number>();
    (options.seeds ?? []).forEach((cardId, at) => {
      if (!seedRank.has(cardId)) seedRank.set(cardId, at);
    });
    const singlePrior = (card: { readonly def: CardDefinition; readonly count: number }): number =>
      priorOf([card], options.reading, config.prior, rules.maxCopiesNonBasic).score;
    const seedOrder = [...Array(n).keys()].sort((a, b) => {
      const cardA = cards[a];
      const cardB = cards[b];
      if (!cardA || !cardB) return 0;
      const rankA = seedRank.get(cardA.def.id) ?? Number.POSITIVE_INFINITY;
      const rankB = seedRank.get(cardB.def.id) ?? Number.POSITIVE_INFINITY;
      if (rankA !== rankB) return rankA - rankB;
      const priorDelta = singlePrior(cardB) - singlePrior(cardA);
      if (priorDelta !== 0) return priorDelta;
      return a - b;
    });
    const pool = seedOrder.slice(0, Math.min(TRIM_SEED_POLICY.bestSinglesConsidered, n));
    const poolSubsets = binomial(pool.length, cardsPerCut);
    for (let index = 0; index < poolSubsets && candidates.length < exploitQuota; index += 1) {
      const combination = nthCombination(pool.length, cardsPerCut, index);
      if (combination) take(combination.map((at) => pool[at] as number));
    }

    // (2) SWEEP — a strided walk of the WHOLE space, indexed in decklist order
    // so it is independent of the prior and of the seeds.
    //
    // ⚠️ This is the quota that makes a pair of individually-innocent cards
    // reachable at all. Without it the search could only ever confirm what the
    // previous round already suspected, which is not a search.
    //
    // ⚠️ THE STRIDE IS COPRIME WITH THE SPACE, and that is not decoration.
    // `index = i * stride mod possible` visits every subset exactly once when
    // gcd(stride, possible) = 1, so the walk can keep going until the roster is
    // actually FULL. A plain evenly-spaced sample cannot: it lands on subsets
    // the exploit quota already took, and each collision silently cost a seat —
    // a 24-seat round came back with 22 and nothing said why.
    const sweepQuota = Math.max(1, cap - candidates.length);
    let stride = Math.max(1, Math.floor(possible / sweepQuota));
    while (stride < possible && greatestCommonDivisor(stride, possible) !== 1) stride += 1;
    for (let i = 0; i < possible && candidates.length < cap; i += 1) {
      const combination = nthCombination(n, cardsPerCut, (i * stride) % possible);
      if (combination) take(combination);
    }
  }

  candidates.sort(comparePrior);
  const kept = candidates.slice(0, cap);
  for (const dropped of candidates.slice(cap)) {
    skipped.push({ outName: dropped.outName, inName: TRIM_IN_NAME, reason: 'capped', details: dropped.priorReasons });
  }
  return { candidates: kept, skipped, coverage: trimCoverage(options.kind, kept.length, n) };
}

/**
 * The prior: the class the ratio favours, then copies held. Every term named.
 *
 * ⚠️ THE FAVOURED-TYPE BONUS IS AWARDED ONCE FOR THE SUBSET, NOT ONCE PER CARD
 * (§3.180). Summing it per card would let a two-nonland cut outrank a one-nonland
 * cut on nothing but arithmetic — twice the bonus for the same single fact about
 * the manabase — and at k = 3 a three-nonland cut would outrank everything in
 * sight. The mana prior answers one question about the whole cut.
 *
 * This is provably identical to the per-card sum for every case that existed
 * before §3.180: at k = 1 the subset is one card, and §3.174's pairs were always
 * exactly one nonland and one land, so exactly one part could ever match. The
 * only thing that moves is the ORDER of the reasons for a pair when a land cut is
 * due — the dominant term now comes first, which is what the field's own doc
 * comment already promised.
 */
function priorOf(
  parts: readonly { readonly def: CardDefinition; readonly count: number }[],
  reading: LandCutReading,
  weights: TrimPriorWeights,
  copiesCap: number,
): { readonly score: number; readonly reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];
  const favoursLand = reading.favoured === 'land';
  if (parts.some(({ def }) => isLandCard(def) === favoursLand)) {
    score += weights.favouredType;
    reasons.push(favoursLand ? 'a land, and a land cut is due' : 'a nonland, and no land cut is due');
  }
  for (const { def, count } of parts) {
    void def;
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
  /**
   * Card ids of the previous round's best single cuts, best-first — the seeds a
   * k > 1 round exploits (§3.180). Absent on a first round.
   */
  readonly seeds?: readonly string[];
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
  /** How much of the k-subset space this round tried, with its denominator (§3.180). */
  readonly coverage: TrimSubsetCoverage;
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
    ...(options.seeds ? { seeds: options.seeds } : {}),
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
    coverage: generated.coverage,
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

/**
 * A round's outcome — a CLOSED set of three, not two (DESIGN §3.179).
 *
 * ⚠️ `'exhausted'` used to mean both "nothing helps" and "nothing could be
 * read", and it printed the first while meaning the second. With almost every
 * row coming back inconclusive there is never a winner, so every round ended
 * `exhausted` and the session stopped having cut zero cards while telling the
 * user the deck cannot be improved. It had not learned that nothing helps; it
 * had learned NOTHING, and those want opposite responses.
 *
 *  - `improved`  — a removal proved better. Apply it (or ask).
 *  - `exhausted` — no winner, and every row is CONCLUSIVE. Nothing helps, and
 *                  more games would not change that. The search is over.
 *  - `unsure`    — no winner, but some row could still be settled by more games.
 *                  This is the one that earns a deeper round.
 */
export type TrimRoundVerdict = 'improved' | 'exhausted' | 'unsure';

/** What one round of trimming found. */
export interface TrimRoundReport {
  readonly deckName: string;
  readonly deckFingerprint: string;
  readonly deckSize: number;
  readonly targetSize: number;
  readonly round: number;
  readonly roundKind: TrimRoundKind;
  readonly cardsPerCut: number;
  /**
   * How much of the k-subset space the round tried, with its denominator and
   * that denominator's source (§3.180) — the panel prints it verbatim, so a
   * sampled round can never be mistaken for an exhaustive one.
   */
  readonly coverage: TrimSubsetCoverage;
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
  // The three-way round verdict (§3.179). "Unsure" is read from the ROWS' own
  // reasons through the shared table — the same `moreGamesCouldSettle` column
  // `decideVerdict` fills — so the round and the rows can never disagree about
  // whether this question is still open.
  //
  // ⚠️ ONLY THE SURVIVORS COUNT, and this is load-bearing. `driveAdaptiveSearch`
  // is successive halving: it deliberately spends almost nothing on candidates it
  // has already judged, so an ELIMINATED row is nearly always short of
  // `minGamesForVerdict` and reads `tooFewGames` by construction. Counting those
  // made EVERY round unsure — including one where every surviving cut was proved
  // worse — so the ladder would have deepened forever against a question it had
  // already answered, which is the exact infinite loop this verdict exists to
  // prevent. A row the ladder dropped HAS been answered, by the ladder.
  const unsure = rows.some(
    (row) =>
      row.elimination === undefined &&
      SWAP_VERDICT_REASON_BY_KEY[row.evaluation.verdictReason].moreGamesCouldSettle,
  );
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
    coverage: round.coverage,
    reading: round.reading,
    verdict: winner ? 'improved' : unsure ? 'unsure' : 'exhausted',
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
 * THE LADDER A SESSION ACTUALLY WALKS, as one function — the kinds whose cut is
 * at most `maxCardsPerCut` AND still fits above the target, in widening order.
 *
 * ⚠️ THIS IS THE DENOMINATOR, AND IT IS EXPORTED FOR THAT REASON. Before
 * §3.180 the ladder was the whole of `TRIM_ROUND_KINDS`, so tests used
 * `TRIM_ROUND_KINDS.length` as a stand-in for "how many rounds a session that
 * finds nothing will run". That stand-in was only accidentally right: it is the
 * length of the TABLE, not of the path walked through it, and the two part
 * company the moment the table has a row the settings or the target rule out.
 * Every caller that wants the walked path asks here (project rule 11: print the
 * denominator AND its source; rule 12: one answer to one question).
 *
 * A `maxCardsPerCut` outside the table is clamped HERE and only here.
 */
export function trimCutSizeLadder(
  maxCardsPerCut: number = DEFAULT_MAX_CARDS_PER_CUT,
  deckSize: number = Number.POSITIVE_INFINITY,
  targetSize: number = 0,
): readonly TrimRoundKind[] {
  const ceiling = Math.max(1, Math.min(Math.floor(maxCardsPerCut), TRIM_MAX_CUT_SIZE));
  return TRIM_CUT_SIZE_ROWS.filter(
    (row) => row.cardsPerCut <= ceiling && deckSize - row.cardsPerCut >= targetSize,
  ).map((row) => row.kind);
}

/**
 * The next round kind to widen to when a round found nothing — the row after
 * `kind` on the ladder this session walks — or `undefined` when there is nothing
 * left to widen to (and the lever left is DEPTH, per §3.179).
 */
export function nextWideningStep(
  kind: TrimRoundKind,
  deckSize: number,
  targetSize: number,
  maxCardsPerCut: number = DEFAULT_MAX_CARDS_PER_CUT,
): TrimRoundKind | undefined {
  // The ladder is filtered by the target, so a kind the target has ruled out is
  // absent from it; `indexOf` returning -1 then reads as "start from the top",
  // which is why the current kind's own size is the floor rather than its index.
  const ladder = trimCutSizeLadder(maxCardsPerCut, deckSize, targetSize);
  const currentSize = CARDS_PER_CUT[kind];
  return ladder.find((next) => CARDS_PER_CUT[next] > currentSize);
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

/**
 * WHY A TRIM SESSION STOPPED — a CLOSED table, one row per reason (§3.179).
 *
 * ⚠️ `'exhausted'` used to cover two OPPOSITE situations: "we tried everything
 * and nothing helps" and "we ran out of road while still unable to read the
 * rows". They deserve opposite responses from the user — accept the deck, or
 * raise the budget — and printing one word for both is the same defect as
 * INCONCLUSIVE one layer up. Adding a reason is a row here plus a row in
 * `TRIM_STOP_REASON_WORDING`; `trim.test.ts` enumerates the reasons and fails if
 * one has no wording, which is the guard that keeps this from rotting.
 */
export const TRIM_STOP_REASONS = [
  'target-reached',
  'awaiting-apply',
  'no-improvement-conclusive',
  'budget-exhausted',
  'paused',
] as const;
export type TrimStopReason = (typeof TRIM_STOP_REASONS)[number];

/** One stop reason's words, and whether it leaves the search genuinely finished. */
export interface TrimStopReasonRow {
  readonly reason: TrimStopReason;
  /** The headline the panel prints. */
  readonly label: string;
  /** One sentence saying what happened and what the user can do about it. */
  readonly detail: string;
  /**
   * Whether the question is settled. `false` means the search stopped with
   * something still unread — a budget the user can raise, or a pause they chose
   * — and the panel says so rather than implying the deck cannot be improved.
   */
  readonly conclusive: boolean;
}

export const TRIM_STOP_REASON_WORDING: Readonly<Record<TrimStopReason, TrimStopReasonRow>> = Object.freeze({
  'target-reached': Object.freeze({
    reason: 'target-reached' as const,
    label: 'Target reached',
    detail: 'The deck is down to the size you asked for.',
    conclusive: true,
  }),
  'awaiting-apply': Object.freeze({
    reason: 'awaiting-apply' as const,
    label: 'Waiting for you',
    detail: 'A removal proved better and your settings say ask before applying it.',
    conclusive: false,
  }),
  'no-improvement-conclusive': Object.freeze({
    reason: 'no-improvement-conclusive' as const,
    label: 'Nothing helps',
    detail:
      'Every removal was measured deeply enough to call, and none of them improved the deck. More games would not change this answer.',
    conclusive: true,
  }),
  'budget-exhausted': Object.freeze({
    reason: 'budget-exhausted' as const,
    label: 'Out of budget, still unsure',
    detail:
      'The session hit its game or time budget with rows it still could not read. This is NOT "nothing helps" — raise the budget or the depth to find out which.',
    conclusive: false,
  }),
  paused: Object.freeze({
    reason: 'paused' as const,
    label: 'Paused',
    detail: 'No removal improved the deck, and your settings say pause rather than keep looking.',
    conclusive: false,
  }),
});

/** A session's result: the deck as it stands, every round, and why it stopped. */
export interface TrimSessionResult {
  readonly deck: Deck;
  readonly rounds: readonly TrimRoundReport[];
  /** The removals applied, in order. */
  readonly applied: readonly TrimRow[];
  readonly stopped: TrimStopReason;
  /** What the session actually spent, so the budget stop can print its own arithmetic. */
  readonly spend: TrimSpend;
  /** The per-candidate depth the last round ran at — grows as the ladder deepens. */
  readonly gamesPerCandidate: number;
}

/** What a session has spent so far, in the units the budget is written in. */
export interface TrimSpend {
  readonly games: number;
  readonly seconds: number;
  readonly rounds: number;
}

/** Options for a whole session — the round options minus what the loop decides. */
export interface TrimSessionOptions extends Omit<RunTrimRoundOptions, 'round' | 'roundKind' | 'baseLandRatio' | 'targetSize'> {
  readonly settings: TrimSettings;
  /** Called after each round, so a long session can say where it is. */
  readonly onRound?: (report: TrimRoundReport) => void;
}

/**
 * The next per-candidate depth after a round that ended UNSURE, or `undefined`
 * when the ladder has hit its ceiling (§3.179).
 *
 * Exported because the web Lab drives the same ladder one round at a time over
 * its worker pool and must not re-derive the growth rule — `trimSession.test.ts`
 * and `trim.test.ts` both read this, so the two drivers cannot disagree about
 * what "keep looking" costs.
 */
export function deeperGamesPerCandidate(current: number): number | undefined {
  if (current >= TRIM_DEEPEN.maxGamesPerCandidate) return undefined;
  return Math.min(Math.max(1, Math.ceil(current * TRIM_DEEPEN.factor)), TRIM_DEEPEN.maxGamesPerCandidate);
}

/**
 * The SEEDS a following k > 1 round should exploit: the card ids of this round's
 * single-card cuts, in the order the round ranked them (§3.180).
 *
 * ⚠️ THE RANKING, NOT THE PRIOR, AND THAT IS THE POINT. `finishSuggestionRun`
 * orders rows proved-better first and then by observed delta, so the top of this
 * list is "the cards that measured worst to keep" — including the ones that
 * measured mildly bad without clearing the bar. Those are precisely the cards
 * whose PAIR is worth asking about, and the cheap prior cannot see them: it only
 * knows card types and copy counts. Seeding from measurement is what lets a
 * k = 2 round learn something a k = 1 round could not.
 *
 * Only single-card rows are seeds. A k > 1 row's cards were already measured as
 * a group, and splitting it back into parts would attribute a joint result to
 * each half — the exact conflation this feature exists to avoid.
 *
 * Exported because the Lab drives rounds one at a time over its worker pool and
 * must seed them the same way the headless loop does.
 */
export function seedsFromRound(report: TrimRoundReport): readonly string[] {
  const seeds: string[] = [];
  for (const row of report.rows) {
    if (row.cuts.length !== 1) continue;
    const cut = row.cuts[0];
    if (cut && !seeds.includes(cut.cardId)) seeds.push(cut.cardId);
  }
  return seeds;
}

/**
 * THE AUTO LOOP: round, apply the winner, shrink by one, round again — until the
 * target, until nothing helps, or until the budget runs out. Under `ask` it
 * returns after the first improving round with the winner unapplied. Nothing
 * on-the-edge is ever applied here.
 *
 * ⚠️ WHAT §3.179 CHANGED. When a round finds no winner the loop no longer treats
 * the end of `TRIM_ROUND_KINDS` as the end of the search. It asks what the round
 * actually learned:
 *
 *  - the round is UNSURE and the kinds are spent → grow `gamesPerCandidate` and
 *    start the kind ladder again, because the lever left is DEPTH;
 *  - the round is CONCLUSIVE (`exhausted`) → stop immediately with
 *    `no-improvement-conclusive`. **This branch is what keeps the deepening from
 *    becoming an infinite loop**, and it is tested as such: re-measuring a
 *    settled question buys nothing and costs the whole budget;
 *  - the depth ceiling or the budget is reached → stop with `budget-exhausted`,
 *    which says plainly that this is NOT "nothing helps".
 *
 * The base land ratio is read ONCE, from the deck the session began with, so the
 * prior measures drift from where the user started — not from the previous round.
 */
export function trimDeck(base: Deck, options: TrimSessionOptions): TrimSessionResult {
  const { settings } = options;
  const budget = settings.budget ?? DEFAULT_TRIM_BUDGET;
  const baseLandRatio = landRatioOf(base, options.pool);
  const rounds: TrimRoundReport[] = [];
  const applied: TrimRow[] = [];
  let deck = base;
  let round = 0;
  let kind: TrimRoundKind = TRIM_FIRST_ROUND_KIND;
  let gamesPerCandidate = options.gamesPerCandidate;
  let games = 0;
  let seconds = 0;
  /**
   * What the last SINGLES round measured, carried forward so a widening round
   * exploits it (§3.180). Reset when a cut lands, because the ranking was taken
   * on a deck that no longer exists.
   */
  let seeds: readonly string[] = [];

  const spend = (): TrimSpend => ({ games, seconds, rounds: rounds.length });
  const stop = (stopped: TrimStopReason): TrimSessionResult => ({
    deck,
    rounds,
    applied,
    stopped,
    spend: spend(),
    gamesPerCandidate,
  });

  while (deckSizeOf(deck) > settings.targetSize) {
    // The budget is checked BEFORE a round, not after: a round begun with no
    // budget left would spend past the boundary and then report having stopped
    // at it, which is a number that is true only because nobody looked.
    if (games >= budget.maxGames || seconds >= budget.maxSeconds) return stop('budget-exhausted');

    const report = runTrimRound(deck, {
      ...options,
      gamesPerCandidate,
      round,
      roundKind: kind,
      targetSize: settings.targetSize,
      baseLandRatio,
      ...(seeds.length > 0 ? { seeds } : {}),
    });
    rounds.push(report);
    if (report.cardsPerCut === 1) seeds = seedsFromRound(report);
    games += report.notes.totalGamesRun;
    seconds += report.notes.elapsedSeconds ?? 0;
    options.onRound?.(report);
    round += 1;

    if (report.verdict === 'improved' && report.winner) {
      if (settings.onImprovement === 'ask') return stop('awaiting-apply');
      deck = applyTrimCut(deck, report.winner.cuts, options.pool);
      applied.push(report.winner);
      // A smaller deck is a new question: back to the cheapest kind AND the
      // starting depth, so the next cut is not paid for at the deep rate the
      // previous impasse needed.
      kind = TRIM_FIRST_ROUND_KIND;
      gamesPerCandidate = options.gamesPerCandidate;
      // The ranking that produced these seeds was measured on a deck that no
      // longer exists, so it is not evidence about this one.
      seeds = [];
      continue;
    }

    if (settings.onNoImprovement === 'pause') return stop('paused');

    const next = nextWideningStep(kind, deckSizeOf(deck), settings.targetSize, settings.maxCardsPerCut);
    if (next !== undefined) {
      kind = next;
      continue;
    }

    // The kinds are spent. What the round LEARNED decides what happens now.
    // `exhausted` means every row was conclusive and none was better: the
    // question is settled, and deepening it is waste.
    if (report.verdict === 'exhausted') return stop('no-improvement-conclusive');

    const deeper = deeperGamesPerCandidate(gamesPerCandidate);
    if (deeper === undefined) return stop('budget-exhausted');
    gamesPerCandidate = deeper;
    kind = TRIM_FIRST_ROUND_KIND;
  }
  return stop('target-reached');
}
