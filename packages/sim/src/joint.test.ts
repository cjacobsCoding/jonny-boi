/**
 * THE JOINT MANABASE + SPELL SEARCH (DESIGN §3.177).
 *
 * Three things are under test, and the second and third are the lane:
 *
 *  1. THE GENERATOR — a phase's family is exactly the list the rules say, every
 *     label names BOTH halves of what changed, and what is out of reach is
 *     reported with a reason. Pure; no games.
 *  2. THE PLANTED ANSWER — a deck whose best manabase is known by construction
 *     is FOUND. A search that cannot be shown to find a planted answer is not a
 *     search, so the truth is planted in a rigged runner (the `trim.test.ts`
 *     idiom): a deck's win rate is a stated function of its land count and its
 *     copies of two planted cards, and the assertion is that the descent walks
 *     to the maximum of that function.
 *  3. THE CONFOUND — the SAME descent, the SAME rigged games and the SAME accept
 *     rule, run under the two rows of `JOINT_PARTNER_RULES`, land on DIFFERENT
 *     land counts: the shipped arbitrary-partner rule walks the wrong way
 *     (because the spell it happens to cut is the deck's worst card, which has
 *     nothing to do with lands), and the measured-partner rule walks to the
 *     planted optimum. That contrast is the whole point of the section.
 *
 * The rig is deterministic and slot-keyed, so none of this is hostage to what a
 * few dozen real games happen to say. One end-to-end block then plays REAL games
 * on the shipped pool, so the search is known to work outside the rig too.
 */

import { describe, expect, it } from 'vitest';
import type { CardDefinition } from '@jonny-boi/core';
import type { CardPool } from '@jonny-boi/cards';
import { buildRegistry, loadCardPool } from '@jonny-boi/cards';
import { createDefaultAiRegistry, HEURISTIC_PILOT_ID, type Pilot } from '@jonny-boi/ai';
import { SELESNYA_BLINK, MONO_RED_AGGRO } from '../data/decks/index.js';
import type { Deck } from './deck.js';
import { loadDeck, validateDeck } from './deck.js';
import type { SwapVerdict } from './swap.js';
import type { MatchupPilots } from './matchup.js';
import type { ArmHandle, PairedArmsUsage, SwapArm, VariantArmSpec } from './paired-arms.js';
import {
  advanceJointSearch,
  applyJointMove,
  deckSizeOf,
  describeJointOutcome,
  generateJointMoves,
  jointBudgetRemaining,
  jointCandidateOf,
  jointStopReasonOf,
  moveForCandidateKey,
  planJointPhase,
  rollUpLandCounts,
  runJointPhase,
  runJointSearch,
  startJointSearch,
  type JointArmRunner,
  type JointBudget,
  type JointMove,
  type JointMoveRow,
  type JointSearchOptions,
  type JointSearchState,
} from './joint.js';
import {
  DEFAULT_JOINT_BUDGET,
  JOINT_CONFOUND_NOTE,
  JOINT_HONEST_CLAIM,
  JOINT_MOVE_FAMILIES,
  JOINT_NOT_GATED_ON,
  JOINT_PARTNER_RULES,
  JOINT_PHASES,
  JOINT_STOP_REASONS,
} from './joint-config.js';
import { landCountVariants, summarizeManabase } from './manabase.js';

// --- a hand-built pool: the RULES are under test, not the shipped data -------------

const land = (name: string, extra: Partial<CardDefinition> = {}): CardDefinition => ({
  id: name.toLowerCase().replace(/\s+/g, '-'),
  name,
  types: ['land'],
  ...extra,
});
const spell = (name: string, cost: CardDefinition['cost']): CardDefinition => ({
  id: name.toLowerCase().replace(/\s+/g, '-'),
  name,
  types: ['creature'],
  cost,
  power: 2,
  toughness: 2,
});

const FOREST = land('Forest', { subtypes: ['forest'], basic: true, produces: ['G'] });
const PLAINS = land('Plains', { subtypes: ['plains'], basic: true, produces: ['W'] });
const TEST_DUAL = land('Test Dual', { subtypes: ['forest', 'plains'], entersTapped: true, producesOptions: [{ G: 1 }, { W: 1 }] });

/**
 * DUD is the deck's CHEAPEST nonland, which is the only thing §3.175's count
 * sweep looks at — and it is also, by construction, the deck's worst card. That
 * gap between "cheapest" and "best to move" IS the confound, made concrete.
 */
