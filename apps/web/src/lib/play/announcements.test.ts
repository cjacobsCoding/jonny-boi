/**
 * THE ANNOUNCEMENT QUEUE — the rule, not the screen.
 *
 * Caleb: *"we are getting some overriding overlays in app that look bad - like
 * 'heres what goblin guide revealed from your library' and 'heres what the
 * computer casted' - those should reconcile somehow"*.
 *
 * Two things have to be true at once and they pull in opposite directions:
 *
 *  1. **two announcements must never be on screen together** — the report; and
 *  2. **no announcement may be delayed or dropped** — because three of the four
 *     GATE the game, and a gate that releases with nothing having been shown for
 *     it desynchronises the board from what the player was told.
 *
 * So the load-bearing assertions here are the ones about the RELATIONSHIP
 * between "queued for display" and "holding the game", and the strongest of them
 * is {@link the old gate}: over every possible combination of live
 * announcements, the new one-value gate is EXTENSIONALLY EQUAL to the
 * `hold || combatHold || forcedChoice` it replaced. That is what "a HOLD's
 * gating is unaffected by queueing" means as something a machine can check.
 */
import { describe, expect, it } from 'vitest';
import {
  ANNOUNCEMENT_KINDS,
  ANNOUNCEMENT_ORDER,
  ANNOUNCEMENT_RANK_INVARIANT,
  ANNOUNCEMENT_SLOTS,
  announcementDurationMs,
  announcementHolds,
  announcementId,
  announcementQueue,
  NO_ANNOUNCEMENTS,
  type AnnouncementBody,
  type AnnouncementKind,
} from './announcements.js';
import {
  ANNOUNCEMENT_BEATS,
  ANNOUNCEMENT_CONFIG,
  COMBAT_HOLD_CONFIG,
  FORCED_CHOICE_CONFIG,
  SPELL_HOLD_CONFIG,
} from './play-config.js';
import { combatHoldDecision, NO_BEATS_SPENT, type CombatHold } from './combat-hold.js';
import { extendPressure, holdDurationMs, NO_HOLD_PRESSURE, pointerPressure } from './spell-hold.js';
import type { ForcedChoice } from './forced-choice.js';
import type { RevealView } from './reveals.js';

// ---------------------------------------------------------------------------
// Fixtures — real values from the real producers wherever one exists.
// ---------------------------------------------------------------------------

/** A REAL combat beat, from the REAL decision, not a hand-built object. */
function realCombatBeat(reducedMotion = false): CombatHold {
  const decision = combatHoldDecision(
    {
      step: 'declareBlockers',
      combat: { blockersDeclared: true, attackerCount: 1, blockCount: 1 },
      spent: NO_BEATS_SPENT,
      reducedMotion,
      gameOver: false,
    },
    COMBAT_HOLD_CONFIG,
  );
  if (decision.kind !== 'hold') throw new Error(`a declared block must hold: ${decision.detail}`);
  return decision.hold;
}

const COMBAT = (reducedMotion = false): AnnouncementBody => ({
  kind: 'combatHold',
  hold: realCombatBeat(reducedMotion),
});

const SPELL = (pressure = NO_HOLD_PRESSURE): AnnouncementBody => ({
  kind: 'spellHold',
  hold: { instanceId: 121, controller: 'B', kind: 'spell' },
  pressure,
});

const FORCED_CHOICE_FIXTURE: ForcedChoice = Object.freeze({
  id: 'engine:7',
  kind: 'selectTargets',
  chooser: 'A',
  sourceInstanceId: 99,
  sourceName: 'Banisher Priest',
  verb: 'targets',
  refs: [121],
  words: ['Grizzly Bears'],
  why: 'only one legal target',
  volume: 'banner',
});
const FORCED: AnnouncementBody = { kind: 'forcedChoice', forced: FORCED_CHOICE_FIXTURE };

const REVEAL_FIXTURE: RevealView = Object.freeze({
  at: 42,
  instanceId: 7,
  cardId: 'goblin-guide',
  name: 'Mountain',
  player: 'A',
  text: 'Goblin Guide reveals Mountain from the top of your library.',
});
const REVEAL: AnnouncementBody = { kind: 'reveal', reveal: REVEAL_FIXTURE };

