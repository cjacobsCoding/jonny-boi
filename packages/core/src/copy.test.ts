/**
 * COPY EFFECTS (CR 707) — the layer-1 seam.
 *
 * The one claim every test here exists to defend: **a copy is applied in LAYER
 * 1, beneath everything**, so what the copy actually IS on the battlefield is
 * "the copied card's printed values, with this permanent's own counters,
 * anthems and pumps applied on top". Getting that backwards — snapshotting a
 * pumped creature — produces a different card, silently, and every A/B verdict
 * that card appears in is then noise.
 *
 * What is pinned:
 *  - the copy routes EVERY characteristic read (name, types, P/T, keywords,
 *    triggers, mana production) because `inst.def` IS the copy;
 *  - **layer order**: the copier keeps its OWN +1/+1 counters and its own
 *    until-EOT pump, and the anthem on the board applies to the copy — all on
 *    top of the copied 1/1 body, never merged into it;
 *  - **copiable values (CR 707.2)**: you copy the printed card. A 1/1 with three
 *    counters is copied as a 1/1; a TRANSFORMED permanent is copied by its FRONT
 *    face; a permanent that is itself a copy is copied by what it copies;
 *  - the "except …" tail (extra types/subtypes/keywords, a name, legendary on
 *    and off, an extra counter) is data and is applied to the copied values;
 *  - the copy is settled BEFORE the permanent enters, so the COPIED card decides
 *    `entersTapped`, summoning sickness and starting loyalty;
 *  - the copy SURVIVES the action-boundary clone (`applyAction` clones every
 *    instance — a dropped `uncopiedDef` would silently revert the Clone to its
 *    own printed body one action later), and a DECLINE survives it too;
 *  - leaving the battlefield ends the copy (CR 400.7) — a bounced Clone is a
 *    Clone in hand.
 */

import { describe, expect, it } from 'vitest';
import type { CardDefinition, GameEvent, GameState, InstanceId, PlayerId } from './index.js';
import {
  applyAction,
  applyCopyAsEnters,
  applyCopyExceptions,
  copiableDefOf,
  copyResultDef,
  createEffectRegistry,
  createGame,
  effectivePower,
  effectiveToughness,
  isCopy,
  transformPermanent,
} from './index.js';
import { indexContinuous } from './internal/continuous.js';
import { resetInstanceForNewZone } from './internal/zones.js';
import type { CardInstance } from './state.js';
import { deckOf, giveHand, landDef } from './test-fixtures.js';

const SEED = 20260819;

/** The plain body a Clone-like prints when it copies nothing: a 0/0 that dies. */
const CLONE: CardDefinition = {
  id: 'clone-test',
  name: 'Test Clone',
  types: ['creature'],
  subtypes: ['Shapeshifter'],
  cost: { generic: 2, U: 2 },
  power: 0,
  toughness: 0,
  copyAsEnters: { filter: { anyOfTypes: ['creature'] } },
};

/** A 2/2 with a keyword, so a copy can be checked for more than numbers. */
const BEAR: CardDefinition = {
  id: 'bear-test',
  name: 'Test Bear',
  types: ['creature'],
  subtypes: ['Bear'],
  cost: { generic: 1, G: 1 },
  power: 2,
  toughness: 2,
  keywords: { trample: true },
};

/** A vanilla 1/1 — the deliberately WORSE copy target in the ranking tests. */
const RAT: CardDefinition = {
  id: 'rat-test',
  name: 'Test Rat',
  types: ['creature'],
  power: 1,
  toughness: 1,
  cost: { B: 1 },
};

const BACK_FACE: CardDefinition = {
  id: 'dfc-copy-test#back',
  name: 'Test Aberration',
  isBackFace: true,
  types: ['creature'],
  power: 3,
  toughness: 2,
  keywords: { flying: true },
};

const FRONT_FACE: CardDefinition = {
  id: 'dfc-copy-test',
  name: 'Test Delver',
  types: ['creature'],
  cost: { U: 1 },
  power: 1,
  toughness: 1,
  backFace: BACK_FACE,
};

