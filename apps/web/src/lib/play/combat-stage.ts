/**
 * THE COMBAT STAGE (UX-12 / UX-13, docs/MTGA-UX-OVERHAUL.md §1) — pure, DOM-free.
 *
 * Caleb: *"attacking creatures moved forward towards the player being attacked,
 * but without crossing the midline between players, chosen blockers being moved
 * forward to meet the creatures they are blocking"*.
 *
 * ## Why the advance cannot be a transform on the tile
 *
 * FOUR boxes between `.play-board` and a `.perm` clip their content:
 * `.play-board` (`overflow-y:auto`, board-fit.css), `.seat__board`
 * (`contain:size; overflow-y:auto`), `.seat__row` (`overflow-x:auto;
 * overflow-y:hidden`) and `.perm` itself (`overflow:hidden`, styles.css). A tile
 * translated toward the midline is therefore clipped by its OWN ROW before it
 * has moved a tile's height, and none of those four can be relaxed:
 * board-fit.css records that `contain: size` on `.seat__board` is the
 * load-bearing line of the whole §3.62 height budget, and `overflow-x: auto` on
 * a row cannot coexist with `overflow-y: visible` (CSS Overflow 3 §3.2 —
 * `visible` computes to `auto` when the other axis is not `visible`).
 *
 * So the advanced card is painted in an UNCLIPPED, viewport-fixed layer — the
 * same pattern `DeathGhost` already uses (AnimationLayer.tsx) — and this module
 * is the geometry that layer needs, with no DOM in it so the clamp can be tested
 * in Node.
 *
 * ## Everything here is measured, nothing is assumed
 *
 * The midline is MEASURED off the element between the two seats, never
 * recomputed from seat heights: one answer to one question (rule 12). Distances
 * are FRACTIONS of measured distances (`COMBAT_ADVANCE_CONFIG`) because the
 * board's height is `dvh`-derived and its tiles `clamp()`-scaled — a pixel
 * literal would be a third of the way across a short seat and a tenth of a tall
 * one. The single absolute is the midline gap, which is a physical space between
 * two pieces of card and genuinely does not scale.
 */
import type { InstanceId } from '@jonny-boi/core';
import type { CombatAdvanceConfig } from './play-config.js';

/**
 * How faint a card's HOME slot is drawn while the card itself is out on the
 * stage. It has to stay visible — the home tile is still the click target for
 * declaring blocks — but must not compete with the copy the player is reading.
 *
 * ⚠️ NAMED HERE RATHER THAN INLINED, AND IT BELONGS IN `play-config.ts`.
 * Lane F owns that file and this run forbids editing it, so the constant lives
 * beside the only code that reads it and is REPORTED for relocation rather than
 * written as a literal in `board-scene.css`, which would put a behavioural
 * number out of every consumer's reach (rule 2).
 */
export const STAGED_HOME_TILE_OPACITY = 0.3;

/** A point in VIEWPORT coordinates, the space every overlay on this board uses. */
export interface StagePoint {
  readonly x: number;
  readonly y: number;
}

/**
 * A measured box in VIEWPORT coordinates — the fields of a `DOMRect` this module
 * actually reads, named as an interface so a test can build one without a DOM.
 */
export interface StageRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Which side of the midline a seat sits on, as the SIGN of "forward" in screen
 * coordinates: the viewer sits at the bottom and advances UP (-1); the opponent
 * sits at the top and advances DOWN (+1).
 *
 * A sign rather than a seat id on purpose — the geometry does not care who is
 * playing, only which way the card has to travel, and deriving the sign from
 * `seat === viewer` inside here would be a second copy of a fact the board
 * already knows.
 */
export type AdvanceDirection = 1 | -1;

/** The roles a staged card can have. CLOSED — a new role is a ROW, not a branch. */
export const STAGE_ROLES = ['attacker', 'blocker'] as const;
export type StageRole = (typeof STAGE_ROLES)[number];

/**
 * How far each role travels, and toward what. One table read by the one mover
 * below, so adding (say) a "defender braces backward" role is a row.
 *
 * `fractionOf` names WHICH configured fraction the role spends, so the two
 * numbers in `COMBAT_ADVANCE_CONFIG` can never be swapped by accident.
 */
