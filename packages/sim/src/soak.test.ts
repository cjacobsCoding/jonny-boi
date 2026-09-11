/**
 * THE FAST SOAK TIER — runs in the ordinary suite, every time.
 *
 * `soak.ts` explains what a soak is and why this repo needs one. This file is
 * the tier that always runs: a few dozen seeded games over randomised full-pool
 * decks, every invariant checked on every settled state, and a hard requirement
 * that every mechanic the pool prints actually FIRES.
 *
 * It is deliberately load-bearing rather than decorative — the whole point of the
 * exercise is that "the suite is green" stopped meaning "the assembled game
 * works" once twelve systems shipped in three days and were only ever tested one
 * at a time. If this file can be deleted without anybody noticing, it has failed.
 *
 * The DEEP tier (thousands of games) lives in `soak-deep.test.ts` behind
 * `JB_SOAK_GAMES`; see TESTING.md.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { buildRegistry, loadCardPool } from '@jonny-boi/cards';
import { createDefaultAiRegistry, DEFAULT_PILOT_ID } from '@jonny-boi/ai';
import type { GameEvent } from '@jonny-boi/core';
import { loadDeck, validateDeck } from './deck.js';
import { makeSeats } from './matchup.js';
import {
  SOAK_BASE_SEED,
  SOAK_EVENT_WITNESS,
  SOAK_FAST_MIXED_GAMES,
  SOAK_MAX_TIMEOUT_RATE,
  SOAK_MECHANIC_SEED_ATTEMPTS,
  SOAK_MECHANICS,
  type SoakMechanicId,
} from './soak-config.js';
import {
  buildAnchoredDeck,
  buildMixedDeck,
  indexPoolForSoak,
  SOAK_DECK_SIZE,
} from './soak-decks.js';
import { PINNED_IDENTITIES, PINNED_MATCHUPS } from './soak-pinned-decks.js';
import type { SoakReport } from './soak.js';
import {
  compareApplyPaths,
  formatSoakReport,
  formatViolations,
  replaySoakMixedGame,
  runawayGames,
  runSoak,
  soakSimConfig,
} from './soak.js';

const pool = loadCardPool({ onWarn: () => {} });
const registry = buildRegistry();
const pilot = createDefaultAiRegistry().getPilot(DEFAULT_PILOT_ID)!;
const index = indexPoolForSoak(pool.cards);

/**
 * THE RUN. One `runSoak` shared by every assertion in the last block — playing it
 * once and asserting many things about it is the difference between a fast tier
 * that runs always and one somebody switches off.
 *
 * In a `beforeAll` rather than at module scope on purpose: module-scope work is
 * COLLECTION to Vitest, so the run's cost would be billed to "collect" (where it
 * is invisible) and a throw would fail the whole FILE with a collection error
 * instead of one named test.
 */
let report: SoakReport;

describe('the deck generator produces legal, reproducible, mixed decks', () => {
  it('every generated deck loads through the SAME loader the gauntlet uses', () => {
    const problems: string[] = [];
    for (let seed = 1; seed <= 40; seed++) {
      const deck = buildMixedDeck(index, seed);
      const reasons = validateDeck(deck, pool);
      if (reasons.length > 0) problems.push(`seed ${seed}: ${reasons.join('; ')}`);
      const size = deck.cards.reduce((sum, e) => sum + e.count, 0);
      if (size !== SOAK_DECK_SIZE) problems.push(`seed ${seed}: ${size} cards, expected ${SOAK_DECK_SIZE}`);
    }
    expect(problems).toEqual([]);
  });

  it('is a pure function of its seed — the same seed rebuilds the same sixty cards', () => {
    // Without this, "here is the seed that reproduces it" is a lie, and every
    // failure message this harness prints is worthless.
    for (const seed of [7, 4242, 0xc0ffee]) {
      expect(JSON.stringify(buildMixedDeck(index, seed))).toBe(JSON.stringify(buildMixedDeck(index, seed)));
    }
  });

  it('an anchored deck really contains the mechanic it is anchored on', () => {
    const problems: string[] = [];
    for (const mechanic of SOAK_MECHANICS) {
      const printed = index.byMechanic.get(mechanic.id) ?? [];
      if (printed.length === 0) continue; // the pool has none — pool-mechanics.test.ts owns that
      const deck = buildAnchoredDeck(index, mechanic.id, 1234);
      if (!deck) {
        problems.push(`${mechanic.id}: the pool prints ${printed.length} card(s) but no deck could be anchored on it`);
        continue;
      }
      const names = new Set(printed.map((c) => c.id));
      if (!deck.cards.some((e) => names.has(e.cardId))) {
        problems.push(`${mechanic.id}: the anchored deck contains none of its ${printed.length} cards`);
      }
      const reasons = validateDeck(deck, pool);
      if (reasons.length > 0) problems.push(`${mechanic.id}: illegal deck — ${reasons.join('; ')}`);
    }
    expect(problems).toEqual([]);
  });

  it('generated decks genuinely MIX systems rather than repeating one', () => {
    // A "mixed" generator that produced forty copies of the same archetype would
    // pass every other test here and soak nothing. Count how many distinct
    // mechanics the union of a batch of decks prints.
    const seen = new Set<SoakMechanicId>();
    for (let seed = 1; seed <= 24; seed++) {
      const deck = buildMixedDeck(index, seed);
      const ids = new Set(deck.cards.map((e) => e.cardId));
      for (const mechanic of SOAK_MECHANICS) {
        if ((index.byMechanic.get(mechanic.id) ?? []).some((c) => ids.has(c.id))) seen.add(mechanic.id);
      }
    }
    expect(seen.size, `only ${seen.size} mechanics appear across 24 mixed decks`).toBeGreaterThanOrEqual(12);
  });
});

