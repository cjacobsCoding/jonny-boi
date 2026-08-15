/**
 * **THE determinism proof for the parallel Lab.**
 *
 * The Lab's whole promise is a *statistically definitive* verdict from a seed.
 * Spreading a run over twelve cores is only allowed if it cannot move a single
 * digit of that verdict, so this suite asserts two things for every run kind:
 *
 *   1. **Core count is invisible.** The same request planned for 1 worker and for
 *      N workers produces identical output — win counts, per-matchup rows,
 *      deltas, p-values, verdicts, and the final ranking ORDER.
 *   2. **Completion order is invisible.** The same request with shards finishing
 *      backwards produces identical output too. (This is the failure mode that
 *      would never show up in a single-threaded test and would look like harmless
 *      noise in production.)
 *
 * And, underneath both, the property that makes them worth anything:
 *
 *   3. **The parallel result equals the sim's own single-threaded function.** A
 *      sharded gauntlet equals `runGauntlet`; a sharded paired run equals
 *      `evaluateSwap`; a sharded suggestions search equals `suggestSwaps`. Two
 *      parallel runs agreeing with each other but not with the sim would be
 *      consistently wrong — which is worse than noisy.
 *
 * The runner is injected, so this runs in Node with no Web Worker involved: the
 * code under test (`plan` → `execute` → `merge`) is exactly the code the browser
 * runs, minus the transport.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SUGGEST_CONFIG,
  evaluateSwap,
  generateCandidates,
  loadDeck,
  runGauntlet as simRunGauntlet,
  suggestSwaps,
  SAMPLE_DECKS,
  type Deck,
  type LoadedDeck,
  type SuggestionReport,
} from '@jonny-boi/sim';
import { createSimContext, executeShard, type SimContext } from './execute.js';
import { resolveOpponentNames } from './opponents.js';
import { runGauntlet, runSuggest, runSwap, ShardFailure, type ShardRunner } from './run.js';
import type { ShardJob, ShardResult } from './shard-protocol.js';
import type {
  GauntletRequest,
  SimProgress,
  SuggestRequest,
  SwapRequest,
} from '../sim-protocol.js';

/**
 * A `ShardRunner` that executes shards in-process. It defers execution to a
 * macrotask so a whole `Promise.all` batch is queued before anything runs, which
 * lets us settle the batch in whatever order we like — the point being that the
 * merge must not care.
 */
class LocalShardRunner implements ShardRunner {
  private pending: {
    job: ShardJob;
    onGames: (n: number) => void;
    resolve: (r: ShardResult) => void;
    reject: (e: Error) => void;
  }[] = [];
  private scheduled = false;

  constructor(
    readonly workerCount: number,
    private readonly context: SimContext,
    private readonly completion: 'forward' | 'reverse',
    /** Shards whose job matches this predicate fail, to test the unhappy path. */
    private readonly failIf: (job: ShardJob) => boolean = () => false,
  ) {}

  submit(job: ShardJob, onGames: (n: number) => void): Promise<ShardResult> {
    return new Promise<ShardResult>((resolve, reject) => {
      this.pending.push({ job, onGames, resolve, reject });
      if (!this.scheduled) {
        this.scheduled = true;
        setTimeout(() => this.drain(), 0);
      }
    });
  }

  private drain(): void {
    this.scheduled = false;
    const batch = this.pending;
    this.pending = [];
    const ordered = this.completion === 'reverse' ? [...batch].reverse() : batch;
    for (const task of ordered) {
      if (this.failIf(task.job)) {
        task.reject(new ShardFailure('simulated shard failure', true));
        continue;
      }
      try {
        task.resolve(executeShard(task.job, this.context, task.onGames));
      } catch (err) {
        task.reject(new ShardFailure(err instanceof Error ? err.message : String(err), true));
      }
    }
    if (this.pending.length > 0 && !this.scheduled) {
      this.scheduled = true;
      setTimeout(() => this.drain(), 0);
    }
  }
}

const context = createSimContext();
// Mono-Red is the fastest sample deck, so this suite proves its point in the
// fewest seconds. Any deck would do — equality is what is under test.
const HERO: Deck = SAMPLE_DECKS[0] as Deck;
const SEED = 0xc0ffee;
/** Small on purpose: this suite proves equality, not statistical power. */
const GAUNTLET_GAMES = 6;
const SWAP_GAMES = 5;
const SUGGEST_GAMES = 3;
const SUGGEST_CANDIDATES = 2;
/** Progress ticks are irrelevant to equality; emit them freely and ignore them. */
const NO_THROTTLE = 0;

