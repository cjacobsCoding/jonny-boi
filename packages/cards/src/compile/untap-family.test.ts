/**
 * THE UNTAP FAMILY — "Untap ~", "Untap target <NOUN>", and the tap half that
 * reads the same noun table.
 *
 * Why it exists as a family rather than a rule per card: the backlog
 * measurement (`packages/cards/scripts/activated-blame.mjs`) split the 1,448
 * cards behind "an activated-ability template the compiler does not recognize
 * yet" into a COST half (71 clauses) and a BODY half (1,134 clauses, 912
 * distinct shapes). The family is not one system — but inside it, the untap
 * bodies are one: forty-odd printed clauses that differ only in the noun after
 * "target". One primitive plus one closed noun table is the whole of it.
 *
 * ⚠️ EVERY ORACLE STRING HERE IS COPIED FROM A REAL PRINTED CARD in the corpus,
 * because `dead-rule-sweep.mjs` exists for the opposite case: the Gatecreeper
 * Vine bug (§3.57) was a rule written from a REMEMBERED wording, which matched
 * nothing, covered zero cards, and no test could see it. A rule proven only
 * against text this file invented is that bug with a passing test attached.
 */

import { describe, expect, it } from 'vitest';
import type { CardDefinition, CardInstance, GameState, InstanceId, PlayerId } from '@jonny-boi/core';
import { createGame, isLegalTarget, legalTargetsFor } from '@jonny-boi/core';
import { compileCard } from './compile.js';
import type { CompilableCard } from './types.js';

/** A Scryfall-shaped record for the compiler. */
function card(
  overrides: Partial<CompilableCard> & { name: string; oracleText: string },
): CompilableCard {
  return {
    id: `id:${overrides.name}`,
    manaCost: { generic: 0, W: 0, U: 0, B: 0, R: 0, G: 0, C: 0, other: [] },
    typeLine: { supertypes: [], types: ['Creature'], subtypes: ['Elf'] },
    power: 1,
    toughness: 1,
    keywords: [],
    ...overrides,
  } as CompilableCard;
}

/** The single activated ability a one-ability card compiled to. */
function soleAbility(printed: CompilableCard) {
  const result = compileCard(printed);
  expect(result.status, `missing: ${JSON.stringify(result.missing)}`).toBe('complete');
  const abilities = result.definition.activated ?? [];
  expect(abilities).toHaveLength(1);
  return abilities[0]!;
}

// --- the acceptance card -------------------------------------------------------

/** Arbor Elf, as printed. */
const ARBOR_ELF = card({ name: 'Arbor Elf', oracleText: '{T}: Untap target Forest.' });

describe('Arbor Elf — the printed basic-land-type target', () => {
  it('compiles completely', () => {
    expect(compileCard(ARBOR_ELF).status).toBe('complete');
  });

  it('unties the ability to the FOREST restriction, never widened to "land"', () => {
    // The whole point of the five basic-type rows. A card that reads "Forest"
    // and plays as "land" untaps an opponent's Island — strictly wider than
    // printed, and invisible to a test that only asserted "complete".
    const ability = soleAbility(ARBOR_ELF);
    expect(ability.cost.tap).toBe(true);
    expect(ability.effects).toHaveLength(1);
    expect(ability.effects[0]!.primitive).toBe('untapTarget');
    expect(ability.effects[0]!.params!.targets).toBe('forest');
  });
});

// --- the noun table, one printed card per row -----------------------------------

/**
 * One REAL printed card per untap noun. The card name is the evidence that the
 * row is not invented; the Oracle text is the card's own.
 */
const PRINTED_UNTAP_BODIES: ReadonlyArray<{
  readonly name: string;
  readonly oracleText: string;
  readonly targets: string;
  readonly types?: readonly string[];
}> = [
  { name: 'Arbor Elf', oracleText: '{T}: Untap target Forest.', targets: 'forest' },
  { name: 'Blossom Dryad', oracleText: '{T}: Untap target land.', targets: 'land' },
  { name: "Jandor's Saddlebags", oracleText: '{3}, {T}: Untap target creature.', targets: 'creature' },
  { name: 'Voltaic Key', oracleText: '{1}, {T}: Untap target artifact.', targets: 'artifact' },
  {
    name: 'Kiora, Behemoth Beckoner',
    oracleText: '{1}{G}: Untap target permanent.',
    targets: 'permanent',
  },
];

describe('the untap noun table — a row per printed noun', () => {
  for (const printed of PRINTED_UNTAP_BODIES) {
    it(`${printed.name} compiles and aims at '${printed.targets}'`, () => {
      const ability = soleAbility(
        card({
          name: printed.name,
          oracleText: printed.oracleText,
          ...(printed.types
            ? { typeLine: { supertypes: [], types: [...printed.types], subtypes: [] } }
            : {}),
        }),
      );
      expect(ability.effects[0]!.primitive).toBe('untapTarget');
      expect(ability.effects[0]!.params!.targets).toBe(printed.targets);
    });
  }
});

