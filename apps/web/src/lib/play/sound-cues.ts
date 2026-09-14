/**
 * GAME-SOUND CUES (pure, DOM-free, unit-tested) — §3.130's procedural audio,
 * modeled exactly like `animations.ts`: game events in, sound-cue hits out. The
 * audio half (`sound-engine.ts`) only synthesizes and plays a cue id; WHICH cue
 * an event earns is decided HERE, where it is a table a test can pin.
 *
 * ## Why a table (rule 2)
 * Every row is `event type → cue`. Adding a sound for a new event is a ROW, not
 * a branch. A handful of rows need the viewer to decide the cue (life going up
 * vs down; the game ending in a win vs a loss), so a row is a small function of
 * the event and the viewer rather than a bare constant — still one row per
 * event, still closed: an event with no row makes no sound.
 *
 * ## Coalescing (why a batch is not a machine-gun)
 * One player action lands as a BATCH of events: a cast auto-taps five lands
 * (five `tapped`), a wrath kills a board (many `creatureDied`). Playing a cue
 * per event would be noise, so identical cues in one batch collapse to a single
 * hit, and the whole batch is then capped by {@link SOUND_CONFIG.maxPerBatch}.
 * The result is "tap … cast" for a spell and one impact for a combat, which is
 * how Arena reads.
 *
 * ## Reduced motion vs. muted
 * Sound is its own axis: `prefers-reduced-motion` silences MOTION, not audio,
 * so this reads `muted` (the persisted preference) rather than the motion flag.
 * Muted derives nothing at all, so no cue is ever scheduled.
 *
 * ## One hit, one clock (§3.143 GAP-11)
 * Most cues fire on the batch's own stagger. DAMAGE does not: the hit is DRAWN
 * travelling from its source to its recipient by {@link deriveDamageSequence},
 * and a thump at t=0 for a bloom that lands `DAMAGE_ANIM_CONFIG.travelMs` later
 * is two answers to "the damage landed" on two different clocks — the exact DRY
 * failure that `vfx-cues.ts` retired on the visual axis. So the damage cue is
 * derived from that SAME sequence and carries the impact moment with it, and
 * every cue now states WHEN it plays ({@link SoundCueHit.delayMs}) instead of
 * leaving the consumer to multiply an index by a stagger.
 */
import type { GameEvent, PlayerId } from '@jonny-boi/core';
import { deriveDamageSequence, type DamageBeat } from './damage-sequence.js';
import { SOUND_CONFIG } from './play-config.js';

/** The synthesizable cues. One per distinct sound the engine knows how to make. */
export type SoundCue =
  | 'land'
  | 'cast'
  | 'draw'
  | 'tap'
  | 'attack'
  | 'block'
  | 'damage'
  | 'death'
  | 'lifeGain'
  | 'lifeLoss'
  | 'resolve'
  | 'ability'
  | 'counter'
  | 'token'
  | 'turn'
  | 'reveal'
  | 'cycle'
  | 'transform'
  | 'victory'
  | 'defeat';

/** One scheduled sound: a stable key (for de-dup across renders) and its cue. */
export interface SoundCueHit {
  /** Absolute event index — React/render identity, and a natural de-dup key. */
  readonly key: string;
  readonly cue: SoundCue;
  /**
   * THE SCHEDULE: ms after this batch arrives that the cue should play. The one
   * answer to "when", so a consumer never re-derives it.
   *
   * Table cues sit on the batch's stagger grid; a damage cue sits on the damage
   * sequence's clock, at the moment its bloom lands.
   */
  readonly delayMs: number;
  /**
   * {@link delayMs} expressed as a whole stagger SLOT — `round(delayMs /
   * SOUND_CONFIG.staggerMs)`.
   *
   * Derived, never a second source of truth: it exists so a consumer still
   * scheduling by `order * staggerMs` (the shape this field had before it named
   * a slot rather than a count) lands within half a stagger of the right moment
   * instead of at t=0. Prefer {@link delayMs}. `sound-cues.test.ts` pins the two
   * in step so they cannot drift.
   */
  readonly order: number;
}

