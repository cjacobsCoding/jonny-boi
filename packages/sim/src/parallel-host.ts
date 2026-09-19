/**
 * THE CLI's PARALLEL WORKER POOL (DESIGN §3.53) — `node:worker_threads` fan-out
 * over the pure slice layer in `parallel-slices.ts`.
 *
 * This is deliberately the ONLY module (with `parallel-worker.ts`, its thread
 * entry) that imports `node:worker_threads`/`node:os`: everything that decides
 * WHAT to play and how results combine is pure and lives in the slice layer,
 * so the identity tests run it in-process and the web bundle never sees a Node
 * built-in. The pool here decides only scheduling — which thread plays which
 * slice, in what order — which is exactly the set of things that provably
 * cannot change the merged numbers (see the slice layer's header).
 *
 * Shape: long-lived workers, fed one job at a time from a shared queue, so a
 * slow slice (AI game lengths vary hugely) never strands the queue behind it —
 * the same arrangement as the web Lab's `useSimWorker` pool. A worker builds
 * its sim context (card pool, registries, decks, pilots) ONCE at startup from
 * `workerData` and reuses it for every slice it is handed; that startup is the
 * whole cost of hiring, and `parallel-config.ts`'s AUTO policy exists to make
 * sure it is only ever paid when the games waiting dwarf it.
 *
 * Failure is loud and total: any worker error rejects the run and terminates
 * the pool. A partial gauntlet quietly missing one slice would print numbers
 * that LOOK complete, which is the exact failure mode the merge layer's
 * byte-identity contract exists to prevent.
 */

import { Worker } from 'node:worker_threads';
import { availableParallelism } from 'node:os';
import { statSync } from 'node:fs';
import type { ParallelJob, ParallelResult, WorkerInitSpec } from './parallel-slices.js';

/** The machine's hardware-thread count — the input to `autoWorkerCount`. */
export function machineParallelism(): number {
  return availableParallelism();
}

// --- the message protocol (host ⇄ worker) ------------------------------------------

/** Host → worker: play this job (index keys the result back to the queue). */
export interface JobMessage {
  readonly type: 'job';
  readonly index: number;
  readonly job: ParallelJob;
}

/** Host → worker: no more jobs; exit cleanly. */
export interface ShutdownMessage {
  readonly type: 'shutdown';
}

export type HostToWorker = JobMessage | ShutdownMessage;

/** Worker → host: a finished slice. */
export interface ResultMessage {
  readonly type: 'result';
  readonly index: number;
  readonly result: ParallelResult;
}

/** Worker → host: games played since the last tick (batched — see config). */
export interface TickMessage {
  readonly type: 'tick';
  readonly games: number;
}

/** Worker → host: the job (or startup) failed. Fatal to the whole run. */
export interface ErrorMessage {
  readonly type: 'error';
  readonly message: string;
}

export type WorkerToHost = ResultMessage | TickMessage | ErrorMessage;

// --- locating the worker module -----------------------------------------------------

/**
 * The worker entry, resolved RELATIVE TO THIS MODULE so it tracks how the CLI
 * is being run: under `tsx src/cli.ts` this module's URL ends `.ts` and the
 * worker is the sibling `.ts` (the tsx loader in the worker handles it); from
 * the built `dist/` it ends `.js` and the sibling `.js` exists. No path is
 * hard-coded, so a rename breaks loudly at resolve time rather than silently
 * spawning a stale file.
 *
 * One exception, for one reason: a `.ts` host in a process WITHOUT a TypeScript
 * loader (Vitest) spawns the freshly BUILT worker when there is one — see
 * {@link freshBuiltWorkerUrl} for the platform difference that forced it.
 */
function workerModuleUrl(): { readonly url: URL; readonly isTypeScript: boolean } {
  const isTypeScript = import.meta.url.endsWith('.ts');
  if (isTypeScript && !processHasTsLoader()) {
    const built = freshBuiltWorkerUrl();
    if (built !== undefined) return { url: built, isTypeScript: false };
  }
  return {
    url: new URL(`./parallel-worker.${isTypeScript ? 'ts' : 'js'}`, import.meta.url),
    isTypeScript,
  };
}

