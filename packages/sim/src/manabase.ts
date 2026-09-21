/**
 * THE MANABASE EXPERIMENTS (DESIGN §3.175) — "try other manabases".
 *
 * A manabase variant is a deck that differs from the hero ONLY in its lands (and,
 * for a land-COUNT step, in the one nonland that keeps the deck the same size).
 * This module is the pure half: it ENUMERATES a closed, explainable set of
 * variants from the decklist and the card pool, BUILDS each one through the same
 * in-place rewrite the A/B swap uses, and ADAPTS the family to the suggestion
 * engine's adaptive ladder so the games are scheduled, eliminated and corrected
 * by exactly the code `suggest` runs on. Nothing here plays a game.
 *
 * ### Why every variant is a list of swaps
 * `applySwap` (§3.5) rewrites a decklist IN PLACE, so the expanded library
 * differs from the base in exactly the rewritten slots — the common-random-
 * numbers property the paired verdict lives on. A manabase variant is therefore
 * expressed as a list of `(out, in, copies)` steps and built by folding
 * `applySwap` over them (`applyManabase`): two Forests and two Plains becoming
 * four Temple Gardens changes four slots and nothing else, and a game that never
 * draws one of those four slots is provably the base game (`paired-arms.ts`).
 * The web Lab's Apply folds the SAME steps over the saved deck, so what was
 * tested and what gets applied cannot drift.
 *
 * ### The three sweeps, and why they are closed
 *  - **Land count** — `base ± k` lands. Each step trades one copy of the deck's
 *    most-played basic for one copy of its cheapest nonland (or back), so the
 *    deck stays the same size and the comparison is fair. The rule is stated in
 *    every label ("23 lands (−1 Forest, +1 Llanowar Elves)").
 *  - **Colour mix** — basics of one type traded for another, `±1 … ±k`, for
 *    every ordered pair of basic types the deck runs.
 *  - **Land type** — a playset of a dual from the pool that fits two of the
 *    deck's colours, replacing two basics of each colour. One variant per
 *    FUNCTIONAL signature (entry rule + whether it carries basic land types), so
 *    the family is not padded with four lands the engine cannot tell apart.
 * A deck outside a sweep's reach (no basics to shift, one colour, fewer than two
 * of a basic) is reported in `skipped` with the reason — never approximated.
 */

import type { CardDefinition, ManaColor } from '@jonny-boi/core';
import { convertedManaCost, isLand, manaModesOf } from '@jonny-boi/core';
import type { CardPool } from '@jonny-boi/cards';
import type { Deck, DeckEntry } from './deck.js';
import { validateDeck } from './deck.js';
import { applySwap, copiesSwappedBy } from './swap.js';
import { DEFAULT_DECK_RULES, type DeckRules } from './config.js';
import type { SwapCandidate } from './suggest-candidates.js';
import { candidateKey } from './suggest-history.js';
import {
  BASIC_LAND_FOR_COLOR,
  COLOR_MIX_SWEEP_RADIUS,
  DUAL_LAND_FAMILIES,
  LAND_COUNT_SWEEP_RADIUS,
  LAND_TYPE_VARIANT_COPIES,
  type DualLandFamilyId,
} from './manabase-config.js';

/** Which sweep produced a variant. */
export type ManabaseVariantKind = 'count' | 'mix' | 'type';

/** One in-place replacement a variant is made of: `copies` of `out` become `in`. */
export interface ManabaseStep {
  readonly outId: string;
  readonly outName: string;
  readonly inId: string;
  readonly inName: string;
  readonly copies: number;
}

/** One manabase to test: what it is called, and exactly how it differs from the base. */
export interface ManabaseVariant {
  /** Stable identity across runs (`count:-1`, `mix:Forest>Plains:1`, `type:<cardId>`). */
  readonly key: string;
  readonly kind: ManabaseVariantKind;
  /** The human label every surface prints, e.g. "4 Temple Garden for 2 Forest + 2 Plains". */
  readonly label: string;
  /** A second line for the panel: the dual's family, or the rule behind a count step. */
  readonly note: string;
  /** The replacements, in order. `applyManabase` folds these; the web Apply folds the same. */
  readonly steps: readonly ManabaseStep[];
  /** Lands in the variant deck. */
  readonly landCount: number;
  /** Library slots that differ from the base — the sum of the steps' copies. */
  readonly slotsChanged: number;
  /** For a land-type variant, the dual's entry-rule family. */
  readonly family?: DualLandFamilyId;
}

