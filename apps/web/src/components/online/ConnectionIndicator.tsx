import type { ReactElement } from 'react';
import type { ConnectionStatus } from '../../lib/online/connection.js';

/** Human label + tone for each connection status. */
const STATUS_LABEL: Readonly<Record<ConnectionStatus, string>> = {
  connecting: 'Connecting…',
  open: 'Connected',
  closed: 'Disconnected',
  error: 'Connection problem',
};

/**
 * A small connection-status pill. The dot color is driven by a status modifier class
 * in styles.css so the indicator matches the app theme tokens.
 */
export function ConnectionIndicator({ status }: { status: ConnectionStatus }): ReactElement {
  return (
    <span className={`conn-pill conn-pill--${status}`} role="status" aria-live="polite">
      <span className="conn-pill__dot" aria-hidden="true" />
      {STATUS_LABEL[status]}
    </span>
  );
}
