/**
 * THE WORKER THREAD ENTRY (DESIGN §3.53) — the file `parallel-host.ts` spawns.
 *
 * It does three things, and nothing else:
 *   1. builds the fixed sim context ONCE from `workerData` (card pool, effect
 *      registry, decks, pilots — the expensive part of hiring a worker);
 *   2. plays each job the host posts, through the SAME pure executor the
 *      identity tests run in-process (`executeParallelJob`), batching progress
 *      ticks so a fast slice does not post per game;
 *   3. reports results — or one loud error, which the host treats as fatal to
 *      the whole run, because a silently missing slice would merge into
 *      numbers that look complete.
 *
 * The engine has run in browser Web Workers since the Lab's pool shipped; this
 * file is what makes the same claim true of `node:worker_threads`, and the
 * integration test spawns it for real to prove it.
 */

import { parentPort, workerData, type MessagePort } from 'node:worker_threads';
import {
  createParallelContext,
  executeParallelJob,
  type WorkerInitSpec,
} from './parallel-slices.js';
import { PROGRESS_TICK_GAMES } from './parallel-config.js';
import type { HostToWorker, WorkerToHost } from './parallel-host.js';

const port: MessagePort = (() => {
  if (!parentPort) throw new Error('parallel-worker.ts is a worker_threads entry — it cannot run as a main module');
  return parentPort;
})();

/** Report a fatal condition and let the host kill the run. */
function reportError(err: unknown): void {
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
  port.postMessage({ type: 'error', message } satisfies WorkerToHost);
}

let context: ReturnType<typeof createParallelContext> | undefined;
try {
  context = createParallelContext(workerData as WorkerInitSpec);
} catch (err) {
  reportError(err);
}

port.on('message', (message: HostToWorker) => {
  if (message.type === 'shutdown') {
    port.close();
    return;
  }
  if (!context) return; // startup already reported the fatal error
  try {
    // `onGame` reports CUMULATIVE games for the current job; ticks to the host
    // are deltas, batched every PROGRESS_TICK_GAMES so a heuristic-speed slice
    // (hundreds of games/sec) does not flood the message channel.
    let cumulative = 0;
    let lastTicked = 0;
    const result = executeParallelJob(context, message.job, (games) => {
      cumulative = games;
      if (cumulative - lastTicked >= PROGRESS_TICK_GAMES) {
        port.postMessage({ type: 'tick', games: cumulative - lastTicked } satisfies WorkerToHost);
        lastTicked = cumulative;
      }
    });
    if (cumulative > lastTicked) {
      port.postMessage({ type: 'tick', games: cumulative - lastTicked } satisfies WorkerToHost);
    }
    port.postMessage({ type: 'result', index: message.index, result } satisfies WorkerToHost);
  } catch (err) {
    reportError(err);
  }
});
