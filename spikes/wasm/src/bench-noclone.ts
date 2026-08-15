/**
 * The end-to-end CEILING for fixing the clone — measured on the real engine, in
 * real games, not projected from percentages.
 *
 * Everything else in this spike is a component measurement. This one answers the
 * question the recommendation actually turns on: **if the per-action state copy
 * cost nothing at all, how much faster would the sim be?** That number bounds
 * every possible clone optimisation — flat arena, persistent structures, copy-on-
 * write, or a full WASM port — so it says what the whole category is worth before
 * anyone spends a week on any member of it.
 *
 * It is measurable without touching `packages/core` because the engine already
 * exports both entry points:
 *   - `applyAction`        clones the state, then mutates the draft  (what the sim uses)
 *   - `applyActionInPlace` mutates the caller's state directly       (what MCTS uses)
 * The match loop below owns its state exclusively — no replay, no trace, no shared
 * reference — which is exactly the contract `applyActionInPlace` documents, so
 * running it there is legitimate rather than a cheat.
 *
 * ## The honesty gate
 * The two loops must play the SAME GAMES. Every game's winner, turn count, action
 * count and final life totals are compared; a single divergence invalidates the
 * comparison, because then the fast loop is simply playing a different (perhaps
 * shorter) game. Determinism is the product here, so this check is not optional.
 */

import { performance, PerformanceObserver } from 'node:perf_hooks';
import { loadCardPool, buildRegistry } from '@jonny-boi/cards';
import { createDefaultAiRegistry } from '@jonny-boi/ai';
import type { Pilot } from '@jonny-boi/ai';
import { SAMPLE_DECKS, loadDeck, gameSeedFor } from '@jonny-boi/sim';
import type { LoadedDeck } from '@jonny-boi/sim';
import type { EffectRegistry, GameState, PlayerId } from '@jonny-boi/core';
import {
  applyAction,
  applyActionInPlace,
  createGame,
  createRng,
  DEFAULT_RULES,
  generateLegalActions,
} from '@jonny-boi/core';

const GAMES = 240;
const MAX_TURNS = 40;
const MAX_ACTIONS = 4000;
const SEED = 0xc0ffee;

/** The outcome fingerprint of one game — what must match between the two loops. */
interface GameOutcome {
  readonly winner: PlayerId | null;
  readonly turns: number;
  readonly actions: number;
  readonly lifeA: number;
  readonly lifeB: number;
}

type ApplyMode = 'clone' | 'in-place';

function playGame(
  mode: ApplyMode,
  deckA: LoadedDeck,
  deckB: LoadedDeck,
  pilot: Pilot,
  registry: EffectRegistry,
  seed: number,
): GameOutcome {
  const rngA = createRng((seed ^ 0x9e3779b9) >>> 0);
  const rngB = createRng((seed ^ 0x85ebca6b) >>> 0);
  let state: GameState = createGame({
    seed,
    startingPlayer: 'A',
    config: DEFAULT_RULES,
    registry,
    decks: { A: { cards: deckA.library }, B: { cards: deckB.library } },
  }).state;

  let actions = 0;
  while (!state.gameOver && state.turnNumber <= MAX_TURNS && actions < MAX_ACTIONS) {
    const legal = generateLegalActions(state, DEFAULT_RULES);
    if (legal.length === 0) break;
    const seat = state.priorityPlayer;
    const chosen = pilot.chooseAction({
      view: state,
      legalActions: legal,
      rng: seat === 'A' ? rngA : rngB,
      registry,
      rulesConfig: DEFAULT_RULES,
    });
    state =
      mode === 'clone'
        ? applyAction(state, chosen, DEFAULT_RULES, registry).state
        : applyActionInPlace(state, chosen, DEFAULT_RULES, registry).state;
    actions++;
  }
  return {
    winner: state.winner,
    turns: state.turnNumber,
    actions,
    lifeA: state.players.A.life,
    lifeB: state.players.B.life,
  };
}