/** A variant the sweep could NOT build for this deck, with the honest reason. */
export interface SkippedVariant {
  readonly kind: ManabaseVariantKind;
  readonly label: string;
  readonly reason: string;
}

/** What the base deck's manabase looks like — printed above the table. */
export interface ManabaseSummary {
  readonly deckSize: number;
  readonly landCount: number;
  /** Every land line, deck order, merged by card. */
  readonly lands: readonly { readonly name: string; readonly count: number }[];
  /** The basics the deck runs, with the colour each serves. */
  readonly basics: readonly { readonly name: string; readonly color: ManaColor; readonly count: number }[];
  /** Coloured pips the SPELLS demand, per colour (the manabase's job). */
  readonly pips: Readonly<Partial<Record<ManaColor, number>>>;
  /** The deck's colours — every colour with at least one pip — in WUBRG order. */
  readonly colors: readonly ManaColor[];
  /** One line for people: "24 lands — 8 Forest, 8 Plains, … · spells need G ×34, W ×21". */
  readonly description: string;
}

/** Which sweeps to run, and how far. Every field has a named default. */
export interface ManabaseSweepOptions {
  readonly sweeps?: { readonly count: boolean; readonly mix: boolean; readonly type: boolean };
  /** Land-count steps each way. Defaults to `LAND_COUNT_SWEEP_RADIUS`. */
  readonly countRadius?: number;
  /** Colour-mix steps each way. Defaults to `COLOR_MIX_SWEEP_RADIUS`. */
  readonly mixRadius?: number;
  /** Dual families the type sweep may use. Defaults to every family. */
  readonly families?: readonly DualLandFamilyId[];
  readonly deckRules?: DeckRules;
}

/** The enumerated family for one deck. */
export interface ManabaseSweep {
  readonly base: ManabaseSummary;
  readonly variants: readonly ManabaseVariant[];
  readonly skipped: readonly SkippedVariant[];
}

/** The sweeps a run performs when the caller does not say. */
export const DEFAULT_MANABASE_SWEEPS = Object.freeze({ count: true, mix: true, type: true });

/**
 * The `out` side of a manabase candidate's key. A variant is not a swap of one
 * card for another, so the adaptive ladder's `outId>inId` key names the base
 * deck on the left and the variant on the right (`manabase>count:-1`).
 */
export const MANABASE_BASE_REF = 'manabase';

const WUBRG: readonly ManaColor[] = ['W', 'U', 'B', 'R', 'G'];

/** Colour of a basic land NAME, from the one table; `undefined` for anything else. */
function colorOfBasic(name: string): ManaColor | undefined {
  for (const color of WUBRG) {
    if (BASIC_LAND_FOR_COLOR[color as keyof typeof BASIC_LAND_FOR_COLOR] === name) return color;
  }
  return undefined;
}

/** A resolved decklist line. */
interface ResolvedLine {
  readonly entry: DeckEntry;
  readonly def: CardDefinition;
}

function resolveLines(deck: Deck, pool: CardPool): ResolvedLine[] {
  const lines: ResolvedLine[] = [];
  const missing: string[] = [];
  for (const entry of deck.cards) {
    const def =
      pool.get(entry.cardId) ??
      (entry.name !== undefined ? pool.getByName(entry.name) : undefined) ??
      pool.getByName(entry.cardId);
    if (!def) missing.push(entry.name ?? entry.cardId);
    else lines.push({ entry, def });
  }
  if (missing.length > 0) {
    throw new Error(`deck "${deck.name}" has cards the pool cannot resolve: ${missing.join(', ')}`);
  }
  return lines;
}

