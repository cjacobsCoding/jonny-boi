/**
 * CHARACTERISTIC PROVENANCE (§3.143 / UX-17) — the breakdown behind "why is this
 * 4/5 creature a 12/8?"
 *
 * The tests that matter here are not the happy-path ones. `explainCharacteristics`
 * is a SECOND walk over the sources `internal/continuous.ts` already folds, and a
 * second walk drifts. So the suite is built around three guards:
 *
 *   1. **It adds up.** On a battery of boards carrying every source family at once,
 *      base + the additive rows must equal `effectivePower`/`effectiveToughness`
 *      read through `indexContinuous` — the same accessors combat and state-based
 *      actions read — and every granted keyword and ability must be named by a row.
 *   2. **It refuses honestly.** What cannot be attributed comes back as an explicit
 *      `'unexplained'` row with `fullyAttributed: false`, never as silence, because
 *      a missing row reads to a player as "nothing changed it".
 *   3. **It cannot decay quietly.** The aggregation's hot path must still allocate
 *      nothing on a bare board and `AggregatedMod` must still have exactly its old
 *      shape; and a new modification field on `PermanentModification` or
 *      `ContinuousEffect` stops `tsc` at the coverage tables in `provenance.ts`.
 *
 * Caleb has complained, by name, that bugs he finds by playing should have been
 * caught by a test. Every row this file asserts is one of those.
 */

import { describe, expect, it } from 'vitest';
import {
  aggregateFor,
  CHARACTERISTIC_KINDS,
  CHARACTERISTIC_SUPPORT,
  CONTINUOUS_EFFECT_CHARACTERISTICS,
  CONTRIBUTION_LAYERS,
  CONTRIBUTION_MODES,
  CONTRIBUTION_SOURCE_KINDS,
  MODIFICATION_CHARACTERISTICS,
  UNEXPLAINED_SOURCE_NAME,
  VANISHED_SOURCE_NAME,
  effectiveActivated,
  effectiveKeywords,
  effectivePower,
  effectiveToughness,
  explainCharacteristics,
  indexContinuous,
  NO_MOD,
  type ActivatedAbility,
  type CardDefinition,
  type CardInstance,
  type CharacteristicContribution,
  type CharacteristicKind,
  type GameState,
  type InstanceId,
  type PlayerId,
} from './index.js';

// --- fixtures ---------------------------------------------------------------------

const BEAR: CardDefinition = {
  id: 'bear',
  name: 'Grizzly Bears',
  types: ['creature'],
  subtypes: ['Bear'],
  cost: { G: 1, generic: 1 },
  power: 2,
  toughness: 2,
  keywords: { vigilance: true },
};

/** "Creatures you control get +1/+1." */
const ANTHEM: CardDefinition = {
  id: 'anthem',
  name: 'Glorious Anthem',
  types: ['enchantment'],
  cost: { W: 1, generic: 2 },
  statics: [
    {
      affects: { anyOfTypes: ['creature'], controller: 'you' },
      power: 1,
      toughness: 1,
      label: 'Creatures you control get +1/+1.',
    },
  ],
};

/** "Other creatures you control get +1/+0 and have trample." */
const LORD: CardDefinition = {
  id: 'lord',
  name: 'Trample Lord',
  types: ['creature'],
  cost: { G: 2 },
  power: 3,
  toughness: 3,
  statics: [
    {
      affects: { anyOfTypes: ['creature'], controller: 'you', excludeSource: true },
      power: 1,
      keywords: { trample: true },
      label: 'Other creatures you control get +1/+0 and have trample.',
    },
  ],
};

/** "Enchanted creature gets +1/+1 and has flying." */
const AURA: CardDefinition = {
  id: 'aura',
  name: 'Ancestral Mask',
  types: ['enchantment'],
  subtypes: ['Aura'],
  cost: { G: 1, generic: 1 },
  attachment: {
    attachesTo: { anyOfTypes: ['creature'] },
    whenIllegal: 'graveyard',
    modifies: { power: 1, toughness: 1, keywords: { flying: true } },
    label: 'Enchanted creature gets +1/+1 and has flying.',
  },
};

/** "Equipped creature gets +2/+0." */
const EQUIPMENT: CardDefinition = {
  id: 'bonesplitter',
  name: 'Bonesplitter',
  types: ['artifact'],
  subtypes: ['Equipment'],
  cost: { generic: 1 },
  attachment: {
    attachesTo: { anyOfTypes: ['creature'], controller: 'you' },
    whenIllegal: 'unattach',
    modifies: { power: 2 },
    label: 'Equipped creature gets +2/+0.',
  },
};

/** An emblem radiating an anthem from the COMMAND zone (CR 114). */
const EMBLEM: CardDefinition = {
  id: 'emblem-anthem',
  name: 'Emblem — Creatures you control get +1/+0',
  types: ['emblem'],
  statics: [
    {
      affects: { anyOfTypes: ['creature'], controller: 'you' },
      power: 1,
      label: 'Creatures you control get +1/+0.',
    },
  ],
};

const MANA_ABILITY: ActivatedAbility = {
  cost: { tap: true },
  effects: [{ primitive: 'addMana', params: { color: 'C' } }],
  label: '{T}: Add {C}.',
};

/**
 * "Enchanted creature has haste and '{T}: Add {C}.'" — an attachment that grants a
 * keyword AND an activated ability, so it survives the `modificationIsInert` gate.
 */
