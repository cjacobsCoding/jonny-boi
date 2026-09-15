/**
 * THE {X} / DERIVED-VALUE FAMILY (DESIGN §3.149) — the three printed ways a card
 * spells a variable amount, and the families deliberately left REPORTED.
 *
 * The backlog row named 953 cards. `gap-clauses.mjs` says 880 distinct shapes
 * over 954 cards — 1.08 cards per shape, the §3.120 artifact again — and
 * `xvalue-blame.mjs` says 70% of it is a SENTENCE with no rule, wearing this
 * row's label because its text happens to contain "equal to". What is really
 * here is an AMOUNT vocabulary, and these are its three spellings:
 *
 *   1. `{X}` in an ACTIVATION cost      — Kessig Wolf Run, Sands of Delirium
 *   2. an OBJECT'S CHARACTERISTIC        — Trostani, Angelic Chorus, Marwyn
 *   3. a `where X is …` BINDING          — Chain Reaction, Doorkeeper, Welding Sparks
 *
 * ⚠️ THE TESTS THAT MATTER MOST HERE ARE THE REFUSALS. Every family this lane
 * could not implement faithfully has a card pinned below with the exact reason,
 * because the failure mode of an amount vocabulary is not a crash — it is a
 * card that reads ZERO and plays as a blank while `'complete'` says nothing at
 * all about it.
 */

import { describe, expect, it } from 'vitest';
import type { CardDefinition, GameState } from '@jonny-boi/core';
import { createGame } from '@jonny-boi/core';
import { compileCard } from './compile.js';
import type { CompilableCard } from './types.js';

function card(
  overrides: Partial<CompilableCard> & { name: string; oracleText: string },
): CompilableCard {
  return {
    id: `id:${overrides.name}`,
    manaCost: { generic: 2, W: 0, U: 0, B: 0, R: 0, G: 0, C: 0, other: [] },
    typeLine: { supertypes: [], types: ['Creature'], subtypes: ['Human'] },
    power: 2,
    toughness: 2,
    keywords: [],
    ...overrides,
  } as CompilableCard;
}

/** The blocked clauses of a card, as the coverage tools read them. */
const blockers = (c: CompilableCard): string[] =>
  (compileCard(c).missing ?? []).map((m) => m.text ?? '');

// ===========================================================================
// 1. {X} IN AN ACTIVATION COST — the acceptance card
// ===========================================================================

const KESSIG_WOLF_RUN = card({
  name: 'Kessig Wolf Run',
  typeLine: { supertypes: [], types: ['Land'], subtypes: [] },
  manaCost: { generic: 0, W: 0, U: 0, B: 0, R: 0, G: 0, C: 0, other: [], absent: true },
  power: null,
  toughness: null,
  oracleText:
    '{T}: Add {C}.\n{X}{R}{G}, {T}: Target creature gets +X/+0 and gains trample until end of turn.',
} as never);

describe('Kessig Wolf Run — the acceptance card from the owner\'s deck', () => {
  it('compiles completely', () => {
    const result = compileCard(KESSIG_WOLF_RUN);
    expect(result.status, `missing: ${JSON.stringify(result.missing)}`).toBe('complete');
  });

  it('keeps the X OUT of the base cost and records how many symbols it printed', () => {
    const ability = compileCard(KESSIG_WOLF_RUN).definition.activated![0]!;
    // The whole reason `xCost` is separate: every existing reader of an
    // activation cost — the payability gate, the offer path, `payCost` — stays
    // correct because the base cost is still the base cost.
    expect(ability.cost.mana).toEqual({ R: 1, G: 1 });
    expect(ability.cost.xCost).toBe(1);
    expect(ability.cost.tap).toBe(true);
  });

  it('pumps by the CHOSEN X, never by a fixed number', () => {
    const ability = compileCard(KESSIG_WOLF_RUN).definition.activated![0]!;
    const pump = ability.effects.find((e) => e.primitive === 'pumpUntilEndOfTurn')!;
    // A number here would be a Kessig Wolf Run that pumps the same amount
    // whether you paid {1} or {7} for it.
    expect(pump.params!.power).toEqual({ chosenX: true });
    expect(pump.params!.toughness).toBe(0);
    expect(ability.effects.some((e) => e.primitive === 'grantKeywordUntilEndOfTurn')).toBe(true);
  });

  it('refuses X on a card whose cost prints none — the gate, not a default of zero', () => {
    // The same sentence on an ability with no {X} anywhere. Compiling it would
    // be an ability that always pumps by nothing.
    const noX = card({
      name: 'Probe',
      oracleText: '{R}{G}, {T}: Target creature gets +X/+0 and gains trample until end of turn.',
    });
    expect(blockers(noX)).toHaveLength(1);
  });

  it('reads X the same way on a mill body — one funnel, not a rule per verb', () => {
    const sands = card({
      name: 'Sands of Delirium',
      typeLine: { supertypes: [], types: ['Artifact'], subtypes: [] },
      power: null,
      toughness: null,
      oracleText: '{X}, {T}: Target player mills X cards.',
    } as never);
    const result = compileCard(sands);
    expect(result.status, `missing: ${JSON.stringify(result.missing)}`).toBe('complete');
    const ability = result.definition.activated![0]!;
    expect(ability.cost.xCost).toBe(1);
    // "{X}, {T}" prints NO base mana at all — an empty remainder is a real cost.
    expect(ability.cost.mana).toBeUndefined();
    expect(ability.effects[0]!.params!.amount).toEqual({ chosenX: true });
  });
});

