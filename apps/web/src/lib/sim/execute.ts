/**
 * **Executing one shard** — the only code that actually plays games in the Lab.
 *
 * This module is deliberately pure and DOM-free: it takes a `ShardJob` plus a
 * built sim context and returns a `ShardResult`. That makes it runnable in a Web
 * Worker (its real home), in Node under Vitest (where the determinism tests live),
 * and in the CLI if it ever wants the same slicing — one implementation, three
 * hosts.
 *
 * ## Why it drops to `runMatch` instead of calling `runMatchup` / `evaluateSwap`
 *
 * A shard is *part* of a matchup, and neither `runMatchup` nor `evaluateSwap`
 * takes a game range — they always run games `0..n-1`. To let a single-opponent
 * gauntlet use all twelve cores we have to be able to say "play games 40–59 of
 * this matchup", so the loop lives here.
 *
 * That is a seam, not a fork of the sim: the seeds come from the sim's exported
 * `gameSeedFor`, the on-the-play alternation from its exported `onPlayFor`, the
 * seats from `makeSeats`, the games from `runMatch`, and every statistic is
 * computed later by the sim's own `wilsonInterval` / `mcNemarTest` /
 * `decideVerdict`. Nothing is re-derived. And because "part of a matchup" is only
 * trustworthy if the parts reassemble into exactly the whole, `determinism.test.ts`
 * asserts a sharded gauntlet equals `runGauntlet` and a sharded paired run equals
 * `evaluateSwap`, field for field. If the sim's loop ever changes, that test fails
 * loudly instead of the Lab quietly reporting different numbers than the CLI.
 */
import { buildRegistry, loadCardPool } from '@jonny-boi/cards';
import type { CardPool } from '@jonny-boi/cards';
import { createDefaultAiRegistry, DEFAULT_PILOT_ID } from '@jonny-boi/ai';
import type { Pilot } from '@jonny-boi/ai';
import type { CardDefinition, EffectRegistry } from '@jonny-boi/core';
import {
  DEFAULT_SUGGEST_CONFIG,
  DEFAULT_SWAP_SCOPE,
  SAMPLE_DECKS,
  applySwap,
  gameSeedFor,
  generateCandidates,
  loadDeck,
  makeSeats,
  onPlayFor,
  runMatch,
  type Deck,
  type LoadedDeck,
  type MatchupPilots,
  type SwapScope,
} from '@jonny-boi/sim';
import type { SimDeckPayload } from '../sim-protocol.js';
import { candidateSeedSalt } from './plan.js';
import type {
  GauntletShardJob,
  GauntletShardResult,
  MatchJob,
  MatchJobResult,
  PairedShardJob,
  PairedShardResult,
  PlannedCandidate,
  ShardContext,
  ShardJob,
  ShardResult,
  SkippedCandidateInfo,
  SuggestPlanJob,
  SuggestPlanResult,
} from './shard-protocol.js';
import { buildMatchTrace } from '../replay-build.js';
import { MAX_REPLAY_FRAMES } from '../replay-config.js';
import type { ReplaySeat } from '../replay-types.js';

/**
 * The per-worker sim context: the card pool, the effect registry and the pilots.
 *
 * Building this is the expensive part of starting a run (indexing the whole card
 * pool), so a worker builds it ONCE and reuses it for every shard it is handed —
 * which is the main reason the pool keeps long-lived workers instead of spawning
 * one per job.
 */
export interface SimContext {
  readonly pool: CardPool;
  readonly registry: EffectRegistry;
  readonly pilots: MatchupPilots;
  /** Loaded gauntlet decks, memoised by name (loading is pure but not free). */
  readonly deckCache: Map<string, LoadedDeck>;
}

/**
 * Build a sim context. `importedCards` are the compiled definitions a user's
 * imported decks depend on; they join the curated pool through the same
 * `extraCards` seam the main thread uses, so a deck loads identically here.
 */
