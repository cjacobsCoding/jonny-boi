/**
 * Auras and Equipment, compiled from REAL printed Oracle text.
 *
 * Every card in this file is quoted verbatim from its Scryfall Oracle text — the
 * printed text is the input, not a convenient paraphrase, because the repo has been
 * burned before by cards that compiled into something strictly better than the real
 * card. If a template here ever drifts, this suite fails on the card, by name.
 *
 * The cards are exercised through the SAME compiler the deck importer uses
 * (`compileCard`), so anything green here is a card a user can paste into a
 * decklist today.
 */

import { describe, expect, it } from 'vitest';
import { compileCard } from './compile.js';
import { CORE_PRIMITIVE_IDS } from '../primitives.js';
import type { CompilableCard } from './types.js';

/** An empty mana cost, spelled once so each fixture only states what it prints. */
const NO_MANA = { generic: 0, W: 0, U: 0, B: 0, R: 0, G: 0, C: 0, other: [] as readonly string[] };

/** Build a Scryfall-shaped record from the parts a printed card actually has. */
function card(parts: {
  name: string;
  cost?: Partial<typeof NO_MANA>;
  types: readonly string[];
  subtypes?: readonly string[];
  oracleText: string;
  keywords?: readonly string[];
}): CompilableCard {
  return {
    id: `test:${parts.name}`,
    name: parts.name,
    manaCost: { ...NO_MANA, ...parts.cost },
    typeLine: { supertypes: [], types: parts.types, subtypes: parts.subtypes ?? [] },
    oracleText: parts.oracleText,
    power: null,
    toughness: null,
    keywords: parts.keywords ?? [],
  };
}

// --- the cards, exactly as printed ---------------------------------------------

/** Unholy Strength {B} — Enchantment — Aura. The plainest possible Aura. */
const UNHOLY_STRENGTH = card({
  name: 'Unholy Strength',
  cost: { B: 1 },
  types: ['Enchantment'],
  subtypes: ['Aura'],
  keywords: ['Enchant'],
  oracleText: 'Enchant creature\nEnchanted creature gets +2/+1.',
});

/** Dead Weight {B} — an Aura used as REMOVAL, i.e. a negative modification. */
const DEAD_WEIGHT = card({
  name: 'Dead Weight',
  cost: { B: 1 },
  types: ['Enchantment'],
  subtypes: ['Aura'],
  keywords: ['Enchant'],
  oracleText: 'Enchant creature\nEnchanted creature gets -2/-2.',
});

/** Flight {U} — an Aura that grants a KEYWORD rather than stats. */
const FLIGHT = card({
  name: 'Flight',
  cost: { U: 1 },
  types: ['Enchantment'],
  subtypes: ['Aura'],
  keywords: ['Enchant'],
  oracleText: 'Enchant creature\nEnchanted creature has flying.',
});

/** Bonesplitter {1} — Artifact — Equipment. The plainest possible Equipment. */
const BONESPLITTER = card({
  name: 'Bonesplitter',
  cost: { generic: 1 },
  types: ['Artifact'],
  subtypes: ['Equipment'],
  keywords: ['Equip'],
  oracleText: 'Equipped creature gets +2/+0.\nEquip {1}',
});

/** Loxodon Warhammer {3} — stats AND two granted keywords in one line. */
const LOXODON_WARHAMMER = card({
  name: 'Loxodon Warhammer',
  cost: { generic: 3 },
  types: ['Artifact'],
  subtypes: ['Equipment'],
  keywords: ['Equip'],
  oracleText: 'Equipped creature gets +3/+0 and has trample and lifelink.\nEquip {3}',
});

describe('Auras compile from their printed text', () => {
  it('Unholy Strength — "Enchant creature" + "gets +2/+1"', () => {
    const result = compileCard(UNHOLY_STRENGTH);
    expect(result.missing, JSON.stringify(result.missing)).toEqual([]);
    expect(result.status).toBe('complete');
    expect(result.definition.attachment).toEqual({
      attachesTo: { anyOfTypes: ['creature'] },
      whenIllegal: 'toGraveyard',
      label: 'Enchant creature',
      modifies: { power: 2, toughness: 1, keywords: {} },
    });
    // The Aura's spell script is "attach me to my target", which is what makes it
    // enter the battlefield already attached.
    expect(result.definition.effects).toEqual([
      { primitive: 'attachToTarget', params: { targets: 'creature' } },
    ]);
  });

  it('Dead Weight — a NEGATIVE modification, not an approximated "destroy"', () => {
    const result = compileCard(DEAD_WEIGHT);
    expect(result.status).toBe('complete');
    expect(result.definition.attachment?.modifies).toEqual({ power: -2, toughness: -2, keywords: {} });
  });

  it('Flight — grants a keyword and no stats', () => {
    const result = compileCard(FLIGHT);
    expect(result.status).toBe('complete');
    expect(result.definition.attachment?.modifies).toEqual({
      power: 0,
      toughness: 0,
      keywords: { flying: true },
    });
  });
});

