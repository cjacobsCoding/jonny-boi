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
 */
import type { GameEvent, PlayerId } from '@jonny-boi/core';
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
  /** How many hits precede this one in its batch (the play stagger slot). */
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
  damageDealt: always('damage'),
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

/**
 * Fold a batch of freshly-appended events into the sound cues they earn.
 * Identical cues coalesce to the first occurrence, then the batch is capped.
 */
export function deriveSoundCues(events: readonly GameEvent[], opts: DeriveSoundOptions): readonly SoundCueHit[] {
  if (opts.muted) return NO_CUES;
  const seen = new Set<SoundCue>();
  const out: SoundCueHit[] = [];
  for (let i = 0; i < events.length; i++) {
    const event = events[i] as GameEvent;
    const resolver = SOUND_CUE_FOR_EVENT[event.type];
    if (resolver === undefined) continue;
    const cue = resolver(event, opts.viewer);
    if (cue === undefined || seen.has(cue)) continue;
    seen.add(cue);
    out.push({ key: `${opts.startIndex + i}`, cue, order: out.length });
    if (out.length >= SOUND_CONFIG.maxPerBatch) break;
  }
  return out.length > 0 ? out : NO_CUES;
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