/** A game parked in A's main phase with empty hands and plenty of mana. */
function mainPhase(): GameState {
  const land = landDef('Plains', 'W');
  const { state } = createGame({
    seed: SEED,
    decks: { A: deckOf(land, 30), B: deckOf(land, 30) },
    registry: createEffectRegistry(),
  });
  state.step = 'precombatMain';
  state.activePlayer = 'A';
  state.priorityPlayer = 'A';
  state.stack = [];
  state.players.A.hand = [];
  state.players.B.hand = [];
  state.players.A.manaPool = { W: 9, U: 9, B: 9, R: 9, G: 9, C: 9 };
  return state;
}

function place(state: GameState, def: CardDefinition, controller: PlayerId): CardInstance {
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
    attachedTo: null,
    counters: {},
  };
  state.battlefield.push(inst);
  return inst;
}

function onBattlefield(state: GameState, id: InstanceId): CardInstance | undefined {
  return state.battlefield.find((c) => c.instanceId === id);
}

/** Effective P/T through the full continuous pipeline — what combat would read. */
function effectiveStats(state: GameState, inst: CardInstance): [number, number] {
  const index = indexContinuous(state);
  const mod = index.get(inst.instanceId);
  return [effectivePower(inst, mod), effectiveToughness(inst, mod)];
}

/**
 * Cast `def` from A's hand and answer the copy question with `pick` (an instance
 * id, or `null` to decline). Returns the resolved permanent.
 *
 * Deliberately drives the REAL action pipeline (`applyAction`, which clones the
 * whole state at every boundary) rather than calling the copy helper directly:
 * the clone is where a dropped field bites, and it bites one action LATER, so a
 * test that skips the pipeline cannot see it.
 */
function castAndCopy(
  state: GameState,
  def: CardDefinition,
  pick: InstanceId | null,
): { state: GameState; permanent: CardInstance; events: GameEvent[] } {
  const registry = createEffectRegistry();
  const [card] = giveHand(state, 'A', [def]);
  const cardId = (card as CardInstance).instanceId;
  const events: GameEvent[] = [];
  let next = state;

  const cast = applyAction(
    next,
    { kind: 'castSpell', player: 'A', instanceId: cardId },
    { registry, config: undefined },
  );
  next = cast.state;
  events.push(...cast.events);

  // Both players pass, which resolves the spell — and stops on the copy question.
  for (const player of ['A', 'B'] as const) {
    const pass = applyAction(next, { kind: 'passPriority', player }, { registry, config: undefined });
    next = pass.state;
    events.push(...pass.events);
  }

  const choice = next.pendingChoice;
  expect(choice, 'the as-enters copy question should be parked').toBeTruthy();
  const answered = applyAction(
    next,
    {
      kind: 'answerChoice',
      player: 'A',
      choiceId: (choice as NonNullable<typeof choice>).id,
      answer: { kind: 'selectCards', instanceIds: pick === null ? [] : [pick] },
    },
    { registry, config: undefined },
  );
  next = answered.state;
  events.push(...answered.events);

  // Found ANYWHERE, not just on the battlefield: a Clone that declines the copy
  // is a 0/0 and dies to a state-based action on arrival, which is exactly what
  // the printed card does and something a battlefield-only lookup would hide.
  const permanent =
    onBattlefield(next, cardId) ?? next.players.A.graveyard.find((c) => c.instanceId === cardId);
  expect(permanent, 'the copying card should have resolved somewhere').toBeTruthy();
  return { state: next, permanent: permanent as CardInstance, events };
}