const GRANTING_AURA: CardDefinition = {
  id: 'granting-aura',
  name: 'Freed from the Real',
  types: ['enchantment'],
  subtypes: ['Aura'],
  cost: { U: 1, generic: 2 },
  attachment: {
    attachesTo: { anyOfTypes: ['creature'] },
    whenIllegal: 'graveyard',
    modifies: { keywords: { haste: true }, activated: [MANA_ABILITY] },
    label: "Enchanted creature has haste and “{T}: Add {C}.”",
  },
};

/**
 * "Enchanted creature has '{T}: Add {C}.'" and NOTHING ELSE (Paradise Mantle).
 *
 * The fixture behind the divergence guard below: whether the engine grants this is
 * a question with ONE answer, and the breakdown must give the same one.
 */
const ACTIVATED_ONLY_ATTACHMENT: CardDefinition = {
  id: 'paradise-mantle',
  name: 'Paradise Mantle',
  types: ['artifact'],
  subtypes: ['Equipment'],
  cost: {},
  attachment: {
    attachesTo: { anyOfTypes: ['creature'], controller: 'you' },
    whenIllegal: 'unattach',
    modifies: { activated: [MANA_ABILITY] },
    label: "Equipped creature has “{T}: Add {C}.”",
  },
};

/** A `*`/`*` box — Tarmogoyf's shape (CR 613.4 layer 7a). */
const GOYF: CardDefinition = {
  id: 'goyf',
  name: 'Tarmogoyf',
  types: ['creature'],
  subtypes: ['Lhurgoyf'],
  cost: { G: 1, generic: 1 },
  characteristicPT: {
    power: { countOf: 'cardTypesInAllGraveyards' },
    toughness: { countOf: 'cardTypesInAllGraveyards', plus: 1 },
  },
};

/** "Creatures you control with power or toughness 1 or less can't be blocked." */
const TETSUKO: CardDefinition = {
  id: 'tetsuko',
  name: 'Tetsuko Umezawa, Fugitive',
  types: ['creature'],
  cost: { U: 1, generic: 1 },
  power: 1,
  toughness: 3,
  statics: [
    {
      affects: { anyOfTypes: ['creature'], controller: 'you', maxEffectivePowerOrToughness: 1 },
      keywords: { unblockable: true },
      label: "Creatures you control with power or toughness 1 or less can't be blocked.",
    },
  ],
};

/** "As ~ enters, choose a creature type. ~ is the chosen type." */
const SHAPESHIFTER: CardDefinition = {
  id: 'shapeshifter',
  name: 'Adaptive Shapeshifter',
  types: ['creature'],
  cost: { generic: 3 },
  power: 2,
  toughness: 2,
  isChosenSubtype: true,
};

/** The card a Clone fixture really is, under the copy. */
const CLONE: CardDefinition = {
  id: 'clone',
  name: 'Clone',
  types: ['creature'],
  subtypes: ['Shapeshifter'],
  cost: { U: 1, generic: 2 },
  power: 0,
  toughness: 0,
};

/**
 * What the Clone copied. An ARTIFACT creature on purpose (Phyrexian Metamorph's
 * case): copying is the only thing in this engine that changes a TYPE LINE, and a
 * fixture that copies a plain creature with a plain creature cannot show it.
 */
const COPIED_ARTIFACT_CREATURE: CardDefinition = {
  id: 'myr',
  name: 'Palladium Myr',
  types: ['artifact', 'creature'],
  subtypes: ['Myr'],
  cost: { generic: 4 },
  power: 1,
  toughness: 1,
};

/** The front face a transform fixture reverts to. */
const WEREWOLF_FRONT: CardDefinition = {
  id: 'werewolf',
  name: 'Village Ironsmith',
  types: ['creature'],
  subtypes: ['Human', 'Werewolf'],
  cost: { R: 1, generic: 2 },
  power: 1,
  toughness: 2,
};

const WEREWOLF_BACK: CardDefinition = {
  id: 'werewolf#back',
  name: 'Ironfang',
  types: ['creature'],
  subtypes: ['Werewolf'],
  power: 3,
  toughness: 2,
  keywords: { firstStrike: true },
};

const PUMP_SPELL: CardDefinition = {
  id: 'giant-growth',
  name: 'Giant Growth',
  types: ['instant'],
  cost: { G: 1 },
};

// --- board builder ----------------------------------------------------------------

/**
 * A hand-built `GameState` with only the fields the continuous layer and the
 * provenance walk read. Deliberately not a real `createGame` board: these tests are
 * about which SOURCES are seen, and a literal makes the board the test describes
 * visible in one screen.
 */
function emptyState(): GameState {
  return {
    battlefield: [],
    stack: [],
    continuous: [],
    nextInstanceId: 100,
    players: {
      A: { hand: [], library: [], graveyard: [], exile: [], command: [] },
      B: { hand: [], library: [], graveyard: [], exile: [], command: [] },
    },
  } as unknown as GameState;
}

let nextId = 1;

function instanceOf(
  def: CardDefinition,
  zone: CardInstance['zone'],
  controller: PlayerId = 'A',
  owner: PlayerId = controller,
): CardInstance {
  return {
    instanceId: nextId++,
    def,
    controller,
    owner,
    zone,
    tapped: false,
    summoningSick: false,
    damageMarked: 0,
    markedByDeathtouch: false,
    attachedTo: null,
    counters: {},
  } as CardInstance;
}

function place(state: GameState, def: CardDefinition, controller: PlayerId = 'A'): CardInstance {
  const inst = instanceOf(def, 'battlefield', controller);
  state.battlefield.push(inst);
  return inst;
}