describe('untap ~ — the untargeted self form', () => {
  it('Grim Monolith compiles to untapSelf, with no target restriction', () => {
    // Printed: "{T}: Add {C}{C}{C}." plus "{4}: Untap Grim Monolith." Only the
    // untap half is asserted here; the mana half has its own family.
    const ability = soleAbility(
      card({
        name: 'Grim Monolith',
        typeLine: { supertypes: [], types: ['Artifact'], subtypes: [] },
        oracleText: '{4}: Untap Grim Monolith.',
      }),
    );
    expect(ability.effects[0]!.primitive).toBe('untapSelf');
    // No aim at all: the printed line names no target, so it must not acquire a
    // targeting gate (hexproof, protection) the real ability does not have.
    expect(ability.effects[0]!.params?.targets).toBeUndefined();
  });
});

describe('the tap half reads the SAME table', () => {
  it('Auriok Transfixer compiles "Tap target artifact"', () => {
    const ability = soleAbility(
      card({
        name: 'Auriok Transfixer',
        oracleText: '{T}: Tap target artifact.',
      }),
    );
    expect(ability.effects[0]!.primitive).toBe('tapTarget');
    expect(ability.effects[0]!.params!.targets).toBe('artifact');
  });
});

// --- what STAYS reported --------------------------------------------------------

describe('nouns outside the table report rather than widen', () => {
  /**
   * Each of these is a REAL printed card the table deliberately does not serve.
   * A row that swallowed one would be a card playing wider than printed, which
   * is the failure this closed table exists to prevent — so the assertion is
   * that the compiler still REFUSES them.
   */
  const REFUSED: ReadonlyArray<{ name: string; oracleText: string }> = [
    // "Another" excludes the source and `ActivatedAbility` cannot say so.
    { name: "Kiora's Follower", oracleText: '{T}: Untap another target permanent.' },
    // A supertype narrowing core's restriction union cannot express.
    { name: "Minamo, School at Water's Edge", oracleText: '{1}{U}, {T}: Untap target legendary permanent.' },
    // A controller scope: "permanent you control" is not a restriction core has.
    { name: 'Forensic Researcher', oracleText: '{2}{U}, {T}: Untap another target permanent you control.' },
  ];
  // ⚠️ Norritt WAS on this list ("a colour narrowing core's restriction union
  // cannot express"). §3.150 gave core that expression, so the refusal is gone
  // and the card compiles. It is asserted POSITIVELY below rather than simply
  // deleted from the list: a pinned refusal that is dropped without a
  // replacement leaves nothing to fail if the bound later stops being carried,
  // and "untap target creature" is exactly the wider card this file guards.
  it('Norritt compiles now, and keeps the COLOUR the printed card names', () => {
    const result = compileCard(card({ name: 'Norritt', oracleText: '{2}, {T}: Untap target blue creature.' }));
    expect(result.status).toBe('complete');
    expect(result.definition?.activated?.[0]?.effects[0]?.params?.targets).toEqual({
      base: 'creature',
      bound: { colour: 'U' },
    });
  });

  for (const printed of REFUSED) {
    it(`${printed.name} stays reported`, () => {
      const result = compileCard(card({ name: printed.name, oracleText: printed.oracleText }));
      expect(result.status).toBe('incomplete');
    });
  }
});

// --- the restriction is real on a board -----------------------------------------

/** A land definition carrying the given basic types. */
function landOf(id: string, subtypes: readonly string[]): CardDefinition {
  return { id, name: id, types: ['land'], subtypes: [...subtypes], produces: ['G'] };
}

function place(state: GameState, def: CardDefinition, controller: PlayerId): InstanceId {
  const id = state.nextInstanceId++;
  state.battlefield.push({
    instanceId: id,
    def,
    controller,
    owner: controller,
    zone: 'battlefield',
    tapped: true,
    summoningSick: false,
    damageMarked: 0,
    markedByDeathtouch: false,
    attachedTo: null,
    counters: {},
  } as CardInstance);
  return id;
}

describe("'forest' on a real board — the discriminator Arbor Elf needs", () => {
  it('offers a Forest and a Forest-typed dual, and refuses an Island and a plain land', () => {
    const filler = landOf('filler', []);
    const { state } = createGame({
      seed: 17,
      decks: { A: { cards: Array.from({ length: 40 }, () => filler) }, B: { cards: Array.from({ length: 40 }, () => filler) } },
    });
    const forest = place(state, landOf('Forest', ['forest']), 'A');
    // Stomping Ground is a Mountain Forest — a legal Arbor Elf target in paper.
    const dual = place(state, landOf('Stomping Ground', ['mountain', 'forest']), 'B');
    const island = place(state, landOf('Island', ['island']), 'B');
    const plain = place(state, landOf('Wastes', []), 'A');

    const offered = legalTargetsFor(state, 'forest', 'A');
    expect([...offered].sort()).toEqual([forest, dual].sort());
    expect(isLegalTarget(state, 'forest', island, 'A')).toBe(false);
    expect(isLegalTarget(state, 'forest', plain, 'A')).toBe(false);
    expect(isLegalTarget(state, 'forest', dual, 'A')).toBe(true);
  });
});
