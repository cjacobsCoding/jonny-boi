/**
 * The guards for UX-12 / UX-13. Each one fails without the clamp, the
 * attacker-first ordering, or the whole-vector scaling it names.
 */
import { describe, expect, it } from 'vitest';
import { COMBAT_ADVANCE_CONFIG } from './play-config.js';
import {
  advancedCentre,
  blockerCentre,
  centreOf,
  maxAdvancePx,
  placementSignature,
  stagePlacements,
  STAGE_ROLES,
  STAGE_ROLE_RULES,
  type StageRect,
  type StageSubject,
} from './combat-stage.js';

const CFG = COMBAT_ADVANCE_CONFIG;

/** A tile of the board's real proportions: `--play-tile-w-max` 96 wide. */
function tile(left: number, top: number): StageRect {
  return { left, top, width: 96, height: 134 };
}

/** The viewer sits low and advances UP; the opponent sits high and advances DOWN. */
const MIDLINE = 400;

describe('an attacker advances toward the defender', () => {
  it('travels the configured fraction of the way to the midline', () => {
    // Home centre at y = 700; the midline is 400, so the full distance is 300.
    const home = tile(500, 700 - 67);
    expect(centreOf(home).y).toBe(700);
    const centre = advancedCentre(home, -1, MIDLINE, CFG);
    expect(centre.y).toBeCloseTo(700 - 300 * CFG.attackerAdvanceFraction, 5);
    // Straight forward: the column it stood in is the column it fights from.
    expect(centre.x).toBeCloseTo(centreOf(home).x, 5);
  });

  it('the opponent advances the other way, by the same rule', () => {
    const home = tile(500, 100 - 67);
    const centre = advancedCentre(home, 1, MIDLINE, CFG);
    expect(centre.y).toBeCloseTo(100 + 300 * CFG.attackerAdvanceFraction, 5);
  });
});

/** Clearance from a card's leading edge to the midline, positive = short of it. */
function clearance(centreY: number, toward: 1 | -1): number {
  return toward * (MIDLINE - (centreY + (toward * 134) / 2));
}

describe('the midline clamp is hard (UX-12: "without crossing the midline")', () => {
  it('a card that would overshoot is stopped exactly at the gap', () => {
    // Centre at 560: its leading (top) edge is 493, 93px short of the midline.
    // 55% of the 160px to the midline is 88px, which would leave 5px — less
    // than the 16px gap — so the clamp must bind.
    const home = tile(500, 560 - 67);
    const centre = advancedCentre(home, -1, MIDLINE, CFG);
    expect(clearance(centre.y, -1)).toBeCloseTo(CFG.midlineGapPx, 5);
    // It really was clamped: the unclamped answer would have gone further.
    expect(centre.y).toBeGreaterThan(560 - 160 * CFG.attackerAdvanceFraction);
  });

  it('AT THE BOUNDARY: from every start, both directions, the advance never eats the gap', () => {
    for (const toward of [1, -1] as const) {
      for (let distance = 0; distance <= 600; distance += 7) {
        const centreY = MIDLINE - toward * distance;
        const home = tile(500, centreY - 67);
        const before = clearance(centreY, toward);
        const after = clearance(advancedCentre(home, toward, MIDLINE, CFG).y, toward);
        // THE INVARIANT, stated so a card that starts too close is covered too:
        // the advance never brings a card inside the gap, and never brings one
        // that was already inside it any closer.
        expect(after).toBeGreaterThanOrEqual(Math.min(before, CFG.midlineGapPx) - 1e-6);
      }
    }
  });

  it('a card ALREADY inside the gap stays put rather than being yanked backwards', () => {
    // Centre at 430 with the viewer advancing up: its top edge is at 363, which
    // is already past the midline. maxAdvancePx is 0, so nothing moves.
    const home = tile(500, 430 - 67);
    expect(maxAdvancePx(home, -1, MIDLINE, CFG)).toBe(0);
    expect(advancedCentre(home, -1, MIDLINE, CFG).y).toBeCloseTo(430, 5);
  });
});