/** Copies of each card, by definition id, summed over every line that names it. */
function tallyByCard(lines: readonly ResolvedLine[]): Map<string, { readonly def: CardDefinition; count: number }> {
  const tally = new Map<string, { readonly def: CardDefinition; count: number }>();
  for (const { entry, def } of lines) {
    const row = tally.get(def.id);
    if (row) row.count += entry.count;
    else tally.set(def.id, { def, count: entry.count });
  }
  return tally;
}

/**
 * Read the base deck's manabase: lands, basics by colour, and the coloured pips
 * its spells demand. Throws (never guesses) when a card does not resolve.
 */
export function summarizeManabase(deck: Deck, pool: CardPool): ManabaseSummary {
  const tally = tallyByCard(resolveLines(deck, pool));
  const lands: { name: string; count: number }[] = [];
  const basics: { name: string; color: ManaColor; count: number }[] = [];
  const pips: Partial<Record<ManaColor, number>> = {};
  let deckSize = 0;
  let landCount = 0;
  for (const { def, count } of tally.values()) {
    deckSize += count;
    if (isLand(def)) {
      landCount += count;
      lands.push({ name: def.name, count });
      const color = colorOfBasic(def.name);
      if (color !== undefined) basics.push({ name: def.name, color, count });
      continue;
    }
    const cost = def.cost;
    if (!cost) continue;
    for (const color of WUBRG) {
      const n = cost[color];
      if (typeof n === 'number' && n > 0) pips[color] = (pips[color] ?? 0) + n * count;
    }
  }
  const colors = WUBRG.filter((color) => (pips[color] ?? 0) > 0);
  const landText = lands.map((l) => `${l.count} ${l.name}`).join(', ');
  const pipText = colors.map((color) => `${color} ×${pips[color]}`).join(', ');
  const description =
    `${landCount} lands — ${landText || 'none'}` + (colors.length > 0 ? ` · spells need ${pipText}` : ' · no coloured pips');
  return { deckSize, landCount, lands, basics, pips, colors, description };
}

// --- the count sweep ---------------------------------------------------------------

/**
 * The deck's most-played basic (ties → alphabetical), or `undefined` when it runs
 * no basic at all — in which case the count and mix sweeps have nothing to move
 * and say so.
 */
function mostPlayedBasic(summary: ManabaseSummary): ManabaseSummary['basics'][number] | undefined {
  return [...summary.basics].sort((a, b) => b.count - a.count || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))[0];
}

/**
 * The deck's cheapest nonland that can absorb the step: for a land CUT the card
 * gains `k` copies and must stay within the copy limit; for a land ADD it loses
 * `k` copies and must have that many. Ties on mana value go to the card with more
 * copies (the deck's own weighting), then alphabetical.
 */
function cheapestNonland(
  tally: ReadonlyMap<string, { readonly def: CardDefinition; count: number }>,
  k: number,
  direction: 'add' | 'cut',
  rules: DeckRules,
): { readonly def: CardDefinition; readonly count: number } | undefined {
  const eligible = [...tally.values()].filter(({ def, count }) => {
    if (isLand(def) || !def.cost || def.noManaCost) return false;
    if (direction === 'add') {
      const limit = rules.unlimitedCopies.has(def.name) ? Number.POSITIVE_INFINITY : rules.maxCopiesNonBasic;
      return count + k <= limit;
    }
    return count >= k;
  });
  eligible.sort((a, b) => {
    const mv = convertedManaCost(a.def.cost as NonNullable<CardDefinition['cost']>) - convertedManaCost(b.def.cost as NonNullable<CardDefinition['cost']>);
    if (mv !== 0) return mv;
    if (a.count !== b.count) return b.count - a.count;
    return a.def.name < b.def.name ? -1 : a.def.name > b.def.name ? 1 : 0;
  });
  return eligible[0];
}

/**
 * `base − k … base + k` lands. Each step trades one copy of the most-played basic
 * for one copy of the cheapest eligible nonland (or back), so the deck size is
 * unchanged. Pure: same deck, same list.
 */