function placeIn(
  state: GameState,
  def: CardDefinition,
  zone: 'graveyard' | 'command' | 'hand' | 'exile',
  controller: PlayerId = 'A',
): CardInstance {
  const inst = instanceOf(def, zone, controller);
  state.players[controller][zone].push(inst);
  return inst;
}

function attach(attachment: CardInstance, host: CardInstance): CardInstance {
  (attachment as { attachedTo: InstanceId | null }).attachedTo = host.instanceId;
  return attachment;
}

function setCounters(inst: CardInstance, counters: Record<string, number>): CardInstance {
  (inst as { counters: Record<string, number> }).counters = counters;
  return inst;
}

function pump(
  state: GameState,
  target: CardInstance,
  source: InstanceId,
  mod: { power?: number; toughness?: number; keywords?: CardDefinition['keywords'] },
): void {
  state.continuous.push({
    id: state.continuous.length + 1,
    targetInstanceId: target.instanceId,
    sourceInstanceId: source,
    duration: 'endOfTurn',
    ...mod,
  });
}

/** The explanation, or a hard failure — every test here has a real instance. */
function explain(state: GameState, inst: CardInstance) {
  const explanation = explainCharacteristics(state, inst.instanceId);
  expect(explanation, 'explainCharacteristics returned undefined for a live instance').toBeDefined();
  return explanation!;
}

function rowsFor(
  contributions: readonly CharacteristicContribution[],
  characteristic: CharacteristicKind,
): readonly CharacteristicContribution[] {
  return contributions.filter((row) => row.characteristic === characteristic);
}

/** The additive total a breakdown claims for one stat — the thing that must add up. */
function additiveTotal(
  contributions: readonly CharacteristicContribution[],
  characteristic: 'power' | 'toughness',
): number {
  let total = 0;
  for (const row of rowsFor(contributions, characteristic)) {
    if (row.mode === 'add' && row.amount !== undefined) total += row.amount;
  }
  return total;
}

// --- the boards under test --------------------------------------------------------

/**
 * EVERY source family at once, on one creature: a printed 2/2 under two battlefield
 * statics, an aura, an equipment, a command-zone emblem, an until-end-of-turn pump
 * from a spell now in the graveyard, and a net +1/+1 of counters.
 */
function kitchenSink(): { state: GameState; bear: CardInstance; spell: CardInstance } {
  const state = emptyState();
  const bear = place(state, BEAR);
  setCounters(bear, { '+1/+1': 2, '-1/-1': 1 });
  place(state, ANTHEM);
  place(state, LORD);
  attach(place(state, AURA), bear);
  attach(place(state, EQUIPMENT), bear);
  placeIn(state, EMBLEM, 'command');
  const spell = placeIn(state, PUMP_SPELL, 'graveyard');
  pump(state, bear, spell.instanceId, { power: 3, toughness: 3, keywords: { trample: true } });
  return { state, bear, spell };
}

// --- 1. IT ADDS UP ----------------------------------------------------------------

describe('the breakdown adds up to the numbers the rules use', () => {
  it('base + every additive row equals effectivePower/effectiveToughness', () => {
    const { state, bear } = kitchenSink();
    const mod = indexContinuous(state).get(bear.instanceId) ?? NO_MOD;
    const explanation = explain(state, bear);

    // The headline numbers ARE the engine's — not a re-derivation.
    expect(explanation.power).toBe(effectivePower(bear, mod));
    expect(explanation.toughness).toBe(effectiveToughness(bear, mod));

    // 2 printed +1 anthem +1 lord +1 aura +2 equip +1 emblem +3 pump +1 counters.
    expect(explanation.power).toBe(12);
    expect(explanation.toughness).toBe(8);

    expect(explanation.basePower + additiveTotal(explanation.contributions, 'power')).toBe(
      explanation.power,
    );
    expect(explanation.baseToughness + additiveTotal(explanation.contributions, 'toughness')).toBe(
      explanation.toughness,
    );
    expect(explanation.fullyAttributed).toBe(true);
  });

  it('every GRANTED keyword is named by a row, and printed ones are not mistaken for granted', () => {
    const { state, bear } = kitchenSink();
    const mod = indexContinuous(state).get(bear.instanceId) ?? NO_MOD;
    const explanation = explain(state, bear);

    const named = new Set(rowsFor(explanation.contributions, 'keyword').map((row) => row.detail));
    for (const key of Object.keys(mod.keywords)) {
      expect(named, `granted keyword '${key}' has no contribution row`).toContain(key);
    }
    // flying from the aura, trample from the lord AND from the pump (two rows, one flag).
    expect(named).toEqual(new Set(['flying', 'trample']));
    expect(rowsFor(explanation.contributions, 'keyword')).toHaveLength(3);

    // vigilance is PRINTED: effective, but never a contribution.
    expect(effectiveKeywords(bear, mod).vigilance).toBe(true);
    expect(explanation.printedKeywords.vigilance).toBe(true);
    expect(named.has('vigilance')).toBe(false);
  });

  it('a stacked board names EVERY contributing card, once per modification', () => {
    const { state, bear } = kitchenSink();
    const explanation = explain(state, bear);
    const powerSources = rowsFor(explanation.contributions, 'power')
      .filter((row) => row.mode === 'add')
      .map((row) => `${row.source.name} ${row.amount! > 0 ? '+' : ''}${row.amount}`);
    expect(powerSources.sort()).toEqual(
      [
        'Ancestral Mask +1',
        'Bonesplitter +2',
        'Emblem — Creatures you control get +1/+0 +1',
        'Giant Growth +3',
        'Glorious Anthem +1',
        // The two counter KINDS are two rows, not one netted number: a player who
        // sees "-1" wants to know a -1/-1 counter is sitting there, and CR 704.5q
        // makes the pair a real, separately-inspectable piece of state.
        'Grizzly Bears +2',
        'Grizzly Bears -1',
        'Trample Lord +1',
      ].sort(),
    );
  });

  it('rows carry the printed wording the card declared for the modification', () => {
    const { state, bear } = kitchenSink();
    const explanation = explain(state, bear);
    const aura = explanation.contributions.find((row) => row.source.name === 'Ancestral Mask');
    expect(aura?.source.label).toBe('Enchanted creature gets +1/+1 and has flying.');
    const anthem = explanation.contributions.find((row) => row.source.name === 'Glorious Anthem');
    expect(anthem?.source.label).toBe('Creatures you control get +1/+1.');
  });

  it('counters are rows, not a subtraction — a +1/+1 and a -1/-1 are both named', () => {
    const { state, bear } = kitchenSink();
    const explanation = explain(state, bear);
    const counterRows = explanation.contributions.filter((row) => row.layer === 'counters');
    expect(counterRows.map((row) => `${row.characteristic} ${row.detail} ${row.amount}`).sort()).toEqual(
      [
        'power +1/+1 2',
        'toughness +1/+1 2',
        'power -1/-1 -1',
        'toughness -1/-1 -1',
      ].sort(),
    );
    for (const row of counterRows) expect(row.source.kind).toBe('counter');
  });

  it('rows come back in CR 613 reading order, with the array as the only sort key', () => {
    const { state, bear } = kitchenSink();
    const explanation = explain(state, bear);
    const order = explanation.contributions.map((row) => CONTRIBUTION_LAYERS.indexOf(row.layer));
    for (let i = 1; i < order.length; i++) {
      expect(order[i]! >= order[i - 1]!, 'contributions are not sorted by layer').toBe(true);
    }
  });
});