const DUD = spell('Dud', { G: 1 });
/** ACE is the best card the deck could add, and it is NOT the cheapest. */
const ACE = spell('Ace', { generic: 1, G: 1 });
/** Neutral bodies: they fill slots and the planted truth is indifferent to them. */
const FILLER_NAMES = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K'] as const;
const FILLERS: readonly CardDefinition[] = FILLER_NAMES.map((letter, i) =>
  spell(`Filler ${letter}`, i % 2 === 0 ? { generic: 1 + (i % 3), G: 1 } : { generic: 1 + (i % 3), W: 1 }),
);

const TEST_CARDS: readonly CardDefinition[] = [FOREST, PLAINS, TEST_DUAL, DUD, ACE, ...FILLERS];

function testPool(cards: readonly CardDefinition[] = TEST_CARDS): CardPool {
  const byId = new Map(cards.map((c) => [c.id, c] as const));
  const byName = new Map(cards.map((c) => [c.name, c] as const));
  return {
    cards,
    get: (id) => byId.get(id),
    getByName: (name) => byName.get(name),
    unsupportedRefs: [],
    attachmentProblems: [],
  };
}
const POOL = testPool();

/** A decklist line, so the fixtures read as counts and stay 60 cards by arithmetic. */
const line = (cardId: string, count: number) => ({ cardId, count });

/** 60 cards, 30 of them lands — flooded well past the planted optimum of 24. */
const FLOODED: Deck = {
  name: 'Flooded GW',
  archetype: 'test',
  cards: [
    line('Forest', 16),
    line('Plains', 14),
    line('Dud', 2),
    ...FILLER_NAMES.slice(0, 7).map((letter) => line(`Filler ${letter}`, 4)),
  ],
};

/** 60 cards, 17 of them lands — screwed, and its best move is UP. */
const SCREWED: Deck = {
  name: 'Screwed GW',
  archetype: 'test',
  cards: [
    line('Forest', 9),
    line('Plains', 8),
    line('Dud', 4),
    line('Ace', 4),
    ...FILLER_NAMES.slice(0, 8).map((letter) => line(`Filler ${letter}`, 4)),
    line('Filler I', 3),
  ],
};

/** 60 cards, 24 lands, the planted card maxed — nothing this search can improve. */
const SETTLED: Deck = {
  name: 'Settled GW',
  archetype: 'test',
  cards: [
    line('Forest', 12),
    line('Plains', 12),
    line('Ace', 4),
    ...FILLER_NAMES.slice(0, 8).map((letter) => line(`Filler ${letter}`, 4)),
  ],
};

const landsIn = (deck: Deck): number => summarizeManabase(deck, POOL).landCount;
const copiesOf = (deck: Deck, name: string): number =>
  deck.cards.filter((e) => (POOL.get(e.cardId) ?? POOL.getByName(e.cardId))?.name === name).reduce((s, e) => s + e.count, 0);

// --- the planted truth ---------------------------------------------------------------

/** The land count the planted truth peaks at. Nothing in the search knows it. */
const PLANTED_BEST_LANDS = 24;
/** Win rate lost per land away from `PLANTED_BEST_LANDS`. */
const LAND_PENALTY = 0.02;
/** Win rate a copy of ACE adds, and a copy of DUD costs. */
const CARD_WEIGHT = 0.05;

/**
 * THE PLANTED WIN RATE of a decklist. The whole rig is this one function: the
 * search never sees it, and the assertions are that the descent walks to its
 * maximum while the arbitrary-partner rule does not.
 */
function plantedWinRate(deck: Deck): number {
  return (
    0.5 -
    LAND_PENALTY * Math.abs(landsIn(deck) - PLANTED_BEST_LANDS) +
    CARD_WEIGHT * copiesOf(deck, 'Ace') -
    CARD_WEIGHT * copiesOf(deck, 'Dud')
  );
}

/**
 * Slots per unit of planted advantage that swing to the better deck. Chosen so
 * the SMALLEST planted delta (one land, 0.02) still produces a one-sided
 * discordant table big enough to survive the Holm correction over the whole
 * family, while the LARGEST stays under the clamp — so the rig's measured delta
 * is monotone in the planted one across the entire range the search walks.
 */
const SWING_SCALE = 6;
const GOLDEN = 0.6180339887498949;

