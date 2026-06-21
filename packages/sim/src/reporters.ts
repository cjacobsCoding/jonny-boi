/**
 * The sim **reporter registry** (DESIGN §2 "Sim harness & reporter registry").
 *
 * A reporter turns a stream of per-game `MatchResult`s into a named metric — a
 * win-rate, turn/length stats, etc. Reporters SELF-REGISTER by id, so adding a
 * metric is a new small module + one `register` call and never touches the match
 * loop (the §2 seam). The harness feeds each finished game to every registered
 * reporter via `observe`, then `summarize` emits the metric rows.
 *
 * The A/B significance reporter is a registered reporter too, fed the paired
 * outcomes — proving the swap verdict plugs into the same seam rather than being
 * special-cased.
 */

import type { MatchResult } from './match.js';
import { wilsonInterval, type ProportionCI } from './stats.js';
import { DEFAULT_STATS_CONFIG, type StatsConfig } from './config.js';

/** One labelled metric value a reporter emits. */
export interface MetricRow {
  readonly label: string;
  readonly value: string;
}

/**
 * A reporter accumulates over a run and summarizes. Stateful per run: build a
 * fresh instance per gauntlet/matchup via its factory so runs don't bleed.
 */
export interface Reporter {
  readonly id: string;
  /** Fold one finished game into the accumulator. */
  observe(result: MatchResult, heroSeat: 'A' | 'B'): void;
  /** Emit the metric rows for everything observed so far. */
  summarize(): readonly MetricRow[];
}

/** A factory the registry stores (so each run gets a fresh accumulator). */
export type ReporterFactory = (stats: StatsConfig) => Reporter;

/** The reporter registry seam — self-registration + lookup by id. */
export interface ReporterRegistry {
  register(id: string, factory: ReporterFactory): void;
  get(id: string): ReporterFactory | undefined;
  ids(): readonly string[];
  /** Instantiate every registered reporter (for a run). */
  instantiateAll(stats?: StatsConfig): Reporter[];
}

export function createReporterRegistry(): ReporterRegistry {
  const factories = new Map<string, ReporterFactory>();
  return {
    register(id, factory) {
      factories.set(id, factory);
    },
    get(id) {
      return factories.get(id);
    },
    ids() {
      return [...factories.keys()];
    },
    instantiateAll(stats = DEFAULT_STATS_CONFIG) {
      return [...factories.values()].map((f) => f(stats));
    },
  };
}

// --- built-in reporters --------------------------------------------------------

export const WIN_RATE_REPORTER_ID = 'winRate';
export const TURN_STATS_REPORTER_ID = 'turnStats';

/** Win-rate from the hero's seat, with a Wilson CI. */
function createWinRateReporter(stats: StatsConfig): Reporter {
  let wins = 0;
  let games = 0;
  let draws = 0;
  return {
    id: WIN_RATE_REPORTER_ID,
    observe(result, heroSeat) {
      games++;
      if (result.outcome.kind === 'win') {
        if (result.outcome.winner === heroSeat) wins++;
      } else {
        draws++;
      }
    },
    summarize() {
      const ci: ProportionCI = wilsonInterval(wins, games, stats.z);
      return [
        { label: 'Win rate', value: `${pct(ci.p)} (${pct(ci.low)}–${pct(ci.high)})` },
        { label: 'Record (W / total)', value: `${wins} / ${games}` },
        { label: 'Draws (timeouts)', value: String(draws) },
      ];
    },
  };
}

/** Game-length stats: mean turns, min/max, and how many hit the timeout cap. */
function createTurnStatsReporter(_stats: StatsConfig): Reporter {
  let games = 0;
  let totalTurns = 0;
  let minTurns = Number.POSITIVE_INFINITY;
  let maxTurns = 0;
  let timeouts = 0;
  return {
    id: TURN_STATS_REPORTER_ID,
    observe(result) {
      games++;
      totalTurns += result.turns;
      if (result.turns < minTurns) minTurns = result.turns;
      if (result.turns > maxTurns) maxTurns = result.turns;
      if (result.outcome.kind === 'timeout') timeouts++;
    },
    summarize() {
      const mean = games > 0 ? totalTurns / games : 0;
      return [
        { label: 'Avg game length (turns)', value: mean.toFixed(1) },
        { label: 'Turn range (min–max)', value: games > 0 ? `${minTurns}–${maxTurns}` : 'n/a' },
        { label: 'Timeout draws', value: String(timeouts) },
      ];
    },
  };
}

/** A registry pre-loaded with the built-in reporters (the §2 seam in action). */
export function createDefaultReporterRegistry(): ReporterRegistry {
  const registry = createReporterRegistry();
  registry.register(WIN_RATE_REPORTER_ID, createWinRateReporter);
  registry.register(TURN_STATS_REPORTER_ID, createTurnStatsReporter);
  return registry;
}

function pct(p: number): string {
  return `${(p * 100).toFixed(1)}%`;
}
