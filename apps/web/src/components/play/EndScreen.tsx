import type { ReactElement } from 'react';
import type { PlayerId } from '@jonny-boi/core';

/**
 * The game-over screen: announce the winner (or a draw), with Rematch (same decks +
 * a new seed) and New Game (back to setup). Reached when the engine sets `gameOver`.
 */
export function EndScreen({
  winner,
  names,
  reason,
  onRematch,
  onNewGame,
}: {
  winner: PlayerId | null;
  names: Readonly<Record<PlayerId, string>>;
  /** Optional concluding reason (e.g. "Player 2 ran out of life"). */
  reason?: string;
  onRematch: () => void;
  onNewGame: () => void;
}): ReactElement {
  return (
    <div className="play-end" role="dialog" aria-modal="true" aria-label="Game over">
      <div className="play-end__card">
        <div className="play-end__mark" aria-hidden="true">
          {winner ? '👑' : '🤝'}
        </div>
        <h2 className="play-end__title">{winner ? `${names[winner]} wins!` : 'The game is a draw'}</h2>
        {reason && <p className="play-end__reason">{reason}</p>}
        <div className="play-end__actions">
          <button type="button" className="btn btn--primary" onClick={onRematch}>
            Rematch (new seed)
          </button>
          <button type="button" className="btn" onClick={onNewGame}>
            New game
          </button>
        </div>
      </div>
    </div>
  );
}
