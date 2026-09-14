/**
 * §3.143 / UX-14 — the fiery combat arcs.
 *
 * Two halves, both pure and both pinned here: WHICH arcs exist for a frame, and
 * WHERE each one's curve, arrowhead and stroke land once its ends are measured.
 * The geometry tests matter more than they look: they are the guard for the
 * class "the overlay silently mis-draws when the board gets a 3D transform",
 * which cannot be caught by looking at a screenshot of a flat board.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { STEP_ORDER } from '@jonny-boi/core';

import {
  COMBAT_ARC_BENCH_ARCS,
  COMBAT_ARC_BENCH_TILE_IDS,
  COMBAT_ARC_KINDS,
  EMPTY_MEASUREMENT,
  arcGradient,
  arcKey,
  arcSegment,
  arcSegments,
  arcStroke,
  blockerLinePairs,
  combatArcPairs,
  dashCycleLength,
  measurementSignature,
  type ArcEnd,
  type CombatArc,
  type MeasuredRect,
  type Measurement,
} from './combat-lines.js';
import { COMBAT_ARC_CONFIG } from './play-config.js';

const NO_DRAFT = new Map<number, number>();
const CFG = COMBAT_ARC_CONFIG;

const perm = (instanceId: number): ArcEnd => ({ at: 'permanent', instanceId });
const seat = (id: 'A' | 'B'): ArcEnd => ({ at: 'seat', seat: id });

// ---------------------------------------------------------------------------
// WHICH arcs exist
// ---------------------------------------------------------------------------

describe('combatArcPairs — block arcs', () => {
  it('draws the local draft (thin/dashed) while declaring blockers', () => {
    const arcs = combatArcPairs({
      step: 'declareBlockers',
      declaredBlocks: [],
      draftAssign: new Map([
        [21, 31],
        [22, 31],
      ]),
    });
    expect(arcs).toEqual([
      { kind: 'block', from: 21, to: perm(31), declared: false },
      { kind: 'block', from: 22, to: perm(31), declared: false },
    ]);
  });

  it('draws declared blocks through damage and end of combat', () => {
    for (const step of ['declareBlockers', 'combatDamage', 'endCombat']) {
      const arcs = combatArcPairs({
        step,
        declaredBlocks: [{ blocker: 21, attacker: 31 }],
        draftAssign: NO_DRAFT,
      });
      expect(arcs, step).toEqual([{ kind: 'block', from: 21, to: perm(31), declared: true }]);
    }
  });

  it('a declared block wins over a stale draft entry for the same blocker', () => {
    const arcs = combatArcPairs({
      step: 'declareBlockers',
      declaredBlocks: [{ blocker: 21, attacker: 31 }],
      draftAssign: new Map([[21, 32]]),
    });
    expect(arcs).toEqual([{ kind: 'block', from: 21, to: perm(31), declared: true }]);
  });

  it('draws nothing outside combat steps, and no draft after the declare step', () => {
    expect(
      combatArcPairs({
        step: 'precombatMain',
        declaredBlocks: [{ blocker: 1, attacker: 2 }],
        draftAssign: NO_DRAFT,
      }),
    ).toEqual([]);
    expect(
      combatArcPairs({
        step: 'combatDamage',
        declaredBlocks: undefined,
        draftAssign: new Map([[21, 31]]),
      }),
    ).toEqual([]);
  });
});

describe('combatArcPairs — attack arcs', () => {
  const ATTACK: Pick<Parameters<typeof combatArcPairs>[0], 'declaredBlocks' | 'draftAssign'> = {
    declaredBlocks: undefined,
    draftAssign: NO_DRAFT,
  };

  it('an attacker with no explicit target points at the defending seat', () => {
    expect(
      combatArcPairs({
        ...ATTACK,
        step: 'declareAttackers',
        declaredAttackers: [7],
        defendingSeat: 'B',
      }),
    ).toEqual([{ kind: 'attack', from: 7, to: seat('B'), declared: true }]);
  });

  it('an attacker with an explicit permanent target points at that permanent', () => {
    expect(
      combatArcPairs({
        ...ATTACK,
        step: 'declareBlockers',
        declaredAttackers: [7],
        attackTargets: { 7: 55 },
        defendingSeat: 'B',
      }),
    ).toEqual([{ kind: 'attack', from: 7, to: perm(55), declared: true }]);
  });

  it('an explicit SEAT target is honoured over the default defending seat', () => {
    expect(
      combatArcPairs({
        ...ATTACK,
        step: 'declareAttackers',
        declaredAttackers: [7],
        attackTargets: { 7: 'A' },
        defendingSeat: 'B',
      }),
    ).toEqual([{ kind: 'attack', from: 7, to: seat('A'), declared: true }]);
  });

  it('REFUSES rather than guessing: no defending seat, and a seat id core does not define', () => {
    // Nothing said who is defending — an arrow to a guessed seat would be a lie
    // the player acts on, so there is no arrow.
    expect(
      combatArcPairs({ ...ATTACK, step: 'declareAttackers', declaredAttackers: [7] }),
    ).toEqual([]);
    // A state from another build naming a seat this one has never heard of.
    expect(
      combatArcPairs({
        ...ATTACK,
        step: 'declareAttackers',
        declaredAttackers: [7],
        attackTargets: { 7: 'Z' as 'A' },
        defendingSeat: 'B',
      }),
    ).toEqual([]);
  });

  it('draws the local draft while declaring attackers, and the declaration wins over it', () => {
    expect(
      combatArcPairs({
        ...ATTACK,
        step: 'declareAttackers',
        draftAttackers: [7, 8],
        draftAttackTargets: new Map([[8, 55]]),
        defendingSeat: 'B',
      }),
    ).toEqual([
      { kind: 'attack', from: 7, to: seat('B'), declared: false },
      { kind: 'attack', from: 8, to: perm(55), declared: false },
    ]);
    // The selection UI does not clear on confirm, so the same id is in both.
    expect(
      combatArcPairs({
        ...ATTACK,
        step: 'declareAttackers',
        declaredAttackers: [7],
        draftAttackers: [7],
        defendingSeat: 'B',
      }),
    ).toEqual([{ kind: 'attack', from: 7, to: seat('B'), declared: true }]);
  });

  it('each kind shows at exactly its own steps — checked against the ENGINE\'s whole step order', () => {
    // Not a hand-picked few steps: every step the engine has. A step added to
    // core is covered here the day it is added, so an arc cannot quietly start
    // (or stop) showing somewhere nobody listed.
    const attackSteps = new Set(['declareAttackers', 'declareBlockers', 'combatDamage', 'endCombat']);
    // A block cannot exist before blockers are declared, so its row starts one
    // step later than the attack's — that difference is the point of two rows.
    const blockSteps = new Set(['declareBlockers', 'combatDamage', 'endCombat']);
    for (const step of STEP_ORDER) {
      expect(
        combatArcPairs({ ...ATTACK, step, declaredAttackers: [7], defendingSeat: 'B' }).length,
        `attack @ ${step}`,
      ).toBe(attackSteps.has(step) ? 1 : 0);
      expect(
        combatArcPairs({
          step,
          declaredBlocks: [{ blocker: 21, attacker: 31 }],
          draftAssign: NO_DRAFT,
        }).length,
        `block @ ${step}`,
      ).toBe(blockSteps.has(step) ? 1 : 0);
    }
  });

  it('attacks paint first so a block reads over the attack it answers', () => {
    const arcs = combatArcPairs({
      step: 'declareBlockers',
      declaredAttackers: [7],
      defendingSeat: 'B',
      declaredBlocks: [{ blocker: 21, attacker: 7 }],
      draftAssign: NO_DRAFT,
    });
    expect(arcs.map((a) => a.kind)).toEqual(['attack', 'block']);
  });

  it('every arc in one frame gets a distinct React key', () => {
    const arcs = combatArcPairs({
      step: 'declareBlockers',
      declaredAttackers: [7, 8],
      attackTargets: { 8: 55 },
      defendingSeat: 'B',
      declaredBlocks: [
        { blocker: 21, attacker: 7 },
        { blocker: 22, attacker: 7 },
      ],
      draftAssign: NO_DRAFT,
    });
    const keys = arcs.map(arcKey);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toContain('attack:7:sB');
    expect(keys).toContain('block:21:p7');
  });
});

describe('blockerLinePairs is an ADAPTER, not a second answer', () => {
  // The online board still calls the block-only entry point. If it ever stops
  // delegating, the two will drift and the bug will be attributed to neither.
  //
  // Driven off the ENGINE's own step list rather than a hand-picked few: a step
  // added to core is covered here the day it is added, which is the only way a
  // fork at an unlisted step cannot hide.
  const shapes = [
    { declaredBlocks: [{ blocker: 21, attacker: 31 }], draftAssign: new Map([[22, 32]]) },
    { declaredBlocks: [{ blocker: 1, attacker: 2 }], draftAssign: NO_DRAFT },
    { declaredBlocks: undefined, draftAssign: new Map([[5, 6]]) },
    { declaredBlocks: [], draftAssign: NO_DRAFT },
  ] as const;
  for (const step of STEP_ORDER) {
    it(`agrees with combatArcPairs at ${step}`, () => {
      for (const shape of shapes) {
        const input = { ...shape, step };
        expect(blockerLinePairs(input), step).toEqual(combatArcPairs(input));
      }
    });
  }
});

// ---------------------------------------------------------------------------
// WHERE each arc goes
// ---------------------------------------------------------------------------

const rect = (left: number, top: number, width = 80, height = 112): MeasuredRect => ({
  left,
  top,
  width,
  height,
});

const ARC: CombatArc = { kind: 'block', from: 21, to: perm(31), declared: true };

/** Is `point` on `rect`'s boundary (within a sub-pixel tolerance)? */
function onBoundary(box: MeasuredRect, point: { x: number; y: number }): boolean {
  const right = box.left + box.width;
  const bottom = box.top + box.height;
  const near = (a: number, b: number): boolean => Math.abs(a - b) < BOUNDARY_EPS;
  const insideX = point.x >= box.left - BOUNDARY_EPS && point.x <= right + BOUNDARY_EPS;
  const insideY = point.y >= box.top - BOUNDARY_EPS && point.y <= bottom + BOUNDARY_EPS;
  return (
    ((near(point.x, box.left) || near(point.x, right)) && insideY) ||
    ((near(point.y, box.top) || near(point.y, bottom)) && insideX)
  );
}

