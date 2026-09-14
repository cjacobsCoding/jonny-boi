/**
 * ZONE-CHANGE ANIMATION DESCRIPTORS (pure, DOM-free, unit-tested) — §3.57's
 * "I can't tell if a card was drawn" fix, modeled as a fold over the event log:
 * game events in → animation descriptors out. The DOM half (`AnimationLayer`)
 * only positions and times sprites; WHAT animates is decided here, where it can
 * be tested.
 *
 * ## What animates (scoped deliberately)
 * - `drawCard`            → a card BACK flying library → hand (both seats).
 * - zoneChange lib→grave  → a mill: the card's face flying library → graveyard.
 * - zoneChange hand→grave → a discard: the face flying hand → graveyard.
 * - zoneChange battlefield→graveyard/exile → a death/removal: the tile's ghost
 *   fading and shrinking where it stood — HELD, when `deathHoldMsFor` says so,
 *   until the damage that killed it has visibly landed (UX-15, §3.143).
 *
 * ## Hidden information
 * A DRAW descriptor deliberately carries NO card identity — not for the
 * opponent (whose draw is secret) and not for the viewer either: the sprite is
 * a card back, and the hand it lands in shows the card. Mill, discard and
 * death identities are public by the time the event exists (the card is in a
 * public zone), and even then the identity comes from the caller's `lookup`,
 * which both boards build from PUBLIC zones only.
 *
 * ## Reduced motion
 * `prefers-reduced-motion` is respected at the SOURCE: with `reducedMotion`
 * set, this returns nothing at all, so no sprite is ever mounted (belt) — and
 * the CSS kills transitions besides (braces).
 */
import type { GameEvent, InstanceId, PlayerId } from '@jonny-boi/core';
import { ANIMATION_CONFIG } from './play-config.js';

/**
 * THE SEAT-ANCHOR TABLE — the `data-anim-anchor` names a seat publishes, named
 * ONCE (§3.143 GAP-13).
 *
 * Every anchor is a contract between a component that PUBLISHES it and one or
 * more overlays that MEASURE it, spelled as a template literal at each end. That
 * is two places answering "what is this anchor called" (rule 12), and it already
 * cost the overhaul a real defect: the damage layer and the combat arcs both
 * aimed at `life:<seat>`, `SeatPanel` published no such element, and face damage
 * silently fell back to the defender's creature row — so an attack "on a player"
 * pointed at their creatures. Nothing could fail, because nothing named the
 * anchor in a place a test could reach.
 *
 * Adding an anchor is a ROW. A kind not in the table does not exist, which is
 * what makes `anchor-adoption.test.ts` able to check publisher against reader.
 */
export const SEAT_ANCHOR_NAMES = Object.freeze({
  /** The life total. What damage to a player, and an attack on a player, aim at. */
  life: 'life',
  /** The hand COUNT chip in the zone rail (not the hand itself — see `hand`). */
  handCount: 'hand-count',
  library: 'library',
  graveyard: 'graveyard',
  /** The creature row — where a permanent-flavoured effect blooms. */
  board: 'board',
  /** The rendered hand region, published by the board rather than the seat panel. */
  hand: 'hand',
});

/** One anchor kind (see {@link SEAT_ANCHOR_NAMES}). */
export type SeatAnchorKind = keyof typeof SEAT_ANCHOR_NAMES;

/**
 * The `data-anim-anchor` value for one seat's anchor — the ONE spelling, used
 * by whoever publishes it and by whoever measures it.
 */
export function seatAnchor(kind: SeatAnchorKind, seat: PlayerId): string {
  return `${SEAT_ANCHOR_NAMES[kind]}:${seat}`;
}

/** The four scoped animation kinds (see the module doc). */
export type AnimationKind = 'draw' | 'mill' | 'discard' | 'death';

/** Public identity of a moved card, resolved by the caller from public zones. */
export interface AnimationCardInfo {
  readonly cardId: string;
  readonly name: string;
  /** Whose zone the card landed in (positions the sprite's endpoints). */
  readonly owner: PlayerId;
}

