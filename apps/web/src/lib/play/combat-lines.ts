/**
 * COMBAT ARCS (§3.143 / UX-14) — the pure, DOM-free half of the combat overlay:
 * WHICH arcs exist this frame, and WHERE each one's curve, arrowhead and stroke
 * go once its two ends have been measured. `CombatLines.tsx` only measures the
 * live DOM and paints what this decides, so every geometric claim in the
 * overlay is unit-testable without a browser.
 *
 * ## The arrowhead convention (one rule, stated once)
 *
 * **An arrowhead marks the object being acted upon.** That single rule covers
 * both kinds:
 * - an **attack** arc runs from the attacker to *what it is attacking* — the
 *   defending player's seat, or the planeswalker/battle named in
 *   `CombatState.attackTargets`;
 * - a **block** arc runs from the blocker to *the attacker it is blocking*.
 *
 * So the arrowhead always sits on the receiving end, and you read a pair by
 * following the point. The two kinds are told apart by colour rather than by
 * direction (`COMBAT_ARC_CONFIG.attackGradient` / `blockGradient`), because the
 * board already codes attacking red and blocking blue (board-clarity.css) and
 * deleting that distinction at the moment a player most needs it would be a
 * regression dressed as a feature.
 *
 * ## Two sources per kind
 *
 * - the engine's DECLARED combat (`combat.attackers`, `combat.blocks`) — the
 *   truth once a declaration is confirmed, visible to both seats;
 * - the local DRAFT still being assembled on this device — drawn thinner and
 *   dashed, so a half-decision never looks committed.
 *
 * ## Refusals are answers
 *
 * Every function here returns `undefined` / drops the row rather than guessing:
 * an attacker whose target cannot be resolved, an end that cannot be measured,
 * two boxes sitting on top of each other. A missing arc is honest; an arc
 * pointing at a place nothing is at is a lie the player would act on.
 */
import { PLAYER_IDS, type InstanceId, type PlayerId } from '@jonny-boi/core';
import type { CombatArcConfig, GradientStop } from './play-config.js';

// ---------------------------------------------------------------------------
// WHICH arcs exist
// ---------------------------------------------------------------------------

/** The kinds of combat relationship an arc can show. Adding one is a row here. */
export const COMBAT_ARC_KINDS = ['attack', 'block'] as const;

/** One relationship kind (see {@link COMBAT_ARC_KINDS}). */
export type CombatArcKind = (typeof COMBAT_ARC_KINDS)[number];

/**
 * Where one end of an arc sits. A tail is always a permanent; a head is a
 * permanent (a blocked attacker, an attacked planeswalker/battle) OR a seat
 * (the defending player), which is why this is a union and not an id.
 */
export type ArcEnd =
  | { readonly at: 'permanent'; readonly instanceId: InstanceId }
  | { readonly at: 'seat'; readonly seat: PlayerId };

/** One arc to draw: tail → head, with the arrowhead at the head. */
export interface CombatArc {
  readonly kind: CombatArcKind;
  /** The TAIL — always a permanent: the attacker (attack) or the blocker (block). */
  readonly from: InstanceId;
  /** The HEAD, where the arrowhead sits: the thing being acted upon. */
  readonly to: ArcEnd;
  /** Committed (engine-declared) vs still being assigned locally. */
  readonly declared: boolean;
}

/**
 * Which steps each arc kind stays on screen for. A ROW per kind, and a step
 * outside a kind's row draws nothing of that kind.
 *
 * The rows differ for a reason worth stating: attackers exist from the moment
 * they are declared, so an attack arc lives through `declareAttackers`; a block
 * cannot exist before `declareBlockers`, so its row starts there. Both run to
 * `endCombat`, which is where the engine clears `state.combat`.
 */
const ARC_STEPS: Readonly<Record<CombatArcKind, ReadonlySet<string>>> = Object.freeze({
  attack: new Set<string>(['declareAttackers', 'declareBlockers', 'combatDamage', 'endCombat']),
  block: new Set<string>(['declareBlockers', 'combatDamage', 'endCombat']),
});

