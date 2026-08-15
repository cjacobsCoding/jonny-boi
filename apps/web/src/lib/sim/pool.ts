/**
 * **The sim worker pool** — the Lab's `ShardRunner` in a real browser.
 *
 * One `SimWorkerPool` owns N long-lived Web Workers and a queue of shards. Its
 * whole job is: keep every worker fed, report progress, survive a worker dying,
 * and stop *immediately* when the user hits Cancel.
 *
 * Design notes worth knowing before changing it:
 *
 * - **Workers are long-lived, jobs are not.** Each worker builds the card pool +
 *   effect registry once (the expensive part of starting a run) and then chews
 *   through shards. Spawning a worker per shard would spend the whole speedup on
 *   pool construction.
 * - **Cancel = terminate.** A shard is a synchronous loop of full MTG games
 *   inside the worker; a cooperative "please stop" flag could not interrupt it
 *   between games, so it would keep burning a core after the UI said it stopped.
 *   `dispose()` terminates every worker outright and rejects everything still in
 *   flight with `RunCancelled`, which the hook turns into a clean idle state.
 * - **A dead worker must not hang the run.** If a worker crashes, its in-flight
 *   shard is re-queued (up to `MAX_SHARD_ATTEMPTS`) onto a freshly spawned
 *   replacement. If the shard fails permanently — an illegal swap, an unknown
 *   deck — it is NOT retried, because it would fail identically forever; the
 *   failure surfaces as a real error instead of a silent partial result.
 */
import type { CardDefinition } from '@jonny-boi/core';
import { MAX_SHARD_ATTEMPTS } from './pool-config.js';
import { RunCancelled, ShardFailure, type ShardRunner } from './run.js';
import type {
  MainToWorkerMessage,
  ShardJob,
  ShardResult,
  WorkerMessage,
} from './shard-protocol.js';

/** One queued or in-flight shard and everything needed to settle its promise. */
interface Task {
  readonly id: number;
  readonly job: ShardJob;
  readonly onGames: (games: number) => void;
  readonly resolve: (result: ShardResult) => void;
  readonly reject: (err: Error) => void;
  attempts: number;
}

/** A worker plus what it is currently doing. */
interface Slot {
  worker: Worker;
  task: Task | null;
}

/** Construct a fresh module worker. Isolated so spawn and respawn share one path. */
function spawnWorker(): Worker {
  return new Worker(new URL('../sim.worker.ts', import.meta.url), { type: 'module' });
}

export interface SimWorkerPoolOptions {
  /**
   * How a worker is created. Injectable because the parts of this class most
   * worth testing — queueing, retry after a worker dies, cancel-rejects-
   * everything — are exactly the parts that need a worker to misbehave on cue,
   * which a real `Worker` will not do. Defaults to the real sim worker.
   */
  readonly spawn?: () => Worker;
}

export class SimWorkerPool implements ShardRunner {
  readonly workerCount: number;

  private readonly slots: Slot[] = [];
  private readonly queue: Task[] = [];
  /** Every task not yet settled, so `dispose` can reject them all. */
  private readonly live = new Map<number, Task>();
  private readonly spawn: () => Worker;
  private nextTaskId = 1;
  private disposed = false;

  constructor(
    workerCount: number,
    private readonly importedCards: readonly CardDefinition[],
    options: SimWorkerPoolOptions = {},
  ) {
    this.workerCount = Math.max(1, workerCount);
    this.spawn = options.spawn ?? spawnWorker;
    // Workers are spawned on demand (see `pump`), never up front: a single-game
    // replay is one job, and starting eleven workers — each loading the whole sim
    // bundle — to leave ten of them idle is pure latency.
  }

  /** Spawn a worker, wire its handlers, and hand it the shared card definitions. */
  private createSlot(): Slot {
    const slot: Slot = { worker: this.spawn(), task: null };
    this.attach(slot);
    const init: MainToWorkerMessage = { type: 'init', importedCards: this.importedCards };
    slot.worker.postMessage(init);
    return slot;
  }