/** The emitted path rounds to 2dp, so a boundary test needs more room than 0. */
const BOUNDARY_EPS = 0.02;

describe('arcSegment geometry', () => {
  it('bows off the chord by the configured fraction, to the LEFT of travel', () => {
    // Travelling straight right: left of travel is UP the screen (smaller y).
    const segment = arcSegment(ARC, rect(0, 0, 10, 10), rect(400, 0, 10, 10), CFG);
    expect(segment).toBeDefined();
    const chord = 400;
    expect(segment!.control.x).toBeCloseTo(205, 6);
    expect(segment!.control.y).toBeCloseTo(5 - chord * CFG.bowChordFraction, 6);
  });

  it('clamps the bow at maxBowPx so a wide monitor cannot balloon an arc', () => {
    const far = CFG.maxBowPx / CFG.bowChordFraction + 1000;
    const segment = arcSegment(ARC, rect(0, 0, 10, 10), rect(far, 0, 10, 10), CFG);
    expect(segment!.control.y).toBeCloseTo(5 - CFG.maxBowPx, 6);
  });

  it('the same pair always bows the same way — the sign never depends on order', () => {
    const a = arcSegment(ARC, rect(0, 0, 10, 10), rect(400, 0, 10, 10), CFG)!;
    const b = arcSegment({ ...ARC, from: 99 }, rect(0, 0, 10, 10), rect(400, 0, 10, 10), CFG)!;
    expect(b.control).toEqual(a.control);
  });

  it('both ends sit ON their box, not in the middle of the card art', () => {
    const from = rect(100, 600);
    const to = rect(500, 120);
    const segment = arcSegment(ARC, from, to, CFG)!;
    expect(onBoundary(from, segment.start)).toBe(true);
    expect(onBoundary(to, segment.end)).toBe(true);
  });

  it('the arrowhead is a triangle at the head, rotated to the curve it terminates', () => {
    const to = rect(500, 120);
    const segment = arcSegment(ARC, rect(100, 600), to, CFG)!;
    const points = segment.arrowPoints.split(' ').map((pair) => {
      const [x, y] = pair.split(',').map(Number);
      return { x: x ?? Number.NaN, y: y ?? Number.NaN };
    });
    const [tip, wingA, wingB] = points;
    if (!tip || !wingA || !wingB || points.length !== 3) {
      throw new Error(`expected a 3-point triangle, got "${segment.arrowPoints}"`);
    }
    // The tip is the arc's end.
    expect(tip.x).toBeCloseTo(segment.end.x, 2);
    expect(tip.y).toBeCloseTo(segment.end.y, 2);
    // The base midpoint sits one arrow-length back along the TERMINAL TANGENT
    // (end − control), which is what makes the head follow the bow rather than
    // the straight chord.
    const tangentX = segment.end.x - segment.control.x;
    const tangentY = segment.end.y - segment.control.y;
    const tangent = Math.hypot(tangentX, tangentY);
    expect((wingA.x + wingB.x) / 2).toBeCloseTo(
      segment.end.x - (tangentX / tangent) * CFG.arrowHeadLengthPx,
      1,
    );
    expect((wingA.y + wingB.y) / 2).toBeCloseTo(
      segment.end.y - (tangentY / tangent) * CFG.arrowHeadLengthPx,
      1,
    );
    expect(Math.hypot(wingA.x - wingB.x, wingA.y - wingB.y)).toBeCloseTo(CFG.arrowHeadWidthPx, 1);
  });

  it('emits a quadratic path through the control point', () => {
    const segment = arcSegment(ARC, rect(0, 0, 10, 10), rect(400, 0, 10, 10), CFG)!;
    expect(segment.path).toMatch(/^M [-\d.]+ [-\d.]+ Q [-\d.]+ [-\d.]+ [-\d.]+ [-\d.]+$/);
    expect(segment.path).toContain(`Q ${round2(segment.control.x)} ${round2(segment.control.y)}`);
  });

  it('REFUSES rather than emitting NaN: coincident centres, and boxes on top of each other', () => {
    expect(arcSegment(ARC, rect(10, 10), rect(10, 10), CFG)).toBeUndefined();
    // An advancing attacker standing on its blocker: pulling both ends back to
    // their edges reverses the direction of travel, so there is no arc to draw.
    expect(arcSegment(ARC, rect(100, 100), rect(104, 100), CFG)).toBeUndefined();
  });
});

