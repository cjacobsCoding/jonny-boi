/**
 * THE PROCEDURAL SOUND ENGINE (§3.130) — synthesizes every {@link SoundCue}
 * with the Web Audio API. No audio FILES ship: each cue is a tiny recipe of
 * oscillators, gain envelopes and filtered noise, so the whole "rival MTGA"
 * soundscape costs zero bytes of assets and passes any asset CSP.
 *
 * ## Why a class, and why lazy
 * Browsers refuse to start an `AudioContext` before a user gesture, so the
 * context is created lazily on the first {@link play}/{@link resume} and, if it
 * comes up `suspended`, resumed. A cue that arrives before any gesture is simply
 * dropped (there is nothing to play into yet) — the NEXT one, after the player's
 * first click, is heard. Nothing here throws: a browser without Web Audio, or a
 * blocked context, degrades to silence, never to a crash.
 *
 * ## The recipe table (rule 2)
 * `RECIPES` is one row per cue — a function handed the context, the destination
 * gain and a start time. Adding a sound is a row here plus a member of
 * `SoundCue`. The numbers inside a recipe (a frequency, a decay) are named where
 * it aids reading, but a synth recipe is inherently a little bag of constants;
 * they are local to their one row and touch nothing else.
 */
import type { SoundCue } from './sound-cues.js';
import { SOUND_CONFIG } from './play-config.js';

/** A recipe schedules its sound from `t0` into `out` (already volume-scaled). */
type Recipe = (ctx: AudioContext, out: GainNode, t0: number) => void;

/** The smallest gain an exponential ramp may target (it cannot reach 0). */
const NEAR_ZERO = 0.0001;

/**
 * One oscillator with an attack/decay envelope — the workhorse. `glideTo` bends
 * the pitch across the life of the note (a downward glide reads as impact, an
 * upward one as a spark).
 */