// ===========================================================================
// 2. AN OBJECT'S CHARACTERISTIC — Trostani's half, and the LKI refusals
// ===========================================================================

const TROSTANI_TRIGGER = card({
  name: "Trostani, Selesnya's Voice",
  oracleText:
    "Whenever another creature you control enters, you gain life equal to that creature's toughness.",
});

describe('the triggering object\'s characteristic', () => {
  it("compiles Trostani's trigger and reads the ENTERING creature, not the source", () => {
    const result = compileCard(TROSTANI_TRIGGER);
    expect(result.status, `missing: ${JSON.stringify(result.missing)}`).toBe('complete');
    const trigger = result.definition.triggers![0]!;
    expect(trigger.effects[0]!.params!.amount).toEqual({
      readOf: 'triggering',
      characteristic: 'toughness',
    });
  });

  it('CARRIES THE SUBJECT on the trigger, or the amount would read nothing', () => {
    const trigger = compileCard(TROSTANI_TRIGGER).definition.triggers![0]!;
    // `triggeringInstances` is opt-in (`carriesSubject`). Without it the
    // resolution never learns which creature entered and the descriptor reads
    // zero — a Trostani that gains no life, with every test still green.
    expect((trigger.condition as { carriesSubject?: boolean }).carriesSubject).toBe(true);
  });

  it('resolves the bare word "its" on an ENTERS trigger, where the referent is printed', () => {
    const chorus = card({
      name: 'Angelic Chorus',
      typeLine: { supertypes: [], types: ['Enchantment'], subtypes: [] },
      power: null,
      toughness: null,
      oracleText: 'Whenever a creature you control enters, you gain life equal to its toughness.',
    } as never);
    const result = compileCard(chorus);
    expect(result.status, `missing: ${JSON.stringify(result.missing)}`).toBe('complete');
    expect(result.definition.triggers![0]!.effects[0]!.params!.amount).toEqual({
      readOf: 'triggering',
      characteristic: 'toughness',
    });
  });

  it("reads ~'s own power on an activated ability, where the source is on the battlefield", () => {
    const spikeshot = card({
      name: 'Spikeshot Goblin',
      oracleText: '{R}, {T}: ~ deals damage equal to its power to any target.',
    });
    const result = compileCard(spikeshot);
    expect(result.status, `missing: ${JSON.stringify(result.missing)}`).toBe('complete');
    expect(result.definition.activated![0]!.effects[0]!.params!.amount).toEqual({
      readOf: 'source',
      characteristic: 'power',
    });
  });

  it('resolves "its" on a SELF trigger too — the third provable seam', () => {
    // Gregor, Shrewd Magistrate. The trigger names `~` and nothing else, and `~`
    // is on the battlefield (it just dealt combat damage). Before this seam the
    // `object-characteristic-draw` rule matched no card in a 32,341-card corpus —
    // `dead-rule-sweep.mjs` is what said so.
    const gregor = card({
      name: 'Gregor, Shrewd Magistrate',
      oracleText: 'Whenever ~ deals combat damage to a player, draw cards equal to its power.',
    });
    const result = compileCard(gregor);
    expect(result.status, `missing: ${JSON.stringify(result.missing)}`).toBe('complete');
    expect(result.definition.triggers![0]!.effects[0]!.params!.count).toEqual({
      readOf: 'source',
      characteristic: 'power',
    });
  });

  // --- the refusals, each with its reason -----------------------------------

  it('REFUSES a DIES trigger reading the dead creature — CR 608.2h, no LKI store', () => {
    // Bottle Golems / Conclave Mentor. The permanent is in the graveyard when
    // the ability resolves, so its power is last-known information and this
    // engine keeps no snapshot of it. Compiling this would gain 0 life, always.
    const dies = card({
      name: 'Bottle Golems',
      oracleText: 'When ~ dies, you gain life equal to its power.',
    });
    expect(blockers(dies)).toEqual(['When ~ dies, you gain life equal to its power.']);
  });

  it('REFUSES "that creature\'s toughness" on a death, even spelled out', () => {
    // Proper Burial. The "its"-guard is one lock; this is the second — a body
    // that names the subject explicitly must not slip past on a dies-trigger.
    const burial = card({
      name: 'Proper Burial',
      typeLine: { supertypes: [], types: ['Enchantment'], subtypes: [] },
      power: null,
      toughness: null,
      oracleText:
        "Whenever a creature you control dies, you gain life equal to that creature's toughness.",
    } as never);
    expect(blockers(burial)).toHaveLength(1);
  });

  it('REFUSES a body that names a SECOND object — "its" would be a coin flip', () => {
    // "Target creature you control deals damage equal to ITS power to target
    // creature an opponent controls": "its" is the FIRST target, not the source.
    // The rewrite guard sees the word "target" and declines.
    const twoObjects = card({
      name: 'Rabid Bite',
      typeLine: { supertypes: [], types: ['Sorcery'], subtypes: [] },
      power: null,
      toughness: null,
      oracleText:
        "Target creature you control deals damage equal to its power to target creature you don't control.",
    } as never);
    expect(blockers(twoObjects)).toHaveLength(1);
  });
});

