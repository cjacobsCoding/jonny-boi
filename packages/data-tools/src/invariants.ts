/**
 * Structural invariants for a {@link CardIndex} — the offline half of the
 * accuracy guard (the online half is `verify.ts` + `verify-cli.ts`).
 *
 * The committed index is the ONLY card data the engine, the AI pilots and the
 * sim ever read; nothing at play time calls Scryfall. So a single wrong pip in
 * this file silently skews every A/B verdict the lab produces, and nothing else
 * in the suite would notice. These checks are the tripwire: they are pure, they
 * need no network, and they run over the committed file in `npm test`.
 *
 * They deliberately encode facts that MUST hold for *any* well-formed Magic
 * card, rather than a snapshot of today's values — a snapshot would have to be
 * updated on every legitimate refresh and would therefore be re-blessed without
 * being read. What is asserted here is the shape a card cannot violate:
 *
 *  - mana value has to be reconcilable with the printed pips;
 *  - a coloured pip in the cost implies that colour in the card's identity;
 *  - the parsed type line has to round-trip from the raw one;
 *  - power and toughness travel together, and only creatures have them;
 *  - a listed keyword has to actually appear in the printed text;
 *  - ids and names are unique, and the file is sorted.
 *
 * A violation means the index disagrees with itself: it was hand-edited, or
 * merged badly, or written by a normalizer change that lost information.
 */

import { parseTypeLine } from './parse.js';
import type { CardIndex, ManaCost, NormalizedCard } from './types.js';

/** The five printed colours. `C` is colourless and is not a colour identity. */
const WUBRG = ['W', 'U', 'B', 'R', 'G'] as const;

/** The card type that may carry power/toughness. */
const CREATURE_TYPE = 'Creature';

/**
 * Keywords Scryfall lists by their FAMILY name, which is never the word printed
 * on the card, together with the shape that word actually takes.
 *
 * "Landcycling" is a family: Chartooth Cougar prints **Mountaincycling {2}**,
 * Elvish Aberration prints **Forestcycling {2}**, and no card anywhere prints
 * the word "landcycling". Same for "Typecycling" (Slice and Dice prints
 * **Wizardcycling**) and "Landwalk" (Bull Hippo prints **Islandwalk**).
 *
 * ⚠️ THE TABLE IS CLOSED, and every row is a family whose members were checked.
 * A keyword missing from the printed text is normally exactly the data error
 * this invariant exists to catch — an index row that came from somewhere other
 * than the card — so widening it to "close enough" would retire the check. Each
 * pattern is anchored to the family's own suffix and matches nothing else.
 */
const FAMILY_KEYWORD_PRINTS: ReadonlyMap<string, RegExp> = new Map([
  ['Landcycling', /\b[a-z]+cycling\b/],
  ['Basic landcycling', /\b[a-z]+cycling\b/],
  ['Typecycling', /\b[a-z]+cycling\b/],
  ['Landwalk', /\b[a-z]+walk\b/],
]);

/** One broken invariant, named so a failure message is actionable on its own. */
export interface IndexViolation {
  /** Card name (or `'<index>'` for whole-file invariants). */
  readonly card: string;
  /** Which invariant broke. */
  readonly rule: string;
  /** What the file actually contains. */
  readonly detail: string;
}

/** Sum of the pips whose contribution to mana value is unambiguous. */
export function knownPipTotal(cost: ManaCost): number {
  return cost.generic + cost.W + cost.U + cost.B + cost.R + cost.G + cost.C;
}

/** Render a {@link ManaCost} back to Scryfall-ish notation, for messages. */
export function formatManaCost(cost: ManaCost): string {
  const parts: string[] = [];
  if (cost.generic > 0) parts.push(`{${cost.generic}}`);
  for (const symbol of [...WUBRG, 'C'] as const) {
    for (let i = 0; i < cost[symbol]; i += 1) parts.push(`{${symbol}}`);
  }
  for (const symbol of cost.other) parts.push(`{${symbol}}`);
  return parts.join('') || '{}';
}

/** Every oracle text on the card, front face and (for DFCs) each face. */
function allOracleText(card: NormalizedCard): string {
  return [card.oracleText, ...card.faces.map((face) => face.oracleText)].join('\n').toLowerCase();
}

/**
 * Check one normalized card. Returns every violation it has (not just the
 * first) so one run reports the whole picture.
 */