function opponents(names: readonly string[]): LoadedDeck[] {
  return names.map((name) => {
    const sample = SAMPLE_DECKS.find((d) => d.name === name);
    if (!sample) throw new Error(`missing sample deck ${name}`);
    return loadDeck(sample, context.pool);
  });
}

/** Two opponents keeps the run cheap while still exercising per-opponent seeding. */
const TWO_OPPONENTS = resolveOpponentNames([], HERO.name).slice(0, 2);
const ONE_OPPONENT = TWO_OPPONENTS.slice(0, 1);

function collect(): { sink: (p: SimProgress) => void; seen: SimProgress[] } {
  const seen: SimProgress[] = [];
  return { sink: (p) => seen.push(p), seen };
}

// --- gauntlet ------------------------------------------------------------------

describe('a parallel gauntlet', () => {
  const request: GauntletRequest = {
    kind: 'gauntlet',
    hero: HERO,
    opponentNames: [...TWO_OPPONENTS],
    gamesPerOpponent: GAUNTLET_GAMES,
    seed: SEED,
  };

  async function runAt(workers: number, completion: 'forward' | 'reverse'): Promise<unknown> {
    const { sink } = collect();
    const payload = await runGauntlet(
      request,
      new LocalShardRunner(workers, context, completion),
      sink,
      NO_THROTTLE,
    );
    if (payload.kind !== 'gauntlet') throw new Error('wrong payload kind');
    return payload.result;
  }

  it('gives byte-identical results at 1 worker and at 12', async () => {
    const single = await runAt(1, 'forward');
    const pooled = await runAt(12, 'forward');
    expect(pooled).toEqual(single);
  });

  it('is unaffected by the order shards finish in', async () => {
    const forward = await runAt(12, 'forward');
    const backward = await runAt(12, 'reverse');
    expect(backward).toEqual(forward);
  });

  it('equals the sim’s own single-threaded runGauntlet, matchup for matchup', async () => {
    const reference = simRunGauntlet(
      loadDeck(HERO, context.pool),
      opponents(TWO_OPPONENTS),
      context.pilots,
      GAUNTLET_GAMES,
      SEED,
      context.registry,
    );
    expect(await runAt(12, 'reverse')).toEqual(reference);
  });

  it('reports honest progress: games done never exceeds games planned, and ends complete', async () => {
    const { sink, seen } = collect();
    await runGauntlet(request, new LocalShardRunner(12, context, 'forward'), sink, NO_THROTTLE);
    const last = seen[seen.length - 1] as SimProgress;
    expect(last.total).toBe(TWO_OPPONENTS.length * GAUNTLET_GAMES);
    expect(last.done).toBe(last.total);
    for (const tick of seen) expect(tick.done).toBeLessThanOrEqual(tick.total);
    // Every tick names how many workers are doing the work — the run is legible.
    expect(last.label).toContain('12 workers');
  });
});

// --- A/B swap ------------------------------------------------------------------

describe('a parallel A/B swap test', () => {
  const candidate = generateCandidates(HERO, context.pool, {
    ...DEFAULT_SUGGEST_CONFIG,
    maxCandidates: 1,
  }).candidates[0];
  if (!candidate) throw new Error('the hero deck produced no legal swap candidates');

  const request: SwapRequest = {
    kind: 'swap',
    hero: HERO,
    opponentNames: [...TWO_OPPONENTS],
    outCardId: candidate.outId,
    inCardId: candidate.inId,
    gamesPerOpponent: SWAP_GAMES,
    seed: SEED,
  };

  async function runAt(workers: number, completion: 'forward' | 'reverse'): Promise<unknown> {
    const { sink } = collect();
    const payload = await runSwap(
      request,
      new LocalShardRunner(workers, context, completion),
      sink,
      NO_THROTTLE,
    );
    if (payload.kind !== 'swap') throw new Error('wrong payload kind');
    return payload.result;
  }

  it('gives an identical verdict at 1 worker and at 12', async () => {
    expect(await runAt(12, 'forward')).toEqual(await runAt(1, 'forward'));
  });

  it('is unaffected by the order shards finish in', async () => {
    expect(await runAt(12, 'reverse')).toEqual(await runAt(12, 'forward'));
  });

  it('equals evaluateSwap — the paired common-random-numbers property survives sharding', async () => {
    // If a shard boundary had separated a game index's base and variant arms, or
    // re-seeded from a shard-local counter, the paired 2x2 table below would
    // differ even though both runs stayed unbiased.
    const reference = evaluateSwap(
      HERO,
      { out: candidate.outId, in: candidate.inId },
      opponents(TWO_OPPONENTS),
      context.pilots,
      SWAP_GAMES,
      SEED,
      context.pool,
      context.registry,
    );
    expect(await runAt(12, 'reverse')).toEqual(reference);
  });

  it('keeps the self-swap sanity check exact when sharded', async () => {
    // Swapping a card for itself must yield a variant identical to the base, so
    // every paired game agrees: zero discordant pairs, delta exactly 0. Sharding
    // is only safe if it preserves that EXACTLY, not approximately.
    const selfRequest: SwapRequest = {
      ...request,
      inCardId: candidate.outId,
      opponentNames: [...ONE_OPPONENT],
    };
    const payload = await runSwap(
      selfRequest,
      new LocalShardRunner(12, context, 'reverse'),
      collect().sink,
      NO_THROTTLE,
    );
    if (payload.kind !== 'swap') throw new Error('wrong payload kind');
    expect(payload.result.delta).toBe(0);
    expect(payload.result.paired.baseOnly).toBe(0);
    expect(payload.result.paired.variantOnly).toBe(0);
    expect(payload.result.verdict).toBe('inconclusive');
  });
});