// ===========================================================================
// 2b. THE RESIDUE ON THE OWNER'S OWN CARD — named, not hand-waved
// ===========================================================================

describe('Trostani, Selesnya\'s Voice — what is left, exactly', () => {
  /**
   * The whole printed card. Its {X}/derived-value half is DONE — the trigger
   * above compiles — and the card still does not, for a reason that belongs to
   * a different family. Pinned here so the next contributor reads the blocker
   * instead of re-deriving it, and so this test goes RED the day populate lands
   * (which is the moment this card should enter the pool).
   */
  const TROSTANI = card({
    name: "Trostani, Selesnya's Voice",
    typeLine: { supertypes: ['Legendary'], types: ['Creature'], subtypes: ['Dryad'] },
    manaCost: { generic: 0, W: 2, U: 0, B: 0, R: 0, G: 2, C: 0, other: [] },
    power: 2,
    toughness: 5,
    oracleText:
      "Whenever another creature you control enters, you gain life equal to that creature's toughness.\n" +
      "{1}{G}{W}, {T}: Populate. (Create a token that's a copy of a creature token you control.)",
  } as never);

  /**
   * ⚠️ **THE TRIPWIRE FIRED, AS IT WAS WRITTEN TO.** This assertion used to read
   * "has exactly ONE blocker left, and it is POPULATE", and its own note said it
   * would go red *"the day populate lands (which is the moment this card should
   * enter the pool)"*. That day is the copy-selector lane: populate is now a
   * resolution-time CHOICE selector on `createTokenCopy` (`populateSourceFor`),
   * so the residue this described is gone.
   *
   * The test is KEPT rather than deleted, pointed at the same card, because what
   * it is really for is that Trostani — the owner's own card, from
   * `docs/decks/acidic-angels.txt` — is pinned by name from the lane that made
   * its {X} half work. The claim it makes now is the stronger one: nothing is
   * left at all. Its sibling below, which proves the amount half compiles on its
   * own, is untouched and is still this lane's discriminator.
   */
  it('has NO blockers left — the {X} half and populate are both in', () => {
    const result = compileCard(TROSTANI);
    expect(result.missing ?? [], JSON.stringify(result.missing)).toEqual([]);
    expect(result.status).toBe('complete');
    // The populate is the ACTIVATED ability's body and it aims at NOTHING —
    // populate says "choose", not "target", so the ability goes on the stack
    // with nothing to aim and a hexproof token is a legal populate.
    const ability = result.definition.activated?.[0];
    expect(ability?.effects[0]?.primitive).toBe('createTokenCopy');
    expect(ability?.effects[0]?.params?.chooseCreatureTokenYouControl).toBe(true);
    expect(ability?.effects[0]?.params?.targets).toBeUndefined();
  });

  it('and the amount half of it is genuinely done', () => {
    // The discriminator for the claim above: the SAME card with the populate
    // line removed compiles completely.
    const triggerOnly = card({
      name: "Trostani, Selesnya's Voice",
      oracleText:
        "Whenever another creature you control enters, you gain life equal to that creature's toughness.",
    });
    expect(compileCard(triggerOnly).status).toBe('complete');
  });
});

