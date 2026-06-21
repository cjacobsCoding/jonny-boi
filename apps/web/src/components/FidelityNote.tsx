import type { ReactElement } from 'react';
import { FIDELITY_CAVEAT } from '../lib/lab-config.js';

/**
 * The §3.9 provisional-verdict caveat, shown near every verdict so the Lab never
 * overstates precision. One wording, sourced from `lab-config` (which mirrors the
 * sim's own `notes.fidelityCaveat`). Pass `text` to surface the sim's verbatim
 * caveat from a report when one is available.
 */
export function FidelityNote({ text }: { text?: string }): ReactElement {
  return (
    <p className="fidelity-note">
      <span className="fidelity-note__mark" aria-hidden="true">
        ⚠
      </span>{' '}
      {text ?? FIDELITY_CAVEAT}
    </p>
  );
}