export function landCountVariants(
  deck: Deck,
  pool: CardPool,
  radius: number = LAND_COUNT_SWEEP_RADIUS,
  rules: DeckRules = DEFAULT_DECK_RULES,
): { readonly variants: readonly ManabaseVariant[]; readonly skipped: readonly SkippedVariant[] } {
  const lines = resolveLines(deck, pool);
  const tally = tallyByCard(lines);
  const summary = summarizeManabase(deck, pool);
  const basic = mostPlayedBasic(summary);
  const variants: ManabaseVariant[] = [];
  const skipped: SkippedVariant[] = [];
  if (!basic) {
    skipped.push({ kind: 'count', label: 'land count sweep', reason: 'the deck runs no basic land to add or cut' });
    return { variants, skipped };
  }
  const basicDef = pool.getByName(basic.name) as CardDefinition;
  for (let k = 1; k <= Math.max(0, Math.floor(radius)); k++) {
    // Fewer lands: cut k of the basic, add k of the cheapest nonland with room.
    const cutLabel = `${summary.landCount - k} lands`;
    if (basic.count < k) {
      skipped.push({ kind: 'count', label: cutLabel, reason: `the deck has only ${basic.count} ${basic.name} to cut` });
    } else {
      const spell = cheapestNonland(tally, k, 'add', rules);
      if (!spell) {
        skipped.push({ kind: 'count', label: cutLabel, reason: `no nonland has room for ${k} more cop${k === 1 ? 'y' : 'ies'}` });
      } else {
        variants.push({
          key: `count:-${k}`,
          kind: 'count',
          label: `${summary.landCount - k} lands (−${k} ${basic.name}, +${k} ${spell.def.name})`,
          note: `cut the most-played basic, add the cheapest nonland with room (${spell.def.name}, mana value ${convertedManaCost(spell.def.cost as NonNullable<CardDefinition['cost']>)})`,
          steps: [{ outId: basicDef.id, outName: basic.name, inId: spell.def.id, inName: spell.def.name, copies: k }],
          landCount: summary.landCount - k,
          slotsChanged: k,
        });
      }
    }
    // More lands: cut k of the cheapest nonland that has them, add k of the basic.
    const addLabel = `${summary.landCount + k} lands`;
    const spell = cheapestNonland(tally, k, 'cut', rules);
    if (!spell) {
      skipped.push({ kind: 'count', label: addLabel, reason: `no nonland has ${k} cop${k === 1 ? 'y' : 'ies'} to cut` });
    } else {
      variants.push({
        key: `count:+${k}`,
        kind: 'count',
        label: `${summary.landCount + k} lands (+${k} ${basic.name}, −${k} ${spell.def.name})`,
        note: `add the most-played basic, cut the cheapest nonland that has the copies (${spell.def.name}, mana value ${convertedManaCost(spell.def.cost as NonNullable<CardDefinition['cost']>)})`,
        steps: [{ outId: spell.def.id, outName: spell.def.name, inId: basicDef.id, inName: basic.name, copies: k }],
        landCount: summary.landCount + k,
        slotsChanged: k,
      });
    }
  }
  return { variants, skipped };
}

// --- the colour-mix sweep ------------------------------------------------------------

/**
 * Basics of one type traded for another, `±1 … ±k`, for every ordered pair of
 * basic types the deck runs. The label keeps one orientation per pair — the
 * deck's own order — so "Forest/Plains 8/8 → 7/9" and "… → 9/7" read as the two
 * directions of one dial.
 */
