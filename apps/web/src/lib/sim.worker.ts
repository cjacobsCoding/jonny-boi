/// <reference lib="webworker" />
/**
 * The sim Web Worker (DESIGN §1.6 / the Lab brief): ALL simulation runs here so
 * the main thread stays responsive. The worker imports `@jonny-boi/sim` (which
 * pulls in the pure, DOM-free core/cards/ai) and drives it on demand.
 *
 * Protocol (see `sim-protocol.ts`): the UI posts ONE `SimRequest`; the worker
 * streams `progress` messages and finishes with a `result` or an `error`. There
 * is no in-worker cancellation flag — the UI cancels by TERMINATING the worker
 * (`worker.terminate()`), which is clean and immediate; the hook then spins up a
 * fresh worker for the next run.
 *
 * Progress without re-implementing sim logic: rather than calling the monolithic
 * `runGauntlet` / `suggestSwaps` (which would only report once, at the end), we
 * compose the SAME public sim primitives those functions use — `runMatchup` per
 * opponent, `evaluateSwap` per candidate, `generateCandidates` / `rankEvaluations`
 * — so we can post progress between units while reusing the exact, tested math
 * (DRY — no duplicated swap/stat logic; we orchestrate over the §2 seams).
 */
import {
  loadCardPool,
  buildRegistry,
} from '@jonny-boi/cards';
import type { CardPool } from '@jonny-boi/cards';
import {
  createDefaultAiRegistry,
  HEURISTIC_PILOT_ID,
} from '@jonny-boi/ai';
import type { Pilot } from '@jonny-boi/ai';
import type { EffectRegistry } from '@jonny-boi/core';
import {
  SAMPLE_DECKS,
  loadDeck,
  DeckLoadError,
  makeSeats,
  runMatchup,
  gameSeedFor,
  wilsonInterval,
  evaluateSwap,
  generateCandidates,
  rankEvaluations,
  DEFAULT_STATS_CONFIG,
  DEFAULT_SUGGEST_CONFIG,
  type Deck,
  type LoadedDeck,
  type MatchupPilots,
  type MatchupResult,
  type GauntletResult,
  type SwapEvaluation,
  type SuggestionReport,
  type RankedSwap,
  type SkippedCandidate,
} from '@jonny-boi/sim';
import type {
  SimRequest,
  SimResponse,
  SimDeckPayload,
} from './sim-protocol.js';

const ctx = self as unknown as DedicatedWorkerGlobalScope;

/** The shared sim context — pool + registry, built once per worker. */
interface Lab {
  readonly pool: CardPool;
  readonly registry: EffectRegistry;
  readonly pilots: MatchupPilots;
}

function makeLab(): Lab {
  // Silence pool validation warnings (stubbed mechanics are intentional, not noise).
  const pool = loadCardPool({ onWarn: () => {} });
  const registry = buildRegistry();
  const aiRegistry = createDefaultAiRegistry();
  const pilotA = aiRegistry.getPilot(HEURISTIC_PILOT_ID);
  const pilotB = aiRegistry.getPilot(HEURISTIC_PILOT_ID);
  if (!pilotA || !pilotB) throw new Error('could not instantiate the heuristic pilot');
  return { pool, registry, pilots: { pilotA: pilotA as Pilot, pilotB: pilotB as Pilot } };
}

function post(message: SimResponse): void {
  ctx.postMessage(message);
}

function nowSeconds(): number {
  return performance.now() / 1000;
}

/** Resolve the chosen sample-deck names into loaded gauntlet decks. */
function resolveOpponents(names: readonly string[], hero: SimDeckPayload, pool: CardPool): LoadedDeck[] {
  const chosen = names.length > 0 ? names : SAMPLE_DECKS.map((d) => d.name);
  const decks: LoadedDeck[] = [];
  for (const name of chosen) {
    const sample = SAMPLE_DECKS.find((d) => d.name === name);
    if (!sample) continue; // an unknown name is silently skipped — never crashes a run.
    if (sample.name === hero.name) continue; // don't pit the hero against itself.
    decks.push(loadDeck(sample, pool));
  }
  return decks;
}