/**
 * A RIGGED runner over the planted truth.
 *
 * Base and variant agree on every slot except a low-discrepancy band of SWING
 * slots whose width is the planted advantage; on those the better deck wins.
 * So the discordant table is one-sided and its size is monotone in the planted
 * delta — exactly the structure a paired arm has when one deck is really better,
 * with none of the noise. `openVariantArm` is the real funnel's own entry point,
 * so an unbuildable move still throws here.
 */
function riggedRunner(base: Deck): JointArmRunner {
  const baseRate = plantedWinRate(base);
  const arms = new Map<ArmHandle, { readonly spec: VariantArmSpec; readonly advantage: number; state: SwapArm }>();
  let played = 0;
  return {
    openVariantArm(spec: VariantArmSpec): ArmHandle {
      if (deckSizeOf(spec.variantDeck) !== deckSizeOf(base)) {
        throw new Error(`variant "${spec.label}" is not the base deck's length`);
      }
      const handle = {} as ArmHandle;
      arms.set(handle, {
        spec,
        advantage: plantedWinRate(spec.variantDeck) - baseRate,
        state: {
          swap: { out: 'base', in: spec.key },
          outName: 'base',
          inName: spec.label,
          variantDeck: spec.variantDeck,
          gamesPlayed: 0,
          variantGamesSkipped: 0,
          paired: { bothWon: 0, baseOnly: 0, variantOnly: 0, neither: 0 },
          variantWonBySlot: [],
        },
      });
      return handle;
    },
    advance(handle: ArmHandle, target: number): SwapArm {
      const arm = arms.get(handle);
      if (!arm) throw new Error('unknown handle');
      const paired = { ...arm.state.paired };
      const slots = [...arm.state.variantWonBySlot];
      const swingRate = Math.min(0.95, Math.abs(arm.advantage) * SWING_SCALE);
      for (let slot = arm.state.gamesPlayed; slot < target; slot++) {
        const baseWon = slot % 2 === 0;
        const swing = ((slot + 1) * GOLDEN) % 1 < swingRate;
        const variantWon = swing ? arm.advantage > 0 : baseWon;
        slots[slot] = variantWon;
        if (baseWon && variantWon) paired.bothWon++;
        else if (baseWon) paired.baseOnly++;
        else if (variantWon) paired.variantOnly++;
        else paired.neither++;
        played += 2;
      }
      arm.state = { ...arm.state, gamesPlayed: target, paired, variantWonBySlot: slots };
      return arm.state;
    },
    usage: (): PairedArmsUsage => ({
      baseGamesPlayed: played / 2,
      variantGamesPlayed: played / 2,
      variantGamesSkipped: 0,
      totalGamesPlayed: played,
      identicalGameSkipEnabled: false,
    }),
  };
}

/**
 * A `JointMoveRow` with only the fields the ROLLUP reads, so the rollup can be
 * tested on rows in an order a finished phase would never hand it.
 */
function fakeRow(spec: {
  readonly landCount: number;
  readonly partner: string;
  readonly delta: number;
  readonly verdict: SwapVerdict;
}): JointMoveRow {
  const move: JointMove = {
    key: `count:${spec.landCount}:${spec.partner}`,
    family: 'count',
    phase: 'manabase',
    label: `${spec.landCount} lands (−1 Forest, +1 ${spec.partner})`,
    note: 'fixture',
    steps: [{ outId: 'forest', outName: 'Forest', inId: spec.partner, inName: spec.partner, copies: 1 }],
    landCount: spec.landCount,
    slotsChanged: 1,
    partner: { cardId: spec.partner, name: spec.partner, direction: 'added', copies: 1, fitScore: 0, fitRank: 1 },
  };
  return {
    rank: 1,
    key: move.key,
    move,
    evaluation: { delta: spec.delta, verdict: spec.verdict } as JointMoveRow['evaluation'],
    gamesPlayed: 100,
    rawPValue: 0.01,
    adjustedPValue: 0.02,
  };
}

/** Two stand-in opponents: the rig never plays them, but the ladder counts them. */
const realPool = loadCardPool({ onWarn: () => {} });
const registry = buildRegistry();
function pilot(id: string): Pilot {
  const p = createDefaultAiRegistry().getPilot(id);
  if (!p) throw new Error(`no pilot ${id}`);
  return p;
}
const pilots: MatchupPilots = { pilotA: pilot(HEURISTIC_PILOT_ID), pilotB: pilot(HEURISTIC_PILOT_ID) };
const RIGGED_OPPONENTS = [loadDeck(MONO_RED_AGGRO, realPool), loadDeck(MONO_RED_AGGRO, realPool)];