describe('copiableDefOf — CR 707.2, what you actually copy', () => {
  it('is the printed card for an ordinary permanent, counters and all', () => {
    const state = mainPhase();
    const bear = place(state, BEAR, 'A');
    bear.counters = { '+1/+1': 3 };
    // The board says 5/5. The COPIABLE values still say 2/2, and that difference
    // IS the feature.
    expect(effectiveStats(state, bear)).toEqual([5, 5]);
    expect(copiableDefOf(bear)).toBe(BEAR);
    expect(copiableDefOf(bear).power).toBe(2);
  });

  it('is the FRONT face of a transformed permanent, not the face that is up', () => {
    const state = mainPhase();
    const delver = place(state, FRONT_FACE, 'A');
    transformPermanent(state, delver.instanceId, () => {});
    expect(delver.def).toBe(BACK_FACE);
    expect(copiableDefOf(delver)).toBe(FRONT_FACE);
  });

  it('is what a COPY copies — a Clone copying a Bear is copied as a Bear', () => {
    const state = mainPhase();
    const bear = place(state, BEAR, 'A');
    const clone = place(state, CLONE, 'A');
    applyCopyAsEnters(clone, bear, CLONE.copyAsEnters as NonNullable<CardDefinition['copyAsEnters']>, () => {});
    expect(copiableDefOf(clone).name).toBe('Test Bear');
    expect(copiableDefOf(clone).power).toBe(2);
  });
});

describe('applyCopyExceptions — the printed "except …" tail (CR 707.3)', () => {
  it('adds types and subtypes without losing the copied ones', () => {
    const result = applyCopyExceptions(BEAR, { addTypes: ['artifact'], addSubtypes: ['Illusion'] });
    expect(result.types).toEqual(['creature', 'artifact']);
    expect(result.subtypes).toEqual(['Bear', 'Illusion']);
    expect(result.power).toBe(2);
  });

  it('renames without changing anything else (Sakashima keeps its own name)', () => {
    const result = applyCopyExceptions(BEAR, { name: 'Sakashima the Impostor' });
    expect(result.name).toBe('Sakashima the Impostor');
    expect(result.power).toBe(2);
    expect(result.keywords?.trample).toBe(true);
  });

  it('grants keywords ON TOP of the copied ones, never instead of them', () => {
    const result = applyCopyExceptions(BEAR, { addKeywords: { flying: true } });
    expect(result.keywords?.flying).toBe(true);
    expect(result.keywords?.trample).toBe(true);
  });

  it('clears legendary when the card says it is not legendary (Spark Double)', () => {
    const legend: CardDefinition = { ...BEAR, legendary: true };
    expect(applyCopyExceptions(legend, { legendary: false }).legendary).toBeUndefined();
    // …and `undefined` is NOT `false`: with no clause the copied supertype stays.
    expect(applyCopyExceptions(legend, { addTypes: ['artifact'] }).legendary).toBe(true);
    // Sakashima's opposite clause adds it to a nonlegendary copy.
    expect(applyCopyExceptions(BEAR, { legendary: true }).legendary).toBe(true);
  });

  it('gives the result its own id so it cannot collide with the copied card', () => {
    expect(copyResultDef(CLONE, place(mainPhase(), BEAR, 'A'), { except: { name: 'X' } }).id).not.toBe(BEAR.id);
  });
});