/** The hero as a sim `Deck` (already in the right shape from the UI). */
function heroDeck(payload: SimDeckPayload): Deck {
  return { name: payload.name, archetype: payload.archetype, cards: [...payload.cards] };
}

// --- gauntlet ------------------------------------------------------------------

function runGauntletJob(req: Extract<SimRequest, { kind: 'gauntlet' }>, lab: Lab): void {
  const hero = loadDeck(heroDeck(req.hero), lab.pool);
  const opponents = resolveOpponents(req.opponentNames, req.hero, lab.pool);
  if (opponents.length === 0) throw new Error('no gauntlet opponents selected.');

  const matchups: MatchupResult[] = [];
  let totalGames = 0;
  let totalWins = 0;
  let totalDraws = 0;
  const start = nowSeconds();

  for (let i = 0; i < opponents.length; i++) {
    const opponent = opponents[i] as LoadedDeck;
    const seats = makeSeats(hero, opponent, lab.pilots, lab.registry);
    const matchupSeed = gameSeedFor(req.seed, i);
    const result = runMatchup(seats, req.gamesPerOpponent, matchupSeed);
    matchups.push(result);
    totalGames += result.games;
    totalWins += result.winsA;
    totalDraws += result.draws;
    post({
      type: 'progress',
      done: i + 1,
      total: opponents.length,
      gamesRun: totalGames,
      elapsedSeconds: nowSeconds() - start,
      label: `vs ${opponent.name}`,
    });
  }

  const elapsedSeconds = nowSeconds() - start;
  const result: GauntletResult = {
    hero: hero.name,
    matchups,
    totalGames,
    totalWins,
    totalDraws,
    overallWinRate: wilsonInterval(totalWins, totalGames, DEFAULT_STATS_CONFIG.z),
  };
  post({
    type: 'result',
    payload: {
      kind: 'gauntlet',
      result,
      gamesPerSecond: elapsedSeconds > 0 ? totalGames / elapsedSeconds : 0,
    },
  });
}

// --- A/B swap ------------------------------------------------------------------

function runSwapJob(req: Extract<SimRequest, { kind: 'swap' }>, lab: Lab): void {
  const opponents = resolveOpponents(req.opponentNames, req.hero, lab.pool);
  if (opponents.length === 0) throw new Error('no gauntlet opponents selected.');

  const start = nowSeconds();
  post({
    type: 'progress',
    done: 0,
    total: 1,
    gamesRun: 0,
    elapsedSeconds: 0,
    label: 'running paired A/B games…',
  });

  const evaluation: SwapEvaluation = evaluateSwap(
    heroDeck(req.hero),
    { out: req.outCardId, in: req.inCardId },
    opponents,
    lab.pilots,
    req.gamesPerOpponent,
    req.seed,
    lab.pool,
    lab.registry,
  );

  const elapsedSeconds = nowSeconds() - start;
  // Each paired game plays BOTH the base and the variant → twice nGames matches.
  const matchesPlayed = evaluation.nGames * 2;
  post({
    type: 'result',
    payload: {
      kind: 'swap',
      result: evaluation,
      gamesPerSecond: elapsedSeconds > 0 ? matchesPlayed / elapsedSeconds : 0,
    },
  });
}

// --- suggestions ---------------------------------------------------------------

const FIDELITY_CAVEAT =
  'Verdicts are PROVISIONAL (DESIGN §3.9): the MVP engine omits triggered abilities ' +
  '& until-end-of-turn expiry, so some cards play as a faithful vanilla subset. The ' +
  'statistics are exact; fidelity grows when engine v2 lands.';

/** A stable non-negative seed salt for a candidate (mirrors suggest.ts). */
function candidateSeedSalt(outId: string, inId: string): number {
  let h = 0x811c9dc5;
  const key = `${outId}>${inId}`;
  for (let i = 0; i < key.length; i++) {
    h = Math.imul(h ^ key.charCodeAt(i), 0x01000193) >>> 0;
  }
  return h;
}

