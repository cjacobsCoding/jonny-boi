/**
 * THE MOVES OF THE JOINT SEARCH (DESIGN §3.177) — what one step of the descent
 * may change, and how each one is named.
 *
 * > "Some decks may need different ratios. Maybe we need a way to find a best
 * > mana ratio for a given deck? The hard part is its not as simple as trying 25
 * > or 23… For 25, you'd need to also take out a non-land card…. Which in turn
 * > affects the ratio… And for 23, you have to add in a nonland card… Which
 * > affects the ratio. So maybe we need a new functionality that tries to find
 * > the perfect mana/land ratio for the deck? And at the same time, tries out
 * > removing/adding cards that seem to fit the deck well?"
 *
 * ### Every move is the same shape, and it is the shape §3.175 already ships
 * A joint move is a list of `(out, in, copies)` steps folded through `applySwap`
 * (`ManabaseStep` / `applyManabase`), which is what keeps the comparison paired:
 * the variant library differs from the base in exactly `slotsChanged` slots, and
 * a game that never draws one of them IS the base game. So a colour-mix variant,
 * a dual-land playset, a land-count step and a spell-for-spell swap are one type
 * with one apply path, and the panel's Apply folds the same steps the sim played.
 *
 * ### The two phases are a partition of that shape, not two mechanisms
 * A move is in the MANABASE phase when it touches a land and in the SPELL phase
 * when it does not. Coordinate descent then means: pin the spells and search the
 * land moves, pin the lands and search the spell moves, repeat. Because the deck
 * stays the same size, "one fewer land" is literally "one more spell" — the two
 * coordinates are the two ends of one slot, which is exactly the confound.
 *
 * ### The partner is chosen by measurement (`JOINT_PARTNER_RULES`)
 * §3.175's count sweep trades the most-played basic for *the cheapest nonland
 * with room*. That makes "23 lands" mean "23 lands AND one more copy of my
 * cheapest spell", and the verdict cannot tell the two apart. Here a count step
 * is enumerated once per PARTNER from the suggestion engine's own fit ranking
 * (`generateCandidates` — the one answer to "which cards suit this deck"), every
 * pair is played, and the land count is attributed to its BEST partner. The
 * shipped rule is kept as a row of the same table so the contrast can be
 * measured rather than argued.
 */

import type { CardDefinition } from '@jonny-boi/core';
import { isLand } from '@jonny-boi/core';
import type { CardPool } from '@jonny-boi/cards';
import type { Deck } from './deck.js';
import { DEFAULT_DECK_RULES, type DeckRules } from './config.js';
import { DEFAULT_HEURISTIC_WEIGHTS, DEFAULT_SUGGEST_CONFIG, type HeuristicWeights } from './suggest-config.js';
import { generateCandidates, type SkippedCandidate, type SwapCandidate } from './suggest-candidates.js';
import {
  colorMixVariants,
  landCountVariants,
  landTypeVariants,
  summarizeManabase,
  type ManabaseStep,
  type ManabaseSummary,
  type SkippedVariant,
} from './manabase.js';
import type { DualLandFamilyId } from './manabase-config.js';
import {
  JOINT_COLOR_MIX_RADIUS,
  JOINT_COUNT_MIN_BASICS_KEPT,
  JOINT_LAND_COUNT_RADIUS,
  JOINT_MOVE_FAMILIES,
  JOINT_PARTNERS_PER_COUNT_STEP,
  JOINT_PARTNER_RULES,
  JOINT_SPELL_MOVES_PER_PHASE,
  JOINT_SPELL_SWAP_SCOPE,
  type JointMoveFamilyId,
  type JointPartnerRuleId,
  type JointPhaseId,
} from './joint-config.js';

/** The phase each move family belongs to — read from the one table. */
const PHASE_OF_FAMILY: Readonly<Record<JointMoveFamilyId, JointPhaseId>> = Object.freeze(
  Object.fromEntries(JOINT_MOVE_FAMILIES.map((family) => [family.id, family.phase])) as Record<
    JointMoveFamilyId,
    JointPhaseId
  >,
);

