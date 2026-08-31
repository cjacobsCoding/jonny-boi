/**
 * The collateral price of tapping a source (§3.60) — the term that finally knows
 * a Forest costs nothing and a mana elf costs a blocker.
 *
 * `mana-plan.test.ts` pins what the PLANNER does with this; these pin the price
 * itself, and above all the rule the price is easiest to get wrong: it reads the
 * permanent as it is RIGHT NOW, never the printed front face.
 */
import { describe, expect, it } from 'vitest';
import type { CardDefinition } from './card.js';
import {
  MANA_COLLATERAL_WEIGHTS,
  MANA_SOURCE_PREFERENCE_DEFAULT,
  SPARE_USEFUL_MANA_SOURCES,
  SPARE_USEFUL_MANA_SOURCES_FIRST,
  manaSourceCollateral,
} from './mana-source-preference.js';
import type { CardInstance, InstanceId, PlayerId } from './state.js';

const FOREST: CardDefinition = { id: 'Forest', name: 'Forest', types: ['land'], produces: ['G'] };
const ELVES: CardDefinition = {
  id: 'LlanowarElves',
  name: 'Llanowar Elves',
  types: ['creature'],
  power: 1,
  toughness: 1,
  produces: ['G'],
};
const UTILITY_LAND: CardDefinition = {
  id: 'UtilityLand',
  name: 'Utility Land',
  types: ['land'],
  produces: ['C'],
  activated: [{ cost: { tap: true }, effects: [], label: '{T}: Do a thing.' }],
};
/** A creature that ALSO prints a `{T}` ability — both prices apply at once. */
const TAPPING_CREATURE: CardDefinition = {
  id: 'TappingCreature',
  name: 'Tapping Creature',
  types: ['creature'],
  power: 2,
  toughness: 2,
  produces: ['W'],
  activated: [{ cost: { tap: true }, effects: [], label: '{T}: Do a thing.' }],
};
/** An ability with a MANA cost and no `{T}` — activating it costs no tap. */
const MANA_COST_ARTIFACT: CardDefinition = {
  id: 'ManaCostArtifact',
  name: 'Mana-Cost Artifact',
  types: ['artifact'],
  produces: ['C'],
  activated: [{ cost: { mana: { generic: 2 } }, effects: [], label: '{2}: Do a thing.' }],
};

function permanent(instanceId: InstanceId, def: CardDefinition, controller: PlayerId = 'A'): CardInstance {
  return {
    instanceId,
    def,
    controller,
    owner: controller,
    zone: 'battlefield',
    tapped: false,
    summoningSick: false,
    damageMarked: 0,
    markedByDeathtouch: false,
    attachedTo: null,
    counters: {},
  };
}

describe('manaSourceCollateral', () => {
  it('charges a basic land nothing — it is the source to spend first', () => {
    expect(manaSourceCollateral(permanent(1, FOREST))).toBe(0);
  });

  it('charges a creature for the body it stops being able to attack or block with', () => {
    expect(manaSourceCollateral(permanent(1, ELVES))).toBe(MANA_COLLATERAL_WEIGHTS.creatureBody);
  });

  it('charges a permanent for the {T} ability tapping for mana spends', () => {
    expect(manaSourceCollateral(permanent(1, UTILITY_LAND))).toBe(MANA_COLLATERAL_WEIGHTS.tapAbility);
  });

  it('adds both when a source is a body AND a {T} ability', () => {
    expect(manaSourceCollateral(permanent(1, TAPPING_CREATURE))).toBe(
      MANA_COLLATERAL_WEIGHTS.creatureBody + MANA_COLLATERAL_WEIGHTS.tapAbility,
    );
  });

  it('ignores an activated ability that does not cost {T} — nothing is lost by tapping', () => {
    expect(manaSourceCollateral(permanent(1, MANA_COST_ARTIFACT))).toBe(0);
  });

  it('prices a body above a spent {T} ability, so the utility land goes first', () => {
    expect(manaSourceCollateral(permanent(1, ELVES))).toBeGreaterThan(
      manaSourceCollateral(permanent(2, UTILITY_LAND)),
    );
  });

  /**
   * ⚠️ THE CURRENT STATE, NOT THE PRINTED CARD. `CardInstance.def` is the face
   * that is up and the card a copy is copying; `printedDef` is the way back. A
   * permanent that is not a creature RIGHT NOW must not be charged for a body it
   * does not have, and one that has become a creature must be.
   */
  it('reads the face that is up, not the printed front face', () => {
    const transformedToLand: CardInstance = { ...permanent(1, FOREST), printedDef: ELVES };
    expect(manaSourceCollateral(transformedToLand)).toBe(0);
    const transformedToCreature: CardInstance = { ...permanent(2, ELVES), printedDef: FOREST };
    expect(manaSourceCollateral(transformedToCreature)).toBe(MANA_COLLATERAL_WEIGHTS.creatureBody);
  });

  it('reads the copied card, not the card the copy really is', () => {
    const cloneOfAnElf: CardInstance = { ...permanent(1, ELVES), uncopiedDef: FOREST };
    expect(manaSourceCollateral(cloneOfAnElf)).toBe(MANA_COLLATERAL_WEIGHTS.creatureBody);
  });

  it('takes tunable weights rather than baked-in numbers', () => {
    const doubled = { creatureBody: 10, tapAbility: 3 };
    expect(manaSourceCollateral(permanent(1, TAPPING_CREATURE), doubled)).toBe(13);
  });
});

describe('the shipped preferences', () => {
  it('defaults to OFF, which is what keeps every pilot and baseline untouched', () => {
    expect(MANA_SOURCE_PREFERENCE_DEFAULT.collateralRank).toBe('off');
  });

  it('places the human policy below flexibility — the conservative rung', () => {
    expect(SPARE_USEFUL_MANA_SOURCES.collateralRank).toBe('belowFlexibility');
    expect(SPARE_USEFUL_MANA_SOURCES_FIRST.collateralRank).toBe('aboveFlexibility');
  });

  it('freezes the presets so a consumer cannot retune them for everyone else', () => {
    expect(Object.isFrozen(MANA_SOURCE_PREFERENCE_DEFAULT)).toBe(true);
    expect(Object.isFrozen(SPARE_USEFUL_MANA_SOURCES)).toBe(true);
    expect(Object.isFrozen(MANA_COLLATERAL_WEIGHTS)).toBe(true);
  });
});