// --- suggestions ---------------------------------------------------------------

describe('a parallel suggestions search', () => {
  const request: SuggestRequest = {
    kind: 'suggest',
    hero: HERO,
    opponentNames: [...ONE_OPPONENT],
    gamesPerCandidate: SUGGEST_GAMES,
    maxCandidates: SUGGEST_CANDIDATES,
    seed: SEED,
  };

  async function runAt(workers: number, completion: 'forward' | 'reverse') {
    const payload = await runSuggest(
      request,
      new LocalShardRunner(workers, context, completion),
      collect().sink,
      NO_THROTTLE,
    );
    if (payload.kind !== 'suggest') throw new Error('wrong payload kind');
    return payload.result;
  }

  /** Timings differ run to run; equality is about the numbers, not the clock. */
  function withoutTimings(report: SuggestionReport): unknown {
    const { elapsedSeconds: _elapsed, gamesPerSecond: _throughput, ...notes } = report.notes;
    return { ...report, notes };
  }

  it('produces the same ranking at 1 worker and at 12', async () => {
    const single = await runAt(1, 'forward');
    const pooled = await runAt(12, 'forward');
    expect(withoutTimings(pooled)).toEqual(withoutTimings(single));
    expect(pooled.suggestions.map((s) => `${s.outName}>${s.inName}`)).toEqual(
      single.suggestions.map((s) => `${s.outName}>${s.inName}`),
    );
  });

  it('is unaffected by the order candidates finish in', async () => {
    const forward = await runAt(12, 'forward');
    const backward = await runAt(12, 'reverse');
    expect(withoutTimings(backward)).toEqual(withoutTimings(forward));
  });

  it('equals the sim’s own suggestSwaps, rank for rank', async () => {
    const reference = suggestSwaps(HERO, {
      gauntletDecks: opponents(ONE_OPPONENT),
      pilots: context.pilots,
      pool: context.pool,
      registry: context.registry,
      baseSeed: SEED,
      gamesPerCandidate: SUGGEST_GAMES,
      suggestConfig: { ...DEFAULT_SUGGEST_CONFIG, maxCandidates: SUGGEST_CANDIDATES },
    });
    const parallel = await runAt(12, 'reverse');
    expect(withoutTimings(parallel)).toEqual(withoutTimings(reference));
  });

  it('drops a candidate whose shards fail and says so, instead of losing the whole run', async () => {
    // A worker dying on one candidate must not throw away a search that may have
    // been running for twenty minutes — and the report must not quietly come back
    // one candidate short.
    const runner = new LocalShardRunner(
      12,
      context,
      'forward',
      (job) => job.kind === 'paired-shard' && job.candidateIndex === 0,
    );
    const payload = await runSuggest(request, runner, collect().sink, NO_THROTTLE);
    if (payload.kind !== 'suggest') throw new Error('wrong payload kind');
    expect(payload.result.candidatesEvaluated).toBe(SUGGEST_CANDIDATES - 1);
    const failure = payload.result.skipped.find((s) =>
      s.details.some((d) => d.includes('simulated shard failure')),
    );
    expect(failure).toBeDefined();
  });
});
