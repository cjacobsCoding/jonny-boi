/**
 * **Executing one shard** — the only code that actually plays games in the Lab.
 *
 * This module is deliberately pure and DOM-free: it takes a `ShardJob` plus a
 * built sim context and returns a `ShardResult`. That makes it runnable in a Web
 * Worker (its real home), in Node under Vitest (where the determinism tests live),
 * and in the CLI if it ever wants the same slicing — one implementation, three
 * hosts.
 *
 * ## It calls the sim; it never restates it
 *
 * A shard is *part* of a run, and the sim now takes a `RunRange` saying which
 * part: `runMatchup` and `evaluateSwap` play games `[gameStart, gameEnd)` of
 * opponents `[opponentStart, opponentEnd)` and derive every seed from a game's
 * ABSOLUTE indices, exactly as the whole run does. So a gauntlet shard IS
 * `runMatchup`, and a paired shard IS `evaluateSwap` — this file used to carry
 * hand-rolled copies of both loops, and those copies are gone.
 *
 * The suggestions shards work the same way one level up. The adaptive search is
 * stateful across candidates (who survives round N+1 depends on round N), so it
 * cannot be flattened into a queue of independent games. Instead the sim exposes
 * the search as a driveable generator and a resumable arm runner, and the shards
 * here are its two parallelisable pieces: play the SHARED base games for a slot
 * range, and play ONE candidate's variant games over a slot range. Which arms get
 * dispatched, and which survive, is decided by the sim in `run.ts` — never here.
 *
 * `determinism.test.ts` pins the whole arrangement against the sim's own
 * single-threaded functions, field for field. If the sim's loop ever changes, that
 * test fails loudly instead of the Lab quietly reporting different numbers than
 * the CLI.
 */
import { buildRegistry, loadCardPool } from '@jonny-boi/cards';
import type { CardPool } from '@jonny-boi/cards';
import { createDefaultAiRegistry, SELECTABLE_PILOT_IDS } from '@jonny-boi/ai';
import type { AiRegistry, Pilot } from '@jonny-boi/ai';
import type { CardDefinition, EffectRegistry } from '@jonny-boi/core';
import {
  DEFAULT_SUGGEST_CONFIG,
  DEFAULT_SWAP_SCOPE,
  SAMPLE_DECKS,
  createPairedArmRunner,
  evaluateSwap,
  gameSeedFor,
  loadDeck,
  makeSeats,
  prepareSuggestionRun,
  runMatchup,
  type Deck,
  type LoadedDeck,
  type MatchupPilots,
  type PairedArmRunner,
  type PairedBaseRecord,
  type SwapScope,
} from '@jonny-boi/sim';
import {
  applyManabase,
  createReliabilityWatch,
  planManabaseRun,
  type PairedGameWatch,
} from '@jonny-boi/sim';
import type { SimDeckPayload } from '../sim-protocol.js';
import type {
  BaseSlotShardJob,
  BaseSlotShardResult,
  GauntletShardJob,
  GauntletShardResult,
  ManabaseBaseSlotShardJob,
  ManabaseBaseSlotShardResult,
  ManabasePlanJob,
  ManabasePlanResult,
  ManabaseVariantSliceShardJob,
  ManabaseVariantSliceShardResult,
  MatchJob,
  MatchJobResult,
  PairedShardJob,
  PairedShardResult,
  ShardContext,
  ShardJob,
  ShardResult,
  SuggestPlanJob,
  SuggestPlanResult,
  VariantSliceShardJob,
  VariantSliceShardResult,
} from './shard-protocol.js';
import { buildMatchTrace } from '../replay-build.js';
import { MAX_REPLAY_FRAMES } from '../replay-config.js';
import type { ReplaySeat } from '../replay-types.js';

/**
 * The per-worker sim context: the card pool, the effect registry, and the pilot
 * registry a job's `pilotId` is resolved against.
 *
 * Building this is the expensive part of starting a run (indexing the whole card
 * pool), so a worker builds it ONCE and reuses it for every shard it is handed —
 * which is the main reason the pool keeps long-lived workers instead of spawning
 * one per job.
 */
