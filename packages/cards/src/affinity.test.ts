/**
 * AFFINITY (CR 702.40) — a spell that costs less for each permanent you control.
 *
 * Chosen from the backlog, not from taste: with ability-word labels folded away
 * (§3.68) the two independent reports agreed that Affinity was the largest
 * unimplemented mechanic that needs no new payment machinery — 28 cards blocked
 * by that line alone, and 33 counting its rarer nouns.
 *
 * The three things a wrong implementation gets wrong, one test each:
 *   - it reduces GENERIC mana only (CR 601.2f), so a coloured pip survives;
 *   - it FLOORS at zero rather than owing the board mana;
 *   - it counts permanents the CASTER controls, as printed, not every permanent.
 *
 * And the fourth, which is the compiler's own discipline: a noun outside the
 * closed table REPORTS instead of quietly compiling into a wider one. "Affinity
 * for Slivers" reduced "for each creature" would make the spell far cheaper than
 * printed — the exact silent approximation this compiler exists to refuse.
 */

import { describe, expect, it } from 'vitest';
import { castManaCostFor, type CardDefinition, type GameState, type ManaCost } from '@jonny-boi/core';
import { compileCard } from './compile/compile.js';
import type { CompilableCard } from './compile/types.js';

function card(oracleText: string, types: readonly string[] = ['Artifact', 'Creature']): CompilableCard {
  return {
    id: 'test:affinity',
    name: 'Probe Card',
    manaCost: { generic: 4, W: 0, U: 1, B: 0, R: 0, G: 0, C: 0, other: [] },
    typeLine: { supertypes: [], types: [...types], subtypes: [] },
    oracleText,
    power: '2',
    toughness: '2',
    keywords: ['Affinity'],
  };
}

const ARTIFACT: CardDefinition = {
  id: 'test:rock',
  name: 'Rock',
  manaCost: { generic: 1, W: 0, U: 0, B: 0, R: 0, G: 0, C: 0, other: [] },
  types: ['artifact'],
};

function rock(id: string, controller: 'A' | 'B') {
  return {
    instanceId: id,
    def: ARTIFACT,
    controller,
    owner: controller,
    tapped: false,
    damageMarked: 0,
    markedByDeathtouch: false,
    summoningSick: false,
    counters: {},
  };
}

/**
 * A board where `mine` artifacts are yours and `theirs` belong to the opponent.
 *
 * `castManaCostFor` reads `state.battlefield` and nothing else, so this is a
 * battlefield rather than a whole game — a real `createGame` here would test the
 * setup code, not the arithmetic under examination.
 */
function boardWith(mine: number, theirs = 0): GameState {
  return {
    battlefield: [
      ...Array.from({ length: mine }, (_, i) => rock(`a${i}`, 'A')),
      ...Array.from({ length: theirs }, (_, i) => rock(`b${i}`, 'B')),
    ],
  } as unknown as GameState;
}

/**
 * The printed cost under test: {4}{U}. Passed EXPLICITLY rather than read off
 * the compiled definition, because the cost the engine reduces is the one the
 * cast path hands it (printed, flashback, madness — CR 601.2f reduces them all),
 * and that is the parameter this function actually takes.
 */
const BASE: ManaCost = { generic: 4, U: 1 } as ManaCost;

describe('affinity — the spell costs less for each permanent you control', () => {
  const compiled = compileCard(card('Affinity for artifacts'));
  const def = compiled.definition;

  it('compiles the keyword line, and the longhand printing, to the same data', () => {
    expect(compiled.status, JSON.stringify(compiled.missing)).toBe('complete');
    const longhand = compileCard(card('This spell costs {1} less to cast for each artifact you control.'));
    expect(longhand.status, JSON.stringify(longhand.missing)).toBe('complete');
    expect(longhand.definition.castCostReductionPerPermanent).toEqual(
      def.castCostReductionPerPermanent,
    );
  });

  it('costs full price on an empty board', () => {
    const cost = castManaCostFor(boardWith(0), 'A', def, BASE);
    expect(cost?.generic).toBe(4);
    expect(cost?.U).toBe(1);
  });

  it('reduces GENERIC mana only — the coloured pip survives (CR 601.2f)', () => {
    const cost = castManaCostFor(boardWith(3), 'A', def, BASE);
    expect(cost?.generic).toBe(1);
    expect(cost?.U).toBe(1);
  });

  it('floors at zero rather than owing the board mana', () => {
    const cost = castManaCostFor(boardWith(9), 'A', def, BASE);
    expect(cost?.generic ?? 0).toBe(0);
    expect(cost?.U).toBe(1);
  });

  it('counts only permanents YOU control, as printed', () => {
    const cost = castManaCostFor(boardWith(1, 5), 'A', def, BASE);
    expect(cost?.generic).toBe(3);
  });

  it('REPORTS a noun outside the closed table instead of widening it', () => {
    const slivers = compileCard(card('Affinity for Slivers'));
    expect(slivers.status).not.toBe('complete');
    expect(slivers.definition.castCostReductionPerPermanent).toBeUndefined();
  });
});
