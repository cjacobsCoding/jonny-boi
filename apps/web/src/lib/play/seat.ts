/**
 * The seat / transport SEAM — the boundary that keeps the hotseat UI free of
 * "local-only" assumptions so a networked transport can be slotted in LATER without
 * rewriting the rendering layer.
 *
 * Design intent (mirrors the brief's architecture note):
 *   - The `GameSession` (session.ts) owns the authoritative engine state and the
 *     rules of advancement. It is transport-agnostic: it just exposes the state, the
 *     legal actions for whoever has priority, and `submitAction`.
 *   - A `SeatTransport` answers two questions the UI needs but the engine doesn't
 *     model: (1) WHICH human is physically/remotely controlling each seat, and
 *     (2) whether a control handoff is required before that human may see secret
 *     info and act. For local hotseat the answer to (1) is "both seats are this
 *     device" and (2) is "show a pass-the-device interstitial between controllers".
 *   - A future `OnlineTransport` would implement the SAME interface: each seat is
 *     owned by a remote peer, `localControls(seat)` is true only for the seat this
 *     client owns, and `requiresHandoff` is always false (each peer only ever sees
 *     its own hand — no device passing). The UI code branches on the transport's
 *     answers, never on `instanceof LocalHotseatTransport`.
 *
 * Because the masking/view-model layer (view-model.ts) keys off "which seat is this
 * viewer", the same hidden-info guarantees hold whether the opponent is across the
 * couch or across the network.
 */
import type { PlayerId } from '@jonny-boi/core';

/** Per-seat identity (display name) the UI shows. */
export interface SeatInfo {
  readonly id: PlayerId;
  readonly name: string;
}

/**
 * The transport seam. Local hotseat and (future) online both implement this; the UI
 * consumes only these methods.
 */
export interface SeatTransport {
  /** A stable tag for diagnostics/telemetry (e.g. 'local-hotseat', 'online'). */
  readonly kind: string;
  /** Display info for both seats. */
  readonly seats: Readonly<Record<PlayerId, SeatInfo>>;
  /**
   * Whether THIS client may directly control `seat` (render its hand face-up, build
   * actions for it). Local hotseat: true for both seats (one device drives both).
   * Online: true only for the seat this client owns.
   */
  localControls(seat: PlayerId): boolean;
  /**
   * Whether a control handoff (the "pass the device" interstitial) is required when
   * the acting seat changes from `from` to `to`. Local hotseat: true whenever the
   * human in control changes (so the next player confirms before secrets show).
   * Online: false (each peer only sees its own info; nothing to hide behind a tap).
   */
  requiresHandoff(from: PlayerId, to: PlayerId): boolean;
}

/**
 * The local pass-and-play transport: both seats are driven by this one device, and
 * a handoff interstitial is shown whenever control passes to the OTHER human so the
 * incoming player confirms before any secret info (their hand) is revealed.
 */
export function createLocalHotseatTransport(
  seats: Readonly<Record<PlayerId, SeatInfo>>,
): SeatTransport {
  return {
    kind: 'local-hotseat',
    seats,
    // Both seats live on this device.
    localControls: () => true,
    // Passing control to the other human requires the device handoff. Same-seat
    // transitions (the active player keeps acting) need no interstitial.
    requiresHandoff: (from, to) => from !== to,
  };
}
