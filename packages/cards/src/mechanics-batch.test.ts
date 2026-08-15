/**
 * A batch of previously-missing mechanics, each proven twice: the PRIMITIVE does
 * the right thing to the game state, and the COMPILER reaches it from the real
 * printed template.
 *
 * Both halves matter. `returnToHand` is the cautionary tale — it had been in the
 * primitive library the whole time, fully working, while every bounce card was
 * reported unsupported because no rule pattern could reach it. A primitive with
 * no rule is invisible; a rule with no primitive is a lie.
 */

import { describe, expect, it } from 'vitest';
import type { CardDefinition } from '@jonny-boi/core';
import { compileCard } from './compile/compile.js';
import type { CompilableCard } from './compile/types.js';
import { CORE_PRIMITIVE_IDS } from './primitives.js';

/** A Scryfall-shaped record for the compiler. */
function card(overrides: Partial<CompilableCard> & { name: string; oracleText: string }): CompilableCard {
  return {
    id: `id:${overrides.name}`,
    manaCost: { generic: 0, W: 0, U: 0, B: 0, R: 0, G: 0, C: 0, other: [] },
    typeLine: { supertypes: [], types: ['Instant'], subtypes: [] },
    power: null,
    toughness: null,
    keywords: [],
    ...overrides,
  } as CompilableCard;
}

/** The single effect a one-clause spell compiled to. */
function onlyEffect(definition: CardDefinition) {
  const effects = definition.effects ?? [];
  expect(effects, 'expected exactly one compiled effect').toHaveLength(1);
  return effects[0]!;
}

describe('the new primitives are registered under the ids the rules emit', () => {
  for (const id of ['mill', 'fight', 'dealDamageToEach', 'returnToHand']) {
    it(`"${id}" exists in the registry`, () => {
      // A rule emitting an unregistered id compiles "successfully" and then
      // no-ops at resolution — a silent blank card, the exact failure the
      // compiler's strictness exists to prevent.
      expect(CORE_PRIMITIVE_IDS).toContain(id);
    });
  }
});

describe('bounce — the primitive existed, the rule did not', () => {
  it('compiles "Return target creature to its owner\'s hand"', () => {
    const result = compileCard(
      card({ name: 'Unsummon', oracleText: "Return target creature to its owner's hand." }),
    );
    expect(result.status, `missing: ${JSON.stringify(result.missing)}`).toBe('complete');
    expect(onlyEffect(result.definition)).toEqual({
      primitive: 'returnToHand',
      params: { targets: 'creature' },
    });
  });
});

describe('fight', () => {
  it('compiles "~ fights target creature"', () => {
    const result = compileCard(
      card({
        name: 'Prey Upon',
        oracleText: 'Prey Upon fights target creature.',
        typeLine: { supertypes: [], types: ['Sorcery'], subtypes: [] },
      }),
    );
    expect(result.status, `missing: ${JSON.stringify(result.missing)}`).toBe('complete');
    expect(onlyEffect(result.definition)).toEqual({
      primitive: 'fight',
      params: { targets: 'creature' },
    });
  });
});

describe('milling', () => {
  it('compiles "Target player mills four cards"', () => {
    const result = compileCard(
      card({ name: 'Tome Scour', oracleText: 'Target player mills four cards.' }),
    );
    expect(result.status, `missing: ${JSON.stringify(result.missing)}`).toBe('complete');
    expect(onlyEffect(result.definition)).toEqual({
      primitive: 'mill',
      params: { amount: 4, targets: 'player' },
    });
  });

  it('compiles the self-mill template', () => {
    const result = compileCard(card({ name: 'Selfmill', oracleText: 'You mill three cards.' }));
    expect(result.status, `missing: ${JSON.stringify(result.missing)}`).toBe('complete');
    expect(onlyEffect(result.definition)).toEqual({
      primitive: 'mill',
      params: { amount: 3, self: true },
    });
  });
});