/** The human label of each move family — read from the one table. */
const LABEL_OF_FAMILY: Readonly<Record<JointMoveFamilyId, string>> = Object.freeze(
  Object.fromEntries(JOINT_MOVE_FAMILIES.map((family) => [family.id, family.label])) as Record<
    JointMoveFamilyId,
    string
  >,
);

/**
 * ONE STEP OF THE DESCENT: exactly what changes, expressed as the in-place
 * rewrites `applySwap` performs, so the deck that is played and the deck that
 * Apply produces are built by the same fold.
 */
export interface JointMove {
  /** Stable identity inside a phase: `count:-1:llanowar-elves`, `spell:a>b`. */
  readonly key: string;
  readonly family: JointMoveFamilyId;
  readonly phase: JointPhaseId;
  /**
   * What changed, in full. Never a count without its partner: a row that said
   * "23 lands" alone would hide the second half of the change.
   */
  readonly label: string;
  /** Why this move is in the family, and where it came from. */
  readonly note: string;
  readonly steps: readonly ManabaseStep[];
  /** Lands in the deck once this move is applied. */
  readonly landCount: number;
  /** Library slots that differ from the base — the sum of the steps' copies. */
  readonly slotsChanged: number;
  /**
   * For a count move: the partner spell the count is paired with, so the rollup
   * can attribute a land count to its best partner and print the rest.
   */
  readonly partner?: {
    readonly cardId: string;
    readonly name: string;
    readonly direction: 'added' | 'cut';
    readonly copies: number;
    /** The fit ranking's score — what ORDERED the partners, never a verdict. */
    readonly fitScore: number;
    /** 1-based place in the fit ranking this partner came from. */
    readonly fitRank: number;
  };
  /** For a land-type move, the dual's entry-rule family. */
  readonly dualFamily?: DualLandFamilyId;
}

/** A move the generator could not build, with the honest reason. */
export interface SkippedJointMove {
  readonly family: JointMoveFamilyId;
  readonly label: string;
  readonly reason: string;
}

/** What one phase's generator produced. */
export interface JointMoveSet {
  readonly phase: JointPhaseId;
  /** The base deck's manabase, so the panel can print what it started from. */
  readonly base: ManabaseSummary;
  readonly moves: readonly JointMove[];
  readonly skipped: readonly SkippedJointMove[];
  /** Moves past the phase's cap, ordered but never played. */
  readonly capped: readonly JointMove[];
  /** Which partner rule the count family was built under. */
  readonly partnerRule: JointPartnerRuleId;
}

/** Knobs a phase's generator obeys; every one has a named default. */
export interface JointMoveOptions {
  readonly phase: JointPhaseId;
  readonly partnerRule?: JointPartnerRuleId;
  readonly countRadius?: number;
  readonly mixRadius?: number;
  readonly partnersPerCountStep?: number;
  readonly spellMovesPerPhase?: number;
  /** Dual families the type family may draw on. Omitted means every family. */
  readonly families?: readonly DualLandFamilyId[];
  readonly deckRules?: DeckRules;
  readonly heuristicWeights?: HeuristicWeights;
}

/** Turn a `SkippedVariant` (the §3.175 shape) into this module's shape. */
function fromSkippedVariant(family: JointMoveFamilyId, skipped: readonly SkippedVariant[]): SkippedJointMove[] {
  return skipped.map((row) => ({ family, label: row.label, reason: row.reason }));
}

/** Turn a `SkippedCandidate` (the suggest shape) into this module's shape. */
function fromSkippedCandidate(family: JointMoveFamilyId, skipped: readonly SkippedCandidate[]): SkippedJointMove[] {
  return skipped.map((row) => ({
    family,
    label: `−1 ${row.outName}, +1 ${row.inName}`,
    reason: row.details.length > 0 ? `${row.reason}: ${row.details.join('; ')}` : row.reason,
  }));
}

