/**
 * SHAPE PINS FOR THE PLAY-SURFACE CONFIG MODULE.
 *
 * This file is the one place nine lanes read their numbers from (§3.143), which
 * makes it the one place a careless edit is felt everywhere: a deleted key is a
 * `undefined` that reaches CSS as the string "undefined" and paints nothing, and
 * a knob nudged past its sane range is a board nobody can read. Neither shows up
 * in a component's own tests.
 *
 * So three guards, all of them systemic rather than per-value:
 *
 *  1. **Frozen, all the way down** — including nested arrays and objects, so a
 *     consumer cannot mutate the shared table for everyone else.
 *  2. **The unit lives in the NAME, and the name is what range-checks it.** Every
 *     numeric knob must end in a tabulated unit suffix (`…Ms`, `…Px`, `…Deg`,
 *     `…Fraction`, `…Opacity`, `…Ratio`, `…Scale`) or be listed as a count or an
 *     explicit exception. A number whose name matches NOTHING fails the test by
 *     name — that is the closed-table discipline applied to the config itself,
 *     and it is what stops the next knob from arriving as a bare `0.7`.
 *  3. **Key pins** — each config's key list, so a later edit cannot quietly drop
 *     one and leave a lane reading `undefined`.
 *
 * Plus the cross-field invariants that are only true if two numbers agree, which
 * is exactly where a hand-tuned pair drifts apart.
 */
import { describe, expect, it } from 'vitest';

import {
  ANIMATION_CONFIG,
  BOARD_3D_CONFIG,
  CARD_ASPECT_HEIGHT_OVER_WIDTH,
  COMBAT_ADVANCE_CONFIG,
  COMBAT_ARC_COLORS,
  COMBAT_ARC_CONFIG,
  COMBAT_HOLD_CONFIG,
  COPILOT_ADVICE_SEED,
  DAMAGE_ANIM_CONFIG,
  DRAG_START_THRESHOLD_PX,
  HOTSEAT_CONFIG,
  OPPONENT_FEED_CONFIG,
  PROPOSAL_CONFIG,
  SOUND_CONFIG,
  SPELL_HOLD_CONFIG,
  STACK_PANEL_CONFIG,
  STEP_LABELS,
  TAP_ROTATION_CONFIG,
  TOAST_MS,
  VFX_CONFIG,
} from './play-config.js';

/* -------------------------------------------------------------------------- */
/* The tables                                                                  */
/* -------------------------------------------------------------------------- */

interface ConfigShape {
  readonly name: string;
  /**
   * `object`, not `Record<string, unknown>`: each config is a precise interface
   * with no index signature, which is the point — the walkers below take
   * `unknown` and narrow, so the table does not have to weaken the types it is
   * guarding.
   */
  readonly value: object;
  /**
   * The keys this config must have. `null` for a config whose keys are a
   * vocabulary owned elsewhere (STEP_LABELS mirrors the engine's `Step` union
   * and is pinned there — restating it here would be a second answer).
   */
  readonly keys: readonly string[] | null;
}