// --- the characteristic-defining box ----------------------------------------------

describe('a characteristic-defining P/T is a BASE, never a badge', () => {
  it('reports the formula value as the base with a basePT row, not 0/0 plus a delta', () => {
    const state = emptyState();
    const goyf = place(state, GOYF);
    // Three card types in graveyards → a 3/4 before anything else touches it.
    placeIn(state, BEAR, 'graveyard');
    placeIn(state, PUMP_SPELL, 'graveyard');
    placeIn(state, AURA, 'graveyard', 'B');

    const explanation = explain(state, goyf);
    expect(explanation.basePower).toBe(3);
    expect(explanation.baseToughness).toBe(4);
    expect(explanation.power).toBe(3);
    expect(explanation.toughness).toBe(4);
    // The printed box is EMPTY — this is the defect a `def.power` read reproduces.
    expect(GOYF.power).toBeUndefined();

    const basePT = explanation.contributions.filter((row) => row.layer === 'basePT');
    expect(basePT.map((row) => `${row.characteristic}=${row.amount}`)).toEqual([
      'power=3',
      'toughness=4',
    ]);
    for (const row of basePT) expect(row.mode).toBe('replace');
    expect(explanation.fullyAttributed).toBe(true);
  });

  it('counters and anthems stack ON TOP of the formula base, and still add up', () => {
    const state = emptyState();
    const goyf = setCounters(place(state, GOYF), { '+1/+1': 1 });
    place(state, ANTHEM);
    placeIn(state, BEAR, 'graveyard');

    const mod = indexContinuous(state).get(goyf.instanceId) ?? NO_MOD;
    const explanation = explain(state, goyf);
    expect(explanation.basePower).toBe(1);
    expect(explanation.power).toBe(effectivePower(goyf, mod));
    expect(explanation.power).toBe(3); // 1 base + 1 counter + 1 anthem
    expect(explanation.basePower + additiveTotal(explanation.contributions, 'power')).toBe(
      explanation.power,
    );
    expect(explanation.fullyAttributed).toBe(true);
  });
});

// --- the effective-P/T static, which the aggregation defers ------------------------

describe('a static whose selector reads EFFECTIVE P/T is attributed the way it applies', () => {
  it('grants the keyword — and the breakdown says which card did', () => {
    const state = emptyState();
    place(state, TETSUKO);
    const small = place(state, { ...BEAR, id: 'mouse', name: 'Mouse', power: 1, toughness: 1 });
    const mod = indexContinuous(state).get(small.instanceId) ?? NO_MOD;
    expect(effectiveKeywords(small, mod).unblockable).toBe(true);

    const explanation = explain(state, small);
    const row = rowsFor(explanation.contributions, 'keyword').find((r) => r.detail === 'unblockable');
    expect(row?.source.name).toBe('Tetsuko Umezawa, Fugitive');
    expect(row?.layer).toBe('ability');
    expect(explanation.fullyAttributed).toBe(true);
  });

  it('an anthem lifts the creature OUT of the selector — and out of the breakdown too', () => {
    // THE divergence this test exists for: the aggregation applies these against
    // SETTLED P/T, so a second walk that used the printed box would show a keyword
    // the board does not have. Both must agree that the buff removed the evasion.
    const state = emptyState();
    place(state, TETSUKO);
    place(state, ANTHEM);
    const small = place(state, { ...BEAR, id: 'mouse', name: 'Mouse', power: 1, toughness: 1 });

    const mod = indexContinuous(state).get(small.instanceId) ?? NO_MOD;
    expect(effectiveKeywords(small, mod).unblockable).toBeFalsy();

    const explanation = explain(state, small);
    expect(rowsFor(explanation.contributions, 'keyword').map((row) => row.detail)).not.toContain(
      'unblockable',
    );
    expect(explanation.fullyAttributed).toBe(true);
  });
});