describe('arcSegment under a 3D-projected board (the UX-9 guard)', () => {
  // `getBoundingClientRect()` on a 3D-transformed ancestor returns the PROJECTED
  // box in VIEWPORT coordinates. These two tests pin the two properties that
  // make the overlay survive that — and they are the tests that fail the day
  // somebody reintroduces a container-origin subtraction.

  it('depends only on where the boxes are RELATIVE to each other', () => {
    // Move the whole board and every arc moves with it, unchanged in shape. No
    // absolute viewport position (a window size, a scroll offset, a container
    // origin) can have crept into the maths and still let this hold.
    const from = rect(100, 600);
    const to = rect(500, 120);
    const dx = 137;
    const dy = -49;
    const base = arcSegment(ARC, from, to, CFG)!;
    const moved = arcSegment(
      ARC,
      { ...from, left: from.left + dx, top: from.top + dy },
      { ...to, left: to.left + dx, top: to.top + dy },
      CFG,
    )!;
    for (const key of ['start', 'end', 'control'] as const) {
      expect(moved[key].x, key).toBeCloseTo(base[key].x + dx, 6);
      expect(moved[key].y, key).toBeCloseTo(base[key].y + dy, 6);
    }
  });

  it('still lands on the box when the box is foreshortened and shifted by the tilt', () => {
    // What a rotateX does to the far row: shorter, narrower, moved up-screen.
    const projected = (box: MeasuredRect): MeasuredRect => ({
      left: box.left + 18,
      top: box.top - 41,
      width: box.width * 0.92,
      height: box.height * 0.71,
    });
    const from = projected(rect(100, 600));
    const to = projected(rect(500, 120));
    const segment = arcSegment(ARC, from, to, CFG)!;
    expect(onBoundary(from, segment.start)).toBe(true);
    expect(onBoundary(to, segment.end)).toBe(true);
  });
});