let gcMillis = 0;
const gcObserver = new PerformanceObserver((list) => {
  for (const e of list.getEntries()) gcMillis += e.duration;
});
gcObserver.observe({ entryTypes: ['gc'] });
const drain = (): Promise<void> => new Promise((r) => setImmediate(r));

interface RunResult {
  readonly mode: ApplyMode;
  readonly wallMs: number;
  readonly gcMs: number;
  readonly gamesPerSecond: number;
  readonly outcomes: readonly GameOutcome[];
}

async function runAll(mode: ApplyMode, pilotId: string): Promise<RunResult> {
  const pool = loadCardPool();
  const registry = buildRegistry(pool);
  const pilot = createDefaultAiRegistry().getPilot(pilotId);
  if (!pilot) throw new Error(`no pilot "${pilotId}"`);
  const decks = SAMPLE_DECKS.map((d) => loadDeck(d, pool));

  // One untimed warm pass so neither mode is charged for JIT tiering-up.
  for (let g = 0; g < 8; g++) {
    playGame(mode, decks[g % decks.length] as LoadedDeck, decks[(g + 3) % decks.length] as LoadedDeck, pilot, registry, gameSeedFor(SEED, g));
  }
  await drain();
  gcMillis = 0;

  const outcomes: GameOutcome[] = [];
  const t0 = performance.now();
  for (let g = 0; g < GAMES; g++) {
    outcomes.push(
      playGame(
        mode,
        decks[g % decks.length] as LoadedDeck,
        decks[(g * 3 + 1) % decks.length] as LoadedDeck,
        pilot,
        registry,
        gameSeedFor(SEED, g),
      ),
    );
  }
  const wallMs = performance.now() - t0;
  await drain();
  return { mode, wallMs, gcMs: gcMillis, gamesPerSecond: (GAMES / wallMs) * 1000, outcomes };
}

function sameOutcomes(a: readonly GameOutcome[], b: readonly GameOutcome[]): number {
  let diffs = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] as GameOutcome;
    const y = b[i] as GameOutcome;
    if (x.winner !== y.winner || x.turns !== y.turns || x.actions !== y.actions || x.lifeA !== y.lifeA || x.lifeB !== y.lifeB) {
      diffs++;
    }
  }
  return diffs;
}

async function main(): Promise<void> {
  const pilotId = process.argv.includes('--pilot') ? (process.argv[process.argv.indexOf('--pilot') + 1] as string) : 'heuristic';

  // Alternate the order across repetitions so neither mode systematically benefits
  // from a warmer heap.
  const cloned = await runAll('clone', pilotId);
  const inPlace = await runAll('in-place', pilotId);
  const cloned2 = await runAll('clone', pilotId);

  const divergences = sameOutcomes(cloned.outcomes, inPlace.outcomes);
  const cloneMs = Math.min(cloned.wallMs, cloned2.wallMs);
  const speedup = cloneMs / inPlace.wallMs;
  const wins = inPlace.outcomes.filter((o) => o.winner === 'A').length;

  process.stdout.write(
    [
      `pilot: ${pilotId}   games: ${GAMES}   node ${process.version}`,
      '',
      `  applyAction      (clones every action)  ${cloneMs.toFixed(0).padStart(7)} ms   ` +
        `${((GAMES / cloneMs) * 1000).toFixed(1).padStart(6)} games/s   gc ${cloned.gcMs.toFixed(0).padStart(5)} ms`,
      `  applyActionInPlace (no clone at all)    ${inPlace.wallMs.toFixed(0).padStart(7)} ms   ` +
        `${inPlace.gamesPerSecond.toFixed(1).padStart(6)} games/s   gc ${inPlace.gcMs.toFixed(0).padStart(5)} ms`,
      '',
      `  CEILING for removing the per-action state copy: ${speedup.toFixed(2)}× sim throughput`,
      `  games diverging between the two loops: ${divergences}` +
        (divergences === 0 ? '  → identical games, the comparison is valid' : '  → DIVERGED, comparison invalid'),
      `  (seat A won ${wins}/${GAMES}, the determinism fingerprint of both runs)`,
      '',
    ].join('\n'),
  );
  if (divergences !== 0) process.exitCode = 1;
}

await main();