/**
 * What one rigged phase is measured with. Depth enough that a one-land planted
 * delta is decisive after Holm over the whole family; the rig plays no real
 * games, so depth is free here and the numbers are exact.
 */
const RIGGED_PHASE: Pick<JointSearchOptions, 'gamesPerMove' | 'partnersPerCountStep' | 'maxMoves'> = {
  gamesPerMove: 150,
  // Every partner in this tiny pool is measured, so the assertions are about the
  // MEASUREMENT choosing the partner and not about the fit ranking's order.
  partnersPerCountStep: 12,
  maxMoves: 120,
};

/** A budget that never binds, so the budget tests are the only ones about it. */
const UNLIMITED: JointBudget = { maxGames: Number.MAX_SAFE_INTEGER, maxSeconds: Number.MAX_SAFE_INTEGER };

/** The search, over the planted truth, under one of the two partner rules. */
function plantedSearch(deck: Deck, overrides: Partial<JointSearchOptions> = {}): JointSearchState {
  return runJointSearch(deck, {
    pool: POOL,
    gauntletDecks: RIGGED_OPPONENTS,
    pilots,
    registry,
    baseSeed: 0xc0ffee,
    budget: UNLIMITED,
    ...RIGGED_PHASE,
    armRunner: (phaseDeck) => riggedRunner(phaseDeck),
    now: () => 0,
    ...overrides,
  });
}

/** One rigged phase of the same search, for the reports the rollup is read from. */
function plantedPhase(deck: Deck, overrides: Partial<Parameters<typeof runJointPhase>[1]> = {}) {
  return runJointPhase(deck, {
    pool: POOL,
    phase: 'manabase',
    round: 0,
    gauntletDecks: RIGGED_OPPONENTS,
    pilots,
    registry,
    baseSeed: 0xc0ffee,
    ...RIGGED_PHASE,
    armRunner: (phaseDeck) => riggedRunner(phaseDeck),
    now: () => 0,
    ...overrides,
  });
}

// --- 1. the generator ------------------------------------------------------------------

