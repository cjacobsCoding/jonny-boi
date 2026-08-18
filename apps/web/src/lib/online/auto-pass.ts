/**
 * Auto-advance through priority windows the online seat CANNOT act in.
 *
 * Why this exists — the bug it fixes. A fresh online game opens in the `upkeep`
 * step, not a main phase. Both seats are handed priority in `upkeep` and again in
 * `draw`, and in every one of those windows the server's only legal action is
 * `passPriority`. So the board correctly said "Your move" while the entire hand was
 * greyed out, and the first land could not be played until FOUR `Pass / advance`
 * clicks (two per seat) had gone by. To a player that is indistinguishable from a
 * broken app: "I joined with someone but I can't even drag lands out to play them.
 * Tried clicking, dragging, nothing works."
 *
 * The rule is deliberately narrow: we pass ONLY when passing is the single thing the
 * player is allowed to do. If any other action is legal — a land, a cast, a combat
 * declaration — we stop and let them play. That makes this a pure convenience: it
 * can never skip a decision, because in the windows it fires there is no decision to
 * make. The server stays authoritative and re-validates the pass like any other
 * action; a rejection simply stops the sequence.
 *
 * Kept pure and DOM-free so the whole rule is unit-testable without a socket.
 */
import type { GameAction } from '@jonny-boi/core';

/** Everything the auto-pass rule is allowed to look at. */
export interface PriorityWindow {
  /** Does this seat hold priority? (The server's `yourTurn`.) */
  readonly yourTurn: boolean;
  /** The server's legal actions for this seat. */
  readonly legalActions: readonly GameAction[];
  /** Objects on the stack. Non-empty means something is resolving — never skip it. */
  readonly stackSize: number;
  /** A resolving card has parked a question addressed to THIS seat. */
  readonly awaitingOwnChoice: boolean;
  /**
   * Cards this seat could cast if it first tapped for mana. The server never lists
   * these (it only offers a `castSpell` once the pool already covers the cost), so
   * `legalActions` alone would understate what the player can do.
   *
   * Deliberately NOT paired with a "has untapped lands" check. Holding an untapped
   * land is not a reason to stop: mana empties at the end of the step, so tapping
   * with nothing castable achieves nothing — and gating on it would disable
   * auto-pass from the first land drop onward, which is every turn but the first.
   */
  readonly tapCastableCount: number;
}

/**
 * True when the ONLY thing this seat can legally do is pass priority, so advancing
 * for them costs nothing and skips nothing.
 *
 * Every guard here is a reason NOT to auto-pass:
 * - no priority → not ours to pass;
 * - a parked question → the player must answer it;
 * - a non-empty stack → they should see what is resolving before it does, and a
 *   response window is exactly where a held instant matters;
 * - a tap-castable card → the client can act even though the server listed no such
 *   action (it only offers casts the pool already covers);
 * - any non-pass legal action → a real decision exists. This is what preserves
 *   blocking: `declareBlockers` arrives as a legal action, so a seat under attack
 *   always stops here rather than being advanced past its blocks.
 */
export function shouldAutoPass(w: PriorityWindow): boolean {
  if (!w.yourTurn) return false;
  if (w.awaitingOwnChoice) return false;
  if (w.stackSize > 0) return false;
  if (w.tapCastableCount > 0) return false;

  let sawPass = false;
  for (const a of w.legalActions) {
    if (a.kind !== 'passPriority') return false;
    sawPass = true;
  }
  return sawPass;
}

/**
 * Rate limit: fire AT MOST ONCE per frame the server pushed.
 *
 * The caller holds the last frame it auto-passed for and skips a repeat. Frame
 * identity is the right unit — not a `turn:step:priority` key, which deadlocks. A
 * seat can legitimately need to pass TWICE inside one step with the stack empty the
 * whole time: in `declareBlockers` the active player gets priority, blockers are
 * declared, and priority comes back around in the same step. A key built from the
 * step would call that second window a duplicate and refuse to advance, hanging the
 * game on "advancing…" forever. The server only broadcasts after state actually
 * changed, so one pass per broadcast is both safe and self-limiting.
 */
export function alreadyPassedFrame(lastPassed: unknown, frame: unknown): boolean {
  return lastPassed === frame;
}
