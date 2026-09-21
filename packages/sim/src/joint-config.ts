/**
 * Named configuration for the JOINT manabase + spell search (DESIGN §3.177).
 *
 * Every value that shapes which moves are enumerated, how a phase is budgeted,
 * and how the search decides it is finished lives here as a named token. The
 * generator, the reducer, the driver and the panel read these; none of them
 * carries a literal.
 */

import type { SwapScope } from './config.js';

/**
 * THE PHASES, as a closed table in descent order.
 *
 * A joint round holds one half of the deck fixed and searches the other, then
 * swaps which half is held. Adding a third coordinate (a sideboard, a companion)
 * is a ROW here, never a branch in the loop.
 */
export const JOINT_PHASES = Object.freeze([
  Object.freeze({
    id: 'manabase',
    label: 'Manabase',
    /** What this phase varies while the other half of the deck is pinned. */
    question: 'holding the spells fixed — how many lands, which colours, which types?',
  }),
  Object.freeze({
    id: 'spells',
    label: 'Spells',
    question: 'holding the manabase fixed — which nonland fills each remaining slot?',
  }),
] as const);

export type JointPhaseId = (typeof JOINT_PHASES)[number]['id'];

/**
 * THE MOVE FAMILIES, a closed table mapping each family to the phase that owns
 * it and to the label a row prints. A family absent from this table cannot be
 * generated, scheduled or reported — which is the point: the search's reach is
 * readable in one place.
 */
export const JOINT_MOVE_FAMILIES = Object.freeze([
  Object.freeze({ id: 'count', phase: 'manabase', label: 'land count' }),
  Object.freeze({ id: 'mix', phase: 'manabase', label: 'colour mix' }),
  Object.freeze({ id: 'type', phase: 'manabase', label: 'land type' }),
  Object.freeze({ id: 'spell', phase: 'spells', label: 'spell slot' }),
] as const);

export type JointMoveFamilyId = (typeof JOINT_MOVE_FAMILIES)[number]['id'];

/**
 * HOW THE PARTNER OF A LAND-COUNT STEP IS CHOSEN — a closed table of two rules,
 * because the difference between them IS the defect this section exists to fix.
 *
 * A land-count step cannot change the land count alone: a deck of a fixed size
 * that plays one fewer land plays one more spell, and *which* spell is a second
 * change measured as though it were part of the first.
 *
 *  - `measured` — the step is enumerated once per PARTNER drawn from the
 *    suggestion engine's own candidate generator ("cards that seem to fit the
 *    deck well"), every pair is played, and the land count is attributed to its
 *    BEST partner: when you build a 23-land deck you get to choose the 61st
 *    card, so the question "is 23 lands better?" is answered by the best 23-land
 *    deck, not by an arbitrary one. The maximum over partners is a selection, so
 *    the Holm correction over the whole phase family is what keeps it honest —
 *    it is the same correction every other family here gets, not a new one.
 *  - `cheapest-nonland` — §3.175's shipped rule, kept as a ROW so the confound
 *    can be demonstrated rather than described: one copy of the most-played
 *    basic traded for one copy of the cheapest nonland with room. It is exactly
 *    `landCountVariants`, called, never re-implemented. A deck whose cheapest
 *    nonland is its worst card reads "more lands is better" under this rule for
 *    a reason that has nothing to do with lands.
 */
export const JOINT_PARTNER_RULES = Object.freeze([
  Object.freeze({
    id: 'measured',
    label: 'partner chosen by measurement',
    note:
      'each land count is played against several partner spells from the suggestion engine’s fit ' +
      'ranking, and the count is judged by its best partner — the deck you would actually build.',
  }),
  Object.freeze({
    id: 'cheapest-nonland',
    label: 'partner fixed by the §3.175 rule (the cheapest nonland with room)',
    note:
      'the shipped manabase sweep’s rule, kept so the confound can be shown: the land count and an ' +
      'arbitrary spell move together and the verdict cannot tell them apart.',
  }),
] as const);

export type JointPartnerRuleId = (typeof JOINT_PARTNER_RULES)[number]['id'];

/** The rule a joint search uses unless the caller says otherwise. */
export const DEFAULT_JOINT_PARTNER_RULE: JointPartnerRuleId = 'measured';

/**
 * How many partner spells each land-count step is measured against. Four is the
 * playset a person would consider and keeps `radius × 2 × partners` inside the
 * ladder's candidate cap alongside the mix and type families.
 */
export const JOINT_PARTNERS_PER_COUNT_STEP = 4;

/**
 * How far one PHASE's land-count sweep reaches, each way. Deliberately the same
 * order as §3.175's — the joint search's reach is not bounded by it, because a
 * round that accepts −2 searches again from the new deck and can reach −4, −6 …
 * The radius bounds one phase's family size, not the answer.
 */
export const JOINT_LAND_COUNT_RADIUS = 2;

/** How far one phase's colour-mix sweep shifts basics between two colours. */
export const JOINT_COLOR_MIX_RADIUS = 2;

/**
 * The basic-land floor the count sweep runs under. Suggest keeps eight of each
 * basic (`minBasicLandsKept`) so an unrelated swap cannot gut a manabase; here
 * moving the manabase IS the question, and the paired verdict — not a floor —
 * is what refuses a bad one. Zero, stated, rather than a silent override.
 */
