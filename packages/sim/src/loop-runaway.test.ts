/**
 * THE RUNAWAY THE GUARD COULD NOT SEE — DESIGN §3.139.
 *
 * `soak-config.ts`'s `gameCanEnd` invariant exists for one class: *this game
 * cannot end*. It watched the game-wide action cap (6,000). A game has a SECOND
 * bound, per TURN (2,000), and overrunning it is recorded as a CR 104.4b draw —
 * so a runaway trips the smaller bound FIRST, is filed as a legal loop draw, and
 * never reaches the counter the invariant was reading. The check that exists to
 * catch "this game cannot end" was structurally incapable of catching it, and
 * said nothing at all for the whole time the class was live.
 *
 * The rows below are the measurement. Each drives a real soak game into a
 * runaway and requires the soak to REPORT it.
 *
 * ⚠️ **The engine cannot tell a mandatory loop from a pilot that will not stop,
 * and nothing here pretends it can.** CR 104.4b legitimately draws a MANDATORY
 * loop — Dualcaster Mage plus a Rite of Replication copy, where every step is
 * compulsory and no player can decline their way out. `{kind:'loop'}` is inferred
 * from an action counter and means only "this turn overran", which is equally
 * true of a pilot re-aiming a copy spell 661 times because it likes the price.
 * So the soak reports what it saw plus the traffic that produced it, and the
 * RULING lives in the `ruling` column of the table below, written by a human. A
 * row ruled `mandatory-loop` is a legal game the report must keep naming; a row
 * ruled `pilot-will-not-stop` is a bug. Making the engine guess between them
 * would put the blindness back, one layer down.
 */
import { describe, expect, it } from 'vitest';
import { createDefaultAiRegistry, DEFAULT_PILOT_ID, type Pilot } from '@jonny-boi/ai';
import { buildRegistry, loadCardPool } from '@jonny-boi/cards';
import type { GameAction, InstanceId } from '@jonny-boi/core';
import { SOAK_INVARIANTS } from './soak-config.js';
import { PINNED_MATCHUPS } from './soak-pinned-decks.js';
import { formatViolations, replaySoakMixedGame } from './soak.js';

const pool = loadCardPool({ onWarn: () => {} });
const registry = buildRegistry();
const heuristic = createDefaultAiRegistry().getPilot(DEFAULT_PILOT_ID)!;

/** The primitive that makes a spell a COPY spell — the thing the mirror is made of. */
const COPY_SPELL_PRIMITIVE = 'copySpell';

/** Below this the row is not the runaway it claims to be, only a slow game. */
const RUNAWAY_MIN_COPIES = 100;

/**
 * A PILOT THAT WILL NOT STOP: it re-aims every copy at another copy spell.
 *
 * This is the §3.33 defect re-created at the SEAM rather than by reverting the
 * fix — and that distinction is the whole reason this file can exist. Reverting
 * `copyPayloadValue` to price a copy at the copied card's face value reproduces
 * the runaway too, but only as a manual experiment nobody re-runs; a pinned row
 * has to reproduce it from committed code. Everything except the one answer is
 * the shipped heuristic, so what is pinned here is "a pilot preferring the mirror
 * burns the turn", which stays true however the valuation is later tuned.
 *
 * ⚠️ It must NOT be used to assert anything about how the shipped pilot plays.
 * `soak.test.ts`'s pinned rows own that question, and they answer it with the
 * real pilot.
 */
function stubbornCopyPilot(inner: Pilot): Pilot {
  return {
    id: `${inner.id}-will-not-stop`,
    description: 'always re-aims a copy at another copy spell (DESIGN §3.139 fixture)',
    chooseAction(ctx): GameAction {
      const pending = ctx.view.pendingChoice;
      if (pending?.kind === 'selectTargets') {
        const copies = new Set<InstanceId>(
          ctx.view.stack
            .filter(
              (obj) =>
                obj.kind === 'spell' &&
                (obj.card.def.effects ?? []).some((e) => e.primitive === COPY_SPELL_PRIMITIVE),
            )
            .map((obj) => obj.instanceId),
        );
        const mirror = ctx.legalActions.find(
          (a) =>
            a.kind === 'answerChoice' &&
            a.answer.kind === 'selectTargets' &&
            a.answer.targets.length > 0 &&
            a.answer.targets.every((t) => copies.has(t as InstanceId)),
        );
        if (mirror) return mirror;
      }
      return inner.chooseAction(ctx);
    },
  };
}