describe('arcSegments', () => {
  const RECTS: Readonly<Record<string, MeasuredRect>> = {
    p21: rect(100, 600),
    p31: rect(500, 120),
    sB: rect(400, 20, 120, 40),
  };
  const measure = (end: ArcEnd): MeasuredRect | undefined =>
    RECTS[end.at === 'permanent' ? `p${end.instanceId}` : `s${end.seat}`];

  it('measures both ends and keeps the input order', () => {
    const arcs: CombatArc[] = [
      { kind: 'attack', from: 31, to: seat('B'), declared: true },
      { kind: 'block', from: 21, to: perm(31), declared: false },
    ];
    const segments = arcSegments(arcs, measure, CFG);
    expect(segments.map((s) => s.kind)).toEqual(['attack', 'block']);
    expect(segments.map((s) => s.declared)).toEqual([true, false]);
  });

  it('an end that cannot be measured contributes NO arc — never a crash, never a guess', () => {
    const arcs: CombatArc[] = [
      { kind: 'block', from: 21, to: perm(9999), declared: true },
      { kind: 'block', from: 9999, to: perm(31), declared: true },
      { kind: 'attack', from: 21, to: seat('A'), declared: true },
      { kind: 'block', from: 21, to: perm(31), declared: true },
    ];
    expect(arcSegments(arcs, measure, CFG)).toHaveLength(1);
  });
});

