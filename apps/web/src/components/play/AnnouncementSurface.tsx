/**
 * THE ONE ANNOUNCEMENT SURFACE — every announcer paints here, one at a time.
 *
 * Caleb: *"we are getting some overriding overlays in app that look bad - like
 * 'heres what goblin guide revealed from your library' and 'heres what the
 * computer casted' - those should reconcile somehow"*.
 *
 * The rule is `lib/play/announcements.ts`; this is only its screen. It mounts
 * the HEAD of the queue and nothing else, so two announcements can no longer be
 * on the board at the same moment — which is the whole of the reported defect.
 *
 * ## ⚠️ WHAT WAITS IS SHOWN, because a dropped announcement is the same bug
 *
 * The queue's waiters are counted on the strip. That is not decoration: this
 * branch has spent ten items on things that were correct and never seen, and an
 * announcement silently swallowed by a higher-ranked one would be the eleventh.
 * A player who sees *"+1 waiting"* knows something else is coming; a player who
 * sees nothing assumes the game said nothing.
 *
 * ## The renderers are a MAPPED TYPE, and that is the class guard
 *
 * {@link AnnouncementRenderers} is `{ [K in AnnouncementKind]: … }`, so a fifth
 * announcement added to `AnnouncementBody` fails to compile at EVERY mount site
 * until somebody says how it is drawn — the same device that makes
 * `FORCED_CHOICE_KINDS` un-skippable. A hand-rolled fifth banner that never
 * becomes a body is caught instead by `announcement-queue.test.ts`, which
 * derives the list of fixed overlays from the stylesheets.
 */
import type { ReactElement } from 'react';
import {
  ANNOUNCEMENT_KINDS,
  announcementId,
  type AnnouncementBodyOf,
  type AnnouncementKind,
  type AnnouncementQueue,
} from '../../lib/play/announcements.js';
/**
 * The surface's own rules live beside the rest of the play chrome. Imported
 * HERE rather than left to the mounting board, so the surface carries its
 * appearance onto any board that mounts it — `CombatHoldBanner` records why
 * (the online board has no `.board-scene` and nothing else pulls this in).
 */
import './board-scene.css';

/** How each kind of announcement is drawn. One entry per row of the table. */
export type AnnouncementRenderers = {
  readonly [K in AnnouncementKind]: (body: AnnouncementBodyOf<K>) => ReactElement;
};

export function AnnouncementSurface({
  queue,
  renderers,
}: {
  readonly queue: AnnouncementQueue;
  readonly renderers: AnnouncementRenderers;
}): ReactElement | null {
  const showing = queue.showing;
  if (showing === null) return null;
  const row = ANNOUNCEMENT_KINDS[showing.kind];
  /*
   * The single cast, in the single place — the mirror of
   * `announcementDurationMs`'s. `renderers[showing.kind]` cannot narrow its own
   * argument for the compiler, but the map was BUILT from the same mapped type
   * that produced the body, so the call is sound by construction.
   */
  const draw = renderers[showing.kind] as (body: typeof showing) => ReactElement;
  const waiting = queue.waiting.length;
  return (
    <div
      className={`announce announce--${row.slot}`}
      /*
       * ⚠️ NO `role` AND NO `aria-live` HERE, deliberately. Every body already
       * carries `role="status"` `aria-live="polite"`, and a live region wrapping
       * a live region announces the same sentence twice. The scar the three
       * bodies all record still applies to this element: `role="dialog"` on a
       * timed announcement told `verify-game-resume.mjs` the game had parked a
       * question, and a 2.4-second strip is not something a reload can restore.
       */
      data-announce-kind={showing.kind}
    >
      {/* Keyed by the announcement's own identity so the surface replays its
          entrance for a genuinely NEW announcement and not for every render of
          the board around it. */}
      <div className="announce__body" key={announcementId(showing)}>
        {draw(showing)}
      </div>
      {waiting > 0 && (
        <span className="announce__waiting">
          +{waiting} waiting
        </span>
      )}
    </div>
  );
}
