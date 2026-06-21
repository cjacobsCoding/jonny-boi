import { useMemo, useRef, useEffect, type ReactElement } from 'react';
import type { PlayerId } from '@jonny-boi/core';
import type { MatchTrace, ReplayFrame, ReplaySide } from '../../lib/replay-types.js';
import { describeEvent, type LogLine } from '../../lib/replay-format.js';
import { findKeyMoments } from '../../lib/replay-fold.js';
import { PermanentTile } from './PermanentTile.js';
import { PlaybackControls } from './PlaybackControls.js';
import { useReplayPlayback } from './useReplayPlayback.js';

const SEAT_ORDER: readonly PlayerId[] = ['B', 'A']; // opponent on top, hero below

/** Human label for a turn step (e.g. "precombatMain" → "Main 1"). */
const STEP_LABELS: Readonly<Record<string, string>> = {
  untap: 'Untap',
  upkeep: 'Upkeep',
  draw: 'Draw',
  precombatMain: 'Main 1',
  beginCombat: 'Combat',
  declareAttackers: 'Attackers',
  declareBlockers: 'Blockers',
  combatDamage: 'Combat damage',
  endCombat: 'End combat',
  postcombatMain: 'Main 2',
  end: 'End step',
  cleanup: 'Cleanup',
};

/**
 * The match-replay surface: a transport bar over the frames, both players' panels
 * (life, hand/library/graveyard counts, and the board with effective P/T + tapped
 * state), an outcome banner, and a scrolling event log up to the current frame.
 *
 * The frames (worker snapshots) are authoritative for the board; the log is folded
 * from the event log via the shared `describeEvent` formatter (DRY). Highlights
 * come from `findKeyMoments` over the same log.
 */
export function MatchReplay({ trace }: { trace: MatchTrace }): ReactElement {
  const playback = useReplayPlayback(trace.frames.length);
  const frame: ReplayFrame | undefined = trace.frames[playback.index];

  const nameOf = useMemo(
    () => (id: number) => trace.names[id] ?? `#${id}`,
    [trace.names],
  );

  const keyMoments = useMemo(() => findKeyMoments(trace.events), [trace.events]);

  // The log: every describable event up to (and including) this frame's event
  // index, newest last. Recomputed on scrub — cheap for a single game's log.
  const logLines = useMemo(() => {
    const upTo = frame ? frame.eventIndex : -1;
    const lines: Array<LogLine & { index: number }> = [];
    for (let i = 0; i <= upTo && i < trace.events.length; i++) {
      const line = describeEvent(trace.events[i]!, nameOf);
      if (line) lines.push({ ...line, index: i });
    }
    return lines;
  }, [frame, trace.events, nameOf]);

  // Keep the log scrolled to the latest line as it advances.
  const logRef = useRef<HTMLOListElement | null>(null);
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [logLines.length]);

  if (!frame) {
    return <p className="lab-placeholder">This game produced no frames to replay.</p>;
  }

  const stepLabel = STEP_LABELS[frame.step] ?? frame.step;

  return (
    <div className="replay">
      <div className="replay-statusbar">
        <span className="replay-turn">
          Turn {frame.turn} · {stepLabel}
        </span>
        <span className="replay-active">
          Active: {trace.seats[frame.activePlayer].deckName}
        </span>
        {frame.stackSize > 0 && (
          <span className="replay-stack">Stack: {frame.stackSize}</span>
        )}
        {frame.gameOver && (
          <span className="replay-status replay-status--over">
            {frame.winner
              ? `${trace.seats[frame.winner].deckName} wins`
              : 'Draw'}
          </span>
        )}
      </div>

      <PlaybackControls
        playback={playback}
        frameCount={trace.frames.length}
        keyMoments={keyMoments}
        frameEventIndex={(f) => trace.frames[f]?.eventIndex ?? -1}
      />

      <div className="replay-table">
        {SEAT_ORDER.map((player) => (
          <SidePanel
            key={player}
            player={player}
            deckName={trace.seats[player].deckName}
            pilot={trace.seats[player].pilot}
            side={frame.sides[player]}
            active={frame.activePlayer === player}
            winner={frame.gameOver ? frame.winner : null}
          />
        ))}
      </div>

      <div className="replay-log-wrap">
        <h4 className="replay-log-title">Event log</h4>
        <ol className="replay-log" ref={logRef}>
          {logLines.length === 0 ? (
            <li className="replay-log__empty">Press play or step forward to watch the game.</li>
          ) : (
            logLines.map((line) => (
              <li
                key={line.index}
                className={`replay-log__line${line.tone ? ` replay-log__line--${line.tone}` : ''}`}
              >
                {line.text}
              </li>
            ))
          )}
        </ol>
      </div>

      {trace.truncated && (
        <p className="lab-hint">
          This game was long — the replay shows the first {trace.events.length.toLocaleString()}{' '}
          events and stops there.
        </p>
      )}
    </div>
  );
}

/** One player's panel: identity, life, zone counts, and the board. */
function SidePanel({
  player,
  deckName,
  pilot,
  side,
  active,
  winner,
}: {
  player: PlayerId;
  deckName: string;
  pilot: string;
  side: ReplaySide;
  active: boolean;
  winner: PlayerId | null;
}): ReactElement {
  const lowLife = side.life <= 5;
  const isWinner = winner === player;
  return (
    <div className={`replay-side${active ? ' replay-side--active' : ''}`}>
      <div className="replay-side__head">
        <div className="replay-side__id">
          <span className="replay-side__seat">Player {player}</span>
          <span className="replay-side__deck" title={deckName}>
            {deckName}
          </span>
          <span className="replay-side__pilot">{pilot}</span>
        </div>
        <div className={`replay-life${lowLife ? ' replay-life--low' : ''}`} aria-label={`${side.life} life`}>
          {side.life}
          {isWinner && <span className="replay-life__crown" aria-label="winner"> 👑</span>}
        </div>
      </div>

      <div className="replay-side__zones">
        <span>Hand {side.handCount}</span>
        <span>Library {side.libraryCount}</span>
        <span>Grave {side.graveyardCount}</span>
      </div>

      <div className="replay-board">
        {side.board.length === 0 ? (
          <span className="replay-board__empty">No permanents</span>
        ) : (
          side.board.map((perm) => <PermanentTile key={perm.instanceId} permanent={perm} />)
        )}
      </div>
    </div>
  );
}
