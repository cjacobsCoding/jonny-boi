/**
 * THE DEAD-RULE GUARD — a rule whose pattern matches nothing real.
 *
 * §3.57's defect, and it hid in plain sight: the two-branch tutor rule was
 * written for Gatecreeper Vine but demanded "or **a** Gate card" while Oracle
 * prints "or Gate card". The rule existed, looked shipped, matched ZERO cards,
 * and the coverage audit blamed a missing engine SYSTEM rather than the rule —
 * so nobody looked at the rule. Nothing in the suite could see it, because
 * every compiler test asserts what a rule DOES on text the test itself wrote:
 * a rule written from a remembered wording and a test written from the same
 * remembered wording agree perfectly and cover nothing.
 *
 * This test quantifies over the RULE TABLE instead, against the printed text of
 * the whole pool (`card-index.json`, the same source the pool round-trip uses):
 * a rule whose own description NAMES a pool card must actually fire when that
 * card compiles. The description is the rule author's claim about what it
 * covers; this is that claim, checked.
 *
 * A rule that names no pool card is not tested here — it may legitimately cover
 * cards outside the pool. `packages/cards/scripts/dead-rule-sweep.mjs` runs the
 * same question over a saved Scryfall corpus, where far more rules are reachable.
 */

import { describe, expect, it } from 'vitest';
import { EFFECT_RULES } from './rules.js';
import { compileCard } from './compile.js';
import type { CompilableCard } from './types.js';
import cardIndex from '../../../data-tools/data/card-index.json' with { type: 'json' };

interface IndexedCard {
  readonly id: string;
  readonly name: string;
  readonly manaCost: CompilableCard['manaCost'];
  readonly typeLine: CompilableCard['typeLine'];
  readonly oracleText: string;
  readonly power: string | null;
  readonly toughness: string | null;
  readonly keywords: readonly string[];
}

const POOL_TEXT = (cardIndex as { cards: readonly IndexedCard[] }).cards;

/** Card names a rule's description cites, in parentheses, as printed. */
function citedCards(description: string): readonly string[] {
  return [
    ...new Set(
      [...description.matchAll(/\(([^)]+)\)/g)]
        .flatMap((match) => (match[1] ?? '').split(/[,;]/))
        // "Liliana's −2" and "Fatal Push — Revolt" cite the card, not the ability.
        .map((name) => name.replace(/—.*$/, '').replace(/'s\b.*$/, '').trim()),
    ),
  ];
}

describe('every rule that names a pool card actually fires on it (§3.57)', () => {
  const byName = new Map(POOL_TEXT.map((card) => [card.name, card]));
  // Compiled once: the whole pool, with the rule ids each card matched.
  const firedBy = new Map<string, ReadonlySet<string>>();
  for (const card of POOL_TEXT) {
    const result = compileCard(card as unknown as CompilableCard);
    firedBy.set(card.name, new Set(result.matchedRules));
  }

  it('the pool text really is compilable — otherwise this whole guard is vacuous', () => {
    expect(POOL_TEXT.length).toBeGreaterThan(100);
    const anyFired = [...firedBy.values()].filter((ids) => ids.size > 0);
    expect(anyFired.length).toBeGreaterThan(100);
  });

  it('no rule cites a pool card it never matches', () => {
    const broken: string[] = [];
    for (const rule of EFFECT_RULES) {
      for (const name of citedCards(rule.description)) {
        const card = byName.get(name);
        if (!card) continue; // cites a card outside the pool — not testable here
        if (!firedBy.get(name)?.has(rule.id)) {
          broken.push(`${rule.id} claims to compile "${name}" but never matches its printed text`);
        }
      }
    }
    expect(
      broken,
      'a rule whose pattern was written from a remembered wording matches nothing and ' +
        'covers no card, while the coverage audit blames a missing engine system (§3.57)',
    ).toEqual([]);
  });
});
