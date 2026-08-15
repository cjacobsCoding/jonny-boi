/**
 * The attachment layer: the relationship, the layering, and — the part that rots
 * if it is done by hand per card — the state-based actions.
 *
 * The SBA cases are each tested EXPLICITLY rather than trusted to a full game,
 * because the failure mode is a board that looks right: an Aura that outlives the
 * creature it enchanted keeps handing out its buff to a dead id forever, and
 * nothing in a win-rate ever says so.
 */

import { describe, expect, it } from 'vitest';
import type { CardDefinition, GameEvent, GameState, InstanceId } from './index.js';
import {
  AURA_WHEN_ILLEGAL,
  EQUIPMENT_WHEN_ILLEGAL,
  attachTo,
  attachmentProblem,
  createGame,
  effectivePower,
  effectiveToughness,
  effectiveKeywords,
  illegalAttachmentReason,
  isLegallyAttached,
} from './index.js';
import { checkStateBasedActions } from './internal/sba.js';
import { aggregateFor, indexContinuous, NO_MOD } from './internal/continuous.js';
import { creatureDef, deckOf, landDef } from './test-fixtures.js';
import type { CardInstance } from './state.js';

const FOREST = landDef('Forest', 'G');

/** "Enchant creature — Enchanted creature gets +2/+1." (Unholy Strength). */
const UNHOLY_STRENGTH: CardDefinition = {
  id: 'unholy-strength',
  name: 'Unholy Strength',
  types: ['enchantment'],
  subtypes: ['aura'],
  cost: { B: 1 },
  attachment: {
    attachesTo: { anyOfTypes: ['creature'] },
    whenIllegal: AURA_WHEN_ILLEGAL,
    modifies: { power: 2, toughness: 1 },
  },
  effects: [{ primitive: 'attachToTarget', params: { targets: 'creature' } }],
};

/** An Aura that grants a keyword only ("Enchanted creature has flying"). */
const FLIGHT: CardDefinition = {
  id: 'flight',
  name: 'Flight',
  types: ['enchantment'],
  subtypes: ['aura'],
  cost: { U: 1 },
  attachment: {
    attachesTo: { anyOfTypes: ['creature'] },
    whenIllegal: AURA_WHEN_ILLEGAL,
    modifies: { keywords: { flying: true } },
  },
};

/** "Equipped creature gets +2/+0. Equip {1}" (Bonesplitter). */
const BONESPLITTER: CardDefinition = {
  id: 'bonesplitter',
  name: 'Bonesplitter',
  types: ['artifact'],
  subtypes: ['equipment'],
  cost: { generic: 1 },
  attachment: {
    attachesTo: { anyOfTypes: ['creature'], controller: 'you' },
    whenIllegal: EQUIPMENT_WHEN_ILLEGAL,
    modifies: { power: 2 },
  },
  activated: [
    {
      cost: { mana: { generic: 1 } },
      effects: [{ primitive: 'attachToTarget', params: { targets: 'creatureYouControl' } }],
      timing: 'sorcery',
      label: 'Equip {1}',
    },
  ],
};

/** An anthem, so the layering test has all four layers at once. */
const ANTHEM: CardDefinition = {
  id: 'anthem',
  name: 'Glorious Anthem',
  types: ['enchantment'],
  cost: { W: 1, generic: 2 },
  statics: [{ affects: { anyOfTypes: ['creature'], controller: 'you' }, power: 1, toughness: 1 }],
};

const BEAR = creatureDef('bear', 2, 2);

/** A bare state with an empty board, ready to have permanents placed on it. */
function emptyBoard(): GameState {
  const created = createGame({ seed: 7, decks: { A: deckOf(FOREST, 20), B: deckOf(FOREST, 20) } });
  const state = created.state;
  state.battlefield = [];
  return state;
}

/** Put a permanent on the battlefield under `controller` and return it. */
function place(state: GameState, def: CardDefinition, controller: 'A' | 'B' = 'A'): CardInstance {
  const inst: CardInstance = {
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
    attachedTo: null,
  };
  state.battlefield.push(inst);
  return inst;
}

/** Collect the events an SBA pass emits. */
function runSbas(state: GameState): GameEvent[] {
  const events: GameEvent[] = [];
  checkStateBasedActions(state, (e) => events.push(e));
  return events;
}