/** The step in which a local, not-yet-confirmed draft of each kind is meaningful. */
const DRAFT_STEPS: Readonly<Record<CombatArcKind, string>> = Object.freeze({
  attack: 'declareAttackers',
  block: 'declareBlockers',
});

/** Seat ids the engine actually defines — anything else resolves to no arc. */
const KNOWN_SEATS: ReadonlySet<string> = new Set<string>(PLAYER_IDS);

/** What one frame of combat looks like, from the board's point of view. */
export interface CombatArcInput {
  readonly step: string;
  /** The engine's committed blocks, when in combat (else undefined/empty). */
  readonly declaredBlocks:
    | ReadonlyArray<{ readonly blocker: InstanceId; readonly attacker: InstanceId }>
    | undefined;
  /** The defender's in-progress assignment (blocker → attacker). */
  readonly draftAssign: ReadonlyMap<InstanceId, InstanceId>;
  /** The engine's committed attackers (`state.combat.attackers`). */
  readonly declaredAttackers?: readonly InstanceId[];
  /**
   * `state.combat.attackTargets` — attacker → what it attacks, present ONLY
   * when that is not the defending player (core keeps it optional and usually
   * absent, which is why an attacker missing from here falls back to
   * {@link CombatArcInput.defendingSeat}).
   */
  readonly attackTargets?: Readonly<Record<InstanceId, InstanceId | PlayerId>>;
  /** The attacker selection this device is still assembling. */
  readonly draftAttackers?: Iterable<InstanceId>;
  /** The draft's non-default attack targets (attacker → planeswalker/battle/seat). */
  readonly draftAttackTargets?: ReadonlyMap<InstanceId, InstanceId | PlayerId>;
  /**
   * The seat being attacked. Pass `opponentOf(state.activePlayer)` — WHO
   * defends is a rules question the engine owns (CR 506.2) and this module
   * deliberately does not re-answer it. Absent ⇒ an attacker with no explicit
   * target draws no arc rather than aiming at a guessed seat.
   */
  readonly defendingSeat?: PlayerId;
}

/**
 * THE FUNNEL: every combat arc for one frame, in PAINT ORDER (later entries
 * draw on top). Attacks are emitted before blocks so a block — the newer, more
 * specific decision — reads over the attack it answers.
 */
export function combatArcPairs(input: CombatArcInput): readonly CombatArc[] {
  const out: CombatArc[] = [];
  appendAttackArcs(out, input);
  appendBlockArcs(out, input);
  return out;
}

/**
 * The block-only view of {@link combatArcPairs}, kept because two boards mount
 * the overlay and only one of them (the hotseat board) knows about attack
 * targets yet. It is an ADAPTER, not a second answer: it delegates, and
 * `combat-lines.test.ts` fails if the two ever disagree.
 */
export function blockerLinePairs(args: {
  readonly step: string;
  readonly declaredBlocks:
    | ReadonlyArray<{ readonly blocker: InstanceId; readonly attacker: InstanceId }>
    | undefined;
  readonly draftAssign: ReadonlyMap<InstanceId, InstanceId>;
}): readonly CombatArc[] {
  return combatArcPairs(args);
}

function appendAttackArcs(out: CombatArc[], input: CombatArcInput): void {
  if (!ARC_STEPS.attack.has(input.step)) return;
  const seen = new Set<InstanceId>();
  for (const attacker of input.declaredAttackers ?? []) {
    const to = attackEnd(input.attackTargets?.[attacker], input.defendingSeat);
    seen.add(attacker);
    if (to) out.push({ kind: 'attack', from: attacker, to, declared: true });
  }
  if (input.step !== DRAFT_STEPS.attack) return;
  for (const attacker of input.draftAttackers ?? []) {
    // A declared attacker's committed arc wins; the draft set usually still
    // holds it (the selection UI does not clear on confirm).
    if (seen.has(attacker)) continue;
    const to = attackEnd(input.draftAttackTargets?.get(attacker), input.defendingSeat);
    if (to) out.push({ kind: 'attack', from: attacker, to, declared: false });
  }
}

