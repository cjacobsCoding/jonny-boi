/**
 * THE JOINT MANABASE + SPELL SEARCH (DESIGN §3.177) — "find a best mana ratio
 * for this deck, and the cards that go with it".
 *
 * ### The confound this exists to fix
 * §3.175's land-COUNT sweep keeps the deck the same size by trading against a
 * partner it picks arbitrarily: `mostPlayedBasic` out, *the cheapest nonland
 * with room* in. A variant labelled "23 lands" is therefore really "23 lands AND
 * one more copy of my cheapest spell", and the paired verdict measures the two
 * changes as one. If 23 comes back worse you cannot tell whether the count was
 * wrong or the partner was; if 25 is genuinely better it can still read worse
 * because the nonland it happened to cut was one of the deck's best cards.
 * `JOINT_CONFOUND_NOTE` is the one wording of this, and
 * `JOINT_PARTNER_RULES` keeps the old rule as a row so the difference can be
 * MEASURED — `joint.test.ts` runs the same descent under both and watches them
 * land on different counts.
 *
 * ### The shape: alternating (coordinate) descent
 * Every move changes the denominator of the others, so the two coordinates are
 * optimised in turn:
 *
 *  1. hold the spells fixed, search the manabase moves (count × partner, colour
 *     mix, land type);
 *  2. hold the manabase fixed, search the spell moves (a nonland slot at a time);
 *  3. repeat until a full round improves nothing, the budget is spent, or the
 *     round cap is reached.
 *
 * That is a LOCAL search and it is reported as one: a round that improves
 * nothing means this search cannot see a better deck from here, never that none
 * exists. `JOINT_STOP_REASONS` carries that meaning next to the reason.
 *
 * ### Nothing statistical is re-implemented
 * A phase is a FAMILY of paired comparisons against one base deck — exactly what
 * the suggestion engine schedules. So a phase is planned as a
 * `SuggestionRunPlan` (`jointCandidateOf` adapts each move to the ladder's
 * candidate shape), driven by `driveAdaptiveSearch` (scout, futility, rank cut,
 * the leader-settled stop) and closed by `finishSuggestionRun` (Holm over the
 * phase's family, verdicts re-decided from the corrected p). Common random
 * numbers, McNemar and the adaptive ladder are reused, not restated. The
 * maximum-over-partners that attributes a land count to its best partner is a
 * SELECTION, and the Holm correction over the whole phase is what keeps it
 * honest — the same correction every family here already gets.
 *
 * ### The budget is the user's, and it is visible
 * A search is a sequence of PHASES, each an ordinary cancellable run, with the
 * state between them plain data (`JointSearchState`). That is what makes it
 * resumable and interruptible rather than an hour-long black box: the panel
 * keeps the state, shows games spent against the budget, and issues the next
 * phase — or does not.
 */

import type { EffectRegistry } from '@jonny-boi/core';
import type { CardPool } from '@jonny-boi/cards';
import type { Deck, LoadedDeck } from './deck.js';
import type { MatchupPilots, RunOptions } from './matchup.js';
import { gameSeedFor } from './matchup.js';
import {
  DEFAULT_DECK_RULES,
  DEFAULT_STATS_CONFIG,
  DEFAULT_SWAP_SCOPE,
  type DeckRules,
  type StatsConfig,
} from './config.js';
import type { ProportionCI } from './stats.js';
import type { SwapEvaluation, SwapVerdict } from './swap.js';
import { summarizePairedSwap } from './swap.js';
import type { SkippedCandidate, SwapCandidate } from './suggest-candidates.js';
import {
  DEFAULT_ADAPTIVE_CONFIG,
  DEFAULT_EXPLORATION_WEIGHTS,
  DEFAULT_SUGGEST_CONFIG,
  type AdaptiveSearchConfig,
} from './suggest-config.js';
import { planWaves } from './suggest-schedule.js';
import { candidateKey, deckFingerprint, emptyHistory } from './suggest-history.js';
import type { AdaptiveArmOutcome, AdaptiveSearchOutcome, SuggestionRunPlan } from './suggest-run.js';
import { driveAdaptiveSearch } from './suggest-run.js';
import type {
  EliminationNote,
  MultipleComparisonsReport,
  SuggestionNotes,
  SuggestionSearchResult,
  WaveReport,
} from './suggest-report.js';
import { finishSuggestionRun } from './suggest-report.js';
import type { ArmHandle, PairedArmRunner, PairedArmsUsage, PairedGameObservation, SwapArm } from './paired-arms.js';
import { createPairedArmRunner } from './paired-arms.js';
import { applyManabase, type ManabaseSummary } from './manabase.js';
import { compareReliability, createReliabilityWatch, type ReliabilityComparison } from './manabase-reliability.js';
import type { DualLandFamilyId } from './manabase-config.js';
import {
  DEFAULT_JOINT_BUDGET,
  DEFAULT_JOINT_PARTNER_RULE,
  JOINT_CONFOUND_NOTE,
  JOINT_HONEST_CLAIM,
  JOINT_MAX_MOVES_PER_PHASE,
  JOINT_MAX_ROUNDS,
  JOINT_MIN_PHASE_GAMES,
  JOINT_NOT_GATED_ON,
  JOINT_PHASES,
  JOINT_STOP_REASONS,
  type JointPartnerRuleId,
  type JointPhaseId,
  type JointStopReasonId,
} from './joint-config.js';
import { generateJointMoves, type JointMove, type JointMoveSet, type SkippedJointMove } from './joint-moves.js';