describe('Equipment compiles from its printed text', () => {
  it('Bonesplitter — the modification plus a sorcery-speed Equip ability', () => {
    const result = compileCard(BONESPLITTER);
    expect(result.missing, JSON.stringify(result.missing)).toEqual([]);
    expect(result.status).toBe('complete');
    expect(result.definition.attachment).toEqual({
      // "creature you control" is part of what Equip means; offering the whole
      // table would be a card playing differently from its printed text.
      attachesTo: { anyOfTypes: ['creature'], controller: 'you' },
      whenIllegal: 'detach',
      label: 'Equip {1}',
      modifies: { power: 2, toughness: 0, keywords: {} },
    });
    expect(result.definition.activated).toEqual([
      {
        cost: { mana: { generic: 1 } },
        effects: [{ primitive: 'attachToTarget', params: { targets: 'creatureYouControl' } }],
        timing: 'sorcery',
        label: 'Equip {1}',
      },
    ]);
    // An Equipment is NOT an Aura: it has no spell script, so it enters
    // unattached and waits to be equipped.
    expect(result.definition.effects).toBeUndefined();
  });

  it('Loxodon Warhammer — stats and two keywords from one printed line', () => {
    const result = compileCard(LOXODON_WARHAMMER);
    expect(result.missing, JSON.stringify(result.missing)).toEqual([]);
    expect(result.definition.attachment?.modifies).toEqual({
      power: 3,
      toughness: 0,
      keywords: { trample: true, lifelink: true },
    });
    expect(result.definition.activated?.[0]?.cost).toEqual({ mana: { generic: 3 } });
  });

  it('emits only primitives that are actually registered', () => {
    // The failure this guards is silent: a ref naming a primitive nobody
    // registered resolves to a no-op, so the card would "work" and do nothing.
    const known = new Set(CORE_PRIMITIVE_IDS);
    for (const fixture of [UNHOLY_STRENGTH, DEAD_WEIGHT, FLIGHT, BONESPLITTER, LOXODON_WARHAMMER]) {
      const definition = compileCard(fixture).definition;
      const refs = [...(definition.effects ?? []), ...(definition.activated ?? []).flatMap((a) => a.effects)];
      for (const ref of refs) expect(known.has(ref.primitive), `${fixture.name}: ${ref.primitive}`).toBe(true);
    }
  });
});

describe('an attachment refers to ITSELF by its subtype', () => {
  it('Angelic Gift — "When this Aura enters, draw a card" is an ability about the Aura', () => {
    // Oracle templates an attachment's self-reference as "this Aura" / "this
    // Equipment", never "this enchantment" / "this artifact". Until those two
    // phrases normalized to `~` the line survived intact and looked like an
    // ability about some OTHER object, so a plain Aura reported its trigger as
    // unrecognized and could not be pooled at all.
    const result = compileCard(
      card({
        name: 'Angelic Gift',
        cost: { generic: 1, W: 1 },
        types: ['Enchantment'],
        subtypes: ['Aura'],
        keywords: ['Enchant'],
        oracleText: 'Enchant creature\nWhen this Aura enters, draw a card.\nEnchanted creature has flying.',
      }),
    );
    expect(result.missing, JSON.stringify(result.missing)).toEqual([]);
    expect(result.status).toBe('complete');
    expect(result.definition.triggers).toEqual([
      {
        condition: { on: 'etb' },
        effects: [{ primitive: 'drawCards', params: { count: 1 } }],
        label: 'Enters: draw a card',
      },
    ]);
    // …and the attachment half is still whole: the trigger must not have eaten it.
    expect(result.definition.attachment?.modifies).toEqual({
      power: 0,
      toughness: 0,
      keywords: { flying: true },
    });
  });

  it('reports an unreadable "this Equipment" line against `~`, not the raw phrase', () => {
    // Normalizing is not the same as understanding. Ghostfire Blade's cost
    // reduction is still refused — what changes is that the report now names the
    // clause in the same canonical form every other diagnostic uses.
    const result = compileCard(
      card({
        name: 'Ghostfire Blade',
        cost: { generic: 1 },
        types: ['Artifact'],
        subtypes: ['Equipment'],
        keywords: ['Equip'],
        oracleText:
          "Equipped creature gets +2/+2.\nEquip {3}\nThis Equipment's equip ability costs {2} less to activate if it targets a colorless creature.",
      }),
    );
    expect(result.status).toBe('incomplete');
    expect(result.missing.map((m) => m.text).join(' ')).toContain('~');
  });
});