/** What {@link deriveSoundCues} needs beside the events. */
export interface DeriveSoundOptions {
  /** Audio is off — derive nothing at all (belt; the engine is the braces). */
  readonly muted: boolean;
  /** Absolute index of `events[0]` in the full log, so keys never collide. */
  readonly startIndex: number;
  /** The seat these sounds are FOR — decides gain/loss and win/loss cues. */
  readonly viewer: PlayerId;
}

/** A row resolves an event (plus the viewer) to a cue, or `undefined` for silence. */
type CueResolver = (event: GameEvent, viewer: PlayerId) => SoundCue | undefined;

/** A row that ignores the event and always plays one cue. */
const always =
  (cue: SoundCue): CueResolver =>
  () =>
    cue;

/**
 * THE TABLE — event type → cue. Everything not listed is deliberately silent
 * (priority passes, step begins, mana bookkeeping): a sound for every event is
 * a game that never stops beeping.
 *
 * Notes on the load-bearing rows:
 * - `tapped` carries the tap click; `manaAdded` is intentionally absent so a
 *   land tapping for mana clicks ONCE, not twice.
 * - `drawCard` plays only for the VIEWER — the opponent's draw is theirs, and
 *   silencing it keeps your own draw legible.
 * - `lifeChanged` splits on the delta's sign; `gainLife` is absent so a life
 *   swing sounds once (lifeChanged is the canonical total change).
 * - `gameOver` is the only win/loss sound; `playerLost` is absent so the end
 *   plays a single sting.
 */
const SOUND_CUE_FOR_EVENT: Partial<Record<GameEvent['type'], CueResolver>> = Object.freeze({
  landPlayed: always('land'),
  spellCast: always('cast'),
  drawCard: (event, viewer) => (event.type === 'drawCard' && event.player === viewer ? 'draw' : undefined),
  tapped: always('tap'),
  attackersDeclared: always('attack'),
  blockersDeclared: always('block'),
  // ⚠️ NO `damageDealt` ROW — deliberately, and this comment is the reason.
  // It used to be `always('damage')`, which fires at t=0, `travelMs` BEFORE the
  // hit it is the sound of blooms on screen. The cue was RELOCATED, not deleted:
  // `appendDamageCues` below emits the identical `damage` cue once per damage
  // ROUND, at that round's first impact, from the same fold that draws the hit.
  // One event, one timeline — and as a bonus the two rounds of a first-strike
  // combat now thump twice, which is the audible half of GAP-12.
  creatureDied: always('death'),
  planeswalkerDied: always('death'),
  lifeChanged: (event) =>
    event.type === 'lifeChanged' ? (event.delta > 0 ? 'lifeGain' : event.delta < 0 ? 'lifeLoss' : undefined) : undefined,
  stackResolved: always('resolve'),
  abilityActivated: always('ability'),
  counterAdded: always('counter'),
  tokenCreated: always('token'),
  turnBegin: always('turn'),
  cardRevealed: always('reveal'),
  cardCycled: always('cycle'),
  transformed: always('transform'),
  gameOver: (event, viewer) =>
    event.type === 'gameOver' ? (event.winner === null ? undefined : event.winner === viewer ? 'victory' : 'defeat') : undefined,
});

/** Shared empty result so a muted or silent frame allocates nothing. */
const NO_CUES: readonly SoundCueHit[] = Object.freeze([]);

/** Is this the event that carries a hit? (The trigger for the damage cues.) */
function isDamageEvent(event: GameEvent): boolean {
  return event.type === 'damageDealt' || event.type === 'damagePrevented';
}