/** Resolve a decklist against the pool, tallying copies by definition. */
function tallyDeck(deck: Deck, pool: CardPool): Map<string, { readonly def: CardDefinition; count: number }> {
  const tally = new Map<string, { readonly def: CardDefinition; count: number }>();
  for (const entry of deck.cards) {
    const def =
      pool.get(entry.cardId) ??
      (entry.name !== undefined ? pool.getByName(entry.name) : undefined) ??
      pool.getByName(entry.cardId);
    if (!def) continue;
    const row = tally.get(def.id);
    if (row) row.count += entry.count;
    else tally.set(def.id, { def, count: entry.count });
  }
  return tally;
}

/** The names of every LAND line the deck runs — the `out` side of a count cut. */
function landNames(deck: Deck, pool: CardPool): string[] {
  return [...tallyDeck(deck, pool).values()].filter(({ def }) => isLand(def)).map(({ def }) => def.name);
}

/** The names of every BASIC line the deck runs — the `in` side of a count add. */
function basicNames(summary: ManabaseSummary): string[] {
  return summary.basics.map((basic) => basic.name);
}

/**
 * The suggestion engine's fit ranking, restricted to one side of a swap.
 *
 * This is the ONE answer to "which cards seem to fit this deck well": the same
 * generator Suggest scouts with, the same legality check, the same heuristic. A
 * second notion of fit is exactly what rule 12 forbids, so nothing is re-scored
 * here — the candidates come back in the generator's order and are only sliced.
 */
function fitRanked(
  deck: Deck,
  pool: CardPool,
  rules: DeckRules,
  weights: HeuristicWeights,
  options: { readonly cutOnly?: readonly string[]; readonly inOnly?: readonly string[]; readonly copies: number },
  minBasicsKept: number,
): { readonly candidates: readonly SwapCandidate[]; readonly skipped: readonly SkippedCandidate[] } {
  return generateCandidates(
    deck,
    pool,
    { ...DEFAULT_SUGGEST_CONFIG, minBasicLandsKept: minBasicsKept },
    weights,
    rules,
    {
      ...(options.cutOnly ? { cutOnly: options.cutOnly } : {}),
      ...(options.inOnly ? { inOnly: options.inOnly } : {}),
      swapScope: { copies: options.copies },
    },
  );
}

/** A candidate's single step, in the one step shape every move is built from. */
function stepOf(candidate: SwapCandidate, copies: number): ManabaseStep {
  return {
    outId: candidate.outId,
    outName: candidate.outName,
    inId: candidate.inId,
    inName: candidate.inName,
    copies,
  };
}

/**
 * THE PARTNERED LAND-COUNT FAMILY — `base ± k` lands, each count played against
 * several partner spells instead of one arbitrary one.
 *
 * Going DOWN (`−k` lands) the partner is ADDED: the generator is asked for the
 * swaps that cut one of the deck's lands, and its in-side ranking is the fit
 * ranking. Going UP (`+k`) the partner is CUT: the generator is asked for the
 * swaps that add one of the deck's basics, and its out-side choices are the
 * spells the deck can spare. Both directions are `generateCandidates` — the
 * copy limits, the legality and the ordering are its answers, not a second copy.
 */