export type { JointMove, JointMoveSet, SkippedJointMove } from './joint-moves.js';
export { generateJointMoves } from './joint-moves.js';

/**
 * The `out` side of a joint candidate's ladder key. A move is not a swap of one
 * card for another (a dual playset rewrites four slots), so the ladder's
 * `outId>inId` key names the base deck on the left and the move on the right —
 * `joint>count:-1:forest>llanowar-elves`.
 */
export const JOINT_BASE_REF = 'joint';

/**
 * Deck size is invariant under a joint move — the identity the whole search
 * rests on, and the reason the land count and the spell count trade against each
 * other at all. Re-exported from the trim lane rather than re-derived: one
 * answer to "how big is this deck".
 */
export { deckSizeOf } from './trim.js';
import { deckSizeOf } from './trim.js';

/**
 * Build the deck a move produces, by the ONE fold that turns a list of
 * replacements into a deck (`applyManabase`), so the deck the sim plays and the
 * deck the Lab's Apply produces cannot drift. The deck keeps its own NAME: the
 * move's label records the change, which is right for a variant and wrong for
 * the deck a person then owns.
 */
export function applyJointMove(deck: Deck, move: JointMove, pool: CardPool): Deck {
  return { ...applyManabase(deck, { steps: move.steps, label: move.label }, pool), name: deck.name };
}

/**
 * A move as the ladder's candidate shape. The ladder reads only `key`, the two
 * names (for its reports) and the traits (for offspring, which a joint phase
 * never uses: `reserves` is empty); the rest is carried so a finished arm is
 * self-describing on a host that does not hold the card pool.
 */
export function jointCandidateOf(move: JointMove, base: ManabaseSummary, baseDeckName: string): SwapCandidate {
  return {
    key: candidateKey(JOINT_BASE_REF, move.key),
    outId: JOINT_BASE_REF,
    inId: move.key,
    outName: `${base.landCount} lands, as built`,
    inName: move.label,
    heuristicScore: move.partner?.fitScore ?? 0,
    traits: { colorKey: '', manaValue: 0, role: 'land' },
    variantDeckName: `${baseDeckName} — ${move.label}`,
    copiesSwapped: move.slotsChanged,
  };
}

/** The move a ladder candidate stands for, by key; `undefined` for a foreign key. */
export function moveForCandidateKey(key: string, moves: readonly JointMove[]): JointMove | undefined {
  return moves.find((move) => candidateKey(JOINT_BASE_REF, move.key) === key);
}

// --- planning one phase ------------------------------------------------------------

/** A `SuggestionRunPlan` for one phase, plus the phase's own family. */
export interface JointPhasePlan extends SuggestionRunPlan {
  readonly joint: {
    readonly phase: JointPhaseId;
    /** Which round of the descent this phase belongs to (0-based). */
    readonly round: number;
    readonly base: ManabaseSummary;
    readonly deckSize: number;
    readonly moves: readonly JointMove[];
    readonly skipped: readonly SkippedJointMove[];
    readonly capped: readonly JointMove[];
    readonly partnerRule: JointPartnerRuleId;
  };
}

export interface PlanJointPhaseOptions {
  readonly pool: CardPool;
  readonly phase: JointPhaseId;
  /** 0-based round of the descent. Offsets the seed so rounds play new games. */
  readonly round: number;
  readonly opponentCount: number;
  readonly baseSeed: number;
  /** Paired games per opponent a FINALIST move reaches; the ladder is adaptive. */
  readonly gamesPerMove?: number;
  readonly partnerRule?: JointPartnerRuleId;
  readonly countRadius?: number;
  readonly mixRadius?: number;
  readonly partnersPerCountStep?: number;
  readonly spellMovesPerPhase?: number;
  readonly families?: readonly DualLandFamilyId[];
  readonly adaptiveConfig?: AdaptiveSearchConfig;
  readonly deckRules?: DeckRules;
  readonly maxMoves?: number;
}

/**
 * Enumerate one phase's family and lay the wave ladder over it. Plain JSON, like
 * every run plan, so the web Lab can compute it in a worker (the pool lives
 * there) and schedule it from the main thread.
 *
 * Each ROUND offsets the seed: the same moves on a deck one card different would
 * otherwise re-run on the same shuffles and inherit the previous round's luck —
 * the trap §3.174 named and solved the same way.
 */