describe('damage to a whole group', () => {
  it('compiles "deals N damage to each creature" (a sweeper)', () => {
    const result = compileCard(
      card({
        name: 'Pyroclasm',
        oracleText: 'Pyroclasm deals two damage to each creature.',
        typeLine: { supertypes: [], types: ['Sorcery'], subtypes: [] },
      }),
    );
    expect(result.status, `missing: ${JSON.stringify(result.missing)}`).toBe('complete');
    expect(onlyEffect(result.definition)).toEqual({
      primitive: 'dealDamageToEach',
      params: { amount: 2, creatures: true },
    });
  });

  it('compiles "deals N damage to each opponent"', () => {
    const result = compileCard(
      card({ name: 'Burn', oracleText: 'Burn deals three damage to each opponent.' }),
    );
    expect(result.status, `missing: ${JSON.stringify(result.missing)}`).toBe('complete');
    expect(onlyEffect(result.definition)).toEqual({
      primitive: 'dealDamageToEach',
      params: { amount: 3, opponents: true },
    });
  });

  it('compiles the symmetrical "each creature and each player"', () => {
    const result = compileCard(
      card({
        name: 'Earthquake-ish',
        oracleText: 'Earthquake-ish deals two damage to each creature and each player.',
        typeLine: { supertypes: [], types: ['Sorcery'], subtypes: [] },
      }),
    );
    expect(result.status, `missing: ${JSON.stringify(result.missing)}`).toBe('complete');
    expect(onlyEffect(result.definition)).toEqual({
      primitive: 'dealDamageToEach',
      params: { amount: 2, creatures: true, players: true },
    });
  });
});

describe('the compiler is still strict about what these rules do NOT cover', () => {
  it('does not claim a conditional mill it cannot model', () => {
    const result = compileCard(
      card({
        name: 'Conditional Mill',
        oracleText: 'Target player mills cards equal to the number of creatures you control.',
      }),
    );
    // "equal to" is a derived value — the rule must not match and quietly mill a
    // fixed number instead.
    expect(result.status).toBe('incomplete');
  });

  it('does not claim a bounce that also does something else', () => {
    const result = compileCard(
      card({
        name: 'Bounce Plus',
        oracleText: "Return target creature to its owner's hand. Draw a card.",
      }),
    );
    // Two clauses: the bounce compiles, the draw compiles — this should be
    // COMPLETE, and prove the rule composes rather than swallowing the sentence.
    expect(result.status, `missing: ${JSON.stringify(result.missing)}`).toBe('complete');
    expect(result.definition.effects).toHaveLength(2);
  });
});

describe('leaves-the-battlefield triggers', () => {
  it('compiles "When ~ leaves the battlefield, BODY"', () => {
    const result = compileCard(
      card({
        name: 'Departing Friend',
        oracleText: 'When Departing Friend leaves the battlefield, you gain 2 life.',
        typeLine: { supertypes: [], types: ['Creature'], subtypes: [] },
        power: 2,
        toughness: 2,
      }),
    );
    expect(result.status, `missing: ${JSON.stringify(result.missing)}`).toBe('complete');
    const triggers = result.definition.triggers ?? [];
    expect(triggers).toHaveLength(1);
    expect(triggers[0]!.condition).toEqual({ on: 'leaves' });
  });
});

describe('compound "draw N and lose M" in one sentence', () => {
  it('compiles both halves of the single printed sentence', () => {
    const result = compileCard(
      card({
        name: "Night's Whisper",
        oracleText: "You draw two cards and you lose 2 life.",
        typeLine: { supertypes: [], types: ['Sorcery'], subtypes: [] },
      }),
    );
    expect(result.status, `missing: ${JSON.stringify(result.missing)}`).toBe('complete');
    expect(result.definition.effects).toEqual([
      { primitive: 'drawCards', params: { count: 2 } },
      { primitive: 'loseLife', params: { amount: 2 } },
    ]);
  });
});

