import type { ReactElement } from 'react';
import type { SimProgress } from '../lib/sim-protocol.js';
import { etaText, gamesPerSecond, throughputText } from '../lib/sim-format.js';

/**
 * The live-run indicator: a progress bar (units done / total), games run,
 * games/sec, and elapsed time, plus a Cancel button. Shown while a run is in
 * flight so the main thread visibly stays responsive (the worker does the work).
 */
export function RunStatus({
  progress,
  onCancel,
}: {
  progress: SimProgress | null;
  onCancel: () => void;
}): ReactElement {
  const total = progress?.total ?? 0;
  const done = progress?.done ?? 0;
  const fraction = total > 0 ? Math.min(done / total, 1) : 0;
  const gps = progress ? gamesPerSecond(progress.gamesRun, progress.elapsedSeconds) : 0;
  const eta = progress ? etaText(done, total, progress.elapsedSeconds) : null;
  return (
    <div className="run-status" role="status" aria-live="polite">
      <div className="run-status__bar-track">
        <div className="run-status__bar-fill" style={{ width: `${fraction * 100}%` }} />
      </div>
      <div className="run-status__meta">
        <span>{progress ? progress.label : 'Starting…'}</span>
        <span className="run-status__nums">
          {progress ? (
            <>
              {progress.gamesRun.toLocaleString()} games · {throughputText(gps)} ·{' '}
              {progress.elapsedSeconds.toFixed(1)}s{eta ? ` · ${eta}` : ''}
            </>
          ) : (
            'spinning up the workers…'
          )}
        </span>
      </div>
      <button type="button" className="btn btn--danger" onClick={onCancel}>
        Cancel
      </button>
    </div>
  );
}