function appendBlockArcs(out: CombatArc[], input: CombatArcInput): void {
  if (!ARC_STEPS.block.has(input.step)) return;
  const seen = new Set<InstanceId>();
  for (const block of input.declaredBlocks ?? []) {
    out.push({
      kind: 'block',
      from: block.blocker,
      to: { at: 'permanent', instanceId: block.attacker },
      declared: true,
    });
    seen.add(block.blocker);
  }
  if (input.step !== DRAFT_STEPS.block) return;
  for (const [blocker, attacker] of input.draftAssign) {
    // A draft entry the engine already knows is folded into its declared arc
    // rather than drawn twice.
    if (seen.has(blocker)) continue;
    out.push({
      kind: 'block',
      from: blocker,
      to: { at: 'permanent', instanceId: attacker },
      declared: false,
    });
  }
}

/**
 * Resolve what an attacker points at. `undefined` means "no arc": either the
 * target is a value this build does not recognise, or nothing said which seat
 * is defending. Both REPORT rather than aim at the nearest thing that exists.
 */
function attackEnd(
  target: InstanceId | PlayerId | undefined,
  defendingSeat: PlayerId | undefined,
): ArcEnd | undefined {
  if (target !== undefined) return arcEndFor(target);
  return defendingSeat === undefined ? undefined : { at: 'seat', seat: defendingSeat };
}

/**
 * `InstanceId | PlayerId` is `number | 'A' | 'B'`, so the discriminator is the
 * runtime type — but a state deserialized from an older build could carry a
 * seat string core no longer defines, and that must draw nothing rather than
 * being coerced to a seat that happens to exist.
 */
function arcEndFor(target: InstanceId | PlayerId): ArcEnd | undefined {
  if (typeof target === 'number') return { at: 'permanent', instanceId: target };
  return KNOWN_SEATS.has(target) ? { at: 'seat', seat: target } : undefined;
}

/** A stable React key for an arc — unique per (kind, tail, head). */
export function arcKey(arc: CombatArc): string {
  const head = arc.to.at === 'permanent' ? `p${arc.to.instanceId}` : `s${arc.to.seat}`;
  return `${arc.kind}:${arc.from}:${head}`;
}

// ---------------------------------------------------------------------------
// The debug bench (CLAUDE.md rule 3)
// ---------------------------------------------------------------------------

/**
 * Tile ids the effects bench should hang `data-perm-id` on to drive
 * {@link COMBAT_ARC_BENCH_ARCS}.
 *
 * NEGATIVE on purpose: `InstanceId` is a positive counter the engine hands out,
 * so these can never be confused with a real permanent if a bench stage is ever
 * mounted beside a live board.
 */
export const COMBAT_ARC_BENCH_TILE_IDS = Object.freeze({
  attacker: -101,
  secondAttacker: -102,
  defender: -103,
  blocker: -104,
  secondBlocker: -105,
});

/**
 * A bench fixture covering every way an arc can look: both kinds, both
 * commitments, both kinds of head.
 *
 * `EffectsPreview.tsx` is not in this lane, so this is the half that CAN ship
 * here — the bench owner needs no knowledge of arc internals to wire it:
 *
 * 1. render one stage element per {@link COMBAT_ARC_BENCH_TILE_IDS} value,
 *    each carrying `data-perm-id="<id>"`;
 * 2. put `data-anim-anchor="board:A"` on the stage's far edge, which is what
 *    the seat-ended arrow aims at (see `SEAT_ANCHORS` in `CombatLines.tsx`);
 * 3. mount the REAL `<CombatLines lines={COMBAT_ARC_BENCH_ARCS} …>` over it.
 *
 * Mounting the real component rather than a mock is the point: a bench that
 * draws its own arcs is a second answer that can look right while the board
 * looks wrong.
 */
