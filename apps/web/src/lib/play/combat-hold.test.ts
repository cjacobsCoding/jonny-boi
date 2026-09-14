/**
 * The guards for the COMBAT HOLD (§10 of docs/MTGA-UX-OVERHAUL.md).
 *
 * ⚠️ WHAT THIS FILE CANNOT PROVE, stated up front so nobody mistakes a green run
 * for a delivered feature: no unit test can see "this state existed for 200 ms".
 * The guard for THAT is `apps/web/scripts/verify-combat-visibility.mjs`, which
 * drives a real game in a real Chrome and samples the board after Confirm. This
 * file pins the DECISION — which combat moments hold, which refuse and why, and
 * that a beat fires once per combat rather than on every priority pass, which is
 * the difference between a pause and a step that can never end.
 */
import { describe, expect, it } from 'vitest';
import { COMBAT_HOLD_CONFIG } from './play-config.js';
import {
  COMBAT_HOLD_KIND_ORDER,
  COMBAT_HOLD_KINDS,
  COMBAT_HOLD_REFUSALS,
  combatHoldDecision,
  combatHoldMs,
  combatWindowFactsOf,
  type CombatHoldContext,
  type CombatHoldKind,
  type CombatHoldRefusal,
} from './combat-hold.js';

const CFG = COMBAT_HOLD_CONFIG;

/** A blocked combat sitting in the declare-blockers step, blocks committed. */
function ctx(overrides: Partial<CombatHoldContext> = {}): CombatHoldContext {
  return {
    step: 'declareBlockers',
    combat: { blockersDeclared: true, attackerCount: 1, blockCount: 1 },
    spent: new Set<CombatHoldKind>(),
    reducedMotion: false,
    gameOver: false,
    ...overrides,
  };
}

function refusalOf(decision: ReturnType<typeof combatHoldDecision>): CombatHoldRefusal | null {
  return decision.kind === 'refused' ? decision.reason : null;
}

describe('the moments that hold', () => {
  it('holds when blockers have been declared — the state that measured ZERO', () => {
    const decision = combatHoldDecision(ctx(), CFG);
    expect(decision.kind).toBe('hold');
    if (decision.kind !== 'hold') return;
    expect(decision.hold.kind).toBe('blocksDeclared');
    expect(decision.hold.ms).toBe(CFG.blocksDeclaredMs);
    // The label is the ROW's, never re-worded at the call site.
    expect(decision.hold.label).toBe(COMBAT_HOLD_KINDS.blocksDeclared.label);
  });

  it('holds again while combat damage is being distributed', () => {
    const decision = combatHoldDecision(
      ctx({ step: 'combatDamage', spent: new Set<CombatHoldKind>(['blocksDeclared']) }),
      CFG,
    );
    expect(decision.kind).toBe('hold');
    if (decision.kind !== 'hold') return;
    expect(decision.hold.kind).toBe('damage');
    expect(decision.hold.ms).toBe(CFG.damageMs);
  });

  it('holds the damage beat even when nothing blocked — an unblocked swing is the thing to see', () => {
    const decision = combatHoldDecision(
      ctx({ step: 'combatDamage', combat: { blockersDeclared: true, attackerCount: 2, blockCount: 0 } }),
      CFG,
    );
    expect(decision.kind).toBe('hold');
  });
});

describe('the moments that refuse, each with its own sentence', () => {
  it.each([
    [
      'a step that is not a combat beat',
      ctx({ step: 'precombatMain', combat: null }),
      'notACombatBeat' as const,
    ],
    [
      'blocks that have not been declared yet — the player is still choosing',
      ctx({ combat: { blockersDeclared: false, attackerCount: 1, blockCount: 0 } }),
      'notACombatBeat' as const,
    ],
    [
      'a combat the defender took on the chin: no block to advance, nothing new on screen',
      ctx({ combat: { blockersDeclared: true, attackerCount: 1, blockCount: 0 } }),
      'notACombatBeat' as const,
    ],
    [
      'a damage step with nothing in combat',
      ctx({ step: 'combatDamage', combat: { blockersDeclared: true, attackerCount: 0, blockCount: 0 } }),
      'notACombatBeat' as const,
    ],
    ['a finished game', ctx({ gameOver: true }), 'gameOver' as const],
    [
      'a beat this combat has already spent',
      ctx({ spent: new Set<CombatHoldKind>(['blocksDeclared']) }),
      'alreadyHeld' as const,
    ],
  ])('refuses %s', (_label, context, reason) => {
    const decision = combatHoldDecision(context, CFG);
    expect(refusalOf(decision)).toBe(reason);
    if (decision.kind !== 'refused') return;
    expect(decision.detail).toBe(COMBAT_HOLD_REFUSALS[reason]);
  });

  it('refuses a beat a designer has turned off rather than arming a zero-length pause', () => {
    // A hold of 0 ms would still gate the walker for a render and would still
    // have to be released; a refusal says what happened and costs nothing.
    const off = { ...CFG, blocksDeclaredMs: 0 };
    expect(refusalOf(combatHoldDecision(ctx(), off))).toBe('beatDisabled');
  });

  it('every refusal reason carries a non-empty sentence', () => {
    for (const [reason, sentence] of Object.entries(COMBAT_HOLD_REFUSALS)) {
      expect(sentence.length, `${reason} has no sentence`).toBeGreaterThan(0);
    }
  });
});

