/**
 * RELIABILITY, MEASURED (DESIGN §3.175) — what a manabase is FOR, read off the
 * games the paired runner already plays.
 *
 * A win rate says whether a manabase is better; it does not say why, and two
 * manabases can tie on wins while one of them stumbles on turn three twice as
 * often. So beside the win rate the Lab reports, per game and then aggregated:
 *
 *  - **a missed land drop** — one of the hero's 2nd–4th own turns that ended
 *    with NO land played, in the plain sense of "I missed my third land drop".
 *    That is the manabase's failure to deliver, which is what the brief's
 *    acceptance test names (a kept one-lander misses turns two and three).
 *    Separately, the watch counts the turns in which the hero HELD a land at a
 *    main-phase window and still played none (`heldLandTurns`) — the pilot's
 *    choice rather than the deck's, reported beside the rate so the two cannot
 *    be confused. A turn cut short by the game ending is not judged at all.
 *  - **colour screw** — a hero turn from the 3rd on in which a spell in hand
 *    could have been paid for in TOTAL mana but not in the right colours. Judged
 *    once per turn, at the first main-phase window after the land drop (or once
 *    there is no land to drop), with the engine's own affordability check for
 *    both readings — never a second opinion about what the board can produce.
 *  - **lands at the start of turn four** — how many lands the hero controls as
 *    its 4th own turn begins.
 *
 * Every number is READ, never modelled: the watch sees the settled states and
 * the events of the real game (`PairedGameWatch`). What the seam cannot see is
 * reported as NOT MEASURED (`RELIABILITY_NOT_MEASURED`) rather than guessed.
 *
 * Because base and variant play the same seeds, these per-game readings are
 * PAIRED exactly as the wins are, so a variant's reliability is judged against
 * the base with the same McNemar test and the same verdict rule the win rate
 * uses — one statistics module, two questions.
 */

import type { GameEvent, GameState, PlayerId } from '@jonny-boi/core';
import { canAffordManaCost, convertedManaCost, isLand, MAIN_STEPS } from '@jonny-boi/core';
import type { StatsConfig } from './config.js';
import { DEFAULT_STATS_CONFIG } from './config.js';
import type { PairedGameObservation, PairedGameWatch } from './paired-arms.js';
import { HERO_SEAT } from './paired-arms-config.js';
import { mcNemarTest, normalCdf, wilsonInterval, type PairedTable, type ProportionCI } from './stats.js';
import { decideVerdict, type SwapVerdict } from './swap.js';
import {
  COLOUR_SCREW_FROM_TURN,
  LAND_DROP_TURNS,
  LANDS_ON_BATTLEFIELD_TURN,
  RELIABILITY_METRICS,
  RELIABILITY_NOT_MEASURED,
  type ReliabilityMetricId,
} from './manabase-config.js';

/**
 * What the watch reports for ONE game. A `type` alias (not an interface) so it
 * is assignable to the runner's plain-JSON `PairedGameObservation`.
 */
export type ReliabilityObservation = {
  /** Completed hero turns in `LAND_DROP_TURNS` that ended with no land played. */
  readonly missedLandDrops: number;
  /**
   * Of those, the turns in which a land sat in the hero's hand at a main-phase
   * window before any drop — the pilot could have played one and did not.
   */
  readonly heldLandTurns: number;
  /** Hero turns from `COLOUR_SCREW_FROM_TURN` on judged colour-screwed. */
  readonly colourScrewTurns: number;
  /** Lands the hero controlled as its `LANDS_ON_BATTLEFIELD_TURN`th turn began; `null` if never reached. */
  readonly landsOnTurn4: number | null;
  /** Hero turns that began — the denominator context for the counts above. */
  readonly heroTurns: number;
};

/**
 * The watch. One per game (`PairedArmsOptions.watchGames`), reading the hero's
 * seat only — the opponent's manabase is not under test.
 */
