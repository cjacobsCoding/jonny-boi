/**
 * The "update ready" pill. Renders nothing until the updater's policy says a
 * new build is waiting AND a live game is deferring it (update-decision.ts is
 * the whole rule; this component only shows its `pillText`). Deliberately not
 * a button: the update applies itself at the next interruption-free moment,
 * and a tap target here would be an invitation to interrupt yourself.
 */
import { useSyncExternalStore, type ReactElement } from 'react';
import { appUpdater } from '../lib/update/updater.js';
import './update-pill.css';

export function UpdatePill(): ReactElement | null {
  const text = useSyncExternalStore(appUpdater.subscribe, appUpdater.pillText, appUpdater.pillText);
  if (text === null) return null;
  return (
    <div className="update-pill" role="status" aria-live="polite">
      <span className="update-pill__dot" />
      {text}
    </div>
  );
}
