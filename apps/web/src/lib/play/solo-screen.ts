/**
 * SOLO-MODE SCREEN RULES — who is allowed to SEE what, decided purely.
 *
 * Bug report 20260825_210108: "after approving my hand, it showed me just a
 * flash of my opponents hand". The flow was built for two humans passing one
 * device, where showing the deciding seat's hand is the point. With a computer
 * in seat B the same flow rendered the COMPUTER'S mulligan prompt — seven cards
 * face up — for the full `aiThinkMs` delay before the auto-keep fired. In a
 * game whose whole premise is hidden hands, that is an information leak, and
 * "it was only 450 ms" is not a defence: the reporter read cards off it.
 *
 * These rules are pure so the leak is pinned by tests rather than by hoping
 * nobody reorders two effects again:
 *  - the mulligan screen for a seat the computer plays NEVER carries the hand;
 *  - a device-handoff addressed to the computer is auto-acknowledged — there is
 *    no human on the other end to pick up the device.
 */
import type { PlayerId } from '@jonny-boi/core';

/** How the mulligan step should be rendered for the seat currently deciding. */
export type MulliganPresentation =
  /** A human decides: show the hand, as pass-and-play always has. */
  | { readonly kind: 'human' }
  /**
   * The computer decides: show CARD BACKS ONLY. The decision itself is made by
   * the auto-keep effect; this is purely about what is on screen while it does.
   */
  | { readonly kind: 'aiDeciding' };

/** Presentation of the mulligan step for `deciding`, given who the computer is. */
export function mulliganPresentationFor(
  deciding: PlayerId,
  aiSeat: PlayerId | undefined,
): MulliganPresentation {
  return aiSeat !== undefined && deciding === aiSeat ? { kind: 'aiDeciding' } : { kind: 'human' };
}

/**
 * Should this device-handoff be acknowledged automatically? True exactly when
 * it is addressed to the computer's seat — a "pass the device to Computer"
 * screen is a doorbell for somebody who does not exist, and every moment it is
 * on screen is a moment the human thinks the game hung.
 */
export function handoffIsToComputer(to: PlayerId, aiSeat: PlayerId | undefined): boolean {
  return aiSeat !== undefined && to === aiSeat;
}