// ===========================================================================
// 3. THE "where X is …" BINDING — one pre-pass, not a rule per body
// ===========================================================================

describe('the "where X is …" binding', () => {
  it('binds X for a body that was ALREADY WRITTEN as a plain-number rule', () => {
    // Chain Reaction. `damage-to-each-creature` has existed all along; the only
    // thing missing was a value for the word X. That is the finding: §3.147
    // measured 74 distinct BODIES and the bodies were the wrong unit.
    const chain = card({
      name: 'Chain Reaction',
      typeLine: { supertypes: [], types: ['Sorcery'], subtypes: [] },
      power: null,
      toughness: null,
      oracleText:
        '~ deals X damage to each creature, where X is the number of creatures on the battlefield.',
    } as never);
    const result = compileCard(chain);
    expect(result.status, `missing: ${JSON.stringify(result.missing)}`).toBe('complete');
    expect(result.definition.effects![0]!.params!.amount).toEqual({ countOf: 'creaturesOnBattlefield' });
  });

  it('reaches Doorkeeper through the SAME rule as Sands of Delirium', () => {
    // The bespoke "mills X cards, where X is …" rule is gone: the binding
    // pre-pass strips the where-clause before any rule sees the sentence, so
    // both cards now reach `target-player-mills-x` with the X each one means.
    const doorkeeper = card({
      name: 'Doorkeeper',
      power: 0,
      toughness: 4,
      keywords: ['Defender'],
      oracleText:
        'Defender\n{2}{U}, {T}: Target player mills X cards, where X is the number of creatures you control with defender.',
    });
    const result = compileCard(doorkeeper);
    expect(result.status, `missing: ${JSON.stringify(result.missing)}`).toBe('complete');
    expect(result.definition.activated![0]!.effects[0]!.params!.amount).toEqual({
      countOf: 'creaturesYouControlWithDefender',
    });
  });

  it('reads the printed ARITHMETIC, with CR 107.1b\'s floor as data', () => {
    const welding = card({
      name: 'Welding Sparks',
      typeLine: { supertypes: [], types: ['Instant'], subtypes: [] },
      power: null,
      toughness: null,
      oracleText:
        '~ deals X damage to target creature, where X is 3 plus the number of artifacts you control.',
    } as never);
    const result = compileCard(welding);
    expect(result.status, `missing: ${JSON.stringify(result.missing)}`).toBe('complete');
    const amount = result.definition.effects![0]!.params!.amount as Record<string, unknown>;
    expect(amount.plus).toBe(3);
    // An adding row needs no floor; a subtracting one does, and says so.
    expect(amount.min).toBeUndefined();
  });

  it('REFUSES a "where X is" phrase outside the count vocabulary', () => {
    // Gray Merchant's devotion, Radiant Flames's "colors of mana spent". Reading
    // either as a count would be a number the card does not print.
    const devotion = card({
      name: 'Gray Merchant of Asphodel',
      oracleText: 'When ~ enters, each opponent loses X life, where X is your devotion to black.',
    });
    expect(blockers(devotion)).toHaveLength(1);
  });
});

// ===========================================================================
// 4. THE COUNT VOCABULARY — filtered rows, and the precedence that cost 8 cards
// ===========================================================================

