/**
 * React hook wrapping the optional upscale pass. The heavy work lives in
 * `upscale.ts`, imported *dynamically* here so it (and the canvas machinery)
 * only load when the user actually turns the toggle on — the initial bundle
 * stays lean. Owns the async orchestration + progress; the pure resample math it
 * calls is tested separately.
 */

import { useCallback, useRef, useState } from 'react';

/** Status of the upscale pass. */
export type UpscaleStatus = 'idle' | 'running' | 'done' | 'error';

/** Progress + result of the current/last upscale pass. */
export interface UpscalerState {
  status: UpscaleStatus;
  /** Fraction complete in [0, 1] while running. */
  progress: number;
  /** original image URL → upscaled (or original, on per-image failure) URL. */
  map: Map<string, string>;
  /** Upscale a de-duplicated set of image URLs; resolves when all are done. */
  run: (urls: readonly string[]) => Promise<void>;
  /** Drop all upscaled results (e.g. when the toggle is switched off). */
  clear: () => void;
}

export function useUpscaler(): UpscalerState {
  const [status, setStatus] = useState<UpscaleStatus>('idle');
  const [progress, setProgress] = useState(0);
  const [map, setMap] = useState<Map<string, string>>(new Map());
  // Guards against a stale pass writing results after a newer one started.
  const runIdRef = useRef(0);

  const run = useCallback(async (urls: readonly string[]) => {
    const runId = (runIdRef.current += 1);
    setStatus('running');
    setProgress(0);
    try {
      // Dynamic import → this becomes its own lazy chunk, off the initial load.
      const { upscaleAll } = await import('./upscale.js');
      const result = await upscaleAll(urls, (done, total) => {
        if (runIdRef.current === runId) setProgress(total > 0 ? done / total : 1);
      });
      if (runIdRef.current !== runId) return; // A newer pass superseded this one.
      setMap(result);
      setProgress(1);
      setStatus('done');
    } catch {
      if (runIdRef.current !== runId) return;
      // Whole-pass failure (e.g. chunk load blocked) → leave art un-upscaled.
      setStatus('error');
    }
  }, []);

  const clear = useCallback(() => {
    runIdRef.current += 1; // Invalidate any in-flight pass.
    setMap(new Map());
    setProgress(0);
    setStatus('idle');
  }, []);

  return { status, progress, map, run, clear };
}