/** One body per kind, so a test can enumerate the table exhaustively. */
const BODY_OF: { readonly [K in AnnouncementKind]: AnnouncementBody } = {
  combatHold: COMBAT(),
  spellHold: SPELL(),
  forcedChoice: FORCED,
  reveal: REVEAL,
};

// ---------------------------------------------------------------------------
describe('the table is closed, complete and ordered', () => {
  it('every kind has a row, and the rows enumerate exactly the kinds', () => {
    expect([...ANNOUNCEMENT_ORDER].sort()).toEqual(
      (Object.keys(BODY_OF) as AnnouncementKind[]).sort(),
    );
  });

  it('the ranks are DISTINCT — "which shows first?" may not depend on argument order', () => {
    const ranks = ANNOUNCEMENT_ORDER.map((k) => ANNOUNCEMENT_KINDS[k].rank);
    expect(new Set(ranks).size).toBe(ranks.length);
  });

  it('ANNOUNCEMENT_ORDER really is the ranks, ascending', () => {
    const ranks = ANNOUNCEMENT_ORDER.map((k) => ANNOUNCEMENT_KINDS[k].rank);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
  });

  it('every row picks a slot from the CLOSED slot table and explains itself', () => {
    for (const kind of ANNOUNCEMENT_ORDER) {
      const row = ANNOUNCEMENT_KINDS[kind];
      expect(Object.keys(ANNOUNCEMENT_SLOTS), kind).toContain(row.slot);
      expect(row.why.length, `${kind} must say why it ranks where it does`).toBeGreaterThan(40);
    }
  });

  /**
   * ⚠️ THE INVARIANT THE WHOLE DESIGN RESTS ON. Every kind that HOLDS the game
   * outranks every kind that does not — so when the game is frozen, the thing on
   * screen is the reason it is frozen, and a hold is never waiting behind a
   * mere notice.
   */
  it('every HOLDING kind outranks every NOTICE', () => {
    expect(ANNOUNCEMENT_RANK_INVARIANT()).toBeNull();
  });

  it('a beat is always positive — a zero-length announcement is a dropped one', () => {
    for (const kind of ANNOUNCEMENT_ORDER) {
      for (const reducedMotion of [false, true]) {
        const ms = announcementDurationMs(BODY_OF[kind], ANNOUNCEMENT_BEATS, reducedMotion);
        expect(ms, `${kind} reducedMotion=${reducedMotion}`).toBeGreaterThan(0);
      }
    }
  });
});

