/**
 * THE PRINTED TARGET BOUND (DESIGN §3.150) — "target creature **with power 5 or
 * greater**", and the bounds deliberately left REPORTED.
 *
 * This family was found by measuring the MODAL backlog row, and the measurement
 * is the interesting half. The row named 432 cards (531 on a 32,414-card
 * corpus) across 504 distinct shapes — 1.05 clauses per shape, the §3.120
 * aggregation artifact for the fifth time and the thinnest ratio yet. And the
 * row's NAME points at the wrong half harder than any row before it:
 * `modal-blame.mjs` reports **MODE-ONLY = 0**. Core's `modal.ts` and the
 * cast-time mode/target pipeline have no gaps at all. Every card in that row is
 * there because a mode BODY has no rule, or because of its header — never
 * because of modal machinery.
 *
 * The largest concentrated shape inside those bodies was a bound on a target
 * selector, so that is what this implements — and it is implemented as the
 * CLASS rather than the instance, because the same bound blocks 175 cards
 * corpus-wide of which only 28 are modal.
 *
 * ⚠️ THE TESTS THAT MATTER MOST HERE ARE THE REFUSALS. The failure mode of a
 * target bound is not a crash: it is a card that quietly targets something its
 * printed text forbids, while `'complete'` says nothing at all about it. Every
 * bound this lane could not implement faithfully has a card pinned below with
 * the reason.
 */

import { describe, expect, it } from 'vitest';
import type { CardDefinition, GameState } from '@jonny-boi/core';
import {
  boundOf,
  baseRestrictionOf,
  createGame,
  describeRestriction,
  isLegalTarget,
  legalTargetsFor,
  restrictionOfEffects,
} from '@jonny-boi/core';
import { compileCard } from './compile.js';
import { stripTargetBound, applyTargetBound } from './rules.js';
import type { CompilableCard } from './types.js';
import cardIndex from '../../../data-tools/data/card-index.json' with { type: 'json' };

function card(overrides: Partial<CompilableCard> & { name: string; oracleText: string }): CompilableCard {
  return {
    id: `id:${overrides.name}`,
    manaCost: { generic: 1, W: 0, U: 0, B: 0, R: 0, G: 0, C: 0, other: [] },
    typeLine: { supertypes: [], types: ['Instant'], subtypes: [] },
    power: null,
    toughness: null,
    keywords: [],
    ...overrides,
  } as CompilableCard;
}

const compiled = (name: string, oracleText: string, rest: Partial<CompilableCard> = {}) =>
  compileCard(card({ name, oracleText, ...rest }));

/** The spec a compiled spell declares, unwrapped. */
function specOf(def: CardDefinition) {
  return restrictionOfEffects(def.effects ?? []);
}

