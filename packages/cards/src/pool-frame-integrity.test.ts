/**
 * POOL FRAME INTEGRITY — the §3.49 invariant for the §3.44 "Serra Angel was
 * not an Angel" class.
 *
 * Ten hand-authored curated cards carried NO subtypes, so every rule that asks
 * the type line — Restoration Angel's "non-Angel", Goblin Chieftain's anthem,
 * Ophiomancer's intervening "if" — silently did not apply to them. The
 * behaviour audits could not see it because they compare what a card DOES;
 * nothing compared what a hand-authored card IS against ground truth.
 *
 * This file compares the whole printed FRAME of every pool card — curated and
 * generated alike — against the offline Scryfall index (`data-tools`' cached
 * `card-index.json`; nothing here fetches):
 *
 *   - card types      (a hand-authored artifact that forgot 'creature' plays
 *                      as uncrewable furniture)
 *   - subtypes        (the §3.44 defect: absent ⇒ typal rules skip the card)
 *   - legendary flag  (absent ⇒ the §3.15 legend rule skips the card)
 *   - power/toughness (a 4/4 authored as 4/5 wins fights the printed card loses)
 *   - loyalty         (a walker entering at the wrong loyalty is a different card)
 *   - defense         (a battle entering at the wrong defense is a different card)
 *
 * `fidelity.test.ts` keeps its §3.44 regression guard (subtypes, front face);
 * this file is the CLASS: every frame axis, every card, one sweep that a new
 * hand-authored card cannot dodge. The compiler-generated half of the pool is
 * swept too — there it doubles as a staleness check on the generated data.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CARD_POOL } from '../data/pool.js';
import type { CompilableCard } from './compile/index.js';

/** The normalized Scryfall index every pool card joins to (owned by data-tools). */
const index = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../data-tools/data/card-index.json', import.meta.url)), 'utf8'),
) as { cards: readonly CompilableCard[] };
const scryfallById = new Map(index.cards.map((card) => [card.id, card]));

/** Case-folded, sorted, for set comparison — Scryfall capitalizes, the pool doesn't. */
function folded(values: readonly string[] | undefined): string[] {
  return [...(values ?? [])].map((value) => value.toLowerCase()).sort();
}

/**
 * The printed FRONT face: a transforming DFC's pool definition carries the
 * front face's frame at top level (the back is its own `backFace` record),
 * while the index's merged `typeLine` splices both with a literal `//`.
 */
function frontFace(scryfall: CompilableCard): {
  typeLine: CompilableCard['typeLine'];
  power: number | null;
  toughness: number | null;
} {
  const face = scryfall.faces?.[0];
  return {
    typeLine: face?.typeLine ?? scryfall.typeLine,
    power: face?.power ?? scryfall.power,
    toughness: face?.toughness ?? scryfall.toughness,
  };
}

/**
 * The type sets a pool definition may legitimately carry, as sorted folded
 * keys: the FRONT face's (a transforming DFC keeps the back in `backFace`; an
 * adventure is its creature half), or the UNION across faces (a SPLIT card is
 * one object whose characteristics are both halves — `Road // Ruin` is
 * authored `instant + sorcery`, which is what CR 708.4 says it is anywhere
 * but the stack). Both shapes trace to the printed card; anything else fails.
 */
function acceptableTypeKeys(scryfall: CompilableCard, pick: (line: CompilableCard['typeLine']) => readonly string[]): string[] {
  const faces = scryfall.faces?.length ? scryfall.faces : [scryfall];
  const front = JSON.stringify(folded(pick(frontFace(scryfall).typeLine)));
  const union = JSON.stringify(folded([...new Set(faces.flatMap((f) => [...pick(f.typeLine)]))]));
  return front === union ? [front] : [front, union];
}

describe('every pool card’s frame agrees with the printed card (§3.44 class)', () => {
  it('every pool card joins to the offline index', () => {
    const missing = CARD_POOL.filter((card) => !scryfallById.has(card.id)).map((card) => card.name);
    expect(missing, 'pool cards with no card-index entry — regenerate the index (offline data drift)').toEqual([]);
  });

  it('card types match', () => {
    const wrong: string[] = [];
    for (const card of CARD_POOL) {
      const scryfall = scryfallById.get(card.id);
      if (!scryfall) continue; // reported above, once
      const declared = JSON.stringify(folded(card.types));
      const accepted = acceptableTypeKeys(scryfall, (line) => line.types);
      if (!accepted.includes(declared)) {
        wrong.push(`${card.name}: printed ${accepted.join(' or ')} vs authored ${declared}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it('subtypes match', () => {
    const wrong: string[] = [];
    for (const card of CARD_POOL) {
      const scryfall = scryfallById.get(card.id);
      if (!scryfall) continue;
      const declared = JSON.stringify(folded(card.subtypes));
      const accepted = acceptableTypeKeys(scryfall, (line) => line.subtypes);
      if (!accepted.includes(declared)) {
        wrong.push(`${card.name}: printed ${accepted.join(' or ')} vs authored ${declared}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it('the legendary flag matches the printed supertype', () => {
    const wrong: string[] = [];
    for (const card of CARD_POOL) {
      const scryfall = scryfallById.get(card.id);
      if (!scryfall) continue;
      const printed = folded(frontFace(scryfall).typeLine.supertypes).includes('legendary');
      const declared = card.legendary === true;
      if (printed !== declared) {
        wrong.push(`${card.name}: printed legendary=${printed} vs authored ${declared} — the legend rule keys on this`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it('power and toughness match', () => {
    const wrong: string[] = [];
    for (const card of CARD_POOL) {
      const scryfall = scryfallById.get(card.id);
      if (!scryfall) continue;
      const face = frontFace(scryfall);
      // `null` covers both "not a creature" and a printed `*` — a star P/T is
      // the characteristic-defining box, which carries no fixed number to
      // compare (the engine models it as `characteristicPT`).
      if (face.power !== null && card.power !== face.power) {
        wrong.push(`${card.name}: printed power ${face.power} vs authored ${card.power}`);
      }
      if (face.toughness !== null && card.toughness !== face.toughness) {
        wrong.push(`${card.name}: printed toughness ${face.toughness} vs authored ${card.toughness}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it('planeswalker loyalty and battle defense match', () => {
    const wrong: string[] = [];
    for (const card of CARD_POOL) {
      const scryfall = scryfallById.get(card.id);
      if (!scryfall) continue;
      if (typeof scryfall.loyalty === 'number' && card.loyalty !== scryfall.loyalty) {
        wrong.push(`${card.name}: printed loyalty ${scryfall.loyalty} vs authored ${card.loyalty}`);
      }
      if (typeof scryfall.defense === 'number' && card.defense !== scryfall.defense) {
        wrong.push(`${card.name}: printed defense ${scryfall.defense} vs authored ${card.defense}`);
      }
    }
    expect(wrong).toEqual([]);
  });
});
