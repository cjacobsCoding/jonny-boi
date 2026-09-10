/**
 * THE RUNAWAY THE GUARD COULD NOT SEE — DESIGN §3.140.
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
import type { SoakDeck } from './soak-decks.js';
import { SOAK_BASE_SEED, SOAK_INVARIANTS } from './soak-config.js';
import { PINNED_IDENTITIES, PINNED_MATCHUPS } from './soak-pinned-decks.js';
import {
  formatViolations,
  replaySoakMixedGame,
  runawayGames,
  runSoak,
  soakSimConfig,
} from './soak.js';

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
    description: 'always re-aims a copy at another copy spell (DESIGN §3.140 fixture)',
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
}> = [
  {
    seed: 1390617766,
    onPlay: 'A',
    ruling: 'pilot-will-not-stop',
    what: 'the Twincast mirror — a copy re-aimed at the Twincast that made it, forever',
  },
  {
    seed: 3434778477,
    onPlay: 'B',
    ruling: 'pilot-will-not-stop',
    what: 'the same mirror on Reverberate, seat B',
  },
  {
    seed: 113343071,
    onPlay: 'A',
    ruling: 'pilot-will-not-stop',
    what: "the same mirror with Reverberate + Narset's Reversal, seat A",
  },
];

describe('a turn that overran is a game that could not END', () => {
  for (const { seed, onPlay, ruling, what } of RUNAWAYS) {
    it(`seed ${seed} (${ruling}): ${what}`, () => {
      const pinnedDecks = PINNED_MATCHUPS[seed];
      const mustContain = PINNED_IDENTITIES[seed];
      expect(pinnedDecks, `seed ${seed} has no recorded decklist`).toBeDefined();
      expect(mustContain, `seed ${seed} has no recorded identity`).toBeDefined();
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
      for (const card of mustContain!) {
        expect(
          decks,
          `seed ${seed} no longer deals ${card} — this row is replaying a DIFFERENT game\n${decks}\n`,
        ).toContain(card);
      }

      // WHAT THE SOAK SAID. One `gameCanEnd` row, whatever else the game did.
      const runaway = violations.filter((v) => v.invariant === SOAK_INVARIANTS.gameCanEnd);
      expect(
        runaway.length,
        `the turn overran and the soak reported no runaway — the §3.140 blindness is back\n${formatViolations(violations)}\n`,
      ).toBe(1);

      // AND WHY IT IS RULEABLE. The detail carries the traffic, which is the only
      // thing a reader can rule on: hundreds of spell copies is a mirror, not a
      // mandatory loop. Asserted as a floor rather than the recorded 661, because
      // everything except the one stubborn answer is the shipped heuristic and
      // that moves; a row pinned to an exact count would go red for a pilot
      // improvement, which is a test measuring the wrong thing.
      const detail = runaway[0]!.detail;
      expect(detail, 'a runaway row that names no traffic cannot be ruled on').toContain(
        'spellCopied',
      );
      expect(
        copiesReported(detail),
        `only ${copiesReported(detail)} copies — this is not the mirror\n${detail}`,
      ).toBeGreaterThan(RUNAWAY_MIN_COPIES);
    }, 120000);
  }
});

/**
 * THE SUMMARY AND THE VIOLATION LIST ARE ONE FACT — and this is where they are
 * made to agree.
 *
 * `SoakReport.loopDraws` counts the games; `runawayGames` lists them. Two
 * renderings of one question is exactly how the original blindness lasted: the
 * count existed the whole time, said "8", and no assertion read it. A run where
 * the two disagree is a bug in the report, and the tiers assert on both.
 *
 * The bound is dropped to one action so EVERY game overruns, which is the only
 * way to make the funnel fire without waiting for a real loop to be dealt. What
 * is pinned is the plumbing, deliberately: `loop-draw.test.ts` owns "an
 * overrunning turn is a draw, not a timeout", the rows above own "a real runaway
 * is caught", and this owns "and the report says so in both places".
 */
describe('the report counts a runaway exactly once, in both places', () => {
  it('every loop draw is a gameCanEnd violation and vice versa', () => {
    const report = runSoak({
      pool,
      registry,
      pilot: heuristic,
      mixedGames: 4,
      // One attempt per mechanic: with a one-action bound no mechanic can ever
      // fire, and the default retry budget would re-roll every one of them.
      anchorAttempts: 1,
      baseSeed: SOAK_BASE_SEED,
      sim: { ...soakSimConfig(), maxActionsPerTurn: 1 },
    });
    expect(report.loopDraws, 'a one-action turn bound must draw every game').toBeGreaterThan(0);
    expect(
      report.actionCapHits,
      'the turn bound trips long before the game cap — that is the whole finding',
    ).toBe(0);
    expect(
      runawayGames(report).length,
      `the summary and the list disagree\n${formatViolations(report.violations)}`,
    ).toBe(report.loopDraws);
  }, 300000);
});

/*
 * ---------------------------------------------------------------------------
 * AND THE OTHER VERDICT: a loop the RULES draw.
 * ---------------------------------------------------------------------------
 */

/** The pair CR 104.4b is written for — put in BY NAME, never hoped for from a seed. */
const MANDATORY_LOOP_CARDS = ['Dualcaster Mage', 'Rite of Replication'] as const;

/**
 * Seeds on that board which end `loop`. Several, deliberately.
 *
 * ⚠️ Pinning ONE was this repo's recorded mistake: `loop-draw.test.ts`'s header
 * records that its first version pinned a single seed where the heuristic looped
 * and "the very next pilot improvement made it WIN that game instead". A whole
 * board is what is pinned here, and any one of these seeds satisfies the row —
 * measured at 238 loops in 300 games, so losing all six means the pilot stopped
 * walking into mandatory loops at all, which is a FINDING to re-rule rather than
 * a regression to fix.
 */