export const STAGE_ROLE_RULES: {
  readonly [R in StageRole]: {
    readonly fractionOf: keyof Pick<
      CombatAdvanceConfig,
      'attackerAdvanceFraction' | 'blockerAdvanceFraction'
    >;
    readonly why: string;
  };
} = Object.freeze({
  attacker: Object.freeze({
    fractionOf: 'attackerAdvanceFraction',
    why: 'An attacker walks toward the player (or planeswalker) it is attacking and stops short of the midline — CR 508 puts it in combat, not in the defender’s half.',
  }),
  blocker: Object.freeze({
    fractionOf: 'blockerAdvanceFraction',
    why: 'A blocker steps out to MEET its attacker (CR 509.1a), so it travels toward that attacker’s ADVANCED position, not its home one — otherwise the two would still be a board apart after both moved.',
  }),
});

/** One card the stage has to paint, before its destination is worked out. */
export interface StageSubject {
  readonly instanceId: InstanceId;
  readonly role: StageRole;
  /** The tile's CURRENT, in-flow box (measured off `data-perm-home`). */
  readonly home: StageRect;
  /** Which way this card's seat advances. */
  readonly toward: AdvanceDirection;
  /**
   * For a blocker: the attacker it is blocking, so it can aim at that
   * attacker's already-advanced centre. Absent for an attacker, which travels
   * straight forward (see {@link advancedCentre}).
   */
  readonly meets?: InstanceId;
}

/** A card placed on the stage: where it was, and where it is drawn. */
export interface StagePlacement {
  readonly instanceId: InstanceId;
  readonly role: StageRole;
  readonly home: StageRect;
  /** The advanced CENTRE, viewport px. */
  readonly centre: StagePoint;
  /**
   * Stagger slot, so a six-creature alpha strike walks out rather than
   * teleporting as one block. Capped at `maxStaggered`: past that the tail
   * shares the last slot, because a twentieth card starting a second later than
   * the first is a delay, not a flourish.
   */
  readonly staggerIndex: number;
}

/** Everything the stage needs that is not per-card. */
export interface StageInput {
  readonly subjects: readonly StageSubject[];
  /** The measured vertical centre of the region between the two seats. */
  readonly midlineY: number;
}