export const COMBAT_ARC_BENCH_ARCS: readonly CombatArc[] = Object.freeze([
  Object.freeze<CombatArc>({
    kind: 'attack',
    from: COMBAT_ARC_BENCH_TILE_IDS.attacker,
    to: { at: 'permanent', instanceId: COMBAT_ARC_BENCH_TILE_IDS.defender },
    declared: true,
  }),
  Object.freeze<CombatArc>({
    kind: 'attack',
    from: COMBAT_ARC_BENCH_TILE_IDS.secondAttacker,
    to: { at: 'seat', seat: 'A' },
    declared: false,
  }),
  Object.freeze<CombatArc>({
    kind: 'block',
    from: COMBAT_ARC_BENCH_TILE_IDS.blocker,
    to: { at: 'permanent', instanceId: COMBAT_ARC_BENCH_TILE_IDS.attacker },
    declared: true,
  }),
  Object.freeze<CombatArc>({
    kind: 'block',
    from: COMBAT_ARC_BENCH_TILE_IDS.secondBlocker,
    to: { at: 'permanent', instanceId: COMBAT_ARC_BENCH_TILE_IDS.attacker },
    declared: false,
  }),
]);

// ---------------------------------------------------------------------------
// WHERE each arc goes — pure geometry over measured rects
// ---------------------------------------------------------------------------

/**
 * A measured box, in the SAME coordinate space for every end of every arc.
 *
 * ⚠️ That space is the VIEWPORT — exactly what `getBoundingClientRect()`
 * returns — and nothing here ever subtracts a container's origin. That is what
 * makes the overlay survive UX-9's 3D scene: a `rotateX` on an ancestor makes
 * `getBoundingClientRect()` report the PROJECTED box, and a projected tile rect
 * minus an UNprojected container rect is a mix of two spaces. Measuring and
 * drawing in one space has no such seam. See `CombatLines.tsx` for the other
 * half of that promise (the overlay is portalled out of the transformed
 * subtree, so its own fixed positioning is viewport-relative too).
 */
export interface MeasuredRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** A point in the same viewport space as {@link MeasuredRect}. */
export interface Point {
  readonly x: number;
  readonly y: number;
}

/** One arc, ready to paint. */
export interface ArcSegment {
  readonly key: string;
  readonly kind: CombatArcKind;
  readonly declared: boolean;
  /** Tail, on the source box's edge — not its centre, so the card stays visible. */
  readonly start: Point;
  /** Arrowhead TIP, on the target box's edge. */
  readonly end: Point;
  /** The quadratic's control point (the bow). */
  readonly control: Point;
  /** `d` for the curve: `M start Q control end`. */
  readonly path: string;
  /** `points` for the arrowhead triangle, tip first. */
  readonly arrowPoints: string;
}

/** How a pair's commitment is drawn. One ROW per commitment. */
type ArcCommitment = 'declared' | 'draft';

/** The stroke a commitment wears. */
export interface ArcStroke {
  readonly widthPx: number;
  /** SVG `stroke-dasharray`, or `undefined` for a solid stroke. */
  readonly dashArray: string | undefined;
}

const ARC_STROKES: Readonly<Record<ArcCommitment, (cfg: CombatArcConfig) => ArcStroke>> =
  Object.freeze({
    declared: (cfg) => ({ widthPx: cfg.strokeWidthPx, dashArray: undefined }),
    draft: (cfg) => ({ widthPx: cfg.draftStrokeWidthPx, dashArray: cfg.draftDashArray }),
  });

/** The stroke for a pair: solid and full width when declared, thin and dashed while drafting. */
export function arcStroke(declared: boolean, cfg: CombatArcConfig): ArcStroke {
  return ARC_STROKES[declared ? 'declared' : 'draft'](cfg);
}

const ARC_GRADIENTS: Readonly<Record<CombatArcKind, (cfg: CombatArcConfig) => readonly GradientStop[]>> =
  Object.freeze({
    attack: (cfg) => cfg.attackGradient,
    block: (cfg) => cfg.blockGradient,
  });

/**
 * The colour ramp for a kind. TOTAL over {@link COMBAT_ARC_KINDS} by
 * construction — the mapped type means adding a kind stops the build here
 * rather than shipping an arc with no colour.
 */
export function arcGradient(kind: CombatArcKind, cfg: CombatArcConfig): readonly GradientStop[] {
  return ARC_GRADIENTS[kind](cfg);
}