export function createSimContext(importedCards: readonly CardDefinition[] = []): SimContext {
  // Pool validation warnings are silenced: stubbed mechanics are intentional,
  // documented in UNSUPPORTED-MECHANICS.md, and not news at every worker start.
  const pool = loadCardPool({ onWarn: () => {}, extraCards: importedCards });
  const registry = buildRegistry();
  const aiRegistry = createDefaultAiRegistry();
  const pilotA = aiRegistry.getPilot(DEFAULT_PILOT_ID);
  const pilotB = aiRegistry.getPilot(DEFAULT_PILOT_ID);
  if (!pilotA || !pilotB) {
    throw new Error(`could not instantiate the "${DEFAULT_PILOT_ID}" pilot`);
  }
  return {
    pool,
    registry,
    pilots: { pilotA: pilotA as Pilot, pilotB: pilotB as Pilot },
    deckCache: new Map(),
  };
}

/** The hero payload as the sim's `Deck` shape. */
export function heroDeck(payload: SimDeckPayload): Deck {
  return { name: payload.name, archetype: payload.archetype, cards: [...payload.cards] };
}

/** Load (and memoise) one gauntlet opponent by its sample-deck name. */
function opponentDeck(context: SimContext, name: string): LoadedDeck {
  const cached = context.deckCache.get(name);
  if (cached) return cached;
  const sample = SAMPLE_DECKS.find((d) => d.name === name);
  if (!sample) throw new Error(`unknown gauntlet deck: "${name}"`);
  const loaded = loadDeck(sample, context.pool);
  context.deckCache.set(name, loaded);
  return loaded;
}

/** The opponent a shard names, by its index into the run's canonical list. */
function opponentAt(context: SimContext, shardContext: ShardContext, index: number): LoadedDeck {
  const name = shardContext.opponentNames[index];
  if (name === undefined) throw new Error(`gauntlet opponent index ${index} is out of range`);
  return opponentDeck(context, name);
}

/** A per-game callback so a long shard can report progress while it runs. */
export type OnGamePlayed = (games: number) => void;

// --- gauntlet shard ------------------------------------------------------------

/**
 * Play games `[gameStart, gameEnd)` of the hero-vs-opponent[i] matchup.
 *
 * The seed for game `g` is `gameSeedFor(gameSeedFor(runSeed, i), g)` and the
 * player on the play is `onPlayFor(g)` — both functions of the game's INDEX in
 * the full matchup, never of its position within this shard. That is the whole
 * trick: a shard covering games 40–59 plays byte-identical games to games 40–59
 * of the single-threaded run.
 */
export function runGauntletShard(
  job: GauntletShardJob,
  context: SimContext,
  onGame?: OnGamePlayed,
): GauntletShardResult {
  const hero = loadDeck(heroDeck(job.context.hero), context.pool);
  const opponent = opponentAt(context, job.context, job.opponentIndex);
  const seats = makeSeats(hero, opponent, context.pilots, context.registry);
  const matchupSeed = gameSeedFor(job.context.seed, job.opponentIndex);

  let winsA = 0;
  let winsB = 0;
  let draws = 0;
  const gameSeeds: number[] = [];

  for (let g = job.gameStart; g < job.gameEnd; g++) {
    const seed = gameSeedFor(matchupSeed, g);
    gameSeeds.push(seed);
    const result = runMatch(seats, seed, { startingPlayer: onPlayFor(g) });
    if (result.outcome.kind === 'win') {
      if (result.outcome.winner === 'A') winsA++;
      else winsB++;
    } else {
      draws++;
    }
    onGame?.(1);
  }

  return {
    kind: 'gauntlet-shard',
    opponentIndex: job.opponentIndex,
    gameStart: job.gameStart,
    gameEnd: job.gameEnd,
    heroName: hero.name,
    opponentName: opponent.name,
    games: job.gameEnd - job.gameStart,
    winsA,
    winsB,
    draws,
    gameSeeds,
  };
}

// --- paired (A/B) shard --------------------------------------------------------