describe('measurementSignature — "is this a different picture?"', () => {
  const RECTS: Readonly<Record<string, MeasuredRect>> = { p21: rect(100, 600), p31: rect(500, 120) };
  const measure = (end: ArcEnd): MeasuredRect | undefined =>
    end.at === 'permanent' ? RECTS[`p${end.instanceId}`] : undefined;
  const pictureFor = (declared: boolean): Measurement => ({
    segments: arcSegments([{ kind: 'block', from: 21, to: perm(31), declared }], measure, CFG),
    clip: rect(0, 0, 1400, 900),
  });

  it('a block CONFIRMED without its tiles moving is a different picture', () => {
    // THE CLASS: a change the player should see that does not trigger a
    // repaint. Confirming a block while the board happens not to shift changes
    // no coordinate and every bit of what the arcs are telling you — without
    // this, the arcs would stay dashed after the decision landed.
    expect(pictureFor(true).segments).toHaveLength(1);
    expect(pictureFor(true).segments[0]?.path).toBe(pictureFor(false).segments[0]?.path);
    expect(measurementSignature(pictureFor(true))).not.toBe(
      measurementSignature(pictureFor(false)),
    );
  });

  it('the same picture measured twice is the same signature, and an empty one is stable', () => {
    expect(measurementSignature(pictureFor(true))).toBe(measurementSignature(pictureFor(true)));
    expect(measurementSignature(EMPTY_MEASUREMENT)).toBe(
      measurementSignature({ segments: [], clip: null }),
    );
  });

  it('the board moving under the arcs is a different picture', () => {
    const scrolled: Measurement = { ...pictureFor(true), clip: rect(0, -120, 1400, 900) };
    expect(measurementSignature(scrolled)).not.toBe(measurementSignature(pictureFor(true)));
  });
});