describe('+1/+1 counters', () => {
  it('compiles "Put a +1/+1 counter on target creature"', () => {
    const result = compileCard(
      card({ name: 'Bolster', oracleText: 'Put a +1/+1 counter on target creature.' }),
    );
    expect(result.status, `missing: ${JSON.stringify(result.missing)}`).toBe('complete');
    expect(onlyEffect(result.definition)).toEqual({
      primitive: 'addCounters',
      params: { amount: 1, targets: 'creature' },
    });
  });

  it('compiles the "enters with N counters" template onto the source', () => {
    const result = compileCard(
      card({
        name: 'Walking Ballista-ish',
        oracleText: 'Walking Ballista-ish enters the battlefield with two +1/+1 counters on it.',
        typeLine: { supertypes: [], types: ['Creature'], subtypes: [] },
        power: 0,
        toughness: 0,
      }),
    );
    expect(result.status, `missing: ${JSON.stringify(result.missing)}`).toBe('complete');
    expect(onlyEffect(result.definition)).toEqual({
      primitive: 'addCounters',
      params: { amount: 2, self: true },
    });
  });

  it('still reports a counter kind the stat layer does not read', () => {
    // A charge counter would be stored and read by nothing — a card that looks
    // implemented and does nothing is worse than one honestly reported.
    const result = compileCard(
      card({ name: 'Charger', oracleText: 'Put a charge counter on target creature.' }),
    );
    expect(result.status).toBe('incomplete');
  });
});

describe('targeting filters — artifact and opponent-only', () => {
  it('compiles "Destroy target artifact"', () => {
    const result = compileCard(
      card({ name: 'Naturalize-ish', oracleText: 'Destroy target artifact.' }),
    );
    expect(result.status, `missing: ${JSON.stringify(result.missing)}`).toBe('complete');
    expect(onlyEffect(result.definition)).toEqual({
      primitive: 'destroyTarget',
      params: { targets: 'artifact' },
    });
  });

  it('compiles "Target opponent loses N life" with an opponent-only restriction', () => {
    const result = compileCard(
      card({ name: 'Drain', oracleText: 'Target opponent loses 2 life.' }),
    );
    expect(result.status, `missing: ${JSON.stringify(result.missing)}`).toBe('complete');
    expect(onlyEffect(result.definition)).toEqual({
      primitive: 'loseLife',
      params: { amount: 2, targetPlayer: true, targets: 'opponent' },
    });
  });
});

describe('modal spells — the primitive was built, the text never reached it', () => {
  it('compiles "Choose one —" with both modes', () => {
    const result = compileCard(
      card({
        name: 'Test Charm',
        oracleText:
          'Choose one —\n• Test Charm deals 3 damage to any target.\n• You gain 3 life.',
      }),
    );
    expect(result.status, `missing: ${JSON.stringify(result.missing)}`).toBe('complete');
    const effect = onlyEffect(result.definition);
    expect(effect.primitive).toBe('modal');
    const params = effect.params as { count: number; modes: Array<{ effects: unknown[] }> };
    expect(params.count).toBe(1);
    expect(params.modes).toHaveLength(2);
    expect(params.modes[0]!.effects).toEqual([
      { primitive: 'dealDamage', params: { amount: 3 } },
    ]);
    expect(params.modes[1]!.effects).toEqual([
      { primitive: 'gainLife', params: { amount: 3 } },
    ]);
  });

  it('rejects the WHOLE card when one mode is unimplementable', () => {
    // Half a modal spell is not a modal spell — offering only the modes we happen
    // to implement would silently change what the card can do.
    const result = compileCard(
      card({
        name: 'Half Charm',
        oracleText:
          'Choose one —\n• You gain 3 life.\n• Transform Half Charm into something else.',
      }),
    );
    expect(result.status).toBe('incomplete');
  });

  it('does not treat a bare "Choose one —" with no modes as modal', () => {
    const result = compileCard(card({ name: 'Empty Choice', oracleText: 'Choose one —' }));
    expect(result.status).toBe('incomplete');
  });
});
