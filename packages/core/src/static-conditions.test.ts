/**
 * "AS LONG AS …" — WHEN A STATIC IS ON (DESIGN §3.169).
 *
 * Threshold, delirium, metalcraft, "as long as it's equipped", "as long as it's
 * attacking", "as long as you have 5 or less life", "another Elf" — each a
 * member of the closed `StaticCondition` table, each read live off the state
 * every time the continuous index is built, so a static switches on and off
 * with nothing stored.
 *
 * What is pinned, per condition: OFF when the fact is false, ON when it is
 * true, on the SAME board with one fact changed. And, for every case, the bulk
 * index and the per-permanent aggregate agree — they walk the same statics and
 * answer the same abilities by index, so a gate present in one and absent in
 * the other would be an ability offered and then resolved to `undefined`.
 */

import { describe, expect, it } from 'vitest';
import type { CardDefinition, CardInstance, GameState } from './index.js';
import { aggregateFor, indexContinuous } from './internal/continuous.js';
import { effectiveKeywords, effectivePower, effectiveToughness } from './internal/stats.js';
import { staticConditionHolds } from './static-conditions.js';

const SELF = { onlySource: true } as const;

/** Krosan Beast: "gets +7/+7 as long as seven or more cards are in your graveyard". */
const KROSAN_BEAST: CardDefinition = {
  id: 'krosan',
  name: 'Krosan Beast',
  types: ['creature'],
  power: 1,
  toughness: 1,
  statics: [
    {
      affects: SELF,
      power: 7,
      toughness: 7,
      activeWhile: { kind: 'countAtLeast', count: { countOf: 'cardsInYourGraveyard' }, min: 7 },
    },
  ],
};

/** Grim Flayer's delirium half: "+2/+2 as long as there are four or more card types among cards in your graveyard". */
const GRIM_FLAYER: CardDefinition = {
  id: 'flayer',
  name: 'Grim Flayer',
  types: ['creature'],
  power: 2,
  toughness: 2,
  statics: [
    {
      affects: SELF,
      power: 2,
      toughness: 2,
      activeWhile: { kind: 'countAtLeast', count: { countOf: 'cardTypesInYourGraveyard' }, min: 4 },
    },
  ],
};

/** Skyhunter Cub: "As long as ~ is equipped, it gets +1/+1 and has flying". */
const SKYHUNTER_CUB: CardDefinition = {
  id: 'cub',
  name: 'Skyhunter Cub',
  types: ['creature'],
  power: 2,
  toughness: 2,
  statics: [
    {
      affects: SELF,
      power: 1,
      toughness: 1,
      keywords: { flying: true },
      activeWhile: { kind: 'sourceAttached', by: 'Equipment' },
    },
  ],
};

/** Indomitable Archangel's metalcraft: "Artifacts you control have shroud as long as you control three or more artifacts". */
const ARCHANGEL: CardDefinition = {
  id: 'archangel',
  name: 'Indomitable Archangel',
  types: ['creature'],
  power: 4,
  toughness: 4,
  statics: [
    {
      affects: { anyOfTypes: ['artifact'], controller: 'you' },
      keywords: { shroud: true },
      activeWhile: {
        kind: 'countAtLeast',
        count: {
          countOf: 'permanentsMatching',
          filter: { anyOfTypes: ['artifact'] },
          scope: 'you',
        },
        min: 3,
      },
    },
  ],
};

/** "~ gets +1/+1 as long as you control ANOTHER Elf" — the source must not count itself. */
const ELF_FRIEND: CardDefinition = {
  id: 'elf-friend',
  name: 'Test Elf Friend',
  types: ['creature'],
  subtypes: ['Elf'],
  power: 1,
  toughness: 1,
  statics: [
    {
      affects: SELF,
      power: 1,
      toughness: 1,
      activeWhile: {
        kind: 'countAtLeast',
        count: { countOf: 'permanentsMatching', filter: { anyOfSubtypes: ['Elf'] }, scope: 'you' },
        min: 1,
        excludeSource: true,
      },
    },
  ],
};

/** Kor Scythemaster: "+1/+0 as long as it's attacking". */
const SCYTHEMASTER: CardDefinition = {
  id: 'scythemaster',
  name: 'Kor Scythemaster',
  types: ['creature'],
  power: 3,
  toughness: 1,
  statics: [{ affects: SELF, power: 1, activeWhile: { kind: 'sourceAttacking' } }],
};