describe('the copy is LAYER 1 — everything else applies on top', () => {
  it('keeps the copier own counters, and adds them to the COPIED body', () => {
    const state = mainPhase();
    const bear = place(state, BEAR, 'A');
    const clone = place(state, CLONE, 'A');
    // Two +1/+1 counters on the Clone itself (Spark Double's clause, a
    // proliferate, an Ordeal — the source does not matter to the layer).
    clone.counters = { '+1/+1': 2 };

    applyCopyAsEnters(clone, bear, CLONE.copyAsEnters as NonNullable<CardDefinition['copyAsEnters']>, () => {});

    // Copied 2/2 (layer 1) + its own two counters (layer 7d) = 4/4.
    expect(clone.def.power).toBe(2);
    expect(effectiveStats(state, clone)).toEqual([4, 4]);
  });

  it('copies the PRINTED body of a pumped creature, then re-applies its own state', () => {
    const state = mainPhase();
    const bear = place(state, BEAR, 'A');
    // The Bear on the board is a 5/5: three counters. A copy that snapshotted
    // the board would be a 5/5 too, and would be the wrong card.
    bear.counters = { '+1/+1': 3 };
    const clone = place(state, CLONE, 'A');

    applyCopyAsEnters(clone, bear, CLONE.copyAsEnters as NonNullable<CardDefinition['copyAsEnters']>, () => {});

    expect(effectiveStats(state, bear)).toEqual([5, 5]);
    expect(effectiveStats(state, clone)).toEqual([2, 2]);
  });

  it('an anthem shines on the copy exactly as it does on the original (layer 7c)', () => {
    const state = mainPhase();
    const anthem: CardDefinition = {
      id: 'anthem-test',
      name: 'Test Anthem',
      types: ['enchantment'],
      statics: [
        {
          id: 'anthem-test#1',
          affects: { controller: 'you', anyOfTypes: ['creature'] },
          power: 1,
          toughness: 1,
        },
      ],
    };
    place(state, anthem, 'A');
    const bear = place(state, BEAR, 'A');
    const clone = place(state, CLONE, 'A');

    applyCopyAsEnters(clone, bear, CLONE.copyAsEnters as NonNullable<CardDefinition['copyAsEnters']>, () => {});

    // Both are 2/2 printed bodies under a +1/+1 anthem.
    expect(effectiveStats(state, bear)).toEqual([3, 3]);
    expect(effectiveStats(state, clone)).toEqual([3, 3]);
  });

  it('an until-end-of-turn pump already on the copier still applies after the copy', () => {
    const state = mainPhase();
    const bear = place(state, BEAR, 'A');
    const clone = place(state, CLONE, 'A');
    state.continuous.push({
      id: state.nextInstanceId++,
      targetInstanceId: clone.instanceId,
      sourceInstanceId: clone.instanceId,
      duration: 'endOfTurn',
      power: 3,
      toughness: 3,
    });

    applyCopyAsEnters(clone, bear, CLONE.copyAsEnters as NonNullable<CardDefinition['copyAsEnters']>, () => {});

    // Copied 2/2 + a Giant Growth-sized pump = 5/5. The pump is not lost and not
    // folded into the copied printed box.
    expect(effectiveStats(state, clone)).toEqual([5, 5]);
  });

  it('routes name, types, subtypes, keywords and triggers through the copy', () => {
    const state = mainPhase();
    const trigger = {
      id: 'copied-trigger',
      label: 'copied trigger',
      condition: { on: 'upkeep' as const },
      effects: [{ primitive: 'drawCards', params: { count: 1 } }],
    };
    const source: CardDefinition = { ...BEAR, triggers: [trigger] };
    const original = place(state, source, 'A');
    const clone = place(state, CLONE, 'A');

    applyCopyAsEnters(clone, original, CLONE.copyAsEnters as NonNullable<CardDefinition['copyAsEnters']>, () => {});

    expect(clone.def.name).toBe('Test Bear');
    expect(clone.def.subtypes).toEqual(['Bear']);
    expect(clone.def.keywords?.trample).toBe(true);
    expect(clone.def.triggers).toBe(source.triggers);
    expect(isCopy(clone)).toBe(true);
    expect(isCopy(original)).toBe(false);
  });

  it('says so in the log, without pretending anything changed zones', () => {
    const state = mainPhase();
    const bear = place(state, BEAR, 'A');
    const clone = place(state, CLONE, 'A');
    const events: GameEvent[] = [];

    applyCopyAsEnters(clone, bear, CLONE.copyAsEnters as NonNullable<CardDefinition['copyAsEnters']>, (e) =>
      events.push(e),
    );

    expect(events).toEqual([
      {
        type: 'becameCopy',
        instanceId: clone.instanceId,
        ownName: 'Test Clone',
        copiedName: 'Test Bear',
        copiedInstanceId: bear.instanceId,
      },
    ]);
    expect(events.some((e) => e.type === 'zoneChange')).toBe(false);
  });
});

