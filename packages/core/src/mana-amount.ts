/**
 * A MANA ABILITY WHOSE AMOUNT THE BOARD DECIDES — DESIGN §3.164.
 *
 * "{T}: Add {G} for each creature you control" (Gaea's Cradle), "Add X mana in
 * any combination of colors, where X is the number of creatures you control
 * with defender" (Axebane Guardian), "Add an amount of {G} equal to your
 * devotion to green" (Karametra's Acolyte), "Add X mana of any one color, where
 * X is this creature's power" (Woodland Weavemaster). 83 cards on the
 * 32,341-card corpus print a derived-amount mana ability; before this every one
 * of them reported.
 *
 * ## The model
 *
 * A mana ability's MODES stay what they were — fixed productions indexed by
 * `TapForManaAction.mode`, one per colour a printed "any one color" offers —
 * and {@link ManaAbility.amount} is a MULTIPLIER on the chosen mode, read off
 * the board as the ability is activated (CR 605.3: a mana ability resolves at
 * once, so the number is the number at that moment). `{ G: 1 } × 4` is four
 * green; a board that makes the count zero makes a tap that adds nothing,
 * which is what the printed card does too.
 *
 * ## Why the amount is a CLOSED subset of the derived counts
 *
 * The mana planner works from a `ManaPlanView` — the battlefield and the pools,
 * nothing else — because an online client plans against a redacted view. An
 * amount that read a hand or a graveyard would be computable by the engine and
 * not by the planner, and the two would disagree about how much a tap is worth,
 * which is the one thing a planner must never be wrong about. So an amount may
 * count only what the battlefield shows: the battlefield rows of the named
 * vocabulary, a filtered permanent count, devotion, or the source's own power.
 * `manaAmountOf` takes exactly that view and nothing more.
 *
 * ## "In any combination of colors"
 *
 * The modes are the five colours, each worth the whole amount, so a pilot that
 * wants X green taps for X green. The printed card may also SPLIT the amount —
 * the action carries {@link TapForManaAction.split} for that, validated to sum
 * to the amount over the ability's own colours. The shipped planner does not
 * search splits yet (it plans one mode per tap, as it always has); the engine
 * accepts them, so a human or a later planner is not narrowed by the model.
 */

import type { CardDefinition, DerivedCountName } from './card.js';
import type { CardFilter } from './choices.js';
import { countPermanentsMatching, evaluateDerivedCount, type DerivedCountScope } from './derived.js';
import type { ManaColor, ManaProduction } from './mana.js';
import { MANA_COLORS } from './mana.js';
import type { CardInstance, GameState, PlayerId } from './state.js';
import type { AggregatedMod } from './internal/continuous.js';
import { NO_MOD } from './internal/continuous.js';
import { effectivePower } from './internal/stats.js';

/** The filtered-count discriminator, spelled once for this module's union. */
export const MANA_AMOUNT_PERMANENTS_MATCHING = 'permanentsMatching';

/**
 * The battlefield rows of {@link DerivedCountName} an amount may name — the
 * closed subset the planner's view can answer (see the module header). Adding
 * a row here is a compile-time claim that `evaluateDerivedCount` reads only
 * `state.battlefield` for it.
 */
export const MANA_AMOUNT_COUNTS = Object.freeze([
  'creaturesYouControl',
  'creaturesOpponentControls',
  'creaturesOnBattlefield',
  'landsYouControl',
  'creaturesYouControlWithDefender',
  'devotionToWhite',
  'devotionToBlue',
  'devotionToBlack',
  'devotionToRed',
  'devotionToGreen',
] as const satisfies readonly DerivedCountName[]);

export type ManaAmountCount = (typeof MANA_AMOUNT_COUNTS)[number];

/** How much one activation adds, as the board decides it. */
export type ManaAmountSource =
  /** "for each creature you control", "equal to your devotion to green" — a named battlefield count. */
  | { readonly countOf: ManaAmountCount }
  /** "for each Elf you control", "for each basic Swamp you control" — a filtered permanent count. */
  | { readonly countOf: typeof MANA_AMOUNT_PERMANENTS_MATCHING; readonly filter: CardFilter; readonly scope: DerivedCountScope }
  /** "equal to this creature's power" — the source's own EFFECTIVE power. */
  | { readonly countOf: 'sourcePower' };

/** The part of a game state a mana amount may read — what the planner's view carries. */
export interface ManaAmountView {
  readonly battlefield: readonly CardInstance[];
}

/**
 * The number this source's ability adds per unit of its mode, right now.
 * Never negative: a board that would make it so makes it zero (CR 107.1b).
 */
export function manaAmountOf(
  view: ManaAmountView,
  source: CardInstance,
  amount: ManaAmountSource,
  /** The source's layered modification, for `sourcePower`; `NO_MOD` when the caller has none. */
  mod: AggregatedMod = NO_MOD,
): number {
  const you: PlayerId = source.controller;
  let value: number;
  if (amount.countOf === 'sourcePower') value = effectivePower(source, mod);
  else if (amount.countOf === MANA_AMOUNT_PERMANENTS_MATCHING) {
    value = countPermanentsMatching(view as GameState, amount.filter, amount.scope, you);
  } else {
    // Only the battlefield rows reach here (see MANA_AMOUNT_COUNTS), so the
    // partial view is the whole of what the evaluator reads for them.
    value = evaluateDerivedCount(view as GameState, amount.countOf, you);
  }
  return value > 0 ? value : 0;
}

/** `production × amount`, allocation-free for the common amount of one. */
export function scaleProduction(production: ManaProduction, amount: number): ManaProduction {
  if (amount === 1) return production;
  if (amount <= 0) return EMPTY_PRODUCTION;
  const scaled: Partial<Record<ManaColor, number>> = {};
  for (let i = 0; i < MANA_COLORS.length; i++) {
    const color = MANA_COLORS[i] as ManaColor;
    const n = production[color];
    if (n !== undefined && n > 0) scaled[color] = n * amount;
  }
  return scaled;
}

/** A tap that adds nothing — the honest result of a zero amount. */
export const EMPTY_PRODUCTION: ManaProduction = Object.freeze({});

/**
 * Whether `split` is a legal way to take `amount` mana "in any combination" of
 * the colours this ability's modes offer: every colour in the split is one of
 * the modes, every count is a whole positive number, and the total is exactly
 * the amount. Anything else is refused — a split short of the amount would be
 * a player declining mana the card makes (legal in paper, but a client that
 * wants less asks for less), and one over it would be mana the card does not
 * make.
 */
export function splitMatchesAmount(
  split: ManaProduction,
  amount: number,
  modes: readonly ManaProduction[],
): boolean {
  let total = 0;
  for (let i = 0; i < MANA_COLORS.length; i++) {
    const color = MANA_COLORS[i] as ManaColor;
    const n = split[color];
    if (n === undefined) continue;
    if (!Number.isInteger(n) || n < 0) return false;
    if (n === 0) continue;
    if (!modes.some((mode) => (mode[color] ?? 0) > 0)) return false;
    total += n;
  }
  return total === amount;
}

/** Whether this definition prints any derived-amount mana ability — one property read per ability. */
export function hasDerivedManaAmount(def: CardDefinition): boolean {
  const abilities = def.manaAbilities;
  if (abilities === undefined) return false;
  for (let i = 0; i < abilities.length; i++) if (abilities[i]!.amount !== undefined) return true;
  return false;
}