/** Gavony Ironwright's fateful hour: "other creatures you control get +1/+4 as long as you have 5 or less life". */
const IRONWRIGHT: CardDefinition = {
  id: 'ironwright',
  name: 'Gavony Ironwright',
  types: ['creature'],
  power: 1,
  toughness: 4,
  statics: [
    {
      affects: { anyOfTypes: ['creature'], controller: 'you', excludeSource: true },
      power: 1,
      toughness: 4,
      activeWhile: { kind: 'lifeAtMost', max: 5 },
    },
  ],
};

const EQUIPMENT: CardDefinition = {
  id: 'sword',
  name: 'Test Sword',
  types: ['artifact'],
  subtypes: ['Equipment'],
};
const ROCK: CardDefinition = { id: 'rock', name: 'Test Rock', types: ['artifact'] };
const ELF: CardDefinition = {
  id: 'elf',
  name: 'Test Elf',
  types: ['creature'],
  subtypes: ['Elf'],
  power: 1,
  toughness: 1,
};
const BEAR: CardDefinition = {
  id: 'bear',
  name: 'Test Bear',
  types: ['creature'],
  power: 2,
  toughness: 2,
};

function card(
  def: CardDefinition,
  instanceId: number,
  extra: Partial<CardInstance> = {},
): CardInstance {
  return {
    instanceId,
    def,
    controller: 'A',
    owner: 'A',
    zone: 'battlefield',
    tapped: false,
    summoningSick: false,
    damageMarked: 0,
    markedByDeathtouch: false,
    counters: {},
    ...extra,
  } as CardInstance;
}

function boardOf(
  battlefield: CardInstance[],
  graveyardA: CardDefinition[] = [],
  life = 20,
): GameState {
  return {
    battlefield,
    stack: [],
    continuous: [],
    combat: null,
    players: {
      A: {
        life,
        hand: [],
        library: [],
        graveyard: graveyardA.map((def, i) => card(def, 900 + i, { zone: 'graveyard' })),
        exile: [],
        command: [],
      },
      B: { life: 20, hand: [], library: [], graveyard: [], exile: [], command: [] },
    },
  } as unknown as GameState;
}

/** Effective power by BOTH paths, asserted equal — the invariant every case leans on. */
function powerOf(state: GameState, id: number): number {
  const inst = state.battlefield.find((c) => c.instanceId === id)!;
  const bulk = effectivePower(inst, indexContinuous(state).get(id) ?? undefined);
  const single = effectivePower(inst, aggregateFor(state, id));
  expect(single, 'the per-permanent aggregate must agree with the bulk index').toBe(bulk);
  return bulk;
}

function keywordsOf(state: GameState, id: number) {
  const inst = state.battlefield.find((c) => c.instanceId === id)!;
  const bulk = effectiveKeywords(inst, indexContinuous(state).get(id) ?? undefined);
  const single = effectiveKeywords(inst, aggregateFor(state, id));
  expect(single).toEqual(bulk);
  return bulk;
}

describe('threshold and delirium — counts in your graveyard', () => {
  it('Krosan Beast is a 1/1 at six cards and an 8/8 at seven', () => {
    const six = boardOf(
      [card(KROSAN_BEAST, 1)],
      Array.from({ length: 6 }, () => BEAR),
    );
    expect(powerOf(six, 1)).toBe(1);
    const seven = boardOf(
      [card(KROSAN_BEAST, 1)],
      Array.from({ length: 7 }, () => BEAR),
    );
    expect(powerOf(seven, 1)).toBe(8);
    expect(effectiveToughness(seven.battlefield[0]!, aggregateFor(seven, 1))).toBe(8);
  });

  it('delirium counts DISTINCT types in YOUR graveyard, not cards', () => {
    const fourCards = boardOf([card(GRIM_FLAYER, 1)], [BEAR, BEAR, BEAR, BEAR]);
    expect(powerOf(fourCards, 1), 'four creature cards are one type').toBe(2);
    const land: CardDefinition = { id: 'l', name: 'L', types: ['land'] };
    const artifact: CardDefinition = { id: 'a', name: 'A', types: ['artifact'] };
    const instant: CardDefinition = { id: 'i', name: 'I', types: ['instant'] };
    const fourTypes = boardOf([card(GRIM_FLAYER, 1)], [BEAR, land, artifact, instant]);
    expect(powerOf(fourTypes, 1)).toBe(4);
    // The opponent's graveyard is not yours.
    const theirs = boardOf([card(GRIM_FLAYER, 1)]);
    theirs.players.B.graveyard = [BEAR, land, artifact, instant].map((def, i) =>
      card(def, 800 + i, { owner: 'B', controller: 'B' }),
    );
    expect(powerOf(theirs, 1)).toBe(2);
  });
});