/** Every frozen config this module exports. Adding one is a ROW. */
const CONFIGS: readonly ConfigShape[] = [
  {
    name: 'HOTSEAT_CONFIG',
    value: HOTSEAT_CONFIG,
    keys: [
      'maxMulligans',
      'defaultNameA',
      'defaultNameB',
      'defaultSeed',
      'aiThinkMs',
      'defaultAiName',
      'maxAutoAdvanceSteps',
    ],
  },
  { name: 'STEP_LABELS', value: STEP_LABELS, keys: null },
  {
    name: 'ANIMATION_CONFIG',
    value: ANIMATION_CONFIG,
    keys: ['drawFlightMs', 'graveFlightMs', 'deathFadeMs', 'staggerMs', 'maxPerBatch', 'spriteWidthPx'],
  },
  {
    name: 'SOUND_CONFIG',
    value: SOUND_CONFIG,
    keys: ['defaultEnabled', 'defaultVolume', 'maxPerBatch', 'staggerMs'],
  },
  { name: 'OPPONENT_FEED_CONFIG', value: OPPONENT_FEED_CONFIG, keys: ['holdMs', 'maxShown'] },
  {
    name: 'VFX_CONFIG',
    value: VFX_CONFIG,
    keys: ['flashMs', 'flareMs', 'burstMs', 'burstParticles', 'maxPerBatch'],
  },
  {
    name: 'BOARD_3D_CONFIG',
    value: BOARD_3D_CONFIG,
    keys: [
      'perspectivePx',
      'tiltDeg',
      'reducedMotionTiltDeg',
      'perspectiveOriginXFraction',
      'perspectiveOriginYFraction',
      'counterTiltDeg',
      'liftScale',
      'liftShadowPx',
      'sceneTransitionMs',
    ],
  },
  {
    name: 'TAP_ROTATION_CONFIG',
    value: TAP_ROTATION_CONFIG,
    keys: ['tappedDeg', 'turnMs', 'footprintRatio', 'tappedOpacity', 'tappedGrayscaleFraction'],
  },
  {
    name: 'COMBAT_ADVANCE_CONFIG',
    value: COMBAT_ADVANCE_CONFIG,
    keys: [
      'attackerAdvanceFraction',
      'blockerAdvanceFraction',
      'midlineGapPx',
      'advanceMs',
      'retreatMs',
      'staggerMs',
      'maxStaggered',
    ],
  },
  {
    name: 'COMBAT_ARC_COLORS',
    value: COMBAT_ARC_COLORS,
    keys: [
      'attackEmber',
      'attackFlame',
      'attackBlaze',
      'attackTip',
      'blockEmber',
      'blockFlame',
      'blockBlaze',
      'blockTip',
    ],
  },
  {
    name: 'COMBAT_ARC_CONFIG',
    value: COMBAT_ARC_CONFIG,
    keys: [
      'bowChordFraction',
      'maxBowPx',
      'strokeWidthPx',
      'draftStrokeWidthPx',
      'draftDashArray',
      'arrowHeadLengthPx',
      'arrowHeadWidthPx',
      'glowBlurPx',
      'emberPeriodMs',
      'emberDashArray',
      'attackGradient',
      'blockGradient',
    ],
  },
  {
    name: 'DAMAGE_ANIM_CONFIG',
    value: DAMAGE_ANIM_CONFIG,
    keys: ['travelMs', 'impactMs', 'staggerMs', 'settleHoldMs', 'maxPerBatch', 'maxTotalMs'],
  },
  {
    name: 'SPELL_HOLD_CONFIG',
    value: SPELL_HOLD_CONFIG,
    keys: ['holdMs', 'pointerHoldMs', 'extendMs', 'fadeMs', 'maxHoldsPerTurn'],
  },
  {
    name: 'COMBAT_HOLD_CONFIG',
    value: COMBAT_HOLD_CONFIG,
    keys: [
      'blocksDeclaredMs',
      'reducedMotionBlocksDeclaredMs',
      'damageMs',
      'reducedMotionDamageMs',
    ],
  },
  {
    name: 'PROPOSAL_CONFIG',
    value: PROPOSAL_CONFIG,
    keys: ['maxOpenProposals', 'cancelKey', 'cancelHintMs', 'commitFlashMs', 'proposingDimOpacity'],
  },
  {
    name: 'STACK_PANEL_CONFIG',
    value: STACK_PANEL_CONFIG,
    keys: [
      'cardWidthPx',
      'maxVisibleEntries',
      'condensedCardWidthPx',
      'overlapFraction',
      'topLiftPx',
      'enterMs',
    ],
  },
];

/**
 * The UNIT SUFFIX table: a numeric knob's name declares what it measures, and
 * that is what bounds it. Adding a unit is a ROW.
 */
const UNIT_SUFFIX_RANGES: readonly { readonly suffix: string; readonly min: number; readonly max: number }[] =
  [
    { suffix: 'Ms', min: 1, max: 20_000 },
    { suffix: 'Px', min: 0, max: 2_000 },
    { suffix: 'Deg', min: -360, max: 360 },
    { suffix: 'Fraction', min: 0, max: 1 },
    { suffix: 'Opacity', min: 0, max: 1 },
    { suffix: 'Ratio', min: 0, max: 4 },
    { suffix: 'Scale', min: 0, max: 4 },
  ];

/** Names that are a COUNT — a whole number of things, at least one. */
const COUNT_FIELDS: ReadonlySet<string> = new Set([
  'maxMulligans',
  'maxAutoAdvanceSteps',
  'maxPerBatch',
  'maxShown',
  'burstParticles',
  'maxStaggered',
  'maxHoldsPerTurn',
  'maxOpenProposals',
  'maxVisibleEntries',
]);

/**
 * Numbers whose name carries no unit and never will, each with its own bounds.
 * Two rows, both predating §3.143 — kept explicit rather than renamed, because
 * renaming a shipped config key is a change to every consumer for no behavioural
 * gain.
 */
const EXPLICIT_FIELD_RANGES: Readonly<
  Record<string, { readonly min: number; readonly max: number; readonly integer?: boolean }>
