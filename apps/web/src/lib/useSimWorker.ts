/**
 * `useSimWorker` — the single wrapper the Lab uses to drive the sim (DESIGN §1.6).
 *
 * One hook owns the worker-pool lifecycle so the views never touch `postMessage`
 * directly (DRY): start a run, observe progress, get a typed result or a friendly
 * error, and cancel mid-run. Its public shape is unchanged from the days of a
 * single worker — the views did not have to learn that the Lab now runs on every
 * core.
 *
 * What DID change: a run is planned into shards, spread over
 * `browserPoolWorkerCount()` workers, and merged back in canonical order (see
 * `lib/sim/`). The pool size never affects a run's numbers, only how long it
 * takes.
 *
 * Cancellation = terminate. Sim runs are long, synchronous loops inside the
 * workers, so a cooperative cancel flag could not interrupt them between games.
 * Disposing the pool terminates every worker immediately and rejects the run;
 * the next run lazily builds a fresh pool. The component is always left in a
 * defined state (idle / running / done / error) — never a blank screen.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { importedDefinitions } from './decklist/importedCards.js';
import { SimWorkerPool } from './sim/pool.js';
import { isCancellation, runSimRequest } from './sim/run.js';
import { PROGRESS_INTERVAL_SECONDS, browserPoolWorkerCount } from './sim/pool-config.js';
import type { SimRequest, SimProgress, SimResultPayload } from './sim-protocol.js';

/** The lifecycle phase of the run, drives what the UI renders. */
export type SimStatus = 'idle' | 'running' | 'done' | 'error';

/** What the hook exposes to a view. */
export interface SimWorkerApi {
  readonly status: SimStatus;
  readonly progress: SimProgress | null;
  readonly result: SimResultPayload | null;
  readonly error: string | null;
  /**
   * How many workers a run will be spread over — a property of this machine,
   * decided once per mount. Exposed so the panels can turn a pilot's relative
   * decision cost into a wall-clock estimate BEFORE the user starts a run that
   * could take hours on this hardware and minutes on another.
   */
  readonly workerCount: number;
  /** Kick off a run. Replaces any in-flight run (terminates it first). */
  run: (request: SimRequest) => void;
  /** Cancel the current run (terminate every worker) and reset to idle. */
  cancel: () => void;
  /** Clear the last result/error back to idle (keeps any chosen inputs). */
  reset: () => void;
}

export function useSimWorker(): SimWorkerApi {
  const [status, setStatus] = useState<SimStatus>('idle');
  const [progress, setProgress] = useState<SimProgress | null>(null);
  const [result, setResult] = useState<SimResultPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const poolRef = useRef<SimWorkerPool | null>(null);
  /**
   * Identifies the current run. A pool disposed mid-run still has promises
   * unwinding, and without this a late rejection from the OLD run could stamp an
   * error over a NEW run that had already started.
   */
  const runIdRef = useRef(0);
  /**
   * The pool size is decided ONCE per mount, not per run: it is a property of
   * the machine, and re-reading it mid-session would let two runs of the same
   * request be planned differently for no reason.
   */
  const [workerCount] = useState(() => browserPoolWorkerCount());

  /** Tear down the live pool (used by cancel, replace-run, and unmount). */
  const dispose = useCallback(() => {
    poolRef.current?.dispose();
    poolRef.current = null;
  }, []);

  // Always clean up the workers when the Lab unmounts.
  useEffect(() => () => dispose(), [dispose]);

  const run = useCallback(
    (request: SimRequest) => {
      dispose(); // replace any in-flight run cleanly.
      const runId = ++runIdRef.current;
      setProgress(null);
      setResult(null);
      setError(null);
      setStatus('running');

      // The workers build their own card pools, so every run must carry the
      // definitions for cards outside the curated set. Injecting it here — the
      // single chokepoint every run goes through — means no Lab feature can
      // forget it and silently fail to load an imported deck.
      const pool = new SimWorkerPool(workerCount, importedDefinitions());
      poolRef.current = pool;

      runSimRequest(
        request,
        pool,
        (message) => {
          if (runIdRef.current !== runId) return;
          setProgress(message);
        },
        PROGRESS_INTERVAL_SECONDS,
      )
        .then((payload) => {
          if (runIdRef.current !== runId) return;
          setResult(payload);
          setStatus('done');
          dispose();
        })
        .catch((err: unknown) => {
          if (runIdRef.current !== runId) return;
          // A cancel already left the UI idle — do not paint it as a failure.
          if (isCancellation(err)) return;
          setError(
            err instanceof Error ? err.message : 'The simulation failed unexpectedly.',
          );
          setStatus('error');
          dispose();
        });
    },
    [dispose, workerCount],
  );

  const cancel = useCallback(() => {
    runIdRef.current++;
    dispose();
    setProgress(null);
    setStatus('idle');
  }, [dispose]);

  const reset = useCallback(() => {
    setProgress(null);
    setResult(null);
    setError(null);
    setStatus('idle');
  }, []);

  return { status, progress, result, error, workerCount, run, cancel, reset };
}