export function planJointPhase(deck: Deck, options: PlanJointPhaseOptions): JointPhasePlan {
  const rules = options.deckRules ?? DEFAULT_DECK_RULES;
  const adaptiveConfig = options.adaptiveConfig ?? DEFAULT_ADAPTIVE_CONFIG;
  const games = options.gamesPerMove ?? DEFAULT_SUGGEST_CONFIG.defaultGamesPerCandidate;
  const generated: JointMoveSet = generateJointMoves(deck, options.pool, {
    phase: options.phase,
    partnerRule: options.partnerRule ?? DEFAULT_JOINT_PARTNER_RULE,
    ...(options.countRadius !== undefined ? { countRadius: options.countRadius } : {}),
    ...(options.mixRadius !== undefined ? { mixRadius: options.mixRadius } : {}),
    ...(options.partnersPerCountStep !== undefined ? { partnersPerCountStep: options.partnersPerCountStep } : {}),
    ...(options.spellMovesPerPhase !== undefined ? { spellMovesPerPhase: options.spellMovesPerPhase } : {}),
    ...(options.families ? { families: options.families } : {}),
    deckRules: rules,
  });

  const cap = Math.max(1, Math.floor(options.maxMoves ?? JOINT_MAX_MOVES_PER_PHASE));
  const moves = generated.moves.slice(0, cap);
  const capped = [...generated.capped, ...generated.moves.slice(cap)];
  const roster = moves.map((move) => jointCandidateOf(move, generated.base, deck.name));
  const maxPairedGames = Math.max(0, games) * Math.max(0, options.opponentCount);
  const runSeed = options.round === 0 ? options.baseSeed : gameSeedFor(options.baseSeed, options.round);

  return {
    baseDeckName: deck.name,
    deckFingerprint: deckFingerprint(deck),
    roster,
    // No offspring pool: a phase's family is closed by construction, and the
    // ladder's "more cards like the leader" rule has nothing to say about it.
    reserves: [],
    skipped: [],
    candidatesGenerated: generated.moves.length + generated.capped.length,
    // Each phase is its own family, corrected on its own. No cross-run record:
    // the deck changes under the search, so a settled verdict from a different
    // deck would be a verdict about a different question.
    history: emptyHistory(deck),
    runSeed,
    opponentCount: options.opponentCount,
    maxPairedGames,
    waves: planWaves(roster.length, maxPairedGames, adaptiveConfig),
    joint: {
      phase: options.phase,
      round: options.round,
      base: generated.base,
      deckSize: deckSizeOf(deck),
      moves,
      skipped: generated.skipped,
      capped,
      partnerRule: generated.partnerRule,
    },
  };
}

// --- the finished phase -------------------------------------------------------------

/** One evaluated move, ranked — the joint search's view of a `RankedSwap`. */
export interface JointMoveRow {
  readonly rank: number;
  readonly key: string;
  readonly move: JointMove;
  /** The paired verdict; `verdict` is the Holm-corrected call. */
  readonly evaluation: SwapEvaluation;
  readonly gamesPlayed: number;
  readonly rawPValue: number;
  readonly adjustedPValue: number;
  readonly elimination?: EliminationNote;
  /**
   * §3.175's reliability reading for a manabase-phase move, when the run
   * watched its games. A READING, never a gate — see `JOINT_NOT_GATED_ON`.
   */
  readonly reliability?: ReliabilityComparison;
}

/**
 * ONE LAND COUNT'S VERDICT, attributed to its BEST partner.
 *
 * This is the row that answers "what is the best mana ratio for this deck", and
 * it exists because a count on its own is not a deck: at 23 lands you also
 * choose the 61st card, so the honest question is whether the best 23-land build
 * beats what you have. `partnersTested` says over how many partners the maximum
 * was taken — a maximum over one partner is the old, confounded reading, and the
 * column says so.
 */
export interface LandCountRow {
  readonly landCount: number;
  /** True for the deck's current count, which has no move and no delta. */
  readonly isBase: boolean;
  readonly partnersTested: number;
  /** The best-delta move at this count; absent for the base row. */
  readonly best?: JointMoveRow;
  /** Every partner tried at this count, best first. */
  readonly partners: readonly JointMoveRow[];
  /** `better` / `worse` / `inconclusive` from the best partner; `base` for the base row. */
  readonly verdict: SwapVerdict | 'base';
  /** variant − base win rate of the best partner, in proportion. 0 for the base. */
  readonly delta: number;
  readonly note: string;
}

/** A phase either found a better deck or it did not. */
export type JointPhaseVerdict = 'improved' | 'inconclusive';

