/**
 * VISUAL-EFFECTS CUES (pure, DOM-free, unit-tested) — §3.131, the third of the
 * "vfx, animations, and sfx" ask. Same shape as `sound-cues.ts` and
 * `animations.ts`: game events in, effect cues out, decided in one TABLE. The
 * DOM half (`VfxLayer`) only positions and times the bloom; WHAT plays, WHERE,
 * is decided here where a test can pin it.
 *
 * ## Three shapes, positioned three ways
 * - `flash`  — a full-screen tint. Life changes for the VIEWER only: a
 *   whole-screen green/red is about YOUR life, not a readout of everyone's.
 * - `flare`  — a glow at a SEAT's board (a spell being cast, a token entering).
 * - `burst`  — a particle spray at a TILE (damage on a creature, a death). The
 *   layer reuses the same last-known tile rect the death ghost does, so a burst
 *   still lands where a creature stood the instant it dies.
 *
 * ## Coalescing (why a wrath is not a strobe)
 * Screen flashes collapse to one per batch (position is constant); tile bursts
 * at DISTINCT tiles are kept, because a board wipe reads as several poofs at the
 * places creatures stood, then the whole batch is capped.
 *
 * ## Reduced motion
 * Honored at the source, like the zone-flight layer: `reducedMotion` derives
 * nothing, so no effect is ever mounted. The frames and badges that carry the
 * same facts without motion (board-clarity.css) stay.
 */
import type { GameEvent, InstanceId, PlayerId } from '@jonny-boi/core';
import { VFX_CONFIG } from './play-config.js';

/** The visual shapes the layer knows how to draw. */
export type VfxKind = 'flash' | 'flare' | 'burst';

/** The palette/behaviour a cue asks for, within its kind. */
export type VfxTone = 'gain' | 'loss' | 'cast' | 'damage' | 'death' | 'token';

/** Where an effect is drawn — a fact the pure layer decides, the DOM measures. */
export type VfxAt =
  | { readonly where: 'screen' }
  | { readonly where: 'board'; readonly seat: PlayerId }
  | { readonly where: 'tile'; readonly instanceId: InstanceId };

/** One transient visual effect the layer should play. */
export interface VfxCue {
  /** Stable key (absolute event index, plus a position tag for tile bursts). */
  readonly key: string;
  readonly kind: VfxKind;
  readonly tone: VfxTone;
  readonly at: VfxAt;
  /** How many effects precede this one in its batch (stagger slot). */
  readonly order: number;
}

/** What {@link deriveVfxCues} needs beside the events. */
export interface DeriveVfxOptions {
  /** The user asked for reduced motion — derive nothing at all. */
  readonly reducedMotion: boolean;
  /** Absolute index of `events[0]` in the full log, so keys never collide. */
  readonly startIndex: number;
  /** The seat these effects are FOR — decides which life flashes fill the screen. */
  readonly viewer: PlayerId;
}

/** A row resolves an event (plus the viewer) to a cue, or `undefined` for none. */
type VfxResolver = (event: GameEvent, viewer: PlayerId) => Omit<VfxCue, 'key' | 'order'> | undefined;

/**
 * THE TABLE — event type → visual effect. Silent by default: only the handful of
 * moments that carry real weight get a bloom, so the board never strobes.
 */
const VFX_FOR_EVENT: Partial<Record<GameEvent['type'], VfxResolver>> = Object.freeze({
  // Your life swinging fills the screen; the sign picks the colour. The
  // opponent's life change is told by their number, not a flash of your screen.
  lifeChanged: (event, viewer) =>
    event.type === 'lifeChanged' && event.player === viewer && event.delta !== 0
      ? { kind: 'flash', tone: event.delta > 0 ? 'gain' : 'loss', at: { where: 'screen' } }
      : undefined,
  // A spell leaving the hand glows at its caster's board.
  spellCast: (event) =>
    event.type === 'spellCast' ? { kind: 'flare', tone: 'cast', at: { where: 'board', seat: event.player } } : undefined,
  // A token entering shimmers at its controller's board.
  tokenCreated: (event) =>
    event.type === 'tokenCreated'
      ? { kind: 'flare', tone: 'token', at: { where: 'board', seat: event.controller } }
      : undefined,
  // Damage to a CREATURE bursts on that tile; damage to a player's face is told
  // by the defender's life flash instead (no tile to burst on).
  damageDealt: (event) =>
    event.type === 'damageDealt' && typeof event.target === 'number'
      ? { kind: 'burst', tone: 'damage', at: { where: 'tile', instanceId: event.target } }
      : undefined,
  // A creature dying bursts where it stood (last-known tile rect).
  creatureDied: (event) =>
    event.type === 'creatureDied' ? { kind: 'burst', tone: 'death', at: { where: 'tile', instanceId: event.instanceId } } : undefined,
});

/**
 * The (dx, dy) each burst particle is flung to — a ring in three reaches so the
 * spray is not a clean circle. Pure and shared, so the live layer and the
 * preview bench (§3.132) draw the identical burst.
 */
export function burstParticleOffsets(count: number): readonly { readonly dx: number; readonly dy: number }[] {
  const out: { dx: number; dy: number }[] = [];
  for (let i = 0; i < count; i++) {
    const angle = (i / count) * Math.PI * 2;
    const reach = 18 + (i % 3) * 8;
    out.push({ dx: Math.cos(angle) * reach, dy: Math.sin(angle) * reach });
  }
  return out;
}

/** Shared empty result so a muted/silent/reduced frame allocates nothing. */
const NO_VFX: readonly VfxCue[] = Object.freeze([]);

/** A de-dup key so two flashes in one batch collapse but two tile bursts do not. */
function positionTag(at: VfxAt): string {
  return at.where === 'screen' ? 'screen' : at.where === 'board' ? `board:${at.seat}` : `tile:${at.instanceId}`;
}

/**
 * Fold a batch of freshly-appended events into the effects they earn. Effects at
 * the SAME place-and-kind coalesce to the first; the batch is then capped.
 */
export function deriveVfxCues(events: readonly GameEvent[], opts: DeriveVfxOptions): readonly VfxCue[] {
  if (opts.reducedMotion) return NO_VFX;
  const seen = new Set<string>();
  const out: VfxCue[] = [];
  for (let i = 0; i < events.length; i++) {
    const event = events[i] as GameEvent;
    const resolver = VFX_FOR_EVENT[event.type];
    if (resolver === undefined) continue;
    const base = resolver(event, opts.viewer);
    if (base === undefined) continue;
    const dedup = `${base.kind}:${base.tone}:${positionTag(base.at)}`;
    if (seen.has(dedup)) continue;
    seen.add(dedup);
    out.push({ ...base, key: `${opts.startIndex + i}:${positionTag(base.at)}`, order: out.length });
    if (out.length >= VFX_CONFIG.maxPerBatch) break;
  }
  return out.length > 0 ? out : NO_VFX;
}
