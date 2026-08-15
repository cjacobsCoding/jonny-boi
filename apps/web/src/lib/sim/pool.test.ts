/**
 * The worker pool's behaviour under pressure — queueing, a worker dying, a job
 * that can never succeed, and cancellation.
 *
 * These are the parts of a parallel runner that only ever go wrong in
 * production, because a real `Worker` will not crash on demand. So the pool
 * takes an injectable `spawn` and this suite hands it a fake that misbehaves
 * exactly when asked. Everything asserted here is a promise the Lab makes to the
 * user: a dead worker must not hang a twenty-minute run, a broken job must
 * surface as an error rather than a quietly-short result, and Cancel must stop
 * every worker at once.
 */
import { describe, expect, it } from 'vitest';
import { SimWorkerPool } from './pool.js';
import { isCancellation, ShardFailure } from './run.js';
import type {
  MainToWorkerMessage,
  ShardJob,
  ShardResult,
  WorkerMessage,
} from './shard-protocol.js';

/** Every fake worker ever spawned in the current test, in spawn order. */
let spawned: FakeWorker[] = [];

/**
 * A stand-in for a real sim worker: it records what it was sent and does nothing
 * until the test tells it to answer, crash, or report a failure.
 */
class FakeWorker {
  onmessage: ((event: MessageEvent<WorkerMessage>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  readonly received: MainToWorkerMessage[] = [];
  terminated = false;

  constructor() {
    spawned.push(this);
  }

  postMessage(message: MainToWorkerMessage): void {
    this.received.push(message);
  }

  terminate(): void {
    this.terminated = true;
  }

  /** The job this worker is currently holding, if any. */
  get currentJobId(): number | null {
    const jobs = this.received.filter((m) => m.type === 'job');
    const last = jobs[jobs.length - 1];
    return last && last.type === 'job' ? last.id : null;
  }

  get jobCount(): number {
    return this.received.filter((m) => m.type === 'job').length;
  }

  private send(message: WorkerMessage): void {
    this.onmessage?.({ data: message } as MessageEvent<WorkerMessage>);
  }

  reportProgress(games: number): void {
    const id = this.currentJobId;
    if (id === null) throw new Error('no job in flight');
    this.send({ type: 'shard-progress', id, gamesDelta: games });
  }

  finish(result: ShardResult = STUB_RESULT): void {
    const id = this.currentJobId;
    if (id === null) throw new Error('no job in flight');
    this.send({ type: 'shard-done', id, result });
  }

  reportError(message: string, permanent: boolean): void {
    const id = this.currentJobId;
    if (id === null) throw new Error('no job in flight');
    this.send({ type: 'shard-error', id, message, permanent });
  }

  /** The worker process dies outright, mid-job, with no reply. */
  crash(message = 'worker died'): void {
    this.onerror?.({ message } as ErrorEvent);
  }
}

const STUB_RESULT: ShardResult = {
  kind: 'gauntlet-shard',
  opponentIndex: 0,
  gameStart: 0,
  gameEnd: 1,
  heroName: 'Hero',
  opponentName: 'Villain',
  games: 1,
  winsA: 1,
  winsB: 0,
  draws: 0,
  gameSeeds: [1],
};

function job(opponentIndex: number): ShardJob {
  return {
    kind: 'gauntlet-shard',
    context: { hero: { name: 'Hero', archetype: 'Hero', cards: [] }, opponentNames: [], seed: 1 },
    opponentIndex,
    gameStart: 0,
    gameEnd: 1,
  };
}

function makePool(workerCount: number): SimWorkerPool {
  spawned = [];
  return new SimWorkerPool(workerCount, [], {
    spawn: () => new FakeWorker() as unknown as Worker,
  });
}

/** Let queued microtasks settle so promise callbacks have run. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('SimWorkerPool', () => {
  it('spawns no worker until there is work, then only as many as there is work for', async () => {
    // A single-game replay is one job; starting eleven workers to leave ten idle
    // is pure latency on the one run where latency is all the user sees.
    const pool = makePool(4);
    expect(spawned).toHaveLength(0);

    const running = pool.submit(job(0), () => {});
    expect(spawned).toHaveLength(1);
    expect((spawned[0] as FakeWorker).received[0]).toEqual({ type: 'init', importedCards: [] });

    (spawned[0] as FakeWorker).finish();
    await running;
    pool.dispose();
  });

  it('keeps every worker busy and queues the rest, never over-committing one', async () => {
    const pool = makePool(2);
    const results = Promise.all([0, 1, 2, 3].map((i) => pool.submit(job(i), () => {})));

    // Two workers, four shards: exactly two are in flight and two wait.
    expect(spawned).toHaveLength(2);
    expect(spawned.map((w) => w.jobCount)).toEqual([1, 1]);

    for (const worker of spawned) worker.finish();
    await settle();
    // Each worker picked up a second shard as it freed up.
    expect(spawned.map((w) => w.jobCount)).toEqual([2, 2]);

    for (const worker of spawned) worker.finish();
    expect(await results).toHaveLength(4);
    pool.dispose();
  });

  it('sums per-worker progress into the caller’s tally', async () => {
    const pool = makePool(2);
    let games = 0;
    const running = Promise.all([0, 1].map((i) => pool.submit(job(i), (n) => (games += n))));
    for (const worker of spawned) worker.reportProgress(7);
    expect(games).toBe(14);
    for (const worker of spawned) worker.finish();
    await running;
    pool.dispose();
  });

  it('re-dispatches a dead worker’s shard onto a fresh worker, so a run never hangs', async () => {
    const pool = makePool(1);
    const running = pool.submit(job(0), () => {});
    const original = spawned[0] as FakeWorker;

    original.crash();
    await settle();

    // The dead worker is gone, a replacement took its place, and the shard it was
    // holding is being played again rather than lost or waited on forever.
    expect(original.terminated).toBe(true);
    expect(spawned).toHaveLength(2);
    const replacement = spawned[1] as FakeWorker;
    expect(replacement.jobCount).toBe(1);

    replacement.finish();
    await expect(running).resolves.toEqual(STUB_RESULT);
    pool.dispose();
  });

  it('gives up honestly when the retry dies too, instead of retrying forever', async () => {
    const pool = makePool(1);
    // Capture the outcome BEFORE the crashes: the rejection lands between the
    // two `settle()`s, and an unhandled rejection would fail the run.
    const outcome = pool.submit(job(0), () => {}).then(
      () => null,
      (err: unknown) => err,
    );

    (spawned[0] as FakeWorker).crash('first death');
    await settle();
    (spawned[1] as FakeWorker).crash('second death');
    await settle();

    // MAX_SHARD_ATTEMPTS is 2, so the second death is terminal: the caller gets a
    // real error and can report it, rather than a silent partial result.
    const error = await outcome;
    expect(error).toBeInstanceOf(ShardFailure);
    expect((error as Error).message).toContain('second death');
    // The shard was dispatched exactly twice (MAX_SHARD_ATTEMPTS) and then given
    // up on — a retry loop on a tab the browser is killing never terminates.
    expect(spawned.reduce((n, w) => n + w.jobCount, 0)).toBe(2);
    // The pool itself is still at full strength for the rest of the run: giving
    // up on one shard is not a reason to run the remaining shards a worker down.
    expect(spawned.filter((w) => !w.terminated)).toHaveLength(1);
    pool.dispose();
  });

  it('does not retry a shard that can never succeed', async () => {
    const pool = makePool(1);
    const running = pool.submit(job(0), () => {});
    const worker = spawned[0] as FakeWorker;

    // An illegal swap or an unknown deck fails identically on every worker;
    // retrying it just burns a core to reach the same answer.
    worker.reportError('"Lightning Bolt" is not in deck "Hero"', true);
    await expect(running).rejects.toBeInstanceOf(ShardFailure);
    expect(worker.jobCount).toBe(1);
    expect(spawned).toHaveLength(1);
    pool.dispose();
  });

  it('keeps a live worker that merely reported a failed job', async () => {
    const pool = makePool(1);
    const first = pool.submit(job(0), () => {});
    const worker = spawned[0] as FakeWorker;
    worker.reportError('bad shard', true);
    await expect(first).rejects.toThrow('bad shard');

    // The worker itself is fine — it caught the error and told us — so it keeps
    // its slot and its (expensive) card pool rather than being thrown away.
    expect(worker.terminated).toBe(false);
    expect(spawned).toHaveLength(1);
    const second = pool.submit(job(1), () => {});
    expect(worker.jobCount).toBe(2);
    worker.finish();
    await expect(second).resolves.toEqual(STUB_RESULT);
    pool.dispose();
  });

  it('cancel terminates every worker and rejects everything still in flight', async () => {
    const pool = makePool(3);
    const running = [0, 1, 2, 3, 4].map((i) => pool.submit(job(i), () => {}));
    const settled = running.map((p) => p.then(() => 'done').catch((e: unknown) => e));

    pool.dispose();

    for (const worker of spawned) expect(worker.terminated).toBe(true);
    // Queued shards reject too — nothing is left awaiting a result that will
    // never come, which is what leaves the UI cleanly idle.
    for (const outcome of await Promise.all(settled)) {
      expect(isCancellation(outcome)).toBe(true);
    }
  });

  it('refuses new work after cancel rather than spawning workers for a dead run', async () => {
    const pool = makePool(2);
    pool.dispose();
    const spawnedBefore = spawned.length;
    await expect(pool.submit(job(0), () => {})).rejects.toSatisfy(isCancellation);
    expect(spawned).toHaveLength(spawnedBefore);
  });

  it('warms every worker up front, so a one-job phase does not stagger the spin-up', async () => {
    // A suggestions search starts with a SINGLE planning job. Left to spawn on
    // demand the pool would build one card pool now and the other ten during the
    // first round of games — measured at ~40% of a short search's wall-clock,
    // spent at barely one-times parallelism.
    const pool = makePool(4);
    pool.warmUp();
    expect(spawned).toHaveLength(4);
    // Every one of them is handed its card set immediately, which is what makes
    // them build their pools in parallel rather than on first job.
    for (const worker of spawned) {
      expect(worker.received[0]?.type).toBe('init');
    }
    // Warming twice must not double the pool.
    pool.warmUp();
    expect(spawned).toHaveLength(4);
    pool.dispose();
  });

  it('does not spawn anything when warmed after cancel', () => {
    const pool = makePool(4);
    pool.dispose();
    pool.warmUp();
    expect(spawned).toHaveLength(0);
  });

  it('ignores a straggling reply from a worker whose job already settled', async () => {
    const pool = makePool(1);
    const running = pool.submit(job(0), () => {});
    const worker = spawned[0] as FakeWorker;
    worker.finish();
    await expect(running).resolves.toEqual(STUB_RESULT);
    // A second reply for the same id must not double-settle anything.
    expect(() => worker.finish()).not.toThrow();
    pool.dispose();
  });
});