describe('the as-enters question, driven through the real action pipeline', () => {
  it('a cast Clone enters as the chosen creature and SURVIVES the action clone', () => {
    let state = mainPhase();
    const bear = place(state, BEAR, 'A');
    const rat = place(state, RAT, 'A');
    void rat;

    const result = castAndCopy(state, CLONE, bear.instanceId);
    state = result.state;

    expect(result.permanent.def.name).toBe('Test Bear');
    expect(result.permanent.def.power).toBe(2);
    expect(result.permanent.uncopiedDef?.name).toBe('Test Clone');
    expect(result.events.some((e) => e.type === 'becameCopy')).toBe(true);

    // TWO more action boundaries — the failure mode a dropped `uncopiedDef`
    // produces is a copy that looks right for exactly one action and then
    // reverts. One boundary is not enough to catch it.
    const registry = createEffectRegistry();
    for (const player of ['A', 'B'] as const) {
      state = applyAction(state, { kind: 'passPriority', player }, { registry, config: undefined }).state;
    }
    const still = onBattlefield(state, result.permanent.instanceId);
    expect(still?.def.name).toBe('Test Bear');
    expect(still?.uncopiedDef?.name).toBe('Test Clone');
  });

  it('DECLINING sticks across the clone: the Clone stays its own printed body', () => {
    const state = mainPhase();
    place(state, BEAR, 'A');
    const result = castAndCopy(state, CLONE, null);
    expect(result.permanent.def.name).toBe('Test Clone');
    // A declined Clone is the printed 0/0 it says it is, so it dies to a
    // state-based action the moment it enters (CR 704.5f) — the sharpest
    // possible proof that the decline really stuck.
    expect(result.permanent.zone).toBe('graveyard');
    expect(result.permanent.uncopiedDef ?? null).toBeNull();
    expect(result.events.some((e) => e.type === 'becameCopy')).toBe(false);
    // The spell resolved exactly once — a decline that did not stick would have
    // re-asked forever, and a double resolution would log two of these.
    expect(result.events.filter((e) => e.type === 'stackResolved')).toHaveLength(1);
  });

  it('is not asked at all when nothing legal is on the battlefield', () => {
    const state = mainPhase();
    const registry = createEffectRegistry();
    const [card] = giveHand(state, 'A', [CLONE]);
    const id = (card as CardInstance).instanceId;
    let next = applyAction(state, { kind: 'castSpell', player: 'A', instanceId: id }, { registry, config: undefined })
      .state;
    for (const player of ['A', 'B'] as const) {
      next = applyAction(next, { kind: 'passPriority', player }, { registry, config: undefined }).state;
    }
    // Nothing to copy ⇒ the printed "you may" has one outcome, so the game must
    // not stop to ask it.
    expect(next.pendingChoice ?? null).toBeNull();
    // It resolved as its own printed 0/0 and died to a state-based action —
    // which is what the real card does with nothing to copy.
    expect(next.players.A.graveyard.find((c) => c.instanceId === id)?.def.name).toBe('Test Clone');
  });

  it('the COPIED card decides summoning sickness — copying a hasty creature', () => {
    const state = mainPhase();
    const hasty = place(state, { ...BEAR, id: 'hasty', name: 'Test Hasty', keywords: { haste: true } }, 'A');
    const result = castAndCopy(state, CLONE, hasty.instanceId);
    expect(result.permanent.summoningSick).toBe(false);
  });
});

describe('leaving the battlefield ends the copy (CR 400.7)', () => {
  it('a bounced Clone is a Clone in hand, not the creature it copied', () => {
    let state = mainPhase();
    const bear = place(state, BEAR, 'A');
    const result = castAndCopy(state, CLONE, bear.instanceId);
    state = result.state;
    const clone = result.permanent;
    expect(clone.def.name).toBe('Test Bear');

    // The one chokepoint every leave path runs.
    resetInstanceForNewZone(clone);

    expect(clone.def.name).toBe('Test Clone');
    expect(clone.uncopiedDef ?? null).toBeNull();
    expect(isCopy(clone)).toBe(false);
  });
});