/** What one phase of the descent found. */
export interface JointPhaseReport {
  readonly deckName: string;
  readonly deckFingerprint: string;
  readonly phase: JointPhaseId;
  readonly round: number;
  readonly deckSize: number;
  readonly base: ManabaseSummary;
  readonly partnerRule: JointPartnerRuleId;
  readonly verdict: JointPhaseVerdict;
  /** Every move evaluated, ranked better → inconclusive → worse. */
  readonly rows: readonly JointMoveRow[];
  /** The move to accept — present iff `verdict` is `improved`. */
  readonly winner?: JointMoveRow;
  /**
   * The best-delta INCONCLUSIVE row, present iff the phase was inconclusive and
   * such a row exists. Offered as on-the-edge; never accepted by the search.
   */
  readonly edge?: JointMoveRow;
  /**
   * One row per land count the phase reached, base included, best-partner first.
   * Empty for a spell phase, whose moves do not change the count.
   */
  readonly landCounts: readonly LandCountRow[];
  readonly baseWinRate: ProportionCI;
  readonly movesEvaluated: number;
  readonly skipped: readonly SkippedJointMove[];
  readonly capped: readonly JointMove[];
  /** Moves that failed while being played (recorded, never fatal). */
  readonly failures: readonly SkippedCandidate[];
  readonly waves: readonly WaveReport[];
  readonly multipleComparisons: MultipleComparisonsReport;
  readonly notes: SuggestionNotes;
  /** Games this phase actually played — what it charged against the budget. */
  readonly gamesPlayed: number;
  readonly elapsedSeconds: number;
  readonly confoundNote: string;
  readonly notGatedOn: typeof JOINT_NOT_GATED_ON;
}

export interface FinishJointPhaseInput {
  readonly plan: JointPhasePlan;
  readonly search: SuggestionSearchResult;
  readonly elapsedSeconds: number;
  readonly workersUsed?: number;
  readonly stats?: StatsConfig;
  /** The base game watch's reading per slot, when the run watched. */
  readonly baseObserved?: readonly (PairedGameObservation | null | undefined)[];
  /** Each arm's readings per slot, by ladder candidate key, when the run watched. */
  readonly moveObserved?: ReadonlyMap<string, readonly (PairedGameObservation | null | undefined)[]>;
}

/** The land count a move produces, read from the move itself. */
function landCountOf(row: JointMoveRow): number {
  return row.move.landCount;
}

/**
 * How a count's partners are ordered when the count is attributed to its BEST
 * one: by what the games decided first, and only then by how big the difference
 * was. A partner PROVED better is a better answer to "is this count better?"
 * than one with a larger point estimate that the correction could not separate
 * from noise — the whole reason this module never ranks on a raw delta.
 */
const PARTNER_VERDICT_ORDER: Readonly<Record<SwapVerdict, number>> = Object.freeze({
  better: 0,
  inconclusive: 1,
  worse: 2,
});

/**
 * ROLL THE COUNT FAMILY UP PER LAND COUNT, best partner first.
 *
 * Exported because it is the load-bearing half of the fix and must be checkable
 * on its own: a rollup that returned the first partner it was handed would agree
 * with the phase report whenever the incoming rows happen to arrive ranked, and
 * a test that only ever saw ranked rows could not tell the difference. It takes
 * rows in ANY order and is tested with them shuffled.
 *
 * The maximum is taken over the partners that were PLAYED, and the row says how
 * many those were: a count reached by one partner is the confounded reading and
 * must not be presented as though it were the best build at that count.
 */
export function rollUpLandCounts(
  rows: readonly JointMoveRow[],
  base: ManabaseSummary,
  baseWinRate: ProportionCI,
): LandCountRow[] {
  const countRows = rows.filter((row) => row.move.family === 'count');
  if (countRows.length === 0) return [];
  const byCount = new Map<number, JointMoveRow[]>();
  for (const row of countRows) {
    const list = byCount.get(landCountOf(row));
    if (list) list.push(row);
    else byCount.set(landCountOf(row), [row]);
  }
  const out: LandCountRow[] = [
    {
      landCount: base.landCount,
      isBase: true,
      partnersTested: 0,
      partners: [],
      verdict: 'base',
      delta: 0,
      note: `the deck as built — ${(baseWinRate.p * 100).toFixed(1)}% against this gauntlet`,
    },
  ];
  for (const [landCount, list] of byCount) {
    const partners = [...list].sort(
      (a, b) =>
        PARTNER_VERDICT_ORDER[a.evaluation.verdict] - PARTNER_VERDICT_ORDER[b.evaluation.verdict] ||
        b.evaluation.delta - a.evaluation.delta,
    );
    const best = partners[0] as JointMoveRow;
    out.push({
      landCount,
      isBase: false,
      partnersTested: partners.length,
      best,
      partners,
      verdict: best.evaluation.verdict,
      delta: best.evaluation.delta,
      note:
        partners.length === 1
          ? `judged on ONE partner (${best.move.partner?.name ?? 'unnamed'}) — the count and that ` +
            'one spell moved together, so this row cannot separate them'
          : `best of ${partners.length} partners (${best.move.partner?.name ?? 'unnamed'})`,
    });
  }
  return out.sort((a, b) => a.landCount - b.landCount);
}

/**
 * Correct, rank and roll up. The statistics are `finishSuggestionRun` verbatim —
 * Holm over the phase's family, every verdict re-decided from the corrected p —
 * and this function only reads the result back as moves.
 */