describe('the count vocabulary', () => {
  it('counts a SUBTYPE noun through a filter, in the scope the card prints', () => {
    const spitting = card({
      name: 'Spitting Earth',
      typeLine: { supertypes: [], types: ['Sorcery'], subtypes: [] },
      power: null,
      toughness: null,
      oracleText: '~ deals damage to target creature equal to the number of Mountains you control.',
    } as never);
    const result = compileCard(spitting);
    expect(result.status, `missing: ${JSON.stringify(result.missing)}`).toBe('complete');
    expect(result.definition.effects![0]!.params!.amount).toEqual({
      countOf: 'permanentsMatching',
      filter: { anyOfSubtypes: ['Mountain'] },
      scope: 'you',
    });
  });

  it('gives an OPPONENT-scoped phrase a different scope, not the same number', () => {
    const runes = card({
      name: 'Ancient Runes Probe',
      typeLine: { supertypes: [], types: ['Sorcery'], subtypes: [] },
      power: null,
      toughness: null,
      oracleText: '~ deals damage to target creature equal to the number of artifacts they control.',
    } as never);
    const amount = compileCard(runes).definition.effects?.[0]?.params?.amount as
      | Record<string, unknown>
      | undefined;
    expect(amount?.scope).toBe('opponents');
  });

  /**
   * ⚠️ THE REGRESSION THIS FILE EXISTS FOR.
   *
   * The generated filtered rows include "lands you control", which the NAMED
   * half already answers as `landsYouControl` — the row core's
   * characteristic-defining P/T evaluator knows. Spread the generated half last
   * and the named row is replaced; `namedDerivedValue` then correctly refuses a
   * filtered count in a star box, and eight `*`/`*` creatures leave the pool
   * with nothing failing. `playable-set.mjs` caught it as 8 LOST inside a +55.
   */
  it('lets a NAMED row win over a generated one, so a star box still compiles', () => {
    const molimo = card({
      name: 'Molimo, Maro-Sorcerer',
      power: null,
      toughness: null,
      oracleText:
        "Trample\n~'s power and toughness are each equal to the number of lands you control.",
    } as never);
    const result = compileCard(molimo);
    expect(result.status, `missing: ${JSON.stringify(result.missing)}`).toBe('complete');
    // The NAMED row, not a filter — a P/T box can only carry this one.
    expect(result.definition.characteristicPT).toEqual({
      power: { countOf: 'landsYouControl' },
      toughness: { countOf: 'landsYouControl' },
    });
  });

  it('REFUSES a filtered count in a star box rather than reading zero', () => {
    // No printed card does this today; the refusal is what keeps it that way
    // until core's CDA evaluator can carry a filter.
    const goyfish = card({
      name: 'Probe Goyf',
      power: null,
      toughness: null,
      oracleText: "~'s power and toughness are each equal to the number of Goblins you control.",
    } as never);
    expect(compileCard(goyfish).status).not.toBe('complete');
  });
});

// ===========================================================================
// 5. THE AMOUNTS ARE REAL ON A BOARD — not just shapes in a compiled record
// ===========================================================================

function creatureDef(id: string, power: number, toughness: number, subtypes: string[] = []): CardDefinition {
  return {
    id,
    name: id,
    types: ['creature'],
    subtypes,
    power,
    toughness,
    cost: { generic: 1 },
  } as CardDefinition;
}

function putOnBattlefield(state: GameState, controller: 'A' | 'B', def: CardDefinition): void {
  state.battlefield.push({
    instanceId: state.nextInstanceId++,
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
}

describe('the amounts evaluate against a real board', () => {
  it('a filtered count sees only the matching permanents, in the printed scope', async () => {
    const { countPermanentsMatching } = await import('@jonny-boi/core');
    const filler = creatureDef('filler', 1, 1);
    const { state } = createGame({
      seed: 7,
      decks: {
        A: { cards: Array.from({ length: 40 }, () => filler) },
        B: { cards: Array.from({ length: 40 }, () => filler) },
      },
    });
    putOnBattlefield(state, 'A', creatureDef('mine-1', 1, 1, ['Goblin']));
    putOnBattlefield(state, 'A', creatureDef('mine-2', 1, 1, ['Goblin']));
    putOnBattlefield(state, 'A', creatureDef('mine-3', 1, 1, ['Elf']));
    putOnBattlefield(state, 'B', creatureDef('theirs-1', 1, 1, ['Goblin']));
    const goblins = { anyOfSubtypes: ['Goblin'] };
    // The discriminator: three different numbers from one board, which is
    // exactly what a single-scope table would have got wrong.
    expect(countPermanentsMatching(state, goblins as never, 'you', 'A')).toBe(2);
    expect(countPermanentsMatching(state, goblins as never, 'opponents', 'A')).toBe(1);
    expect(countPermanentsMatching(state, goblins as never, 'any', 'A')).toBe(3);
  });
});