export function colorMixVariants(
  deck: Deck,
  pool: CardPool,
  radius: number = COLOR_MIX_SWEEP_RADIUS,
): { readonly variants: readonly ManabaseVariant[]; readonly skipped: readonly SkippedVariant[] } {
  const summary = summarizeManabase(deck, pool);
  const variants: ManabaseVariant[] = [];
  const skipped: SkippedVariant[] = [];
  const basics = summary.basics;
  if (basics.length < 2) {
    skipped.push({
      kind: 'mix',
      label: 'colour mix sweep',
      reason: basics.length === 0 ? 'the deck runs no basic lands' : `only one basic land type (${basics[0]?.name}) — nothing to shift`,
    });
    return { variants, skipped };
  }
  for (let i = 0; i < basics.length; i++) {
    for (let j = i + 1; j < basics.length; j++) {
      const a = basics[i] as ManabaseSummary['basics'][number];
      const b = basics[j] as ManabaseSummary['basics'][number];
      const aDef = pool.getByName(a.name) as CardDefinition;
      const bDef = pool.getByName(b.name) as CardDefinition;
      for (let k = 1; k <= Math.max(0, Math.floor(radius)); k++) {
        // a → b: k fewer of a, k more of b.
        for (const [from, to, fromDef, toDef] of [
          [a, b, aDef, bDef],
          [b, a, bDef, aDef],
        ] as const) {
          const after = { [a.name]: a.count, [b.name]: b.count } as Record<string, number>;
          after[from.name] = (after[from.name] as number) - k;
          after[to.name] = (after[to.name] as number) + k;
          const label = `${a.name}/${b.name} ${a.count}/${b.count} → ${after[a.name]}/${after[b.name]}`;
          if (from.count < k) {
            skipped.push({ kind: 'mix', label, reason: `the deck has only ${from.count} ${from.name} to shift` });
            continue;
          }
          variants.push({
            key: `mix:${from.name}>${to.name}:${k}`,
            kind: 'mix',
            label,
            note: `${k} ${from.name} become ${to.name}; every other card is unchanged`,
            steps: [{ outId: fromDef.id, outName: from.name, inId: toDef.id, inName: to.name, copies: k }],
            landCount: summary.landCount,
            slotsChanged: k,
          });
        }
      }
    }
  }
  return { variants, skipped };
}

// --- the land-type sweep ------------------------------------------------------------

/**
 * The definition keys a PLAIN dual may carry: identity, its type line, its two
 * mana modes and its entry rule. A land with any other key does something else
 * (a trigger, an activated ability, a static) and is left out of the type sweep,
 * so what differs between two type variants is exactly the entry rule.
 */
const PLAIN_DUAL_KEYS: ReadonlySet<string> = new Set([
  'id',
  'name',
  'types',
  'subtypes',
  'basic',
  'produces',
  'producesOptions',
  'entersTapped',
  'entersTappedUnless',
  'entersTappedUnlessLifePaid',
  'entersTappedUnlessRevealed',
]);

/** Classify a dual's entry rule onto the closed family table, or refuse it. */
export function dualLandFamilyOf(def: CardDefinition): DualLandFamilyId | undefined {
  if (def.entersTappedUnlessLifePaid !== undefined) return 'shock';
  if (def.entersTappedUnlessRevealed !== undefined) return 'reveal';
  const unless = def.entersTappedUnless;
  if (unless !== undefined) {
    if (unless.controlsSubtype !== undefined) return 'check';
    if (unless.maxOtherLands !== undefined) return 'fast';
    if (unless.minOtherLands !== undefined) return 'slow';
    if (unless.minBasicLands !== undefined) return 'battle';
    return 'conditional';
  }
  if (def.entersTapped === true) return 'tapped';
  return 'untapped';
}

/** The two colours a plain dual taps for, or `undefined` when it is not one. */
function dualColorsOf(def: CardDefinition): readonly [ManaColor, ManaColor] | undefined {
  if (!isLand(def) || def.basic === true) return undefined;
  for (const key of Object.keys(def)) if (!PLAIN_DUAL_KEYS.has(key)) return undefined;
  const modes = manaModesOf(def);
  if (modes.length !== 2) return undefined;
  const colors: ManaColor[] = [];
  for (const mode of modes) {
    const entries = Object.entries(mode).filter(([, n]) => typeof n === 'number' && n > 0);
    if (entries.length !== 1) return undefined;
    const [color, amount] = entries[0] as [string, number];
    if (amount !== 1 || color === 'C' || !WUBRG.includes(color as ManaColor)) return undefined;
    colors.push(color as ManaColor);
  }
  const [first, second] = colors as [ManaColor, ManaColor];
  if (first === second) return undefined;
  return WUBRG.indexOf(first) < WUBRG.indexOf(second) ? [first, second] : [second, first];
}

/**
 * The functional signature the type sweep de-duplicates on: the family, the exact
 * entry condition, and whether the land carries basic land types (a Forest-typed
 * dual is fetchable and turns on a checkland; an untyped one is not and does not).
 */