export function finishJointPhase(input: FinishJointPhaseInput): JointPhaseReport {
  const stats = input.stats ?? DEFAULT_STATS_CONFIG;
  const plan = input.plan;
  const report = finishSuggestionRun({
    baseDeckName: plan.baseDeckName,
    search: input.search,
    skipped: [],
    candidatesGenerated: plan.candidatesGenerated,
    cappedByBudget: plan.joint.capped.length > 0,
    elapsedSeconds: input.elapsedSeconds,
    history: plan.history,
    method: DEFAULT_ADAPTIVE_CONFIG.multipleComparisons,
    exploration: DEFAULT_EXPLORATION_WEIGHTS,
    stats,
    ...(input.workersUsed !== undefined ? { workersUsed: input.workersUsed } : {}),
  });

  const gamesByKey = new Map(input.search.outcomes.map((o) => [o.candidate.key, o.gamesPlayed] as const));
  const rows: JointMoveRow[] = [];
  for (const ranked of report.suggestions) {
    const key = `${ranked.evaluation.swap.out}>${ranked.evaluation.swap.in}`;
    const move = moveForCandidateKey(key, plan.joint.moves);
    if (!move) continue; // a foreign key cannot come from our own plan; never invent a row
    const depth = gamesByKey.get(key) ?? ranked.gamesPlayed;
    const observed = input.moveObserved?.get(key);
    rows.push({
      rank: ranked.rank,
      key,
      move,
      evaluation: ranked.evaluation,
      gamesPlayed: ranked.gamesPlayed,
      rawPValue: ranked.rawPValue,
      adjustedPValue: ranked.adjustedPValue,
      ...(ranked.elimination ? { elimination: ranked.elimination } : {}),
      ...(input.baseObserved && observed
        ? { reliability: compareReliability(input.baseObserved.slice(0, depth), observed.slice(0, depth), stats) }
        : {}),
    });
  }

  const winner = rows.find((row) => row.evaluation.verdict === 'better');
  const edge = winner
    ? undefined
    : [...rows.filter((row) => row.evaluation.verdict === 'inconclusive')].sort(
        (a, b) => b.evaluation.delta - a.evaluation.delta,
      )[0];

  return {
    deckName: plan.baseDeckName,
    deckFingerprint: plan.deckFingerprint,
    phase: plan.joint.phase,
    round: plan.joint.round,
    deckSize: plan.joint.deckSize,
    base: plan.joint.base,
    partnerRule: plan.joint.partnerRule,
    verdict: winner ? 'improved' : 'inconclusive',
    rows,
    ...(winner ? { winner } : {}),
    ...(edge ? { edge } : {}),
    landCounts: rollUpLandCounts(rows, plan.joint.base, report.baseGauntletWinRate),
    baseWinRate: report.baseGauntletWinRate,
    movesEvaluated: rows.length,
    skipped: plan.joint.skipped,
    capped: plan.joint.capped,
    failures: input.search.failures,
    waves: report.waves,
    multipleComparisons: report.multipleComparisons,
    notes: report.notes,
    gamesPlayed: report.notes.totalGamesRun,
    elapsedSeconds: input.elapsedSeconds,
    confoundNote: JOINT_CONFOUND_NOTE,
    notGatedOn: JOINT_NOT_GATED_ON,
  };
}

// --- the search state, as plain data ------------------------------------------------

/** What the user allowed the search to spend. Both halves are hard. */
export interface JointBudget {
  readonly maxGames: number;
  readonly maxSeconds: number;
}

/** What the search has spent so far — the live "spent" half of the budget. */
export interface JointSpend {
  readonly games: number;
  readonly seconds: number;
  readonly phasesRun: number;
}

/** One accepted move: what changed, what it bought, and what it cost. */
export interface JointPathStep {
  readonly round: number;
  readonly phase: JointPhaseId;
  readonly move: JointMove;
  /** variant − base win rate, in proportion, as measured in that phase. */
  readonly delta: number;
  readonly verdict: SwapVerdict;
  readonly adjustedPValue: number;
  readonly gamesPlayed: number;
  /** Deck size and land count AFTER the move — the denominators it changed. */
  readonly deckSize: number;
  readonly landCount: number;
}

/**
 * THE SEARCH, as plain data between phases — which is what makes it resumable
 * and interruptible. The panel keeps one of these, renders the path and the
 * spend, and asks for the next phase (or does not).
 */
export interface JointSearchState {
  /** The deck as it stands: the base deck with every accepted move applied. */
  readonly deck: Deck;
  /** The deck the session began with — the path's starting point. */
  readonly startDeck: Deck;
  readonly round: number;
  /** Index into `JOINT_PHASES` of the phase to run NEXT. */
  readonly phaseIndex: number;
  readonly path: readonly JointPathStep[];
  readonly spend: JointSpend;
  readonly budget: JointBudget;
  /** Moves accepted in the round in progress — zero means a local optimum looms. */
  readonly acceptedThisRound: number;
  /** Set once the search is over; `undefined` while it can still run. */
  readonly stopped?: JointStopReasonId;
  /** Every phase report so far, in order — the audit trail. */
  readonly phases: readonly JointPhaseReport[];
}