const MANDATORY_LOOP_SEEDS: ReadonlyArray<readonly [number, 'A' | 'B']> = [
  [635374, 'A'],
  [740103, 'B'],
  [1159019, 'A'],
  [1159019, 'B'],
  [2101580, 'A'],
  [2101580, 'B'],
];

/**
 * How decisively the split has to fall before a row may call it either way.
 *
 * Measured over 80 games on this board: 56 ended `loop`, and the readings are
 * bimodal — 398 answered against 1,980 auto-answered (five to one, compulsory)
 * or 1,185 answered against 0 (a pilot that will not stop). Between them sit
 * eight games at 396 vs 397, which is not a verdict at all; a bare `>` would let
 * a coin flip decide a CR 104.4b ruling, so the seeds pinned above are the
 * decisive ones and a row that lands on a near-tie goes red and asks for a human.
 */
const RULING_MARGIN = 2;

/** A legal 60 with the loop's two halves in it, and enough mana to cast them. */
function mandatoryLoopDeck(): SoakDeck {
  const idOf = (name: string) => {
    const card = pool.cards.find((c) => c.name === name);
    if (!card) throw new Error(`the pool no longer prints '${name}' — re-rule this row`);
    return card.id;
  };
  return {
    name: 'cr104-4b-mandatory-loop',
    archetype: 'loop/UR',
    seed: 0,
    colors: ['U', 'R'],
    cards: [
      { cardId: idOf('Dualcaster Mage'), count: 4 },
      { cardId: idOf('Rite of Replication'), count: 4 },
      { cardId: idOf('Twincast'), count: 4 },
      { cardId: idOf('Island'), count: 32 },
      { cardId: idOf('Mountain'), count: 16 },
    ],
  };
}

/** `… N were ANSWERED by a player and M had a single legal option …` → [N, M]. */
function whoChose(detail: string): readonly [number, number] {
  const m = /questions (\d+) were ANSWERED by a player and (\d+) had a single legal option/.exec(
    detail,
  );
  return m ? [Number(m[1]), Number(m[2])] : [0, 0];
}

describe('a loop the RULES draw is reported too — and is TOLD APART, not swallowed', () => {
  it('CR 104.4b: Dualcaster Mage + Rite of Replication, compulsory at every step', () => {
    const deck = mandatoryLoopDeck();
    let found: { detail: string; decks: string } | null = null;
    for (const [seed, onPlay] of MANDATORY_LOOP_SEEDS) {
      const { violations, decks } = replaySoakMixedGame({
        pool,
        registry,
        pilot: heuristic,
        seed,
        decks: { A: deck, B: deck },
        onPlay,
      });
      // WHICH GAME, before anything else — the two cards are the position.
      for (const card of MANDATORY_LOOP_CARDS) {
        expect(decks, `seed ${seed} is not the CR 104.4b board\n${decks}\n`).toContain(card);
      }
      const runaway = violations.find((v) => v.invariant === SOAK_INVARIANTS.gameCanEnd);
      // ⚠️ THE FIRST SEED THAT RUNS AWAY IS THE ONE RULED ON. The scan skips a
      // seed that produced no runaway at all (a pilot change can do that) and
      // NEVER a seed whose reading it dislikes. Scanning for a match is how this
      // row escaped its own sabotage the first time: inverting the chosen /
      // auto-answered discriminator made it walk down the list until it found a
      // game satisfying the inverted reading, and pass. A row that keeps looking
      // until it agrees with itself is not a check.
      if (!runaway) continue;
      found = { detail: runaway.detail, decks };
      break;
    }
    expect(
      found,
      `none of the ${MANDATORY_LOOP_SEEDS.length} pinned seeds ran away on this board at all. That ` +
        `is a finding to re-rule, not a regression to fix: either the pilot stopped ` +
        `walking into CR 104.4b, or the two cards stopped combining.`,
    ).not.toBeNull();

    // ⚠️ THE DISTINCTION, asserted rather than described. This is the row that
    // proves the report can tell a legal draw from a pilot that will not stop:
    // here the loop's steps had ONE legal option each and nobody was asked, while
    // every `RUNAWAYS` row above is hundreds of answers a pilot chose to give.
    const [chosen, forced] = whoChose(found!.detail);
    expect(
      forced,
      `RE-RULE THIS ROW: this board produced a loop that was mostly CHOSEN, not compulsory\n${found!.detail}`,
    ).toBeGreaterThan(chosen * RULING_MARGIN);
    expect(forced, 'and it must be a LOOP, not two forced steps').toBeGreaterThan(
      RUNAWAY_MIN_COPIES,
    );
  }, 600000);

  it('and the copy mirror is the OTHER verdict, on the same measurement', () => {
    // The pair to the row above, deliberately adjacent: same invariant, same
    // report, opposite reading. If both rows ever agree, the split has stopped
    // discriminating and the ruling column is decoration.
    const { violations } = replaySoakMixedGame({
      pool,
      registry,
      pilot: stubbornCopyPilot(heuristic),
      seed: 1390617766,
      decks: PINNED_MATCHUPS[1390617766]!,
      onPlay: 'A',
    });
    const runaway = violations.find((v) => v.invariant === SOAK_INVARIANTS.gameCanEnd);
    expect(runaway, 'the mirror stopped being a runaway').toBeDefined();
    const [chosen, forced] = whoChose(runaway!.detail);
    expect(
      chosen,
      `a pilot that will not stop must be mostly ANSWERED\n${runaway!.detail}`,
    ).toBeGreaterThan(forced * RULING_MARGIN);
    expect(chosen).toBeGreaterThan(RUNAWAY_MIN_COPIES);
  }, 120000);
});