/**
 * Decimal places kept in the emitted `d`/`points` strings. Two is below what
 * any display can resolve, and the shorter string is less DOM text for React to
 * diff on every re-measure — this runs once per tile per measurement pass.
 */
const ARC_PATH_DECIMALS = 2;

/**
 * Geometry for one arc, or `undefined` when there is nothing honest to draw.
 *
 * The curve is a quadratic Bézier bowed off the chord by
 * `min(chord × bowChordFraction, maxBowPx)` — a FRACTION so a short arc between
 * neighbouring tiles and a long one across the board have the same character,
 * and a pixel CEILING so the widest arc on a wide monitor cannot balloon over
 * the seat panels.
 *
 * The bow always goes to the LEFT of the direction of travel. Deterministic on
 * purpose: an alternating or index-derived sign would flip an arc to the other
 * side of the board when an unrelated pair was added, and a line that moves for
 * no reason is worse than one that curves the "wrong" way.
 *
 * Both ends are then pulled back to their box's EDGE, along the ray toward the
 * control point — so the tail leaves the source card and the arrowhead lands ON
 * the target card instead of being buried in the middle of its art. Because the
 * endpoints move but the control point does not, the drawn curve's terminal
 * tangent is exactly `end - control`, which is what the arrowhead is rotated to.
 */
export function arcSegment(
  arc: CombatArc,
  fromRect: MeasuredRect,
  toRect: MeasuredRect,
  cfg: CombatArcConfig,
): ArcSegment | undefined {
  const tail = centreOf(fromRect);
  const head = centreOf(toRect);
  const chordX = head.x - tail.x;
  const chordY = head.y - tail.y;
  const chord = Math.hypot(chordX, chordY);
  // Coincident centres: there is no direction to bow along and no relationship
  // a curve could show. Refuse rather than emit NaN.
  if (chord === 0) return undefined;

  const bow = Math.min(chord * cfg.bowChordFraction, cfg.maxBowPx);
  // Left of travel in screen coordinates (y grows downward): rotate the unit
  // chord by -90°.
  const control: Point = {
    x: (tail.x + head.x) / 2 + (chordY / chord) * bow,
    y: (tail.y + head.y) / 2 + (-chordX / chord) * bow,
  };

  const start = rectExit(fromRect, tail, control.x - tail.x, control.y - tail.y);
  const end = rectExit(toRect, head, control.x - head.x, control.y - head.y);

  // If pulling both ends back to their edges reversed the direction of travel,
  // the two boxes overlap: an advancing attacker standing on its blocker. The
  // outline styling still says who is fighting whom; an arc here would be noise
  // pointing backwards.
  if ((end.x - start.x) * chordX + (end.y - start.y) * chordY <= 0) return undefined;

  const tipX = end.x - control.x;
  const tipY = end.y - control.y;
  const tip = Math.hypot(tipX, tipY);
  if (tip === 0) return undefined;

  const dirX = tipX / tip;
  const dirY = tipY / tip;
  const baseX = end.x - dirX * cfg.arrowHeadLengthPx;
  const baseY = end.y - dirY * cfg.arrowHeadLengthPx;
  const halfWidth = cfg.arrowHeadWidthPx / 2;

  return {
    key: arcKey(arc),
    kind: arc.kind,
    declared: arc.declared,
    start,
    end,
    control,
    path: `M ${n(start.x)} ${n(start.y)} Q ${n(control.x)} ${n(control.y)} ${n(end.x)} ${n(end.y)}`,
    arrowPoints: [
      `${n(end.x)},${n(end.y)}`,
      `${n(baseX - dirY * halfWidth)},${n(baseY + dirX * halfWidth)}`,
      `${n(baseX + dirY * halfWidth)},${n(baseY - dirX * halfWidth)}`,
    ].join(' '),
  };
}

/** One measurement pass: the arcs to paint, and the box to clip them to. */
export interface Measurement {
  readonly segments: readonly ArcSegment[];
  /** The board's visible box, in the same viewport space. `null` = nothing measured. */
  readonly clip: MeasuredRect | null;
}

