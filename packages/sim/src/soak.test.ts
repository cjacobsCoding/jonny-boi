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
import type { SoakReport } from './soak.js';
import {
  compareApplyPaths,
  formatSoakReport,
  formatViolations,
  replaySoakMixedGame,
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
    expect(report.actionCapHits, `\n${formatSoakReport(report)}\n`).toBe(0);
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
 * ⚠️ **EVERY ROW MUST NAME THE CARDS THAT MADE THE BUG, PER SEAT**, and the test
 * asserts they are really in the deck that seat was dealt. "No violations" is
 * also what a replay of the WRONG game reports, so an outcome-only assertion is
 * green for two completely different reasons and cannot tell them apart. This was
 * not a hypothesis: flipping one bit of the opponent-deck seed left the rows below
 * passing, happily replaying a different match.
 *
 * ⚠️ **PER SEAT is the part that took two goes.** A flat list is checked against
 * both decklists at once, so a row whose cards all sit in deck A stays green when
 * deck B is replaced wholesale — which is exactly what the bit-flip sabotage did
 * to two of the three rows here. Naming the seat is what makes the assertion
 * about the MATCHUP rather than about the pool.
 *
 * `mustContain` is also the half of the test that fails when the pool churns until
 * this seed no longer deals the position — which is a finding, not a pass.
 */
describe('soak violations stay fixed, replayed from their seed alone', () => {
  const PINNED: ReadonlyArray<{
    readonly seed: number;
    readonly onPlay?: 'A' | 'B';
    readonly what: string;
    /**
     * Cards without which this seed is not the game that found the bug, listed
     * under the SEAT that must be dealt them. Both seats, always: half a matchup
     * is not a game.
     */
    readonly mustContain: { readonly A: readonly string[]; readonly B: readonly string[] };
  }> = [
    /*
     * THE THREE GAMES THAT COULD NOT END, and they are ONE bug: the pilot priced
     * a copy of a COPY SPELL as a card (8 + 2 per mana value) rather than as what
     * it would end up copying, so "you may choose new targets for the copy"
     * (CR 707.10) aimed every new copy back at the copy spell sitting above its
     * own target. Each of the three froze with a two-object stack and a board
     * that never changed while ~1,800 copies were made.
     *
     * ⚠️ The DRAW ENGINE each of these decks also holds (Howling Mine, Font of
     * Mythos, Kami of the Crescent Moon) is NOT part of the position and is not
     * named below. It was the first hypothesis and it is a coincidence of the
     * decks the generator dealt: the loop needs two copy spells and one spell
     * worth less than they cost, nothing more.
     */
    {
      seed: 3434778477,
      onPlay: 'B',
      what:
        'CR 707.10: with the stack at [Thought Scour, Reverberate→Thought Scour], every copy of the ' +
        'Reverberate was re-aimed at the Reverberate (worth 12 as a card) instead of the Thought ' +
        'Scour (worth 10), so the copy copied the copy spell forever — 6,000 actions, 1,797 copies, ' +
        'one unchanged board (fixed by pricing a copy chain at what it ENDS at, one link down)',
      // The loop is A's, both halves of it. B's Font of Mythos is the other side
      // of the matchup — the extra draw is why turn 20 still had two Reverberates
      // in hand — and naming it is what makes this row about this GAME.
      mustContain: { A: ['Reverberate', 'Thought Scour'], B: ['Font of Mythos'] },
    },
    {
      seed: 1390617766,
      what:
        'the same loop through Twincast: stack frozen at [Dream Twist, Twincast→Dream Twist] for ' +
        '1,891 copies. Reproduces from BOTH seats, which is what proved it was the pilot rather ' +
        'than anything about who was on the play',
      mustContain: { A: ['Twincast', 'Dream Twist'], B: ['Howling Mine'] },
    },
    {
      seed: 113343071,
      what:
        "the same loop through the OPPONENT's Reverberate: stack frozen at [Geistflame, " +
        'Reverberate→Geistflame] for 1,848 copies',
      mustContain: { A: ['Mikokoro, Center of the Sea'], B: ['Reverberate', 'Geistflame'] },
    },
  ];

  for (const { seed, onPlay, what, mustContain } of PINNED) {
    it(`seed ${seed}: ${what}`, () => {
      const { violations, decks } = replaySoakMixedGame({
        pool,
        registry,
        pilot,
        seed,
        ...(onPlay ? { onPlay } : {}),
      });
      // WHICH GAME — asserted first, because it is what makes the next line mean
      // anything. A replay that drifted onto another match reports no violations
      // and would otherwise read as a fix holding.
      //
      // Split at the seam `describeMatchup` writes, so each seat's list is checked
      // against THAT seat's decklist. A missing seam fails loudly rather than
      // silently collapsing both seats into one string.
      const halves = decks.split('\n    B: ');
      expect(halves, `the replay's decklists no longer name both seats:
${decks}
`).toHaveLength(2);
      const dealt: Record<'A' | 'B', string> = { A: halves[0]!, B: halves[1]! };
      for (const seat of ['A', 'B'] as const) {
        for (const card of mustContain[seat]) {
          expect(dealt[seat], `seed ${seed} no longer deals ${seat} a ${card} — this row is replaying a DIFFERENT game
${decks}
`).toContain(card);
        }
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