function runSuggestJob(req: Extract<SimRequest, { kind: 'suggest' }>, lab: Lab): void {
  const base = heroDeck(req.hero);
  const opponents = resolveOpponents(req.opponentNames, req.hero, lab.pool);
  if (opponents.length === 0) throw new Error('no gauntlet opponents selected.');

  const suggestConfig = { ...DEFAULT_SUGGEST_CONFIG, maxCandidates: req.maxCandidates };
  const generated = generateCandidates(base, lab.pool, suggestConfig);
  const candidates = generated.candidates;
  const evaluated = candidates.slice(0, req.maxCandidates);
  const cappedByBudget = candidates.length > evaluated.length;
  const capped: SkippedCandidate[] = candidates.slice(req.maxCandidates).map((c) => ({
    outName: c.outName,
    inName: c.inName,
    reason: 'capped' as const,
    details: [],
  }));
  const illegalSkipped: SkippedCandidate[] = [...generated.skipped];

  const evaluations: SwapEvaluation[] = [];
  let totalGamesRun = 0;
  let baseGauntletWinRate: SwapEvaluation['baseWinRate'] | undefined;
  const start = nowSeconds();

  for (let i = 0; i < evaluated.length; i++) {
    const candidate = evaluated[i]!;
    const candidateSeed = gameSeedFor(req.seed, candidateSeedSalt(candidate.outId, candidate.inId));
    try {
      const evaluation = evaluateSwap(
        base,
        { out: candidate.outId, in: candidate.inId },
        opponents,
        lab.pilots,
        req.gamesPerCandidate,
        candidateSeed,
        lab.pool,
        lab.registry,
      );
      evaluations.push(evaluation);
      totalGamesRun += evaluation.nGames * 2;
      baseGauntletWinRate ??= evaluation.baseWinRate;
    } catch (err) {
      illegalSkipped.push({
        outName: candidate.outName,
        inName: candidate.inName,
        reason: 'illegal',
        details: [err instanceof Error ? err.message : String(err)],
      });
    }
    post({
      type: 'progress',
      done: i + 1,
      total: evaluated.length,
      gamesRun: totalGamesRun,
      elapsedSeconds: nowSeconds() - start,
      label: `${candidate.outName} → ${candidate.inName}`,
    });
  }

  const elapsedSeconds = nowSeconds() - start;
  const ranked = rankEvaluations(evaluations);
  const suggestions: RankedSwap[] = ranked.map((evaluation, i) => ({
    rank: i + 1,
    outName: evaluation.outName,
    inName: evaluation.inName,
    evaluation,
  }));

  const report: SuggestionReport = {
    baseDeck: base.name,
    baseGauntletWinRate: baseGauntletWinRate ?? { p: 0, low: 0, high: 0, successes: 0, n: 0 },
    candidatesEvaluated: evaluations.length,
    suggestions,
    skipped: [...illegalSkipped, ...capped],
    notes: {
      totalGamesRun,
      elapsedSeconds: elapsedSeconds > 0 ? elapsedSeconds : undefined,
      gamesPerSecond: elapsedSeconds > 0 ? totalGamesRun / elapsedSeconds : undefined,
      candidatesGenerated: candidates.length + illegalSkipped.length,
      cappedByBudget,
      fidelityCaveat: FIDELITY_CAVEAT,
    },
  };
  post({ type: 'result', payload: { kind: 'suggest', result: report } });
}

// --- dispatch ------------------------------------------------------------------

ctx.onmessage = (event: MessageEvent<SimRequest>): void => {
  const req = event.data;
  try {
    const lab = makeLab();
    switch (req.kind) {
      case 'gauntlet':
        runGauntletJob(req, lab);
        break;
      case 'swap':
        runSwapJob(req, lab);
        break;
      case 'suggest':
        runSuggestJob(req, lab);
        break;
      default:
        post({ type: 'error', message: `unknown request kind` });
    }
  } catch (err) {
    // A DeckLoadError carries readable reasons; anything else → a one-line message.
    const message =
      err instanceof DeckLoadError
        ? err.message
        : err instanceof Error
          ? err.message
          : String(err);
    post({ type: 'error', message });
  }
};