/** One transient sprite the animation layer should play. */
export interface AnimationDescriptor {
  /** Unique, stable key (absolute event index) — React list identity. */
  readonly key: string;
  readonly kind: AnimationKind;
  /** The seat whose zones the sprite flies between. */
  readonly seat: PlayerId;
  /** The moved instance (a death ghost is positioned by this id's last rect). */
  readonly instanceId: InstanceId;
  /** Face art for the PUBLIC moves; absent on a draw (see the module doc). */
  readonly cardId?: string;
  readonly name?: string;
  /** How many sprites precede this one in its batch (stagger slot). */
  readonly order: number;
  /**
   * Extra ms this sprite waits ON TOP of its stagger slot, so a death can be
   * held until the damage that caused it has visibly landed (UX-15). Absent
   * means 0; see {@link DeriveAnimationsOptions.deathHoldMsFor}.
   */
  readonly delayMs?: number;
}

/** What {@link deriveAnimations} needs beside the events. */
export interface DeriveAnimationsOptions {
  /** The user asked for reduced motion — derive nothing at all. */
  readonly reducedMotion: boolean;
  /**
   * Absolute index of `events[0]` in the session's full log. Keys are minted
   * from it, so two batches can never collide and a re-render cannot re-play.
   */
  readonly startIndex: number;
  /**
   * Resolve a moved card's PUBLIC identity (it just landed in a public zone).
   * Return `undefined` for anything unknown — that move simply doesn't animate,
   * which is the safe fallback (the log still tells the story).
   */
  readonly lookup: (id: InstanceId) => AnimationCardInfo | undefined;
  /**
   * How long this instance's DEATH must wait for the damage that killed it to
   * land, ms (UX-15). Omitted (or 0) means "vanish immediately", which is right
   * for a Doom Blade and wrong for a creature that just ate combat damage: a
   * ghost that fades while the hit is still in flight tells the player the
   * creature died of nothing.
   *
   * The number comes from `damage-sequence.damageHoldMsFor` — ONE clock shared
   * by the two layers rather than each guessing at the other's timings.
   */
  readonly deathHoldMsFor?: (instanceId: InstanceId) => number;
}

/**
 * Fold a batch of freshly-appended events into the sprites they earn. Order is
 * event order; the count is capped by `ANIMATION_CONFIG.maxPerBatch` (a wipe is
 * better told by the log than by twenty overlapping ghosts).
 */
export function deriveAnimations(
  events: readonly GameEvent[],
  opts: DeriveAnimationsOptions,
): readonly AnimationDescriptor[] {
  if (opts.reducedMotion) return NO_ANIMATIONS;
  const out: AnimationDescriptor[] = [];
  for (let i = 0; i < events.length; i++) {
    if (out.length >= ANIMATION_CONFIG.maxPerBatch) break;
    const event = events[i] as GameEvent;
    const descriptor = descriptorFor(event, `${opts.startIndex + i}`, out.length, opts);
    if (descriptor) out.push(descriptor);
  }
  return out;
}

/** Shared empty result so the common no-motion frame allocates nothing. */
const NO_ANIMATIONS: readonly AnimationDescriptor[] = Object.freeze([]);

/** The one-event rule table (see the module doc for the scoping rationale). */
function descriptorFor(
  event: GameEvent,
  key: string,
  order: number,
  opts: DeriveAnimationsOptions,
): AnimationDescriptor | undefined {
  if (event.type === 'drawCard') {
    // NO identity on purpose — a draw animates as a card back (hidden info).
    return { key, kind: 'draw', seat: event.player, instanceId: event.instanceId, order };
  }
  if (event.type !== 'zoneChange') return undefined;
  const kind = zoneMoveKind(event.from, event.to);
  if (kind === undefined) return undefined;
  const info = opts.lookup(event.instanceId);
  if (info === undefined) return undefined;
  // Only a DEATH waits: a mill or a discard has no hit in flight to wait for.
  const hold = kind === 'death' ? (opts.deathHoldMsFor?.(event.instanceId) ?? 0) : 0;
  return {
    key,
    kind,
    seat: info.owner,
    instanceId: event.instanceId,
    cardId: info.cardId,
    name: info.name,
    order,
    ...(hold > 0 ? { delayMs: hold } : {}),
  };
}

/** Which animation a zone move earns, if any. */
function zoneMoveKind(from: string, to: string): AnimationKind | undefined {
  if (from === 'library' && to === 'graveyard') return 'mill';
  if (from === 'hand' && to === 'graveyard') return 'discard';
  if (from === 'battlefield' && (to === 'graveyard' || to === 'exile')) return 'death';
  return undefined;
}