export function createReliabilityWatch(hero: PlayerId = HERO_SEAT): PairedGameWatch {
  let heroTurns = 0;
  /** `turnNumber` of the hero turn in progress, or -1 between hero turns. */
  let currentTurn = -1;
  let landsPlayedThisTurn = 0;
  let heldLandBeforeDrop = false;
  let colourJudged = false;
  let missedLandDrops = 0;
  let heldLandTurns = 0;
  let colourScrewTurns = 0;
  let landsOnTurn4: number | null = null;

  /** Judge the hero turn that just ended (a completed turn only). */
  function finishHeroTurn(): void {
    if (currentTurn < 0) return;
    if (heroTurns >= LAND_DROP_TURNS.from && heroTurns <= LAND_DROP_TURNS.to && landsPlayedThisTurn === 0) {
      missedLandDrops++;
      if (heldLandBeforeDrop) heldLandTurns++;
    }
    currentTurn = -1;
  }

  return {
    onEvent(event: GameEvent): void {
      if (event.type === 'turnBegin') {
        finishHeroTurn();
        if (event.activePlayer === hero) {
          heroTurns++;
          currentTurn = event.turn;
          landsPlayedThisTurn = 0;
          heldLandBeforeDrop = false;
          colourJudged = false;
        }
      } else if (event.type === 'landPlayed' && event.player === hero && currentTurn >= 0) {
        landsPlayedThisTurn++;
      }
    },
    onState(state: GameState): void {
      if (currentTurn < 0 || state.turnNumber !== currentTurn || state.activePlayer !== hero) return;
      if (heroTurns === LANDS_ON_BATTLEFIELD_TURN && landsOnTurn4 === null) {
        landsOnTurn4 = landsControlledBy(state, hero);
      }
      if (state.priorityPlayer !== hero || !MAIN_STEPS.includes(state.step)) return;
      const hand = state.players[hero].hand;
      const played = state.players[hero].landsPlayedThisTurn;
      const holdsLand = hand.some((card) => isLand(card.def));
      if (played === 0 && holdsLand) heldLandBeforeDrop = true;
      if (
        !colourJudged &&
        heroTurns >= COLOUR_SCREW_FROM_TURN &&
        state.stack.length === 0 &&
        (played >= 1 || !holdsLand)
      ) {
        colourJudged = true;
        if (hand.some((card) => uncastableOnlyForColour(state, hero, card.def))) colourScrewTurns++;
      }
    },
    finish(): PairedGameObservation {
      // A turn in progress when the game ends is NOT judged — it was cut short.
      const observation: ReliabilityObservation = {
        missedLandDrops,
        heldLandTurns,
        colourScrewTurns,
        landsOnTurn4,
        heroTurns,
      };
      return observation;
    },
  };
}

function landsControlledBy(state: GameState, player: PlayerId): number {
  let lands = 0;
  for (const permanent of state.battlefield) {
    if (permanent.controller === player && isLand(permanent.def)) lands++;
  }
  return lands;
}

/**
 * "Uncastable ONLY for colour": the engine refuses the printed cost but would
 * accept a cost of the same mana value with every pip made generic. Both
 * readings come from `canAffordManaCost` — the engine's one authority on what a
 * board can pay — so this can never disagree with what the pilot was offered.
 */
export function uncastableOnlyForColour(
  state: GameState,
  player: PlayerId,
  def: GameState['battlefield'][number]['def'],
): boolean {
  if (isLand(def) || !def.cost || def.noManaCost) return false;
  const total = convertedManaCost(def.cost);
  if (total === 0) return false;
  if (canAffordManaCost(state, player, def.cost)) return false;
  return canAffordManaCost(state, player, { generic: total });
}

/**
 * Read a runner observation back as a reliability record, refusing (returning
 * `undefined`) anything that is not one: a record from a different watch, or a
 * slot the skip answered from a record with no observation. A refused record is
 * left out of the denominator, never counted as a zero.
 */
export function reliabilityOf(observation: PairedGameObservation | null | undefined): ReliabilityObservation | undefined {
  if (!observation) return undefined;
  const missed = observation['missedLandDrops'];
  const held = observation['heldLandTurns'];
  const screw = observation['colourScrewTurns'];
  const lands = observation['landsOnTurn4'];
  const turns = observation['heroTurns'];
  if (typeof missed !== 'number' || typeof held !== 'number' || typeof screw !== 'number' || typeof turns !== 'number') {
    return undefined;
  }
  if (lands !== null && typeof lands !== 'number') return undefined;
  return {
    missedLandDrops: missed,
    heldLandTurns: held,
    colourScrewTurns: screw,
    landsOnTurn4: lands ?? null,
    heroTurns: turns,
  };
}