/**
 * The stagger SLOT a delay falls in — see {@link SoundCueHit.order}. Rounded
 * rather than floored so a delay lands on the nearer slot, which is what makes
 * the fallback schedule within half a stagger of {@link SoundCueHit.delayMs}
 * rather than up to a whole one early.
 */
function slotOf(delayMs: number): number {
  return Math.round(delayMs / SOUND_CONFIG.staggerMs);
}

/** Mint a hit from the one number that decides when it plays. */
function hitAt(key: string, cue: SoundCue, delayMs: number): SoundCueHit {
  return { key, cue, delayMs, order: slotOf(delayMs) };
}

/**
 * One `damage` cue per damage ROUND, each at that round's first IMPACT — the
 * moment `DamageLayer` blooms, not the moment the event arrived.
 *
 * Per round rather than per hit for the reason the whole module coalesces: a
 * board-wide combat is one impact, not fourteen. Per round rather than per BATCH
 * because the rounds are the thing the player is meant to be able to tell apart
 * (CR 510.4) — a first-strike combat should sound like two beats.
 *
 * The sequence is derived with `reducedMotion: false` on purpose: this asks
 * *when the hits land*, which is a fact about the combat, not about whether the
 * layer draws it. Sound is its own axis (see the module doc), so suppressing
 * motion must not suppress — or re-time — the impact.
 */
function appendDamageCues(out: SoundCueHit[], events: readonly GameEvent[], opts: DeriveSoundOptions): void {
  const beats = deriveDamageSequence(events, { reducedMotion: false, startIndex: opts.startIndex });
  const firstOfRound = new Map<number, DamageBeat>();
  for (const beat of beats) if (!firstOfRound.has(beat.roundIndex)) firstOfRound.set(beat.roundIndex, beat);
  for (const beat of firstOfRound.values()) {
    // `travelMs` is 0 on a condensed beat, which blooms where it starts.
    out.push(hitAt(`dmg:${beat.key}`, 'damage', beat.startMs + beat.travelMs));
  }
}

/**
 * Fold a batch of freshly-appended events into the sound cues they earn.
 * Identical cues coalesce to the first occurrence, then the batch is capped.
 *
 * The damage cues are spliced in at the FIRST damage event, so the returned list
 * stays in event order and the cap keeps cutting from the tail — a combat's own
 * impact is never the cue that a busy batch drops.
 */
export function deriveSoundCues(events: readonly GameEvent[], opts: DeriveSoundOptions): readonly SoundCueHit[] {
  if (opts.muted) return NO_CUES;
  const seen = new Set<SoundCue>();
  const out: SoundCueHit[] = [];
  let slot = 0;
  let damageDone = false;
  for (let i = 0; i < events.length; i++) {
    const event = events[i] as GameEvent;
    if (!damageDone && isDamageEvent(event)) {
      damageDone = true;
      appendDamageCues(out, events, opts);
      if (out.length >= SOUND_CONFIG.maxPerBatch) break;
    }
    const resolver = SOUND_CUE_FOR_EVENT[event.type];
    if (resolver === undefined) continue;
    const cue = resolver(event, opts.viewer);
    if (cue === undefined || seen.has(cue)) continue;
    seen.add(cue);
    out.push(hitAt(`${opts.startIndex + i}`, cue, slot * SOUND_CONFIG.staggerMs));
    slot += 1;
    if (out.length >= SOUND_CONFIG.maxPerBatch) break;
  }
  return out.length > 0 ? out.slice(0, SOUND_CONFIG.maxPerBatch) : NO_CUES;
}

/** Every cue the table can emit — for the debug preview and exhaustive tests. */
export const ALL_SOUND_CUES: readonly SoundCue[] = Object.freeze([
  'land',
  'cast',
  'draw',
  'tap',
  'attack',
  'block',
  'damage',
  'death',
  'lifeGain',
  'lifeLoss',
  'resolve',
  'ability',
  'counter',
  'token',
  'turn',
  'reveal',
  'cycle',
  'transform',
  'victory',
  'defeat',
]);
