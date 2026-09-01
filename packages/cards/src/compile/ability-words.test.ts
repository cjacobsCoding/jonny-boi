/**
 * AN ABILITY WORD IS A LABEL, NOT AN ABILITY (CR 207.2c).
 *
 * The italicised word in front of a line — Landfall, Revolt, Threshold — has no
 * rules meaning. Everything the ability does is printed in the line itself.
 *
 * The bug this file pins: the label used to decide, all by itself, that a line
 * was a RIDER on the line above it, so
 *
 *     Flying
 *     Revolt — When this creature enters, … you gain 5 life.
 *
 * was glued into "Flying. Revolt — When ~ enters, … you gain 5 life." — one
 * sentence no rule can ever match, on a card whose body the compiler already
 * understood. A rider is the rare case (Fatal Push), not the common one, and
 * conflating the two made every ability-word card unreachable through a gap
 * that looked like a missing mechanic in every report.
 *
 * Measured honestly: fixing it moved the full 31,091-card pool by **+14**
 * playable cards, far fewer than the ~450 the old reports attributed to
 * "missing ability words" — because stripping the label exposes the BODY, and
 * most of those bodies are still unimplemented. The change is kept because the
 * backlog now names the body instead of the label, so the NEXT measurement is
 * honest; the 14 cards are a side effect, not the case for it.
 */

import { describe, expect, it } from 'vitest';
import { compileCard } from './compile.js';
import { splitAbilities } from './text.js';
import type { CompilableCard } from './types.js';

function card(
  oracleText: string,
  types: readonly string[] = ['Creature'],
  keywords: readonly string[] = [],
): CompilableCard {
  return {
    id: 'test:ability-word',
    name: 'Probe Card',
    manaCost: { generic: 1, W: 0, U: 0, B: 1, R: 0, G: 0, C: 0, other: [] },
    typeLine: { supertypes: [], types: [...types], subtypes: [] },
    oracleText,
    power: types.includes('Creature') ? '2' : null,
    toughness: types.includes('Creature') ? '2' : null,
    keywords: [...keywords],
  };
}

describe('an ability-word label is folded away, never glued to the line above', () => {
  it('leaves a standalone ability-word line as its own ability, label stripped', () => {
    expect(splitAbilities('Flying\nRevolt — When this creature enters, you gain 5 life.')).toEqual([
      'Flying',
      'When this creature enters, you gain 5 life.',
    ]);
  });

  it('compiles the line the label sat on, exactly as if the label were absent', () => {
    const labelled = compileCard(card('Landfall — Whenever a land you control enters, you gain 1 life.'));
    const bare = compileCard(card('Whenever a land you control enters, you gain 1 life.'));
    expect(labelled.status, JSON.stringify(labelled.missing)).toBe('complete');
    expect(labelled.definition.triggers).toEqual(bare.definition.triggers);
  });

  it('does not glue the label to the KEYWORD line above it', () => {
    const result = compileCard(card('Flying\nLandfall — Whenever a land you control enters, you gain 1 life.'));
    expect(result.status, JSON.stringify(result.missing)).toBe('complete');
    expect(result.definition.keywords?.flying).toBe(true);
    expect(result.definition.triggers).toHaveLength(1);
  });

  it('STILL joins a true rider, which cannot stand alone', () => {
    // Fatal Push: "that creature" has no referent, and compiling the two lines
    // independently would destroy twice.
    const lines = splitAbilities(
      'Destroy target creature if it has mana value 2 or less.\n' +
        'Revolt — Destroy that creature if it has mana value 4 or less instead if a permanent left the battlefield under your control this turn.',
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('Revolt —');
  });

  it('does not mistake a line that REPLACES ITS OWN first sentence for a rider', () => {
    // Akoum Hellkite's "instead" replaces the damage its own first sentence
    // deals, not anything on the line above — and the line opens a trigger, so
    // it plainly stands alone.
    const lines = splitAbilities(
      'Flying\nLandfall — Whenever a land you control enters, this creature deals 1 damage to any target. ' +
        'If that land is a Mountain, this creature deals 2 damage instead.',
    );
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatch(/^Whenever a land/);
  });

  it('leaves a rider with no line above it alone, label included, so it reports honestly', () => {
    const lines = splitAbilities(
      'Revolt — Destroy that creature if it has mana value 4 or less instead.',
    );
    expect(lines).toEqual(['Revolt — Destroy that creature if it has mana value 4 or less instead.']);
  });

  it('does not strip a label that carries real rules — a Saga chapter, or Channel', () => {
    // CR 207.2c is about words with NO rules meaning. These have plenty, and
    // folding them away would delete the ability rather than reveal it.
    expect(splitAbilities('I — Draw a card.')).toEqual(['I — Draw a card.']);
    expect(splitAbilities('Channel — {2}{R}, Discard this card: It deals 2 damage to any target.')).toEqual([
      'Channel — {2}{R}, Discard this card: It deals 2 damage to any target.',
    ]);
  });
});
