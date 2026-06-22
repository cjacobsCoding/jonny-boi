import { useEffect, useRef, type ReactElement } from 'react';
import type { GameEvent } from '@jonny-boi/core';
import { describeEvents, type LogResolvers } from '../../lib/play/play-format.js';

/**
 * The running game log: the engine's event stream rendered through the shared
 * play-format formatter (DRY — one event→text source). Auto-scrolls to the newest
 * line. Bookkeeping events (priority/mana/untap) are filtered by the formatter.
 */
export function GameLog({
  events,
  resolvers,
}: {
  events: readonly GameEvent[];
  resolvers: LogResolvers;
}): ReactElement {
  const lines = describeEvents(events, resolvers);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [lines.length]);

  return (
    <div className="game-log" aria-label="Game log" aria-live="polite">
      <div className="game-log__title">Game Log</div>
      <div className="game-log__lines">
        {lines.length === 0 ? (
          <div className="game-log__empty">The game begins…</div>
        ) : (
          lines.map((line, i) => (
            <div key={i} className={`game-log__line${line.tone ? ` game-log__line--${line.tone}` : ''}`}>
              {line.text}
            </div>
          ))
        )}
        <div ref={endRef} />
      </div>
    </div>
  );
}
