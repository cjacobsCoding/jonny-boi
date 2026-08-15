/**
 * Protocol version negotiation (pure).
 *
 * The two halves of this app ship at different speeds: the web app auto-deploys on
 * every merge, while the game server is a bundle copied onto a NAS by hand. The
 * server is therefore routinely the STALE side, and the handshake's strict equality
 * check turns that ordinary skew into a total outage — the lobby won't open at all,
 * for a version difference that only affects some cards.
 *
 * So when a handshake is refused for a version mismatch, step down to the oldest
 * version still worth playing and retry the same request once. The decision is
 * isolated here so it is unit-testable without a DOM, a socket, or React.
 */
import { MIN_COMPATIBLE_PROTOCOL_VERSION, PROTOCOL_VERSION } from '@jonny-boi/protocol';
import type { ErrorCode } from '@jonny-boi/protocol';

/** What to do about a server error during the handshake. */
export type NegotiationOutcome =
  | { readonly action: 'retry'; readonly version: number }
  | { readonly action: 'surface' };

/**
 * Decide whether a server error is a recoverable version mismatch.
 *
 * `retry` only when ALL of these hold, so we can never loop or paper over a real
 * failure: the error is specifically a version mismatch, a handshake is actually
 * outstanding to replay, and we are still ABOVE the compatible floor (so each
 * refusal strictly lowers the version and the process terminates).
 */
export function negotiateOnError(
  code: ErrorCode,
  currentVersion: number,
  hasPendingHandshake: boolean,
  floor: number = MIN_COMPATIBLE_PROTOCOL_VERSION,
): NegotiationOutcome {
  if (code !== 'protocolMismatch') return { action: 'surface' };
  if (!hasPendingHandshake) return { action: 'surface' };
  if (currentVersion <= floor) return { action: 'surface' };
  return { action: 'retry', version: floor };
}

/**
 * True when `version` is older than what this build speaks — i.e. we negotiated
 * down and are talking to a server that predates some features. The UI uses this
 * to say so up front rather than let a player discover it mid-game.
 */
export function isLegacyVersion(version: number): boolean {
  return version < PROTOCOL_VERSION;
}