/** The centre of a measured box. */
export function centreOf(rect: StageRect): StagePoint {
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

/**
 * The FURTHEST a card may travel forward before its leading edge would come
 * closer than `midlineGapPx` to the midline. Never negative: a card already past
 * the line (a very short window, a mid-scroll measurement) stays where it is
 * rather than being yanked backwards, which would read as the board rejecting a
 * legal attack.
 *
 * This is the hard clamp UX-12 names, expressed once so both roles obey it.
 */
export function maxAdvancePx(
  home: StageRect,
  toward: AdvanceDirection,
  midlineY: number,
  cfg: CombatAdvanceConfig,
): number {
  const leadingEdge = centreOf(home).y + (toward * home.height) / 2;
  return Math.max(0, toward * (midlineY - leadingEdge) - cfg.midlineGapPx);
}

/**
 * Move `home` a fraction of the way toward `target`, clamped by
 * {@link maxAdvancePx}.
 *
 * ⚠️ The clamp scales the WHOLE vector, not just its vertical part. A blocker
 * aims diagonally at its attacker; clamping only `y` would leave it lined up
 * under a card it never reached, which says "these two are paired" in the one
 * direction and "they are not" in the other.
 *
 * ⚠️ AND IT NEVER MOVES A CARD BACKWARDS. Found by the boundary test rather
 * than by reading: a card whose leading edge already sits inside the midline gap
 * (a mid-scroll measurement, a very short window) has a target BEHIND it, and
 * the first draft happily dragged it back toward the line — turning the clamp
 * from "you may not advance past here" into "you must sit exactly here", which
 * is a different and wrong rule. `Math.max(0, …)` on the travel is the fix, and
 * the honest consequence is stated in {@link maxAdvancePx}: such a card does not
 * move at all, and the clearance it already had is the clearance it keeps.
 */
function advanceToward(
  home: StageRect,
  target: StagePoint,
  fraction: number,
  toward: AdvanceDirection,
  midlineY: number,
  cfg: CombatAdvanceConfig,
): StagePoint {
  const from = centreOf(home);
  const dx = (target.x - from.x) * fraction;
  const dy = (target.y - from.y) * fraction;
  const forward = toward * dy;
  if (forward <= 0) return from;
  const limit = maxAdvancePx(home, toward, midlineY, cfg);
  const scale = Math.min(1, limit / forward);
  return { x: from.x + dx * scale, y: from.y + dy * scale };
}

/**
 * An ATTACKER's advanced centre: straight forward, a configured fraction of the
 * way from its own centre to the midline, stopping at the clamp.
 *
 * Straight forward, not angled at the defender's tile, DELIBERATELY: which
 * creature (or player, or planeswalker) is being attacked is said by lane G's
 * arc, which can point anywhere; moving the card sideways as well would say it
 * twice and would shuffle the attacking row's reading order while the player is
 * still deciding blocks.
 */
export function advancedCentre(
  home: StageRect,
  toward: AdvanceDirection,
  midlineY: number,
  cfg: CombatAdvanceConfig,
): StagePoint {
  const from = centreOf(home);
  return advanceToward(
    home,
    { x: from.x, y: midlineY },
    cfg.attackerAdvanceFraction,
    toward,
    midlineY,
    cfg,
  );
}

/**
 * A BLOCKER's advanced centre: toward the attacker's ADVANCED centre (see
 * {@link STAGE_ROLE_RULES}), under the same clamp.
 */
export function blockerCentre(
  home: StageRect,
  attackerAdvanced: StagePoint,
  toward: AdvanceDirection,
  midlineY: number,
  cfg: CombatAdvanceConfig,
): StagePoint {
  return advanceToward(home, attackerAdvanced, cfg.blockerAdvanceFraction, toward, midlineY, cfg);
}

/**
 * THE FUNNEL. Every card on the stage, placed, in one pass.
 *
 * Attackers are placed FIRST because a blocker's destination is defined in terms
 * of its attacker's placed one; a blocker whose attacker is not on the stage
 * (it was removed from combat, or the measurement missed its tile) falls back to
 * that attacker's HOME centre rather than being dropped — an honest
 * approximation that still points the right way, and the only case where this
 * module guesses at all.
 */
export function stagePlacements(
  input: StageInput,
  cfg: CombatAdvanceConfig,
): readonly StagePlacement[] {
  const { subjects, midlineY } = input;
  const homes = new Map<InstanceId, StageRect>();
  for (const s of subjects) homes.set(s.instanceId, s.home);

  const advancedById = new Map<InstanceId, StagePoint>();
  const out: StagePlacement[] = [];
  let slot = 0;
  const nextSlot = (): number => {
    const index = Math.min(slot, cfg.maxStaggered - 1);
    slot += 1;
    return index;
  };

  for (const s of subjects) {
    if (s.role !== 'attacker') continue;
    const centre = advancedCentre(s.home, s.toward, midlineY, cfg);
    advancedById.set(s.instanceId, centre);
    out.push({ instanceId: s.instanceId, role: s.role, home: s.home, centre, staggerIndex: nextSlot() });
  }

  for (const s of subjects) {
    if (s.role !== 'blocker') continue;
    const attackerHome = s.meets === undefined ? undefined : homes.get(s.meets);
    const attackerCentre =
      (s.meets === undefined ? undefined : advancedById.get(s.meets)) ??
      (attackerHome === undefined ? undefined : centreOf(attackerHome));
    // No attacker to meet: the blocker stays home. Painting it "forward" at a
    // guessed destination would claim a pairing the board cannot show.
    if (attackerCentre === undefined) continue;
    const centre = blockerCentre(s.home, attackerCentre, s.toward, midlineY, cfg);
    out.push({ instanceId: s.instanceId, role: s.role, home: s.home, centre, staggerIndex: nextSlot() });
  }

  return out;
}

/**
 * "Is this a different picture?" — the same idea as lane G's
 * `measurementSignature`, and for the same reason: the stage re-measures on
 * every commit and on scroll/resize, and a measurement that found nothing new
 * must cost no render.
 *
 * Rounded to whole pixels: sub-pixel jitter from a scroll is not a new picture.
 */
export function placementSignature(placements: readonly StagePlacement[]): string {
  return placements
    .map((p) => `${p.instanceId}:${p.role}:${Math.round(p.centre.x)}:${Math.round(p.centre.y)}:${Math.round(p.home.width)}`)
    .join('|');
}
