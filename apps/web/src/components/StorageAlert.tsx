import { useSyncExternalStore, type ReactElement } from 'react';
import {
  describeNotice,
  dismissStorageNotice,
  storageNotices,
  subscribeToStorageNotices,
} from '../lib/persistence/failures.js';
import './storage-alert.css';

/**
 * THE BANNER THAT WOULD HAVE SAVED TWO DECKS.
 *
 * Mounted once in the app shell next to `UpdatePill`, for the same reason: a
 * storage failure happens while you are on whatever screen you are on, and a
 * message that lives inside one view would have to be navigated to.
 *
 * It says so AT THE MOMENT OF THE SAVE. That is the whole point — the old
 * behaviour was a `console.warn` and a deck that looked fine until the next
 * reload, which is not a failure the user can connect to anything they did.
 *
 * It is dismissible but not auto-dismissing: a toast that fades is exactly as
 * useful as the console line it replaces if the user happened to be looking
 * away, and the thing it is reporting does not stop being true.
 */
export function StorageAlert({
  onOpenStorageReadout,
}: {
  /** Take the user to the storage readout on the About page. */
  readonly onOpenStorageReadout: () => void;
}): ReactElement | null {
  const notices = useSyncExternalStore(
    subscribeToStorageNotices,
    storageNotices,
    storageNotices,
  );
  if (notices.length === 0) return null;

  // Errors first: a shed notice must never sit above "your decks did not save".
  const ordered = [...notices].sort((a, b) =>
    a.severity === b.severity ? b.at - a.at : a.severity === 'error' ? -1 : 1,
  );

  return (
    <div className="storage-alert" role="alert" aria-live="assertive">
      {ordered.map((notice) => (
        <div
          key={`${notice.areaId}:${notice.reason}`}
          className={`storage-alert__item storage-alert__item--${notice.severity}`}
        >
          <span className="storage-alert__mark" aria-hidden="true">
            {notice.severity === 'error' ? '⚠' : 'ℹ'}
          </span>
          <p className="storage-alert__text">{describeNotice(notice)}</p>
          <div className="storage-alert__actions">
            <button
              type="button"
              className="storage-alert__link"
              onClick={onOpenStorageReadout}
            >
              See what is using storage
            </button>
            <button
              type="button"
              className="storage-alert__dismiss"
              onClick={() => dismissStorageNotice(notice.areaId, notice.reason)}
              aria-label="Dismiss this storage message"
            >
              ✕
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
