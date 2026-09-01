/**
 * THE GAME LIBRARY list (§3.66) — every game played, resumable, deletable, and
 * visibly connected to the playthroughs it was forked from.
 *
 * Presentational only: it renders rows a pure module already decided
 * (`lib/play/library-view.ts`), so what the list SAYS is unit-tested and this
 * file is just the markup.
 */
import type { ReactElement } from 'react';
import type { LibraryRow } from '../../lib/play/library-view.js';
import './game-library.css';

/** How long ago, in the same voice the resume banner uses. */
function ago(when: number, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - when) / 1000));
  if (seconds < 60) return 'moments ago';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

export function GameLibrary({
  rows,
  onResume,
  onDelete,
}: {
  readonly rows: readonly LibraryRow[];
  readonly onResume: (id: string) => void;
  readonly onDelete: (id: string) => void;
}): ReactElement | null {
  if (rows.length === 0) return null;

  return (
    <section className="game-library" aria-label="Game library">
      <h3 className="game-library__title">Your games</h3>
      <ul className="game-library__list">
        {rows.map((row) => (
          <li
            key={row.id}
            className={`game-library__row${row.resumable ? ' game-library__row--live' : ''}`}
            /* Indenting by fork depth IS the "which are forks of each other"
               affordance: a fork sits under the game it came from. Capped so a
               long chain cannot indent itself off the edge of a phone. */
            style={{ marginLeft: `${Math.min(row.depth, 4) * 1.25}rem` }}
            data-root={row.rootId}
          >
            <div className="game-library__main">
              <span className="game-library__decks">{row.decks}</span>
              <span className="game-library__meta">
                {row.title} · {row.mode} · turn {row.turn} · {row.outcomeText} · {ago(row.updatedAt)}
              </span>
              {row.forkedFrom && (
                <span className="game-library__lineage" title={row.forkedFrom}>
                  ⑂ {row.forkedFrom}
                </span>
              )}
              {row.forkCount > 0 && (
                <span className="game-library__lineage">
                  {row.forkCount} fork{row.forkCount === 1 ? '' : 's'} from this game
                </span>
              )}
            </div>
            <div className="game-library__actions">
              {row.resumable && (
                <button type="button" className="btn" onClick={() => onResume(row.id)}>
                  Resume
                </button>
              )}
              <button
                type="button"
                className="btn btn--ghost"
                onClick={() => onDelete(row.id)}
                aria-label={`Delete ${row.decks}, ${row.outcomeText}`}
              >
                Delete
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
