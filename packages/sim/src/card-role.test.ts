/**
 * §3.135 — what a card is FOR, read off its compiled effects, and the
 * no-brainer test built on top of it. Asked for directly: look at the obvious
 * swaps first, and prefer swapping like for like.
 *
 * These assert against REAL pool cards on purpose. The whole premise of the
 * classifier is that a compiled card already says what it does, so a test that
 * invented its own definitions would be testing a fiction.
 */
import { describe, expect, it } from 'vitest';
import { loadCardPool } from '@jonny-boi/cards';
import type { CardDefinition, ManaColor } from '@jonny-boi/core';
import { compareForUpgrade, castableIn, roleOf, primitivesOf, type CardRole } from './card-role.js';

const pool = loadCardPool({ onWarn: () => {} });

function card(name: string): CardDefinition {
  const found = pool.getByName(name);
  if (!found) throw new Error(`no pool card named "${name}"`);
  return found;
}

const colors = (...cs: ManaColor[]): ReadonlySet<ManaColor> => new Set(cs);

describe('roleOf — a card names its own job', () => {
  const cases: readonly (readonly [string, CardRole])[] = [
    ['Murder', 'removal'], // destroyTarget
    ['Doom Blade', 'removal'],
    ['Lightning Strike', 'damage'], // dealDamage can go at a face, so it is its own job
    ['Cancel', 'counterspell'],
    ['Divination', 'draw'],
    ['Giant Growth', 'pump'],
    ['Forest', 'land'],
    ['Grizzly Bears', 'threat'], // a body and nothing else
  ];
  for (const [name, role] of cases) {
    it(`${name} is ${role}`, () => {
      expect(roleOf(card(name))).toBe(role);
    });
  }

  it('reads a creature’s ENTERS trigger, not just its spell effects', () => {
    // Elvish Visionary has no spell effects at all; its draw is a trigger.
    expect(primitivesOf(card('Elvish Visionary'))).toContain('drawCards');
    expect(roleOf(card('Elvish Visionary'))).toBe('draw');
  });

  it('a mana creature is ramp even with no effects — it taps, it does not "do"', () => {
    // Llanowar Elves compiles to no effects; what makes it ramp is `produces`.
    expect(primitivesOf(card('Llanowar Elves'))).toEqual([]);
    expect(roleOf(card('Llanowar Elves'))).toBe('ramp');
  });

  it('a library search is "dig" — the primitive cannot tell a land fetch from a tutor', () => {
    // Honest coarseness, documented: Rampant Growth and a creature tutor compile
    // to the same `searchLibrary`, so the classifier does not pretend to know.
    expect(roleOf(card('Rampant Growth'))).toBe('dig');
  });
});

describe('compareForUpgrade — the no-brainer test', () => {
  it('Lightning Bolt over Lightning Strike: identical effect, one mana instead of two', () => {
    const verdict = compareForUpgrade(card('Lightning Strike'), card('Lightning Bolt'), colors('R'));
    expect(verdict.sameRole).toBe(true);
    expect(verdict.strictUpgrade, '3 damage either way, and Bolt costs {R}').toBe(true);
  });

  it('is NOT symmetric — the more expensive card is never the upgrade', () => {
    expect(compareForUpgrade(card('Lightning Bolt'), card('Lightning Strike'), colors('R')).strictUpgrade).toBe(
      false,
    );
  });

  it('a SMALLER effect is not an upgrade, however much cheaper — Shock is not Lightning Strike', () => {
    // Both are `dealDamage`; comparing primitive names alone would call the
    // cheaper one free. Shock deals 2 where Strike deals 3.
    const verdict = compareForUpgrade(card('Lightning Strike'), card('Shock'), colors('R'));
    expect(verdict.sameRole, 'same job — both are damage').toBe(true);
    expect(verdict.strictUpgrade, '2 damage for 3 is a trade-off, not a no-brainer').toBe(false);
  });

  it('an added RESTRICTION is not an upgrade — Doom Blade cannot kill black creatures', () => {
    // Doom Blade is cheaper than Murder and also destroyTarget, but it carries
    // `notColor: 'B'`. A parameter the candidate ADDS is a restriction we cannot
    // prove is harmless, so it is not a no-brainer.
    const verdict = compareForUpgrade(card('Murder'), card('Doom Blade'), colors('B'));
    expect(verdict.sameRole).toBe(true);
    expect(verdict.strictUpgrade, 'cheaper, but conditional').toBe(false);
  });

  it('refuses a card the deck cannot cast, however good it is', () => {
    // Naturalize also destroys, and is cheaper than Murder — but it is GREEN.
    expect(castableIn(card('Naturalize'), colors('B')), 'green pips, mono-black deck').toBe(false);
    expect(compareForUpgrade(card('Lightning Strike'), card('Lightning Bolt'), colors('W')).strictUpgrade, 'a red card is no upgrade to a deck with no red').toBe(false);
  });

  it('refuses a different job — a burn spell does not "upgrade" a counterspell', () => {
    const verdict = compareForUpgrade(card('Cancel'), card('Lightning Strike'), colors('U', 'R'));
    expect(verdict.sameRole).toBe(false);
    expect(verdict.strictUpgrade).toBe(false);
  });

  it('refuses a candidate that does LESS, even when it is cheaper', () => {
    // Elvish Visionary draws AND leaves a body; a hypothetical cheaper card that
    // only drew would still have to do everything the cut card does. Divination
    // draws but is not a creature, and costs more — not an upgrade either way.
    expect(compareForUpgrade(card('Elvish Visionary'), card('Divination'), colors('G', 'U')).strictUpgrade).toBe(
      false,
    );
  });

  it('same cost with a strictly bigger body IS an upgrade', () => {
    // Savannah Lions (2/1 for W) over a hypothetical 1/1 for W: same job (a
    // body), same cost, more stats. Grizzly Bears vs Savannah Lions differ in
    // cost, so this uses the pair that isolates the body rule.
    const lions = card('Savannah Lions');
    const weaker: CardDefinition = { ...lions, id: 'test-weakling', name: 'Weakling', power: 1, toughness: 1 };
    expect(compareForUpgrade(weaker, lions, colors('W')).strictUpgrade).toBe(true);
    expect(compareForUpgrade(lions, weaker, colors('W')).strictUpgrade).toBe(false);
  });
});