describe('joint move generator', () => {
  it('pairs every land-count step with several measured partners, and names both halves', () => {
    const set = generateJointMoves(FLOODED, POOL, { phase: 'manabase', partnerRule: 'measured', partnersPerCountStep: 3 });
    const counts = set.moves.filter((m) => m.family === 'count');
    expect(counts.length).toBeGreaterThan(0);
    for (const move of counts) {
      // The label carries the count AND the partner — never a bare "29 lands".
      expect(move.label).toMatch(/^\d+ lands \([−+]\d+ .+, [−+]\d+ .+\)$/u);
      expect(move.partner).toBeDefined();
      expect(move.partner?.fitRank).toBeGreaterThanOrEqual(1);
    }
    // Several partners per count is the whole fix: group and check.
    const byCount = new Map<number, number>();
    for (const move of counts) byCount.set(move.landCount, (byCount.get(move.landCount) ?? 0) + 1);
    for (const [, partners] of byCount) expect(partners).toBeGreaterThan(1);
  });

  it('reports the partners past the shortlist rather than dropping them — in BOTH directions', () => {
    const set = generateJointMoves(FLOODED, POOL, { phase: 'manabase', partnerRule: 'measured', partnersPerCountStep: 1 });
    const past = set.skipped.filter((s) => s.reason.startsWith('past the partner shortlist'));
    expect(past.length).toBeGreaterThan(0);
    expect(past.every((s) => s.family === 'count')).toBe(true);
    // A skip label opens with the land count it belongs to, so the two
    // directions are distinguishable — and both must report, or the half that
    // does not would drop its extra partners in silence.
    const counts = past.map((s) => Number.parseInt(s.label, 10));
    expect(counts.some((n) => n < landsIn(FLOODED))).toBe(true);
    expect(counts.some((n) => n > landsIn(FLOODED))).toBe(true);
    // And each one names the shortlist it fell outside, with the denominator.
    expect(past.every((s) => /1 of \d+ partners are measured at this count$/u.test(s.reason))).toBe(true);
  });

  it("the arbitrary-partner rule IS §3.175's sweep — one partner per count, and the same labels", () => {
    const set = generateJointMoves(FLOODED, POOL, { phase: 'manabase', partnerRule: 'cheapest-nonland' });
    const counts = set.moves.filter((m) => m.family === 'count');
    const shipped = landCountVariants(FLOODED, POOL);
    expect(counts.map((m) => m.label)).toEqual(shipped.variants.map((v) => v.label));
    const byCount = new Map<number, number>();
    for (const move of counts) byCount.set(move.landCount, (byCount.get(move.landCount) ?? 0) + 1);
    for (const [, partners] of byCount) expect(partners).toBe(1);
    // And the partner it names is the deck's cheapest nonland — the confound.
    expect(counts.find((m) => m.landCount === 29)?.partner?.name).toBe('Dud');
  });

  it('a spell move never touches a land, and never changes the land count', () => {
    const before = landsIn(FLOODED);
    const set = generateJointMoves(FLOODED, POOL, { phase: 'spells' });
    expect(set.moves.length).toBeGreaterThan(0);
    for (const move of set.moves) {
      expect(move.family).toBe('spell');
      expect(move.landCount).toBe(before);
      expect(landsIn(applyJointMove(FLOODED, move, POOL))).toBe(before);
    }
  });

  it('every move keeps the deck the same size, and rewrites exactly the slots it claims', () => {
    for (const phase of JOINT_PHASES) {
      const set = generateJointMoves(FLOODED, POOL, { phase: phase.id, partnersPerCountStep: 12 });
      for (const move of set.moves) {
        const after = applyJointMove(FLOODED, move, POOL);
        expect(deckSizeOf(after)).toBe(deckSizeOf(FLOODED));
        expect(validateDeck(after, POOL)).toEqual([]);
        expect(move.steps.reduce((sum, step) => sum + step.copies, 0)).toBe(move.slotsChanged);
        expect(after.name).toBe(FLOODED.name);
      }
    }
  });

  it('a family out of reach is REPORTED with a reason, never approximated', () => {
    const mono: Deck = {
      name: 'Mono G',
      archetype: 'test',
      cards: [
        { cardId: 'Forest', count: 24 },
        { cardId: 'Filler A', count: 4 },
        { cardId: 'Filler C', count: 4 },
        { cardId: 'Filler E', count: 4 },
        { cardId: 'Ace', count: 4 },
        { cardId: 'Dud', count: 4 },
        { cardId: 'Test Dual', count: 16 },
      ],
    };
    const set = generateJointMoves(mono, POOL, { phase: 'manabase' });
    const reasons = set.skipped.map((s) => `${s.family}: ${s.reason}`);
    expect(reasons.some((r) => r.startsWith('mix:'))).toBe(true);
    expect(reasons.some((r) => r.startsWith('type:'))).toBe(true);
    expect(set.skipped.every((s) => s.reason.length > 0)).toBe(true);
  });

  it('the ladder adapter round-trips every move by key', () => {
    const plan = planJointPhase(FLOODED, {
      pool: POOL,
      phase: 'manabase',
      round: 0,
      opponentCount: 2,
      baseSeed: 1,
      partnersPerCountStep: 12,
    });
    for (const move of plan.joint.moves) {
      const candidate = jointCandidateOf(move, plan.joint.base, FLOODED.name);
      expect(moveForCandidateKey(candidate.key, plan.joint.moves)).toBe(move);
      // `inName` IS the label, so a host with no card pool can still name the row.
      expect(candidate.inName).toBe(move.label);
      expect(candidate.copiesSwapped).toBe(move.slotsChanged);
    }
    // Every family in the table has a phase, and every move's phase agrees.
    for (const move of plan.joint.moves) {
      expect(JOINT_MOVE_FAMILIES.find((f) => f.id === move.family)?.phase).toBe(move.phase);
    }
  });
});

// --- 2. the planted answer --------------------------------------------------------------