/** The empty picture, as a stable identity so re-committing it re-renders nothing. */
export const EMPTY_MEASUREMENT: Measurement = Object.freeze({ segments: [], clip: null });

/**
 * A cheap identity for a measurement — "is this a different picture?".
 *
 * ⚠️ It must cover EVERYTHING the overlay paints, not just the coordinates. A
 * block that is confirmed while its tiles happen not to move changes nothing
 * geometric and everything about what the player is being told, so `declared`
 * is part of the identity; without it the arcs would stay dashed after the
 * decision landed. The class this guards is "a change the player should see
 * does not trigger a repaint", and `combat-lines.test.ts` pins it.
 */
export function measurementSignature(measurement: Measurement): string {
  const clip = measurement.clip;
  const head = clip === null ? '-' : `${clip.left},${clip.top},${clip.width},${clip.height}`;
  const body = measurement.segments
    .map((s) => `${s.key}|${s.declared ? 'declared' : 'draft'}|${s.path}|${s.arrowPoints}`)
    .join('~');
  return `${head}#${body}`;
}

/**
 * Every arc that can be drawn, in the order given. `measure` answers "where is
 * this end, in viewport coordinates"; an end it cannot answer for contributes
 * no arc — the overlay is decoration and must never be the reason something
 * breaks.
 */
export function arcSegments(
  arcs: readonly CombatArc[],
  measure: (end: ArcEnd) => MeasuredRect | undefined,
  cfg: CombatArcConfig,
): readonly ArcSegment[] {
  const out: ArcSegment[] = [];
  for (const arc of arcs) {
    const fromRect = measure({ at: 'permanent', instanceId: arc.from });
    if (!fromRect) continue;
    const toRect = measure(arc.to);
    if (!toRect) continue;
    const segment = arcSegment(arc, fromRect, toRect, cfg);
    if (segment) out.push(segment);
  }
  return out;
}

/**
 * How far `stroke-dashoffset` must travel for a dash pattern to land back on
 * itself — the ember loop's distance, derived from the pattern rather than
 * typed as a second copy of the same number.
 *
 * SVG repeats an ODD-length dasharray twice to make a full cycle (CR-equivalent
 * rule: SVG 1.1 §11.4), so `'6 5 3'` cycles over 28, not 14. Returns 0 for a
 * pattern with no positive length, which the caller reads as "no ember loop".
 */
export function dashCycleLength(dashArray: string): number {
  const parts = dashArray
    .split(/[\s,]+/)
    .filter((part) => part.length > 0)
    .map(Number);
  if (parts.length === 0 || parts.some((value) => !Number.isFinite(value) || value < 0)) return 0;
  const sum = parts.reduce((total, value) => total + value, 0);
  if (sum <= 0) return 0;
  return parts.length % 2 === 0 ? sum : sum * 2;
}

function centreOf(rect: MeasuredRect): Point {
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

/**
 * Where a ray leaves a box: from a point inside it, travelling along
 * (`dx`, `dy`), the first point on the box's boundary. The slab method — one
 * candidate distance per axis, the nearer one wins.
 *
 * A zero-area box, or a zero direction, has no exit; the origin is returned
 * unchanged so the caller still gets a usable point instead of a NaN.
 */
function rectExit(rect: MeasuredRect, from: Point, dx: number, dy: number): Point {
  const toEdge = (delta: number, low: number, high: number, at: number): number => {
    if (delta > 0) return (high - at) / delta;
    if (delta < 0) return (low - at) / delta;
    return Number.POSITIVE_INFINITY;
  };
  const t = Math.min(
    toEdge(dx, rect.left, rect.left + rect.width, from.x),
    toEdge(dy, rect.top, rect.top + rect.height, from.y),
  );
  if (!Number.isFinite(t) || t <= 0) return from;
  return { x: from.x + dx * t, y: from.y + dy * t };
}

/** Round a coordinate for the emitted path string (see {@link ARC_PATH_DECIMALS}). */
function n(value: number): string {
  return Number(value.toFixed(ARC_PATH_DECIMALS)).toString();
}