describe('a blocker moves to MEET its attacker (UX-13)', () => {
  it('aims at the attacker’s ADVANCED centre, not its home one', () => {
    const attackerHome = tile(200, 100 - 67); // opponent's side, centre y=100
    const attackerAdvanced = advancedCentre(attackerHome, 1, MIDLINE, CFG);
    const blockerHome = tile(600, 900 - 67); // viewer's side, centre (648, 900)

    const met = blockerCentre(blockerHome, attackerAdvanced, -1, MIDLINE, CFG);
    const naive = blockerCentre(blockerHome, centreOf(attackerHome), -1, MIDLINE, CFG);
    // The attacker walked forward, so meeting it is a SHORTER trip than meeting
    // where it used to stand — the two answers are genuinely different.
    expect(met.y).toBeGreaterThan(naive.y);
    // And it slides sideways into the attacker's column, which is what makes the
    // pairing readable without reading the arc.
    expect(met.x).toBeLessThan(centreOf(blockerHome).x);
  });

  it('the clamp scales the WHOLE vector, so a clamped blocker is still on the line to its attacker', () => {
    const attackerAdvanced = { x: 100, y: 380 }; // just past the midline
    const blockerHome = tile(600, 500 - 67); // centre (648, 500)
    const centre = blockerCentre(blockerHome, attackerAdvanced, -1, MIDLINE, CFG);
    const from = centreOf(blockerHome);
    const wantedDx = (attackerAdvanced.x - from.x) * CFG.blockerAdvanceFraction;
    const wantedDy = (attackerAdvanced.y - from.y) * CFG.blockerAdvanceFraction;
    const gotDx = centre.x - from.x;
    const gotDy = centre.y - from.y;
    // Clamped (so shorter than wanted) but COLLINEAR with the wanted vector.
    expect(Math.abs(gotDy)).toBeLessThan(Math.abs(wantedDy));
    expect(gotDx * wantedDy).toBeCloseTo(gotDy * wantedDx, 6);
  });
});

describe('the stage as a whole', () => {
  const subjects: readonly StageSubject[] = [
    { instanceId: 1, role: 'blocker', home: tile(600, 833), toward: -1, meets: 2 },
    { instanceId: 2, role: 'attacker', home: tile(200, 33), toward: 1 },
    { instanceId: 3, role: 'attacker', home: tile(320, 33), toward: 1 },
  ];

  it('places attackers before blockers, so a blocker can aim at a placed attacker', () => {
    const placed = stagePlacements({ subjects, midlineY: MIDLINE }, CFG);
    expect(placed.map((p) => p.instanceId)).toEqual([2, 3, 1]);
    const attacker = placed.find((p) => p.instanceId === 2);
    const blocker = placed.find((p) => p.instanceId === 1);
    expect(attacker).toBeDefined();
    expect(blocker).toBeDefined();
    // The blocker really did aim at the ADVANCED attacker: recomputing from the
    // attacker's home gives a different answer.
    const fromHome = blockerCentre(tile(600, 833), centreOf(tile(200, 33)), -1, MIDLINE, CFG);
    expect(blocker?.centre.y).not.toBeCloseTo(fromHome.y, 3);
  });

  it('a blocker whose attacker is not staged is DROPPED, not guessed at', () => {
    const orphan: readonly StageSubject[] = [
      { instanceId: 1, role: 'blocker', home: tile(600, 833), toward: -1, meets: 99 },
    ];
    expect(stagePlacements({ subjects: orphan, midlineY: MIDLINE }, CFG)).toEqual([]);
  });

  it('the stagger is capped: card N past the cap shares the last slot', () => {
    const many: StageSubject[] = [];
    for (let i = 0; i < CFG.maxStaggered + 5; i += 1) {
      many.push({ instanceId: i + 1, role: 'attacker', home: tile(i * 100, 33), toward: 1 });
    }
    const placed = stagePlacements({ subjects: many, midlineY: MIDLINE }, CFG);
    expect(placed).toHaveLength(many.length);
    expect(Math.max(...placed.map((p) => p.staggerIndex))).toBe(CFG.maxStaggered - 1);
  });

  it('the signature changes when the picture does, and not when it does not', () => {
    const a = stagePlacements({ subjects, midlineY: MIDLINE }, CFG);
    const same = stagePlacements({ subjects, midlineY: MIDLINE }, CFG);
    const moved = stagePlacements({ subjects, midlineY: MIDLINE - 40 }, CFG);
    expect(placementSignature(a)).toBe(placementSignature(same));
    expect(placementSignature(a)).not.toBe(placementSignature(moved));
  });
});

describe('the role table is closed', () => {
  it('every role has a rule naming which configured fraction it spends', () => {
    for (const role of STAGE_ROLES) {
      const rule = STAGE_ROLE_RULES[role];
      expect(typeof CFG[rule.fractionOf]).toBe('number');
      expect(rule.why.length).toBeGreaterThan(40);
    }
    // Both fractions are spent by somebody: a knob nothing reads is a knob that
    // will be tuned and have no effect.
    const spent = new Set(STAGE_ROLES.map((r) => STAGE_ROLE_RULES[r].fractionOf));
    expect(spent).toEqual(new Set(['attackerAdvanceFraction', 'blockerAdvanceFraction']));
  });
});