function partneredCountMoves(
  deck: Deck,
  pool: CardPool,
  summary: ManabaseSummary,
  options: Required<Pick<JointMoveOptions, 'countRadius' | 'partnersPerCountStep'>> & {
    readonly rules: DeckRules;
    readonly weights: HeuristicWeights;
  },
): { readonly moves: JointMove[]; readonly skipped: SkippedJointMove[] } {
  const moves: JointMove[] = [];
  const skipped: SkippedJointMove[] = [];
  const lands = landNames(deck, pool);
  const basics = basicNames(summary);
  const perStep = Math.max(1, Math.floor(options.partnersPerCountStep));

  for (let k = 1; k <= Math.max(0, Math.floor(options.countRadius)); k++) {
    // --- fewer lands: cut a land, add a spell the deck wants ---
    const cutLabel = `${summary.landCount - k} lands`;
    if (lands.length === 0) {
      skipped.push({ family: 'count', label: cutLabel, reason: 'the deck runs no land to cut' });
    } else {
      const ranked = fitRanked(deck, pool, options.rules, options.weights, { cutOnly: lands, copies: k }, JOINT_COUNT_MIN_BASICS_KEPT);
      // The in-side must be a NONLAND, or the move is a land-for-land trade —
      // that is the mix/type family's question, not the count family's.
      const partners = ranked.candidates.filter((candidate) => {
        const def = pool.get(candidate.inId);
        // A land-for-land trade is the mix/type family's question, not this one.
        // And a line too short to give `k` copies would move fewer than the
        // label claims (`copiesForScope` clamps), so it is refused, not rounded.
        return def !== undefined && !isLand(def) && candidate.copiesSwapped === k;
      });
      if (partners.length === 0) {
        skipped.push({
          family: 'count',
          label: cutLabel,
          reason: `no legal spell can take ${k} more cop${k === 1 ? 'y' : 'ies'} in place of a land`,
        });
      }
      for (const candidate of partners.slice(perStep)) {
        skipped.push({
          family: 'count',
          label: `${cutLabel} (−${k} ${candidate.outName}, +${k} ${candidate.inName})`,
          reason: `past the partner shortlist — ${perStep} of ${partners.length} partners are measured at this count`,
        });
      }
      partners.slice(0, perStep).forEach((candidate, index) => {
        moves.push({
          key: `count:-${k}:${candidate.outId}>${candidate.inId}`,
          family: 'count',
          phase: PHASE_OF_FAMILY.count,
          label: `${summary.landCount - k} lands (−${k} ${candidate.outName}, +${k} ${candidate.inName})`,
          note:
            `${LABEL_OF_FAMILY.count} · partner ${index + 1} of ${Math.min(perStep, partners.length)} for this count, ` +
            `from the suggestion engine's fit ranking (fit rank ${index + 1} of ${partners.length})`,
          steps: [stepOf(candidate, k)],
          landCount: summary.landCount - k,
          slotsChanged: k,
          partner: {
            cardId: candidate.inId,
            name: candidate.inName,
            direction: 'added',
            copies: k,
            fitScore: candidate.heuristicScore,
            fitRank: index + 1,
          },
        });
      });
    }

    // --- more lands: cut a spell the deck can spare, add a basic ---
    const addLabel = `${summary.landCount + k} lands`;
    if (basics.length === 0) {
      skipped.push({ family: 'count', label: addLabel, reason: 'the deck runs no basic land to add' });
      continue;
    }
    const rankedUp = fitRanked(deck, pool, options.rules, options.weights, { inOnly: basics, copies: k }, JOINT_COUNT_MIN_BASICS_KEPT);
    const cuts = rankedUp.candidates.filter((candidate) => {
      const def = pool.get(candidate.outId);
      return def !== undefined && !isLand(def) && candidate.copiesSwapped === k;
    });
    if (cuts.length === 0) {
      skipped.push({
        family: 'count',
        label: addLabel,
        reason: `no spell has ${k} cop${k === 1 ? 'y' : 'ies'} the deck can spare for a land`,
      });
      continue;
    }
    for (const candidate of cuts.slice(perStep)) {
      skipped.push({
        family: 'count',
        label: `${addLabel} (+${k} ${candidate.inName}, −${k} ${candidate.outName})`,
        reason: `past the partner shortlist — ${perStep} of ${cuts.length} partners are measured at this count`,
      });
    }
    cuts.slice(0, perStep).forEach((candidate, index) => {
      moves.push({
        key: `count:+${k}:${candidate.outId}>${candidate.inId}`,
        family: 'count',
        phase: PHASE_OF_FAMILY.count,
        label: `${summary.landCount + k} lands (+${k} ${candidate.inName}, −${k} ${candidate.outName})`,
        note:
          `${LABEL_OF_FAMILY.count} · partner ${index + 1} of ${Math.min(perStep, cuts.length)} for this count, ` +
          `from the suggestion engine's fit ranking (fit rank ${index + 1} of ${cuts.length})`,
        steps: [stepOf(candidate, k)],
        landCount: summary.landCount + k,
        slotsChanged: k,
        partner: {
          cardId: candidate.outId,
          name: candidate.outName,
          direction: 'cut',
          copies: k,
          fitScore: candidate.heuristicScore,
          fitRank: index + 1,
        },
      });
    });
  }
  return { moves, skipped };
}