/**
 * Play paired games `[gameStart, gameEnd)` of base-vs-variant against opponent[i].
 *
 * **Common random numbers survive sharding** because the pair is the unit: one
 * game index produces ONE seed and ONE on-the-play assignment, and both the base
 * deck and the variant deck are played under them, back to back, inside the same
 * shard. A split that put base and variant on different workers would still be
 * unbiased but would throw away the variance reduction that lets a single-card
 * swap be called in hundreds of games rather than tens of thousands — so no plan
 * is ever allowed to separate them, and the pair count is the shard's unit.
 */
export function runPairedShard(
  job: PairedShardJob,
  context: SimContext,
  onGame?: OnGamePlayed,
): PairedShardResult {
  const base = heroDeck(job.context.hero);
  // `applySwap` resolves out/in by id or name and rewrites the cut card(s) IN
  // PLACE, which is what keeps the two shuffled libraries differing only at the
  // swapped slots. Reusing it (and `loadDeck`) means the variant this shard plays
  // is the same deck `evaluateSwap` would have built — including the SCOPE, which
  // decides whether one copy or the whole playset moved. Defaulting it here rather
  // than letting each call site guess is what stops a Lab run quietly answering a
  // different question than the user asked.
  const scope: SwapScope = job.swapScope ?? DEFAULT_SWAP_SCOPE;
  const variant = applySwap(base, { out: job.outCardId, in: job.inCardId }, context.pool, scope);
  const baseLoaded = loadDeck(base, context.pool);
  const variantLoaded = loadDeck(variant, context.pool);
  const opponent = opponentAt(context, job.context, job.opponentIndex);

  const baseSeats = makeSeats(baseLoaded, opponent, context.pilots, context.registry);
  const variantSeats = makeSeats(variantLoaded, opponent, context.pilots, context.registry);
  const matchupSeed = gameSeedFor(job.swapSeed, job.opponentIndex);

  let baseWins = 0;
  let variantWins = 0;
  let bothWon = 0;
  let baseOnly = 0;
  let variantOnly = 0;
  let neither = 0;
  let n = 0;

  for (let g = job.gameStart; g < job.gameEnd; g++) {
    const seed = gameSeedFor(matchupSeed, g);
    const matchOpts = { startingPlayer: onPlayFor(g) };

    const baseResult = runMatch(baseSeats, seed, matchOpts);
    const variantResult = runMatch(variantSeats, seed, matchOpts);

    const baseWon = baseResult.outcome.kind === 'win' && baseResult.outcome.winner === 'A';
    const variantWon = variantResult.outcome.kind === 'win' && variantResult.outcome.winner === 'A';

    if (baseWon) baseWins++;
    if (variantWon) variantWins++;
    if (baseWon && variantWon) bothWon++;
    else if (baseWon) baseOnly++;
    else if (variantWon) variantOnly++;
    else neither++;
    n++;
    // Two games actually played per pair — report them honestly.
    onGame?.(2);
  }

  const outDef = context.pool.get(job.outCardId) ?? context.pool.getByName(job.outCardId);
  const inDef = context.pool.get(job.inCardId) ?? context.pool.getByName(job.inCardId);

  // How many copies actually moved — read off the base decklist exactly as
  // `evaluateSwap` reads it, so a merged verdict reports the same number the
  // single-threaded one would.
  const outCount = outDef
    ? (base.cards.find((entry) => {
        const resolved = context.pool.get(entry.cardId) ?? context.pool.getByName(entry.cardId);
        return resolved?.id === outDef.id;
      })?.count ?? 1)
    : 1;

  return {
    kind: 'paired-shard',
    opponentIndex: job.opponentIndex,
    gameStart: job.gameStart,
    gameEnd: job.gameEnd,
    candidateIndex: job.candidateIndex,
    baseDeckName: base.name,
    variantDeckName: variant.name,
    outName: outDef?.name ?? job.outCardId,
    inName: inDef?.name ?? job.inCardId,
    outCardId: job.outCardId,
    inCardId: job.inCardId,
    scope,
    copiesSwapped: scope === 'playset' ? outCount : 1,
    n,
    baseWins,
    variantWins,
    bothWon,
    baseOnly,
    variantOnly,
    neither,
  };
}

