/**
 * §3.143 — THE TWO ANSWERS TO "WHAT IS A PRINTED SYMBOL WORTH?", pinned against
 * each other and against Scryfall.
 *
 * `@jonny-boi/core` answers it from the COMPILED cost (`convertedManaCost`, via
 * `hybridSymbolManaValue`); `@jonny-boi/data-tools` answers it from the PRINTED
 * symbol string (`maxSymbolManaValue`, the ceiling its card-index reconciliation
 * brackets `cmc` with). Two copies exist because data-tools deliberately has no
 * dependencies and so cannot call core — which is exactly the situation CLAUDE.md
 * rule 12 says needs a test that fails when they diverge. This is that test.
 *
 * It is also the guard the brief's warning names: get a hybrid symbol's mana
 * value wrong and the card index's pip/mana-value reconciliation is the thing
 * that fails, several systems away from the mistake.
 *
 * The third party is REALITY: every card in the real Scryfall fixture whose cost
 * the compiler reads in full must land on the mana value Scryfall printed. A
 * table agreeing with itself proves nothing if both halves are wrong.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { convertedManaCost, formatManaCost, hybridSymbolManaValue, PHYREXIAN_LIFE_PRICE } from '@jonny-boi/core';
import type { HybridComponent } from '@jonny-boi/core';
import { maxSymbolManaValue } from '@jonny-boi/data-tools';
import { compileCard, UNPAYABLE_MANA_SYMBOL_GAP } from './compile.js';
import type { CompilableCard } from './types.js';

/**
 * Printed symbol → the components core compiles it into. Every hybrid family
 * plus the two things a cost prints that are not symbols core can pay, so the
 * parity check covers the whole vocabulary rather than the convenient half.
 */
const PRINTED_SYMBOLS: ReadonlyArray<readonly [string, readonly HybridComponent[]]> = [
  ['G/W', ['G', 'W']],
  ['W/U', ['W', 'U']],
  ['2/W', [{ generic: 2 }, 'W']],
  ['2/R', [{ generic: 2 }, 'R']],
  ['W/P', ['W', { life: PHYREXIAN_LIFE_PRICE }]],
  ['B/P', ['B', { life: PHYREXIAN_LIFE_PRICE }]],
  ['G/U/P', ['G', 'U', { life: PHYREXIAN_LIFE_PRICE }]],
];

describe('§3.143 mana value has ONE answer across the packages', () => {
  for (const [printed, components] of PRINTED_SYMBOLS) {
    it(`{${printed}} is worth the same to core and to the card-index bracket`, () => {
      expect(maxSymbolManaValue(printed)).toBe(hybridSymbolManaValue(components));
    });
  }

  it('agrees on the symbols that are NOT hybrid', () => {
    // {X} is 0 outside the stack (CR 107.3) on both sides, and an unreadable
    // symbol is one pip — the ceiling this bracket has always assumed.
    expect(maxSymbolManaValue('X')).toBe(0);
    expect(maxSymbolManaValue('S')).toBe(1);
    // A brace-wrapped spelling is the same symbol, because a hand-built record
    // may carry either form (the compiler folds both too).
    expect(maxSymbolManaValue('{2/W}')).toBe(2);
  });
});

// --- against Scryfall itself ------------------------------------------------------

/**
 * The same normalized Scryfall index `compile.test.ts` joins the pool to — real
 * printed costs with Scryfall's own `cmc` beside them.
 */
const CARD_INDEX_PATH = fileURLToPath(
  new URL('../../../data-tools/data/card-index.json', import.meta.url),
);

interface CardIndexFile {
  readonly cards: readonly CompilableCard[];
}

describe("§3.143 the compiled mana value equals Scryfall's own", () => {
  it('matches on every indexed card whose cost the compiler reads in full', () => {
    const index = JSON.parse(readFileSync(CARD_INDEX_PATH, 'utf8')) as CardIndexFile;
    expect(index.cards.length).toBeGreaterThan(0);
    const mismatches: string[] = [];
    let checked = 0;
    let hybridsChecked = 0;
    for (const card of index.cards) {
      // `{X}` is worth 0 outside the stack (CR 107.3) and the compiled cost does
      // not carry the symbol at all, so such a card cannot reconcile here; the
      // check is about the symbols the compiler turned INTO pips.
      if (card.manaCost.other.some((symbol) => symbol.replace(/[{}]/g, '').toUpperCase() === 'X')) continue;
      let compiled;
      try {
        compiled = compileCard(card);
      } catch {
        continue; // a throw is not a verdict — the coverage tools count those
      }
      // A card the compiler still REPORTS a mana symbol for has pips it never
      // turned into a cost. Excluded, because the reconciliation is about what
      // was read, not about what was honestly refused.
      if (compiled.missing.some((gap) => gap.missingEngineSystem === UNPAYABLE_MANA_SYMBOL_GAP)) continue;
      const cost = compiled.definition.cost ?? {};
      checked += 1;
      if ((cost.hybrid?.length ?? 0) > 0) hybridsChecked += 1;
      if (convertedManaCost(cost) !== card.cmc) {
        mismatches.push(`${card.name} ${formatManaCost(cost)}: compiled ${convertedManaCost(cost)}, Scryfall ${card.cmc}`);
      }
    }
    expect(mismatches).toEqual([]);
    expect(checked).toBeGreaterThan(0);
    // The index must actually CONTAIN hybrid costs, or this check would pass
    // forever on plain pips while the hybrid rule rotted.
    expect(hybridsChecked).toBeGreaterThan(0);
  });
});