describe('the planted answer is found', () => {
  it('a deck flooded at 30 lands is walked to the planted optimum of 24, with the planted card', () => {
    const state = plantedSearch(FLOODED);
    expect(landsIn(state.deck)).toBe(PLANTED_BEST_LANDS);
    // Not just the count: the partner the measurement chose is the planted card.
    expect(copiesOf(state.deck, 'Ace')).toBeGreaterThan(0);
    // The PATH is auditable: every accepted move improved the planted win rate.
    expect(state.path.length).toBeGreaterThan(0);
    let deck = state.startDeck;
    for (const step of state.path) {
      const before = plantedWinRate(deck);
      deck = applyJointMove(deck, step.move, POOL);
      expect(plantedWinRate(deck)).toBeGreaterThan(before);
    }
    expect(plantedWinRate(state.deck)).toBeGreaterThan(plantedWinRate(FLOODED));
  });

  it('a deck screwed at 17 lands is walked UP toward the planted optimum', () => {
    const state = plantedSearch(SCREWED);
    expect(landsIn(SCREWED)).toBe(17);
    expect(landsIn(state.deck)).toBeGreaterThan(17);
    expect(Math.abs(landsIn(state.deck) - PLANTED_BEST_LANDS)).toBeLessThan(Math.abs(17 - PLANTED_BEST_LANDS));
    expect(deckSizeOf(state.deck)).toBe(deckSizeOf(SCREWED));
  });

  it('the land-count rollup attributes each count to its BEST partner, and says how many it had', () => {
    const report = plantedPhase(FLOODED);
    const rows = report.landCounts;
    expect(rows.length).toBeGreaterThan(1);
    expect(rows.find((r) => r.isBase)?.landCount).toBe(30);
    const twentyEight = rows.find((r) => r.landCount === 28);
    expect(twentyEight).toBeDefined();
    expect(twentyEight?.partnersTested).toBeGreaterThan(1);
    expect(twentyEight?.note).toContain('best of');
    // The best partner at 28 is the planted card, chosen by the games.
    expect(twentyEight?.best?.move.partner?.name).toBe('Ace');
    // And the fewer-lands direction is what proved better here.
    expect(twentyEight?.verdict).toBe('better');
    expect(report.confoundNote).toBe(JOINT_CONFOUND_NOTE);
  });

  it('the rollup picks the best partner from rows in ANY order — proved verdict first, then delta', () => {
    // Handed IN ASCENDING order, and with the largest point estimate on a row
    // the correction could NOT separate from noise. A rollup that returned the
    // first row it was given, or that ranked on the raw delta, gets this wrong —
    // which is the point of testing the rollup on its own: inside a finished
    // phase the rows already arrive ranked, so neither mistake would ever show.
    const shuffled = [
      fakeRow({ landCount: 23, partner: 'Weakest', delta: 0.01, verdict: 'better' }),
      fakeRow({ landCount: 23, partner: 'Loudest', delta: 0.40, verdict: 'inconclusive' }),
      fakeRow({ landCount: 23, partner: 'Best', delta: 0.09, verdict: 'better' }),
      fakeRow({ landCount: 25, partner: 'Only', delta: -0.05, verdict: 'worse' }),
    ];
    const rolled = rollUpLandCounts(shuffled, summarizeManabase(FLOODED, POOL), { p: 0.5, low: 0.4, high: 0.6, n: 100 });
    const at23 = rolled.find((r) => r.landCount === 23);
    expect(at23?.best?.move.partner?.name).toBe('Best');
    expect(at23?.partners.map((p) => p.move.partner?.name)).toEqual(['Best', 'Weakest', 'Loudest']);
    expect(at23?.verdict).toBe('better');
    expect(at23?.partnersTested).toBe(3);
    expect(rolled.find((r) => r.landCount === 25)?.verdict).toBe('worse');
    // The base row is always present, sits at its own count, and has no move.
    const base = rolled.find((r) => r.isBase);
    expect(base?.landCount).toBe(landsIn(FLOODED));
    expect(base?.best).toBeUndefined();
    expect(base?.verdict).toBe('base');
    expect(rolled.map((r) => r.landCount)).toEqual([...rolled.map((r) => r.landCount)].sort((a, b) => a - b));
  });

  it('a count judged on ONE partner says so, instead of reading as the best build at it', () => {
    const report = plantedPhase(FLOODED, { partnerRule: 'cheapest-nonland' });
    const row = report.landCounts.find((r) => !r.isBase);
    expect(row?.partnersTested).toBe(1);
    expect(row?.note).toContain('ONE partner');
    expect(row?.note).toContain('cannot separate them');
  });
});

// --- 3. the confound ---------------------------------------------------------------------