// --- suggestions: the planning phase ------------------------------------------

/**
 * Enumerate and pre-rank the candidate swaps for a suggestions run.
 *
 * This is the sim's own `generateCandidates` (colour/curve heuristic, legality via
 * `validateDeck`) — we only trim to the budget and stamp each survivor with its
 * per-candidate seed, exactly as `suggestSwaps` does, so a candidate is evaluated
 * on the same seed here as on the CLI.
 */
export function runSuggestPlan(job: SuggestPlanJob, context: SimContext): SuggestPlanResult {
  const base = heroDeck(job.context.hero);
  const suggestConfig = { ...DEFAULT_SUGGEST_CONFIG, maxCandidates: job.maxCandidates };
  const generated = generateCandidates(base, context.pool, suggestConfig);

  const kept = generated.candidates.slice(0, job.maxCandidates);
  const overflow = generated.candidates.slice(job.maxCandidates);
  const candidates: PlannedCandidate[] = kept.map((candidate) => ({
    outId: candidate.outId,
    inId: candidate.inId,
    outName: candidate.outName,
    inName: candidate.inName,
    swapSeed: gameSeedFor(job.context.seed, candidateSeedSalt(candidate.outId, candidate.inId)),
  }));

  const skipped: SkippedCandidateInfo[] = [
    ...generated.skipped.map((s) => ({
      outName: s.outName,
      inName: s.inName,
      reason: s.reason,
      details: [...s.details],
    })),
    ...overflow.map((c) => ({
      outName: c.outName,
      inName: c.inName,
      reason: 'capped' as const,
      details: [] as readonly string[],
    })),
  ];

  return {
    kind: 'suggest-plan',
    baseDeckName: base.name,
    candidates,
    skipped,
    // Snapshot BEFORE evaluation can append further skips, so coverage is honest.
    candidatesGenerated: generated.candidates.length + generated.skipped.length,
    cappedByBudget: overflow.length > 0,
  };
}

// --- single-game replay trace --------------------------------------------------

/** Play ONE game and record its trace for the replay viewer. Never sharded. */
export function runMatchJob(job: MatchJob, context: SimContext): MatchJobResult {
  const hero = loadDeck(heroDeck(job.context.hero), context.pool);
  if (job.opponentName === job.context.hero.name) {
    throw new Error('a deck cannot play itself — pick a different opponent.');
  }
  const opponent = opponentDeck(context, job.opponentName);

  const seatNames: Record<'A' | 'B', ReplaySeat> = {
    A: { player: 'A', deckName: hero.name, pilot: DEFAULT_PILOT_ID },
    B: { player: 'B', deckName: opponent.name, pilot: DEFAULT_PILOT_ID },
  };
  // The frame count tracks the event count; cap events generously and frames a bit
  // lower so a runaway game still yields a usable, bounded trace.
  const EVENTS_PER_FRAME_HEADROOM = 8;
  const maxEvents = Math.max(
    1,
    Math.min(job.maxEvents, MAX_REPLAY_FRAMES * EVENTS_PER_FRAME_HEADROOM),
  );

  const trace = buildMatchTrace(
    {
      deckA: hero,
      deckB: opponent,
      pilotA: context.pilots.pilotA,
      pilotB: context.pilots.pilotB,
      registry: context.registry,
      seatNames,
    },
    job.context.seed,
    maxEvents,
  );
  return { kind: 'match', trace };
}

// --- dispatch ------------------------------------------------------------------

/** Run any shard. The single entry point both the worker and the tests call. */
export function executeShard(
  job: ShardJob,
  context: SimContext,
  onGame?: OnGamePlayed,
): ShardResult {
  switch (job.kind) {
    case 'gauntlet-shard':
      return runGauntletShard(job, context, onGame);
    case 'paired-shard':
      return runPairedShard(job, context, onGame);
    case 'suggest-plan':
      return runSuggestPlan(job, context);
    case 'match':
      return runMatchJob(job, context);
  }
}