// --- aggregation ---------------------------------------------------------------

/** A mean with a two-sided normal-approximation interval. */
export interface MeanCI {
  readonly mean: number;
  readonly low: number;
  readonly high: number;
  /** Readings the mean is over. */
  readonly n: number;
}

/**
 * Mean ± z·s/√n. With one reading or none the interval is the reading itself
 * (or `[0, 0]` for none) — degenerate on purpose rather than a division by zero.
 */
export function meanInterval(values: readonly number[], z: number): MeanCI {
  const n = values.length;
  if (n === 0) return { mean: 0, low: 0, high: 0, n: 0 };
  const mean = values.reduce((sum, v) => sum + v, 0) / n;
  if (n === 1) return { mean, low: mean, high: mean, n };
  const variance = values.reduce((sum, v) => sum + (v - mean) * (v - mean), 0) / (n - 1);
  const margin = (z * Math.sqrt(variance)) / Math.sqrt(n);
  return { mean, low: mean - margin, high: mean + margin, n };
}

/** One arm's reliability, summarised over the games it was observed in. */
export interface ReliabilitySummary {
  /** Games with at least one observation (the rates' denominator). */
  readonly games: number;
  /** Share of games with a missed land drop in turns 2–4. */
  readonly missedLandDrop: ProportionCI;
  /**
   * Of the games with a missed drop, how many missed while HOLDING a playable
   * land at least once — the pilot's share of the misses, printed as a footnote
   * so a deck is not blamed for a choice.
   */
  readonly heldLandGames: number;
  /** Share of games with a colour-screwed turn. */
  readonly colourScrew: ProportionCI;
  /** Lands at the start of turn four, over the games that reached it. */
  readonly landsOnTurn4: MeanCI;
}

/** Summarise one arm's observations. `null`/foreign entries are left out. */
export function summarizeReliability(
  observations: readonly (PairedGameObservation | null | undefined)[],
  stats: StatsConfig = DEFAULT_STATS_CONFIG,
): ReliabilitySummary {
  let games = 0;
  let missed = 0;
  let held = 0;
  let screwed = 0;
  const lands: number[] = [];
  for (const raw of observations) {
    const observation = reliabilityOf(raw);
    if (!observation) continue;
    games++;
    if (observation.missedLandDrops > 0) missed++;
    if (observation.heldLandTurns > 0) held++;
    if (observation.colourScrewTurns > 0) screwed++;
    if (observation.landsOnTurn4 !== null) lands.push(observation.landsOnTurn4);
  }
  return {
    games,
    missedLandDrop: wilsonInterval(missed, games, stats.z),
    heldLandGames: held,
    colourScrew: wilsonInterval(screwed, games, stats.z),
    landsOnTurn4: meanInterval(lands, stats.z),
  };
}

/** How one metric moved from the base to a variant, judged on the paired games. */
export interface ReliabilityMetricComparison {
  readonly id: ReliabilityMetricId;
  readonly label: string;
  /**
   * 'better' = MORE reliable, 'worse' = LESS reliable, whichever direction the
   * metric's good side is; 'inconclusive' when the paired test cannot say.
   */
  readonly verdict: SwapVerdict;
  /** The paired test's p-value (McNemar for a rate, a paired z-test for a mean). */
  readonly pValue: number;
  /** Paired games the comparison rests on. */
  readonly nPaired: number;
  /** The per-game difference for a mean metric (variant − base); absent for rates. */
  readonly meanDifference?: MeanCI;
}

/** A variant's reliability beside the base's, with the per-metric verdicts. */
export interface ReliabilityComparison {
  readonly base: ReliabilitySummary;
  readonly variant: ReliabilitySummary;
  readonly metrics: readonly ReliabilityMetricComparison[];
  /** Metrics the seam cannot observe, verbatim from the config table. */
  readonly notMeasured: typeof RELIABILITY_NOT_MEASURED;
  /**
   * THE RULE the panel states: reliability is "not worse" when no metric's
   * paired verdict is 'worse'. Inconclusive metrics do not count against a
   * variant — a run too short to decide is not evidence of a stumble.
   */
  readonly notWorse: boolean;
}