describe('§3.150 — the printed bound compiles onto the restriction', () => {
  it('Selesnya Charm compiles — the acceptance card, and a mode was all that blocked it', () => {
    const result = compiled(
      'Selesnya Charm',
      'Choose one —\n• Target creature gets +2/+2 and gains trample until end of turn.\n• Exile target creature with power 5 or greater.\n• Create a 2/2 white Knight creature token with vigilance.',
    );
    expect(result.status).toBe('complete');
    const modes = result.definition?.modal?.modes ?? [];
    expect(modes).toHaveLength(3);
    // The middle mode is the one that used to refuse, and it must carry the
    // BOUND — not merely "a creature", which would exile any creature at all.
    const exileMode = modes[1];
    expect(boundOf(exileMode!.targets!)).toEqual({ atLeast: { property: 'power', value: 5 } });
    expect(baseRestrictionOf(exileMode!.targets!)).toBe('creature');
  });

  it.each([
    ['power 5 or greater', 'Exile target creature with power 5 or greater.', { atLeast: { property: 'power', value: 5 } }],
    ['power 2 or less', 'Destroy target creature with power 2 or less.', { atMost: { property: 'power', value: 2 } }],
    ['toughness 4 or greater', 'Destroy target creature with toughness 4 or greater.', { atLeast: { property: 'toughness', value: 4 } }],
    ['with flying', 'Destroy target creature with flying.', { withKeyword: 'flying' }],
    ['without flying', 'Destroy target creature without flying.', { withoutKeyword: 'flying' }],
    ['with defender', 'Destroy target creature with defender.', { withKeyword: 'defender' }],
  ])('reads "%s" onto the declared restriction', (_label, text, bound) => {
    const result = compiled('Probe', text);
    expect(result.status).toBe('complete');
    expect(boundOf(specOf(result.definition!)!)).toEqual(bound);
  });

  it('reads the pre-2021 "converted mana cost" spelling as the same number', () => {
    const modern = compiled('Modern', 'Counter target spell with mana value 4 or greater.');
    const legacy = compiled('Legacy', 'Counter target spell with converted mana cost 4 or greater.');
    expect(modern.status).toBe('complete');
    expect(legacy.status).toBe('complete');
    // ONE spelling matched and the other left reporting is how a rule looks
    // shipped while half its printings sit in the backlog.
    expect(boundOf(specOf(legacy.definition!)!)).toEqual(boundOf(specOf(modern.definition!)!));
  });

  it('reads the COLOUR form, which sits before the noun rather than after it', () => {
    const result = compiled('Red Elemental Blast', 'Destroy target blue permanent.');
    expect(result.status).toBe('complete');
    expect(boundOf(specOf(result.definition!)!)).toEqual({ colour: 'U' });
  });

  it('gives EVERY verb the vocabulary — the point of a pre-pass over a rule per verb', () => {
    // destroy / exile / bounce / burn / counter all reach the same tables. A
    // rule per verb would have needed five copies of the noun list, and the
    // sixth verb would still refuse.
    for (const text of [
      'Destroy target creature with flying.',
      'Exile target creature with flying.',
      'Return target creature with flying to its owner’s hand.',
      'Probe deals 3 damage to target creature with flying.',
    ]) {
      expect(compiled('Probe', text).status, text).toBe('complete');
    }
  });
});


function creatureDef(
  id: string,
  power: number,
  toughness: number,
  keywords: Partial<Record<string, boolean>> = {},
  colors: readonly string[] = ['G'],
): CardDefinition {
  return {
    id,
    name: id,
    types: ['creature'],
    subtypes: [],
    power,
    toughness,
    colors,
    cost: { generic: 1 },
    keywords,
  } as unknown as CardDefinition;
}

function putOnBattlefield(state: GameState, controller: 'A' | 'B', def: CardDefinition): string {
  const instanceId = String(state.nextInstanceId++);
  state.battlefield.push({
    instanceId,
    def,
    controller,
    owner: controller,
    zone: 'battlefield',
    tapped: false,
    summoningSick: false,
    damageMarked: 0,
    markedByDeathtouch: false,
    counters: {},
  } as never);
  return instanceId;
}

/** A board with a 5/5 flier and a 1/1 ground creature — the two sides of every bound below. */
function boardWithBigAndSmall(): { state: GameState; big: string; small: string } {
  const filler = creatureDef('filler', 1, 1);
  const { state } = createGame({
    seed: 7,
    decks: {
      A: { cards: Array.from({ length: 40 }, () => filler) },
      B: { cards: Array.from({ length: 40 }, () => filler) },
    },
  });
  const big = putOnBattlefield(state, 'A', creatureDef('big', 5, 5, { flying: true }));
  const small = putOnBattlefield(state, 'A', creatureDef('small', 1, 1));
  return { state, big, small };
}