/** Whether THIS process already runs under a TypeScript loader (the `tsx` CLI). */
function processHasTsLoader(): boolean {
  return process.execArgv.some((arg) => arg.includes('tsx'));
}

/**
 * The BUILT worker — `dist/src/parallel-worker.js` — when it exists and is at
 * least as new as every source it is compiled from; else `undefined`.
 *
 * ⚠️ Why a `.ts` host ever prefers a `.js` worker. Under Vitest this module is
 * loaded from `src/` (the config aliases every workspace package to its source),
 * so the sibling worker is `.ts` and needs a TypeScript loader INSIDE the thread.
 * Appending `--import tsx` to the worker's `execArgv` did that on the Windows dev
 * boxes and did nothing on the Linux CI runner: on Node 20 the worker died with
 * `Unknown file extension ".ts"`, and on Node 22 — whose native type-stripping
 * loads the `.ts` entry itself — it died one import later on
 * `Cannot find module './parallel-slices.js'`, the `.js`→`.ts` rewrite being the
 * loader's job. Whatever the reason a `Worker`'s `--import` is honoured on one
 * platform and not the other, a test that passes only where it was written is
 * not a test.
 *
 * The built worker needs no loader: its sibling imports are real `.js` files and
 * `@jonny-boi/*` already resolves to `dist/` through package exports. It is also
 * what the CLI actually runs, so the thing measured is the thing shipped. The
 * freshness check is what makes this safe to prefer: a `dist/` older than its
 * sources is exactly the trap `parallel-host.test.ts` documents ("does not
 * provide an export named …" after merging upstream), and a stale worker would
 * be a confident measurement of a tree that no longer exists — so it is refused,
 * and the `.ts` route stays as the fallback it was.
 */
function freshBuiltWorkerUrl(): URL | undefined {
  const built = new URL('../dist/src/parallel-worker.js', import.meta.url);
  // The worker's own local imports, compiled into dist beside it.
  const sources = ['./parallel-worker.ts', './parallel-slices.ts', './parallel-config.ts', './parallel-host.ts'].map(
    (rel) => new URL(rel, import.meta.url),
  );
  try {
    const builtAt = statSync(built).mtimeMs;
    for (const source of sources) {
      if (statSync(source).mtimeMs > builtAt) return undefined; // stale — refuse, say nothing false
    }
    return built;
  } catch {
    return undefined; // no dist at all: the .ts route, as before
  }
}

/**
 * The Node flags the worker thread starts with. A `.ts` worker needs a
 * TypeScript loader in the WORKER's own process args: under the `tsx` CLI the
 * inherited `execArgv` already carries one, but under Vitest (which transforms
 * in-process and registers no loader) it does not — so one is appended. `tsx`
 * is a dependency of this package and hoists to the repo root, where the
 * worker's module resolution finds it.
 */
function workerExecArgv(isTypeScript: boolean): readonly string[] | undefined {
  if (!isTypeScript) return undefined; // dist worker: plain JS, inherit as-is
  return processHasTsLoader() ? undefined : [...process.execArgv, '--import', 'tsx'];
}

// --- the pool ------------------------------------------------------------------------

/** A live pool: run batches of jobs against the same warmed workers, then close. */
export interface WorkerPool {
  /**
   * Play every job and return results in JOB ORDER (never arrival order).
   * `onProgress` is called with the cumulative games played across the batch.
   * One batch at a time — a second `run` before the first resolves is a bug.
   */
  readonly run: (
    jobs: readonly ParallelJob[],
    onProgress?: (gamesPlayed: number) => void,
    onResult?: (result: ParallelResult) => void,
  ) => Promise<readonly ParallelResult[]>;
  /** Shut every worker down. Idempotent; safe after a failed run. */
  readonly close: () => Promise<void>;
  /** How many workers were actually hired (≤ requested). */
  readonly size: number;
}

