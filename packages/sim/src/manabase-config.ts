/**
 * Named configuration for the MANABASE experiments (DESIGN §3.175). Every value
 * that shapes which variants are enumerated, or how a game's reliability is
 * judged, lives here as a named token — the generator and the observer read
 * these, never a literal.
 */

import type { ManaColor } from '@jonny-boi/core';

/**
 * How far the land-COUNT sweep reaches: `base − k … base + k` lands, one variant
 * per step. Two each way covers "a land light" and "a land heavy" without
 * drowning the family in variants nobody would build.
 */
export const LAND_COUNT_SWEEP_RADIUS = 2;

/**
 * How far the colour-MIX sweep shifts basics between two colours: `±1 … ±k`
 * basics of one type traded for the other, one variant per step and direction.
 */
export const COLOR_MIX_SWEEP_RADIUS = 2;

/**
 * How many copies a land-TYPE variant brings in — a playset, replacing that many
 * basics split evenly across the dual's two colours. A cycle is judged as a
 * playset because that is how a person builds with one.
 */
export const LAND_TYPE_VARIANT_COPIES = 4;

/**
 * The hero's OWN turns during which a missed land drop (a completed turn with no
 * land played) counts against the manabase: the 2nd through the 4th. Turn 1 has
 * no cost worth counting (the opening seven either has a land or it does not,
 * and a mulligan is the answer to that — see `RELIABILITY_NOT_MEASURED`), and
 * after turn 4 a missed drop is flood-or-screw noise the win rate already carries.
 */
export const LAND_DROP_TURNS = Object.freeze({ from: 2, to: 4 });

/**
 * The hero's own turn from which COLOUR SCREW is judged: a spell in hand the
 * hero could pay for in total mana but not in the right colours. Before turn 3
 * a one-colour hand behind a one-colour board is the norm, not a screw.
 */
export const COLOUR_SCREW_FROM_TURN = 3;

/** The hero's own turn at whose START "lands on the battlefield" is read. */
export const LANDS_ON_BATTLEFIELD_TURN = 4;

/**
 * The reliability metrics, as a CLOSED table. Every consumer — the observer, the
 * aggregator, the report, the panel's columns — reads this one list, so a metric
 * added here is measured, summarised and shown in the same edit.
 *
 *  - `rate` metrics are the share of games in which the bad thing happened at
 *    least once (Wilson interval, paired McNemar against the base);
 *  - `mean` metrics are averaged over the games that reached the reading, with a
 *    normal-approximation interval and a paired difference against the base.
 *
 * `direction` says which way is GOOD, so the verdict can be stated as
 * "more reliable" / "less reliable" without a second table.
 */
export const RELIABILITY_METRICS = Object.freeze([
  Object.freeze({
    id: 'missedLandDrop',
    label: 'Missed a land drop (turns 2–4)',
    kind: 'rate',
    direction: 'lowerIsBetter',
  }),
  Object.freeze({
    id: 'colourScrew',
    label: 'Colour-screwed (turn 3+)',
    kind: 'rate',
    direction: 'lowerIsBetter',
  }),
  Object.freeze({
    id: 'landsOnTurn4',
    label: 'Lands at the start of turn 4',
    kind: 'mean',
    direction: 'higherIsBetter',
  }),
] as const);

export type ReliabilityMetricId = (typeof RELIABILITY_METRICS)[number]['id'];
export type ReliabilityMetricKind = (typeof RELIABILITY_METRICS)[number]['kind'];
export type ReliabilityDirection = (typeof RELIABILITY_METRICS)[number]['direction'];

/**
 * Metrics the brief asked for that the CURRENT seam cannot observe, with the
 * reason. Reported as NOT MEASURED — in the report and on the panel — rather
 * than estimated, because a guessed reliability number is worse than none.
 *
 * Mulligans: the harness never mulligans. CR 103.5 is a recorded gap in
 * `packages/core/src/conformance/rules-manifest.ts` ('103'); every game is
 * played from the first seven, so a mulligan rate would be identically zero for
 * every manabase and say nothing.
 */
export const RELIABILITY_NOT_MEASURED = Object.freeze([
  Object.freeze({
    id: 'mulligan',
    label: 'Mulligans taken',
    reason:
      'the simulator never mulligans (CR 103.5 is a recorded engine gap), so every deck would read 0% ' +
      'and the number would say nothing about the manabase',
  }),
] as const);

/**
 * The basic land for each colour, and the colour of each basic — ONE table, read
 * both ways, so "the deck's most-played basic" and "which basic serves G" cannot
 * disagree. Colourless has no basic and is deliberately absent.
 */
export const BASIC_LAND_FOR_COLOR: Readonly<Record<Exclude<ManaColor, 'C'>, string>> = Object.freeze({
  W: 'Plains',
  U: 'Island',
  B: 'Swamp',
  R: 'Mountain',
  G: 'Forest',
});

/**
 * How a dual land's ENTRY RULE is named for people — the cycle families a
 * manabase is built from. The classifier in `manabase.ts` maps a compiled
 * definition onto exactly one of these (or refuses the land), and the label on
 * every land-type variant quotes the family, so "4 Temple Garden for 2 Forest +
 * 2 Plains" also says what kind of land that is.
 *
 * Ordered from the fastest to the slowest entry, which is also the order the
 * type sweep presents them in.
 */
export const DUAL_LAND_FAMILIES = Object.freeze([
  Object.freeze({ id: 'untapped', label: 'enters untapped' }),
  Object.freeze({ id: 'shock', label: 'shockland — pay 2 life or enters tapped' }),
  Object.freeze({ id: 'check', label: 'checkland — untapped with the right basic type' }),
  Object.freeze({ id: 'fast', label: 'fastland — untapped with two or fewer other lands' }),
  Object.freeze({ id: 'slow', label: 'slowland — untapped with two or more other lands' }),
  Object.freeze({ id: 'battle', label: 'battleland — untapped with two basic lands' }),
  Object.freeze({ id: 'reveal', label: 'reveal land — untapped if you reveal a basic type' }),
  Object.freeze({ id: 'conditional', label: 'untapped under another printed condition' }),
  Object.freeze({ id: 'tapped', label: 'enters tapped' }),
] as const);

export type DualLandFamilyId = (typeof DUAL_LAND_FAMILIES)[number]['id'];