// --- granted activated abilities --------------------------------------------------

describe('granted ACTIVATED abilities', () => {
  it('an aura that grants a keyword and an ability produces a row for the ability', () => {
    const state = emptyState();
    const bear = place(state, BEAR);
    attach(place(state, GRANTING_AURA), bear);

    const mod = indexContinuous(state).get(bear.instanceId) ?? NO_MOD;
    const explanation = explain(state, bear);
    expect(explanation.activated).toHaveLength(effectiveActivated(bear, mod).length);
    const row = rowsFor(explanation.contributions, 'activatedAbility')[0];
    expect(row?.detail).toBe('{T}: Add {C}.');
    expect(row?.source.name).toBe('Freed from the Real');
    expect(row?.layer).toBe('ability');
    expect(explanation.fullyAttributed).toBe(true);
  });

  it('DIVERGENCE GUARD: the breakdown reports a grant exactly when the engine makes one', () => {
    // An attachment whose `modifies` carries ONLY `activated` (Paradise Mantle).
    // Whether that grant happens is a question with ONE answer — `effectiveActivated`
    // over the index. This asserts the breakdown gives the same one, whichever it is,
    // so the day the engine's inertness rule changes both move together instead of a
    // tooltip promising an ability the board does not offer.
    const state = emptyState();
    const bear = place(state, BEAR);
    attach(place(state, ACTIVATED_ONLY_ATTACHMENT), bear);

    const mod = indexContinuous(state).get(bear.instanceId) ?? NO_MOD;
    const granted = effectiveActivated(bear, mod).length - (BEAR.activated?.length ?? 0);
    const explanation = explain(state, bear);
    expect(rowsFor(explanation.contributions, 'activatedAbility')).toHaveLength(granted);
    expect(explanation.fullyAttributed).toBe(true);
  });
});

// --- 2. IT REFUSES HONESTLY -------------------------------------------------------

describe('honest closure — what cannot be attributed says so', () => {
  it("a control change names the effect that took it", () => {
    const state = emptyState();
    const thief = place(state, ANTHEM, 'B');
    const stolen = place(state, BEAR, 'B');
    (stolen as { owner: PlayerId }).owner = 'A';
    state.continuous.push({
      id: 1,
      targetInstanceId: stolen.instanceId,
      sourceInstanceId: thief.instanceId,
      duration: 'endOfTurn',
      controlChange: { instanceId: stolen.instanceId, from: 'A', to: 'B' },
    });

    const explanation = explain(state, stolen);
    const row = rowsFor(explanation.contributions, 'controller')[0];
    expect(row?.mode).toBe('replace');
    expect(row?.previous).toBe('A');
    expect(row?.detail).toBe('B');
    expect(row?.source.name).toBe('Glorious Anthem');
    expect(explanation.fullyAttributed).toBe(true);
  });

  it('a control change with NO record left is an explicit "source unknown" row, never silence', () => {
    // Reachable today: a blink drops the continuous effect and keeps the theft, so
    // the permanent is genuinely under another player with nothing left to name.
    // Omitting the row would read to a player as "nobody took this", which is a lie.
    const state = emptyState();
    const stolen = place(state, BEAR, 'B');
    (stolen as { owner: PlayerId }).owner = 'A';

    const explanation = explain(state, stolen);
    const row = rowsFor(explanation.contributions, 'controller')[0];
    expect(row?.source.kind).toBe('unexplained');
    expect(row?.source.name).toBe(UNEXPLAINED_SOURCE_NAME);
    // The LAYER is still known — a control change is CR 613's layer 2 whoever made
    // it. Only the source is missing, and the two are separate axes: collapsing
    // them into "unknown" would throw away the half of the answer we have.
    expect(row?.layer).toBe('control');
    expect(row?.previous).toBe('A');
    expect(row?.detail).toBe('B');
    expect(explanation.fullyAttributed).toBe(false);
  });

  it('a row that cannot be placed in a LAYER sorts last', () => {
    expect(CONTRIBUTION_LAYERS[CONTRIBUTION_LAYERS.length - 1]).toBe('unknown');
  });

  it('a pump whose source has ceased to exist is still a NAMED row with an honest zone', () => {
    // CR 111.7 — a token that pumped and then died exists in no zone. Dropping the
    // row would make the contributions stop summing, and the reconciliation would
    // then blame the arithmetic for what is really a lookup miss.
    const state = emptyState();
    const bear = place(state, BEAR);
    const index = indexContinuous(state);
    expect(index.get(bear.instanceId)).toBeUndefined();

    pump(state, bear, 9999 as InstanceId, { power: 2, keywords: { menace: true } });
    const explanation = explain(state, bear);
    expect(explanation.fullyAttributed).toBe(true);
    const row = rowsFor(explanation.contributions, 'power')[0];
    expect(row?.source.name).toBe(VANISHED_SOURCE_NAME);
    expect(row?.source.zone).toBe('unknown');
    expect(explanation.basePower + additiveTotal(explanation.contributions, 'power')).toBe(
      explanation.power,
    );
  });

  it('a resolved spell still in the graveyard is named, with its real zone', () => {
    const { state, bear, spell } = kitchenSink();
    const explanation = explain(state, bear);
    const row = explanation.contributions.find((r) => r.source.instanceId === spell.instanceId);
    expect(row?.source.name).toBe('Giant Growth');
    expect(row?.source.zone).toBe('graveyard');
    expect(row?.source.kind).toBe('temporary');
    expect(row?.source.cardId).toBe('giant-growth');
  });

  it('an id that exists in no zone returns undefined rather than throwing', () => {
    const state = emptyState();
    expect(explainCharacteristics(state, 4242 as InstanceId)).toBeUndefined();
  });

  it('a card in hand is a legitimate question whose answer is an EMPTY list', () => {
    const state = emptyState();
    place(state, ANTHEM);
    const inHand = placeIn(state, BEAR, 'hand');
    const explanation = explain(state, inHand);
    expect(explanation.contributions).toEqual([]);
    expect(explanation.fullyAttributed).toBe(true);
    // The anthem does NOT reach it: statics only touch permanents in play.
    expect(explanation.power).toBe(2);
  });
});