/**
 * Spawn `workers` threads initialised with `init`. Returns immediately —
 * workers warm up (pool load) concurrently with whatever the host does next,
 * which is how the soak's sequential anchored half hides the startup cost.
 */
export function createWorkerPool(init: WorkerInitSpec, workers: number): WorkerPool {
  const { url, isTypeScript } = workerModuleUrl();
  const execArgv = workerExecArgv(isTypeScript);
  const size = Math.max(1, Math.floor(workers));

  const threads: Worker[] = [];
  for (let i = 0; i < size; i++) {
    threads.push(
      new Worker(url, {
        workerData: init,
        ...(execArgv !== undefined ? { execArgv: [...execArgv] } : {}),
      }),
    );
  }

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await Promise.all(threads.map((thread) => thread.terminate()));
  };

  const run = (
    jobs: readonly ParallelJob[],
    onProgress?: (gamesPlayed: number) => void,
    onResult?: (result: ParallelResult) => void,
  ): Promise<readonly ParallelResult[]> => {
    if (jobs.length === 0) return Promise.resolve([]);
    return new Promise((resolve, reject) => {
      const results = new Array<ParallelResult>(jobs.length);
      let nextJob = 0;
      let completed = 0;
      let gamesPlayed = 0;
      let settled = false;

      const fail = (error: unknown): void => {
        if (settled) return;
        settled = true;
        detachAll();
        // The pool is poisoned — a worker died mid-slice. Close it so the CLI's
        // one-line error is the LAST thing that happens, not a hang.
        void close().finally(() => reject(error instanceof Error ? error : new Error(String(error))));
      };

      const feed = (thread: Worker): void => {
        if (settled) return;
        if (nextJob < jobs.length) {
          const index = nextJob++;
          thread.postMessage({ type: 'job', index, job: jobs[index] as ParallelJob } satisfies JobMessage);
        }
      };

      const listeners = new Map<Worker, (message: WorkerToHost) => void>();
      const errorListeners = new Map<Worker, (err: Error) => void>();
      const exitListeners = new Map<Worker, (code: number) => void>();
      const detachAll = (): void => {
        for (const thread of threads) {
          const onMessage = listeners.get(thread);
          if (onMessage) thread.off('message', onMessage);
          const onError = errorListeners.get(thread);
          if (onError) thread.off('error', onError);
          const onExit = exitListeners.get(thread);
          if (onExit) thread.off('exit', onExit);
        }
      };

      for (const thread of threads) {
        const onMessage = (message: WorkerToHost): void => {
          switch (message.type) {
            case 'tick':
              gamesPlayed += message.games;
              onProgress?.(gamesPlayed);
              return;
            case 'result':
              results[message.index] = message.result;
              completed++;
              onResult?.(message.result);
              if (completed === jobs.length) {
                settled = true;
                detachAll();
                resolve(results);
                return;
              }
              feed(thread);
              return;
            case 'error':
              fail(new Error(message.message));
              return;
          }
        };
        const onError = (err: Error): void => fail(err);
        const onExit = (code: number): void => {
          if (!settled && code !== 0) fail(new Error(`sim worker exited with code ${code}`));
        };
        listeners.set(thread, onMessage);
        errorListeners.set(thread, onError);
        exitListeners.set(thread, onExit);
        thread.on('message', onMessage);
        thread.on('error', onError);
        thread.on('exit', onExit);
      }

      // Prime every worker with one job; the queue refills them as they finish.
      for (const thread of threads) feed(thread);
    });
  };

  return { run, close, size };
}

/**
 * One-shot convenience: pool → run → close. What every CLI command except the
 * two-phase soak uses.
 */
export async function runJobsOnWorkers(
  jobs: readonly ParallelJob[],
  init: WorkerInitSpec,
  workers: number,
  onProgress?: (gamesPlayed: number) => void,
  onResult?: (result: ParallelResult) => void,
): Promise<readonly ParallelResult[]> {
  const pool = createWorkerPool(init, Math.min(workers, Math.max(1, jobs.length)));
  try {
    return await pool.run(jobs, onProgress, onResult);
  } finally {
    await pool.close();
  }
}
