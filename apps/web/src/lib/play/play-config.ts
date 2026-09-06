/**
 * Named UI/flow constants for the hotseat (pass-and-play) mode. DESIGN §1.3: no
 * magic numbers — every value that affects the hotseat flow or feel lives here so
 * it is tunable from one place. Rules-affecting values (starting hand, lands/turn,
 * phase names) come from the engine's `DEFAULT_RULES`/`STEP_ORDER`, NOT from here;
 * this module only owns the *client* knobs the engine has no opinion about.
 */
import { DEFAULT_RULES } from '@jonny-boi/core';

/** A frozen bundle of hotseat client knobs. */
export interface HotseatConfig {
  /**
   * Maximum number of mulligans a player may take before they must keep. London
   * mulligan: you always draw a full hand, then bottom N cards equal to how many
   * times you mulliganed. Capped at the starting hand size so you can't bottom more
   * than you hold.
   */
  readonly maxMulligans: number;
  /** Default name for seat A when the player leaves it blank. */
  readonly defaultNameA: string;
  /** Default name for seat B when the player leaves it blank. */
  readonly defaultNameB: string;
  /** Seed used when the player doesn't enter one (kept deterministic for replays). */
  readonly defaultSeed: number;
  /**
   * Pause before the AI opponent takes each action, in milliseconds.
   *
   * Not decoration: without it the pilot resolves its whole turn between two
   * frames, and the human sees the board teleport from their end step to their
   * next untap with a wall of new log lines and no idea what happened. A short
   * beat makes each play legible. It is also what keeps a long AI turn from
   * blocking the main thread in one synchronous burst.
   */
  readonly aiThinkMs: number;
  /** Default name for the AI opponent's seat. */
  readonly defaultAiName: string;
  /**
   * A safety cap on automatic engine advancement (e.g. when a player passes and the
   * engine resolves a chain of steps with nothing to do). Bounds any internal loop
   * so a pathological state can never hang the UI — mirrors the sim's action cap.
   */
  readonly maxAutoAdvanceSteps: number;
}

/** The default hotseat configuration. */
export const HOTSEAT_CONFIG: HotseatConfig = Object.freeze({
  // You can mulligan down to a one-card hand at most (London: bottom up to a full
  // hand). Capping at the starting hand size keeps "bottom N" always legal.
  maxMulligans: DEFAULT_RULES.startingHandSize - 1,
  defaultNameA: 'Player 1',
  defaultNameB: 'Player 2',
  defaultSeed: 12345,
  aiThinkMs: 450,
  defaultAiName: 'Computer',
  maxAutoAdvanceSteps: 512,
});

/** Human-readable labels for the engine's turn steps (UI display only). */
export const STEP_LABELS: Readonly<Record<string, string>> = Object.freeze({
  untap: 'Untap',
  upkeep: 'Upkeep',
  draw: 'Draw',
  precombatMain: 'Main Phase 1',
  beginCombat: 'Begin Combat',
  declareAttackers: 'Declare Attackers',
  declareBlockers: 'Declare Blockers',
  combatDamage: 'Combat Damage',
  endCombat: 'End of Combat',
  postcombatMain: 'Main Phase 2',
  end: 'End Step',
  cleanup: 'Cleanup',
});

/** A readable label for a step, falling back to the raw id. */
export function stepLabel(step: string): string {
  return STEP_LABELS[step] ?? step;
}

/**
 * How long a board toast (a rejection reason, a "pick an attacker first" hint)
 * stays on screen, in milliseconds. Named here because it was three different
 * inline literals across the board's handlers, which is exactly the drift DESIGN
 * §1.3 forbids: the same class of message vanishing at three different speeds.
 */
export const TOAST_MS = 2600;

/**
 * Drag-to-play: how far (px, straight-line) a pressed card must travel before the
 * press commits to being a drag. Below this a release is a plain click/tap — the
 * threshold is what keeps tap-to-play alive on touch screens, where every tap
 * would otherwise register as a zero-distance drag and die on release.
 */
