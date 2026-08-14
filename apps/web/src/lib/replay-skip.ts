/**
 * Which replay frames are worth stopping on.
 *
 * A traced game snapshots a frame after EVERY applied action, and most actions
 * are a player passing priority through a step where nothing can happen: untap,
 * upkeep with no triggers, a combat phase with no creature able to attack.
 * Stepping through those one at a time buries the moments that matter.
 *
 * So stepping fast-forwards to the next frame that CHANGED something. A frame is
 * notable when the events it introduced include at least one the log would print
 * — which is exactly the shared `describeEvent` filter, so what you can stop on
 * and what you can read stay in agreement by construction (no second rule table
 * to drift).
 *
 * Deliberately event-based rather than "could anything legally happen here?":
 * proving a phase inert would mean re-deriving legal actions for a state we only
 * snapshot, and the honest answer the viewer wants is the same either way —
 * nothing happened, so move on. The endpoints (opening, final, game over) are
 * always notable so fast-forward can never run off the end or hide the result.
 *
 * Pure and dependency-free apart from the formatter: unit-tested, no React.
 */

import type { MatchTrace } from './replay-types.js';
import { describeEvent } from './replay-format.js';

/** Names are irrelevant to whether an event is notable — this stub keeps it cheap. */
const NO_NAMES = (id: number): string => `#${id}`;

/**
 * Does stopping on `index` show the viewer something new?
 *
 * True for the opening frame, the final frame, any frame that ends the game, and
 * any frame whose newly-introduced events include a printable one.
 */
export function isNotableFrame(trace: MatchTrace, index: number): boolean {
  const frames = trace.frames;
  if (index <= 0) return true;
  if (index >= frames.length - 1) return true;

  const frame = frames[index];
  if (!frame) return true;
  if (frame.gameOver) return true;

  const previous = frames[index - 1];
  const from = previous ? previous.eventIndex + 1 : 0;
  for (let i = from; i <= frame.eventIndex && i < trace.events.length; i += 1) {
    const event = trace.events[i];
    if (event && describeEvent(event, NO_NAMES)) return true;
  }
  return false;
}

/**
 * The next notable frame in `direction` (+1 / -1) from `index`, or the nearest
 * endpoint if there is none. Never returns `index` itself, so a step always
 * moves — a quiet tail can't wedge the button.
 */
export function nextNotableFrame(
  trace: MatchTrace,
  index: number,
  direction: 1 | -1,
): number {
  const last = trace.frames.length - 1;
  if (last < 0) return 0;

  for (let i = index + direction; i >= 0 && i <= last; i += direction) {
    if (isNotableFrame(trace, i)) return i;
  }
  return direction > 0 ? last : 0;
}