/** Begin a search over `deck`. Pure; plays nothing. */
export function startJointSearch(deck: Deck, budget: JointBudget = DEFAULT_JOINT_BUDGET): JointSearchState {
  return {
    deck,
    startDeck: deck,
    round: 0,
    phaseIndex: 0,
    path: [],
    spend: { games: 0, seconds: 0, phasesRun: 0 },
    budget,
    acceptedThisRound: 0,
    phases: [],
  };
}

/** The phase a state will run next, or `undefined` once it has stopped. */
export function nextJointPhase(state: JointSearchState): JointPhaseId | undefined {
  if (state.stopped !== undefined) return undefined;
  return JOINT_PHASES[state.phaseIndex]?.id;
}

/**
 * Whether the budget can pay for another phase, with the reason when it cannot.
 * A phase too small to decide anything is refused rather than run: its verdicts
 * would all come back inconclusive, which reads as "nothing is better" and is a
 * different claim.
 */
export function jointBudgetRemaining(state: JointSearchState): {
  readonly games: number;
  readonly seconds: number;
  readonly canRunPhase: boolean;
} {
  const games = Math.max(0, state.budget.maxGames - state.spend.games);
  const seconds = Math.max(0, state.budget.maxSeconds - state.spend.seconds);
  return { games, seconds, canRunPhase: games >= JOINT_MIN_PHASE_GAMES && seconds > 0 };
}

/**
 * THE REDUCER: fold one finished phase into the search.
 *
 * Accept the phase's winner (if it proved better), charge the phase to the
 * budget, advance to the next phase — and, at the end of a round, decide whether
 * the descent goes on. A full round that accepted nothing is a LOCAL OPTIMUM and
 * stops the search saying exactly that; nothing here ever claims a global one.
 *
 * Pure: same state and report in, same state out. The apply is
 * `applyJointMove` — the one fold, so the deck the next phase searches from is
 * byte-for-byte the deck that was played.
 */
export function advanceJointSearch(
  state: JointSearchState,
  report: JointPhaseReport,
  pool: CardPool,
): JointSearchState {
  const accepted = report.verdict === 'improved' && report.winner !== undefined;
  const deck = accepted ? applyJointMove(state.deck, (report.winner as JointMoveRow).move, pool) : state.deck;
  const path: JointPathStep[] = [...state.path];
  if (accepted) {
    const winner = report.winner as JointMoveRow;
    path.push({
      round: report.round,
      phase: report.phase,
      move: winner.move,
      delta: winner.evaluation.delta,
      verdict: winner.evaluation.verdict,
      adjustedPValue: winner.adjustedPValue,
      gamesPlayed: winner.gamesPlayed,
      deckSize: deckSizeOf(deck),
      landCount: winner.move.landCount,
    });
  }
  const spend: JointSpend = {
    games: state.spend.games + report.gamesPlayed,
    seconds: state.spend.seconds + report.elapsedSeconds,
    phasesRun: state.spend.phasesRun + 1,
  };
  const acceptedThisRound = state.acceptedThisRound + (accepted ? 1 : 0);
  const phases = [...state.phases, report];

  const lastPhaseOfRound = state.phaseIndex >= JOINT_PHASES.length - 1;
  const nextRound = lastPhaseOfRound ? state.round + 1 : state.round;
  const nextPhaseIndex = lastPhaseOfRound ? 0 : state.phaseIndex + 1;
  const next: JointSearchState = {
    ...state,
    deck,
    round: nextRound,
    phaseIndex: nextPhaseIndex,
    path,
    spend,
    phases,
    acceptedThisRound: lastPhaseOfRound ? 0 : acceptedThisRound,
  };

  // A round ends: nothing accepted anywhere in it means this search cannot see
  // a better deck from here.
  if (lastPhaseOfRound && acceptedThisRound === 0) return { ...next, stopped: 'local-optimum' };
  if (lastPhaseOfRound && nextRound >= JOINT_MAX_ROUNDS) return { ...next, stopped: 'max-rounds' };
  if (!jointBudgetRemaining(next).canRunPhase) return { ...next, stopped: 'budget-spent' };
  return next;
}

/** Stop a live search because the user said so — the interruptible half. */
export function interruptJointSearch(state: JointSearchState): JointSearchState {
  return state.stopped === undefined ? { ...state, stopped: 'interrupted' } : state;
}

/** The stop reason's row, so a surface prints the shared meaning, not its own. */
export function jointStopReasonOf(id: JointStopReasonId): (typeof JOINT_STOP_REASONS)[number] {
  const row = JOINT_STOP_REASONS.find((reason) => reason.id === id);
  if (!row) throw new Error(`no joint stop reason named "${id}"`);
  return row;
}