// --- whole-definition swaps: the only name/type/colour changes there are -----------

describe('copy and transform — the changes that are a whole new card underneath', () => {
  it('a copy reports name, types, subtypes, colours, mana cost and P/T as REPLACED', () => {
    const state = emptyState();
    const clone = place(state, COPIED_ARTIFACT_CREATURE);
    (clone as { uncopiedDef: CardDefinition }).uncopiedDef = CLONE;

    const explanation = explain(state, clone);
    const copyRows = explanation.contributions.filter((row) => row.layer === 'copy');
    const byCharacteristic = new Map(copyRows.map((row) => [row.characteristic, row]));
    expect([...byCharacteristic.keys()].sort()).toEqual(
      ['colors', 'manaCost', 'name', 'power', 'subtypes', 'toughness', 'types'].sort(),
    );
    expect(byCharacteristic.get('name')?.previous).toBe('Clone');
    expect(byCharacteristic.get('name')?.detail).toBe('Palladium Myr');
    expect(byCharacteristic.get('types')?.previous).toBe('creature');
    expect(byCharacteristic.get('types')?.detail).toBe('artifact creature');
    expect(byCharacteristic.get('subtypes')?.previous).toBe('Shapeshifter');
    expect(byCharacteristic.get('subtypes')?.detail).toBe('Myr');
    // The copy is COLOURLESS — it is the copied card's pips that decide, not the
    // copier's. This is the one thing in the engine that changes a colour.
    expect(byCharacteristic.get('colors')?.previous).toBe('U');
    expect(byCharacteristic.get('colors')?.detail).toBe('');
    for (const row of copyRows) expect(row.mode).toBe('replace');
    // A `replace` row states a base; it must NOT enter the additive sum.
    expect(additiveTotal(explanation.contributions, 'power')).toBe(0);
    expect(explanation.power).toBe(1);
  });

  it('a transformed permanent reports the front face it came from', () => {
    const state = emptyState();
    const wolf = place(state, WEREWOLF_BACK);
    (wolf as { printedDef: CardDefinition }).printedDef = WEREWOLF_FRONT;

    const explanation = explain(state, wolf);
    const faceRows = explanation.contributions.filter((row) => row.layer === 'face');
    const name = faceRows.find((row) => row.characteristic === 'name');
    expect(name?.previous).toBe('Village Ironsmith');
    expect(name?.detail).toBe('Ironfang');
    expect(faceRows.some((row) => row.characteristic === 'power')).toBe(true);
    // firstStrike is PRINTED on the back face, so it is not an aftermarket grant.
    expect(explanation.printedKeywords.firstStrike).toBe(true);
    expect(rowsFor(explanation.contributions, 'keyword')).toEqual([]);
  });

  it('"as ~ enters, choose a type" is an ADDED subtype with the permanent as its own source', () => {
    const state = emptyState();
    const shifter = place(state, SHAPESHIFTER);
    (shifter as { chosenAsEntered?: string }).chosenAsEntered = 'Goblin';

    const explanation = explain(state, shifter);
    const row = rowsFor(explanation.contributions, 'subtypes')[0];
    expect(row?.layer).toBe('type');
    expect(row?.mode).toBe('add');
    expect(row?.detail).toBe('Goblin');
    expect(row?.source.kind).toBe('self');
  });

  it('a permanent that named NOTHING adds nothing — never "every type"', () => {
    const state = emptyState();
    const shifter = place(state, SHAPESHIFTER);
    const explanation = explain(state, shifter);
    expect(rowsFor(explanation.contributions, 'subtypes')).toEqual([]);
  });
});

// --- 3. IT CANNOT DECAY QUIETLY ---------------------------------------------------

describe('the hot path did not grow (CLAUDE.md rule 7)', () => {
  it('a bare board still returns the SHARED empty index — no allocation, same object', () => {
    const state = emptyState();
    place(state, BEAR);
    place(state, { ...BEAR, id: 'bear2', name: 'Runeclaw Bear' });
    expect(indexContinuous(state)).toBe(indexContinuous(state));
    expect(indexContinuous(state).size).toBe(0);
  });

  it('AggregatedMod still has exactly its old shape — attribution added no field', () => {
    const state = emptyState();
    const bear = place(state, BEAR);
    pump(state, bear, bear.instanceId, { power: 3, toughness: 3 });
    const fromIndex = indexContinuous(state).get(bear.instanceId)!;
    expect(Object.keys(fromIndex).sort()).toEqual(['keywords', 'power', 'toughness']);
    expect(Object.keys(aggregateFor(state, bear.instanceId)).sort()).toEqual([
      'keywords',
      'power',
      'toughness',
    ]);
    expect(Object.keys(NO_MOD).sort()).toEqual(['keywords', 'power', 'toughness']);
  });

  it('a caller that already built the index can hand it over instead of forcing N rebuilds', () => {
    // What a board renderer does: one index per pass, every tile reading through it.
    // The answer must be identical to the one a fresh build gives.
    const { state, bear } = kitchenSink();
    const index = indexContinuous(state);
    const shared = explainCharacteristics(state, bear.instanceId, index);
    const fresh = explainCharacteristics(state, bear.instanceId);
    expect(shared).toEqual(fresh);
  });

  it('a characteristic-defining permanent adds only the two base fields, as before', () => {
    const state = emptyState();
    const goyf = place(state, GOYF);
    const mod = indexContinuous(state).get(goyf.instanceId)!;
    expect(Object.keys(mod).sort()).toEqual([
      'baseToughness',
      'basePower',
      'keywords',
      'power',
      'toughness',
    ].sort());
  });
});