describe('§3.150 — the bound is ENFORCED, not merely recorded', () => {
  it('the OFFER and the ACCEPT name the same set — a bound enforced on only one is a cheat', () => {
    const { state, big, small } = boardWithBigAndSmall();
    const spell = compiled('Probe', 'Exile target creature with power 5 or greater.').definition!;
    const spec = specOf(spell)!;
    // The DISCRIMINATOR: without the bound this list is BOTH creatures, which is
    // exactly the strictly-better card the whole family exists to prevent.
    expect([...legalTargetsFor(state, spec, 'A', spell)]).toEqual([big]);
    // The menu and the legality check must agree (DESIGN §3.36): the small
    // creature is off BOTH, not merely off the menu.
    expect(isLegalTarget(state, spec, big, 'A', spell)).toBe(true);
    expect(isLegalTarget(state, spec, small, 'A', spell)).toBe(false);
  });

  it('an at-MOST bound points the other way — the direction is not decoration', () => {
    const { state, big, small } = boardWithBigAndSmall();
    const spell = compiled('Probe', 'Destroy target creature with power 2 or less.').definition!;
    const spec = specOf(spell)!;
    expect([...legalTargetsFor(state, spec, 'A', spell)]).toEqual([small]);
  });

  it('a keyword bound reads the permanent, and its negation excludes the same card', () => {
    const { state, big, small } = boardWithBigAndSmall();
    const withFlying = specOf(compiled('P', 'Destroy target creature with flying.').definition!)!;
    const withoutFlying = specOf(compiled('P', 'Destroy target creature without flying.').definition!)!;
    expect([...legalTargetsFor(state, withFlying, 'A', undefined)]).toEqual([big]);
    expect([...legalTargetsFor(state, withoutFlying, 'A', undefined)]).toEqual([small]);
  });

  it('a bound refuses a PLAYER — every bound this table expresses is a property of a permanent', () => {
    const { state } = boardWithBigAndSmall();
    const spell = compiled('Probe', 'Destroy target creature with flying.').definition!;
    expect(isLegalTarget(state, specOf(spell)!, 'A', 'A', spell)).toBe(false);
  });

  it('describes the WHOLE printed selector, noun and bound', () => {
    const spell = compiled('Probe', 'Exile target creature with power 5 or greater.').definition!;
    expect(describeRestriction(specOf(spell)!)).toContain('power 5 or greater');
  });
});

/**
 * THE OFFER/ACCEPT AGREEMENT UNDER A CONTINUOUS EFFECT — the bug this file's
 * first draft could not see.
 *
 * `legalTargetsFor` builds a continuous index for the whole menu and passes it
 * down; `isLegalTarget` passes nothing. While `targetMeetsBound` defaulted a
 * missing index to "no modifications", those two read DIFFERENT power: the menu
 * offered a pumped 2/2 for "power 5 or greater" and the cast was then refused.
 *
 * Every test above ran on a board with no continuous effect at all, so all of
 * them passed while the disagreement was live. That is a check that cannot
 * fail, and this is the discriminator it was missing.
 */
describe('§3.150 — a bound reads LAYERED stats, and both readers agree', () => {
  it('a pumped creature is legal to BOTH the menu and the legality check', () => {
    const { state, small } = boardWithBigAndSmall();
    // +4/+4 until end of turn: the 1/1 becomes a 5/5 and enters the bound.
    state.continuous.push({
      id: 1,
      targetInstanceId: small,
      sourceInstanceId: 0,
      duration: 'endOfTurn',
      power: 4,
      toughness: 4,
    } as never);
    const spell = compiled('Probe', 'Exile target creature with power 5 or greater.').definition!;
    const spec = specOf(spell)!;
    // THE DISCRIMINATOR: without the layered read this is `false` while the
    // menu below still lists it — offer and accept disagreeing (DESIGN §3.36).
    expect(isLegalTarget(state, spec, small, 'A', spell)).toBe(true);
    expect([...legalTargetsFor(state, spec, 'A', spell)]).toContain(small);
  });

  it('a SHRUNK creature leaves the bound for both readers too', () => {
    const { state, big } = boardWithBigAndSmall();
    // -3/-0: the 5/5 becomes a 2/5 and falls out of "power 5 or greater".
    state.continuous.push({
      id: 1,
      targetInstanceId: big,
      sourceInstanceId: 0,
      duration: 'endOfTurn',
      power: -3,
      toughness: 0,
    } as never);
    const spell = compiled('Probe', 'Exile target creature with power 5 or greater.').definition!;
    const spec = specOf(spell)!;
    expect(isLegalTarget(state, spec, big, 'A', spell)).toBe(false);
    expect([...legalTargetsFor(state, spec, 'A', spell)]).not.toContain(big);
  });
});