// ---------------------------------------------------------------------------
describe('the beats are the EXISTING beats, not new numbers', () => {
  it('ANNOUNCEMENT_BEATS references the three configs themselves, never copies', () => {
    // Identity, not deep equality: a copy would drift the day somebody tunes one.
    expect(ANNOUNCEMENT_BEATS.spellHold).toBe(SPELL_HOLD_CONFIG);
    expect(ANNOUNCEMENT_BEATS.forcedChoice).toBe(FORCED_CHOICE_CONFIG);
    expect(ANNOUNCEMENT_BEATS.announcement).toBe(ANNOUNCEMENT_CONFIG);
  });

  it('the combat beat is the one the DECISION produced, reduced motion included', () => {
    for (const reducedMotion of [false, true]) {
      const body = COMBAT(reducedMotion);
      expect(announcementDurationMs(body, ANNOUNCEMENT_BEATS, reducedMotion)).toBe(
        realCombatBeat(reducedMotion).ms,
      );
    }
    // And reduced motion really does pick a DIFFERENT number, or the row is a
    // boolean in disguise (BOARD_3D_CONFIG's convention: scale, don't switch).
    expect(realCombatBeat(true).ms).not.toBe(realCombatBeat(false).ms);
    expect(realCombatBeat(true).ms).toBeGreaterThan(0);
  });

  it("the spell hold's beat is holdDurationMs — pointer and extensions included", () => {
    const hovered = pointerPressure(NO_HOLD_PRESSURE, true);
    const pressed = extendPressure(NO_HOLD_PRESSURE);
    for (const pressure of [NO_HOLD_PRESSURE, hovered, pressed]) {
      expect(announcementDurationMs(SPELL(pressure), ANNOUNCEMENT_BEATS, false)).toBe(
        holdDurationMs(pressure, SPELL_HOLD_CONFIG),
      );
    }
    // The point of routing pressure through the BODY: hovering lengthens the
    // beat that is running, so the queue's one timer re-arms longer.
    expect(announcementDurationMs(SPELL(hovered), ANNOUNCEMENT_BEATS, false)).toBeGreaterThan(
      announcementDurationMs(SPELL(), ANNOUNCEMENT_BEATS, false),
    );
  });

  it('the settled-choice and reveal beats swap a NUMBER for reduced motion', () => {
    expect(announcementDurationMs(FORCED, ANNOUNCEMENT_BEATS, false)).toBe(
      FORCED_CHOICE_CONFIG.holdMs,
    );
    expect(announcementDurationMs(FORCED, ANNOUNCEMENT_BEATS, true)).toBe(
      FORCED_CHOICE_CONFIG.reducedMotionHoldMs,
    );
    expect(announcementDurationMs(REVEAL, ANNOUNCEMENT_BEATS, false)).toBe(
      ANNOUNCEMENT_CONFIG.revealMs,
    );
    expect(announcementDurationMs(REVEAL, ANNOUNCEMENT_BEATS, true)).toBe(
      ANNOUNCEMENT_CONFIG.reducedMotionRevealMs,
    );
    // Shorter, never zero — the words still have to be read.
    expect(ANNOUNCEMENT_CONFIG.reducedMotionRevealMs).toBeGreaterThan(0);
    expect(ANNOUNCEMENT_CONFIG.reducedMotionRevealMs).toBeLessThan(ANNOUNCEMENT_CONFIG.revealMs);
  });

  /**
   * The reveal's beat is the ONE new number on this surface, and it is derived
   * rather than invented: a reveal and a settled choice carry the same reading
   * load (one sentence, one card face).
   */
  it("the reveal's new beat is DERIVED from the settled-choice beat", () => {
    expect(ANNOUNCEMENT_CONFIG.revealMs).toBe(FORCED_CHOICE_CONFIG.holdMs);
    expect(ANNOUNCEMENT_CONFIG.reducedMotionRevealMs).toBe(FORCED_CHOICE_CONFIG.reducedMotionHoldMs);
    expect(ANNOUNCEMENT_CONFIG.fadeMs).toBe(SPELL_HOLD_CONFIG.fadeMs);
  });
});

// ---------------------------------------------------------------------------
describe('TWO ANNOUNCEMENTS IN THE SAME FRAME — both appear, in order, neither lost', () => {
  /** The reported pair, verbatim: a revealed card and the opponent's spell. */
  it('the reveal and the opponent’s cast: one shows, the other WAITS', () => {
    const queue = announcementQueue([REVEAL, SPELL()]);
    expect(queue.showing?.kind, 'the hold outranks the notice').toBe('spellHold');
    expect(queue.waiting.map((b) => b.kind), 'and the reveal is not lost').toEqual(['reveal']);
  });

  it('the loser comes back the moment the winner is gone — it is not consumed', () => {
    const both = announcementQueue([REVEAL, SPELL()]);
    expect(both.waiting).toHaveLength(1);
    // The spell hold released; the SAME reveal body is still live.
    const after = announcementQueue([REVEAL]);
    expect(after.showing).toEqual(REVEAL);
    expect(after.waiting).toHaveLength(0);
  });

  it('all four at once order by RANK, and every one of them is still in the queue', () => {
    const queue = announcementQueue([REVEAL, FORCED, SPELL(), COMBAT()]);
    expect([queue.showing, ...queue.waiting].map((b) => b?.kind)).toEqual([
      'combatHold',
      'spellHold',
      'forcedChoice',
      'reveal',
    ]);
  });

  it('the order is the TABLE’s, never the argument order', () => {
    const forwards = announcementQueue([COMBAT(), SPELL(), FORCED, REVEAL]);
    const backwards = announcementQueue([REVEAL, FORCED, SPELL(), COMBAT()]);
    expect([forwards.showing, ...forwards.waiting].map((b) => b?.kind)).toEqual(
      [backwards.showing, ...backwards.waiting].map((b) => b?.kind),
    );
  });

  it('nulls and undefineds are absences, not entries', () => {
    expect(announcementQueue([null, undefined, null])).toBe(NO_ANNOUNCEMENTS);
    expect(announcementQueue([null, REVEAL, undefined]).showing).toEqual(REVEAL);
    expect(announcementQueue([]).showing).toBeNull();
  });

  it('each announcement has a stable identity, and they do not collide', () => {
    const ids = [COMBAT(), SPELL(), FORCED, REVEAL].map(announcementId);
    expect(new Set(ids).size).toBe(ids.length);
    // Stable: the same subject yields the same id, so the surface does not
    // replay its entrance on every render of the board around it.
    expect(announcementId(SPELL())).toBe(announcementId(SPELL(pointerPressure(NO_HOLD_PRESSURE, true))));
  });
});