export const JOINT_COUNT_MIN_BASICS_KEPT = 0;

/**
 * How many spell-slot moves one phase evaluates, after the fit ranking has
 * ordered them. The rest are reported `capped`, never dropped silently.
 */
export const JOINT_SPELL_MOVES_PER_PHASE = 12;

/**
 * Copies a spell-slot move swaps. ONE, because a coordinate descent takes small
 * steps: every accepted move is individually attributable, and four rounds
 * convert a playset if the playset is really the improvement.
 */
export const JOINT_SPELL_SWAP_SCOPE: SwapScope = 'one';

/**
 * Rounds (a manabase phase plus a spell phase) a search may run before it stops
 * and reports what it has. A bound on the PATH, so a run that keeps finding
 * marginal moves still ends somewhere a person can read.
 */
export const JOINT_MAX_ROUNDS = 6;

/**
 * The default budget. Both halves are hard: the search stops at whichever binds
 * first and says which one did. Games are the unit the progress bar counts, so
 * "spent so far" and "budget" are the same unit on the panel.
 */
export const DEFAULT_JOINT_BUDGET = Object.freeze({
  maxGames: 12000,
  maxSeconds: 900,
});

/**
 * The smallest phase worth starting. Below this many games left in the budget a
 * phase would run its ladder on so few games that every verdict came back
 * inconclusive — which reads as "nothing is better" and is not the same claim.
 */
export const JOINT_MIN_PHASE_GAMES = 200;

/** Why a joint search stopped — a closed table, each row with what it means. */
export const JOINT_STOP_REASONS = Object.freeze([
  Object.freeze({
    id: 'local-optimum',
    label: 'a full round improved nothing',
    meaning:
      'neither phase found a move that beat the deck it started from. Alternating descent stops at a ' +
      'LOCAL optimum: a better deck may sit behind two moves that are only good together, and this ' +
      'search cannot see it. This is not a claim that the deck is globally best.',
  }),
  Object.freeze({
    id: 'budget-spent',
    label: 'the budget ran out',
    meaning: 'the games or the seconds you allowed were spent. The path is what was found on the way.',
  }),
  Object.freeze({
    id: 'max-rounds',
    label: 'the round cap was reached',
    meaning: `the search ran ${JOINT_MAX_ROUNDS} rounds and still found moves; the deck may improve further.`,
  }),
  Object.freeze({
    id: 'no-moves',
    label: 'no move could be built',
    meaning: 'every family was out of reach for this deck. The skip list says why, per family.',
  }),
  Object.freeze({
    id: 'interrupted',
    label: 'you stopped it',
    meaning: 'the search was interrupted. Everything accepted before the interruption is in the path.',
  }),
] as const);

export type JointStopReasonId = (typeof JOINT_STOP_REASONS)[number]['id'];

/**
 * THE CLAIM, in the words every surface prints. There is no "perfect ratio" in
 * this module's vocabulary and there must not be one in its output: a search
 * that spends a finite budget along one path reports the best deck it FOUND,
 * and names the budget and the path so a person can audit both.
 */
export const JOINT_HONEST_CLAIM =
  'This is the best deck this search FOUND, under this budget, along this path — not the perfect ' +
  'ratio and not a proven optimum. Every accepted move is listed with its measured delta and its ' +
  'verdict; a round that ended inconclusive is labelled inconclusive, not "no improvement".';

/**
 * THE CONFOUND, stated once, printed beside the land-count rollup. This is the
 * defect the section exists to fix, in the words that explain why the rollup has
 * a partner column at all.
 */
export const JOINT_CONFOUND_NOTE =
  'A land count cannot be changed by itself: a 60-card deck with one fewer land has one more spell. ' +
  'Pairing every count step with one arbitrary spell measures TWO changes as one — a good count can ' +
  'read worse because the spell it was paired with was bad, and a bad count can read better because ' +
  'the spell it cut was worse. So each count is played against several partner spells, and the count ' +
  'is judged by its best one.';

/**
 * What this search does NOT judge, reported rather than quietly omitted. The
 * reliability metrics (§3.175) are READ on every manabase-phase move so the path
 * can be audited, but the accept rule is the paired win rate alone: a rule that
 * also gated on reliability would have to say how a maximum over partners
 * interacts with three more verdicts, and no such rule has been stated.
 */
export const JOINT_NOT_GATED_ON = Object.freeze([
  Object.freeze({
    id: 'reliability',
    label: 'Reliability (missed land drops, colour screw, lands by turn four)',
    reason:
      'measured and shown for every manabase-phase move, but the accept rule is the paired win rate ' +
      'alone. The Manabase tab (§3.175) is where a manabase is judged on both axes under a stated rule.',
  }),
  Object.freeze({
    id: 'deck-size',
    label: 'Deck SIZE',
    reason:
      'every joint move keeps the deck the same size, which is what makes the land count and the ' +
      'spell count trade against each other at all. Trimming a deck toward a smaller target is the ' +
      'Trim tab (§3.174) — a different question with a different answer.',
  }),
] as const);