export const DRAG_START_THRESHOLD_PX = 8;

/** Zone-change animation knobs (§3.57) — every timing named, none inline. */
export interface AnimationConfig {
  /** Flight time of the card-back sprite from library to hand (a draw). */
  readonly drawFlightMs: number;
  /** Flight time of a card sprite into the graveyard (a mill or a discard). */
  readonly graveFlightMs: number;
  /** How long a dying permanent's ghost takes to fade/shrink away. */
  readonly deathFadeMs: number;
  /**
   * Delay between sprites spawned by ONE action, so "draw three" reads as
   * three cards rather than one thick blur.
   */
  readonly staggerMs: number;
  /**
   * Most sprites one batch of events may spawn. A board wipe or a big mill is
   * a fact the log tells better than twenty overlapping sprites would — past
   * the cap the remaining moves simply happen, exactly as before this feature.
   */
  readonly maxPerBatch: number;
  /** Sprite size (width, px) for the flying card back / face. */
  readonly spriteWidthPx: number;
}

/** The default animation configuration (see {@link AnimationConfig}). */
export const ANIMATION_CONFIG: AnimationConfig = Object.freeze({
  drawFlightMs: 550,
  graveFlightMs: 480,
  deathFadeMs: 500,
  staggerMs: 90,
  maxPerBatch: 10,
  spriteWidthPx: 52,
});

/** Procedural game-audio knobs (§3.130) — every timing/level named, none inline. */
export interface SoundConfig {
  /** Whether audio is on out of the box (before the player ever touches it). */
  readonly defaultEnabled: boolean;
  /** Master volume out of the box, 0..1. */
  readonly defaultVolume: number;
  /**
   * Most sound cues ONE batch of events may play. A board wipe emits many
   * `creatureDied` events; a cast auto-taps many lands — past the cap the
   * remaining cues are dropped rather than played as a machine-gun. Identical
   * cues in a batch are coalesced to one BEFORE this cap applies.
   */
  readonly maxPerBatch: number;
  /** Gap between staggered cues in one batch, so two sounds read as two. */
  readonly staggerMs: number;
}

/**
 * The default audio configuration. On by default because the whole point is the
 * MTGA-style feel; a mute toggle rides the action bar and the choice persists.
 * The volume is deliberately gentle — procedural tones are pure and carry, so a
 * modest master keeps them a texture rather than a nuisance.
 */
export const SOUND_CONFIG: SoundConfig = Object.freeze({
  defaultEnabled: true,
  defaultVolume: 0.55,
  maxPerBatch: 6,
  staggerMs: 70,
});

/** Visual-effects knobs (§3.131) — the particle/glow/flash layer's timings. */
export interface VfxConfig {
  /** How long a full-screen life flash takes to bloom and fade. */
  readonly flashMs: number;
  /** How long a cast/token glow flare lives. */
  readonly flareMs: number;
  /** How long a damage/death particle burst lives. */
  readonly burstMs: number;
  /** Particles in one burst — enough to read as a spray, not a swarm. */
  readonly burstParticles: number;
  /**
   * Most effects ONE batch of events may spawn — a board wipe is better told by
   * a few poofs than by twenty overlapping ones. Screen flashes coalesce to one
   * BEFORE this cap; tile bursts at distinct tiles are kept (up to the cap).
   */
  readonly maxPerBatch: number;
}

/** The default visual-effects configuration (see {@link VfxConfig}). */
export const VFX_CONFIG: VfxConfig = Object.freeze({
  flashMs: 620,
  flareMs: 560,
  burstMs: 620,
  burstParticles: 10,
  maxPerBatch: 8,
});

/**
 * The seed the co-pilot asks the pilot from (§3.67). FIXED on purpose: the
 * advice for a given board must be the same every time it is drawn, or a hint
 * would flicker between renders and be impossible to act on. It is advice, not
 * a game input, so it takes no part in the game's own determinism.
 */
export const COPILOT_ADVICE_SEED = 0x5ee_d1;