// ---------------------------------------------------------------------------
describe('HOLDING THE GAME and BEING ON SCREEN are one answer', () => {
  /**
   * ⚠️ THE EQUIVALENCE PROOF. `PlayView` gated both the auto-passer and the AI
   * seat on the literal `hold || combatHold || forcedChoice`, in two places. It
   * now gates both on `announcements.holdsGame`. Over EVERY combination of live
   * announcements the two agree — so queueing changed what is DRAWN and nothing
   * at all about when the game stops.
   */
  it('the new gate equals the old `hold || combatHold || forcedChoice`, on all 16 combinations', () => {
    const combos: readonly (readonly [boolean, boolean, boolean, boolean])[] = [
      false,
      true,
    ].flatMap((c) =>
      [false, true].flatMap((s) =>
        [false, true].flatMap((f) => [false, true].map((r) => [c, s, f, r] as const)),
      ),
    );
    expect(combos).toHaveLength(16);
    for (const [c, s, f, r] of combos) {
      const queue = announcementQueue([
        c ? COMBAT() : null,
        s ? SPELL() : null,
        f ? FORCED : null,
        r ? REVEAL : null,
      ]);
      // The shipped expression this replaced, evaluated on the same inputs.
      const oldGate = s || c || f;
      expect(queue.holdsGame, `combat=${c} spell=${s} forced=${f} reveal=${r}`).toBe(oldGate);
    }
  });

  it('a REVEAL alone never freezes the game — it is the one notice', () => {
    expect(announcementQueue([REVEAL]).holdsGame).toBe(false);
    expect(announcementHolds(REVEAL)).toBe(false);
  });

  /**
   * A hold waiting behind another hold must still freeze the board, or the game
   * advances between two beats and the second one is standing in a window that
   * has already gone.
   *
   * ⚠️ MEASURED HONESTLY: this assertion does NOT discriminate `some` from
   * `head`. Replacing `queue.some(row.holds)` with `head.holds` was tried, and
   * all 79 assertions stayed green — because the rank invariant makes the two
   * extensionally EQUAL (if any hold is queued, the head is a hold). The
   * discriminating test for that is the invariant above, which reddens the
   * moment a rank moves. `some` is written anyway because it is the form that
   * stays correct if a future row breaks the invariant; the invariant test is
   * what stops the row from breaking it silently.
   */
  it('a hold WAITING behind another hold still holds the game', () => {
    const queue = announcementQueue([COMBAT(), SPELL()]);
    expect(queue.showing?.kind).toBe('combatHold');
    expect(queue.waiting.map((b) => b.kind)).toEqual(['spellHold']);
    expect(queue.holdsGame, 'the waiting hold still freezes the board').toBe(true);
  });

  /**
   * The theorem the rank invariant buys: while the game is held, the thing on
   * screen is a holding announcement. There is no frame where the board is
   * frozen and the player is looking at something unrelated.
   */
  it('whenever the game is held, the announcement SHOWING is the one holding it', () => {
    const everySubset: AnnouncementBody[][] = [[]];
    for (const body of [COMBAT(), SPELL(), FORCED, REVEAL]) {
      for (const soFar of [...everySubset]) everySubset.push([...soFar, body]);
    }
    expect(everySubset).toHaveLength(16);
    for (const live of everySubset) {
      const queue = announcementQueue(live);
      if (!queue.holdsGame) continue;
      expect(queue.showing, JSON.stringify(live.map((b) => b.kind))).not.toBeNull();
      expect(
        announcementHolds(queue.showing as AnnouncementBody),
        `showing ${queue.showing?.kind} while held by ${live.map((b) => b.kind).join('+')}`,
      ).toBe(true);
    }
  });

  it('nothing queued is nothing held', () => {
    expect(NO_ANNOUNCEMENTS.holdsGame).toBe(false);
    expect(NO_ANNOUNCEMENTS.showing).toBeNull();
    expect(NO_ANNOUNCEMENTS.waiting).toHaveLength(0);
  });
});