/**
 * THE CLAIM A FINISHED SEARCH MAKES, assembled from what actually happened.
 * There is no "perfect ratio" here and there must not be: the sentence names the
 * budget that was spent, the path that was walked, and the reason it stopped.
 */
export function describeJointOutcome(state: JointSearchState): string {
  const reason = state.stopped ? jointStopReasonOf(state.stopped) : undefined;
  const moves = state.path.length;
  const head =
    moves === 0
      ? 'No move beat the deck you started with.'
      : `${moves} move${moves === 1 ? '' : 's'} were accepted, in this order: ` +
        `${state.path.map((step) => step.move.label).join(' → ')}.`;
  const spent =
    `${state.spend.games} of ${state.budget.maxGames} games and ` +
    `${state.spend.seconds.toFixed(1)} of ${state.budget.maxSeconds} seconds spent over ` +
    `${state.spend.phasesRun} phase${state.spend.phasesRun === 1 ? '' : 's'}.`;
  return [head, spent, reason ? `Stopped: ${reason.label} — ${reason.meaning}` : 'Still running.', JOINT_HONEST_CLAIM].join(' ');
}

// --- playing a phase on the calling thread ------------------------------------------

/**
 * The slice of a `PairedArmRunner` a local phase needs. Narrow on purpose: a
 * test rigs one of these with planted tallies to prove the SEARCH — which count
 * it reaches, which partner it picks, where it stops — without the answer being
 * hostage to what a few dozen real games happen to say.
 */
export type JointArmRunner = Pick<PairedArmRunner, 'openVariantArm' | 'advance' | 'usage'>;

/** Progress callbacks for a local phase. */
export interface JointProgress {
  readonly onWave?: (info: { readonly wave: number; readonly totalWaves: number; readonly moves: number }) => void;
  readonly onGame?: (games: number) => void;
  readonly onPhase?: (report: JointPhaseReport) => void;
}

/**
 * Drive one phase's wave ladder on the calling thread — the sequential
 * counterpart of the Lab's pooled driver, over the SAME plan. Nothing here
 * decides who survives; `driveAdaptiveSearch` does.
 */