describe('the styling tables', () => {
  it('a declared pair is solid and full width; a draft one is thinner and dashed', () => {
    expect(arcStroke(true, CFG)).toEqual({ widthPx: CFG.strokeWidthPx, dashArray: undefined });
    expect(arcStroke(false, CFG)).toEqual({
      widthPx: CFG.draftStrokeWidthPx,
      dashArray: CFG.draftDashArray,
    });
    // "Distinct" has to stay TRUE, not merely be intended.
    expect(arcStroke(false, CFG).widthPx).toBeLessThan(arcStroke(true, CFG).widthPx);
    expect(arcStroke(false, CFG).dashArray).not.toBe(arcStroke(true, CFG).dashArray);
  });

  it('every arc kind has a colour ramp — the table is TOTAL', () => {
    for (const kind of COMBAT_ARC_KINDS) {
      const ramp = arcGradient(kind, CFG);
      expect(ramp.length, kind).toBeGreaterThan(1);
      // The ends are load-bearing: the component reads stop 0 as the source
      // colour and the LAST stop as the ember colour.
      expect(ramp[0]?.offsetFraction, kind).toBe(0);
      expect(ramp[ramp.length - 1]?.offsetFraction, kind).toBe(1);
    }
  });
});

describe('the debug bench fixture (rule 3)', () => {
  it('covers every kind × commitment, and both kinds of arrowhead end', () => {
    // A bench that shows three of the four looks is how a broken fourth ships.
    const looks = new Set(COMBAT_ARC_BENCH_ARCS.map((arc) => `${arc.kind}:${arc.declared}`));
    for (const kind of COMBAT_ARC_KINDS) {
      for (const declared of [true, false]) {
        expect(looks, `${kind} ${declared ? 'declared' : 'draft'}`).toContain(`${kind}:${declared}`);
      }
    }
    const ends = new Set(COMBAT_ARC_BENCH_ARCS.map((arc) => arc.to.at));
    expect(ends).toEqual(new Set(['permanent', 'seat']));
  });

  it('uses ids no live board can hand out, and names every tile the stage must render', () => {
    const ids = Object.values(COMBAT_ARC_BENCH_TILE_IDS);
    expect(ids.every((id) => id < 0)).toBe(true);
    // Every end the fixture names must be in the published tile list, or the
    // bench silently draws fewer arcs than it claims to.
    const named = new Set<number>(ids);
    for (const arc of COMBAT_ARC_BENCH_ARCS) {
      expect(named, `tail ${arc.from}`).toContain(arc.from);
      if (arc.to.at === 'permanent') expect(named, `head ${arc.to.instanceId}`).toContain(arc.to.instanceId);
    }
  });
});