export interface SimContext {
  readonly pool: CardPool;
  readonly registry: EffectRegistry;
  /** The pilot registry this worker resolves a job's `pilotId` against. */
  readonly aiRegistry: AiRegistry;
  /**
   * Instantiated seat pairs, memoised by pilot id.
   *
   * A worker serves whatever run the pool hands it, and a run names its pilot, so
   * the pilots cannot be built once at construction time any more. They are still
   * built once PER PILOT and reused, which is what the cache is for — a search
   * pilot allocates its evaluator and weights up front.
   */
  readonly pilotCache: Map<string, MatchupPilots>;
  /** Loaded gauntlet decks, memoised by name (loading is pure but not free). */
  readonly deckCache: Map<string, LoadedDeck>;
  /**
   * The paired-arm runner for the suggestions run this worker is currently
   * serving, kept between shards. A suggestions run hands one worker dozens of
   * slices of the same run, and rebuilding the runner per slice would re-load the
   * base deck, re-verify the instance-id mapping, and throw away every seat it
   * had built. Keyed so a NEW run (different deck, opponents or seed) never
   * inherits the previous run's base games.
   */
  runnerCache: { key: string; runner: SuggestionRunner } | null;
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
  return {
    pool,
    registry: buildRegistry(),
    aiRegistry: createDefaultAiRegistry(),
    pilotCache: new Map(),
    deckCache: new Map(),
    runnerCache: null,
  };
}

/**
 * The two seats for one pilot id, built once per worker per pilot.
 *
 * BOTH seats get the same pilot on purpose. A gauntlet win rate is only meaningful
 * as "this deck against that deck, at this level of play"; pitting a strong pilot
 * against a weak one would measure the pilots, not the decks. (Two seats, not one
 * shared instance, because a pilot may carry per-seat state — the hybrid search
 * keeps a committed macro-plan between decisions.)
 *
 * An unknown id fails LOUDLY rather than falling back to the default: a run that
 * quietly substituted a different pilot would report numbers labelled with a pilot
 * that never played, which is the exact failure this whole change exists to stop.
 */