describe('the compiler still refuses what it cannot do faithfully', () => {
  it('reports an Equip whose cost narrows the host ("Equip only to a Human")', () => {
    const result = compileCard(
      card({
        name: 'Restricted Blade',
        cost: { generic: 1 },
        types: ['Artifact'],
        subtypes: ['Equipment'],
        keywords: ['Equip'],
        oracleText: 'Equipped creature gets +1/+0.\nEquip Human {1}\nEquip {3}',
      }),
    );
    // The plain "Equip {3}" half compiles; the narrowed half must still report,
    // because equipping anything for {1} would be strictly better than printed.
    expect(result.status).toBe('incomplete');
    expect(result.missing.map((m) => m.text)).toContain('Equip Human {1}');
  });

  it('grants the PAYLOAD keywords an attachment prints', () => {
    // Ward and protection carry a value rather than a boolean, and core models
    // both — so an attachment printing one compiles it rather than reporting.
    // (This case USED to be the refusal below; the refusal now needs a quality
    // core genuinely has no check for, which is what the next test uses.)
    const warded = compileCard(
      card({
        name: 'Test Ward Aura',
        cost: { W: 1 },
        types: ['Enchantment'],
        subtypes: ['Aura'],
        keywords: ['Enchant'],
        oracleText: 'Enchant creature\nEnchanted creature has ward {2}.',
      }),
    );
    expect(warded.status).toBe('complete');
    expect(warded.definition.attachment?.modifies).toEqual({
      power: 0,
      toughness: 0,
      keywords: { ward: 2 },
    });

    const sword = compileCard(
      card({
        name: 'Test Protective Sword',
        cost: { generic: 3 },
        types: ['Artifact'],
        subtypes: ['Equipment'],
        keywords: ['Equip'],
        oracleText:
          'Equipped creature gets +2/+2 and has protection from black and from green.\nEquip {2}',
      }),
    );
    expect(sword.status).toBe('complete');
    expect(sword.definition.attachment?.modifies).toEqual({
      power: 2,
      toughness: 2,
      keywords: { protectionFrom: ['black', 'green'] },
    });
  });

  it('reports an Aura whose printed grant we cannot model', () => {
    // A protection QUALITY outside the closed table: core has no check for "a
    // Demon", so granting it would protect from the wrong set of things.
    const result = compileCard(
      card({
        name: 'Test Demon Ward',
        cost: { W: 1 },
        types: ['Enchantment'],
        subtypes: ['Aura'],
        keywords: ['Enchant'],
        // A quality outside the closed table. "From Demons" used to be the
        // stand-in until subtypes compiled (§3.109); Reaver Titan's mana-value
        // protection is the real printed form that still has no engine check.
        oracleText: 'Enchant creature\nEnchanted creature has protection from mana value 3 or less.',
      }),
    );
    expect(result.status).toBe('incomplete');
    // And it must not have compiled a SILENTLY EMPTY modification instead.
    expect(result.definition.attachment?.modifies).toBeUndefined();
  });

  it('refuses a modification with no way to ever become attached', () => {
    const result = compileCard(
      card({
        name: 'Orphan Buff',
        cost: { generic: 1 },
        types: ['Artifact'],
        oracleText: 'Equipped creature gets +5/+5.',
      }),
    );
    expect(result.status).toBe('incomplete');
    expect(result.definition.attachment).toBeUndefined();
    expect(result.missing.map((m) => m.missingEngineSystem).join(' ')).toContain('Equip {N}');
  });

  it('reports "enchant player" — a host kind the engine has no permanent for', () => {
    const result = compileCard(
      card({
        name: 'Test Curse',
        cost: { B: 1 },
        types: ['Enchantment'],
        subtypes: ['Aura', 'Curse'],
        keywords: ['Enchant'],
        oracleText: 'Enchant player\nEnchanted player loses 1 life at the beginning of their upkeep.',
      }),
    );
    expect(result.status).toBe('incomplete');
    expect(result.definition.attachment).toBeUndefined();
  });
});