describe('the mechanic inventory is a closed, checkable manifest', () => {
  it('every event type the engine can emit is classified', () => {
    // A companion to the mapped type in `soak-config.ts`: the TYPE makes a new
    // event break the build, and this makes a *stale* entry (an event type that
    // vanished) visible too.
    const classified = Object.keys(SOAK_EVENT_WITNESS) as GameEvent['type'][];
    expect(classified.length).toBeGreaterThan(50);
    for (const key of classified) {
      const value = SOAK_EVENT_WITNESS[key];
      if (value !== null) {
        expect(SOAK_MECHANICS.map((m) => m.id), `${key} names an unknown mechanic`).toContain(value);
      }
    }
  });

  it('every mechanic in the inventory is witnessable — by an event, an action or a state', () => {
    // A mechanic nobody can witness would sit in the inventory for ever reading
    // like a guarantee and asserting nothing.
    const byEvent = new Set(Object.values(SOAK_EVENT_WITNESS).filter((v): v is SoakMechanicId => v !== null));
    const missing = SOAK_MECHANICS.filter(
      (m) => m.witnessKind === 'event' && !byEvent.has(m.id) && !WITNESSED_WITH_EXTRA_CONTEXT.has(m.id),
    );
    expect(missing.map((m) => m.id)).toEqual([]);
  });
});

/**
 * Mechanics witnessed by an event PLUS something the event TYPE alone cannot say,
 * so they are absent from `SOAK_EVENT_WITNESS`'s one-type-one-mechanic table.
 *
 * Two shapes, both handled in `soak.ts`:
 *  - the SOURCE that asked. X, kicker and buyback all park a question, and scry
 *    and surveil are the same printed look with different destinations, so the
 *    mechanic lives in the card behind `choiceAsked.sourceInstanceId`;
 *  - the counter KIND. `counterAdded` covers +1/+1, loyalty and defense alike,
 *    and crediting it wholesale would let a planeswalker entering play satisfy
 *    the +1/+1-counter requirement.
 */
const WITNESSED_WITH_EXTRA_CONTEXT: ReadonlySet<SoakMechanicId> = new Set([
  'x-cost',
  'kicker',
  'buyback',
  'scry',
  'surveil',
  'optional-payment',
  'graveyard-recursion',
  'counters',
  'additional-cast-cost',
  'tutor-route',
  // Witnessed by replacementApplied PLUS its payload: the event type alone is
  // every replacement family at once, and the tokens family is the payload.
  'token-count-replacement',
]);