> = {
  defaultSeed: { min: 0, max: Number.MAX_SAFE_INTEGER, integer: true },
  defaultVolume: { min: 0, max: 1 },
};

/** The standalone exported numbers, which are SCREAMING_SNAKE and so miss the suffix table. */
const STANDALONE_NUMBERS: readonly (readonly [string, number, number, number])[] = [
  ['TOAST_MS', TOAST_MS, 1, 20_000],
  ['DRAG_START_THRESHOLD_PX', DRAG_START_THRESHOLD_PX, 0, 2_000],
  ['CARD_ASPECT_HEIGHT_OVER_WIDTH', CARD_ASPECT_HEIGHT_OVER_WIDTH, 1, 2],
  ['COPILOT_ADVICE_SEED', COPILOT_ADVICE_SEED, 0, Number.MAX_SAFE_INTEGER],
];

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

interface NumericKnob {
  readonly path: string;
  readonly key: string;
  readonly value: number;
}

/** Every number reachable from a config, with the leaf key that names its unit. */
function numericKnobs(node: unknown, path: string, out: NumericKnob[]): NumericKnob[] {
  if (Array.isArray(node)) {
    (node as readonly unknown[]).forEach((item, index) =>
      numericKnobs(item, `${path}[${index}]`, out),
    );
  } else if (node !== null && typeof node === 'object') {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (typeof value === 'number') out.push({ path: `${path}.${key}`, key, value });
      else numericKnobs(value, `${path}.${key}`, out);
    }
  }
  return out;
}