/**
 * THE SHIPPED, ARBITRARY-PARTNER COUNT FAMILY — `landCountVariants` verbatim,
 * wrapped into this module's move shape.
 *
 * Kept so the confound is demonstrable: run the same descent under this rule and
 * under `measured` on the same deck and the same games, and watch them land on
 * different counts. Nothing about the rule is re-implemented here; if §3.175's
 * rule changes, this row changes with it.
 */
function arbitraryPartnerCountMoves(
  deck: Deck,
  pool: CardPool,
  summary: ManabaseSummary,
  countRadius: number,
  rules: DeckRules,
): { readonly moves: JointMove[]; readonly skipped: SkippedJointMove[] } {
  const generated = landCountVariants(deck, pool, countRadius, rules);
  const moves = generated.variants.map((variant): JointMove => {
    const step = variant.steps[0];
    // Going DOWN a basic is cut and the spell is added; going UP the spell is
    // cut and the basic added. The variant's land count against the base says
    // which of the step's two sides is the partner.
    const goingDown = variant.landCount < summary.landCount;
    return {
      key: variant.key,
      family: 'count',
      phase: PHASE_OF_FAMILY.count,
      label: variant.label,
      note: `${LABEL_OF_FAMILY.count} · ${variant.note}`,
      steps: variant.steps,
      landCount: variant.landCount,
      slotsChanged: variant.slotsChanged,
      ...(step
        ? {
            partner: {
              cardId: goingDown ? step.inId : step.outId,
              name: goingDown ? step.inName : step.outName,
              direction: goingDown ? ('added' as const) : ('cut' as const),
              copies: step.copies,
              // No fit ranking took part in this rule; a zero here is the
              // honest reading, and the note says which rule chose the partner.
              fitScore: 0,
              fitRank: 1,
            },
          }
        : {}),
    };
  });
  return { moves, skipped: fromSkippedVariant('count', generated.skipped) };
}

/** The colour-mix and land-type families — §3.175's generators, re-shaped. */
function landOnlyMoves(
  deck: Deck,
  pool: CardPool,
  mixRadius: number,
  families: readonly DualLandFamilyId[] | undefined,
): { readonly moves: JointMove[]; readonly skipped: SkippedJointMove[] } {
  const mix = colorMixVariants(deck, pool, mixRadius);
  const type = families ? landTypeVariants(deck, pool, families) : landTypeVariants(deck, pool);
  const moves: JointMove[] = [];
  for (const variant of mix.variants) {
    moves.push({
      key: variant.key,
      family: 'mix',
      phase: PHASE_OF_FAMILY.mix,
      label: variant.label,
      note: `${LABEL_OF_FAMILY.mix} · ${variant.note}`,
      steps: variant.steps,
      landCount: variant.landCount,
      slotsChanged: variant.slotsChanged,
    });
  }
  for (const variant of type.variants) {
    moves.push({
      key: variant.key,
      family: 'type',
      phase: PHASE_OF_FAMILY.type,
      label: variant.label,
      note: `${LABEL_OF_FAMILY.type} · ${variant.note}`,
      steps: variant.steps,
      landCount: variant.landCount,
      slotsChanged: variant.slotsChanged,
      ...(variant.family ? { dualFamily: variant.family } : {}),
    });
  }
  return {
    moves,
    skipped: [...fromSkippedVariant('mix', mix.skipped), ...fromSkippedVariant('type', type.skipped)],
  };
}

/**
 * THE SPELL FAMILY — the manabase pinned, one nonland slot at a time.
 *
 * Literally Suggest's candidate generator with both sides restricted to
 * nonlands: "removing/adding cards that seem to fit the deck well", answered by
 * the code that already answers it. Restricting the sides is a FILTER over the
 * generated family rather than a second generator, so a card the suggestion
 * engine would never offer is never offered here either.
 */
