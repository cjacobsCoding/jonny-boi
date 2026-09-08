import { useEffect, useRef, useState, type ReactElement } from 'react';
import type { GameAction, InstanceId, PlayerId } from '@jonny-boi/core';
import {
  describeNote,
  describeOpponentActions,
  type OpponentActionNote,
} from '../../lib/play/opponent-actions.js';
import { OPPONENT_FEED_CONFIG } from '../../lib/play/play-config.js';
import './opponent-feed.css';

/**
 * "WHAT THE COMPUTER JUST DID" (§3.133) — the DOM half of `opponent-actions.ts`.
 *
 * Reported: "the computer plays instant and sorcery spells and I have no idea
 * what they played… what they are targeting". Everything needed was already on
 * screen and already GONE: the Solo board auto-passes, so an AI instant is cast
 * and resolved in one burst and the stack panel that would have named it may
 * never render. This holds each opponent play on screen for
 * {@link OPPONENT_FEED_CONFIG.holdMs} after the fact, naming the spell AND what
 * it pointed at.
 *
 * Baselined at mount like the animation and sound layers, so opening a board
 * mid-game (or resuming one) never replays a whole turn's worth of history.
 */
export function useOpponentFeed(
  actions: readonly GameAction[],
  viewer: PlayerId,
  label: (ref: InstanceId | PlayerId) => string,
): readonly OpponentActionNote[] {
  const [notes, setNotes] = useState<readonly OpponentActionNote[]>([]);
  const seen = useRef<number>(actions.length);

  useEffect(() => {
    if (actions.length <= seen.current) {
      seen.current = actions.length; // a rematch's shorter list: re-baseline
      return;
    }
    const startIndex = seen.current;
    const fresh = actions.slice(startIndex);
    seen.current = actions.length;
    const derived = describeOpponentActions(fresh, { viewer, startIndex, label });
    if (derived.length === 0) return;
    setNotes((current) => [...current, ...derived].slice(-OPPONENT_FEED_CONFIG.maxShown));
    // Each note retires on its own timer, so a burst fades one by one rather
    // than the whole feed blinking out together.
    const keys = derived.map((n) => n.key);
    const timer = window.setTimeout(
      () => setNotes((current) => current.filter((n) => !keys.includes(n.key))),
      OPPONENT_FEED_CONFIG.holdMs,
    );
    return () => window.clearTimeout(timer);
    // `label` is a real dependency, which is safe: it changes with the session,
    // and a run where no action was appended hits the re-baseline branch above
    // and announces nothing. The caller memoizes it so this stays cheap.
  }, [actions, viewer, label]);

  return notes;
}

/** The feed itself: the opponent's recent plays, newest last, with their targets. */
export function OpponentActionFeed({
  notes,
  opponentName,
}: {
  notes: readonly OpponentActionNote[];
  opponentName: string;
}): ReactElement | null {
  if (notes.length === 0) return null;
  return (
    <div className="opp-feed" role="status" aria-live="polite" aria-label={`What ${opponentName} just did`}>
      {notes.map((note) => (
        <div key={note.key} className="opp-feed__note">
          <span className="opp-feed__who">{opponentName}</span>
          <span className="opp-feed__what">{describeNote(note)}</span>
        </div>
      ))}
    </div>
  );
}