describe('dashCycleLength', () => {
  it('an even pattern cycles over its sum; an ODD one repeats twice (SVG 1.1 §11.4)', () => {
    expect(dashCycleLength('10 14')).toBe(24);
    expect(dashCycleLength('6,5')).toBe(11);
    expect(dashCycleLength('6 5 3')).toBe(28);
  });

  it('a pattern with no length reports 0, which the caller reads as "no ember loop"', () => {
    expect(dashCycleLength('')).toBe(0);
    expect(dashCycleLength('0 0')).toBe(0);
    expect(dashCycleLength('none')).toBe(0);
    expect(dashCycleLength('-4 2')).toBe(0);
  });

  it('the shipped ember pattern loops seamlessly', () => {
    expect(dashCycleLength(CFG.emberDashArray)).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// The structural guards — the claims that live in the component and its CSS
// ---------------------------------------------------------------------------

/**
 * Read a source file with comments stripped, so PROSE about a rule can never
 * satisfy an assertion about the rule. CRLF is normalized first: these files
 * are CRLF on a Windows checkout and LF in git (CLAUDE.md), and a byte compare
 * without this false-alarms on every Windows clone.
 *
 * (Deliberately a local, six-line reader rather than a shared helper: the one
 * in `styles-regressions.test.ts` is not exported, and importing across test
 * files to save six lines buys a coupling worth more than the lines.)
 */
function readSource(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8')
    .replace(/\r\n/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
}

const component = readSource('../../components/play/CombatLines.tsx');
const stylesheet = readSource('../../components/play/combat-arcs.css');

describe('the overlay stays immune to the board scene (UX-9 × UX-14)', () => {
  it('renders through a portal to document.body', () => {
    // THE CLASS: someone re-parents the overlay back inside the board. A
    // `position: fixed` box inside a transformed ancestor is positioned
    // relative to THAT ancestor, so every arc would silently shift.
    expect(component).toContain('createPortal(');
    expect(component).toContain('document.body');
  });

  it('measures in ONE space: a browser rect reaches the geometry unmodified', () => {
    // THE CLASS this replaces: the old overlay measured a tile in viewport
    // space and then subtracted its container's origin. Under the scene
    // transform the tile rect is PROJECTED and the container's is not, so the
    // subtraction mixes two spaces and every arc lands somewhere plausible and
    // wrong. There is nothing to subtract now, and this fails if one comes back.
    expect(component).toMatch(/left:\s*rect\.left/);
    expect(component).toMatch(/top:\s*rect\.top/);
    expect(component).not.toMatch(/-\s*containerRect\./);
  });

  it('the layer is fixed, inert to the pointer, and never clipped by the board subtree', () => {
    const layer = declarationsFor(stylesheet, '.combat-arcs');
    expect(layer).toMatch(/position:\s*fixed/);
    expect(layer).toMatch(/pointer-events:\s*none/);
    expect(layer).toMatch(/inset:\s*0/);
  });

  it('no colour is written down twice — the ramps live in play-config.ts', () => {
    // A hex here would be a second answer to "what colour is a combat arc",
    // and the two would drift.
    expect(stylesheet).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(component).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });
});

describe('reduced motion keeps the information and drops the decoration', () => {
  it('only the ember flow is animated, and only when nobody asked for less motion', () => {
    const gate = stylesheet.match(
      /@media\s*\(prefers-reduced-motion:\s*no-preference\)\s*\{([\s\S]*?)\n\}/,
    );
    expect(gate, 'a no-preference gate must exist').not.toBeNull();
    expect(gate![1]).toContain('animation:');
    // Nothing outside the gate may animate: the arcs themselves must render
    // identically with motion off, because they carry the information.
    const outsideGate = stylesheet.replace(gate![0], '');
    expect(outsideGate).not.toMatch(/\banimation:/);
  });

  it('the component drops the ember elements too — the same second guard AnimationLayer uses', () => {
    expect(component).toContain('usePrefersReducedMotion');
    expect(component).toMatch(/!reducedMotion/);
  });
});

/** All declarations of every rule whose selector list names `selector` exactly. */
function declarationsFor(css: string, selector: string): string {
  return css
    .split('}')
    .filter((chunk) => {
      const open = chunk.lastIndexOf('{');
      if (open === -1) return false;
      const head = chunk.slice(0, open);
      const start = head.lastIndexOf('{');
      return (start === -1 ? head : head.slice(start + 1))
        .split(',')
        .some((part) => part.trim() === selector);
    })
    .map((chunk) => chunk.slice(chunk.lastIndexOf('{') + 1))
    .join('\n');
}

function round2(value: number): string {
  return Number(value.toFixed(2)).toString();
}
