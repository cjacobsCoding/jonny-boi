/**
 * `useSimWorker` — the single wrapper the Lab uses to drive the sim Web Worker
 * (DESIGN §1.6). One hook owns the worker lifecycle so the views never touch
 * `postMessage` directly (DRY): start a run, observe progress, get a typed result
 * or a friendly error, and cancel mid-run.
 *
 * Cancellation = terminate. The sim runs are long, synchronous loops inside the
 * worker, so a cooperative cancel flag couldn't interrupt them between games.
 * Terminating the worker stops the work immediately and cleanly; we lazily spin
 * up a fresh worker for the next run. The component is always left in a defined
 * state (idle / running / done / error) — never a blank screen.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  SimRequest,
  SimResponse,
  SimProgress,
  SimResultPayload,
} from './sim-protocol.js';

/** The lifecycle phase of the worker, drives what the UI renders. */
export type SimStatus = 'idle' | 'running' | 'done' | 'error';

/** What the hook exposes to a view. */
export interface SimWorkerApi {
  readonly status: SimStatus;
  readonly progress: SimProgress | null;
  readonly result: SimResultPayload | null;
  readonly error: string | null;
  /** Kick off a run. Replaces any in-flight run (terminates it first). */
  run: (request: SimRequest) => void;
  /** Cancel the current run (terminate the worker) and reset to idle. */
  cancel: () => void;
  /** Clear the last result/error back to idle (keeps any chosen inputs). */
  reset: () => void;
}

/** Construct a fresh module worker. Isolated so `run`/`cancel` share one path. */
function spawnWorker(): Worker {
  return new Worker(new URL('./sim.worker.ts', import.meta.url), { type: 'module' });
}

export function useSimWorker(): SimWorkerApi {
  const [status, setStatus] = useState<SimStatus>('idle');
  const [progress, setProgress] = useState<SimProgress | null>(null);
  const [result, setResult] = useState<SimResultPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const workerRef = useRef<Worker | null>(null);

  /** Tear down the live worker (used by cancel, replace-run, and unmount). */
  const terminate = useCallback(() => {
    if (workerRef.current) {
      workerRef.current.terminate();
      workerRef.current = null;
    }
  }, []);

  // Always clean up the worker when the Lab unmounts.
  useEffect(() => () => terminate(), [terminate]);

  const run = useCallback(
    (request: SimRequest) => {
      terminate(); // replace any in-flight run cleanly.
      setProgress(null);
      setResult(null);
      setError(null);
      setStatus('running');

      const worker = spawnWorker();
      workerRef.current = worker;

      worker.onmessage = (event: MessageEvent<SimResponse>) => {
        const message = event.data;
        if (message.type === 'progress') {
          setProgress(message);
        } else if (message.type === 'result') {
          setResult(message.payload);
          setStatus('done');
          terminate();
        } else {
          setError(message.message);
          setStatus('error');
          terminate();
        }
      };
      // A worker that crashes outright (e.g. an import/parse failure) must still
      // land us in a defined error state, never a silent hang or blank screen.
      worker.onerror = (event: ErrorEvent) => {
        setError(event.message || 'The simulation worker crashed unexpectedly.');
        setStatus('error');
        terminate();
      };

      worker.postMessage(request);
    },
    [terminate],
  );

  const cancel = useCallback(() => {
    terminate();
    setProgress(null);
    setStatus('idle');
  }, [terminate]);

  const reset = useCallback(() => {
    setProgress(null);
    setResult(null);
    setError(null);
    setStatus('idle');
  }, []);

  return { status, progress, result, error, run, cancel, reset };
}