export function dualSignatureOf(def: CardDefinition): string {
  const family = dualLandFamilyOf(def) ?? 'unknown';
  const condition = JSON.stringify(def.entersTappedUnless ?? def.entersTappedUnlessRevealed ?? def.entersTappedUnlessLifePaid ?? null);
  const typed = (def.subtypes ?? []).some((subtype) => colorOfBasic(capitalize(subtype)) !== undefined);
  return `${family}|${condition}|${typed ? 'typed' : 'untyped'}`;
}

function capitalize(word: string): string {
  return word.length === 0 ? word : word[0]!.toUpperCase() + word.slice(1).toLowerCase();
}

/**
 * A playset of each plain dual that fits two of the deck's colours, replacing
 * two basics of each colour. One variant per functional signature, the first
 * card by name standing for its equivalents; a signature the deck ALREADY runs
 * is skipped by name rather than tested against itself.
 */
export function landTypeVariants(
  deck: Deck,
  pool: CardPool,
  families: readonly DualLandFamilyId[] = DUAL_LAND_FAMILIES.map((f) => f.id),
): { readonly variants: readonly ManabaseVariant[]; readonly skipped: readonly SkippedVariant[] } {
  const summary = summarizeManabase(deck, pool);
  const variants: ManabaseVariant[] = [];
  const skipped: SkippedVariant[] = [];
  if (summary.colors.length < 2) {
    skipped.push({
      kind: 'type',
      label: 'land type sweep',
      reason: summary.colors.length === 0 ? 'the deck has no coloured pips' : `a one-colour deck (${summary.colors[0]}) has no dual to try`,
    });
    return { variants, skipped };
  }
  const allowed = new Set(families);
  const familyOrder = new Map(DUAL_LAND_FAMILIES.map((f, i) => [f.id, i] as const));
  const familyLabel = new Map(DUAL_LAND_FAMILIES.map((f) => [f.id, f.label] as const));
  const inDeck = new Map<string, CardDefinition>();
  for (const { def } of resolveLines(deck, pool)) inDeck.set(def.id, def);
  const deckSignatures = new Map<string, string>();
  for (const def of inDeck.values()) {
    if (dualColorsOf(def)) deckSignatures.set(dualSignatureOf(def), def.name);
  }

  // Candidates, sorted by name so "first by name" is deterministic, then grouped
  // by colour pair and signature.
  const duals = pool.cards
    .map((def) => ({ def, colors: dualColorsOf(def) }))
    .filter((row): row is { def: CardDefinition; colors: readonly [ManaColor, ManaColor] } => row.colors !== undefined)
    .sort((x, y) => (x.def.name < y.def.name ? -1 : x.def.name > y.def.name ? 1 : 0));

  // Colours in the DECK's order — the order its basics are listed, then any colour
  // it splashes without a basic — so "2 Forest + 2 Plains" reads the way the
  // decklist does and agrees with the mix sweep's "Forest/Plains" labels.
  const deckOrder: ManaColor[] = [];
  for (const basic of summary.basics) if (!deckOrder.includes(basic.color)) deckOrder.push(basic.color);
  for (const color of summary.colors) if (!deckOrder.includes(color)) deckOrder.push(color);
  const colors = deckOrder.filter((color) => summary.colors.includes(color));
  for (let i = 0; i < colors.length; i++) {
    for (let j = i + 1; j < colors.length; j++) {
      const c1 = colors[i] as ManaColor;
      const c2 = colors[j] as ManaColor;
      // `dualColorsOf` reports a pair in WUBRG order; match on that, label in deck order.
      const [w1, w2] = WUBRG.indexOf(c1) < WUBRG.indexOf(c2) ? [c1, c2] : [c2, c1];
      const basic1 = summary.basics.find((b) => b.color === c1);
      const basic2 = summary.basics.find((b) => b.color === c2);
      const name1 = BASIC_LAND_FOR_COLOR[c1 as keyof typeof BASIC_LAND_FOR_COLOR];
      const name2 = BASIC_LAND_FOR_COLOR[c2 as keyof typeof BASIC_LAND_FOR_COLOR];
      const perColor = LAND_TYPE_VARIANT_COPIES / 2;
      /** The variant standing for each signature, so its equivalents can be named on it. */
      const standing = new Map<string, ManabaseVariant | null>();
      const equivalents = new Map<string, string[]>();
      const pairRows = duals
        .filter((row) => row.colors[0] === w1 && row.colors[1] === w2)
        .sort((x, y) => (familyOrder.get(dualLandFamilyOf(x.def) as DualLandFamilyId) ?? 0) - (familyOrder.get(dualLandFamilyOf(y.def) as DualLandFamilyId) ?? 0));
      for (const { def } of pairRows) {
        const family = dualLandFamilyOf(def);
        if (family === undefined || !allowed.has(family)) continue;
        const signature = dualSignatureOf(def);
        const label = `${LAND_TYPE_VARIANT_COPIES} ${def.name} for ${perColor} ${name1} + ${perColor} ${name2}`;
        // Per CARD: a land the deck already runs, or one the engine cannot tell
        // from a land it runs, is skipped by name — never tested against itself.
        if (inDeck.has(def.id)) {
          skipped.push({ kind: 'type', label, reason: `${def.name} is already in the deck` });
          continue;
        }
        const already = deckSignatures.get(signature);
        if (already !== undefined) {
          skipped.push({ kind: 'type', label, reason: `the deck already runs an equivalent land (${already})` });
          continue;
        }
        if (standing.has(signature)) {
          // The engine cannot tell this land from the one already chosen for
          // its signature; it is named on that variant rather than tested twice.
          equivalents.get(signature)?.push(def.name);
          continue;
        }
        standing.set(signature, null);
        equivalents.set(signature, []);
        if (!basic1 || basic1.count < perColor || !basic2 || basic2.count < perColor) {
          skipped.push({
            kind: 'type',
            label,
            reason: `needs ${perColor} ${name1} and ${perColor} ${name2} to replace; the deck has ${basic1?.count ?? 0} and ${basic2?.count ?? 0}`,
          });
          continue;
        }
        const basic1Def = pool.getByName(name1) as CardDefinition;
        const basic2Def = pool.getByName(name2) as CardDefinition;
        const variant: ManabaseVariant = {
          key: `type:${def.id}`,
          kind: 'type',
          label,
          note: familyLabel.get(family) ?? family,
          steps: [
            { outId: basic1Def.id, outName: name1, inId: def.id, inName: def.name, copies: perColor },
            { outId: basic2Def.id, outName: name2, inId: def.id, inName: def.name, copies: perColor },
          ],
          landCount: summary.landCount,
          slotsChanged: LAND_TYPE_VARIANT_COPIES,
          family,
        };
        standing.set(signature, variant);
        variants.push(variant);
      }
      // Name the equivalents on the variant that stands for them.
      for (const [signature, names] of equivalents) {
        const variant = standing.get(signature);
        if (!variant || names.length === 0) continue;
        const index = variants.indexOf(variant);
        if (index < 0) continue;
        variants[index] = { ...variant, note: `${variant.note} — also stands for ${names.join(', ')}` };
      }
    }
  }
  return { variants, skipped };
}