export function pilotsFor(context: SimContext, pilotId: string): MatchupPilots {
  const cached = context.pilotCache.get(pilotId);
  if (cached) return cached;
  const pilotA = context.aiRegistry.getPilot(pilotId);
  const pilotB = context.aiRegistry.getPilot(pilotId);
  if (!pilotA || !pilotB) {
    throw new Error(
      `unknown AI pilot "${pilotId}" — expected one of: ${SELECTABLE_PILOT_IDS.join(', ')}`,
    );
  }
  const pilots: MatchupPilots = { pilotA: pilotA as Pilot, pilotB: pilotB as Pilot };
  context.pilotCache.set(pilotId, pilots);
  return pilots;
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

/** Every gauntlet opponent of a run, in the run's canonical order. */
function allOpponents(context: SimContext, shardContext: ShardContext): LoadedDeck[] {
  return shardContext.opponentNames.map((_, index) => opponentAt(context, shardContext, index));
}

/** A per-game callback so a long shard can report progress while it runs. */
export type OnGamePlayed = (games: number) => void;

// --- gauntlet shard ------------------------------------------------------------

/**
 * Play games `[gameStart, gameEnd)` of the hero-vs-opponent[i] matchup.
 *
 * This is the sim's `runMatchup`, restricted to a game range. The seed for game
 * `g` is `gameSeedFor(gameSeedFor(runSeed, i), g)` and the player on the play is
 * `onPlayFor(g)` — both functions of the game's INDEX in the full matchup, never
 * of its position within this shard. That is the whole trick: a shard covering
 * games 40–59 plays byte-identical games to games 40–59 of the single-threaded
 * run.
 */
export function runGauntletShard(
  job: GauntletShardJob,
  context: SimContext,
  onGame?: OnGamePlayed,
): GauntletShardResult {
  const hero = loadDeck(heroDeck(job.context.hero), context.pool);
  const opponent = opponentAt(context, job.context, job.opponentIndex);
  const seats = makeSeats(
    hero,
    opponent,
    pilotsFor(context, job.context.pilotId),
    context.registry,
  );
  const matchupSeed = gameSeedFor(job.context.seed, job.opponentIndex);

  const slice = runMatchup(seats, job.gameEnd, matchupSeed, {
    range: { gameStart: job.gameStart, gameEnd: job.gameEnd },
    onGame: () => onGame?.(1),
  });

  return {
    kind: 'gauntlet-shard',
    opponentIndex: job.opponentIndex,
    gameStart: job.gameStart,
    gameEnd: job.gameEnd,
    heroName: slice.deckA,
    opponentName: slice.deckB,
    games: slice.games,
    winsA: slice.winsA,
    winsB: slice.winsB,
    draws: slice.draws,
    gameSeeds: slice.gameSeeds,
  };
}

// --- paired (A/B) shard --------------------------------------------------------

/**
 * Play paired games `[gameStart, gameEnd)` of base-vs-variant against opponent[i].
 *
 * This is the sim's `evaluateSwap`, restricted to one opponent and a game range —
 * including the swap SCOPE, which decides whether one copy or the whole playset
 * moved, so a Lab run can never quietly answer a different question than the user
 * asked.
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
  const scope: SwapScope = job.swapScope ?? DEFAULT_SWAP_SCOPE;

  const evaluation = evaluateSwap(
    base,
    { out: job.outCardId, in: job.inCardId },
    allOpponents(context, job.context),
    pilotsFor(context, job.context.pilotId),
    job.gameEnd,
    job.swapSeed,
    context.pool,
    context.registry,
    {
      swapScope: scope,
      range: {
        opponentStart: job.opponentIndex,
        opponentEnd: job.opponentIndex + 1,
        gameStart: job.gameStart,
        gameEnd: job.gameEnd,
      },
      ...(onGame ? { onGame } : {}),
    },
  );

  return {
    kind: 'paired-shard',
    opponentIndex: job.opponentIndex,
    gameStart: job.gameStart,
    gameEnd: job.gameEnd,
    candidateIndex: job.candidateIndex,
    baseDeckName: evaluation.baseDeck,
    variantDeckName: evaluation.variantDeck,
    outName: evaluation.outName,
    inName: evaluation.inName,
    outCardId: job.outCardId,
    inCardId: job.inCardId,
    scope: evaluation.scope,
    copiesSwapped: evaluation.copiesSwapped,
    n: evaluation.nGames,
    // The paired table's margins ARE the two arms' win counts, so nothing extra
    // has to be counted alongside it (see `summarizePairedSwap`).
    baseWins: evaluation.paired.bothWon + evaluation.paired.baseOnly,
    variantWins: evaluation.paired.bothWon + evaluation.paired.variantOnly,
    bothWon: evaluation.paired.bothWon,
    baseOnly: evaluation.paired.baseOnly,
    variantOnly: evaluation.paired.variantOnly,
    neither: evaluation.paired.neither,
  };
}

// --- suggestions: the planning phase ------------------------------------------

/**
 * Enumerate + pre-rank candidates, accept the caller's cross-run record, and plan
 * the wave ladder — the sim's own `prepareSuggestionRun`, verbatim.
 *
 * We also settle the identical-game-skip question here, once, rather than letting
 * each shard answer it and hoping they agree.
 */
export function runSuggestPlan(job: SuggestPlanJob, context: SimContext): SuggestPlanResult {
  const base = heroDeck(job.context.hero);
  const plan = prepareSuggestionRun(base, {
    pool: context.pool,
    opponentCount: job.context.opponentNames.length,
    baseSeed: job.context.seed,
    gamesPerCandidate: job.gamesPerCandidate,
    suggestConfig: { ...DEFAULT_SUGGEST_CONFIG, maxCandidates: job.maxCandidates },
    ...(job.history ? { history: job.history } : {}),
    // §3.136 — the focus the caller asked for. `swapScope` MUST match what the
    // arms will actually build, or every candidate's recorded copy count would
    // describe a different experiment than the one that gets played; it rides
    // the shared context for precisely that reason.
    ...(job.cutOnly ? { cutOnly: job.cutOnly } : {}),
    ...(job.context.swapScope ? { swapScope: job.context.swapScope } : {}),
  });

  const skip = suggestionRunner(context, job.context, plan.runSeed).runner.identicalGameSkip;
  return {
    kind: 'suggest-plan',
    plan,
    identicalGameSkipEnabled: skip.enabled,
    ...(skip.reason ? { identicalGameSkipDisabledReason: skip.reason } : {}),
  };
}

// --- suggestions: the base arm and the variant arms ----------------------------

/**
 * A paired-arm runner plus the two mutable bits a long-lived, shard-served runner
 * needs: a store of base records other workers played, and the progress callback
 * of whichever shard is using it right now.
 */
export interface SuggestionRunner {
  readonly runner: PairedArmRunner;
  /** Hand in a base game somebody else played, so this worker need not replay it. */
  readonly supply: (slot: number, record: PairedBaseRecord) => void;
  /** The current shard's progress tick; re-pointed per shard, cleared after. */
  tick: OnGamePlayed | undefined;
}

/**
 * The paired-arm runner for one suggestions run, cached on the worker.
 *
 * `baseRecords` is wired to a per-runner store the shards fill in: a variant
 * slice hands its job's base records in, the runner reads them instead of
 * replaying those games, and the identical-game skip keeps working. A slot the
 * store cannot answer is played locally and counted honestly — which never
 * happens under the schedule in `run.ts`, and would show up as a base-game count
 * that disagrees with the headless engine if it ever did.
 *
 * Caching matters: one worker is handed dozens of slices of the same run, and
 * rebuilding the runner per slice would re-load the base deck, re-verify the
 * instance-id mapping and discard every seat it had built. The key covers
 * everything that could change the games, so a run with a different deck,
 * gauntlet or seed never inherits an older run's base records.
 *
 * It cannot outlive a run in the app either: `useSimWorker` disposes the pool
 * when a run ends, so the next run gets new workers and an empty cache. That
 * matters for honesty as much as for correctness — a second identical run served
 * from a warm cache would report a throughput no fresh run could reproduce.
 */
/**
 * A per-game watch a runner is built with, NAMED so it can be part of the
 * runner-cache key: two shards of one run must agree on whether their games
 * were watched, or a base record without a reading would be handed to a variant
 * slice that expects one. `undefined` (every run before §3.175) watches nothing.
 */
export interface NamedGameWatch {
  readonly id: string;
  readonly create: () => PairedGameWatch;
}

/** §3.175 — the reliability watch every manabase shard plays under. */
export const RELIABILITY_WATCH: NamedGameWatch = {
  id: 'reliability',
  create: () => createReliabilityWatch(),
};

function suggestionRunner(
  context: SimContext,
  shardContext: ShardContext,
  runSeed: number,
  watch?: NamedGameWatch,
): SuggestionRunner {
  // The pilot is part of the key: base games played by one pilot are not the base
  // games of a run piloted by another, and adopting them would silently compare a
  // variant arm against the wrong control.
  // §3.136 — the SCOPE is part of the key too. Base games are shared across a
  // run's candidates, but a runner built at one scope constructs different
  // variants than one built at another, so reusing it across scopes would
  // compare arms from two different experiments.
  // §3.175 — and the WATCH: a runner built without one records no readings.
  const key = JSON.stringify([
    shardContext.hero,
    shardContext.opponentNames,
    runSeed,
    shardContext.pilotId,
    shardContext.swapScope ?? null,
    watch?.id ?? null,
  ]);
  const cached = context.runnerCache;
  if (cached?.key === key) return cached.runner;

  const supplied = new Map<number, PairedBaseRecord>();
  const holder: { tick: OnGamePlayed | undefined } = { tick: undefined };
  const runner = createPairedArmRunner(heroDeck(shardContext.hero), {
    gauntletDecks: allOpponents(context, shardContext),
    pilots: pilotsFor(context, shardContext.pilotId),
    pool: context.pool,
    registry: context.registry,
    seed: runSeed,
    baseRecords: (slot) => supplied.get(slot),
    onGame: (games) => holder.tick?.(games),
    // §3.136 — build variants at the scope the plan was made with.
    ...(shardContext.swapScope ? { runOptions: { swapScope: shardContext.swapScope } } : {}),
    ...(watch ? { watchGames: watch.create } : {}),
  });
  const entry: SuggestionRunner = {
    runner,
    supply: (slot, record) => {
      supplied.set(slot, record);
    },
    get tick(): OnGamePlayed | undefined {
      return holder.tick;
    },
    set tick(value: OnGamePlayed | undefined) {
      holder.tick = value;
    },
  };
  context.runnerCache = { key, runner: entry };
  return entry;
}

/**
 * Play the SHARED base games for slots `[slotStart, slotEnd)`.
 *
 * One base game per slot for the whole run — not per candidate — is the single
 * biggest saving the adaptive engine made, and it survives here because the
 * records travel back to the main thread and are handed to whichever workers play
 * the variant arms over those slots.
 */
export function runBaseSlotShard(
  job: BaseSlotShardJob,
  context: SimContext,
  onGame?: OnGamePlayed,
): BaseSlotShardResult {
  const entry = suggestionRunner(context, job.context, job.runSeed);
  entry.tick = onGame;
  try {
    const records: PairedBaseRecord[] = [];
    for (let slot = job.slotStart; slot < job.slotEnd; slot++) {
      records.push(entry.runner.baseRecordAt(slot));
    }
    return { kind: 'base-slot-shard', slotStart: job.slotStart, slotEnd: job.slotEnd, records };
  } finally {
    entry.tick = undefined;
  }
}

/**
 * Play ONE candidate's variant games over slots `[slotStart, slotEnd)`, against
 * the base records the main thread collected in this round's base phase.
 *
 * Returns this slice's 2×2 table alone. The main thread sums a candidate's slices
 * into its cumulative table, and integer addition is exact and commutative — so
 * the arm's numbers cannot depend on how the slots were split or on which slice
 * came home first.
 */
export function runVariantSliceShard(
  job: VariantSliceShardJob,
  context: SimContext,
  onGame?: OnGamePlayed,
): VariantSliceShardResult {
  const entry = suggestionRunner(context, job.context, job.runSeed);
  for (let i = 0; i < job.baseRecords.length; i++) {
    entry.supply(job.slotStart + i, job.baseRecords[i] as PairedBaseRecord);
  }
  entry.tick = onGame;
  try {
    const slice = entry.runner.playSlice(
      { out: job.outCardId, in: job.inCardId },
      job.outName,
      job.inName,
      job.slotStart,
      job.slotEnd,
    );
    return {
      kind: 'variant-slice-shard',
      candidateKey: job.candidateKey,
      slotStart: job.slotStart,
      slotEnd: job.slotEnd,
      paired: slice.paired,
      variantWonBySlot: slice.variantWonBySlot,
      variantGamesPlayed: slice.variantGamesPlayed,
      variantGamesSkipped: slice.variantGamesSkipped,
    };
  } finally {
    entry.tick = undefined;
  }
}

// --- §3.175 manabase experiments ---------------------------------------------------

/**
 * Enumerate the manabase family and plan its ladder — the sim's own
 * `planManabaseRun`. The identical-game-skip question is settled here once, as
 * it is for suggestions, and the runner it settles on is the WATCHED one every
 * later shard of this run will be served from.
 */
export function runManabasePlan(job: ManabasePlanJob, context: SimContext): ManabasePlanResult {
  const base = heroDeck(job.context.hero);
  const plan = planManabaseRun(base, {
    pool: context.pool,
    opponentCount: job.context.opponentNames.length,
    baseSeed: job.context.seed,
    gamesPerVariant: job.gamesPerVariant,
    sweep: {
      sweeps: job.sweeps,
      countRadius: job.radius,
      mixRadius: job.radius,
      ...(job.families ? { families: job.families } : {}),
    },
  });
  const skip = suggestionRunner(context, job.context, plan.runSeed, RELIABILITY_WATCH).runner.identicalGameSkip;
  return {
    kind: 'manabase-plan',
    plan,
    identicalGameSkipEnabled: skip.enabled,
    ...(skip.reason ? { identicalGameSkipDisabledReason: skip.reason } : {}),
  };
}

/** The shared base games for a slot range, played under the reliability watch. */
export function runManabaseBaseSlotShard(
  job: ManabaseBaseSlotShardJob,
  context: SimContext,
  onGame?: OnGamePlayed,
): ManabaseBaseSlotShardResult {
  const entry = suggestionRunner(context, job.context, job.runSeed, RELIABILITY_WATCH);
  entry.tick = onGame;
  try {
    const records: PairedBaseRecord[] = [];
    for (let slot = job.slotStart; slot < job.slotEnd; slot++) {
      records.push(entry.runner.baseRecordAt(slot));
    }
    return { kind: 'manabase-base-slot-shard', slotStart: job.slotStart, slotEnd: job.slotEnd, records };
  } finally {
    entry.tick = undefined;
  }
}

/**
 * ONE manabase variant's games over a slot range. The variant deck is built
 * here from its steps, by the same `applyManabase` the sweep's planner
 * legality-checked it with; an unbuildable variant throws, which the pool
 * reports as a permanent failure of that ARM, never of the run.
 */
export function runManabaseVariantSliceShard(
  job: ManabaseVariantSliceShardJob,
  context: SimContext,
  onGame?: OnGamePlayed,
): ManabaseVariantSliceShardResult {
  const entry = suggestionRunner(context, job.context, job.runSeed, RELIABILITY_WATCH);
  for (let i = 0; i < job.baseRecords.length; i++) {
    entry.supply(job.slotStart + i, job.baseRecords[i] as PairedBaseRecord);
  }
  entry.tick = onGame;
  try {
    const slice = entry.runner.playVariantSlice(
      {
        key: job.variant.key,
        label: job.variant.label,
        variantDeck: applyManabase(heroDeck(job.context.hero), job.variant, context.pool),
        slotsChanged: job.variant.slotsChanged,
      },
      job.slotStart,
      job.slotEnd,
    );
    return {
      kind: 'manabase-variant-slice-shard',
      candidateKey: job.candidateKey,
      slotStart: job.slotStart,
      slotEnd: job.slotEnd,
      paired: slice.paired,
      variantGamesPlayed: slice.variantGamesPlayed,
      variantGamesSkipped: slice.variantGamesSkipped,
      variantWonBySlot: slice.variantWonBySlot,
      observedBySlot: slice.observedBySlot ?? [],
    };
  } finally {
    entry.tick = undefined;
  }
}

// --- single-game replay trace --------------------------------------------------

/** Play ONE game and record its trace for the replay viewer. Never sharded. */
export function runMatchJob(job: MatchJob, context: SimContext): MatchJobResult {
  const hero = loadDeck(heroDeck(job.context.hero), context.pool);
  if (job.opponentName === job.context.hero.name) {
    throw new Error('a deck cannot play itself — pick a different opponent.');
  }
  const opponent = opponentDeck(context, job.opponentName);

  const pilots = pilotsFor(context, job.context.pilotId);
  // The trace records the pilot per seat, so a saved replay can always say who
  // was playing — the same fact the Lab's win rates are relative to.
  const seatNames: Record<'A' | 'B', ReplaySeat> = {
    A: { player: 'A', deckName: hero.name, pilot: job.context.pilotId },
    B: { player: 'B', deckName: opponent.name, pilot: job.context.pilotId },
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
      pilotA: pilots.pilotA,
      pilotB: pilots.pilotB,
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
    case 'base-slot-shard':
      return runBaseSlotShard(job, context, onGame);
    case 'variant-slice-shard':
      return runVariantSliceShard(job, context, onGame);
    case 'match':
      return runMatchJob(job, context);
    case 'manabase-plan':
      return runManabasePlan(job, context);
    case 'manabase-base-slot-shard':
      return runManabaseBaseSlotShard(job, context, onGame);
    case 'manabase-variant-slice-shard':
      return runManabaseVariantSliceShard(job, context, onGame);
  }
}