/** The instance with this id on the battlefield, or undefined. */
function onBattlefield(state: GameState, id: InstanceId): CardInstance | undefined {
  return state.battlefield.find((c) => c.instanceId === id);
}

// --- the relationship ----------------------------------------------------------

describe('attaching', () => {
  it('attaches to a legal host and says so in the log', () => {
    const state = emptyBoard();
    const bear = place(state, BEAR);
    const aura = place(state, UNHOLY_STRENGTH);
    const events: GameEvent[] = [];

    expect(attachTo(state, aura, bear.instanceId, (e) => events.push(e))).toBe(true);
    expect(aura.attachedTo).toBe(bear.instanceId);
    expect(events).toEqual([
      { type: 'permanentAttached', instanceId: aura.instanceId, hostInstanceId: bear.instanceId },
    ]);
  });

  it('REFUSES an illegal host, leaving the board untouched (rule 6)', () => {
    const state = emptyBoard();
    const land = place(state, FOREST);
    const aura = place(state, UNHOLY_STRENGTH);
    const events: GameEvent[] = [];

    expect(attachTo(state, aura, land.instanceId, (e) => events.push(e))).toBe(false);
    expect(aura.attachedTo).toBeNull();
    expect(events[0]?.type).toBe('attachmentFailed');
    expect(illegalAttachmentReason(state, aura, land.instanceId)).toContain('cannot be attached');
  });

  it('an Equip ability may not be pointed at a creature you do not control', () => {
    const state = emptyBoard();
    const theirs = place(state, BEAR, 'B');
    const equipment = place(state, BONESPLITTER, 'A');
    expect(attachTo(state, equipment, theirs.instanceId, () => {})).toBe(false);
    expect(equipment.attachedTo).toBeNull();
  });

  it('moving an Equipment to a new creature leaves the old one alone', () => {
    const state = emptyBoard();
    const first = place(state, BEAR);
    const second = place(state, BEAR);
    const equipment = place(state, BONESPLITTER);

    attachTo(state, equipment, first.instanceId, () => {});
    attachTo(state, equipment, second.instanceId, () => {});

    expect(equipment.attachedTo).toBe(second.instanceId);
    expect(effectivePower(first, indexContinuous(state).get(first.instanceId) ?? NO_MOD)).toBe(2);
    expect(effectivePower(second, indexContinuous(state).get(second.instanceId) ?? NO_MOD)).toBe(4);
  });
});

// --- the layering --------------------------------------------------------------

describe('layering — an attachment is one more additive layer', () => {
  it('combines with +1/+1 counters, an anthem AND an until-end-of-turn pump', () => {
    const state = emptyBoard();
    const bear = place(state, BEAR); // 2/2 printed
    bear.counters = { '+1/+1': 1 }; // layer 2 → 3/3
    place(state, ANTHEM); // layer 3b → 4/4
    const aura = place(state, UNHOLY_STRENGTH); // layer 3a (+2/+1) → 6/5
    attachTo(state, aura, bear.instanceId, () => {});
    state.continuous.push({
      id: 1,
      targetInstanceId: bear.instanceId,
      sourceInstanceId: 0,
      duration: 'endOfTurn',
      power: 3,
      toughness: 3,
    }); // layer 4 → 9/8

    const mod = indexContinuous(state).get(bear.instanceId) ?? NO_MOD;
    expect(effectivePower(bear, mod)).toBe(9);
    expect(effectiveToughness(bear, mod)).toBe(8);
    // The single-instance path must agree with the bulk index — they are two
    // readers of the same layering and a divergence would be invisible.
    const single = aggregateFor(state, bear.instanceId);
    expect(effectivePower(bear, single)).toBe(9);
    expect(effectiveToughness(bear, single)).toBe(8);
  });

  it('grants keywords, which OR together with the printed ones', () => {
    const state = emptyBoard();
    const bear = place(state, creatureDef('trampler', 2, 2, { keywords: { trample: true } }));
    const flight = place(state, FLIGHT);
    attachTo(state, flight, bear.instanceId, () => {});

    const keywords = effectiveKeywords(bear, indexContinuous(state).get(bear.instanceId) ?? NO_MOD);
    expect(keywords.trample).toBe(true);
    expect(keywords.flying).toBe(true);
  });

  it('stacks two attachments on one creature', () => {
    const state = emptyBoard();
    const bear = place(state, BEAR);
    for (const def of [UNHOLY_STRENGTH, BONESPLITTER]) {
      attachTo(state, place(state, def), bear.instanceId, () => {});
    }
    const mod = indexContinuous(state).get(bear.instanceId) ?? NO_MOD;
    expect(effectivePower(bear, mod)).toBe(2 + 2 + 2);
    expect(effectiveToughness(bear, mod)).toBe(2 + 1);
  });

  it('an UNATTACHED attachment modifies nothing at all', () => {
    const state = emptyBoard();
    const bear = place(state, BEAR);
    place(state, BONESPLITTER); // on the battlefield, equipped to nobody
    expect(effectivePower(bear, indexContinuous(state).get(bear.instanceId) ?? NO_MOD)).toBe(2);
  });
});