export function driveJointPhase(
  deck: Deck,
  plan: JointPhasePlan,
  pool: CardPool,
  runner: JointArmRunner,
  settings: { readonly adaptiveConfig?: AdaptiveSearchConfig; readonly stats?: StatsConfig } = {},
  progress?: JointProgress,
): {
  readonly outcome: AdaptiveSearchOutcome;
  readonly usage: PairedArmsUsage;
  readonly arms: ReadonlyMap<string, SwapArm>;
} {
  const handles = new Map<string, ArmHandle>();
  const lastArm = new Map<string, SwapArm>();
  const driver = driveAdaptiveSearch(plan, {
    adaptiveConfig: settings.adaptiveConfig ?? DEFAULT_ADAPTIVE_CONFIG,
    explorationWeights: DEFAULT_EXPLORATION_WEIGHTS,
    stats: settings.stats ?? DEFAULT_STATS_CONFIG,
  });

  let step = driver.next();
  while (!step.done) {
    const wave = step.value;
    progress?.onWave?.({ wave: wave.wave, totalWaves: plan.waves.length, moves: wave.arms.length });
    const answers: AdaptiveArmOutcome[] = [];
    for (const request of wave.arms) {
      const candidate = request.candidate;
      let handle = handles.get(candidate.key);
      if (!handle) {
        const move = moveForCandidateKey(candidate.key, plan.joint.moves);
        try {
          if (!move) throw new Error(`the plan names no joint move for candidate "${candidate.key}"`);
          handle = runner.openVariantArm({
            key: move.key,
            label: move.label,
            variantDeck: applyJointMove(deck, move, pool),
            slotsChanged: move.slotsChanged,
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
  return { outcome: step.value, usage: runner.usage(), arms: lastArm };
}

/** Everything one local phase needs beyond the plan. */
export interface RunJointPhaseOptions extends Omit<PlanJointPhaseOptions, 'opponentCount'> {
  readonly gauntletDecks: readonly LoadedDeck[];
  readonly pilots: MatchupPilots;
  readonly registry: EffectRegistry;
  readonly runOptions?: RunOptions;
  readonly stats?: StatsConfig;
  readonly onProgress?: JointProgress;
  /**
   * Where the games are played. Defaults to a real `createPairedArmRunner` over
   * the gauntlet; a test supplies a rigged runner. Called once per phase with
   * the plan, so a rig can key its answers on the phase's deck.
   */
  readonly armRunner?: (deck: Deck, plan: JointPhasePlan) => JointArmRunner;
  /** Wall clock, isolated so a run stays a data transform in tests. */
  readonly now?: () => number;
}

/** Play ONE phase on the calling thread: plan → ladder → report. */
export function runJointPhase(deck: Deck, options: RunJointPhaseOptions): JointPhaseReport {
  const now = options.now ?? (() => Date.now() / 1000);
  const startedAt = now();
  const stats = options.stats ?? DEFAULT_STATS_CONFIG;
  const plan = planJointPhase(deck, { ...options, opponentCount: options.gauntletDecks.length });
  const rigged = options.armRunner?.(deck, plan);
  const runner: JointArmRunner =
    rigged ??
    createPairedArmRunner(deck, {
      gauntletDecks: options.gauntletDecks,
      pilots: options.pilots,
      pool: options.pool,
      registry: options.registry,
      seed: plan.runSeed,
      deckRules: options.deckRules ?? DEFAULT_DECK_RULES,
      ...(options.runOptions ? { runOptions: options.runOptions } : {}),
      ...(options.onProgress?.onGame ? { onGame: options.onProgress.onGame } : {}),
      // §3.175's watch: the reliability of a manabase move is READ on every
      // phase so the path can be audited. It is never a gate here.
      watchGames: () => createReliabilityWatch(),
    });

  const { outcome, usage, arms } = driveJointPhase(
    deck,
    plan,
    options.pool,
    runner,
    {
      ...(options.adaptiveConfig ? { adaptiveConfig: options.adaptiveConfig } : {}),
      ...(options.stats ? { stats: options.stats } : {}),
    },
    options.onProgress,
  );

  // Readings, when the runner is a real (watched) one. A rigged runner has none
  // and the rows simply carry no reliability — reported absent, never zeroed.
  const full = rigged ? undefined : (runner as PairedArmRunner);
  const baseObserved: (PairedGameObservation | null)[] | undefined = full
    ? Array.from({ length: outcome.baseSlotsPlayed }, (_, slot) => full.baseRecordAt(slot).observed ?? null)
    : undefined;
  const moveObserved = new Map<string, readonly (PairedGameObservation | null)[]>();
  if (full) for (const [key, arm] of arms) moveObserved.set(key, arm.observedBySlot ?? []);

  const report = finishJointPhase({
    plan,
    search: {
      outcomes: outcome.arms.map((arm) => {
        const played = arms.get(arm.candidate.key);
        return {
          candidate: arm.candidate,
          evaluation: summarizePairedSwap({
            baseDeckName: deck.name,
            variantDeckName: arm.candidate.variantDeckName,
            swap: { out: arm.candidate.outId, in: arm.candidate.inId },
            outName: arm.candidate.outName,
            inName: arm.candidate.inName,
            paired: played?.paired ?? arm.paired,
            stats,
            scope: DEFAULT_SWAP_SCOPE,
            copiesSwapped: arm.candidate.copiesSwapped,
          }),
          gamesPlayed: arm.gamesPlayed,
          ...(arm.elimination ? { elimination: arm.elimination } : {}),
        };
      }),
      waves: outcome.waves,
      usage,
      failures: outcome.failures,
      fixedSchemeGames: outcome.fixedSchemeGames,
    },
    elapsedSeconds: now() - startedAt,
    stats,
    ...(baseObserved ? { baseObserved } : {}),
    ...(full ? { moveObserved } : {}),
  });
  options.onProgress?.onPhase?.(report);
  return report;
}

// --- the whole descent --------------------------------------------------------------

/** Options for a whole search — the phase options minus what the loop decides. */
export interface JointSearchOptions extends Omit<RunJointPhaseOptions, 'phase' | 'round'> {
  readonly budget?: JointBudget;
  /**
   * Called between phases; returning `true` stops the search with `interrupted`.
   * This is the interruptible half of the contract — a long search never becomes
   * an hour-long black box.
   */
  readonly shouldStop?: (state: JointSearchState) => boolean;
}

/**
 * THE ALTERNATING DESCENT: manabase phase, spell phase, repeat — accepting a
 * phase's winner, charging its games to the budget, and stopping the moment a
 * full round improves nothing, the budget cannot pay for another phase, the
 * round cap is reached, or the caller says stop.
 *
 * Resumable by construction: it is `advanceJointSearch` in a loop over plain
 * state, so a caller that keeps the state can stop between any two phases and
 * carry on later — which is exactly what the Lab panel does.
 */
export function runJointSearch(base: Deck, options: JointSearchOptions): JointSearchState {
  let state = startJointSearch(base, options.budget ?? DEFAULT_JOINT_BUDGET);
  if (!jointBudgetRemaining(state).canRunPhase) return { ...state, stopped: 'budget-spent' };

  for (;;) {
    if (options.shouldStop?.(state)) return interruptJointSearch(state);
    const phase = nextJointPhase(state);
    if (phase === undefined) return state;
    const report = runJointPhase(state.deck, { ...options, phase, round: state.round });
    // A phase with nothing to evaluate means every family was out of reach for
    // this deck; the skip list says why, per family.
    if (report.rows.length === 0 && state.path.length === 0) {
      return { ...advanceJointSearch(state, report, options.pool), stopped: 'no-moves' };
    }
    state = advanceJointSearch(state, report, options.pool);
    if (state.stopped !== undefined) return state;
  }
}
