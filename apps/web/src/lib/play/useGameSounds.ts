/**
 * useGameSounds (§3.130) — the React glue between the session's event log and
 * the {@link SoundEngine}, modeled on `useZoneAnimations`: baseline at mount so
 * a board opening mid-game never replays history, then fold each freshly
 * appended batch into cues and play them, staggered so a batch reads as a short
 * phrase rather than a chord.
 *
 * The engine is owned by the caller (one per board, so a rematch keeps its
 * unlocked AudioContext); this hook only feeds it. Muting is honored at the
 * SOURCE — a muted derive yields nothing — and again in the engine, so toggling
 * off is instant and silent even mid-batch.
 */
import { useEffect, useRef } from 'react';
import type { GameEvent, PlayerId } from '@jonny-boi/core';
import { deriveSoundCues } from './sound-cues.js';
import { SOUND_CONFIG } from './play-config.js';
import type { SoundEngine } from './sound-engine.js';

export function useGameSounds(
  events: readonly GameEvent[],
  viewer: PlayerId,
  engine: SoundEngine,
  muted: boolean,
): void {
  // Baseline at mount: everything already logged happened before we listened.
  const seen = useRef<number>(events.length);

  useEffect(() => {
    if (events.length <= seen.current) {
      // A rematch swaps in a shorter log; re-baseline instead of replaying it.
      seen.current = events.length;
      return;
    }
    const startIndex = seen.current;
    const fresh = events.slice(startIndex);
    seen.current = events.length;
    // `muted` is a real dependency, which is safe: a mute-only change appends no
    // events, so this run hits the re-baseline branch above and plays nothing —
    // the toggle never replays history, it just changes what future batches do.
    const cues = deriveSoundCues(fresh, { muted, startIndex, viewer });
    if (cues.length === 0) return;
    const timers: number[] = [];
    for (const hit of cues) {
      if (hit.order === 0) {
        engine.play(hit.cue); // the first cue is immediate; only later ones stagger
        continue;
      }
      timers.push(window.setTimeout(() => engine.play(hit.cue), hit.order * SOUND_CONFIG.staggerMs));
    }
    return () => timers.forEach((t) => window.clearTimeout(t));
  }, [events, viewer, engine, muted]);
}