describe('§3.150 — the closed tables REFUSE rather than widen', () => {
  it.each([
    ['a keyword the engine does not model', 'Destroy target creature with shadow.'],
    ['a keyword the engine does not model', 'Destroy target creature with horsemanship.'],
    ['a keyword the engine does not model', 'Destroy target creature with fear.'],
  ])('refuses %s: %s', (_why, text) => {
    // The direction matters: widening "with shadow" to "any creature" is a
    // STRICTLY BETTER card, and one of those in the pool biases every A/B
    // verdict the lab produces. Reporting is the correct outcome.
    expect(compiled('Probe', text).status).not.toBe('complete');
  });

  it('refuses a clause carrying TWO bounded selectors — there is no single restriction to narrow', () => {
    expect(stripTargetBound('target creature with flying fights target creature with trample')).toBeNull();
  });

  it('refuses when the compiled clause declares no single restriction to narrow', () => {
    // A bound attached to a guess is the failure this returns null to prevent.
    expect(applyTargetBound([], { withKeyword: 'flying' })).toBeNull();
    expect(
      applyTargetBound(
        [
          { primitive: 'destroyTarget', params: { targets: 'creature' } },
          { primitive: 'destroyTarget', params: { targets: 'artifact' } },
        ],
        { withKeyword: 'flying' },
      ),
    ).toBeNull();
  });

  it('does NOT narrow a GROUP selector — a different consumer, with a different filter', () => {
    // "destroy each creature with mana value 3 or less" has no target at all.
    // Narrowing it through the targeting seam would police something that does
    // not exist and leave the group unfiltered — wider than printed, in the
    // half nobody looks at.
    expect(stripTargetBound('destroy each creature with mana value 3 or less')).toBeNull();
    expect(compiled('Ritual of Soot', 'Destroy each creature with mana value 3 or less.').status).not.toBe(
      'complete',
    );
  });
});

/**
 * THE DEAD-RULE GUARD for this family (rule 10 — ship the guard with the fix).
 *
 * The pre-pass is not a row in `EFFECT_RULES`, so `rule-coverage.test.ts` and
 * `dead-rule-sweep.mjs` cannot see it: both quantify over the rule table. A
 * bound table written from a REMEMBERED wording would match no real card and
 * nothing in the suite could tell — the §3.57 defect those two guards exist for.
 *
 * ⚠️ AND THE OBVIOUS SOURCE DOES NOT WORK, which is worth writing down because
 * the first draft of this file used it and passed vacuously. `card-index.json`
 * is the SHIPPED POOL — the cards that already compiled — so it contains ZERO
 * cards printing four of these five families, by construction. A guard sourced
 * from it can never see a NEW family and would go green while proving nothing.
 *
 * So each line below is transcribed VERBATIM from the Scryfall oracle corpus
 * (32,414 cards, fetched 2026-09-15) together with the card that prints it, and
 * the corpus-wide guard is the set diff in the lane report (+175 gained, 0 lost)
 * plus `modal-blame.mjs`. The one family the shipped pool CAN attest is checked
 * against the live index below, so at least one arm of this guard moves when the
 * pool does.
 */
describe('§3.150 — every bound family fires on text a REAL card prints', () => {
  it.each([
    ['P/T, at least', 'Stand Up for Yourself', 'Destroy target creature with power 3 or greater.'],
    ['P/T, at most', 'Escape Tunnel', "{T}, Sacrifice this land: Target creature with power 2 or less can't be blocked this turn."],
    ['keyword', 'Clear a Path', 'Destroy target creature with defender.'],
    ['keyword, kicked ETB', 'Oran-Rief Recluse', 'When this creature enters, if it was kicked, destroy target creature with flying.'],
    ['negated keyword', 'Jiwari, the Earth Aflame', '{X}{R}, {T}: Jiwari deals X damage to target creature without flying.'],
    ['mana value', 'Baffling End', 'When this enchantment enters, exile target creature an opponent controls with mana value 3 or less.'],
    ['colour', 'Lifeforce', '{G}{G}: Counter target black spell.'],
  ])('%s — %s', (_family, _name, printedLine) => {
    expect(stripTargetBound(printedLine.toLowerCase())).not.toBeNull();
  });

  it('the mana-value family is attested by the SHIPPED pool index, not only by the corpus', () => {
    interface IndexedCard {
      readonly name: string;
      readonly oracleText: string;
    }
    const pool = (cardIndex as { cards: readonly IndexedCard[] }).cards;
    const shape = /target [a-z ]*with mana value \d+ or (?:less|greater)/i;
    const hits = pool.filter((c) => shape.test(c.oracleText ?? ''));
    expect(hits.length).toBeGreaterThan(0);
    const clause = (hits[0]!.oracleText ?? '').split('\n').find((line) => shape.test(line))!;
    expect(stripTargetBound(clause.toLowerCase()), `${hits[0]!.name}: ${clause}`).not.toBeNull();
  });
});