/**
 * Compare a variant's per-slot observations with the base's, slot for slot.
 *
 * Only slots BOTH arms observed enter a comparison; a slot either arm has no
 * record for is dropped from that metric's denominator rather than imputed.
 * For a rate, "the bad thing did not happen" is treated as the win, so the
 * verdict comes out of `decideVerdict` with its usual meaning — 'better' is
 * fewer bad games for the variant.
 */
export function compareReliability(
  baseBySlot: readonly (PairedGameObservation | null | undefined)[],
  variantBySlot: readonly (PairedGameObservation | null | undefined)[],
  stats: StatsConfig = DEFAULT_STATS_CONFIG,
): ReliabilityComparison {
  const depth = Math.min(baseBySlot.length, variantBySlot.length);
  const pairs: { readonly base: ReliabilityObservation; readonly variant: ReliabilityObservation }[] = [];
  for (let slot = 0; slot < depth; slot++) {
    const base = reliabilityOf(baseBySlot[slot]);
    const variant = reliabilityOf(variantBySlot[slot]);
    if (base && variant) pairs.push({ base, variant });
  }

  const metrics: ReliabilityMetricComparison[] = RELIABILITY_METRICS.map((metric) => {
    if (metric.kind === 'rate') {
      const bad =
        metric.id === 'missedLandDrop'
          ? (o: ReliabilityObservation) => o.missedLandDrops > 0
          : (o: ReliabilityObservation) => o.colourScrewTurns > 0;
      const table: { bothWon: number; baseOnly: number; variantOnly: number; neither: number } = {
        bothWon: 0,
        baseOnly: 0,
        variantOnly: 0,
        neither: 0,
      };
      for (const { base, variant } of pairs) {
        const baseGood = !bad(base);
        const variantGood = !bad(variant);
        if (baseGood && variantGood) table.bothWon++;
        else if (baseGood) table.baseOnly++;
        else if (variantGood) table.variantOnly++;
        else table.neither++;
      }
      const paired: PairedTable = table;
      const test = mcNemarTest(paired);
      const delta = (table.variantOnly - table.baseOnly) / Math.max(1, pairs.length);
      const verdict = decideVerdict(delta, test.pValue, pairs.length, stats.alpha, stats.minGamesForVerdict);
      return { id: metric.id, label: metric.label, verdict, pValue: test.pValue, nPaired: pairs.length };
    }
    // A mean metric: the paired per-game difference, variant − base, over the
    // games where BOTH arms reached the reading.
    const differences: number[] = [];
    for (const { base, variant } of pairs) {
      if (base.landsOnTurn4 !== null && variant.landsOnTurn4 !== null) {
        differences.push(variant.landsOnTurn4 - base.landsOnTurn4);
      }
    }
    const meanDifference = meanInterval(differences, stats.z);
    const pValue = pairedMeanPValue(differences);
    const signed = metric.direction === 'higherIsBetter' ? meanDifference.mean : -meanDifference.mean;
    const verdict = decideVerdict(signed, pValue, differences.length, stats.alpha, stats.minGamesForVerdict);
    return { id: metric.id, label: metric.label, verdict, pValue, nPaired: differences.length, meanDifference };
  });

  return {
    base: summarizeReliability(baseBySlot.slice(0, depth), stats),
    variant: summarizeReliability(variantBySlot.slice(0, depth), stats),
    metrics,
    notMeasured: RELIABILITY_NOT_MEASURED,
    notWorse: metrics.every((metric) => metric.verdict !== 'worse'),
  };
}

/**
 * Two-sided p-value of a paired z-test on per-game differences (H0: mean 0).
 * All-identical differences (zero variance) give p = 1 when the mean is 0 and
 * p = 0 otherwise — the two cases where the test needs no estimate.
 */
export function pairedMeanPValue(differences: readonly number[]): number {
  const n = differences.length;
  if (n < 2) return 1;
  const mean = differences.reduce((sum, d) => sum + d, 0) / n;
  const variance = differences.reduce((sum, d) => sum + (d - mean) * (d - mean), 0) / (n - 1);
  if (variance === 0) return mean === 0 ? 1 : 0;
  const z = Math.abs(mean) / Math.sqrt(variance / n);
  return 2 * (1 - normalCdf(z));
}