// --- the state-based actions ---------------------------------------------------

describe('state-based actions (CR 704.5m / 704.5n)', () => {
  it('the enchanted creature leaves the battlefield → the Aura goes to the graveyard', () => {
    const state = emptyBoard();
    const bear = place(state, BEAR);
    const aura = place(state, UNHOLY_STRENGTH);
    attachTo(state, aura, bear.instanceId, () => {});

    // The creature dies to lethal damage; the Aura must follow it off the board.
    bear.damageMarked = 99;
    const events = runSbas(state);

    expect(onBattlefield(state, bear.instanceId)).toBeUndefined();
    expect(onBattlefield(state, aura.instanceId)).toBeUndefined();
    expect(state.players.A.graveyard.map((c) => c.def.name)).toContain('Unholy Strength');
    expect(events.some((e) => e.type === 'attachmentPutIntoGraveyard')).toBe(true);
  });

  it('the equipped creature leaves the battlefield → the Equipment STAYS, unattached', () => {
    const state = emptyBoard();
    const bear = place(state, BEAR);
    const equipment = place(state, BONESPLITTER);
    attachTo(state, equipment, bear.instanceId, () => {});

    bear.damageMarked = 99;
    const events = runSbas(state);

    expect(onBattlefield(state, bear.instanceId)).toBeUndefined();
    expect(onBattlefield(state, equipment.instanceId)).toBeDefined();
    expect(equipment.attachedTo).toBeNull();
    expect(events.some((e) => e.type === 'permanentUnattached')).toBe(true);
    expect(state.players.A.graveyard.map((c) => c.def.name)).not.toContain('Bonesplitter');
  });

  it('an Equipment attached to nothing is just a permanent — SBAs leave it alone', () => {
    const state = emptyBoard();
    const equipment = place(state, BONESPLITTER);
    const events = runSbas(state);
    expect(onBattlefield(state, equipment.instanceId)).toBeDefined();
    expect(events.filter((e) => e.type === 'permanentUnattached')).toEqual([]);
  });

  it('an Aura attached to nothing dies immediately — that is how a fizzled Aura ends up in the graveyard', () => {
    const state = emptyBoard();
    const aura = place(state, UNHOLY_STRENGTH);
    runSbas(state);
    expect(onBattlefield(state, aura.instanceId)).toBeUndefined();
    expect(state.players.A.graveyard.map((c) => c.def.name)).toEqual(['Unholy Strength']);
  });

  it('an Aura whose host stops satisfying its printed line falls off', () => {
    // The general legality rule, exercised on the shape a future control-change or
    // type-change effect would produce: the host is still on the battlefield, it
    // just no longer matches "Enchant creature".
    const state = emptyBoard();
    const land = place(state, FOREST);
    const aura = place(state, UNHOLY_STRENGTH);
    aura.attachedTo = land.instanceId; // set directly: no legal path produces this

    expect(isLegallyAttached(state, aura)).toBe(false);
    runSbas(state);
    expect(onBattlefield(state, aura.instanceId)).toBeUndefined();
  });

  it('an Equipment on a creature that changes controller falls off (it says "you control")', () => {
    const state = emptyBoard();
    const bear = place(state, BEAR, 'A');
    const equipment = place(state, BONESPLITTER, 'A');
    attachTo(state, equipment, bear.instanceId, () => {});

    bear.controller = 'B'; // whatever took control of it
    runSbas(state);

    expect(equipment.attachedTo).toBeNull();
    expect(onBattlefield(state, equipment.instanceId)).toBeDefined();
  });

  it('gaining hexproof does NOT make an existing Aura fall off', () => {
    // Deliberate and rules-correct (CR 704.5m + 303.4c): hexproof and shroud stop a
    // permanent being TARGETED, which is a cast-time rule. Only protection makes an
    // already-attached Aura illegal, and this engine has no protection yet. An
    // implementation that dropped the Aura here would make every Aura strictly
    // worse than printed, which is the same class of bug as making one better.
    const state = emptyBoard();
    const bear = place(state, BEAR);
    const aura = place(state, UNHOLY_STRENGTH);
    attachTo(state, aura, bear.instanceId, () => {});

    state.continuous.push({
      id: 2,
      targetInstanceId: bear.instanceId,
      sourceInstanceId: 0,
      duration: 'endOfTurn',
      keywords: { hexproof: true },
    });
    runSbas(state);

    expect(aura.attachedTo).toBe(bear.instanceId);
    expect(onBattlefield(state, aura.instanceId)).toBeDefined();
  });

  it('cascades: the Aura keeping a creature alive dies with its own host, and the creature dies too', () => {
    // A 1/1 wearing +2/+1 is a 3/2, so one marked damage is survivable — but only
    // while the Aura is there. The point is that when the Aura leaves, the SBA loop
    // must re-judge the creature rather than leaving it alive on a buff that is gone.
    const state = emptyBoard();
    const host = place(state, creatureDef('runt', 1, 1));
    const aura = place(state, UNHOLY_STRENGTH); // +2/+1 → the runt is a 3/2
    attachTo(state, aura, host.instanceId, () => {});
    host.damageMarked = 1; // a 3/2 shrugs this off; a 1/1 does not
    runSbas(state);
    expect(onBattlefield(state, host.instanceId)).toBeDefined();

    // Now the Aura is destroyed by something else. Its host must die on the very
    // next SBA check, with no window in which the buff outlives its source.
    state.battlefield = state.battlefield.filter((c) => c.instanceId !== aura.instanceId);
    runSbas(state);
    expect(onBattlefield(state, host.instanceId)).toBeUndefined();
  });

  it('a negative Aura (Dead Weight) kills its host through the normal death SBA', () => {
    const deadWeight: CardDefinition = {
      id: 'dead-weight',
      name: 'Dead Weight',
      types: ['enchantment'],
      subtypes: ['aura'],
      cost: { B: 1 },
      attachment: {
        attachesTo: { anyOfTypes: ['creature'] },
        whenIllegal: AURA_WHEN_ILLEGAL,
        modifies: { power: -2, toughness: -2 },
      },
    };
    const state = emptyBoard();
    const runt = place(state, creatureDef('runt', 1, 1));
    const aura = place(state, deadWeight);
    attachTo(state, aura, runt.instanceId, () => {});

    runSbas(state);

    expect(onBattlefield(state, runt.instanceId)).toBeUndefined();
    // …and the Aura, now attached to nothing, follows it. Both end in a graveyard.
    expect(onBattlefield(state, aura.instanceId)).toBeUndefined();
  });
});

// --- rule 6: an unusable declaration is REPORTED -------------------------------

describe('unsupported attachment shapes degrade to a clear signal', () => {
  it('reports an attachment on a card that can never be on the battlefield', () => {
    const problem = attachmentProblem({
      id: 'bad',
      name: 'Not A Permanent',
      types: ['instant'],
      attachment: { attachesTo: { anyOfTypes: ['creature'] }, whenIllegal: AURA_WHEN_ILLEGAL },
    });
    expect(problem).toContain('only a permanent can be attached');
  });

  it('reports an unknown illegality rule rather than guessing one', () => {
    const problem = attachmentProblem({
      id: 'bad2',
      name: 'Strange Aura',
      types: ['enchantment'],
      attachment: {
        attachesTo: { anyOfTypes: ['creature'] },
        whenIllegal: 'explode' as unknown as 'detach',
      },
    });
    expect(problem).toContain('unknown attachment illegality rule');
  });

  it('says nothing about a card that is not an attachment', () => {
    expect(attachmentProblem(BEAR)).toBeUndefined();
    expect(attachmentProblem(BONESPLITTER)).toBeUndefined();
  });
});