// --- the whole family ------------------------------------------------------------

/**
 * Enumerate every variant the chosen sweeps produce for `deck`, legality-checked
 * through the deck loader (a variant that would break the copy limit is skipped
 * with the loader's own reasons, never crashed on). Pure and total.
 */
export function generateManabaseVariants(
  deck: Deck,
  pool: CardPool,
  options: ManabaseSweepOptions = {},
): ManabaseSweep {
  const sweeps = options.sweeps ?? DEFAULT_MANABASE_SWEEPS;
  const rules = options.deckRules ?? DEFAULT_DECK_RULES;
  const base = summarizeManabase(deck, pool);
  const variants: ManabaseVariant[] = [];
  const skipped: SkippedVariant[] = [];
  const collect = (result: { readonly variants: readonly ManabaseVariant[]; readonly skipped: readonly SkippedVariant[] }): void => {
    skipped.push(...result.skipped);
    for (const variant of result.variants) {
      let problems: string[];
      try {
        problems = validateDeck(applyManabase(deck, variant, pool), pool, rules);
      } catch (err) {
        problems = [err instanceof Error ? err.message : String(err)];
      }
      if (problems.length > 0) skipped.push({ kind: variant.kind, label: variant.label, reason: problems.join('; ') });
      else variants.push(variant);
    }
  };
  if (sweeps.count) collect(landCountVariants(deck, pool, options.countRadius ?? LAND_COUNT_SWEEP_RADIUS, rules));
  if (sweeps.mix) collect(colorMixVariants(deck, pool, options.mixRadius ?? COLOR_MIX_SWEEP_RADIUS));
  if (sweeps.type) collect(landTypeVariants(deck, pool, options.families));
  return { base, variants, skipped };
}