describe('the fast soak', () => {
  beforeAll(() => {
    report = runSoak({
      pool,
      registry,
      pilot,
      mixedGames: SOAK_FAST_MIXED_GAMES,
      anchorAttempts: SOAK_MECHANIC_SEED_ATTEMPTS,
      baseSeed: SOAK_BASE_SEED,
    });
  });

  it('breaks no invariant across the whole run', () => {
    expect(report.violations.length, `\n${formatViolations(report.violations)}\n`).toBe(0);
  });

  it('never plays a game that cannot END', () => {
    // The recorded failure shape: a combat-declaration bug once made games
    // unable to finish while every test in the repo passed, because every test
    // asserted "it finished" via a cap that the bug simply hit.
    //
    // ⚠️ ASKED THROUGH `runawayGames`, not through `actionCapHits`. This line WAS
    // `expect(report.actionCapHits).toBe(0)`, and that is a different question:
    // the per-turn bound is a third of the game-wide cap, so a runaway trips it
    // first, is drawn by CR 104.4b, and never touches the cap this test named. It
    // was green for exactly the thing it exists to catch (DESIGN §3.140).
    expect(runawayGames(report).length, `\n${formatSoakReport(report)}\n`).toBe(0);
    // Belt and braces: the summary counters and the violation list are two
    // renderings of one fact, and a divergence between them is itself a bug.
    expect(report.actionCapHits + report.loopDraws).toBe(0);
  });

  it('finishes most games on the board rather than on the turn cap', () => {
    const rate = report.timeouts / Math.max(report.games, 1);
    expect(rate, `${report.timeouts}/${report.games} games stalled to the turn cap`).toBeLessThan(
      SOAK_MAX_TIMEOUT_RATE,
    );
  });

  it('fires EVERY mechanic the pool prints — an inert feature is not shipped', () => {
    expect(report.inertMechanics, `\n${formatSoakReport(report)}\n`).toEqual([]);
  });

  it('plays enough games, over enough turns, to mean something', () => {
    // Guards the guard: a soak whose deck generator silently started producing
    // unplayable piles would report zero violations and zero of everything else.
    expect(report.games).toBeGreaterThanOrEqual(SOAK_FAST_MIXED_GAMES);
    expect(report.turns / report.games, 'games are ending before anything happens').toBeGreaterThan(3);
    expect(report.actions).toBeGreaterThan(report.games * 20);
  });
});

/*
 * PINNED SOAK VIOLATIONS — one game each, replayed from the seed the run printed.
 *
 * The soak's whole contract is that a violation reproduces (`soak-config.ts`'s
 * header: "a violation prints the seed AND both decklists"). This is where that
 * contract gets spent: a defect the tier found becomes a ~200 ms test that fails
 * for exactly the original reason, instead of a seed in a commit message that
 * nobody can afford to re-run.
 *
 * Add a row when a soak finds something. Keep the row after it is fixed — the
 * point is the fix staying fixed.
 *
 * ⚠️ **EVERY ROW MUST NAME THE CARDS THAT MADE THE BUG**, and the test asserts
 * they are really in the decks this seed built. "No violations" is also what a
 * replay of the WRONG game reports, so an outcome-only assertion is green for two
 * completely different reasons and cannot tell them apart. This was not a
 * hypothesis: flipping one bit of the opponent-deck seed left the row below
 * passing, happily replaying a different match. That half of the test is what
 * fails when the pool churns until this seed no longer deals the position —
 * which is a finding, not a pass.
 *
 * The card names live in `soak-pinned-decks.ts` (`PINNED_IDENTITIES`), next to
 * the decklists they describe and read by `loop-runaway.test.ts` too — one answer
 * to "which game is this", and its doc carries the rule the list has to obey
 * (name cards from BOTH decks, or substituting one of them goes unnoticed).
 */