  private attach(slot: Slot): void {
    slot.worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
      const message = event.data;
      const task = slot.task;
      // A reply for a task we already settled (a straggler from a worker we were
      // about to replace) is dropped rather than double-settling a promise.
      if (!task || task.id !== message.id) return;
      switch (message.type) {
        case 'shard-progress':
          task.onGames(message.gamesDelta);
          return;
        case 'shard-done':
          slot.task = null;
          this.settle(task, () => task.resolve(message.result));
          this.pump();
          return;
        case 'shard-error':
          // The worker is alive — it caught the error and reported it — so it
          // keeps its slot and only the task is settled.
          slot.task = null;
          this.failTask(task, new ShardFailure(message.message, message.permanent));
          return;
      }
    };
    // A worker that dies outright (an import failure, an OOM kill, a browser
    // reclaiming a background tab) reports here with no job context. Whatever it
    // was holding is treated as a TRANSIENT failure — the shard itself was
    // probably fine — so it is retried, on a replacement worker.
    slot.worker.onerror = (event: ErrorEvent) => {
      this.onWorkerDied(slot, event.message || 'a simulation worker crashed');
    };
    slot.worker.onmessageerror = () => {
      this.onWorkerDied(slot, 'a simulation worker sent an unreadable message');
    };
  }

  /** A worker is gone: replace it, then retry (or fail) whatever it was holding. */
  private onWorkerDied(slot: Slot, message: string): void {
    const task = slot.task;
    slot.task = null;
    this.replaceWorker(slot);
    if (task) this.failTask(task, new ShardFailure(message, false));
    else this.pump();
  }

  /** Terminate a slot's worker and give it a fresh one (used after a crash). */
  private replaceWorker(slot: Slot): void {
    if (this.disposed) return;
    try {
      slot.worker.terminate();
    } catch {
      // Already gone; nothing to clean up.
    }
    slot.worker = this.spawn();
    this.attach(slot);
    const init: MainToWorkerMessage = { type: 'init', importedCards: this.importedCards };
    slot.worker.postMessage(init);
  }

  private settle(task: Task, action: () => void): void {
    this.live.delete(task.id);
    action();
  }

  /**
   * A shard attempt failed. Retry transient failures on a fresh worker; surface
   * permanent ones (and exhausted retries) to the caller.
   */
  private failTask(task: Task, error: ShardFailure): void {
    if (this.disposed) {
      this.settle(task, () => task.reject(new RunCancelled()));
      return;
    }
    if (!error.permanent && task.attempts < MAX_SHARD_ATTEMPTS) {
      this.queue.push(task);
      this.pump();
      return;
    }
    this.settle(task, () => task.reject(error));
    this.pump();
  }

  /**
   * Hand queued shards to idle workers until one side runs out, growing the pool
   * up to `workerCount` as long as there is work for another worker.
   */
  private pump(): void {
    if (this.disposed) return;
    for (;;) {
      if (this.queue.length === 0) return;
      let slot = this.slots.find((candidate) => candidate.task === null);
      if (!slot) {
        if (this.slots.length >= this.workerCount) return; // fully committed.
        slot = this.createSlot();
        this.slots.push(slot);
      }
      const task = this.queue.shift();
      if (!task) return;
      task.attempts++;
      slot.task = task;
      const message: MainToWorkerMessage = { type: 'job', id: task.id, job: task.job };
      slot.worker.postMessage(message);
    }
  }

  /**
   * Spawn every worker now and let them build their card pools in parallel.
   *
   * Workers are otherwise created on demand, which is right for a one-job run (a
   * replay should not start eleven workers to leave ten idle) but wrong for a
   * suggestions search: its first phase is a SINGLE planning job, so one worker
   * would build its pool while ten others had not been created yet, and the rest
   * of the spin-up would then land inside the first round of games. Measured on a
   * 12-core box that put ~40% of a short search's wall-clock into pool
   * construction, at barely one-times parallelism.
   *
   * Warming is free to get wrong in the harmless direction: it costs nothing but
   * memory if the run turns out to be short, and it never changes a result.
   */
  warmUp(): void {
    if (this.disposed) return;
    while (this.slots.length < this.workerCount) this.slots.push(this.createSlot());
  }

  submit(job: ShardJob, onGames: (games: number) => void): Promise<ShardResult> {
    if (this.disposed) return Promise.reject(new RunCancelled());
    return new Promise<ShardResult>((resolve, reject) => {
      const task: Task = {
        id: this.nextTaskId++,
        job,
        onGames,
        resolve,
        reject,
        attempts: 0,
      };
      this.live.set(task.id, task);
      this.queue.push(task);
      this.pump();
    });
  }

  /**
   * Stop everything, now. Terminating is what makes Cancel instant: the games
   * running inside each worker are synchronous and cannot be asked to stop.
   * Every unsettled promise rejects with `RunCancelled` so no caller is left
   * awaiting a result that will never come.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const slot of this.slots) {
      slot.task = null;
      slot.worker.onmessage = null;
      slot.worker.onerror = null;
      slot.worker.onmessageerror = null;
      try {
        slot.worker.terminate();
      } catch {
        // Already gone.
      }
    }
    this.slots.length = 0;
    this.queue.length = 0;
    const pending = [...this.live.values()];
    this.live.clear();
    for (const task of pending) task.reject(new RunCancelled());
  }
}