describe('the closure tables cannot claim what they do not do', () => {
  it('every modification field of PermanentModification maps to a real characteristic', () => {
    // The compile-time half of this guard is in `provenance.ts`: the table is a
    // MAPPED TYPE, so adding a field to `PermanentModification` stops `tsc` until
    // it is classified. This is the runtime half — that what it maps to is real.
    for (const [field, characteristic] of Object.entries(MODIFICATION_CHARACTERISTICS)) {
      expect(CHARACTERISTIC_KINDS, `'${field}' maps outside the table`).toContain(characteristic);
    }
    expect(Object.keys(MODIFICATION_CHARACTERISTICS).sort()).toEqual([
      'activated',
      'keywords',
      'power',
      'toughness',
    ]);
  });

  it('every modifying field of ContinuousEffect maps to a real characteristic', () => {
    for (const [field, characteristic] of Object.entries(CONTINUOUS_EFFECT_CHARACTERISTICS)) {
      expect(CHARACTERISTIC_KINDS, `'${field}' maps outside the table`).toContain(characteristic);
    }
    expect(Object.keys(CONTINUOUS_EFFECT_CHARACTERISTICS).sort()).toEqual([
      'controlChange',
      'keywords',
      'power',
      'toughness',
    ]);
  });

  it('every characteristic the table calls MODIFIABLE is produced by a real board', () => {
    // The table cannot advertise a capability nothing exercises. If a kind is added
    // and marked modifiable, this fails until a fixture above actually produces it.
    const produced = new Set<CharacteristicKind>();
    for (const row of everyContributionInThisSuite()) produced.add(row.characteristic);
    for (const kind of CHARACTERISTIC_KINDS) {
      if (!CHARACTERISTIC_SUPPORT[kind].modifiable) continue;
      expect(produced, `no fixture produces a '${kind}' contribution`).toContain(kind);
    }
  });

  it('nothing claims to REMOVE anything, and nothing emits a remove row', () => {
    // Ability removal does not exist in this engine: a grant sets a flag and never
    // clears one, and `MODIFICATION_IS_PURELY_ADDITIVE` stops the build if a
    // clearing field appears. The `'remove'` mode is declared so the struck-through
    // rendering is written once; until then BOTH halves must say so.
    for (const kind of CHARACTERISTIC_KINDS) {
      expect(CHARACTERISTIC_SUPPORT[kind].removable, `${kind} claims removability`).toBe(false);
    }
    for (const row of everyContributionInThisSuite()) {
      expect(row.mode, 'a remove row was produced while the table denies removability').not.toBe(
        'remove',
      );
    }
    expect(CONTRIBUTION_MODES).toContain('remove');
  });

  it('every row uses a layer, mode and source kind from the closed tables', () => {
    for (const row of everyContributionInThisSuite()) {
      expect(CONTRIBUTION_LAYERS).toContain(row.layer);
      expect(CONTRIBUTION_MODES).toContain(row.mode);
      expect(CONTRIBUTION_SOURCE_KINDS).toContain(row.source.kind);
      expect(CHARACTERISTIC_KINDS).toContain(row.characteristic);
    }
  });

  it('every characteristic carries a player-facing sentence about what can change it', () => {
    for (const kind of CHARACTERISTIC_KINDS) {
      const support = CHARACTERISTIC_SUPPORT[kind];
      expect(support.note.length, `${kind} has no note`).toBeGreaterThan(20);
      for (const layer of support.layers) expect(CONTRIBUTION_LAYERS).toContain(layer);
    }
  });
});

// --- the twin guard: `indexContinuous` and `aggregateFor` must agree --------------

/**
 * "Creatures you control have haste and '{T}: Add {C}.'" — a static that grants an
 * ACTIVATED ability as well as a keyword, so it survives the inertness gate.
 */
const GRANTING_LORD: CardDefinition = {
  id: 'granting-lord',
  name: 'Cryptolith Rite',
  types: ['enchantment'],
  cost: { G: 1, generic: 1 },
  statics: [
    {
      affects: { anyOfTypes: ['creature'], controller: 'you' },
      keywords: { haste: true },
      activated: [MANA_ABILITY],
      label: 'Creatures you control have haste and “{T}: Add {C}.”',
    },
  ],
};