/** Every object/array reachable from a config, so the freeze can be checked all the way down. */
function reachableContainers(node: unknown, path: string, out: [string, object][]): [string, object][] {
  if (node !== null && typeof node === 'object') {
    out.push([path, node]);
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      reachableContainers(value, `${path}.${key}`, out);
    }
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Guards                                                                      */
/* -------------------------------------------------------------------------- */

describe('every config is frozen, all the way down', () => {
  it.each(CONFIGS.map((config) => [config.name, config] as const))('%s', (_name, config) => {
    for (const [path, container] of reachableContainers(config.value, config.name, [])) {
      expect(Object.isFrozen(container), `${path} is mutable`).toBe(true);
    }
  });
});

describe('every config keeps its keys — a deletion cannot be quiet', () => {
  it.each(CONFIGS.filter((config) => config.keys !== null).map((c) => [c.name, c] as const))(
    '%s',
    (_name, config) => {
      expect([...Object.keys(config.value)].sort()).toEqual([...(config.keys ?? [])].sort());
    },
  );
});

describe('every numeric knob declares its unit in its name, and stays in range', () => {
  const knobs = CONFIGS.flatMap((config) => numericKnobs(config.value, config.name, []));

  it('found knobs to check (the walker itself works)', () => {
    expect(knobs.length).toBeGreaterThan(50);
  });

  it('every number is covered by the suffix table, the count set, or an explicit row', () => {
    const untabulated = knobs
      .filter(
        (knob) =>
          !UNIT_SUFFIX_RANGES.some((unit) => knob.key.endsWith(unit.suffix)) &&
          !COUNT_FIELDS.has(knob.key) &&
          EXPLICIT_FIELD_RANGES[knob.key] === undefined,
      )
      .map((knob) => knob.path);
    // A knob outside every table REPORTS rather than being waved through: name it
    // with its unit (`…Ms`, `…Px`, `…Fraction`) or add its row.
    expect(untabulated).toEqual([]);
  });

  it('every number is finite and inside the range its name implies', () => {
    for (const knob of knobs) {
      expect(Number.isFinite(knob.value), `${knob.path} is not finite`).toBe(true);
      const unit = UNIT_SUFFIX_RANGES.find((candidate) => knob.key.endsWith(candidate.suffix));
      if (unit !== undefined) {
        expect(knob.value, `${knob.path} (${unit.suffix})`).toBeGreaterThanOrEqual(unit.min);
        expect(knob.value, `${knob.path} (${unit.suffix})`).toBeLessThanOrEqual(unit.max);
        continue;
      }
      if (COUNT_FIELDS.has(knob.key)) {
        expect(Number.isInteger(knob.value), `${knob.path} is a count`).toBe(true);
        expect(knob.value, knob.path).toBeGreaterThanOrEqual(1);
        continue;
      }
      const explicit = EXPLICIT_FIELD_RANGES[knob.key];
      expect(explicit, knob.path).toBeDefined();
      if (explicit === undefined) continue;
      if (explicit.integer === true) expect(Number.isInteger(knob.value), knob.path).toBe(true);
      expect(knob.value, knob.path).toBeGreaterThanOrEqual(explicit.min);
      expect(knob.value, knob.path).toBeLessThanOrEqual(explicit.max);
    }
  });

  it('every standalone exported number is in range too', () => {
    for (const [name, value, min, max] of STANDALONE_NUMBERS) {
      expect(Number.isFinite(value), name).toBe(true);
      expect(value, name).toBeGreaterThanOrEqual(min);
      expect(value, name).toBeLessThanOrEqual(max);
    }
  });

  it('every string knob is non-empty', () => {
    for (const config of CONFIGS) {
      for (const [key, value] of Object.entries(config.value as Record<string, unknown>)) {
        if (typeof value !== 'string') continue;
        expect(value.length, `${config.name}.${key}`).toBeGreaterThan(0);
      }
    }
  });
});

describe('cross-field invariants — the pairs that only work if they agree', () => {
  it('the counter-tilt is exactly the negation of the tilt, so chrome text is upright', () => {
    expect(BOARD_3D_CONFIG.counterTiltDeg).toBe(-BOARD_3D_CONFIG.tiltDeg);
  });

  it('the reduced-motion tilt is never MORE tilt than the normal one', () => {
    expect(Math.abs(BOARD_3D_CONFIG.reducedMotionTiltDeg)).toBeLessThanOrEqual(
      Math.abs(BOARD_3D_CONFIG.tiltDeg),
    );
  });

  it('the tilt stays inside the readability window the comment claims', () => {
    // Past ~12° the far seat's art and P/T stop being readable at a glance,
    // which is the opposite of what this overhaul is for.
    expect(Math.abs(BOARD_3D_CONFIG.tiltDeg)).toBeGreaterThan(0);
    expect(Math.abs(BOARD_3D_CONFIG.tiltDeg)).toBeLessThanOrEqual(12);
  });

  it('a turned card reserves at least the width it actually occupies', () => {
    // `transform` does not reflow, so the SLOT has to reserve the footprint or a
    // 90° turn overlaps its neighbours — the exact reason the board shipped 24°.
    expect(TAP_ROTATION_CONFIG.footprintRatio).toBe(CARD_ASPECT_HEIGHT_OVER_WIDTH);
    expect(TAP_ROTATION_CONFIG.footprintRatio).toBeGreaterThan(1);
    expect(TAP_ROTATION_CONFIG.tappedDeg).toBe(90);
  });

  it('a retreat is never slower than the advance it undoes', () => {
    expect(COMBAT_ADVANCE_CONFIG.retreatMs).toBeLessThanOrEqual(COMBAT_ADVANCE_CONFIG.advanceMs);
  });

  it('an advance never reaches the midline on the fraction alone', () => {
    expect(COMBAT_ADVANCE_CONFIG.attackerAdvanceFraction).toBeLessThan(1);
    expect(COMBAT_ADVANCE_CONFIG.blockerAdvanceFraction).toBeLessThan(1);
    expect(COMBAT_ADVANCE_CONFIG.midlineGapPx).toBeGreaterThan(0);
  });

  it('a full damage batch fits inside the total cap', () => {
    // A cap the per-beat timings can never reach is a cap that never fires,
    // which is worse than none because it reads like a guarantee.
    const worstCase =
      DAMAGE_ANIM_CONFIG.travelMs +
      DAMAGE_ANIM_CONFIG.impactMs +
      DAMAGE_ANIM_CONFIG.settleHoldMs +
      DAMAGE_ANIM_CONFIG.staggerMs * (DAMAGE_ANIM_CONFIG.maxPerBatch - 1);
    expect(worstCase).toBeLessThanOrEqual(DAMAGE_ANIM_CONFIG.maxTotalMs);
  });

  it('a pointer on a held spell extends the hold, and the extension is still bounded', () => {
    expect(SPELL_HOLD_CONFIG.pointerHoldMs).toBeGreaterThan(SPELL_HOLD_CONFIG.holdMs);
    expect(SPELL_HOLD_CONFIG.pointerHoldMs).toBeLessThan(20_000);
  });

  it('the combat beats outlast the animations they exist to reveal', () => {
    // §10: "a hold shorter than the animation it exists to reveal is
    // pointless". The blocker advance must have FINISHED travelling — including
    // the stagger tail of a maximum-width charge — before the beat ends, and
    // one damage hit must have travelled AND bloomed.
    const advanceEnds =
      COMBAT_ADVANCE_CONFIG.advanceMs +
      COMBAT_ADVANCE_CONFIG.staggerMs * (COMBAT_ADVANCE_CONFIG.maxStaggered - 1);
    expect(COMBAT_HOLD_CONFIG.blocksDeclaredMs).toBeGreaterThan(advanceEnds);
    expect(COMBAT_HOLD_CONFIG.damageMs).toBeGreaterThan(
      DAMAGE_ANIM_CONFIG.travelMs + DAMAGE_ANIM_CONFIG.impactMs,
    );
  });

  it('a combat beat never outlasts the damage sequence it could ever cover', () => {
    // The other side of the same coin: a beat past the sequence's own provable
    // ceiling would be the board sitting on a finished animation.
    const sequenceCeiling =
      DAMAGE_ANIM_CONFIG.maxTotalMs + DAMAGE_ANIM_CONFIG.impactMs + DAMAGE_ANIM_CONFIG.settleHoldMs;
    expect(COMBAT_HOLD_CONFIG.damageMs).toBeLessThan(sequenceCeiling);
  });

  it('a reduced-motion beat is never LONGER than the full one', () => {
    // The same invariant the tilt keeps (see `reducedMotionTiltDeg`): reducing
    // motion may shorten or flatten, never add. Somebody who asked for less
    // must not be made to wait for more.
    expect(COMBAT_HOLD_CONFIG.reducedMotionBlocksDeclaredMs).toBeLessThanOrEqual(
      COMBAT_HOLD_CONFIG.blocksDeclaredMs,
    );
    expect(COMBAT_HOLD_CONFIG.reducedMotionDamageMs).toBeLessThanOrEqual(
      COMBAT_HOLD_CONFIG.damageMs,
    );
  });

  it('a proposal cannot nest', () => {
    expect(PROPOSAL_CONFIG.maxOpenProposals).toBe(1);
    expect(PROPOSAL_CONFIG.cancelKey).toBe('Escape');
  });

  it('a condensed stack card is never wider than a full one, and the fan leaves a sliver', () => {
    expect(STACK_PANEL_CONFIG.condensedCardWidthPx).toBeLessThanOrEqual(
      STACK_PANEL_CONFIG.cardWidthPx,
    );
    expect(STACK_PANEL_CONFIG.overlapFraction).toBeLessThan(1);
  });

  it('a drafted block is drawn no heavier than a committed one', () => {
    expect(COMBAT_ARC_CONFIG.draftStrokeWidthPx).toBeLessThanOrEqual(
      COMBAT_ARC_CONFIG.strokeWidthPx,
    );
  });
});

describe('the arc gradients are well-formed ramps built from the named colour tokens', () => {
  const tokens = new Set<string>(Object.values(COMBAT_ARC_COLORS));

  it.each([
    ['attackGradient', COMBAT_ARC_CONFIG.attackGradient],
    ['blockGradient', COMBAT_ARC_CONFIG.blockGradient],
  ] as const)('%s', (name, gradient) => {
    expect(gradient.length, name).toBeGreaterThanOrEqual(2);
    expect(gradient[0]?.offsetFraction, `${name} must start at the source end`).toBe(0);
    expect(gradient.at(-1)?.offsetFraction, `${name} must end at the arrowhead`).toBe(1);
    for (let i = 1; i < gradient.length; i += 1) {
      expect(
        gradient[i]?.offsetFraction,
        `${name} stop ${i} must come after stop ${i - 1}`,
      ).toBeGreaterThan(gradient[i - 1]?.offsetFraction ?? 0);
    }
    for (const stop of gradient) {
      // A raw hex here would be the literal the "named colour tokens" rule
      // exists to prevent — the tokens are the one place the palette is stated.
      expect(tokens.has(stop.color), `${name} uses an untokenised colour ${stop.color}`).toBe(true);
    }
  });

  it('every colour token is a six-digit hex', () => {
    for (const [name, value] of Object.entries(COMBAT_ARC_COLORS)) {
      expect(value, name).toMatch(/^#[0-9a-f]{6}$/u);
    }
  });

  it('the attack ramp and the block ramp share no colour', () => {
    // The board already codes attacking red and blocking blue (board-clarity.css);
    // one shared stop and the two arcs stop telling you which end you are looking at.
    const attack = new Set(COMBAT_ARC_CONFIG.attackGradient.map((stop) => stop.color));
    const shared = COMBAT_ARC_CONFIG.blockGradient.filter((stop) => attack.has(stop.color));
    expect(shared).toEqual([]);
  });
});