export function checkCard(card: NormalizedCard): IndexViolation[] {
  const violations: IndexViolation[] = [];
  const fail = (rule: string, detail: string): void => {
    violations.push({ card: card.name || '<unnamed>', rule, detail });
  };

  if (!card.id.trim()) fail('id is non-empty', 'empty id');
  if (!card.name.trim()) fail('name is non-empty', 'empty name');

  // --- cost ↔ mana value ---------------------------------------------------
  // Every unambiguous pip contributes exactly 1 to mana value (generic
  // contributes its number). The symbols we could not attribute — hybrid, snow,
  // Phyrexian — contribute at most 1 each, and {X} contributes 0, so the true
  // mana value is bracketed by the known total and that total plus `other`.
  const known = knownPipTotal(card.manaCost);
  if (card.cmc < known || card.cmc > known + card.manaCost.other.length) {
    fail(
      'mana value is reconcilable with the printed pips',
      `${formatManaCost(card.manaCost)} → pips ${known}..${known + card.manaCost.other.length}, but cmc is ${card.cmc}`,
    );
  }
  if (card.cmc < 0) fail('mana value is not negative', `cmc ${card.cmc}`);
  for (const symbol of ['generic', ...WUBRG, 'C'] as const) {
    if (card.manaCost[symbol] < 0) {
      fail('pip counts are not negative', `${symbol} ${card.manaCost[symbol]}`);
    }
  }

  // A coloured pip you must pay is, by the colour rules, part of the card's
  // colour identity. (Its `colors` can legitimately differ — devoid — but its
  // identity cannot.) This is the check that catches a generic pip that turned
  // into a coloured one.
  for (const color of WUBRG) {
    if (card.manaCost[color] > 0 && !card.colorIdentity.includes(color)) {
      fail(
        'a coloured pip implies that colour in the colour identity',
        `${formatManaCost(card.manaCost)} but colorIdentity is [${card.colorIdentity.join(', ')}]`,
      );
    }
  }
  for (const color of card.colors) {
    if (!card.colorIdentity.includes(color)) {
      fail(
        'colors are a subset of the colour identity',
        `colors [${card.colors.join(', ')}] ⊄ colorIdentity [${card.colorIdentity.join(', ')}]`,
      );
    }
  }

  // --- type line -----------------------------------------------------------
  // The parsed halves must be exactly what the parser makes of the raw line, so
  // a hand-edit of either one is caught.
  const reparsed = parseTypeLine(card.rawTypeLine);
  if (JSON.stringify(reparsed) !== JSON.stringify(card.typeLine)) {
    fail(
      'the parsed type line round-trips from the raw one',
      `"${card.rawTypeLine}" parses to ${JSON.stringify(reparsed)}, stored ${JSON.stringify(card.typeLine)}`,
    );
  }
  if (card.rawTypeLine.trim() && card.typeLine.types.length === 0) {
    fail('a card has at least one card type', `"${card.rawTypeLine}"`);
  }

  // --- power / toughness ---------------------------------------------------
  // Both or neither: a card with one printed number and not the other does not
  // exist. `null` for a creature is legitimate — it means a characteristic-
  // defining `*`, which `parseStat` refuses to guess a number for.
  if ((card.power === null) !== (card.toughness === null)) {
    fail('power and toughness are both present or both absent', `${card.power}/${card.toughness}`);
  }
  const isCreature = card.typeLine.types.includes(CREATURE_TYPE);
  if (!isCreature && card.power !== null) {
    fail('only creatures carry power/toughness', `${card.rawTypeLine} is ${card.power}/${card.toughness}`);
  }

  // --- keywords ------------------------------------------------------------
  // Scryfall derives `keywords` from the printed text, so a keyword that does
  // not appear in any face's text is data that came from somewhere else.
  const text = allOracleText(card);
  for (const keyword of card.keywords) {
    if (!text.includes(keyword.toLowerCase()) && !FAMILY_KEYWORD_PRINTS.get(keyword)?.test(text)) {
      fail('every listed keyword appears in the printed text', `"${keyword}" is not in the oracle text`);
    }
  }

  // --- faces ---------------------------------------------------------------
  if (card.isDoubleFaced && card.faces.length === 0) {
    fail('a double-faced card carries its faces', 'isDoubleFaced with no faces');
  }
  if (!card.isDoubleFaced && card.faces.length > 0) {
    fail('a single-faced card carries no faces', `${card.faces.length} faces`);
  }

  return violations;
}

/**
 * Check a whole index: every card, plus the file-level invariants (uniqueness,
 * sort order, the header fields).
 */
export function checkCardIndex(index: CardIndex): IndexViolation[] {
  const violations: IndexViolation[] = [];
  const fail = (rule: string, detail: string): void => {
    violations.push({ card: '<index>', rule, detail });
  };

  if (!index.attribution.trim()) fail('the index carries its Scryfall attribution', 'empty attribution');
  if (index.cards.length === 0) fail('the index is not empty', '0 cards');

  const seenIds = new Set<string>();
  const seenNames = new Set<string>();
  for (const card of index.cards) {
    if (seenIds.has(card.id)) fail('card ids are unique', `duplicate id ${card.id} (${card.name})`);
    if (seenNames.has(card.name)) fail('card names are unique', `duplicate name ${card.name}`);
    seenIds.add(card.id);
    seenNames.add(card.name);
    violations.push(...checkCard(card));
  }

  // The pipeline writes the cards sorted by name; drift means an edit landed by
  // hand rather than by regenerating.
  for (let i = 1; i < index.cards.length; i += 1) {
    const previous = index.cards[i - 1]!;
    const current = index.cards[i]!;
    if (previous.name.localeCompare(current.name) > 0) {
      fail('cards are sorted by name', `${previous.name} precedes ${current.name}`);
    }
  }

  return violations;
}

/** A one-line-per-violation report, for test failure messages and the CLI. */
export function formatViolations(violations: readonly IndexViolation[]): string {
  return violations.map((v) => `  ${v.card}: ${v.rule} — ${v.detail}`).join('\n');
}