describe('the source itself — equipped, attacking', () => {
  it('Skyhunter Cub flies and grows only while an Equipment is attached to it', () => {
    const bare = boardOf([card(SKYHUNTER_CUB, 1), card(EQUIPMENT, 2)]);
    expect(powerOf(bare, 1)).toBe(2);
    expect(keywordsOf(bare, 1).flying).toBeFalsy();
    const equipped = boardOf([card(SKYHUNTER_CUB, 1), card(EQUIPMENT, 2, { attachedTo: 1 })]);
    expect(powerOf(equipped, 1)).toBe(3);
    expect(keywordsOf(equipped, 1).flying).toBe(true);
    // An Aura attached to it is not "equipped".
    const aura: CardDefinition = {
      id: 'aura',
      name: 'Test Aura',
      types: ['enchantment'],
      subtypes: ['Aura'],
    };
    const enchanted = boardOf([card(SKYHUNTER_CUB, 1), card(aura, 2, { attachedTo: 1 })]);
    expect(powerOf(enchanted, 1)).toBe(2);
  });

  it('Kor Scythemaster gets +1/+0 only while it is a declared attacker', () => {
    const idle = boardOf([card(SCYTHEMASTER, 1)]);
    expect(powerOf(idle, 1)).toBe(3);
    const attacking = boardOf([card(SCYTHEMASTER, 1)]);
    (attacking as { combat: unknown }).combat = { attackers: [1], blocks: {}, declared: true };
    expect(powerOf(attacking, 1)).toBe(4);
  });
});

describe('counts of what you control', () => {
  it("metalcraft: the Archangel's shroud reaches artifacts only at three or more", () => {
    const two = boardOf([card(ARCHANGEL, 1), card(ROCK, 2), card(ROCK, 3)]);
    expect(keywordsOf(two, 2).shroud).toBeFalsy();
    const three = boardOf([card(ARCHANGEL, 1), card(ROCK, 2), card(ROCK, 3), card(ROCK, 4)]);
    expect(keywordsOf(three, 2).shroud).toBe(true);
    expect(keywordsOf(three, 1).shroud, 'the Archangel is no artifact').toBeFalsy();
  });

  it('"another Elf" never counts the source, and does count a second Elf', () => {
    const alone = boardOf([card(ELF_FRIEND, 1)]);
    expect(powerOf(alone, 1), 'an Elf alone controls no OTHER Elf').toBe(1);
    const withElf = boardOf([card(ELF_FRIEND, 1), card(ELF, 2)]);
    expect(powerOf(withElf, 1)).toBe(2);
    const withBear = boardOf([card(ELF_FRIEND, 1), card(BEAR, 2)]);
    expect(powerOf(withBear, 1)).toBe(1);
  });
});

describe('a life total', () => {
  it("fateful hour: the Ironwright's team pump is on at 5 life and off at 6", () => {
    const safe = boardOf([card(IRONWRIGHT, 1), card(BEAR, 2)], [], 6);
    expect(powerOf(safe, 2)).toBe(2);
    const desperate = boardOf([card(IRONWRIGHT, 1), card(BEAR, 2)], [], 5);
    expect(powerOf(desperate, 2)).toBe(3);
    expect(powerOf(desperate, 1), 'OTHER creatures — not the Ironwright itself').toBe(1);
  });
});

describe('the predicate itself', () => {
  it('reads instance state for tapped, and is false for a source not on the battlefield', () => {
    const state = boardOf([card(BEAR, 1, { tapped: true })]);
    const bear = state.battlefield[0]!;
    expect(staticConditionHolds(state, bear, { kind: 'sourceTapped', tapped: true })).toBe(true);
    expect(staticConditionHolds(state, bear, { kind: 'sourceTapped', tapped: false })).toBe(false);
    expect(staticConditionHolds(state, bear, { kind: 'sourceAttacking' })).toBe(false);
  });
});
