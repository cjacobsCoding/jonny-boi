/**
 * THE SCRUBBER (§3.66) — move through a saved game, then take it over.
 *
 * It sits above the ORDINARY board rather than beside a bespoke replay view,
 * because the whole point is that what you are looking at is the real game: the
 * same tiles, the same log, the same hand. Only the source of the state differs
 * — a deterministic re-derivation from the record instead of your own last move.
 *
 * "Play from here" is the fork. Anywhere before the end of the log it starts a
 * new playthrough that shares this game's seed, so the two differ only in what
 * happens next; at the end of the log there is nothing to fork from and it
 * simply hands the game back.
 */
import type { ReactElement } from 'react';
import './review-scrubber.css';

export function ReviewScrubber({
  at,
  total,
  turn,
  onScrub,
  onPlayFromHere,
}: {
  /** How many actions of the record are currently replayed. */
  readonly at: number;
  readonly total: number;
  /** The turn number of the state on screen — the number a player thinks in. */
  readonly turn: number;
  readonly onScrub: (next: number) => void;
  readonly onPlayFromHere: () => void;
}): ReactElement {
  const atEnd = at >= total;
  return (
    <div className="review-scrubber" role="group" aria-label="Review this game">
      <div className="review-scrubber__controls">
        <button
          type="button"
          className="btn btn--ghost"
          onClick={() => onScrub(0)}
          disabled={at === 0}
          aria-label="Jump to the start of the game"
        >
          ⏮
        </button>
        <button
          type="button"
          className="btn btn--ghost"
          onClick={() => onScrub(at - 1)}
          disabled={at === 0}
          aria-label="Step back one action"
        >
          ◀
        </button>
        <input
          className="review-scrubber__range"
          type="range"
          min={0}
          max={total}
          step={1}
          value={at}
          onChange={(e) => onScrub(Number(e.target.value))}
          aria-label="Scrub through the game"
        />
        <button
          type="button"
          className="btn btn--ghost"
          onClick={() => onScrub(at + 1)}
          disabled={atEnd}
          aria-label="Step forward one action"
        >
          ▶
        </button>
        <button
          type="button"
          className="btn btn--ghost"
          onClick={() => onScrub(total)}
          disabled={atEnd}
          aria-label="Jump to the end of the game"
        >
          ⏭
        </button>
      </div>
      <div className="review-scrubber__status">
        <span className="review-scrubber__where">
          Turn {turn} · action {at} of {total}
        </span>
        <button type="button" className="btn btn--primary" onClick={onPlayFromHere}>
          {atEnd ? 'Take over from here' : 'Fork and play from here'}
        </button>
      </div>
    </div>
  );
}