function blip(
  ctx: AudioContext,
  out: GainNode,
  t0: number,
  {
    freq,
    type = 'sine',
    dur,
    peak,
    attack = 0.005,
    glideTo,
  }: { freq: number; type?: OscillatorType; dur: number; peak: number; attack?: number; glideTo?: number },
): void {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (glideTo !== undefined) osc.frequency.exponentialRampToValueAtTime(Math.max(glideTo, 1), t0 + dur);
  gain.gain.setValueAtTime(NEAR_ZERO, t0);
  gain.gain.linearRampToValueAtTime(peak, t0 + attack);
  gain.gain.exponentialRampToValueAtTime(NEAR_ZERO, t0 + dur);
  osc.connect(gain).connect(out);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

/** A short filtered-noise burst — riffles, impacts, whooshes. */
function noise(
  ctx: AudioContext,
  out: GainNode,
  t0: number,
  {
    dur,
    peak,
    type = 'bandpass',
    freq,
    q = 1,
    sweepTo,
  }: { dur: number; peak: number; type?: BiquadFilterType; freq: number; q?: number; sweepTo?: number },
): void {
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(ctx);
  const filter = ctx.createBiquadFilter();
  filter.type = type;
  filter.frequency.setValueAtTime(freq, t0);
  filter.Q.value = q;
  if (sweepTo !== undefined) filter.frequency.exponentialRampToValueAtTime(Math.max(sweepTo, 1), t0 + dur);
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(NEAR_ZERO, t0);
  gain.gain.linearRampToValueAtTime(peak, t0 + 0.006);
  gain.gain.exponentialRampToValueAtTime(NEAR_ZERO, t0 + dur);
  src.connect(filter).connect(gain).connect(out);
  src.start(t0);
  src.stop(t0 + dur + 0.02);
}

/** An ascending or descending arpeggio of `blip`s — chimes, stings. */
function arp(
  ctx: AudioContext,
  out: GainNode,
  t0: number,
  freqs: readonly number[],
  { step = 0.09, dur = 0.28, peak = 0.5, type = 'triangle' as OscillatorType } = {},
): void {
  freqs.forEach((freq, i) => blip(ctx, out, t0 + i * step, { freq, type, dur, peak }));
}

/** One reusable second of white noise — filtered per use, so one buffer serves all. */
let cachedNoise: AudioBuffer | undefined;
function noiseBuffer(ctx: AudioContext): AudioBuffer {
  if (cachedNoise) return cachedNoise;
  const buffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  cachedNoise = buffer;
  return buffer;
}

/** The recipe per cue. Frequencies are Hz; durations seconds; peaks 0..1. */
const RECIPES: Readonly<Record<SoundCue, Recipe>> = Object.freeze({
  // A card meeting the table: a low wooden thock plus a little edge noise.
  land: (ctx, out, t0) => {
    blip(ctx, out, t0, { freq: 150, glideTo: 90, type: 'sine', dur: 0.16, peak: 0.6 });
    noise(ctx, out, t0, { dur: 0.05, peak: 0.18, type: 'lowpass', freq: 1400 });
  },
  // A spell leaving the hand: an upward filtered whoosh with a sine sparkle.
  cast: (ctx, out, t0) => {
    noise(ctx, out, t0, { dur: 0.28, peak: 0.16, type: 'bandpass', freq: 500, q: 0.8, sweepTo: 3200 });
    blip(ctx, out, t0 + 0.02, { freq: 420, glideTo: 900, type: 'triangle', dur: 0.24, peak: 0.28 });
  },
  // Drawing a card: a quick paper riffle.
  draw: (ctx, out, t0) => noise(ctx, out, t0, { dur: 0.11, peak: 0.24, type: 'highpass', freq: 2200 }),
  // Tapping a permanent: a soft, short click.
  tap: (ctx, out, t0) => blip(ctx, out, t0, { freq: 1250, type: 'triangle', dur: 0.05, peak: 0.28 }),
  // Declaring attackers: a martial down-swept saw with a noise edge.
  attack: (ctx, out, t0) => {
    blip(ctx, out, t0, { freq: 320, glideTo: 150, type: 'sawtooth', dur: 0.22, peak: 0.32 });
    noise(ctx, out, t0, { dur: 0.14, peak: 0.14, type: 'bandpass', freq: 1800, sweepTo: 700 });
  },
  // Declaring blockers: a duller, lower two-tone thud (shields up).
  block: (ctx, out, t0) => {
    blip(ctx, out, t0, { freq: 220, type: 'square', dur: 0.12, peak: 0.22 });
    blip(ctx, out, t0 + 0.01, { freq: 165, type: 'square', dur: 0.16, peak: 0.2 });
  },
  // Damage landing: a punchy low sine plus a noise crack.
  damage: (ctx, out, t0) => {
    blip(ctx, out, t0, { freq: 180, glideTo: 70, type: 'sine', dur: 0.18, peak: 0.55 });
    noise(ctx, out, t0, { dur: 0.09, peak: 0.28, type: 'bandpass', freq: 2600, q: 0.6 });
  },
  // A creature dying: a longer descending minor fall.
  death: (ctx, out, t0) => blip(ctx, out, t0, { freq: 300, glideTo: 90, type: 'sawtooth', dur: 0.5, peak: 0.34 }),
  // Gaining life: a bright, pleasant rising third.
  lifeGain: (ctx, out, t0) => arp(ctx, out, t0, [523.25, 659.25], { step: 0.08, dur: 0.3, peak: 0.34, type: 'sine' }),
  // Losing life: a low, blunt descending pair.
  lifeLoss: (ctx, out, t0) => arp(ctx, out, t0, [200, 150], { step: 0.07, dur: 0.24, peak: 0.34, type: 'triangle' }),
  // A spell/ability resolving: a soft rounded pop.
  resolve: (ctx, out, t0) => blip(ctx, out, t0, { freq: 520, glideTo: 360, type: 'sine', dur: 0.12, peak: 0.24 }),
  // Activating an ability: a bright zap.
  ability: (ctx, out, t0) => blip(ctx, out, t0, { freq: 900, glideTo: 1500, type: 'square', dur: 0.1, peak: 0.2 }),
  // A counter going on: a tiny high tick.
  counter: (ctx, out, t0) => blip(ctx, out, t0, { freq: 1600, type: 'triangle', dur: 0.05, peak: 0.22 }),
  // A token appearing: a light three-note shimmer up.
  token: (ctx, out, t0) => arp(ctx, out, t0, [784, 988, 1319], { step: 0.05, dur: 0.16, peak: 0.2, type: 'sine' }),
  // A new turn: a calm two-note bell.
  turn: (ctx, out, t0) => arp(ctx, out, t0, [392, 587.33], { step: 0.12, dur: 0.5, peak: 0.28, type: 'sine' }),
  // A card revealed: a short rising sine.
  reveal: (ctx, out, t0) => blip(ctx, out, t0, { freq: 600, glideTo: 950, type: 'sine', dur: 0.16, peak: 0.2 }),
  // Cycling: a quick double blip.
  cycle: (ctx, out, t0) => arp(ctx, out, t0, [880, 1175], { step: 0.05, dur: 0.09, peak: 0.2, type: 'triangle' }),
  // Transforming: a sine gliss up then down.
  transform: (ctx, out, t0) => {
    blip(ctx, out, t0, { freq: 400, glideTo: 1100, type: 'sine', dur: 0.16, peak: 0.24 });
    blip(ctx, out, t0 + 0.14, { freq: 1100, glideTo: 500, type: 'sine', dur: 0.2, peak: 0.22 });
  },
  // Winning: a triumphant major triad up.
  victory: (ctx, out, t0) => arp(ctx, out, t0, [523.25, 659.25, 783.99, 1046.5], { step: 0.12, dur: 0.5, peak: 0.4, type: 'triangle' }),
  // Losing: a somber minor triad down.
  defeat: (ctx, out, t0) => arp(ctx, out, t0, [440, 349.23, 261.63], { step: 0.16, dur: 0.6, peak: 0.36, type: 'sine' }),
});

/**
 * Every cue the engine can actually synthesize (the recipe table's keys). The
 * `Record<SoundCue, Recipe>` type already makes `RECIPES` exhaustive at compile
 * time; exporting the keys lets a test assert the pure cue list and the preview
 * bench stay in lockstep with it, so a new cue can never ship with no sound.
 */
export const SYNTHESIZABLE_CUES: readonly SoundCue[] = Object.freeze(Object.keys(RECIPES) as SoundCue[]);

/**
 * A stateful, best-effort audio player. One instance per board; construct it
 * eagerly (cheap — no context yet) and call {@link play} on each cue. Enable
 * state and volume are settable live so the action-bar toggle takes effect
 * mid-game without a rebuild.
 */
export class SoundEngine {
  private ctx: AudioContext | undefined;
  private master: GainNode | undefined;
  private enabled: boolean;
  private volume: number;

  constructor(enabled: boolean = SOUND_CONFIG.defaultEnabled, volume: number = SOUND_CONFIG.defaultVolume) {
    this.enabled = enabled;
    this.volume = clamp01(volume);
  }

  /** Turn audio on/off live. Turning on from a user gesture also resumes the context. */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (enabled) void this.resume();
    else if (this.ctx && this.ctx.state === 'running') void this.ctx.suspend();
  }

  /** Set the master volume (0..1), applied immediately if the context exists. */
  setVolume(volume: number): void {
    this.volume = clamp01(volume);
    if (this.master && this.ctx) this.master.gain.setValueAtTime(this.volume, this.ctx.currentTime);
  }

  /**
   * Ensure the context exists and is running — call from a user gesture (a
   * button click) so the browser's autoplay policy is satisfied. Safe to call
   * repeatedly; never throws.
   */
  async resume(): Promise<void> {
    try {
      const ctx = this.ensureContext();
      if (ctx && ctx.state === 'suspended') await ctx.resume();
    } catch {
      /* audio unavailable — stay silent */
    }
  }

  /**
   * Play one cue now. A no-op when unsupported or not yet resumed, and when
   * disabled UNLESS `force` — the preview bench (§3.132) forces a play so you
   * can audition a cue even with game audio muted.
   */
  play(cue: SoundCue, force = false): void {
    if (!this.enabled && !force) return;
    const ctx = this.ensureContext();
    const master = this.master;
    if (!ctx || !master) return;
    // Not yet unlocked by a gesture: attempt a resume for next time, skip now.
    if (ctx.state !== 'running') {
      void this.resume();
      return;
    }
    try {
      RECIPES[cue](ctx, master, ctx.currentTime + 0.001);
    } catch {
      /* a scheduling failure must never break the game */
    }
  }

  /** Release audio resources (board unmount). Idempotent; never throws. */
  dispose(): void {
    try {
      void this.ctx?.close();
    } catch {
      /* already closed */
    }
    this.ctx = undefined;
    this.master = undefined;
  }

  /** Create the context + master gain on first need. Returns undefined if unsupported. */
  private ensureContext(): AudioContext | undefined {
    if (this.ctx) return this.ctx;
    const Ctor: typeof AudioContext | undefined =
      typeof window !== 'undefined'
        ? window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
        : undefined;
    if (!Ctor) return undefined;
    try {
      const ctx = new Ctor();
      const master = ctx.createGain();
      master.gain.setValueAtTime(this.volume, ctx.currentTime);
      master.connect(ctx.destination);
      this.ctx = ctx;
      this.master = master;
      return ctx;
    } catch {
      return undefined;
    }
  }
}

function clamp01(n: number): number {
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
}