function spellMoves(
  deck: Deck,
  pool: CardPool,
  summary: ManabaseSummary,
  rules: DeckRules,
  weights: HeuristicWeights,
): { readonly moves: JointMove[]; readonly skipped: SkippedJointMove[] } {
  const generated = generateCandidates(deck, pool, DEFAULT_SUGGEST_CONFIG, weights, rules, {
    swapScope: JOINT_SPELL_SWAP_SCOPE,
  });
  const moves: JointMove[] = [];
  for (const candidate of generated.candidates) {
    const outDef = pool.get(candidate.outId);
    const inDef = pool.get(candidate.inId);
    if (!outDef || !inDef || isLand(outDef) || isLand(inDef)) continue;
    moves.push({
      key: `spell:${candidate.outId}>${candidate.inId}`,
      family: 'spell',
      phase: PHASE_OF_FAMILY.spell,
      label: `−${candidate.copiesSwapped} ${candidate.outName}, +${candidate.copiesSwapped} ${candidate.inName}`,
      note: `${LABEL_OF_FAMILY.spell} · the manabase is unchanged (${summary.landCount} lands)`,
      steps: [stepOf(candidate, candidate.copiesSwapped)],
      landCount: summary.landCount,
      slotsChanged: candidate.copiesSwapped,
    });
  }
  return { moves, skipped: fromSkippedCandidate('spell', generated.skipped) };
}

/**
 * Enumerate one PHASE's moves for `deck`, in the order they will be scouted.
 *
 * Pure and total: same deck, same pool, same options → same list. A family out
 * of reach for this deck comes back in `skipped` with its reason; moves past the
 * cap come back in `capped`, ordered, so the panel can say what was not tried.
 */
export function generateJointMoves(deck: Deck, pool: CardPool, options: JointMoveOptions): JointMoveSet {
  const rules = options.deckRules ?? DEFAULT_DECK_RULES;
  const weights = options.heuristicWeights ?? DEFAULT_HEURISTIC_WEIGHTS;
  const partnerRule = options.partnerRule ?? JOINT_PARTNER_RULES[0].id;
  const summary = summarizeManabase(deck, pool);

  if (options.phase === 'spells') {
    const built = spellMoves(deck, pool, summary, rules, weights);
    const cap = Math.max(1, Math.floor(options.spellMovesPerPhase ?? JOINT_SPELL_MOVES_PER_PHASE));
    return {
      phase: options.phase,
      base: summary,
      moves: built.moves.slice(0, cap),
      capped: built.moves.slice(cap),
      skipped: built.skipped,
      partnerRule,
    };
  }

  const countRadius = options.countRadius ?? JOINT_LAND_COUNT_RADIUS;
  const count =
    partnerRule === 'cheapest-nonland'
      ? arbitraryPartnerCountMoves(deck, pool, summary, countRadius, rules)
      : partneredCountMoves(deck, pool, summary, {
          countRadius,
          partnersPerCountStep: options.partnersPerCountStep ?? JOINT_PARTNERS_PER_COUNT_STEP,
          rules,
          weights,
        });
  const landOnly = landOnlyMoves(deck, pool, options.mixRadius ?? JOINT_COLOR_MIX_RADIUS, options.families);
  // ORDER, because the roster cap cuts from the end: every count's BEST partner
  // first (so no count is ever left with fewer partners than another), then the
  // mix and type families, then the deeper partners. A cap that removed whole
  // counts, or left one count on a single partner, would quietly reinstate the
  // confound this family exists to remove.
  const firstPartners = count.moves.filter((move) => (move.partner?.fitRank ?? 1) <= 1);
  const deeperPartners = count.moves
    .filter((move) => (move.partner?.fitRank ?? 1) > 1)
    .sort((a, b) => (a.partner?.fitRank ?? 0) - (b.partner?.fitRank ?? 0));
  return {
    phase: options.phase,
    base: summary,
    moves: [...firstPartners, ...landOnly.moves, ...deeperPartners],
    capped: [],
    skipped: [...count.skipped, ...landOnly.skipped],
    partnerRule,
  };
}