describe('soak violations stay fixed, replayed from their seed alone', () => {
  const PINNED: ReadonlyArray<{
    readonly seed: number;
    readonly onPlay?: 'A' | 'B';
    readonly what: string;
  }> = [
    {
      seed: 4222011655,
      what:
        'CR 704.5f: a Weakness-ed Blood Artist held above zero toughness by a Trusty Machete that ' +
        "Costly Plunder's additional cost then sacrificed — the payment handed priority straight " +
        'back to the caster, so nothing checked state-based actions and the 0/0 sat there for five ' +
        'turns (fixed by moving the CR 704.3 boundary to the end of every action)',
    },
    /*
     * THE COPY-MIRROR LOOP — one defect, three seeds, both seats.
     *
     * Two copy spells on the stack are each other's only interesting target, and
     * the pilot priced a copy spell at its FACE VALUE, so re-aiming a copy at the
     * other copy spell always outscored aiming it at the real spell underneath.
     * Every copy then made another copy, neither original ever reached the top of
     * the stack, and the game burned the 6,000-action cap ~1,850 copies deep.
     *
     * All three rows are kept even though one fix covers them: they are different
     * cards (Twincast / Reverberate), different seats (A and B) and different
     * turns, so a regression that only re-breaks one of the three still fails
     * loudly here.
     */
    {
      seed: 1390617766,
      onPlay: 'A',
      what:
        'CR 707.10: a copy of Twincast re-aimed at the Twincast that made it, forever — the pilot ' +
        'valued copying a copy spell at the copy spell\'s own face value, so the mirror always beat ' +
        'copying the Dream Twist underneath it (fixed by pricing a copy by what its chain delivers)',
    },
    {
      seed: 3434778477,
      onPlay: 'B',
      what: 'CR 707.10: the same copy-mirror loop on Reverberate, seat B',
    },
    {
      seed: 113343071,
      onPlay: 'A',
      what: 'CR 707.10: the same copy-mirror loop with Reverberate + Narset\'s Reversal, seat A',
    },
    /*
     * THE MANA EXCHANGE THAT PAID FOR ITSELF — §3.141, and the first row this
     * block could not have held before §3.140 un-blinded `gameCanEnd`: the turn
     * bound tripped first, the game was filed as a legal CR 104.4b draw, and the
     * runaway was invisible for as long as the class was live.
     *
     * Seven sibling seeds do the same thing with the same card (3505743309,
     * 437769586, 506638966, 2340004011, 1830547618, 44358381, 876545993, and
     * every one of them on BOTH seats). One is pinned rather than all eight
     * because they are one position, not eight — each is B's Bog Initiate on an
     * all-black pool — and a fast tier that replays one finding eight times is a
     * tier somebody switches off.
     */
    {
      seed: 3791358276,
      onPlay: 'A',
      what:
        'CR 602: the pilot activated Bog Initiate ({1}: Add {B}) ~665 times in one turn, paying the ' +
        '{1} with the {B} it had just made — a repeatable ability with no net state change, priced ' +
        'at its output and never against its cost, until CR 104.4b drew the game (fixed by refusing ' +
        'a pure mana exchange that would leave the pool exactly as it found it)',
    },
  ];

  for (const { seed, onPlay, what } of PINNED) {
    it(`seed ${seed}: ${what}`, () => {
      // The decks are PINNED, not regenerated. Generating them from the seed
      // meant every pool change re-dealt these rows onto a different match —
      // §3.35 added two cards and did exactly that to three of the four. See
      // `soak-pinned-decks.ts`.
      const pinnedDecks = PINNED_MATCHUPS[seed];
      // WHICH CARDS MAKE IT THIS GAME — read from `soak-pinned-decks.ts`, which
      // owns both halves of a matchup's identity so the two can never disagree.
      const mustContain = PINNED_IDENTITIES[seed];
      expect(pinnedDecks, `seed ${seed} has no recorded decklist`).toBeDefined();
      expect(mustContain, `seed ${seed} has no recorded identity`).toBeDefined();
      const { violations, decks } = replaySoakMixedGame({
        pool,
        registry,
        pilot,
        seed,
        decks: pinnedDecks,
        ...(onPlay ? { onPlay } : {}),
      });
      // WHICH GAME — asserted first, because it is what makes the next line mean
      // anything. A replay that drifted onto another match reports no violations
      // and would otherwise read as a fix holding.
      for (const card of mustContain!) {
        expect(decks, `seed ${seed} no longer deals ${card} — this row is replaying a DIFFERENT game
${decks}
`).toContain(card);
      }
      // WHAT IT DID.
      expect(violations.length, `
${formatViolations(violations)}
`).toBe(0);
    });
  }
});

describe('applyActionInPlace stays exact on SOAK decks', () => {
  /*
   * `match-inplace.test.ts` pins this for four CURATED decks and three seeds.
   * Those decks predate transform, modal casting, madness, card grants,
   * planeswalkers and attachments — every one of which mutates state in a shape
   * that did not exist when that test was written, and an in-place path that
   * aliased one of them would silently rewrite every win-rate and every A/B
   * verdict in the product.
   *
   * So the pairs below are ANCHORED on those systems specifically, not merely
   * random: each matchup is guaranteed to contain the mechanics named in it.
   * The mixed pair is kept as the control.
   */
  const sim = soakSimConfig();
  const PAIRS: ReadonlyArray<readonly [SoakMechanicId | 'mixed', SoakMechanicId | 'mixed', number]> = [
    ['transform-dfc', 'modal-cast', 11],
    ['madness', 'graveyard-grant', 2027],
    ['planeswalker-loyalty', 'attachment', 0xbadc0de],
    ['mixed', 'mixed', 4242],
  ];
  for (const [left, right, seed] of PAIRS) {
    it(`is bit-identical: ${left} vs ${right} @ seed ${seed}`, () => {
      const build = (which: SoakMechanicId | 'mixed', s: number) =>
        which === 'mixed' ? buildMixedDeck(index, s) : buildAnchoredDeck(index, which, s);
      const deckA = build(left, seed);
      const deckB = build(right, seed ^ 0x27d4eb2f);
      // A mechanic the pool cannot print is `pool-mechanics.test.ts`'s business,
      // not this test's — but silently skipping would make a green run
      // meaningless, so say so.
      expect(deckA, `${left} could not be anchored — see pool-mechanics.test.ts`).toBeDefined();
      expect(deckB, `${right} could not be anchored — see pool-mechanics.test.ts`).toBeDefined();
      const seats = makeSeats(loadDeck(deckA!, pool), loadDeck(deckB!, pool), { pilotA: pilot, pilotB: pilot }, registry);
      expect(compareApplyPaths(seats, seed, sim, 'A')).toBeUndefined();
    });
  }
});