describe('the confound the joint search fixes', () => {
  it('ONE manabase phase, same deck and same games: the two rules pick OPPOSITE land counts', () => {
    // This is the contrast, at the coordinate the confound lives on: the spells
    // are held fixed, so the only thing that differs between the two runs is the
    // row of `JOINT_PARTNER_RULES` that chose each count's partner.
    const arbitrary = plantedPhase(FLOODED, { partnerRule: 'cheapest-nonland' });
    const measured = plantedPhase(FLOODED, { partnerRule: 'measured' });
    expect(landsIn(FLOODED)).toBe(30);

    // The shipped rule pairs every count with the deck's CHEAPEST nonland, which
    // here is also its worst card — so cutting it makes MORE lands look good and
    // adding it makes FEWER lands look bad. It walks AWAY from 24.
    expect(arbitrary.winner?.move.family).toBe('count');
    expect(arbitrary.winner?.move.partner?.name).toBe('Dud');
    expect(arbitrary.winner?.move.landCount).toBeGreaterThan(30);
    expect(Math.abs((arbitrary.winner?.move.landCount as number) - PLANTED_BEST_LANDS)).toBeGreaterThan(
      Math.abs(30 - PLANTED_BEST_LANDS),
    );

    // The measured rule plays each count against several partners and judges it
    // by its best one, so it walks TOWARD 24.
    expect(measured.winner?.move.family).toBe('count');
    expect(measured.winner?.move.landCount).toBeLessThan(30);
    expect(Math.abs((measured.winner?.move.landCount as number) - PLANTED_BEST_LANDS)).toBeLessThan(
      Math.abs(30 - PLANTED_BEST_LANDS),
    );

    // Both are "better" against the same base on the same games — the arbitrary
    // rule is not noisy here, it is CONFOUNDED: it measured a real improvement
    // and attributed it to the land count instead of to the spell.
    expect(arbitrary.winner?.evaluation.verdict).toBe('better');
    expect(measured.winner?.evaluation.verdict).toBe('better');
  });

  it('over the whole descent the arbitrary rule never reaches the planted optimum and the measured rule does', () => {
    const arbitrary = plantedSearch(FLOODED, { partnerRule: 'cheapest-nonland' });
    const measured = plantedSearch(FLOODED, { partnerRule: 'measured' });
    expect(landsIn(measured.deck)).toBe(PLANTED_BEST_LANDS);
    expect(landsIn(arbitrary.deck)).not.toBe(PLANTED_BEST_LANDS);
    expect(plantedWinRate(measured.deck)).toBeGreaterThan(plantedWinRate(arbitrary.deck));

    // Its FIRST accepted move is the wrong way, named after the cheapest spell.
    const firstCount = arbitrary.path.find((s) => s.move.family === 'count');
    expect(firstCount?.move.partner?.name).toBe('Dud');
    expect(firstCount?.landCount).toBeGreaterThan(landsIn(FLOODED));

    // It recovers only partly, and only because the SPELL phase happened to put
    // a better partner inside the cheapest-nonland rule's reach — which is
    // itself the point: the two coordinates are not independent.
    expect(Math.abs(landsIn(arbitrary.deck) - PLANTED_BEST_LANDS)).toBeGreaterThan(0);
  });

  it('both rules are rows of ONE table, and the shipped rule is one of them', () => {
    expect(JOINT_PARTNER_RULES.map((r) => r.id)).toEqual(['measured', 'cheapest-nonland']);
    expect(JOINT_PARTNER_RULES.find((r) => r.id === 'cheapest-nonland')?.label).toContain('§3.175');
  });
});

// --- 4. the budget, the stop reasons, and the claim ---------------------------------------

