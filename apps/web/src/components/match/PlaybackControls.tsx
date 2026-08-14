import type { ReactElement } from 'react';
import { PLAYBACK_SPEEDS } from '../../lib/replay-config.js';
import type { ReplayPlayback } from './useReplayPlayback.js';
import type { KeyMoment } from '../../lib/replay-fold.js';

/**
 * The transport bar: restart / step-back / play-pause / step-forward, a speed
 * selector (named `replay-config` speeds), and a scrubber over the frames with key
 * moments marked. All timing is owned by the playback hook — this is pure UI.
 */
export function PlaybackControls({
  playback,
  frameCount,
  keyMoments,
  frameEventIndex,
}: {
  playback: ReplayPlayback;
  frameCount: number;
  keyMoments: readonly KeyMoment[];
  /** Maps a key moment's event index to the frame that first reflects it. */
  frameEventIndex: (frame: number) => number;
}): ReactElement {
  const lastFrame = Math.max(0, frameCount - 1);

  // Place each key-moment marker by finding the first frame whose event index is
  // at or past the moment, as a fraction of the timeline.
  const markers = keyMoments.map((m) => {
    let frame = 0;
    for (let f = 0; f <= lastFrame; f++) {
      if (frameEventIndex(f) >= m.eventIndex) {
        frame = f;
        break;
      }
      frame = f;
    }
    return { ...m, fraction: lastFrame > 0 ? frame / lastFrame : 0 };
  });

  return (
    <div className="replay-transport">
      <div className="replay-buttons">
        <button
          type="button"
          className="btn"
          onClick={playback.restart}
          disabled={playback.atStart && !playback.playing}
          aria-label="Restart"
          title="Restart"
        >
          ⏮
        </button>
        <button
          type="button"
          className="btn"
          onClick={playback.stepBack}
          disabled={playback.atStart}
          aria-label="Step back"
          title="Step back"
        >
          ◀
        </button>
        <button
          type="button"
          className="btn btn--primary replay-play"
          onClick={playback.toggle}
          disabled={frameCount === 0 || (playback.atEnd && !playback.playing)}
          aria-label={playback.playing ? 'Pause' : 'Play'}
          title={playback.playing ? 'Pause' : 'Play'}
        >
          {playback.playing ? '⏸' : '▶'}
        </button>
        <button
          type="button"
          className="btn"
          onClick={playback.stepForward}
          disabled={playback.atEnd}
          aria-label="Step forward"
          title="Step forward"
        >
          ▶
        </button>

        <div className="replay-speeds" role="group" aria-label="Playback speed">
          {PLAYBACK_SPEEDS.map((speed) => (
            <button
              key={speed.id}
              type="button"
              className={`chip${playback.speedId === speed.id ? ' chip--active' : ''}`}
              aria-pressed={playback.speedId === speed.id}
              onClick={() => playback.setSpeed(speed.id)}
            >
              {speed.label}
            </button>
          ))}
        </div>

        <label className="replay-skip-toggle" title="Jump straight to the next frame where something actually happens, instead of stopping on every priority pass.">
          <input
            type="checkbox"
            checked={playback.skipQuiet}
            onChange={(event) => playback.setSkipQuiet(event.target.checked)}
          />
          Skip quiet phases
        </label>
      </div>

      <div className="replay-scrub">
        <div className="replay-scrub__markers" aria-hidden="true">
          {markers.map((m, i) => (
            <span
              key={`${m.eventIndex}-${i}`}
              className={`replay-marker replay-marker--${m.kind}`}
              style={{ left: `${m.fraction * 100}%` }}
              title={m.label}
            />
          ))}
        </div>
        <input
          type="range"
          min={0}
          max={lastFrame}
          step={1}
          value={playback.index}
          onChange={(e) => playback.seek(Number(e.target.value))}
          aria-label="Replay position"
          className="replay-range"
        />
        <span className="replay-scrub__count">
          {playback.index + 1} / {frameCount}
        </span>
      </div>
    </div>
  );
}
