/// <reference lib="webworker" />
/**
 * The sim Web Worker — one member of the Lab's worker pool.
 *
 * ALL simulation runs here so the main thread stays responsive (DESIGN §1.6),
 * and since the Lab now runs a POOL of these, this file is deliberately thin:
 * it is a loop that receives a shard, plays it, and answers. It owns no
 * orchestration, no statistics and no ranking — `lib/sim/execute.ts` plays the
 * games (composing the sim's public API), `lib/sim/merge.ts` aggregates on the
 * main thread, and `lib/sim/pool.ts` decides who runs what.
 *
 * Two things this worker is careful about:
 *
 * - **Context is built once, on `init`.** The card pool and effect registry are
 *   the expensive part of starting a run, so they are built when the worker is
 *   handed its card set and reused for every shard afterwards. This is why the
 *   pool keeps workers alive instead of spawning one per shard — and why it can
 *   warm every worker at once before a long run's first round.
 * - **Progress is coalesced.** Shards tick per game; twelve workers ticking
 *   individually would spend real time serialising `postMessage` payloads
 *   instead of playing games, so ticks are batched on a short timer and the
 *   remainder is always flushed before the result, so the totals stay exact.
 *
 * There is no in-worker cancellation flag: a shard is a synchronous run of full
 * games and could not honour one between them. The pool cancels by TERMINATING
 * its workers, which is immediate and clean.
 */
import { createSimContext, executeShard, type SimContext } from './sim/execute.js';
import type {
  MainToWorkerMessage,
  WorkerMessage,
} from './sim/shard-protocol.js';
import type { CardDefinition } from '@jonny-boi/core';

const ctx = self as unknown as DedicatedWorkerGlobalScope;

/**
 * How long games may accumulate before this worker posts a progress tick. Short
 * enough that the UI's bar moves smoothly, long enough that a fast shard is not
 * dominated by message traffic.
 */
const WORKER_PROGRESS_INTERVAL_SECONDS = 0.1;

let importedCards: readonly CardDefinition[] = [];
let context: SimContext | null = null;

function post(message: WorkerMessage): void {
  ctx.postMessage(message);
}

/**
 * The sim context. Normally built by `init`; the fallback covers a job that
 * somehow arrives first, so a missing init degrades to the old lazy behaviour
 * rather than throwing.
 */
function simContext(): SimContext {
  context ??= createSimContext(importedCards);
  return context;
}

ctx.onmessage = (event: MessageEvent<MainToWorkerMessage>): void => {
  const message = event.data;

  if (message.type === 'init') {
    importedCards = message.importedCards;
    // A new card set invalidates any pool built from the old one. Rebuild it NOW
    // rather than on the first job: init is the pool's chance to warm every
    // worker at once (`SimWorkerPool.warmUp`), and that only buys anything if the
    // expensive part actually happens here, off the main thread, in parallel.
    context = createSimContext(importedCards);
    return;
  }

  const { id, job } = message;
  let pendingGames = 0;
  let lastFlushAt = performance.now() / 1000;

  const flush = (): void => {
    if (pendingGames === 0) return;
    post({ type: 'shard-progress', id, gamesDelta: pendingGames });
    pendingGames = 0;
  };

  try {
    const result = executeShard(job, simContext(), (games) => {
      pendingGames += games;
      const now = performance.now() / 1000;
      if (now - lastFlushAt >= WORKER_PROGRESS_INTERVAL_SECONDS) {
        lastFlushAt = now;
        flush();
      }
    });
    // Always flush the remainder so the pool's tally matches the games played.
    flush();
    post({ type: 'shard-done', id, result });
  } catch (err) {
    flush();
    // Anything thrown from `executeShard` is inherent to the JOB (an illegal
    // swap, an unknown deck, an unloadable decklist) rather than to this worker,
    // so re-running it elsewhere would fail identically: report it as permanent
    // and let the pool surface an honest error instead of retrying forever.
    post({
      type: 'shard-error',
      id,
      message: err instanceof Error ? err.message : String(err),
      permanent: true,
    });
  }
};