describe('the budget is the user’s, and the claim is honest', () => {
  it('a budget too small to decide anything refuses to run a phase rather than running a useless one', () => {
    const state = plantedSearch(FLOODED, { budget: { maxGames: 10, maxSeconds: 60 } });
    expect(state.stopped).toBe('budget-spent');
    expect(state.spend.games).toBe(0);
    expect(state.path).toEqual([]);
    expect(jointBudgetRemaining(state).canRunPhase).toBe(false);
  });

  it('a spent budget stops the descent and the spend is reported against it', () => {
    const budget = { maxGames: 900, maxSeconds: 3600 };
    const state = plantedSearch(FLOODED, { budget });
    expect(state.stopped).toBe('budget-spent');
    expect(state.spend.games).toBeGreaterThan(0);
    expect(state.spend.games).toBeLessThanOrEqual(budget.maxGames + state.phases[state.phases.length - 1]!.gamesPlayed);
    expect(state.spend.phasesRun).toBe(state.phases.length);
    // The deck it reports is the deck the accepted path produced, not the base.
    expect(landsIn(state.deck)).toBeLessThan(landsIn(FLOODED));
  });

  it('the caller can interrupt between phases, and everything accepted so far survives', () => {
    let seen = 0;
    const state = plantedSearch(FLOODED, {
      shouldStop: () => seen++ >= 2,
    });
    expect(state.stopped).toBe('interrupted');
    expect(state.spend.phasesRun).toBe(2);
    expect(describeJointOutcome(state)).toContain('Stopped: you stopped it');
  });

  it('a deck the search cannot improve stops at a LOCAL optimum and says it is not a global one', () => {
    expect(landsIn(SETTLED)).toBe(PLANTED_BEST_LANDS);
    const state = plantedSearch(SETTLED);
    expect(state.stopped).toBe('local-optimum');
    expect(state.path).toEqual([]);
    const said = describeJointOutcome(state);
    expect(said).toContain('LOCAL optimum');
    expect(said).toContain('not a claim that the deck is globally best');
    expect(said).toContain('No move beat the deck you started with.');
  });

  it('never CLAIMS a perfect ratio — the only mention of the word is the disclaimer', () => {
    // The one sanctioned use: the shared claim says what this is NOT.
    expect(JOINT_HONEST_CLAIM).toContain('not the perfect ratio');
    const others = [
      JOINT_CONFOUND_NOTE,
      ...JOINT_STOP_REASONS.map((r) => `${r.label} ${r.meaning}`),
      ...JOINT_NOT_GATED_ON.map((r) => `${r.label} ${r.reason}`),
      ...JOINT_PARTNER_RULES.map((r) => `${r.label} ${r.note}`),
      ...JOINT_PHASES.map((ph) => `${ph.label} ${ph.question}`),
    ];
    for (const text of others) expect(text.toLowerCase()).not.toContain('perfect');
    // And the sentence a finished search prints carries the claim, and says
    // "found", never "optimal".
    const said = describeJointOutcome(plantedSearch(FLOODED));
    expect(said).toContain(JOINT_HONEST_CLAIM);
    expect(said.replace(JOINT_HONEST_CLAIM, '').toLowerCase()).not.toContain('perfect');
    expect(JOINT_HONEST_CLAIM).toContain('best deck this search FOUND');
  });

  it('every stop reason in the table has a meaning a surface can print', () => {
    for (const reason of JOINT_STOP_REASONS) {
      expect(jointStopReasonOf(reason.id)).toBe(reason);
      expect(reason.meaning.length).toBeGreaterThan(20);
    }
    expect(() => jointStopReasonOf('nonsense' as never)).toThrow(/no joint stop reason/u);
  });

  it('the reducer is pure: the same state and report fold to the same state', () => {
    const start = startJointSearch(FLOODED, DEFAULT_JOINT_BUDGET);
    const report = plantedPhase(FLOODED);
    const a = advanceJointSearch(start, report, POOL);
    const b = advanceJointSearch(start, report, POOL);
    expect(a.deck).toEqual(b.deck);
    expect(a.path).toEqual(b.path);
    expect(start.deck).toBe(FLOODED); // the input is never mutated
    expect(a.phaseIndex).toBe(1);
    expect(a.round).toBe(0);
  });
});

// --- 5. real games, on the shipped pool ----------------------------------------------------

describe('the search runs on real games', () => {
  it('plays a real phase on the shipped pool and reports a verdict for every move', () => {
    const started = Date.now();
    const report = runJointPhase(SELESNYA_BLINK, {
      pool: realPool,
      phase: 'manabase',
      round: 0,
      gauntletDecks: [loadDeck(MONO_RED_AGGRO, realPool)],
      pilots,
      registry,
      baseSeed: 0xc0ffee,
      gamesPerMove: 6,
      countRadius: 1,
      mixRadius: 1,
      partnersPerCountStep: 2,
      maxMoves: 6,
    });
    expect(report.rows.length).toBeGreaterThan(0);
    for (const row of report.rows) {
      expect(['better', 'worse', 'inconclusive']).toContain(row.evaluation.verdict);
      expect(row.gamesPlayed).toBeGreaterThan(0);
    }
    // The reliability half is READ on a real (watched) run — never a gate.
    expect(report.rows.some((row) => row.reliability !== undefined)).toBe(true);
    expect(report.notes.totalGamesRun).toBeGreaterThan(0);
    expect(report.gamesPlayed).toBe(report.notes.totalGamesRun);
    const perSecond = report.notes.totalGamesRun / Math.max(0.001, (Date.now() - started) / 1000);
    expect(perSecond).toBeGreaterThan(0);
  }, 240_000);
});
