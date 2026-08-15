/**
 * The representative sim workload the WASM spike is measured against.
 *
 * One seeded gauntlet of full AI-vs-AI games driven through the SAME public
 * entry points the product uses (`runGauntlet` → `runMatchup` → `runMatch` →
 * `generateLegalActions`/`applyAction`), so the profile reflects real product
 * cost and not a microbenchmark's idea of it.
 *
 * The pilot is a parameter because the two shipped pilots stress completely
 * different code:
 *   - `heuristic` — the throughput pilot. One `applyAction` per decision, so the
 *     profile is dominated by the ENGINE.
 *   - `mcts` — the look-ahead pilot. Hundreds of hypothetical plies per decision,
 *     so the profile is dominated by SEARCH (which is itself engine calls).
 * Both are profiled; a kernel that only helps one of them is not a win.
 *
 * Nothing here is imported by the product. This whole directory is a spike.
 */

import { performance } from 'node:perf_hooks';
import { loadCardPool, buildRegistry } from '@jonny-boi/cards';
import { createDefaultAiRegistry } from '@jonny-boi/ai';
import type { Pilot } from '@jonny-boi/ai';
import { SAMPLE_DECKS, loadDeck, runGauntlet } from '@jonny-boi/sim';

/** The hero deck the gauntlet is run for. Fixed so every run is comparable. */
export const HERO_DECK_NAME = 'Mono-Red Aggro';

/** The seed every workload run uses. Fixed: the whole lab rests on reproducibility. */
export const WORKLOAD_SEED = 0xc0ffee;

export interface WorkloadOptions {
  readonly pilotId: string;
  /** Games per matchup. */
  readonly games: number;
}

export interface WorkloadSummary {
  readonly pilotId: string;
  readonly gamesPerMatchup: number;
  readonly totalGames: number;
  readonly wallMs: number;
  readonly gamesPerSecond: number;
  /** Hero win-rate — the determinism fingerprint of the run. */
  readonly winRate: number;
  readonly totalWins: number;
  readonly totalDraws: number;
}

export function runWorkload(opts: WorkloadOptions): WorkloadSummary {
  const pool = loadCardPool();
  const registry = buildRegistry(pool);
  const ai = createDefaultAiRegistry();
  const pilot: Pilot | undefined = ai.getPilot(opts.pilotId);
  if (!pilot) throw new Error(`no pilot registered under id "${opts.pilotId}"`);

  const heroSource = SAMPLE_DECKS.find((d) => d.name === HERO_DECK_NAME);
  if (!heroSource) throw new Error(`hero deck ${HERO_DECK_NAME} not found`);
  const hero = loadDeck(heroSource, pool);
  const opponents = SAMPLE_DECKS.filter((d) => d.name !== HERO_DECK_NAME).map((d) => loadDeck(d, pool));

  const start = performance.now();
  const result = runGauntlet(
    hero,
    opponents,
    { pilotA: pilot, pilotB: pilot },
    opts.games,
    WORKLOAD_SEED,
    registry,
  );
  const wallMs = performance.now() - start;

  return {
    pilotId: opts.pilotId,
    gamesPerMatchup: opts.games,
    totalGames: result.totalGames,
    wallMs,
    gamesPerSecond: (result.totalGames / wallMs) * 1000,
    winRate: result.overallWinRate.p,
    totalWins: result.totalWins,
    totalDraws: result.totalDraws,
  };
}