/** `spellCopied ×661` → 661, or 0 when the detail never named the event. */
function copiesReported(detail: string): number {
  return Number(/spellCopied ×(\d+)/.exec(detail)?.[1] ?? 0);
}

/**
 * ONE RUNAWAY EACH — and the ruling a human made about it.
 *
 * The three seeds are §3.33's copy mirror, replayed from their PINNED decklists
 * (see `soak-pinned-decks.ts` for why a pinned row carries its own decks). With
 * the shipped pilot they are ordinary games and `soak.test.ts` asserts they break
 * nothing; driven by a pilot that will not stop they are the exact class this
 * invariant exists for, on both seats and on two different copy spells.
 */
const RUNAWAYS: ReadonlyArray<{
  readonly seed: number;
  readonly onPlay: 'A' | 'B';
  readonly ruling: 'pilot-will-not-stop' | 'mandatory-loop';
  readonly what: string;
  /** Cards without which this seed is not the game that found the bug. */
  readonly mustContain: readonly string[];
}> = [
  {
    seed: 1390617766,
    onPlay: 'A',
    ruling: 'pilot-will-not-stop',
    what: 'the Twincast mirror — a copy re-aimed at the Twincast that made it, forever',
    mustContain: ['Twincast', 'Dream Twist'],
  },
  {
    seed: 3434778477,
    onPlay: 'B',
    ruling: 'pilot-will-not-stop',
    what: 'the same mirror on Reverberate, seat B',
    mustContain: ['Reverberate'],
  },
  {
    seed: 113343071,
    onPlay: 'A',
    ruling: 'pilot-will-not-stop',
    what: "the same mirror with Reverberate + Narset's Reversal, seat A",
    mustContain: ['Reverberate', "Narset's Reversal"],
  },
];

describe('a turn that overran is a game that could not END', () => {
  for (const { seed, onPlay, ruling, what, mustContain } of RUNAWAYS) {
    it(`seed ${seed} (${ruling}): ${what}`, () => {
      const pinnedDecks = PINNED_MATCHUPS[seed];
      expect(pinnedDecks, `seed ${seed} has no recorded decklist`).toBeDefined();
      const { violations, decks } = replaySoakMixedGame({
        pool,
        registry,
        pilot: stubbornCopyPilot(heuristic),
        seed,
        decks: pinnedDecks,
        onPlay,
      });

      /*
       * WHICH GAME — asserted before anything about the outcome, because "no
       * violations" is also what a replay of the WRONG game reports and the two
       * greens are indistinguishable. This is not hypothetical: an earlier agent
       * flipped one bit of the opponent-deck seed and the pinned test stayed
       * green, happily replaying a different match and finding nothing in it.
       */
      for (const card of mustContain) {
        expect(decks, `seed ${seed} no longer deals ${card} — this row is replaying a DIFFERENT game\n${decks}\n`).toContain(
          card,
        );
      }

      // WHAT THE SOAK SAID. One `gameCanEnd` row, whatever else the game did.
      const runaway = violations.filter((v) => v.invariant === SOAK_INVARIANTS.gameCanEnd);
      expect(
        runaway.length,
        `the turn overran and the soak reported no runaway — the §3.139 blindness is back\n${formatViolations(violations)}\n`,
      ).toBe(1);

      // AND WHY IT IS RULEABLE. The detail carries the traffic, which is the only
      // thing a reader can rule on: hundreds of spell copies is a mirror, not a
      // mandatory loop. Asserted as a floor rather than the recorded 661, because
      // everything except the one stubborn answer is the shipped heuristic and
      // that moves; a row pinned to an exact count would go red for a pilot
      // improvement, which is a test measuring the wrong thing.
      const detail = runaway[0]!.detail;
      expect(detail, 'a runaway row that names no traffic cannot be ruled on').toContain('spellCopied');
      expect(copiesReported(detail), `only ${copiesReported(detail)} copies — this is not the mirror\n${detail}`).toBeGreaterThan(
        RUNAWAY_MIN_COPIES,
      );
    }, 120000);
  }
});