describe('a beat fires ONCE per combat', () => {
  it('the same window refuses after its beat has been spent, so the step can still end', () => {
    // The game passes back through `declareBlockers` on every priority pass. A
    // hold that re-armed each time would gate the auto-passer forever and the
    // step would never finish — a worse bug than the one this exists to fix.
    const first = combatHoldDecision(ctx(), CFG);
    expect(first.kind).toBe('hold');
    if (first.kind !== 'hold') return;
    const spent = new Set<CombatHoldKind>([first.hold.kind]);
    expect(refusalOf(combatHoldDecision(ctx({ spent }), CFG))).toBe('alreadyHeld');
  });

  it('spending the blocks beat does not spend the damage beat', () => {
    const spent = new Set<CombatHoldKind>(['blocksDeclared']);
    expect(combatHoldDecision(ctx({ step: 'combatDamage', spent }), CFG).kind).toBe('hold');
  });
});

describe('reduced motion picks the other beat, it does not switch the hold off', () => {
  it.each(COMBAT_HOLD_KIND_ORDER)('%s', (kind) => {
    const full = combatHoldMs(kind, CFG, false);
    const quiet = combatHoldMs(kind, CFG, true);
    expect(quiet).toBeGreaterThan(0);
    expect(quiet).toBeLessThanOrEqual(full);
    expect(quiet).toBe(CFG[COMBAT_HOLD_KINDS[kind].beat.reducedMotion]);
    expect(full).toBe(CFG[COMBAT_HOLD_KINDS[kind].beat.full]);
  });

  it('a reduced-motion viewer still gets a pause at declared blockers', () => {
    const decision = combatHoldDecision(ctx({ reducedMotion: true }), CFG);
    expect(decision.kind).toBe('hold');
    if (decision.kind !== 'hold') return;
    expect(decision.hold.ms).toBe(CFG.reducedMotionBlocksDeclaredMs);
  });
});

describe('the adapter reads core’s combat state and nothing else', () => {
  it('counts the declaration, not the board', () => {
    expect(
      combatWindowFactsOf({
        attackers: [11, 12],
        blocks: { 21: 11 },
        attackersDeclared: true,
        blockersDeclared: true,
      }),
    ).toEqual({ blockersDeclared: true, attackerCount: 2, blockCount: 1 });
  });

  it('a board with no combat at all is null, never an empty combat', () => {
    // `{ attackerCount: 0 }` and "there is no combat" are different facts, and
    // conflating them is how a hold ends up armed outside combat.
    expect(combatWindowFactsOf(null)).toBeNull();
  });
});

describe('the table is closed and cannot drift', () => {
  it('the try-order names exactly the kinds in the table', () => {
    // Two lists of the same vocabulary is the drift rule 12 is about: the order
    // is explicit (a rule may not depend on property-insertion order) and this
    // is what stops it from disagreeing with the table it orders.
    expect([...COMBAT_HOLD_KIND_ORDER].sort()).toEqual(Object.keys(COMBAT_HOLD_KINDS).sort());
  });

  it('every row names two REAL config keys, and never the same one twice', () => {
    for (const kind of COMBAT_HOLD_KIND_ORDER) {
      const { beat } = COMBAT_HOLD_KINDS[kind];
      expect(Object.keys(CFG)).toContain(beat.full);
      expect(Object.keys(CFG)).toContain(beat.reducedMotion);
      expect(beat.full).not.toBe(beat.reducedMotion);
    }
  });

  it('no two rows spend the same beat — swapping the two numbers would be silent', () => {
    const used = COMBAT_HOLD_KIND_ORDER.map((kind) => COMBAT_HOLD_KINDS[kind].beat.full);
    expect(new Set(used).size).toBe(used.length);
  });

  it('every row says what it shows and why, so a refusal can be explained out loud', () => {
    for (const kind of COMBAT_HOLD_KIND_ORDER) {
      const row = COMBAT_HOLD_KINDS[kind];
      expect(row.label.length, `${kind} has no label`).toBeGreaterThan(0);
      expect(row.shows.length, `${kind} says nothing about what it shows`).toBeGreaterThan(0);
      expect(row.why.length, `${kind} has no reason`).toBeGreaterThan(0);
    }
  });

  it('at most one row applies to any one window', () => {
    // The rows are tried in order and the first wins; two rows matching the same
    // window would make that order load-bearing in a way nobody wrote down.
    const windows: CombatHoldContext[] = [
      ctx(),
      ctx({ step: 'combatDamage' }),
      ctx({ step: 'declareAttackers', combat: { blockersDeclared: false, attackerCount: 1, blockCount: 0 } }),
      ctx({ step: 'endCombat' }),
      ctx({ step: 'postcombatMain', combat: null }),
    ];
    for (const window of windows) {
      const matches = COMBAT_HOLD_KIND_ORDER.filter((kind) =>
        COMBAT_HOLD_KINDS[kind].applies(window),
      );
      expect(matches.length, `${window.step} matched ${matches.join(' + ')}`).toBeLessThanOrEqual(1);
    }
  });
});