// --- building a variant deck ----------------------------------------------------

/**
 * Build the variant deck by folding the variant's steps through `applySwap` —
 * the ONE in-place rewrite the whole paired machinery is built on, so a manabase
 * variant's library differs from the base in exactly `slotsChanged` slots.
 *
 * A step whose out card sits on several decklist lines (two printings of Forest)
 * is applied line by line until the asked-for copies have moved; a step that
 * cannot move them all throws rather than building a deck that differs from the
 * label. The result is named after the variant, not after the chain of swaps.
 *
 * ⚠️ The parameter is the STEPS and the LABEL, not the whole variant, because
 * this is the one fold in the repo that turns a list of replacements into a
 * deck: the joint search (§3.177) builds its own moves from the same
 * `ManabaseStep` shape and must not carry a second copy of this loop.
 */
export function applyManabase(base: Deck, variant: Pick<ManabaseVariant, 'steps' | 'label'>, pool: CardPool): Deck {
  let deck: Deck = base;
  for (const step of variant.steps) {
    let remaining = step.copies;
    while (remaining > 0) {
      const swap = { out: step.outId, in: step.inId };
      // How many THIS line can give (`copiesSwappedBy` reads the same line
      // `applySwap` rewrites); a line that is exhausted makes `applySwap` throw
      // its own "not in deck" error, which is the honest failure here too.
      const moving = copiesSwappedBy(deck, swap, pool, { copies: remaining });
      deck = applySwap(deck, swap, pool, { copies: remaining });
      if (moving <= 0) {
        throw new Error(`"${variant.label}": could not move ${remaining} more ${step.outName} → ${step.inName}`);
      }
      remaining -= moving;
    }
  }
  return { name: `${base.name} — ${variant.label}`, archetype: base.archetype, cards: deck.cards };
}

// --- the adaptive-ladder adapter ---------------------------------------------------

/**
 * A variant as the suggestion ladder's candidate shape, so `driveAdaptiveSearch`
 * schedules, eliminates and `finishSuggestionRun` Holm-corrects a manabase
 * family with the code `suggest` runs on. The ladder reads only `key`,
 * `outName`/`inName` (for its reports) and the traits (for offspring, which a
 * manabase run never uses: `reserves` is empty); the rest is carried so the
 * finished evaluation is self-describing — `inName` IS the variant's label, and
 * `copiesSwapped` is the slots it changed.
 */
export function manabaseCandidateOf(variant: ManabaseVariant, base: ManabaseSummary, baseDeckName: string): SwapCandidate {
  return {
    key: candidateKey(MANABASE_BASE_REF, variant.key),
    outId: MANABASE_BASE_REF,
    inId: variant.key,
    outName: `${base.landCount} lands (as built)`,
    inName: variant.label,
    heuristicScore: 0,
    traits: { colorKey: '', manaValue: 0, role: 'land' },
    variantDeckName: `${baseDeckName} — ${variant.label}`,
    copiesSwapped: variant.slotsChanged,
  };
}

/** The variant a ladder candidate stands for, by key; `undefined` for a foreign key. */
export function variantForCandidateKey(
  key: string,
  variants: readonly ManabaseVariant[],
): ManabaseVariant | undefined {
  return variants.find((variant) => candidateKey(MANABASE_BASE_REF, variant.key) === key);
}
