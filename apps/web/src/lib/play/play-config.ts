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

/**
 * "What the opponent just did" feed (§3.133). The hold is the whole point: an
 * AI instant is cast and resolved inside one auto-passed burst, so the note has
 * to OUTLIVE the stack object it describes for a human to read it.
 */
export interface OpponentFeedConfig {
  /** How long one note stays on screen after the play. */
  readonly holdMs: number;
  /** Most notes shown at once — a long turn scrolls past, it does not stack up. */
  readonly maxShown: number;
}

/** The default opponent-feed configuration (see {@link OpponentFeedConfig}). */
export const OPPONENT_FEED_CONFIG: OpponentFeedConfig = Object.freeze({
  holdMs: 7000,
  maxShown: 4,
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

// =============================================================================
// §3.143 — the MTGA-parity play surface (docs/MTGA-UX-OVERHAUL.md).
//
// Every tunable the overhaul needs is named HERE, up front, before any lane
// builds on it — §2.5 of the scope: "Perspective angle, tilt, attack advance
// fraction, midline clamp, arc curvature, ember colors, damage-animation
// durations and stagger — all from a config module, none inline."
//
// Nine lanes render this board. Nine lanes inventing their own 90°, their own
// 250ms, their own orange is nine answers to one question (rule 12). One module
// is the answer, and the UNIT LIVES IN THE NAME (`…Ms`, `…Px`, `…Deg`,
// `…Fraction`) so a reader never has to guess what a number means and
// `play-config.test.ts` can range-check every knob from its name alone.
// =============================================================================

/**
 * A card's drawn height ÷ its drawn width.
 *
 * Taken from the SCRYFALL "normal" image (488 × 680), not from the printed
 * 63 × 88 mm card, because the image is what the board actually paints —
 * `styles.css` sets `aspect-ratio: 488 / 680` on the card image. The two differ
 * by 0.25%, which matters nowhere, but picking the one the pixels use means
 * {@link TapRotationConfig.footprintRatio} reserves exactly the space a turned
 * card occupies rather than approximately it.
 */
export const CARD_ASPECT_HEIGHT_OVER_WIDTH = 680 / 488;

/**
 * The tabletop tilt, in degrees, as ONE named value — because
 * {@link Board3dConfig.counterTiltDeg} is its exact negation and two literals
 * that must stay equal and opposite is a divergence waiting to happen (rule 12:
 * where a second copy is unavoidable, derive both from one source).
 */
const BOARD_TILT_DEG = 8;

/** The 3D tabletop scene (UX-9). */
export interface Board3dConfig {
  /**
   * CSS `perspective` distance, px. SMALLER = stronger foreshortening. 1600px
   * against a board roughly 700–900px tall is a gentle projection: the far seat
   * reads as further away without the fish-eye that a sub-1000px perspective
   * gives a box this size, where the near row's corners visibly bulge.
   */
  readonly perspectivePx: number;
  /**
   * Tilt of the tabletop away from the viewer, degrees. Caleb asked for
   * "looking down and slanted **just a bit**", and this is the "just a bit".
   *
   * The trade-off is legibility: every degree of tilt vertically compresses the
   * far row's card art and its P/T footer by `cos(tilt)`, and past roughly 12°
   * the opponent's tiles — already the smaller half of the height budget
   * (`--play-seat-rows-max`, board-fit.css) — stop being readable at a glance,
   * which is the opposite of what this overhaul is for. 8° costs 1% of height
   * and still visibly seats the board on a table.
   */
  readonly tiltDeg: number;
  /**
   * The tilt used when the viewer prefers reduced motion. **0 means flat**, and
   * flat is the honest fallback: a tilted plane whose tiles slide across it
   * during combat is exactly the vestibular trigger `prefers-reduced-motion`
   * exists to signal. A number rather than a boolean so a designer can choose a
   * gentler tilt instead of none without a code change.
   */
  readonly reducedMotionTiltDeg: number;
  /**
   * Where the vanishing point sits horizontally, as a fraction of the scene box.
   * 0.5 — the player sits square to the table, so the scene is symmetric and a
   * creature on the left recedes exactly as one on the right does.
   */
  readonly perspectiveOriginXFraction: number;
  /**
   * The same, vertically. Above 0.5 the eye moves toward the PLAYER's edge of
   * the table, which is the seat Caleb asked to look from: the player's own row
   * reads near full size and the opponent's recedes. Pushed much past 0.7 the
   * keystone becomes strong enough that the opponent's row narrows noticeably
   * at its far corners; 0.62 is a seat, not a lean.
   */
  readonly perspectiveOriginYFraction: number;
  /**
   * Counter-rotation applied to text-bearing chrome that must sit INSIDE the
   * scene (a tile's P/T footer, a counter chip). Exactly `-tiltDeg`, so the
   * glyphs are upright.
   *
   * Rejected alternative: a PARTIAL counter-tilt (say 70%), which keeps the text
   * visually bedded into the table. It loses, because this overhaul exists to
   * make the board readable and a 5/6 that is 1% shorter than it should be is a
   * better trade than a 5/6 that is slanted.
   */
  readonly counterTiltDeg: number;
  /**
   * How much a "lifted" tile (hovered, selected, advancing into combat) scales
   * up to read as floating above the table.
   *
   * ⚠️ Lift is FAKED with scale + shadow, never `translateZ`. Four ancestors
   * between `.play-board` and a tile set `overflow`/`contain` (board-fit.css
   * `.play-board`, `.seat__board`, `.seat__row`; styles.css `.perm`), and CSS
   * Transforms L2 forces `transform-style: flat` on any such box — so no
   * descendant of this scene can be positioned in 3D at all. The scene is a FLAT
   * PROJECTION through one transform, which needs no `preserve-3d`, and removing
   * those four scrollers would undo the entire §3.62/§3.119 height budget.
   */
  readonly liftScale: number;
  /** Blur radius of a lifted tile's drop shadow, px — the other half of the lift. */
  readonly liftShadowPx: number;
  /**
   * How long the scene takes to tilt or flatten when the knob changes (the debug
   * bench slider, a reduced-motion preference flipping). Short: this is a
   * settings change, not a game event.
   */
  readonly sceneTransitionMs: number;
}

/** The default 3D-scene configuration (see {@link Board3dConfig}). */
export const BOARD_3D_CONFIG: Board3dConfig = Object.freeze({
  perspectivePx: 1600,
  tiltDeg: BOARD_TILT_DEG,
  reducedMotionTiltDeg: 0,
  perspectiveOriginXFraction: 0.5,
  perspectiveOriginYFraction: 0.62,
  counterTiltDeg: -BOARD_TILT_DEG,
  liftScale: 1.06,
  liftShadowPx: 14,
  sceneTransitionMs: 220,
});

/** Tapping a permanent turns it sideways (UX-11). */
export interface TapRotationConfig {
  /**
   * Degrees a tapped permanent turns. **90 is the table rule** — you turn a card
   * sideways to tap it — and it is named rather than inlined because the board
   * shipped with 24° (styles.css `.perm--tapped`) as a workaround for the fixed
   * grid, which is the defect UX-11 exists to remove.
   */
  readonly tappedDeg: number;
  /**
   * How long the turn takes. The board's existing `.perm` transition is 120ms,
   * chosen for a 24° nudge; at 120ms a 90° sweep reads as a snap rather than a
   * turn. Past roughly 250ms an untap step becomes a slow carousel of every
   * permanent you control, so 180ms is the window between "flicker" and "wait".
   */
  readonly turnMs: number;
  /**
   * LAYOUT width a turned card's slot must reserve, as a multiple of the tile
   * width — a card turned 90° is as wide as it was tall.
   *
   * Derived from {@link CARD_ASPECT_HEIGHT_OVER_WIDTH}, never typed as 1.4:
   * `transform` does not reflow, which is precisely why 24° was chosen over 90°
   * in the first place. The footprint has to come from the slot's `flex-basis`,
   * and `.seat__board`'s `contain: size` (board-fit.css, called "the load-bearing
   * line" by its own comment) means the strip will NOT grow to absorb it.
   */
  readonly footprintRatio: number;
  /**
   * Opacity of a tapped permanent. The board shipped 0.72 alongside a 24°
   * rotation, because at 24° the tilt alone did not say "tapped" loudly enough.
   * At a full 90° the ROTATION carries the signal, so the dimming can be gentler
   * and the card stays readable while tapped — which matters now that an
   * ATTACKING creature is also a tapped one (UX-11).
   */
  readonly tappedOpacity: number;
  /** Desaturation of a tapped permanent, 0..1. Reduced for the same reason. */
  readonly tappedGrayscaleFraction: number;
}

/** The default tap-rotation configuration (see {@link TapRotationConfig}). */
export const TAP_ROTATION_CONFIG: TapRotationConfig = Object.freeze({
  tappedDeg: 90,
  turnMs: 180,
  footprintRatio: CARD_ASPECT_HEIGHT_OVER_WIDTH,
  tappedOpacity: 0.82,
  tappedGrayscaleFraction: 0.25,
});

/**
 * Attackers advance toward the defender and blockers advance to meet them
 * (UX-12, UX-13).
 *
 * Every distance is a FRACTION of a measured distance, never a pixel literal:
 * the board's height is `dvh`-derived and its tiles `clamp()`-scaled
 * (board-fit.css), so a "40px forward" would be a third of the way across a
 * short seat and a tenth of a tall one. The one pixel value here is the midline
 * clamp, which is a physical gap between two cards and genuinely absolute.
 */
export interface CombatAdvanceConfig {
  /**
   * How far an attacker travels along the line from its home position to the
   * midline, as a fraction of that distance. Above ~0.7 the tile arrives close
   * enough to the midline that the clamp does all the work and the fraction
   * stops meaning anything; below ~0.35 the move reads as a jitter rather than a
   * charge. 0.55 is past halfway — visibly committed — with daylight left.
   */
  readonly attackerAdvanceFraction: number;
  /**
   * How far a blocker travels toward its attacker's ADVANCED position, as a
   * fraction of that distance. Higher than the attacker's because "moved forward
   * to meet the creatures they are blocking" is the whole point: the pair must
   * read as a pair.
   */
  readonly blockerAdvanceFraction: number;
  /**
   * The hard clamp: no advancing tile's leading edge may come closer than this
   * to the midline, px. Caleb: "without crossing the midline between players".
   * Sized so an attacker and the blocker meeting it leave a visible seam rather
   * than appearing to overlap into one object.
   */
  readonly midlineGapPx: number;
  /** Travel time of one advance. Long enough to follow, short enough not to gate declare-attackers. */
  readonly advanceMs: number;
  /**
   * Travel time home at end of combat. Faster than the advance on purpose: the
   * advance is a statement the player must read, the retreat is bookkeeping.
   */
  readonly retreatMs: number;
  /** Delay between tiles in one advance, so an alpha strike reads as a charge and not a slab. */
  readonly staggerMs: number;
  /**
   * Most tiles that get their own stagger slot. Past this they all move
   * together — a 20-creature swing must not take two seconds to finish moving.
   */
  readonly maxStaggered: number;
}

/** The default combat-advance configuration (see {@link CombatAdvanceConfig}). */
export const COMBAT_ADVANCE_CONFIG: CombatAdvanceConfig = Object.freeze({
  attackerAdvanceFraction: 0.55,
  blockerAdvanceFraction: 0.6,
  midlineGapPx: 16,
  advanceMs: 260,
  retreatMs: 200,
  staggerMs: 45,
  maxStaggered: 8,
});

/** One stop of an arc's gradient. */
export interface GradientStop {
  /** Position along the arc: 0 = the source end, 1 = the arrowhead end. */
  readonly offsetFraction: number;
  /** The colour at that position, as a CSS colour — a token from {@link COMBAT_ARC_COLORS}. */
  readonly color: string;
}

/**
 * The arc palette, named ONCE (UX-14: "ember colors … from a config module").
 *
 * Two ramps, not one. The board already codes combat with colour — a red
 * outline for `.perm--attacking`, a blue one for `.perm--blocking`
 * (board-clarity.css) — and painting both arcs the same fire would delete that
 * distinction at the exact moment a player most needs it. So the attack arc is a
 * red/orange flame and the block arc is a BLUE flame: both fiery, still telling
 * you which end of the pair you are looking at.
 *
 * Each ramp runs dark at the source end to near-white at the arrowhead, so the
 * arrow reads directionally even in a still screenshot.
 */
export const COMBAT_ARC_COLORS = Object.freeze({
  /** Attack: the dark root of the flame, at the attacker's end. */
  attackEmber: '#7a1d05',
  /** Attack: the body of the flame. */
  attackFlame: '#e2560f',
  /** Attack: the bright mid-flame. */
  attackBlaze: '#ffa71f',
  /** Attack: the hot tip, at the arrowhead. */
  attackTip: '#ffe9a8',
  /** Block: the dark root of the blue flame, at the blocker's end. */
  blockEmber: '#06203f',
  /** Block: the body. */
  blockFlame: '#1177c9',
  /** Block: the bright mid-flame. */
  blockBlaze: '#4fc3f7',
  /** Block: the hot tip. */
  blockTip: '#dff3ff',
});

/** Fiery arced arrows for attack/block pairs (UX-14). */
export interface CombatArcConfig {
  /**
   * How far the arc bows off the straight line, as a fraction of the CHORD
   * length. A fraction rather than a pixel bow so a short arc between adjacent
   * tiles and a long one across the board have the same visual character. 0.18
   * is a clear curve; past ~0.3 arcs between distant tiles start to leave the
   * board's box.
   */
  readonly bowChordFraction: number;
  /**
   * Absolute ceiling on the bow, px — the clamp that keeps the widest arc on a
   * wide monitor from ballooning over the seat panels.
   */
  readonly maxBowPx: number;
  /** Stroke width of a DECLARED pair's arc. */
  readonly strokeWidthPx: number;
  /** Stroke width of a half-built (locally drafted) block, drawn thinner AND dashed. */
  readonly draftStrokeWidthPx: number;
  /** SVG `stroke-dasharray` for a drafted block — a decision that is not committed yet. */
  readonly draftDashArray: string;
  /** Arrowhead length along the arc's terminal tangent. */
  readonly arrowHeadLengthPx: number;
  /** Arrowhead width across that tangent. */
  readonly arrowHeadWidthPx: number;
  /** Blur radius of the glow under the arc, which is what makes it read as fire rather than ink. */
  readonly glowBlurPx: number;
  /**
   * Period of the ember travel loop. Slow enough to read as embers drifting
   * along the arc, fast enough to be obviously alive. Gated behind
   * `prefers-reduced-motion: no-preference` by the consumer — the static arc and
   * its arrowhead must survive with motion off, because they carry the
   * INFORMATION and the embers are only decoration.
   */
  readonly emberPeriodMs: number;
  /** SVG `stroke-dasharray` of the travelling ember overlay. */
  readonly emberDashArray: string;
  /** Attacker → defender ramp, source end first. */
  readonly attackGradient: readonly GradientStop[];
  /** Blocker → attacker ramp, source end first. */
  readonly blockGradient: readonly GradientStop[];
}

/** The default combat-arc configuration (see {@link CombatArcConfig}). */
export const COMBAT_ARC_CONFIG: CombatArcConfig = Object.freeze({
  bowChordFraction: 0.18,
  maxBowPx: 120,
  strokeWidthPx: 3,
  draftStrokeWidthPx: 2,
  draftDashArray: '6 5',
  arrowHeadLengthPx: 14,
  arrowHeadWidthPx: 10,
  glowBlurPx: 6,
  emberPeriodMs: 1400,
  emberDashArray: '10 14',
  attackGradient: Object.freeze([
    Object.freeze({ offsetFraction: 0, color: COMBAT_ARC_COLORS.attackEmber }),
    Object.freeze({ offsetFraction: 0.45, color: COMBAT_ARC_COLORS.attackFlame }),
    Object.freeze({ offsetFraction: 0.8, color: COMBAT_ARC_COLORS.attackBlaze }),
    Object.freeze({ offsetFraction: 1, color: COMBAT_ARC_COLORS.attackTip }),
  ]),
  blockGradient: Object.freeze([
    Object.freeze({ offsetFraction: 0, color: COMBAT_ARC_COLORS.blockEmber }),
    Object.freeze({ offsetFraction: 0.45, color: COMBAT_ARC_COLORS.blockFlame }),
    Object.freeze({ offsetFraction: 0.8, color: COMBAT_ARC_COLORS.blockBlaze }),
    Object.freeze({ offsetFraction: 1, color: COMBAT_ARC_COLORS.blockTip }),
  ]),
});

/**
 * The damage-distribution sequence at end of blocks (UX-15).
 *
 * The budget is deliberately internally consistent, and `play-config.test.ts`
 * pins it: one full batch at {@link DamageAnimConfig.maxPerBatch} beats must fit
 * inside {@link DamageAnimConfig.maxTotalMs}. A cap that the per-beat timings
 * cannot reach is a cap that never fires, which is worse than no cap because it
 * reads like a guarantee.
 */
export interface DamageAnimConfig {
  /** Flight time of one hit, source → recipient. */
  readonly travelMs: number;
  /** The bloom at the recipient once the hit lands. */
  readonly impactMs: number;
  /**
   * Gap between hits in one batch. This is the knob that makes a multi-block
   * legible: Caleb's complaint is that damage "just happens", and three
   * simultaneous arcs are as unreadable as none.
   */
  readonly staggerMs: number;
  /**
   * Beat between the last impact and the board settling (deaths applied,
   * attackers retreating), so a lethal hit and the creature vanishing are two
   * events rather than one.
   */
  readonly settleHoldMs: number;
  /**
   * Most hits ONE batch may animate. Past the cap the remaining damage simply
   * happens, exactly as it does today — the same policy {@link AnimationConfig}
   * and {@link VfxConfig} already state, so a board wipe is told by the log.
   */
  readonly maxPerBatch: number;
  /**
   * Hard ceiling on the whole sequence. Whichever binds first — this or
   * {@link maxPerBatch} — ends the sequence; a huge combat must never be able to
   * stall the game.
   */
  readonly maxTotalMs: number;
}

/** The default damage-animation configuration (see {@link DamageAnimConfig}). */
export const DAMAGE_ANIM_CONFIG: DamageAnimConfig = Object.freeze({
  travelMs: 340,
  impactMs: 260,
  staggerMs: 110,
  settleHoldMs: 220,
  maxPerBatch: 10,
  maxTotalMs: 2200,
});

/**
 * Holding an opponent's spell on screen so it can be read before it resolves
 * (UX-16).
 *
 * ⚠️ A HOLD IS NOT A STOP. `shouldStopForPriority` returning false on
 * `!ctx.hasAnyPlay` (priority-stops.ts) is correct and §3.119 removed the
 * alternative deliberately: handing priority to a player who can do nothing is
 * the bug, not the fix. The hold is a purely presentational pause layered on
 * top, which is why its durations live here and not in the stop table.
 */
export interface SpellHoldConfig {
  /**
   * How long an opponent's instant/sorcery stays on screen before the board
   * auto-passes. Long enough to read a name and a type line and decide whether
   * to look closer; short enough that an AI turn with three cantrips in it does
   * not become a slideshow.
   */
  readonly holdMs: number;
  /**
   * The TOTAL hold once the player moves the pointer onto the held card — they
   * have signalled they are reading it, so the beat becomes a pause.
   *
   * ⚠️ Bounded, not infinite, and that is the point: a pointer resting over the
   * announce card must not be able to freeze the game. When it expires the card
   * resolves and the post-hoc feed (§3.133) still carries what happened.
   */
  readonly pointerHoldMs: number;
  /** Extra time added by each press of the explicit "keep holding" affordance. */
  readonly extendMs: number;
  /** Fade in/out of the announce card. */
  readonly fadeMs: number;
  /**
   * Most holds one turn may spend. A storm turn is not twelve pauses; past the
   * cap the spells resolve at today's speed and the feed reports them.
   */
  readonly maxHoldsPerTurn: number;
}

/** The default opponent-spell-hold configuration (see {@link SpellHoldConfig}). */
export const SPELL_HOLD_CONFIG: SpellHoldConfig = Object.freeze({
  holdMs: 2400,
  pointerHoldMs: 8000,
  extendMs: 3000,
  fadeMs: 220,
  maxHoldsPerTurn: 6,
});

/**
 * The two-phase cast/activate transaction (UX-3/4/5).
 *
 * The commit boundary itself is `lib/play/proposal.ts` + the session snapshot
 * (scope §2.3); this is only the knobs that decide how the pre-commit state
 * LOOKS and how far it may go.
 */
export interface ProposalConfig {
  /**
   * How many proposals may be open at once. **1** — a proposal opened inside a
   * proposal has no single snapshot to restore, so the second one is REFUSED
   * rather than guessed at (rule 2: a value outside the table reports honestly).
   * Named so the refusal is a config fact a test can assert, not a hidden `if`.
   */
  readonly maxOpenProposals: number;
  /**
   * The key that cancels a proposal. Caleb: "Escape / an explicit Cancel".
   * Named because the same string is needed by the board's key handler, the
   * hint text and the test, and three copies of `'Escape'` is three chances to
   * mistype one.
   */
  readonly cancelKey: string;
  /** How long the "Esc cancels" hint rides the action bar after a proposal opens. */
  readonly cancelHintMs: number;
  /** The confirm flash when a committed object lands on the stack — the moment it becomes irreversible. */
  readonly commitFlashMs: number;
  /**
   * How far the board dims behind an open proposal. Pre-commit must not look
   * like the game: the whole promise of UX-3 is that nothing has happened yet.
   */
  readonly proposingDimOpacity: number;
}

/** The default proposal configuration (see {@link ProposalConfig}). */
export const PROPOSAL_CONFIG: ProposalConfig = Object.freeze({
  maxOpenProposals: 1,
  cancelKey: 'Escape',
  cancelHintMs: 4000,
  commitFlashMs: 240,
  proposingDimOpacity: 0.55,
});

/**
 * The stack, showing real card faces (UX-1) and always visible (UX-2).
 *
 * **Measured, not guessed:** the centre column the stack shares with the log is
 * `minmax(12rem, 22rem)` wide and capped at `--play-log-max-h` = 22dvh
 * (board-fit.css) — 176px tall on an 800px window — on a column declared
 * `flex: 0 4 auto`, i.e. the DESIGNATED first-to-yield. A hand-size face
 * (`--play-card-w-max` 148px → 206px tall) does not fit in that; a tile-size
 * face does, with one row to spare. Hence a tile-width card, and hence UX-2's
 * "always visible" being answered by floating the panel over the board rather
 * than by growing that column — growing it re-opens §3.119's "Battleground is
 * super crunched", a fix already paid for.
 */
export interface StackPanelConfig {
  /**
   * Width of a card face on the stack, px. Equal to `--play-tile-w-max` (96px,
   * board-fit.css) — the largest face that provably fits the measured column,
   * at 96 × 1.393 ≈ 134px tall.
   */
  readonly cardWidthPx: number;
  /**
   * How many stack objects show at full size before the panel condenses. Five
   * covers essentially every real stack; deeper than that the exact faces matter
   * less than the count and the order.
   */
  readonly maxVisibleEntries: number;
  /** Card width once the panel has condensed, px. */
  readonly condensedCardWidthPx: number;
  /**
   * Fraction of a card's width covered by the next card in the fan. The visible
   * sliver is `1 - this`, and that sliver is what stays hoverable — a
   * readability floor, the same argument `--play-hand-slice-min` makes for the
   * hand.
   */
  readonly overlapFraction: number;
  /** How far the top of the stack (the object that resolves NEXT) lifts clear of the rest. */
  readonly topLiftPx: number;
  /** How long a newly-pushed object takes to animate into the panel. */
  readonly enterMs: number;
}

/** The default stack-panel configuration (see {@link StackPanelConfig}). */
export const STACK_PANEL_CONFIG: StackPanelConfig = Object.freeze({
  cardWidthPx: 96,
  maxVisibleEntries: 5,
  condensedCardWidthPx: 64,
  overlapFraction: 0.42,
  topLiftPx: 10,
  enterMs: 200,
});