describe('the two aggregation accessors are TWINS and must never disagree', () => {
  // This suite is here rather than beside `indexContinuous` because the provenance
  // walk is the THIRD reader of these sources, and building it is what exposed the
  // divergences below. The engine OFFERS a permanent's abilities through the bulk
  // index and APPLIES the chosen one through `aggregateFor` by the same integer
  // index, and combat reads one while a resolving primitive reads the other — so a
  // disagreement is a wrong answer, not a missing feature. `internal/continuous.ts`
  // already records this class biting once (emblems). It bit twice more.
  const boards: readonly { readonly name: string; readonly build: () => GameState }[] = [
    { name: 'every source family at once', build: () => kitchenSink().state },
    {
      name: 'an aura granting a keyword AND an activated ability',
      build: () => {
        const state = emptyState();
        const bear = place(state, BEAR);
        attach(place(state, GRANTING_AURA), bear);
        return state;
      },
    },
    {
      name: 'a lord granting an activated ability to the team',
      build: () => {
        const state = emptyState();
        place(state, BEAR);
        place(state, GRANTING_LORD);
        return state;
      },
    },
    {
      name: 'an effective-P/T static, with the creature INSIDE the bound',
      build: () => {
        const state = emptyState();
        place(state, TETSUKO);
        place(state, { ...BEAR, id: 'mouse', name: 'Mouse', power: 1, toughness: 1 });
        return state;
      },
    },
    {
      name: 'an effective-P/T static, with an anthem lifting the creature OUT of the bound',
      build: () => {
        const state = emptyState();
        place(state, TETSUKO);
        place(state, ANTHEM);
        place(state, { ...BEAR, id: 'mouse', name: 'Mouse', power: 1, toughness: 1 });
        return state;
      },
    },
    {
      name: 'an emblem radiating from the command zone',
      build: () => {
        const state = emptyState();
        place(state, BEAR);
        placeIn(state, EMBLEM, 'command');
        return state;
      },
    },
    {
      name: 'a characteristic-defining box beside an anthem',
      build: () => {
        const state = emptyState();
        place(state, GOYF);
        place(state, ANTHEM);
        placeIn(state, PUMP_SPELL, 'graveyard');
        return state;
      },
    },
  ];

  for (const board of boards) {
    it(`agrees on every permanent — ${board.name}`, () => {
      const state = board.build();
      const index = indexContinuous(state);
      for (const perm of state.battlefield) {
        const bulk = index.get(perm.instanceId) ?? NO_MOD;
        const single = aggregateFor(state, perm.instanceId);
        const where = `${perm.def.name}#${perm.instanceId}`;
        expect(effectivePower(perm, single), `power: ${where}`).toBe(effectivePower(perm, bulk));
        expect(effectiveToughness(perm, single), `toughness: ${where}`).toBe(
          effectiveToughness(perm, bulk),
        );
        expect(effectiveKeywords(perm, single), `keywords: ${where}`).toEqual(
          effectiveKeywords(perm, bulk),
        );
        expect(
          effectiveActivated(perm, single).map((a) => a.label),
          `activated: ${where}`,
        ).toEqual(effectiveActivated(perm, bulk).map((a) => a.label));
      }
    });

    it(`and the breakdown matches both — ${board.name}`, () => {
      const state = board.build();
      const index = indexContinuous(state);
      for (const perm of state.battlefield) {
        const explanation = explain(state, perm);
        const mod = index.get(perm.instanceId) ?? NO_MOD;
        const where = `${perm.def.name}#${perm.instanceId}`;
        expect(explanation.power, `power: ${where}`).toBe(effectivePower(perm, mod));
        expect(
          explanation.basePower + additiveTotal(explanation.contributions, 'power'),
          `power sum: ${where}`,
        ).toBe(explanation.power);
        expect(
          explanation.baseToughness + additiveTotal(explanation.contributions, 'toughness'),
          `toughness sum: ${where}`,
        ).toBe(explanation.toughness);
        expect(explanation.fullyAttributed, `fully attributed: ${where}`).toBe(true);
      }
    });
  }
});

/**
 * Every contribution any board in this file produces, in one list — the corpus the
 * closure tests are asserted against. Rebuilt per call so no test can pollute
 * another's fixtures.
 */
function everyContributionInThisSuite(): readonly CharacteristicContribution[] {
  const rows: CharacteristicContribution[] = [];

  const sink = kitchenSink();
  rows.push(...explain(sink.state, sink.bear).contributions);

  const grantState = emptyState();
  const granted = place(grantState, BEAR);
  attach(place(grantState, GRANTING_AURA), granted);
  rows.push(...explain(grantState, granted).contributions);

  const goyfState = emptyState();
  const goyf = place(goyfState, GOYF);
  placeIn(goyfState, BEAR, 'graveyard');
  rows.push(...explain(goyfState, goyf).contributions);

  const copyState = emptyState();
  const clone = place(copyState, COPIED_ARTIFACT_CREATURE);
  (clone as { uncopiedDef: CardDefinition }).uncopiedDef = CLONE;
  rows.push(...explain(copyState, clone).contributions);

  const faceState = emptyState();
  const wolf = place(faceState, WEREWOLF_BACK);
  (wolf as { printedDef: CardDefinition }).printedDef = WEREWOLF_FRONT;
  rows.push(...explain(faceState, wolf).contributions);

  const typeState = emptyState();
  const shifter = place(typeState, SHAPESHIFTER);
  (shifter as { chosenAsEntered?: string }).chosenAsEntered = 'Goblin';
  rows.push(...explain(typeState, shifter).contributions);

  const controlState = emptyState();
  const thief = place(controlState, ANTHEM, 'B');
  const stolen = place(controlState, BEAR, 'B');
  (stolen as { owner: PlayerId }).owner = 'A';
  controlState.continuous.push({
    id: 1,
    targetInstanceId: stolen.instanceId,
    sourceInstanceId: thief.instanceId,
    duration: 'endOfTurn',
    controlChange: { instanceId: stolen.instanceId, from: 'A', to: 'B' },
  });
  rows.push(...explain(controlState, stolen).contributions);

  return rows;
}
